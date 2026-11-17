// OAuth 2.1 authorization server for MCP clients. It keeps no state: client ids, the login in progress
// and authorization codes are HMAC-signed values. The login itself is Plivo's `plivo login` browser flow
// with client=mcp, which ends in an stk_ scope token minted by the auth proxy.

import { STK_RE } from "./upstream";

export interface OAuthConfig {
  secret: string;
  loginBase: string;
  /** Proves to the auth proxy that this server, and no one else, is redeeming an MCP login code. */
  clientSecret: string;
  /** Where clients reach this server; it names itself with this in metadata, the issuer and the login cookie. */
  publicOrigin: string;
  fetchImpl?: typeof fetch;
  /** Counts registrations per caller address. Without it (local runs, tests) registration is not limited. */
  registerLimiter?: RateLimit;
}

export const OAUTH_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/register",
  "/authorize",
  "/oauth/callback",
  "/token",
  "/oauth/revoke",
]);

const LOGIN_TTL_SECONDS = 600;
// The auth proxy's own code lives 60 s, so a longer one here could only fail later.
const CODE_TTL_SECONDS = 60;
const MAX_REDIRECT_URIS = 5;
const MAX_FIELD_CHARS = 512;
const MAX_NAME_CHARS = 100;
// The auth proxy refuses a longer consent-screen label, so the host must leave room for part of the name.
const MAX_LABEL_CHARS = 128;
const MAX_SHOWN_HOST_CHARS = 100;
const MAX_BODY_CHARS = 16_384;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Handled by the browser or the operating system itself, so a redirect to one starts that handler and reaches no MCP
// app. The list cannot be complete, which is why the consent label always names an app scheme.
const SYSTEM_SCHEMES = new Set(
  (
    "javascript data vbscript file blob about filesystem view-source ftp ftps sftp ws wss chrome chrome-extension chrome-untrusted " +
    "devtools edge moz-extension safari-extension safari-web-extension resource jar res mhtml mk cid mid urn tag mailto tel sms smsto " +
    "mms mmsto sip sips callto facetime facetime-audio facetime-group imessage xmpp irc ircs news nntp snews webcal geo maps ssh " +
    "telnet ldap ldaps smb nfs afp vnc rdp git svn dav davs shell search-ms intent market android-app content itms itms-apps " +
    "itms-appss itms-services itms-books prefs app-settings shortcuts applescript help x-man-page man magnet bitcoin gopher rtsp rtmp " +
    "wyciwyg chrome-search isolated-app feed pcast ipp ipps gemini opera brave firefox skype x-callback-url"
  ).split(" "),
);
const SYSTEM_SCHEME_PREFIX = /^(ms-|x-apple|microsoft-edge|web\+)/;
// An opaque host may hold brackets and other characters that would read as part of the consent label.
const APP_HOST = /^[a-z0-9._-]*(:\d+)?$/i;
const MAX_LOGINS_IN_PROGRESS = 5;
// One login cookie is about 0.6 KB, and up to 3 KB with the longest redirect URI and state; 8 KB is a common limit
// for all of a request's headers.
const MAX_LOGIN_COOKIE_BYTES = 6_000;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

const now = () => Math.floor(Date.now() / 1000);

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

// The purpose is signed with the payload, so a client id can never pass as a code or a login.
type Purpose = "client" | "login" | "code";

