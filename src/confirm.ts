import { createRequestStateCodec, type CallToolResult, type RequestStateCodec, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { getOperation, type Operation } from "./catalog";
import type { BuiltRequest } from "./upstream";

const KEEPS_ACCESS = "This creates or changes a way to place calls on this account, and it keeps working after this app is disconnected.";
const REROUTES = "This changes where this account's calls or messages are sent.";
const MOVES_CALL = "This moves a live call somewhere else.";

// Free and undoable, yet they outlive a revoked token or send traffic elsewhere, so a prompt injection could
// use them for lasting harm.
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
  "POST /Application/{app_id}/": REROUTES,
  "POST /Number/{number}/": REROUTES,
  "POST /Powerpack/": REROUTES,
  "POST /Powerpack/{powerpack_uuid}/": REROUTES,
  "POST /Call/{call_uuid}/": MOVES_CALL,
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

const MAX_FIELDS = 12;
const MAX_VALUE_CHARS = 200;
const PLAIN_KEY = /^[A-Za-z0-9_.[\]-]+$/;
// The preview lands in the chat transcript; like the CLI, never print a password back.
const HIDDEN_FIELD = /password|secret/i;

/**
 * The plain-text description of the action the user is asked to approve. The model controls the argument
 * order and values, so it must not decide what the user sees: required params come first, then documented
 * ones, and values are JSON-escaped so a newline in one cannot forge another line.
 */
export function describeAction(op: Operation, req: BuiltRequest): string {
  const u = new URL(req.url);
  const path = u.pathname.replace(/^.*\/v1\/Account\/[^/]+/, "") || "/";
  const lines = [`${op.title} (${op.method} ${path}${u.search})`, ...approvalReasons(op)];
  if (ASKS_FIRST[op.id] === KEEPS_ACCESS) lines.push("If it is no longer needed later, delete it in the Plivo console.");

  const body = req.body === undefined ? {} : (JSON.parse(req.body) as Record<string, unknown>);
  const rank = new Map(op.params.map((p, i) => [p.name, p.required ? i : op.params.length + i]));
  const unranked = 2 * op.params.length;
  const names = Object.keys(body).sort((a, b) => (rank.get(a) ?? unranked) - (rank.get(b) ?? unranked) || (a < b ? -1 : a > b ? 1 : 0));
  for (const k of names.slice(0, MAX_FIELDS)) {
    const s = JSON.stringify(body[k]) ?? "null";
    const shown = HIDDEN_FIELD.test(k)
      ? `(hidden, ${typeof body[k] === "string" ? body[k].length : s.length} characters)`
      : s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS)}… (${s.length} characters)` : s;
    lines.push(`${PLAIN_KEY.test(k) ? k : JSON.stringify(k)}${rank.has(k) ? "" : " (not a documented param)"}: ${shown}`);
  }
  if (names.length > MAX_FIELDS) lines.push(`…and ${names.length - MAX_FIELDS} more fields`);
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

  return {
    approved: false,
    result: textResult({
      status: "confirmation_required",
      nothing_done_yet: true,
      action: describeAction(op, req),
      confirmation_code: await c.code.mint({ d }, ctx),
      expires_in_seconds: CODE_TTL_SECONDS,
      instructions:
        "Show the user this action and ask them to approve it. Only if they explicitly say yes, call the same tool " +
        "again with exactly the same arguments plus confirmation_code. Never approve on the user's behalf.",
    }),
  };
}
