import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { createConfirmer } from "./confirm";
import { handleOAuth, OAUTH_PATHS, resourceMetadataChallenge } from "./oauth";
import { buildServer, type ServerConfig } from "./server";
import { parseCredential, readCapped } from "./upstream";

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
  /** The auth proxy's mcp_client_secret, sent when redeeming a login code; at least 32 characters. A Worker secret. */
  MCP_CLIENT_SECRET?: string;
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

function unauthorized(reason: string, challenge: string, error = "unauthorized"): Response {
  return new Response(JSON.stringify({ error, error_description: reason }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": challenge },
  });
}

// The SDK answers 413 past this itself; peeking at a body first must not buffer more than it would.
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** Whether a JSON-RPC body (one message or a batch) calls a tool: the only requests that reach Plivo. */
async function callsTool(request: Request): Promise<boolean> {
  const text = await readCapped(request.clone().body, MAX_REQUEST_BYTES);
  try {
    const body: unknown = JSON.parse(text);
    return (Array.isArray(body) ? body : [body]).some((m) => (m as { method?: unknown } | null)?.method === "tools/call");
  } catch {
    return false;
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

export function createWorker(fetchImpl?: typeof fetch) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
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
        return url.pathname === "/"
          ? new Response("Plivo MCP server. Connect an MCP client to /mcp.\n", { headers: { "Content-Type": "text/plain" } })
          : new Response("Not found\n", { status: 404 });
      }

      const rejected =
        hostHeaderValidationResponse(request, hostnames(env)) ??
        originValidationResponse(request, [...localhostAllowedOrigins(), ...hostnames(env)]);
      if (rejected) return rejected;

      const mode = confirmationMode(env);
      const configError =
        apiBaseError(env.PLIVO_API_BASE) ??
        (mode === "confirm" && (env.CONFIRM_SECRET ?? "").length < 32 ? "CONFIRM_SECRET must be at least 32 characters" : undefined) ??
        (mode === "allow" && !LOCAL_HOSTS.has(new URL(env.PLIVO_API_BASE).hostname)
          ? "CONFIRMATION_MODE=allow is only for a fake upstream on this machine"
          : undefined);
      if (configError) return misconfigured(configError);

      const challenge = (invalidToken = false) =>
        env.PLIVO_LOGIN_BASE
          ? resourceMetadataChallenge(publicOrigin, invalidToken)
          : `Bearer realm="plivo"${invalidToken ? ', error="invalid_token"' : ""}`;
      const cred = parseCredential(request.headers.get("Authorization"), env.ALLOW_BASIC_AUTH === "true");
      if ("error" in cred) return unauthorized(cred.error, challenge());

      let tokenRejected = false;
      const config: ServerConfig = {
        apiBase: env.PLIVO_API_BASE,
        confirmationMode: mode,
        confirmer: mode === "confirm" ? createConfirmer(env.CONFIRM_SECRET!) : undefined,
        fetchImpl,
        onTokenRejected: () => {
          tokenRejected = true;
        },
      };
      const toolCall = request.method === "POST" && (await callsTool(request));
      const handler = createMcpHandler((ctx) => buildServer(ctx, config));
      const res = await handler.fetch(request, { authInfo: { token: cred.authorization, clientId: "", scopes: [], extra: { credential: cred } } });
      if (!toolCall) return res;
      // A streamed reply may still be running the tool, so whether Plivo refused the token is known only once it is read.
      const body = await res.arrayBuffer();
      if (tokenRejected) {
        return unauthorized("Plivo refused this token: it has expired or was revoked. Sign in again.", challenge(true), "invalid_token");
      }
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    },
  };
}

export default createWorker();
