import { findParam, type Operation } from "./catalog";
import { notGrantedModule } from "./permissions";

export interface Credential {
  /** The caller's Authorization header, forwarded unchanged. */
  authorization: string;
  /** Value for {auth_id} in the path. The auth proxy resolves `me` from the stk_ token. */
  authId: string;
  /** The connecting IP, the MCP app (its User-Agent) and X-Forwarded-For, sent to the auth proxy for its logs only. */
  clientIp?: string;
  client?: string;
  forwardedFor?: string;
}

// The auth proxy mints "stk_" + 32 base62 characters.
export const STK_RE = /^Bearer (stk_[A-Za-z0-9]{32})$/;
export const AUTH_ID_RE = /^[A-Za-z0-9]{10,40}$/;

/**
 * Accepts `Bearer stk_…` (production: the auth proxy swaps it for the account's credentials), and HTTP
 * Basic `auth_id:auth_token` only when allowBasic is set, for local development against
 * api.plivo.com.
 */
export function parseCredential(header: string | null, allowBasic: boolean): Credential | { error: string } {
  if (!header) return { error: "missing Authorization header" };
  if (STK_RE.test(header)) return { authorization: header, authId: "me" };
  if (header.startsWith("Basic ")) {
    if (!allowBasic) return { error: "Basic auth is disabled; use a Plivo stk_ token" };
    let decoded: string;
    try {
      decoded = atob(header.slice(6));
    } catch {
      return { error: "malformed Basic credentials" };
    }
    const authId = decoded.split(":", 1)[0];
    if (!AUTH_ID_RE.test(authId) || !decoded.includes(":")) return { error: "malformed Basic credentials" };
    return { authorization: header, authId };
  }
  return { error: "unsupported Authorization scheme" };
}

const IPV4_PART = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${IPV4_PART}(\\.${IPV4_PART}){3}$`, "u");
const MAX_CLIENT = 200;
const MAX_FORWARDED = 256;

// The character check keeps anything but an address out of the brackets; the URL parser checks IPv6 syntax.
const isIp = (v: string) => IPV4.test(v) || (v.includes(":") && /^[\da-f:.]+$/iu.test(v) && URL.canParse(`http://[${v}]/`));
// Printable ASCII only: it cannot break a log line, and fetch never refuses it and fails the call.
const printable = (v: string | null, max: number) => (v ?? "").replace(/[^\x20-\x7e]/gu, "").trimStart().slice(0, max).trimEnd();

export function clientOf(headers: Headers): Pick<Credential, "clientIp" | "client" | "forwardedFor"> {
  const ip = headers.get("CF-Connecting-IP") ?? "";
  const app = printable(headers.get("User-Agent"), MAX_CLIENT);
  // CloudFront sits in front, so CF-Connecting-IP is its edge; the caller's own address is only in X-Forwarded-For.
  const forwarded = printable(headers.get("X-Forwarded-For"), MAX_FORWARDED);
  return { ...(isIp(ip) ? { clientIp: ip } : {}), ...(app ? { client: app } : {}), ...(forwarded ? { forwardedFor: forwarded } : {}) };
}

export function clientHeaders(cred: Credential): Record<string, string> {
  return {
    "X-Request-Id": crypto.randomUUID(),
    ...(cred.clientIp ? { "X-MCP-Client-IP": cred.clientIp } : {}),
    ...(cred.client ? { "X-MCP-Client": cred.client } : {}),
    ...(cred.forwardedFor ? { "X-MCP-Forwarded-For": cred.forwardedFor } : {}),
  };
}

export interface CallArgs {
  path_params?: Record<string, string | number>;
  params?: Record<string, unknown>;
}

export interface BuiltRequest {
  url: string;
  method: string;
  body?: string;
  warnings: string[];
}

