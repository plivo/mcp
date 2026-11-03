import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { createConfirmer } from "./confirm";
import { buildServer, type ServerConfig } from "./server";
import { parseCredential } from "./upstream";

export interface Env {
  /** The auth proxy's /v1/proxy base in production; https://api.plivo.com for local development. */
  PLIVO_API_BASE: string;
  /** Comma-separated hostnames this Worker answers on, e.g. "mcp.plivo.com". Localhost is always allowed. */
  ALLOWED_HOSTS?: string;
  /** "true" accepts Basic auth_id:auth_token; local development only, never in production. */
  ALLOW_BASIC_AUTH?: string;
  /**
   * Writes that cost money or cannot be undone: "confirm" (default) asks the user, "block" refuses them,
   * "allow" sends them unasked (tests and local runs against a fake upstream only).
   */
  CONFIRMATION_MODE?: string;
  /** Signs confirmation state and codes; at least 32 characters. Set with `wrangler secret put CONFIRM_SECRET`. */
  CONFIRM_SECRET?: string;
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
export function apiBaseError(base: string | undefined): string | undefined {
  let u: URL;
  try {
    u = new URL(base ?? "");
  } catch {
    return "PLIVO_API_BASE is not a URL";
  }
  if (u.hostname.includes("replace-with")) return "PLIVO_API_BASE is still the placeholder";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) {
    return "PLIVO_API_BASE must be https";
  }
  return undefined;
}

function unauthorized(reason: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", error_description: reason }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="plivo"' },
  });
}

export function createWorker(fetchImpl?: typeof fetch) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
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
      if (configError) {
        console.error(`plivo-mcp misconfigured: ${configError}`);
        return new Response("Server misconfigured\n", { status: 500 });
      }

      const cred = parseCredential(request.headers.get("Authorization"), env.ALLOW_BASIC_AUTH === "true");
      if ("error" in cred) return unauthorized(cred.error);

      const config: ServerConfig = {
        apiBase: env.PLIVO_API_BASE,
        confirmationMode: mode,
        confirmer: mode === "confirm" ? createConfirmer(env.CONFIRM_SECRET!) : undefined,
        fetchImpl,
      };
      const handler = createMcpHandler((ctx) => buildServer(ctx, config));
      return handler.fetch(request, { authInfo: { token: cred.authorization, clientId: "", scopes: [], extra: { credential: cred } } });
    },
  };
}

export default createWorker();
