import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { approvalId, type Approvals } from "./approvals";
import { getOperation, type Operation } from "./catalog";
import type { BuiltRequest } from "./upstream";

const KEEPS_ACCESS = "This creates or changes a way to place calls on this account, and it keeps working after this app is disconnected.";
const REROUTES = "This changes where this account's calls or messages are sent.";
const MOVES_CALL = "This moves a live call somewhere else.";
const NEW_APP =
  "This creates an application, which decides where calls and messages go; it can become the default for new numbers and endpoints.";
const NEW_AGENT = "This creates an AI agent on this account.";
const CHANGES_AGENT = "This changes an AI agent, which may be live on calls and messages.";
const AGENT_LIVE = "This puts an AI agent live on calls and messages.";
const AGENT_STOPS = "This stops a live AI agent from handling calls and messages.";
const REMOVES_MEMBER = "This removes a member from a live conference.";

// Free, yet they outlive a revoked token, send traffic elsewhere, change what an AI agent does on live traffic or
// cut someone off a live call, so a prompt injection could use them for lasting harm.
const ASKS_FIRST: Readonly<Record<string, string>> = {
  "POST /Endpoint/": KEEPS_ACCESS,
  "POST /Endpoint/{endpoint_id}/": KEEPS_ACCESS,
  "POST /Zentrunk/Credential/": KEEPS_ACCESS,
  "POST /Zentrunk/Credential/{credential_uuid}/": KEEPS_ACCESS,
  "POST /Zentrunk/IPAccessControlList/": KEEPS_ACCESS,
  "POST /Zentrunk/IPAccessControlList/{ipacl_uuid}/": KEEPS_ACCESS,
  "POST /Zentrunk/Trunk/": KEEPS_ACCESS,
  "POST /Zentrunk/Trunk/{trunk_id}/": KEEPS_ACCESS,
  "POST /Zentrunk/URI/": REROUTES,
  "POST /Zentrunk/URI/{uri_uuid}/": REROUTES,
  "POST /Application/": NEW_APP,
  "POST /Application/{app_id}/": REROUTES,
  "POST /Number/{number}/": REROUTES,
  "POST /Powerpack/": REROUTES,
  "POST /Powerpack/{powerpack_uuid}/": REROUTES,
  "POST /Call/{call_uuid}/": MOVES_CALL,
  "POST /AgentFlow/": NEW_AGENT,
  "POST /AgentFlow/{agent_id}/": CHANGES_AGENT,
  "POST /AgentFlow/{agent_id}/Publish/": AGENT_LIVE,
  "POST /AgentFlow/{agent_id}/Resume/": AGENT_LIVE,
  "POST /AgentFlow/{agent_id}/Pause/": AGENT_STOPS,
  "POST /Conference/{conference_name}/Member/{member_id}/Kick/": REMOVES_MEMBER,
};

for (const id of Object.keys(ASKS_FIRST)) {
  const op = getOperation(id);
  if (!op || op.method === "GET") throw new Error(`ASKS_FIRST lists ${id}, which is not a write in the catalog`);
}

/** Why a write needs the user's approval, one sentence per reason; empty when it needs none. */
export function approvalReasons(op: Operation): string[] {
  const why: string[] = [];
  if (op.costs_money) why.push("This costs money.");
  if (op.destructive) why.push("This cannot be undone.");
  if (ASKS_FIRST[op.id]) why.push(ASKS_FIRST[op.id]);
  return why;
}

/**
 * What the user approves: one exact request (method, URL and body), by digest. `k` marks state minted for an
 * elicitation and for an approval link, whose `a` is the approval's id at the auth proxy. `n` makes every approval
 * distinct, so spending one cannot spend another for the same request.
 */
interface Pending {
  d: string;
  k?: "elicit" | "link";
  n?: string;
  a?: string;
}

export interface Confirmer {
  code: RequestStateCodec<Pending>;
  /** Absent in local development, where there is no auth proxy to remember a spent approval. */
  approvals?: Approvals;
}

