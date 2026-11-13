import { createRequestStateCodec, type CallToolResult, type RequestStateCodec, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
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

// Free and undoable, yet they outlive a revoked token, send traffic elsewhere or change what an AI agent does
// on live traffic, so a prompt injection could use them for lasting harm.
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

/** What the user approves: one exact request (method, URL and body), by digest. */
interface Pending {
  d: string;
}

export interface Confirmer {
  code: RequestStateCodec<Pending>;
}

export const CODE_TTL_SECONDS = 300;

export const confirmationCodeField = z
  .string()
  .max(2000)
  .optional()
  .describe("Only after a previous call returned confirmation_required and the user approved that exact action.");

export function createConfirmer(secret: string): Confirmer {
  // Bound to the caller's credential: one account's approval cannot authorize another's request.
  const bind = (ctx: ServerContext) => ctx.http?.authInfo?.token ?? "";
  return { code: createRequestStateCodec<Pending>({ key: secret, ttlSeconds: CODE_TTL_SECONDS, bind }) };
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
// (usecases/agent_management.py): secret-named fields at any depth, unparseable JSON-encoded credential
// fields and URL credentials. Like the CLI, it never prints a password back.
const SECRET_KEY = new RegExp(["token", "password", "secret", "api[_-]?key", "authorization", "cookie"].join("|"), "i");
const JSON_SECRET_FIELDS = new Set(["headers", "params", "body", "auth_params", "http_headers", "http_params", "http_body_template"]);
const WHOLE_TEMPLATE = /^\{\{[^{}]*\}\}$/;
const MAX_DEPTH = 50;

const hide = (s: string) => `(hidden, ${s.length} characters)`;

function decoded(s: string): string {
  try {
    return decodeURIComponent(s.replaceAll("+", " "));
  } catch {
    return s;
  }
}

function hideUrlCredentials(s: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/is.exec(s);
  if (!m) return s;
  let authority = m[2];
  const at = authority.lastIndexOf("@");
  const colon = at > 0 ? authority.slice(0, at).indexOf(":") : -1;
  if (colon >= 0) authority = `${authority.slice(0, colon)}:(hidden)${authority.slice(at)}`;
  return m[1] + authority + m[3] + hideQuerySecrets(m[4] ?? "") + (m[5] ?? "");
}

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
  if (depth > MAX_DEPTH) return "(hidden)";
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
    return canonical(r) === canonical(parsed) ? v : JSON.stringify(r);
  }
  if (JSON_SECRET_FIELDS.has(key) && !(v.includes("{{") && v.includes("}}"))) return hide(v);
  return hideUrlCredentials(v);
}

/**
 * The plain-text description of the action the user is asked to approve. The model controls the argument
 * order and values, so it must not decide what the user sees: required params come first, then documented
 * ones, and values are JSON-escaped so a newline in one cannot forge another line.
 */
export function describeAction(op: Operation, req: BuiltRequest): string {
  const u = new URL(req.url);
  const path = u.pathname.replace(/^.*\/v1\/Account\/[^/]+/, "") || "/";
  const lines = [`${op.title} (${op.method} ${path}${hideQuerySecrets(u.search)})`, ...approvalReasons(op)];
  if (ASKS_FIRST[op.id] === KEEPS_ACCESS) lines.push("If it is no longer needed later, delete it in the Plivo console.");

  const body = req.body === undefined ? {} : (JSON.parse(req.body) as Record<string, unknown>);
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

export type Gate = { approved: true } | { approved: false; result: CallToolResult };

function textResult(value: unknown, isError = false): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Decides whether a request that needs approval (see approvalReasons) may be sent now. The first call returns a
 * preview and a code; only a call carrying a fresh code, from the same caller, for this exact request is sent.
 */
export async function confirmGate(c: Confirmer, ctx: ServerContext, op: Operation, req: BuiltRequest, code: string | undefined): Promise<Gate> {
  const d = await requestDigest(req);

  if (code !== undefined) {
    let p: Pending;
    try {
      p = await c.code.verify(code, ctx);
    } catch {
      return { approved: false, result: textResult("confirmation_code is invalid or expired. Call again without it to get a new one, and ask the user again.", true) };
    }
    if (p.d === d) return { approved: true };
    return { approved: false, result: textResult("confirmation_code was issued for a different request. Nothing was done.", true) };
  }

  const action = describeAction(op, req);
  if (action.length > MAX_PREVIEW_CHARS) {
    return {
      approved: false,
      result: textResult(
        `Nothing was done: this action is ${action.length} characters, too long to show the user for approval (the limit is ` +
          `${MAX_PREVIEW_CHARS}). Make the change in smaller steps if the operation allows it, or in the Plivo console.`,
        true,
      ),
    };
  }
  return {
    approved: false,
    result: textResult({
      status: "confirmation_required",
      nothing_done_yet: true,
      action,
      confirmation_code: await c.code.mint({ d }, ctx),
      expires_in_seconds: CODE_TTL_SECONDS,
      instructions:
        "Show the user this action and ask them to approve it. Only if they explicitly say yes, call the same tool " +
        "again with exactly the same arguments plus confirmation_code. Never approve on the user's behalf.",
    }),
  };
}
