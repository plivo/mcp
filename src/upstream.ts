import { findParam, type Operation } from "./catalog";

export interface Credential {
  /** The caller's Authorization header, forwarded unchanged. */
  authorization: string;
  /** Value for {auth_id} in the path. The auth proxy resolves `me` from the stk_ token. */
  authId: string;
}

// The auth proxy mints "stk_" + 32 base62 characters.
const STK_RE = /^Bearer (stk_[A-Za-z0-9]{32})$/;
const AUTH_ID_RE = /^[A-Za-z0-9]{10,40}$/;

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
    body: hasBody ? JSON.stringify(body) : undefined,
    warnings,
  };
}

export interface UpstreamResult {
  status: number;
  ok: boolean;
  body: unknown;
  /** The auth proxy refused the caller's token itself (not a 401 from Plivo behind it). */
  tokenRejected?: boolean;
}

const TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 1_000_000;

export async function callUpstream(req: BuiltRequest, cred: Credential, fetchImpl: typeof fetch = fetch): Promise<UpstreamResult> {
  const headers: Record<string, string> = {
    Authorization: cred.authorization,
    Accept: "application/json",
    "User-Agent": "plivo-mcp/0.1",
  };
  if (req.body !== undefined) headers["Content-Type"] = "application/json";
  // redirect: "manual" so a 3xx can never carry the Authorization header to another host.
  const res = await fetchImpl(req.url, {
    method: req.method,
    headers,
    body: req.body,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    return { status: res.status, ok: false, body: { error: "upstream redirected; not followed" } };
  }
  const text = await readCapped(res.body, MAX_BODY_BYTES);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON bodies (rare error pages, or a clipped body) are returned as text.
  }
  // The proxy marks its own token refusals; Plivo's 401 for the account behind a valid token must not
  // send the client into a sign-in loop.
  const tokenRejected = res.status === 401 && /\binvalid_token\b/.test(res.headers.get("WWW-Authenticate") ?? "");
  return { status: res.status, ok: res.ok, body, ...(tokenRejected ? { tokenRejected } : {}) };
}

/** Reads at most max bytes of a body, so an oversized one cannot exhaust the Worker's memory. */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!stream) return "";
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
  return new TextDecoder().decode(all);
}