export const CODE_TTL_SECONDS = 300;

export const confirmationCodeField = z
  .string()
  .max(2000)
  .optional()
  .describe("Only after a previous call returned approval_required or confirmation_required and the user approved that exact action.");

export function createConfirmer(secret: string, approvals?: Approvals): Confirmer {
  // Bound to the caller's credential: one account's approval cannot authorize another's request.
  const bind = (ctx: ServerContext) => ctx.http?.authInfo?.token ?? "";
  return { code: createRequestStateCodec<Pending>({ key: secret, ttlSeconds: CODE_TTL_SECONDS, bind }), approvals };
}

/**
 * Spends a verified approval, so it sends its request once however often it is presented. Any answer but a clear
 * one refuses the action: an approval that may already have been used must not run again.
 */
async function spend(c: Confirmer, ctx: ServerContext, proof: string): Promise<Gate> {
  const authorization = ctx.http?.authInfo?.token ?? "";
  if (!c.approvals || !authorization.startsWith("Bearer ")) return { approved: true };
  const outcome = await c.approvals.consume(await approvalId(proof), authorization);
  if (outcome === "ok" || outcome === "absent") return { approved: true };
  return {
    approved: false,
    result: textResult(
      outcome === "used"
        ? "This approval was already used once. Nothing was done; call again without it and ask the user again."
        : "The approval could not be recorded as used, so nothing was done. Try again shortly.",
      true,
    ),
  };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export async function requestDigest(req: BuiltRequest): Promise<string> {
  const body = req.body === undefined ? null : JSON.parse(req.body);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${req.method}\n${req.url}\n${canonical(body)}`));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// The user approves what they see, so nothing is cut short; a preview too long to read is refused instead.
const MAX_PREVIEW_CHARS = 8_000;
const PLAIN_KEY = /^[A-Za-z0-9_.[\]-]+$/;

// The preview lands in the chat transcript, so it hides what cx-core hides when it returns an agent
// (usecases/agent_management.py): secret-named fields at any depth, JSON-encoded credential fields and URL
// credentials. Like the CLI, it never prints a password back. Only fields that hold credentials are hidden:
// hiding words in free text would let a crafted value hide itself from the user.
const SECRET_KEY = new RegExp(["token", "password", "secret", "api[_-]?key", "authorization", "cookie"].join("|"), "iu");
const JSON_SECRET_FIELDS = new Set(["headers", "params", "body", "auth_params", "http_headers", "http_params", "http_body_template"]);
const WHOLE_TEMPLATE = /^\{\{[^{}]*\}\}$/;
const URL_LIKE = /[a-z][a-z0-9+.-]*:[^\s"'<>`]+/giu;
const MAX_DEPTH = 50;

/** A value the preview cannot show both exactly and without its secrets; the write is refused instead. */
class Unshowable extends Error {}

// cx-core returns secrets as this placeholder and keeps the stored secret when it comes back, so a user can
// tell a kept secret from a new one.
const KEPT_PLACEHOLDER = `${"*".repeat(3)}REDACTED${"*".repeat(3)}`;
const hide = (s: string) => (s === KEPT_PLACEHOLDER ? "(unchanged: the stored secret)" : `(hidden, ${s.length} characters)`);

// Forgiving like Python's unquote: one bad escape must not stop "api%5fkey" being read as api_key.
const decoded = (s: string) =>
  s.replaceAll("+", " ").replace(/%([0-9a-f]{2})/giu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

function hideQuerySecrets(query: string): string {
  if (!query) return query;
  const pairs = query.slice(1).split("&").map((pair) => {
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    return eq > 0 && value && SECRET_KEY.test(decoded(name)) && !WHOLE_TEMPLATE.test(decoded(value)) ? `${name}=(hidden)` : pair;
  });
  return `?${pairs.join("&")}`;
}

function hideUrlCredentials(s: string): string {
  return s.replace(URL_LIKE, (url) => {
    const q = url.indexOf("?");
    const f = url.indexOf("#", Math.max(q, 0));
    let head = url.slice(0, q >= 0 ? q : f >= 0 ? f : undefined);
    const query = q >= 0 ? url.slice(q, f >= 0 ? f : undefined) : "";
    const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/isu.exec(head);
    if (m) {
      const at = m[2].lastIndexOf("@");
      const colon = at > 0 ? m[2].slice(0, at).indexOf(":") : -1;
      if (colon >= 0) head = `${m[1]}${m[2].slice(0, colon)}:(hidden)${m[2].slice(at)}${m[3]}`;
    }
    return head + hideQuerySecrets(query) + (f >= 0 ? url.slice(f) : "");
  });
}

/** s without whitespace outside strings: equal to JSON.stringify of its parse only if parsing lost nothing. */
function minifyJson(s: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      out += c;
      if (c === "\\") out += s[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (!" \t\n\r".includes(c)) {
      out += c;
    }
  }
  return out;
}

function mapObject(o: object, f: (v: unknown, k: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(o)) out[k] = f(v, k);
  return out;
}

// Under a secret-named key the whole value is the secret; numbers and booleans stay, as in `token_expiry: 3600`.
function hideAll(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "(hidden)";
  if (typeof v === "string") return v ? hide(v) : v;
  if (Array.isArray(v)) return v.map((x) => hideAll(x, depth + 1));
  if (v !== null && typeof v === "object") return mapObject(v, (x) => hideAll(x, depth + 1));
  return v;
}

function redact(v: unknown, key: string, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Unshowable("it is nested too deeply");
  if (Array.isArray(v)) return v.map((x) => redact(x, key, depth + 1));
  if (v !== null && typeof v === "object") {
    return mapObject(v, (x, k) => (SECRET_KEY.test(k) ? hideAll(x, depth + 1) : redact(x, k, depth + 1)));
  }
  if (typeof v !== "string" || !v) return v;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === "object") {
    const r = redact(parsed, key, depth + 1);
    if (canonical(r) === canonical(parsed)) return v;
    // Duplicate keys and long numbers do not survive a parse, so the rewritten text would not be what is sent.
    if (JSON.stringify(parsed) !== minifyJson(v)) throw new Unshowable("a JSON text in it cannot be shown exactly once its secrets are hidden");
    return JSON.stringify(r);
  }
  // Stricter than cx-core, which passes any value holding a {{template}}: a secret can sit beside one.
  if (JSON_SECRET_FIELDS.has(key) && !WHOLE_TEMPLATE.test(v)) return hide(v);
  return hideUrlCredentials(v);
}

/**
 * The plain-text description of the action the user is asked to approve. The model controls the argument
 * order and values, so it must not decide what the user sees: required params come first, then documented
 * ones, and values are JSON-escaped so a newline in one cannot forge another line.
 */
export function describeAction(op: Operation, req: BuiltRequest, extra: string[] = []): string {
  const u = new URL(req.url);
  const path = u.pathname.replace(/^.*\/v1\/Account\/[^/]+/, "") || "/";
  const lines = [`${op.title} (${op.method} ${path}${hideQuerySecrets(u.search)})`, ...approvalReasons(op)];
  if (ASKS_FIRST[op.id] === KEEPS_ACCESS) lines.push("If it is no longer needed later, delete it in the Plivo console.");
  lines.push(...extra);

  const body = req.body === undefined ? {} : (JSON.parse(req.body) as Record<string, unknown>);
  // One send or call can fan out to many destinations joined with "<", each billed.
  for (const k of ["dst", "to"]) {
    const n = typeof body[k] === "string" ? (body[k] as string).split("<").filter((d) => d.trim()).length : 0;
    if (n > 1) lines.push(`${n} recipients (${k}).`);
  }
  const rank = new Map(op.params.map((p, i) => [p.name, p.required ? i : op.params.length + i]));
  const unranked = 2 * op.params.length;
  const names = Object.keys(body).sort((a, b) => (rank.get(a) ?? unranked) - (rank.get(b) ?? unranked) || (a < b ? -1 : a > b ? 1 : 0));
  for (const k of names) {
    const v = body[k];
    const shown = !SECRET_KEY.test(k)
      ? JSON.stringify(redact(v, k, 0))
      : typeof v === "string" ? hide(v) : JSON.stringify(hideAll(v, 0));
    lines.push(`${PLAIN_KEY.test(k) ? k : JSON.stringify(k)}${rank.has(k) ? "" : " (not a documented param)"}: ${shown ?? "null"}`);
  }
  return lines.join("\n");
}

export type Gate = { approved: true } | { approved: false; result: CallToolResult | InputRequiredResult };

function textResult(value: unknown, isError = false): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function preview(op: Operation, req: BuiltRequest, extra: string[]): { action: string } | { refusal: CallToolResult } {
  let action: string;
  try {
    action = describeAction(op, req, extra);
  } catch (e) {
    if (!(e instanceof Unshowable)) throw e;
    return { refusal: textResult(`Nothing was done: this action cannot be shown to the user for approval, because ${e.message}. Make the change in the Plivo console.`, true) };
  }
  if (action.length > MAX_PREVIEW_CHARS) {
    return {
      refusal: textResult(
        `Nothing was done: this action is ${action.length} characters, too long to show the user for approval (the limit is ` +
          `${MAX_PREVIEW_CHARS}). Make the change in smaller steps if the operation allows it, or in the Plivo console.`,
        true,
      ),
    };
  }
  return { action };
}


const APPROVE_KEY = "approve";
const APPROVAL_SCHEMA = {
  type: "object" as const,
  properties: { approve: { type: "boolean" as const, title: "Approve this action", default: false } },
  required: ["approve"],
};

/** Form-mode elicitation, declared on this 2026-07-28 request; a 2025-era request carries no envelope. */
function canElicit(ctx: ServerContext): boolean {
  const caps = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  const e = caps?.elicitation as Record<string, unknown> | undefined;
  return e !== undefined && (Object.keys(e).length === 0 || "form" in e);
}

/**
 * Asks the user through the client's own dialog. The model sees neither the question nor the answer, so it cannot
 * approve for the user; the retry is sent only when the signed state matches this exact request and the user accepted.
 */
async function askUser(c: Confirmer, ctx: ServerContext, d: string, action: string): Promise<Gate> {
  const raw = ctx.mcpReq.requestState();
  if (raw === undefined) {
    return {
      approved: false,
      result: inputRequired({
        inputRequests: { [APPROVE_KEY]: inputRequired.elicit({ message: `${action}\n\nApprove this action?`, requestedSchema: APPROVAL_SCHEMA }) },
        requestState: await c.code.mint({ d, k: "elicit", n: crypto.randomUUID() }, ctx),
      }),
    };
  }
  let p: Pending;
  try {
    p = await c.code.verify(String(raw), ctx);
  } catch {
    return { approved: false, result: textResult("The approval request expired or is invalid. Nothing was done; call again to ask the user again.", true) };
  }
  if (p.k !== "elicit" || p.d !== d) return { approved: false, result: textResult("The approval was for a different request. Nothing was done.", true) };
  const answer = inputResponse(ctx.mcpReq.inputResponses, APPROVE_KEY);
  if (answer.kind === "elicit" && answer.action === "accept" && answer.content?.approve === true) return spend(c, ctx, String(raw));
  return { approved: false, result: textResult("Nothing was done: the user did not approve this action.", true) };
}

const LINK_INSTRUCTIONS =
  "Give the user approval_url and ask them to open it and approve this action there, signed in to Plivo. You cannot " +
  "approve it yourself. After they say they approved, call the same tool again with exactly the same arguments plus " +
  "confirmation_code.";

/**
 * For a client with no approval dialog: registers the action at the auth proxy and returns the Plivo console page
 * where the signed-in user approves it. The model gets a link and a handle, neither of which approves anything.
 * Undefined when there is no proxy to hold approvals, which leaves the confirmation code.
 */
async function askByLink(c: Confirmer, ctx: ServerContext, d: string, action: string): Promise<Gate | undefined> {
  const authorization = ctx.http?.authInfo?.token ?? "";
  if (!c.approvals || !authorization.startsWith("Bearer ")) return undefined;
  const made = await c.approvals.create(d, action, authorization);
  if (made === "absent") return undefined;
  if (made === "failed") return { approved: false, result: textResult("The approval could not be set up, so nothing was done. Try again shortly.", true) };
  return {
    approved: false,
    result: textResult({
      status: "approval_required",
      nothing_done_yet: true,
      action,
      approval_url: made.url,
      confirmation_code: await c.code.mint({ d, k: "link", a: made.id, n: crypto.randomUUID() }, ctx),
      expires_in_seconds: CODE_TTL_SECONDS,
      instructions: LINK_INSTRUCTIONS,
    }),
  };
}

/** Asks the auth proxy what the user decided on the approval page; an approval is handed out once. */
async function redeemLink(c: Confirmer, ctx: ServerContext, p: Pending): Promise<Gate> {
  const authorization = ctx.http?.authInfo?.token ?? "";
  const outcome = c.approvals && p.a ? await c.approvals.redeem(p.a, p.d, authorization) : "failed";
  if (outcome === "approved") return { approved: true };
  const why = {
    pending: "The user has not approved this action yet. Nothing was done; ask them to open approval_url and approve it, then call again with the same confirmation_code.",
    denied: "Nothing was done: the user denied this action.",
    gone: "This approval expired or was already used. Nothing was done; call again without confirmation_code and ask the user again.",
    failed: "The approval could not be checked, so nothing was done. Try again shortly.",
  }[outcome];
  return { approved: false, result: textResult(why, true) };
}

/**
 * Decides whether a request that needs approval (see approvalReasons) may be sent now. A client that can show its own
 * approval dialog is asked through it; any other gets a link to approve it in the Plivo console. Without an auth
 * proxy to hold approvals (local development) it gets a preview and a code, and only a call carrying a fresh code,
 * from the same caller, for this exact request is sent.
 */
export async function confirmGate(
  c: Confirmer,
  ctx: ServerContext,
  op: Operation,
  req: BuiltRequest,
  code: string | undefined,
  extra: string[] = [],
): Promise<Gate> {
  const d = await requestDigest(req);
  // Checked on both calls, so a code minted before a limit existed cannot approve what the limit refuses.
  const shown = preview(op, req, extra);
  if ("refusal" in shown) return { approved: false, result: shown.refusal };
  if (canElicit(ctx)) return askUser(c, ctx, d, shown.action);

  if (code !== undefined) {
    let p: Pending;
    try {
      p = await c.code.verify(code, ctx);
    } catch {
      return { approved: false, result: textResult("confirmation_code is invalid or expired. Call again without it to get a new one, and ask the user again.", true) };
    }
    if (p.d !== d || p.k === "elicit") return { approved: false, result: textResult("confirmation_code was issued for a different request. Nothing was done.", true) };
    return p.k === "link" ? redeemLink(c, ctx, p) : spend(c, ctx, code);
  }

  const link = await askByLink(c, ctx, d, shown.action);
  if (link) return link;

  return {
    approved: false,
    result: textResult({
      status: "confirmation_required",
      nothing_done_yet: true,
      action: shown.action,
      confirmation_code: await c.code.mint({ d, n: crypto.randomUUID() }, ctx),
      expires_in_seconds: CODE_TTL_SECONDS,
      instructions:
        "Show the user this action and ask them to approve it. Only if they explicitly say yes, call the same tool " +
        "again with exactly the same arguments plus confirmation_code. Never approve on the user's behalf.",
    }),
  };
}
