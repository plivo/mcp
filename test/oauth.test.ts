import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorker, type Env } from "../src/index";
import { consentLabel, redirectUriError } from "../src/oauth";

const ORIGIN = "http://localhost";
const LOGIN = "http://127.0.0.1:8798";
const CLIENT_CB = "http://127.0.0.1:9999/cb";
const STK = "stk_" + "B".repeat(32);
const ENV: Env = {
  PLIVO_API_BASE: "http://127.0.0.1:8799/v1/proxy",
  CONFIRM_SECRET: "test-confirm-secret-".padEnd(48, "x"),
  PLIVO_LOGIN_BASE: LOGIN,
  OAUTH_SECRET: "test-oauth-secret-".padEnd(48, "y"),
  MCP_CLIENT_SECRET: "test-mcp-client-secret-".padEnd(48, "z"),
};

async function s256(v: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The auth proxy's side of `plivo login`: a code is deleted on first use and needs the PKCE verifier.
function fakeLogin() {
  const codes = new Map<string, { state: string; challenge: string }>();
  const redeemed: unknown[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== `${LOGIN}/v1/accounts/cli/token`) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init?.body)) as { state: string; code: string; code_verifier: string; client_secret?: string };
    redeemed.push(body);
    if (body.client_secret !== ENV.MCP_CLIENT_SECRET) {
      return new Response(JSON.stringify({ errors: { global_error: "client authentication failed" } }), { status: 401 });
    }
    const entry = codes.get(body.code);
    codes.delete(body.code);
    if (!entry || entry.state !== body.state || (await s256(body.code_verifier)) !== entry.challenge) {
      return new Response(JSON.stringify({ errors: { global_error: "code not found or expired" } }), { status: 400 });
    }
    return Response.json({ data: { access_token: STK, expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString() } });
  });
  return { codes, redeemed, fetchImpl };
}

function setup(env: Partial<Env> = {}) {
  const login = fakeLogin();
  const worker = createWorker(login.fetchImpl as typeof fetch);
  const send = (path: string, init?: RequestInit) => {
    const req = new Request(`${ORIGIN}${path}`, init);
    const headers = new Headers(req.headers);
    headers.set("Host", "localhost");
    return worker.fetch(new Request(req, { headers, redirect: "manual" }), { ...ENV, ...env });
  };
  return { ...login, send };
}

const location = (res: Response) => new URL(res.headers.get("Location") ?? "");
const cookieOf = (res: Response) => (res.headers.get("Set-Cookie") ?? "").split(";")[0];

async function registerClient(send: ReturnType<typeof setup>["send"]) {
  const res = await send("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLIENT_CB], client_name: "Test Client" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Runs /authorize, the Console's Allow and /oauth/callback; returns what the MCP client receives. */
async function signIn(t: ReturnType<typeof setup>, verifier = "v".repeat(43)) {
  const clientId = await registerClient(t.send);
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: CLIENT_CB, state: "client-state",
    code_challenge: await s256(verifier), code_challenge_method: "S256", resource: `${ORIGIN}/mcp`,
  });
  const auth = await t.send(`/authorize?${q}`);
  expect(auth.status).toBe(302);
  const toLogin = location(auth);
  const loginState = toLogin.searchParams.get("state")!;
  t.codes.set("login-code-1", { state: loginState, challenge: toLogin.searchParams.get("code_challenge")! });
  const back = await t.send(`/oauth/callback?state=${loginState}&code=login-code-1`, { headers: { Cookie: cookieOf(auth) } });
  return { clientId, verifier, toLogin, auth, back, code: location(back).searchParams.get("code")! };
}

