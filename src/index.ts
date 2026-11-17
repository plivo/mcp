import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { proxyApprovals } from "./approvals";
import { createConfirmer } from "./confirm";
import { landingPage, landingPolicy, wantsLandingPage } from "./landing";
import { handleOAuth, insufficientScopeChallenge, OAUTH_PATHS, resourceMetadataChallenge } from "./oauth";
import { buildServer, type ServerConfig } from "./server";
import { createTokenCheck } from "./tokencheck";
import { clientOf, parseCredential, readCapped } from "./upstream";

export interface Env {
  /** The auth proxy's /v1/proxy base in production; https://api.plivo.com for local development. */
  PLIVO_API_BASE: string;
  /** Comma-separated Host header values this Worker accepts, e.g. its workers.dev name. Localhost is always allowed. */
  ALLOWED_HOSTS?: string;
  /**
   * The origin clients reach this Worker at, e.g. "https://mcp.plivo.com", when a proxy in front of it forwards the
   * Worker's own Host. Sign-in metadata, the issuer and 401 challenges use it; it defaults to the request's origin.
   */
  PUBLIC_ORIGIN?: string;
  /** "true" accepts Basic auth_id:auth_token; local development only, never in production. */
  ALLOW_BASIC_AUTH?: string;
  /**
   * Writes that cost money or cannot be undone: "confirm" (default) asks the user, "block" refuses them,
   * "allow" sends them unasked (tests and local runs against a fake upstream only).
   */
  CONFIRMATION_MODE?: string;
  /** Signs confirmation state and codes; at least 32 characters. Set with `wrangler secret put CONFIRM_SECRET`. */
  CONFIRM_SECRET?: string;
  /** Origin of Plivo's browser login (/v1/accounts/cli/*). Setting it turns on OAuth sign-in for MCP clients. */
  PLIVO_LOGIN_BASE?: string;
  /** Signs OAuth client ids, logins and codes; at least 32 characters. Set with `wrangler secret put OAUTH_SECRET`. */
  OAUTH_SECRET?: string;
  /** The auth proxy's mcp_client_secret, sent when redeeming a login code and with every call to it; at least 32 characters. A Worker secret. */
  MCP_CLIENT_SECRET?: string;
  /**
   * When set (32+ characters), every request must carry it in X-Plivo-Edge-Secret, which the proxy in front of the
   * Worker adds; the Worker's own workers.dev address then answers no one else. Unset or empty checks nothing.
   */
  EDGE_SECRET?: string;
}

const EDGE_SECRET_HEADER = "X-Plivo-Edge-Secret";
// Named to end in "Key": the auth proxy's tracing redacts headers by name and that is a name it knows.
const CLIENT_SECRET_HEADER = "X-Plivo-MCP-Client-Key";

/**
 * A fetch that shows the auth proxy this server's client secret. The proxy honours an MCP token only beside it, so a
 * token read out of an AI app's config cannot be sent to Plivo around the approval this server asks for.
 */
function asThisServer(proxyBases: string[], secret: string, fetchImpl: typeof fetch = fetch): typeof fetch {
  const origins = new Set(proxyBases.map((b) => new URL(b).origin));
  return ((input: string, init?: RequestInit) =>
    origins.has(new URL(input).origin)
      ? fetchImpl(input, { ...init, headers: { ...(init?.headers as Record<string, string>), [CLIENT_SECRET_HEADER]: secret } })
      : fetchImpl(input, init)) as typeof fetch;
}