// A path value must stay one segment: '/', '?', '#' or '%' would let it reach another resource.
const UNSAFE_SEGMENT = /[/\\?#%\s]|^\.\.?$/;

function pathValue(name: string, raw: string | number | undefined): string | { error: string } {
  if (raw === undefined || raw === null) return { error: `missing path param "${name}"` };
  if (typeof raw !== "string" && typeof raw !== "number") return { error: `path param "${name}" must be a string or number` };
  const v = String(raw).trim();
  if (v === "" || v.length > 200 || UNSAFE_SEGMENT.test(v)) return { error: `path param "${name}" is not a valid ID: ${JSON.stringify(raw)}` };
  // Member and participant IDs take comma lists (1,2), which the API expects unescaped.
  return encodeURIComponent(v).replaceAll("%2C", ",");
}

export function buildRequest(op: Operation, args: CallArgs, cred: Credential, base: string): BuiltRequest | { error: string } {
  const warnings: string[] = [];
  const pathParams = args.path_params ?? {};
  const declared = new Set((op.path_params ?? []).map((p) => p.name));
  for (const k of Object.keys(pathParams)) {
    if (!declared.has(k)) return { error: `"${k}" is not a path param of ${op.id}; path params: ${[...declared].join(", ") || "none"}` };
  }

  let pathError: string | undefined;
  const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    if (name === "auth_id") return encodeURIComponent(cred.authId);
    const v = pathValue(name, Object.hasOwn(pathParams, name) ? pathParams[name] : undefined);
    if (typeof v !== "string") {
      pathError ??= v.error;
      return "";
    }
    return v;
  });
  if (pathError) return { error: pathError };

  const query = new URLSearchParams(op.fixed_query ?? {});
  // No prototype: a "__proto__" key from JSON stays an ordinary field instead of vanishing from the body.
  const body: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(args.params ?? {})) {
    if (v === undefined) continue;
    if (declared.has(k)) return { error: `"${k}" is a path param; pass it in path_params` };
    if (op.fixed_query && Object.hasOwn(op.fixed_query, k)) return { error: `"${k}" is fixed to "${op.fixed_query[k]}" for ${op.id}` };
    const p = findParam(op, k);
    if (!p) warnings.push(`"${k}" is not in the documented params for ${op.id}; sent as-is`);
    else if (p.deprecated) warnings.push(`"${k}" is deprecated`);
    const where = p?.in === "query" || p?.in === "body" ? p.in : op.method === "GET" ? "query" : "body";
    if (where === "query") {
      if (v === null || typeof v === "object") return { error: `query param "${k}" must be a string, number or boolean` };
      query.set(k, String(v));
    } else {
      body[k] = v;
    }
  }

  const qs = query.toString();
  const hasBody = Object.keys(body).length > 0;
  if (hasBody && op.method === "GET") return { error: `${op.id} takes no request body` };
  return {
    url: base.replace(/\/+$/, "") + path + (qs ? `?${qs}` : ""),
    method: op.method,
    // Plivo refuses a bodiless write as not JSON, and the auth proxy forwards no Content-Type without a body.
    body: hasBody ? JSON.stringify(body) : op.method === "GET" || op.method === "DELETE" ? undefined : "{}",
    warnings,
  };
}

export interface UpstreamResult {
  status: number;
  ok: boolean;
  body: unknown;
  /** The auth proxy refused the caller's token itself (not a 401 from Plivo behind it). */
  tokenRejected?: boolean;
  /** The auth proxy refused the call because the token was minted without the module it needs. */
  scopeMissing?: boolean;
  /** The module this call needs and the user chose not to grant at sign-in; a new sign-in is theirs to start. */
  notGranted?: string;
  /** The audio a call returned, when the caller asked for audio and Plivo sent it. */
  audio?: { data: Uint8Array; mime: string };
  /** Plivo sent more audio than the caller allowed, so none is returned although the request was carried out. */
  audioTooLarge?: boolean;
}