function tokenRequest(t: ReturnType<typeof setup>, fields: Record<string, string>) {
  return t.send("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", redirect_uri: CLIENT_CB, ...fields }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("token revocation", () => {
  const revoke = (upstream: (url: string, init?: RequestInit) => Response | Promise<Response>, body: Record<string, string>) => {
    const calls: { url: string; auth: string | null; redirect?: string; timed: boolean }[] = [];
    const worker = createWorker((async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization"), redirect: init?.redirect, timed: init?.signal instanceof AbortSignal });
      return upstream(String(url), init);
    }) as typeof fetch);
    const req = new Request(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Host: "localhost" },
      body: new URLSearchParams(body),
    });
    return worker.fetch(req, ENV).then((res) => ({ res, calls }));
  };

  it("advertises the endpoint", async () => {
    const as = (await (await setup().send("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ revocation_endpoint: `${ORIGIN}/oauth/revoke`, revocation_endpoint_auth_methods_supported: ["none"] });
  });

  it("asks the auth proxy to delete the token, as its bearer", async () => {
    const { res, calls } = await revoke(() => Response.json({ message: "Token revoked" }), { token: STK, token_type_hint: "access_token" });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: `${LOGIN}/v1/accounts/cli/revoke`, auth: `Bearer ${STK}`, redirect: "manual", timed: true }]);
  });

  it.each<[string, Record<string, string>, number, number]>([
    ["answers 200 when the proxy does not take it as a token", { token: STK }, 401, 200],
    ["answers 200 for something that is not our token, without calling the proxy", { token: "not-ours" }, 200, 200],
    ["answers 200 for a token no header can carry, without calling the proxy", { token: "stk_\u4e2d" }, 200, 200],
    ["answers 200 for a token longer than ours, without calling the proxy", { token: `${STK}x` }, 200, 200],
    ["says try again when the proxy has no revoke route yet", { token: STK }, 404, 503],
    ["says try again when the proxy redirects", { token: STK }, 302, 503],
    ["says try again when the proxy fails", { token: STK }, 503, 503],
    ["refuses a request without a token", {}, 200, 400],
    ["refuses a body over the size limit", { token: "x".repeat(20_000) }, 200, 400],
  ])("%s", async (_, body, upstreamStatus, want) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { res, calls } = await revoke(() => new Response("{}", { status: upstreamStatus }), body);
    expect(res.status).toBe(want);
    expect(calls).toHaveLength(body.token === STK ? 1 : 0);
  });

  it("says try again when the proxy is unreachable", async () => {
    const { res } = await revoke(() => Promise.reject(new Error("down")), { token: STK });
    expect(res.status).toBe(503);
  });
});

