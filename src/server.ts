import { McpServer, type McpRequestContext, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { getOperation, type Operation } from "./catalog";
import { approvalReasons, confirmationCodeField, confirmGate, type Confirmer } from "./confirm";
import { searchDocs } from "./docs";
import { searchOperations } from "./search";
import { shortcuts } from "./shortcuts";
import { buildRequest, callUpstream, type Credential } from "./upstream";

export interface ServerConfig {
  apiBase: string;
  confirmationMode: "confirm" | "block" | "allow";
  /** Required when confirmationMode is "confirm". */
  confirmer?: Confirmer;
  fetchImpl?: typeof fetch;
  /** Called when Plivo refuses the caller's token, so the HTTP layer can ask the client to sign in again. */
  onTokenRejected?: () => void;
}

const MAX_RESULT_CHARS = 40_000;

// Without it an empty 7-day page reads as "this account has no calls".
const CALL_WINDOW_NOTE =
  "Plivo searched only the last 7 days because no end_time filter was given. For older calls pass end_time__gt and/or " +
  "end_time__lt (a range of at most 30 days, within the last 90).";

function text(value: unknown, isError = false) {
  let s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (s.length > MAX_RESULT_CHARS) {
    s = `${s.slice(0, MAX_RESULT_CHARS)}\n… truncated (${s.length} chars). Narrow the request with limit/offset or filters.`;
  }
  return { content: [{ type: "text" as const, text: s }], ...(isError ? { isError: true } : {}) };
}

function describe(op: Operation) {
  return {
    id: op.id,
    title: op.title,
    description: op.description,
    method: op.method,
    path: op.path,
    call_with: op.method === "GET" ? "plivo_api_read" : "plivo_api_write",
    costs_money: op.costs_money,
    destructive: op.destructive,
    needs_approval: op.method === "GET" ? [] : approvalReasons(op),
    path_params: op.path_params ?? [],
    params: op.params,
    fixed_query: op.fixed_query,
    docs_url: op.docs_url,
  };
}

const callInput = z.object({
  id: z.string().describe('Operation id from plivo_api_search, e.g. "POST /Message/"'),
  path_params: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional()
    .describe('Values for the {placeholders} in the path, e.g. {"message_uuid": "…"}. {auth_id} is filled in for you.'),
  params: z.record(z.string(), z.unknown()).optional().describe("Query params (GET) or JSON body fields (other methods), as listed by plivo_api_details"),
});

const writeInput = callInput.extend({ confirmation_code: confirmationCodeField });

export function buildServer(ctx: McpRequestContext, config: ServerConfig): McpServer {
  const server = new McpServer(
    { name: "plivo", version: "0.1.0" },
    {
      instructions:
        "Plivo communications API (SMS, voice calls, phone numbers, SIP trunking, 10DLC and more). " +
        `Common tasks have their own tools: ${shortcuts.map((s) => s.name).join(", ")}. ` +
        "For anything else, find an operation with plivo_api_search, read its params with plivo_api_details, then call it with " +
        "plivo_api_read (GET) or plivo_api_write (everything else). To learn how something works (Plivo XML for " +
        "calls, error codes, setup guides), use search_docs. Actions that cost money, cannot be undone, give lasting " +
        "access to the account or change where calls and messages go need the user's approval; never approve one on " +
        "the user's behalf.",
    },
  );
  const caller = ctx.authInfo?.extra?.credential as Credential | undefined;

  async function call(kind: "read" | "write", args: z.infer<typeof writeInput>, reqCtx: ServerContext) {
    const op = getOperation(args.id);
    if (!op) return text(`Unknown operation "${args.id}". Use plivo_api_search to find a valid id.`, true);
    if (kind === "read" && op.method !== "GET") return text(`${op.id} changes data; call it with plivo_api_write.`, true);
    if (kind === "write" && op.method === "GET") return text(`${op.id} is read-only; call it with plivo_api_read.`, true);
    const reasons = kind === "write" ? approvalReasons(op) : [];
    const needsConfirmation = reasons.length > 0;
    if (needsConfirmation && config.confirmationMode === "block") {
      return text(`${op.id} needs the user's approval (${reasons.join(" ")}), and this server is set to refuse such actions. Do it in the Plivo console instead.`, true);
    }
    if (!caller) return text("This request has no Plivo credentials.", true);

    // Built before asking, so the user is never asked to approve a request that cannot be sent.
    const req = buildRequest(op, args, caller, config.apiBase);
    if ("error" in req) return text(req.error, true);
    if (needsConfirmation && config.confirmationMode === "confirm") {
      if (!config.confirmer) return text("Confirmation is not configured on this server.", true);
      const gate = await confirmGate(config.confirmer, reqCtx, op, req, args.confirmation_code);
      if (!gate.approved) return gate.result;
    }
    let res;
    try {
      res = await callUpstream(req, caller, config.fetchImpl);
    } catch (e) {
      const reason = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "failed";
      return text(`The Plivo API call ${reason}. Nothing is known about whether it took effect; check before retrying.`, true);
    }
    if (res.status === 401) config.onTokenRejected?.();
    const result: Record<string, unknown> = { status: res.status, response: res.body };
    if (req.warnings.length) result.warnings = req.warnings;
    if (op.id === "GET /Call/" && !Object.keys(args.params ?? {}).some((k) => k.startsWith("end_time"))) result.note = CALL_WINDOW_NOTE;
    return text(result, !res.ok);
  }

  server.registerTool(
    "plivo_api_search",
    {
      title: "Search Plivo API operations",
      description:
        "Search the Plivo API by what you want to do (e.g. \"send an SMS\", \"list calls\", \"buy a phone number\"). " +
        "Returns operation ids to pass to plivo_api_details.",
      inputSchema: z.object({
        query: z.string().min(1).max(300).describe("What you want to do, in plain words"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 8)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const hits = searchOperations(query, limit ?? 8);
      if (hits.length === 0) return text(`No operations match "${query}". Try other words, e.g. the resource name (message, call, number, trunk).`);
      return text(hits);
    },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search the Plivo docs",
      description:
        "Search Plivo's guides and reference: concepts, how-tos, Plivo XML for calls, error codes, FAQs and " +
        "troubleshooting. Use it to learn how something works; use plivo_api_search to find the API operation to call.",
      inputSchema: z.object({
        query: z.string().min(1).max(300).describe('What you want to know, e.g. "Speak XML", "SMS error code 30", "10DLC registration"'),
        limit: z.number().int().min(1).max(10).optional().describe("Max sections (default 5)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const hits = searchDocs(query, limit ?? 5);
      if (hits.length === 0) return text(`No docs match "${query}". Try other words.`);
      return text(hits);
    },
  );

  server.registerTool(
    "plivo_api_details",
    {
      title: "Describe a Plivo API operation",
      description: "Get an operation's params (name, type, required, description), path params, and whether it costs money. Call before plivo_api_read or plivo_api_write.",
      inputSchema: z.object({ id: z.string().describe('Operation id from plivo_api_search, e.g. "POST /Message/"') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const op = getOperation(id);
      if (!op) return text(`Unknown operation "${id}". Use plivo_api_search to find a valid id.`, true);
      return text(describe(op));
    },
  );

  server.registerTool(
    "plivo_api_read",
    {
      title: "Call a read-only Plivo API operation",
      description: "Call a GET operation from the catalog (list or retrieve messages, calls, numbers, recordings, and more).",
      inputSchema: callInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, reqCtx) => call("read", args, reqCtx),
  );

  server.registerTool(
    "plivo_api_write",
    {
      title: "Call a Plivo API operation that changes data",
      description:
        "Call a POST, PATCH or DELETE operation from the catalog. Operations that cost money (sending messages, " +
        "making calls, buying numbers), cannot be undone, create SIP access or reroute calls and messages need the " +
        "user's approval first; plivo_api_details lists the reasons as needs_approval.",
      inputSchema: writeInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args, reqCtx) => call("write", args, reqCtx),
  );

  for (const s of shortcuts) {
    server.registerTool(
      s.name,
      { title: s.op.title, description: s.description, inputSchema: s.inputSchema, annotations: s.annotations },
      async (args, reqCtx) => call(s.kind, s.toCall(args), reqCtx),
    );
  }

  return server;
}