export const SECRET_KEY = new RegExp(
  ["token", "password", "passwd", "pwd", "passphrase", "secret", "api[_-]?key", "private[_-]?key", "authorization", "bearer", "jwt", "cookie"].join("|"),
  "iu",
);
// Plivo's agent API returns a stored secret as this, and keeps that secret when it is sent back.
export const KEPT_PLACEHOLDER = `${"*".repeat(3)}REDACTED${"*".repeat(3)}`;
export const HIDDEN = "[hidden]";
const PIN_KEY = /(^|[_-])pin$/iu;
// A number under one of these can be the credential itself; under `token` it is a count or a lifetime.
const NUMBER_KEYS = new RegExp(`passw|pwd|passphrase|secret|${PIN_KEY.source}`, "iu");
// Inside an error, `authorization: "missing"` is the reason, not a credential.
const ERROR_REASON_KEY = /^authorization$/iu;
const ERROR_KEY = /^(errors?|message)$/iu;
// Named after a secret, yet state about it or a cursor the model must send back.
const STATE_OR_CURSOR = /[_-](status|enabled|count|type|at|id)$|(^|[_-])(next|page|continuation|cursor|pagination)[_-]?token$/iu;
const COUNT_KEY = /tokens$/iu;
const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/u;
const MAX_DEPTH = 50;
const LOOKS_LIKE_JSON = /^\s*[[{]/u;
const WITHHELD = "Plivo's reply was too large to show safely. Narrow the request with limit/offset or filters.";

const SCHEMA_KEYWORDS = new Set(
  "type description title format enum default examples pattern items properties required minLength maxLength $ref anyOf oneOf allOf nullable readOnly writeOnly".split(" "),
);

/** Whether a key names a credential, before the exceptions a reply needs. */
export const secretNamed = (key: string) => SECRET_KEY.test(key) || PIN_KEY.test(key);

/** The secret name beside a `value`, the way a list of headers is written: any `name` or `key` field may hold it. */
export function pairName(fields: [string, unknown][], secret: (name: string) => boolean = secretNamed): string | undefined {
  return fields.map(([k, x]) => (/^(name|key)$/iu.test(k) && typeof x === "string" && secret(x) ? x : undefined)).find(Boolean);
}

function schemaNode(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const typed = typeof o.type === "string" || (Array.isArray(o.type) && o.type.every((t) => typeof t === "string"));
  return typed || ["$ref", "anyOf", "oneOf", "allOf", "enum"].some((k) => Object.hasOwn(o, k));
}

type Hide = "nothing" | "text" | "text and numbers";

function hideUnder(key: string, inError: boolean): Hide {
  if (!secretNamed(key) || STATE_OR_CURSOR.test(key) || (inError && ERROR_REASON_KEY.test(key))) return "nothing";
  return NUMBER_KEYS.test(key) ? "text and numbers" : "text";
}

/**
 * A reply with its credential fields blanked at any depth: an endpoint read returns the SIP password. Only a value
 * that could be a credential is hidden: text under a secret-named key, a number under a password-like one, and the
 * `value` beside a secret-named `name` or `key`, the way a list of headers is written. JSON held in a text field is
 * searched too. A JSON Schema node under `properties` describes a field without holding it, so its keywords stay.
 */
export function hideSecrets(v: unknown, hide: Hide = "nothing", depth = 0, inError = false, count = false, schema = false): unknown {
  if (depth > MAX_DEPTH) return HIDDEN;
  if (Array.isArray(v)) return v.map((x) => hideSecrets(x, hide, depth + 1, inError, count));
  if (v !== null && typeof v === "object") {
    const fields = Object.entries(v);
    const name = pairName(fields, (n) => hideUnder(n, inError) !== "nothing");
    const under = (k: string): Hide => (hide !== "nothing" ? hide : hideUnder(/^value$/iu.test(k) && name !== undefined ? name : k, inError));
    const next = (k: string, x: unknown, h: Hide) => hideSecrets(x, h, depth + 1, inError || ERROR_KEY.test(k), COUNT_KEY.test(k), /^properties$/iu.test(k));
    // fromEntries defines "__proto__" as a field; assignment would drop it.
    return Object.fromEntries(
      fields.map(([k, x]) => {
        if (!schema || hide !== "nothing" || !schemaNode(x)) return [k, next(k, x, under(k))];
        // A schema describes the field named k; only a default or an example of it can be a real value.
        const rest = (word: string) => (under(k) !== "nothing" ? under(k) : SCHEMA_KEYWORDS.has(word) ? "nothing" : under(word));
        const described = Object.entries(x).map(([word, d]) => [word, next(word, d, SCHEMA_KEYWORDS.has(word) && !/^(default|examples)$/u.test(word) ? "nothing" : rest(word))]);
        return [k, Object.fromEntries(described)];
      }),
    );
  }
  if (hide !== "nothing") {
    if (typeof v === "number") return hide === "text and numbers" ? HIDDEN : v;
    if (typeof v !== "string" || v === "" || v === KEPT_PLACEHOLDER || (count && NUMERIC.test(v))) return v;
    return HIDDEN;
  }
  if (typeof v !== "string" || !LOOKS_LIKE_JSON.test(v)) return v;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return v;
  }
  const shown = JSON.stringify(hideSecrets(parsed, "nothing", depth + 1, inError));
  return shown === JSON.stringify(parsed) ? v : shown;
}

/** A body cut at the size limit no longer parses, so its secrets cannot be found field by field: it is not shown at all. */
function clippedSecrets(text: string): boolean {
  const plain = text.replace(/\\u([0-9a-f]{4})/giu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return LOOKS_LIKE_JSON.test(text) && SECRET_KEY.test(plain);
}

const TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 1_000_000;

const AUDIO_MIME = /^audio\/[\w.+-]+$/u;

/** `audioMax` is the most audio bytes to return, for a call that answers with audio; the rest of the call is unchanged. */
export async function callUpstream(
  req: BuiltRequest,
  cred: Credential,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS,
  audioMax?: number,
): Promise<UpstreamResult> {
  const headers: Record<string, string> = {
    Authorization: cred.authorization,
    Accept: audioMax === undefined ? "application/json" : "audio/mpeg, application/json",
    "User-Agent": "plivo-mcp/0.1",
    ...clientHeaders(cred),
  };
  if (req.body !== undefined) headers["Content-Type"] = "application/json";
  // redirect: "manual" so a 3xx can never carry the Authorization header to another host.
  const res = await fetchImpl(req.url, {
    method: req.method,
    headers,
    body: req.body,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    return { status: res.status, ok: false, body: { error: "upstream redirected; not followed" } };
  }
  const mime = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (audioMax !== undefined && res.ok && AUDIO_MIME.test(mime)) {
    // One byte past the limit tells "exactly at it" from "more than it".
    const { bytes, clipped } = await readCappedBytes(res.body, audioMax + 1);
    return clipped ? { status: res.status, ok: true, body: null, audioTooLarge: true } : { status: res.status, ok: true, body: null, audio: { data: bytes, mime } };
  }
  const text = await readCapped(res.body, MAX_BODY_BYTES);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON bodies (rare error pages, or a clipped body) are returned as text.
    if (clippedSecrets(text)) body = WITHHELD;
  }
  // The proxy marks its own token refusals; Plivo's 401 for the account behind a valid token must not
  // send the client into a sign-in loop.
  const tokenRejected = res.status === 401 && /\binvalid_token\b/.test(res.headers.get("WWW-Authenticate") ?? "");
  // The proxy names the missing module under errors.required_module; Plivo's own 403s use `error` and never carry it.
  const notGranted = notGrantedModule(res.status, body);
  const scopeMissing =
    notGranted === undefined && res.status === 403 && typeof (body as { errors?: { required_module?: unknown } } | null)?.errors?.required_module === "string";
  return {
    status: res.status,
    ok: res.ok,
    body: hideSecrets(body),
    ...(tokenRejected ? { tokenRejected } : {}),
    ...(scopeMissing ? { scopeMissing } : {}),
    ...(notGranted !== undefined ? { notGranted } : {}),
  };
}

/** Reads at most max bytes of a body, so an oversized one cannot exhaust the Worker's memory. */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  return new TextDecoder().decode((await readCappedBytes(stream, max)).bytes);
}

/** The bytes of a body up to max, and whether the body reached max (so it may hold more). */
export async function readCappedBytes(stream: ReadableStream<Uint8Array> | null, max: number): Promise<{ bytes: Uint8Array; clipped: boolean }> {
  if (!stream) return { bytes: new Uint8Array(), clipped: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  // Not awaited: on a cloned request's body the cancel settles only once the other branch is read too.
  if (size >= max) reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.byteLength - at);
    all.set(c.subarray(0, take), at);
    at += take;
    if (at >= all.byteLength) break;
  }
  return { bytes: all, clipped: size >= max };
}