// Compared as digests, so the time taken says nothing about the secret or its length.
async function sameSecret(given: string, secret: string): Promise<boolean> {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(given), digest(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function confirmationMode(env: Env): ServerConfig["confirmationMode"] {
  return env.CONFIRMATION_MODE === "allow" || env.CONFIRMATION_MODE === "block" ? env.CONFIRMATION_MODE : "confirm";
}

function hostnames(env: Env): string[] {
  const extra = (env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return [...localhostAllowedHostnames(), ...extra];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The base every Authorization header is sent to: https, or http only to this machine. */
export function apiBaseError(base: string | undefined, name = "PLIVO_API_BASE"): string | undefined {
  let u: URL;
  try {
    u = new URL(base ?? "");
  } catch {
    return `${name} is not a URL`;
  }
  if (u.hostname.includes("replace-with")) return `${name} is still the placeholder`;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) {
    return `${name} must be https`;
  }
  return undefined;
}

function unauthorized(reason: string, challenge: string, error = "unauthorized", status = 401): Response {
  return new Response(JSON.stringify({ error, error_description: reason }), {
    status,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": challenge },
  });
}

// The SDK answers 413 past this itself; peeking at a body first must not buffer more than it would.
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

interface RpcMessage {
  method?: unknown;
  params?: { name?: unknown };
}

/** The messages of a JSON-RPC body (one or a batch); none when it is not JSON. */
async function rpcMessages(request: Request): Promise<(RpcMessage | null)[]> {
  const text = await readCapped(request.clone().body, MAX_REQUEST_BYTES);
  try {
    const body: unknown = JSON.parse(text);
    return (Array.isArray(body) ? body : [body]) as (RpcMessage | null)[];
  } catch {
    return [];
  }
}

function publicOriginError(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const why = apiBaseError(value, "PUBLIC_ORIGIN");
  if (why) return why;
  const u = new URL(value);
  return u.pathname !== "/" || u.search || u.hash ? "PUBLIC_ORIGIN must be an origin like https://mcp.plivo.com, with no path" : undefined;
}

function misconfigured(reason: string): Response {
  console.error(`plivo-mcp misconfigured: ${reason}`);
  return new Response("Server misconfigured\n", { status: 500 });
}

// Nothing the Worker serves is meant to be framed, sniffed or loaded by a page.
const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

function withSecurityHeaders(res: Response, policy?: string): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (policy) out.headers.set("Content-Security-Policy", policy);
  return out;
}

export function createWorker(plainFetch?: typeof fetch) {
  const tokenAccepted = createTokenCheck();
  const worker = {
    async fetch(request: Request, env: Env): Promise<Response> {
      let fetchImpl = plainFetch;
      // Trimmed: a header never carries the newline a piped `wrangler secret put` can leave on the secret.
      const expected = env.EDGE_SECRET?.trim();
      if (expected) {
        if (expected.length < 32) return misconfigured("EDGE_SECRET must be at least 32 characters");
        if (!(await sameSecret(request.headers.get(EDGE_SECRET_HEADER) ?? "", expected))) return new Response("Forbidden\n", { status: 403 });
      }
      const url = new URL(request.url);
      const originError = publicOriginError(env.PUBLIC_ORIGIN);
      if (originError) return misconfigured(originError);
      const publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : url.origin;
      if (OAUTH_PATHS.has(url.pathname) && env.PLIVO_LOGIN_BASE) {
        const badHost = hostHeaderValidationResponse(request, hostnames(env));
        if (badHost) return badHost;
        const oauthError =
          apiBaseError(env.PLIVO_LOGIN_BASE, "PLIVO_LOGIN_BASE") ??
          ((env.OAUTH_SECRET ?? "").length < 32 ? "OAUTH_SECRET must be at least 32 characters" : undefined) ??
          ((env.MCP_CLIENT_SECRET ?? "").length < 32 ? "MCP_CLIENT_SECRET must be at least 32 characters" : undefined);
        if (oauthError) return misconfigured(oauthError);
        return handleOAuth(request, {
          secret: env.OAUTH_SECRET!,
          loginBase: new URL(env.PLIVO_LOGIN_BASE).origin,
          clientSecret: env.MCP_CLIENT_SECRET!,
          publicOrigin,
          fetchImpl,
        });
      }
      if (url.pathname !== "/mcp") {
        if (url.pathname !== "/") return new Response("Not found\n", { status: 404 });
        return wantsLandingPage(request)
          ? landingPage(request)
          : new Response("Plivo MCP server. Connect an MCP client to /mcp.\n", { headers: { "Content-Type": "text/plain", Vary: "Accept" } });
      }

      const rejected =
        hostHeaderValidationResponse(request, hostnames(env)) ??
        originValidationResponse(request, [...localhostAllowedOrigins(), ...hostnames(env)]);
      if (rejected) return rejected;

      const mode = confirmationMode(env);
      const configError =
        apiBaseError(env.PLIVO_API_BASE) ??
        (env.PLIVO_LOGIN_BASE ? apiBaseError(env.PLIVO_LOGIN_BASE, "PLIVO_LOGIN_BASE") : undefined) ??
        (env.PLIVO_LOGIN_BASE && (env.MCP_CLIENT_SECRET ?? "").length < 32 ? "MCP_CLIENT_SECRET must be at least 32 characters" : undefined) ??
        (mode === "confirm" && (env.CONFIRM_SECRET ?? "").length < 32 ? "CONFIRM_SECRET must be at least 32 characters" : undefined) ??
        (mode === "allow" && !LOCAL_HOSTS.has(new URL(env.PLIVO_API_BASE).hostname)
          ? "CONFIRMATION_MODE=allow is only for a fake upstream on this machine"
          : undefined);
      if (configError) return misconfigured(configError);
      if (env.PLIVO_LOGIN_BASE) fetchImpl = asThisServer([env.PLIVO_LOGIN_BASE, env.PLIVO_API_BASE], env.MCP_CLIENT_SECRET!, plainFetch);

      const challenge = (invalidToken = false) =>
        env.PLIVO_LOGIN_BASE
          ? resourceMetadataChallenge(publicOrigin, invalidToken)
          : `Bearer realm="plivo"${invalidToken ? ', error="invalid_token"' : ""}`;
      const cred = parseCredential(request.headers.get("Authorization"), env.ALLOW_BASIC_AUTH === "true");
      if ("error" in cred) return unauthorized(cred.error, challenge());
      Object.assign(cred, clientOf(request.headers));

      let tokenRejected = false;
      let scopeMissing = false;
      const onTokenRejected = () => {
        tokenRejected = true;
      };
      const config: ServerConfig = {
        apiBase: env.PLIVO_API_BASE,
        confirmationMode: mode,
        confirmer:
          mode === "confirm"
            ? createConfirmer(
                env.CONFIRM_SECRET!,
                env.PLIVO_LOGIN_BASE ? proxyApprovals(new URL(env.PLIVO_LOGIN_BASE).origin, fetchImpl) : undefined,
                onTokenRejected,
              )
            : undefined,
        fetchImpl,
        onTokenRejected,
        onScopeMissing: () => {
          scopeMissing = true;
        },
      };
      const messages = request.method === "POST" ? await rpcMessages(request) : [];
      const toolCall = messages.some((m) => m?.method === "tools/call");
      const tokenRefused = () => unauthorized("Plivo refused this token: it has expired or was revoked. Sign in again.", challenge(true), "invalid_token");
      // Tool calls included: one that fails validation or stops for approval never reaches the auth proxy.
      if (env.PLIVO_LOGIN_BASE && !(await tokenAccepted(cred, env.PLIVO_API_BASE, fetchImpl))) return tokenRefused();
      const handler = createMcpHandler((ctx) => buildServer(ctx, config));
      const res = await handler.fetch(request, { authInfo: { token: cred.authorization, clientId: "", scopes: [], extra: { credential: cred } } });
      if (!toolCall) return res;
      // A streamed reply may still be running the tool, so whether Plivo refused the token is known only once it is read.
      const body = await res.arrayBuffer();
      if (tokenRejected) return tokenRefused();
      if (scopeMissing && env.PLIVO_LOGIN_BASE) {
        return unauthorized(
          "This connection was approved before this tool's permission existed. Approve the Plivo connection again to use it.",
          insufficientScopeChallenge(publicOrigin),
          "insufficient_scope",
          403,
        );
      }
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    },
  };
  return {
    fetch: async (request: Request, env: Env) => {
      const res = await worker.fetch(request, env);
      return withSecurityHeaders(res, await landingPolicy(res));
    },
  };
}

export default createWorker();