async function seal(secret: string, purpose: Purpose, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${purpose}.${body}`));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

async function unseal<T extends object>(secret: string, purpose: Purpose, value: string | null | undefined): Promise<T | undefined> {
  const parts = (value ?? "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(parts[1]), enc.encode(`${purpose}.${parts[0]}`));
    if (!ok) return undefined;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))) as T & { exp?: number };
    return payload.exp !== undefined && payload.exp < now() ? undefined : payload;
  } catch {
    return undefined;
  }
}

/** The PKCE verifier sent to the auth proxy for one login, derived so nothing has to be stored. */
async function loginVerifier(secret: string, loginState: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`pkce.${loginState}`));
  return b64url(new Uint8Array(sig));
}

interface Client {
  /** Random, so two registrations with the same metadata are still two clients. */
  id: string;
  redirect_uris: string[];
  client_name?: string;
}
interface Login {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  login_state: string;
  exp: number;
}
interface Code {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  login_state: string;
  login_code: string;
  exp: number;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extra },
  });
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version" };

const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

// Shown in the browser when the client itself cannot be trusted with a redirect.
function errorPage(message: string): Response {
  return new Response(`Plivo sign-in failed: ${message}\n`, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function redirectTo(target: string, params: Record<string, string | undefined>, cookies: string[] = []): Response {
  const url = new URL(target);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const headers = new Headers({ Location: url.toString(), "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

export function redirectUriError(uri: unknown): string | undefined {
  if (typeof uri !== "string" || uri.length > MAX_FIELD_CHARS) return "must be a string of at most 512 characters";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "is not a URL";
  }
  if (url.hash) return "must not have a fragment";
  if (url.protocol === "http:") {
    if (!LOOPBACK.has(url.hostname)) return "may use http only for a loopback address";
  } else if (url.protocol !== "https:") {
    const scheme = url.protocol.slice(0, -1);
    if (SYSTEM_SCHEMES.has(scheme) || SYSTEM_SCHEME_PREFIX.test(scheme)) return `cannot use ${url.protocol}`;
    if (!APP_HOST.test(url.host)) return "has a host that is not a plain name";
  }
  if ([...shownHost(url)].length > MAX_SHOWN_HOST_CHARS) return `has a host longer than ${MAX_SHOWN_HOST_CHARS} characters`;
  return undefined;
}

/**
 * Where the token goes, as the consent screen shows it. An app scheme is always named, so `evil://claude.ai` cannot
 * read as the website. Never as `scheme://host`: the firewall before the auth proxy blocks URLs in a query value.
 */
function shownHost(url: URL): string {
  if (url.protocol === "https:" || url.protocol === "http:") return url.host;
  return `${url.protocol} app link${url.host ? ` to ${url.host}` : ""}`;
}

/** A name someone else chose, without the invisible characters that could pad it or reorder what is shown. */
export function cleanName(name: unknown): string {
  if (typeof name !== "string") return "";
  const clean = name.replace(/[\p{C}\p{Default_Ignorable_Code_Point}]/gu, "").replace(/\s+/gu, " ").trim();
  return [...clean].slice(0, MAX_NAME_CHARS).join("");
}

/**
 * The consent screen's name for the app. The client chooses its own name, so the host the token is sent to
 * comes first and is never shortened; only the name is cut to fit.
 */
export function consentLabel(clientName: string | undefined, redirectUri: string): string {
  const host = shownHost(new URL(redirectUri));
  // Without brackets of its own, the name cannot close the pair it is shown in and pass as the text after it.
  const name = [...cleanName(clientName?.replace(/[\p{Ps}\p{Pe}]/gu, ""))];
  if (name.length === 0) return host;
  const room = MAX_LABEL_CHARS - [...host].length - 3;
  return `${host} (${name.length <= room ? name.join("") : `${name.slice(0, room - 1).join("")}…`})`;
}

// One cookie per login, so a second sign-in in the same browser does not replace the first.
function loginCookieName(origin: URL, loginState: string) {
  return `${origin.protocol === "https:" ? "__Host-" : ""}plivo_mcp_login_${loginState.slice(0, 16)}`;
}

function cookies(request: Request): [string, string][] {
  return (request.headers.get("Cookie") ?? "").split(";").map((part) => {
    const [k, ...v] = part.trim().split("=");
    return [k, v.join("=")];
  });
}

// Lax, so the cookie still arrives when the Console redirects the browser back here.
function loginCookie(origin: URL, name: string, value: string, maxAge: number): string {
  const secure = origin.protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/**
 * The challenge for a token minted before the module a tool needs existed: MCP clients sign in again and retry the
 * call. No scope is named, because a sign-in grants every module the MCP has, whatever is asked for.
 */
export function insufficientScopeChallenge(origin: string): string {
  return `Bearer error="insufficient_scope", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`;
}

/** The WWW-Authenticate value that tells an MCP client where to start OAuth; error="invalid_token" for a token that stopped working. */
export function resourceMetadataChallenge(origin: string, invalidToken = false): string {
  return `Bearer ${invalidToken ? 'error="invalid_token", ' : ""}resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`;
}

async function readBody(request: Request): Promise<string | undefined> {
  const text = await request.text();
  return text.length > MAX_BODY_CHARS ? undefined : text;
}

// The limiter's period in wrangler.jsonc.
const REGISTER_RETRY_SECONDS = 60;

/** An address as a limiter key: IPv4 whole, IPv6 by its /64, since one caller usually holds all of a /64. */
function addressKey(raw: string): string | undefined {
  const ip = raw.trim().toLowerCase();
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return v4.slice(1).every((n) => Number(n) <= 255) ? v4.slice(1).map(Number).join(".") : undefined;
  const halves = ip.split("::");
  if (halves.length > 2 || !/^[0-9a-f:]+$/.test(ip)) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return `${groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/**
 * Who is registering, as CloudFront saw them. CF-Connecting-IP is never the answer: behind CloudFront it is
 * CloudFront's own address, and a key shared by every user would lock them all out together.
 */
function callerKey(request: Request): string | undefined {
  // "ip:port"; an IPv6 address comes with or without brackets, and its last group is then the port.
  const viewer = request.headers.get("CloudFront-Viewer-Address")?.trim();
  const reported = viewer && addressKey(/^\[(.*)\](:\d+)?$/.exec(viewer)?.[1] ?? viewer.replace(/:[^:]*$/, ""));
  if (reported) return reported;
  // CloudFront appends the viewer's address; Cloudflare may then append CloudFront's, which is not the caller.
  const forwarded = (request.headers.get("X-Forwarded-For") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  if (forwarded.at(-1) === request.headers.get("CF-Connecting-IP")?.trim()) forwarded.pop();
  return addressKey(forwarded.at(-1) ?? "");
}

async function overRegisterLimit(request: Request, limiter: RateLimit | undefined): Promise<boolean> {
  const key = limiter && callerKey(request);
  if (!limiter || !key) return false;
  try {
    return !(await limiter.limit({ key })).success;
  } catch (e) {
    // Sign-in for everyone must not depend on the limiter.
    console.error(`plivo-mcp: the registration rate limiter failed, so this registration was not counted: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function register(request: Request, cfg: OAuthConfig): Promise<Response> {
  if (await overRegisterLimit(request, cfg.registerLimiter)) {
    const res = oauthError("too_many_requests", "too many client registrations from this network address; try again in a minute", 429);
    res.headers.set("Retry-After", String(REGISTER_RETRY_SECONDS));
    return res;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readBody(request)) ?? "") as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "body must be JSON of at most 16 KB");
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return oauthError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`);
  }
  for (const u of uris) {
    const why = redirectUriError(u);
    if (why) return oauthError("invalid_redirect_uri", `${String(u).slice(0, 100)} ${why}`);
  }
  const name = cleanName(body.client_name) || undefined;
  const client: Client = { id: b64url(crypto.getRandomValues(new Uint8Array(16))), redirect_uris: uris as string[], ...(name ? { client_name: name } : {}) };
  return json(
    {
      client_id: await seal(cfg.secret, "client", client),
      client_id_issued_at: now(),
      redirect_uris: client.redirect_uris,
      ...(name ? { client_name: name } : {}),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    201,
  );
}

async function authorize(request: Request, origin: URL, cfg: OAuthConfig): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const client = await unseal<Client>(cfg.secret, "client", clientId);
  if (!client) return errorPage("unknown client_id. Remove this server from your MCP client and add it again.");
  if (!client.redirect_uris.includes(redirectUri)) return errorPage("redirect_uri is not registered for this client.");
  // A client id never expires, so one sealed under older rules is held to today's.
  if (redirectUriError(redirectUri)) {
    return errorPage("this app registered a redirect address that is no longer accepted. Remove this server from your MCP client and add it again.");
  }

  const state = q.get("state") ?? undefined;
  const fail = (error: string, description: string) => redirectTo(redirectUri, { error, error_description: description, state });
  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  if (state !== undefined && state.length > MAX_FIELD_CHARS) return fail("invalid_request", "state is too long");
  const resource = q.get("resource");
  if (resource !== null && resource !== `${origin.origin}/mcp` && resource !== origin.origin) {
    return fail("invalid_target", `resource must be ${origin.origin}/mcp`);
  }

  const loginState = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const login: Login = { client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, login_state: loginState, exp: now() + LOGIN_TTL_SECONDS };
  const device = consentLabel(client.client_name, redirectUri);
  const cookieName = loginCookieName(origin, loginState);
  const sealed = await seal(cfg.secret, "login", login);
  return redirectTo(
    `${cfg.loginBase}/v1/accounts/cli/authorize`,
    {
      client: "mcp",
      state: loginState,
      code_challenge: await sha256(await loginVerifier(cfg.secret, loginState)),
      code_challenge_method: "S256",
      device,
    },
    [loginCookie(origin, cookieName, sealed, LOGIN_TTL_SECONDS), ...staleLogins(request, origin, cookieName.length + sealed.length + 1)],
  );
}

/**
 * Expires the logins in progress that would take the browser past 5 cookies or past the byte limit with the new one,
 * oldest first (a browser sends its oldest cookies first), and the cookie of the earlier single-login scheme.
 */
function staleLogins(request: Request, origin: URL, newBytes: number): string[] {
  const prefix = loginCookieName(origin, "");
  const sent = cookies(request).filter(([k]) => /^[\w-]+$/.test(k));
  const stale = sent.filter(([k]) => k === prefix.slice(0, -1)).map(([k]) => k);
  let room = MAX_LOGIN_COOKIE_BYTES - newBytes;
  let kept = 1;
  for (const [k, v] of sent.filter(([k]) => k.startsWith(prefix)).reverse()) {
    room -= k.length + v.length + 3;
    if (room < 0 || ++kept > MAX_LOGINS_IN_PROGRESS) stale.push(k);
  }
  return stale.map((k) => loginCookie(origin, k, "", 0));
}

async function callback(request: Request, origin: URL, cfg: OAuthConfig): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const state = q.get("state") ?? "";
  const login = await unseal<Login>(cfg.secret, "login", cookies(request).find(([k]) => k === loginCookieName(origin, state))?.[1]);
  // The cookie ties the callback to the browser that started the login.
  if (!login || login.login_state !== state) {
    return errorPage("this sign-in link has expired or was opened in another browser. Start again from your MCP client.");
  }
  const clear = [loginCookie(origin, loginCookieName(origin, state), "", 0)];
  const loginCode = q.get("code");
  if (!loginCode) {
    const error = q.get("error") === "access_denied" ? "access_denied" : "server_error";
    return redirectTo(login.redirect_uri, { error, state: login.state }, clear);
  }
  const code: Code = {
    client_id: login.client_id,
    redirect_uri: login.redirect_uri,
    code_challenge: login.code_challenge,
    login_state: login.login_state,
    login_code: loginCode,
    exp: now() + CODE_TTL_SECONDS,
  };
  return redirectTo(login.redirect_uri, { code: await seal(cfg.secret, "code", code), state: login.state, iss: origin.origin }, clear);
}

async function token(request: Request, cfg: OAuthConfig): Promise<Response> {
  const raw = await readBody(request);
  if (raw === undefined) return oauthError("invalid_request", "body is too large");
  const form = new URLSearchParams(raw);
  if (form.get("grant_type") !== "authorization_code") return oauthError("unsupported_grant_type", "only authorization_code is supported");
  const code = await unseal<Code>(cfg.secret, "code", form.get("code"));
  if (!code) return oauthError("invalid_grant", "code is invalid or expired");
  if (form.get("client_id") !== code.client_id) return oauthError("invalid_grant", "code was issued to another client");
  const redirectUri = form.get("redirect_uri");
  if (redirectUri !== null && redirectUri !== code.redirect_uri) return oauthError("invalid_grant", "redirect_uri does not match");
  if ((await sha256(form.get("code_verifier") ?? "")) !== code.code_challenge) return oauthError("invalid_grant", "code_verifier does not match");

  let res: Response;
  try {
    // The auth proxy deletes its code on first use, which makes this code single-use as well.
    res = await (cfg.fetchImpl ?? fetch)(`${cfg.loginBase}/v1/accounts/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: code.login_state,
        code: code.login_code,
        code_verifier: await loginVerifier(cfg.secret, code.login_state),
        client_secret: cfg.clientSecret,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return oauthError("temporarily_unavailable", "Plivo sign-in is unreachable; try again", 503);
  }
  const body = (await res.json().catch(() => undefined)) as { data?: { access_token?: string; expires_at?: string } } | undefined;
  const accessToken = body?.data?.access_token;
  if (!res.ok || !accessToken) {
    return res.status >= 500 ? oauthError("temporarily_unavailable", "Plivo sign-in failed; try again", 503) : oauthError("invalid_grant", "code was already used or has expired");
  }
  const expiresAt = Date.parse(body?.data?.expires_at ?? "");
  return json({
    access_token: accessToken,
    token_type: "Bearer",
    ...(Number.isFinite(expiresAt) ? { expires_in: Math.max(0, Math.floor(expiresAt / 1000) - now()) } : {}),
  });
}