describe("OAuth sign-in", () => {
  it("points a client without a token at the sign-in metadata", async () => {
    const { send } = setup();
    const res = await send("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const prm = (await (await send("/.well-known/oauth-protected-resource/mcp")).json()) as { authorization_servers: string[] };
    const as = (await (await send("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(prm.authorization_servers).toEqual([ORIGIN]);
    expect(as).toMatchObject({ issuer: ORIGIN, token_endpoint: `${ORIGIN}/token`, code_challenge_methods_supported: ["S256"] });
  });

  it("signs in through Plivo's login and hands the client an stk_ token that works on /mcp", async () => {
    const t = setup();
    const { clientId, verifier, toLogin, back, code } = await signIn(t);

    expect(`${toLogin.origin}${toLogin.pathname}`).toBe(`${LOGIN}/v1/accounts/cli/authorize`);
    expect(Object.fromEntries(toLogin.searchParams)).toMatchObject({ client: "mcp", code_challenge_method: "S256", device: "127.0.0.1:9999 (Test Client)" });
    expect(`${location(back).origin}${location(back).pathname}`).toBe(CLIENT_CB);
    expect(location(back).searchParams.get("state")).toBe("client-state");

    const res = await tokenRequest(t, { code, client_id: clientId, code_verifier: verifier });
    expect(res.status).toBe(200);
    const tok = (await res.json()) as { access_token: string; token_type: string; expires_in: number };
    expect(tok).toMatchObject({ access_token: STK, token_type: "Bearer" });
    expect(tok.expires_in).toBeGreaterThan(89 * 86_400);

    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (input, init) => t.send(new URL(String(input)).pathname, init),
      requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("passes a declined consent back to the client", async () => {
    const t = setup();
    const clientId = await registerClient(t.send);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLIENT_CB, state: "s1", code_challenge: await s256("v".repeat(43)), code_challenge_method: "S256" });
    const auth = await t.send(`/authorize?${q}`);
    const back = await t.send(`/oauth/callback?state=${location(auth).searchParams.get("state")}&error=access_denied`, { headers: { Cookie: cookieOf(auth) } });
    expect(Object.fromEntries(location(back).searchParams)).toEqual({ error: "access_denied", state: "s1" });
  });

  it.each([
    ["the wrong code_verifier", async (_t: ReturnType<typeof setup>, s: Awaited<ReturnType<typeof signIn>>) => ({ code: s.code, client_id: s.clientId, code_verifier: "w".repeat(43) })],
    ["another client's id", async (t: ReturnType<typeof setup>, s: Awaited<ReturnType<typeof signIn>>) => ({ code: s.code, client_id: await registerClient(t.send), code_verifier: s.verifier })],
    ["a forged code", async (_t: ReturnType<typeof setup>, s: Awaited<ReturnType<typeof signIn>>) => ({ code: s.code.replace(/^e/, "f"), client_id: s.clientId, code_verifier: s.verifier })],
  ])("refuses a token request with %s, without asking Plivo", async (_name, fields) => {
    const t = setup();
    const s = await signIn(t);
    const res = await tokenRequest(t, await fields(t, s));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(t.redeemed).toHaveLength(0);
  });

  it("makes a code single-use and expires it after 60 seconds", async () => {
    const t = setup();
    const s = await signIn(t);
    const fields = { code: s.code, client_id: s.clientId, code_verifier: s.verifier };
    expect((await tokenRequest(t, fields)).status).toBe(200);
    expect(await (await tokenRequest(t, fields)).json()).toMatchObject({ error: "invalid_grant" });

    const t2 = setup();
    const late = await signIn(t2);
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    expect(await (await tokenRequest(t2, { code: late.code, client_id: late.clientId, code_verifier: late.verifier })).json()).toMatchObject({ error: "invalid_grant" });
    expect(t2.redeemed).toHaveLength(0);
  });

  it("will not finish a sign-in in a browser that did not start it", async () => {
    const t = setup();
    const s = await signIn(t);
    const state = s.toLogin.searchParams.get("state")!;
    const tries: [string, string][] = [
      ["", state],
      [cookieOf(s.auth).replace("=e", "=f"), state],
      // Someone else's login pushed into this browser.
      [cookieOf(s.auth), "another-login-state-".padEnd(43, "z")],
    ];
    for (const [cookie, st] of tries) {
      const res = await t.send(`/oauth/callback?state=${st}&code=login-code-1`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
    }
  });

  it("does not redirect to a URI the client never registered", async () => {
    const t = setup();
    const clientId = await registerClient(t.send);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb", code_challenge: await s256("v".repeat(43)), code_challenge_method: "S256" });
    const res = await t.send(`/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it.each([
    ["javascript:alert(1)", "cannot use javascript:"],
    ["http://evil.example/cb", "may use http only for a loopback address"],
    ["https://claude.ai/cb#x", "must not have a fragment"],
  ])("refuses to register %s", (uri, why) => {
    expect(redirectUriError(uri)).toBe(why);
  });

  it("accepts https, loopback and app redirect URIs", () => {
    for (const uri of ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:33418/", "cursor://anysphere.cursor-retrieval/oauth/callback"]) {
      expect(redirectUriError(uri), uri).toBeUndefined();
    }
  });

  it("refuses a redirect host too long to show in full on the consent screen", () => {
    const host = `${"a".repeat(60)}.${"b".repeat(27)}.example.com`;
    expect(redirectUriError(`https://${host}/cb`)).toBeUndefined();
    expect(redirectUriError(`https://x${host}/cb`)).toBe("has a host longer than 100 characters");
  });

  it("is off without PLIVO_LOGIN_BASE, and refuses to run with a short secret", async () => {
    expect((await setup({ PLIVO_LOGIN_BASE: undefined }).send("/.well-known/oauth-authorization-server")).status).toBe(404);
    expect((await setup({ OAUTH_SECRET: "short" }).send("/.well-known/oauth-authorization-server")).status).toBe(500);
    expect((await setup({ MCP_CLIENT_SECRET: undefined }).send("/.well-known/oauth-authorization-server")).status).toBe(500);
  });
});

describe("consent screen label", () => {
  it("shows the full redirect host first, however the client pads its name", async () => {
    const t = setup();
    const evilCb = "https://claude.ai.connect-callback.evil-example.com/cb";
    const reg = await t.send("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [evilCb], client_name: "Claude" + "\u200B".repeat(94) }),
    });
    const { client_id, client_name } = (await reg.json()) as { client_id: string; client_name: string };
    expect(client_name).toBe("Claude");
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: evilCb, code_challenge: await s256("v".repeat(43)), code_challenge_method: "S256" });
    expect(location(await t.send(`/authorize?${q}`)).searchParams.get("device")).toBe("claude.ai.connect-callback.evil-example.com (Claude)");
  });

  it.each([
    ["drops controls, bidi overrides and zero-width fillers", "Cl\u202Eau\u0007de\u3164 \u200D App", "https://claude.ai/cb", "claude.ai (Claude App)"],
    ["uses the host alone when no name is left", "\u200B\u200C\u2060", "http://127.0.0.1:33418/", "127.0.0.1:33418"],
    ["names an app redirect by its scheme first", "Cursor", "cursor://anysphere.cursor-retrieval/oauth/callback", "cursor: app link to anysphere.cursor-retrieval (Cursor)"],
    ["never shows an app redirect as the website it names", "Claude", "evil://claude.ai/cb", "evil: app link to claude.ai (Claude)"],
    ["names an app redirect without a host by its scheme", "App", "com.example.app:/oauth2redirect", "com.example.app: app link (App)"],
    ["keeps the name inside its brackets", "Claude) is asking. Ignore (the rest\uFF09", "https://evil-example.com/cb", "evil-example.com (Claude is asking. Ignore the rest)"],
  ])("%s", (_, name, uri, label) => {
    expect(consentLabel(name, uri)).toBe(label);
  });

  it("shortens only the name to fit the auth proxy's 128-character limit", () => {
    const host = `${"a".repeat(60)}.${"b".repeat(27)}.example.com`;
    const label = consentLabel("N".repeat(100), `https://${host}/cb`);
    expect([...label]).toHaveLength(128);
    expect(label.startsWith(`${host} (N`)).toBe(true);
    expect(label.endsWith("N…)")).toBe(true);
  });
});

describe("behind a proxy that forwards the Worker's own host", () => {
  const PUBLIC = "https://mcp.example.com";

  it("names itself by PUBLIC_ORIGIN everywhere a client looks", async () => {
    const t = setup({ PUBLIC_ORIGIN: PUBLIC });
    const unauth = await t.send("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(unauth.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
    expect(await (await t.send("/.well-known/oauth-protected-resource/mcp")).json()).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC] });
    expect(await (await t.send("/.well-known/oauth-authorization-server")).json()).toMatchObject({
      issuer: PUBLIC,
      authorization_endpoint: `${PUBLIC}/authorize`,
      token_endpoint: `${PUBLIC}/token`,
      registration_endpoint: `${PUBLIC}/register`,
    });

    const clientId = await registerClient(t.send);
    const challenge = await s256("v".repeat(43));
    const authorize = (resource: string) =>
      t.send(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLIENT_CB, state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource })}`);
    expect(location(await authorize(`${ORIGIN}/mcp`)).searchParams.get("error")).toBe("invalid_target");
    const auth = await authorize(`${PUBLIC}/mcp`);
    expect(`${location(auth).origin}${location(auth).pathname}`).toBe(`${LOGIN}/v1/accounts/cli/authorize`);
    expect(auth.headers.get("Set-Cookie")).toMatch(/^__Host-plivo_mcp_login_[\w-]{16}=[^;]+; .*; Secure$/);

    const loginState = location(auth).searchParams.get("state")!;
    t.codes.set("login-code-1", { state: loginState, challenge: location(auth).searchParams.get("code_challenge")! });
    const back = await t.send(`/oauth/callback?state=${loginState}&code=login-code-1`, { headers: { Cookie: cookieOf(auth) } });
    expect(location(back).searchParams.get("iss")).toBe(PUBLIC);
  });

  it.each(["https://mcp.example.com/mcp", "http://mcp.example.com", "not a url"])("refuses to run with PUBLIC_ORIGIN %s", async (value) => {
    expect((await setup({ PUBLIC_ORIGIN: value }).send("/.well-known/oauth-authorization-server")).status).toBe(500);
    expect((await setup({ PUBLIC_ORIGIN: value }).send("/mcp", { method: "POST", body: "{}" })).status).toBe(500);
  });
});

describe("redirect URI schemes", () => {
  it.each([
    "ftp://claude.ai/cb",
    "tel:+14155550100",
    "mailto:someone@example.com",
    "ms-msdt:/id",
    "MS-Settings://x",
    "chrome-extension://abcdefghijklmnop/cb",
    "file:///etc/hosts",
    "wss://claude.ai/cb",
    "intent://scan/#Intent;scheme=zxing;end",
  ])("refuses to register %s, which a browser or the system handles itself", (uri) => {
    expect(redirectUriError(uri)).toMatch(/^(cannot use [a-z-]+:|must not have a fragment)$/);
  });

  it.each(["vscode://vscode.github-authentication/did-authenticate", "vscode-insiders://oauth/callback", "com.example.app:/oauth2redirect", "https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost:33418/callback"])(
    "still registers %s",
    (uri) => {
      expect(redirectUriError(uri)).toBeUndefined();
    },
  );

  it("refuses an app redirect whose host could pass as part of the label", () => {
    expect(redirectUriError("evil://claude.ai(Claude)/cb")).toBe("has a host that is not a plain name");
  });

  it("stops a client registered earlier with a scheme that is no longer accepted, on a page and not by redirect", async () => {
    const t = setup();
    const uri = "ftp://claude.ai/cb";
    const sign = async (body: string) => {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ENV.OAUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`client.${body}`))).toString("base64url");
    };
    const body = Buffer.from(JSON.stringify({ id: "old", redirect_uris: [uri, CLIENT_CB] })).toString("base64url");
    const client_id = `${body}.${await sign(body)}`;
    const authorize = async (redirect_uri: string) =>
      t.send(`/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri, code_challenge: await s256("v".repeat(43)), code_challenge_method: "S256" })}`);
    const refused = await authorize(uri);
    expect(refused.status).toBe(400);
    expect(refused.headers.get("Location")).toBeNull();
    expect(await refused.text()).toContain("no longer accepted");
    expect((await authorize(CLIENT_CB)).status).toBe(302);
  });
});

describe("several sign-ins in one browser", () => {
  const start = async (t: ReturnType<typeof setup>, clientId: string, jar: string[]) => {
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLIENT_CB, state: "s", code_challenge: await s256("v".repeat(43)), code_challenge_method: "S256" });
    const auth = await t.send(`/authorize?${q}`, { headers: { Cookie: jar.join("; ") } });
    for (const c of auth.headers.getSetCookie()) {
      const pair = c.split(";")[0];
      const at = jar.findIndex((j) => j.startsWith(`${pair.split("=")[0]}=`));
      if (at >= 0) jar.splice(at, 1);
      if (!c.includes("Max-Age=0")) jar.push(pair);
    }
    return location(auth).searchParams.get("state")!;
  };
  const finish = (t: ReturnType<typeof setup>, state: string, jar: string[]) => t.send(`/oauth/callback?state=${state}&code=c1`, { headers: { Cookie: jar.join("; ") } });

  it("finishes each one, and clears only that one's cookie", async () => {
    const t = setup();
    const jar: string[] = [];
    const clientId = await registerClient(t.send);
    const first = await start(t, clientId, jar);
    const second = await start(t, clientId, jar);
    expect(jar).toHaveLength(2);

    const back = await finish(t, first, jar);
    expect(location(back).searchParams.get("code")).toBeTruthy();
    expect(back.headers.getSetCookie()).toEqual([expect.stringMatching(new RegExp(`^plivo_mcp_login_${first.slice(0, 16)}=; .*Max-Age=0`))]);
    expect(location(await finish(t, second, jar)).searchParams.get("code")).toBeTruthy();
  });

  it("will not finish a login with another login's cookie under its name", async () => {
    const t = setup();
    const jar: string[] = [];
    const clientId = await registerClient(t.send);
    const first = await start(t, clientId, jar);
    const second = await start(t, clientId, jar);
    const swapped = `plivo_mcp_login_${second.slice(0, 16)}=${jar[0].split("=").slice(1).join("=")}`;
    const res = await finish(t, second, [swapped]);
    expect(first).not.toBe(second);
    expect(res.status).toBe(400);
  });

  it("keeps at most 5 logins in progress, dropping the oldest, so the Cookie header stays small", async () => {
    const t = setup();
    const jar: string[] = [];
    const clientId = await registerClient(t.send);
    const states: string[] = [];
    for (let i = 0; i < 7; i++) states.push(await start(t, clientId, jar));
    expect(jar).toHaveLength(5);
    expect(jar.join("; ").length).toBeLessThan(8_000);
    expect((await finish(t, states[0], jar)).status).toBe(400);
    expect((await finish(t, states[6], jar)).status).toBe(302);
  });
});