/**
 * RFC 7009: ends the token an app is disconnecting. A token that cannot be one of ours answers 200, as the RFC
 * asks; one that could be answers 200 only once the auth proxy has dealt with it, so a client is never told a
 * live token is gone.
 */
async function revoke(request: Request, cfg: OAuthConfig): Promise<Response> {
  const raw = await readBody(request);
  if (raw === undefined) return oauthError("invalid_request", "body is too large");
  const tokenValue = new URLSearchParams(raw).get("token");
  if (!tokenValue) return oauthError("invalid_request", "token is required");
  const authorization = `Bearer ${tokenValue}`;
  if (STK_RE.test(authorization)) {
    let status: number;
    try {
      const res = await (cfg.fetchImpl ?? fetch)(`${cfg.loginBase}/v1/accounts/cli/revoke`, {
        method: "POST",
        headers: { Authorization: authorization },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel();
      status = res.status;
    } catch {
      return oauthError("temporarily_unavailable", "Plivo sign-in is unreachable; try again", 503);
    }
    // The proxy answers 200 for a live, expired or unknown token alike, and 401 for one it does not take as a token.
    if (status !== 200 && status !== 401) {
      console.error(`plivo-mcp: the auth proxy answered ${status} to a token revocation`);
      return oauthError("temporarily_unavailable", "Plivo could not revoke the token; try again", 503);
    }
  }
  return new Response(null, { status: 200, headers: CORS });
}

export async function handleOAuth(request: Request, cfg: OAuthConfig): Promise<Response> {
  const origin = new URL(cfg.publicOrigin);
  const path = new URL(request.url).pathname;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET, POST" } });

  if (request.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
    return json({ resource: `${origin.origin}/mcp`, authorization_servers: [origin.origin], bearer_methods_supported: ["header"] });
  }
  if (request.method === "GET" && path === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: origin.origin,
      authorization_endpoint: `${origin.origin}/authorize`,
      token_endpoint: `${origin.origin}/token`,
      registration_endpoint: `${origin.origin}/register`,
      revocation_endpoint: `${origin.origin}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ["none"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  }
  if (request.method === "POST" && path === "/register") return register(request, cfg);
  if (request.method === "GET" && path === "/authorize") return authorize(request, origin, cfg);
  if (request.method === "GET" && path === "/oauth/callback") return callback(request, origin, cfg);
  if (request.method === "POST" && path === "/token") return token(request, cfg);
  if (request.method === "POST" && path === "/oauth/revoke") return revoke(request, cfg);
  return new Response("Method not allowed\n", { status: 405 });
}
