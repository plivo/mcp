import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createWorker, type Env } from "../src/index";
import { buildShortcuts, SHORTCUT_DEFS } from "../src/shortcuts";
import { getOperation } from "../src/catalog";
import { CODE_TTL_SECONDS, describeAction } from "../src/confirm";
import { buildRequest } from "../src/upstream";
import catalogData from "../catalog/catalog.json";
import { docsSources } from "../src/docs";
import proxyRoutes from "../catalog/proxy-routes.json";

const STK = "Bearer stk_" + "a".repeat(32);
const API = "http://127.0.0.1:8799/v1/proxy";
const TEST_SECRET = "test-confirm-secret-".padEnd(48, "x");
const SIP_PASSWORD = "x".repeat(10);

interface Sent {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function setup(envOverrides: Partial<Env> = {}, reply = { status: 200, body: { api_id: "x", ok: true } as unknown }) {
  const sent: Sent[] = [];
  const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(url), method: init?.method ?? "GET", auth: headers.get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  });
  const worker = createWorker(upstream as typeof fetch);
  const env: Env = { PLIVO_API_BASE: API, CONFIRM_SECRET: TEST_SECRET, ...envOverrides };
  const toWorker = (input: string | URL | Request, init?: RequestInit) => worker.fetch(withHost(new Request(input, init)), env);
  return { worker, env, sent, toWorker };
}

// Workers always see the client's Host header; a Request built in Node has none.
function withHost(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.set("Host", new URL(req.url).host);
  return new Request(req, { headers });
}

async function connect(toWorker: typeof fetch, auth = STK, mode?: { pin: "2026-07-28" }) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: toWorker,
    requestInit: { headers: { Authorization: auth } },
  });
  const client = new Client({ name: "test", version: "1.0.0" }, mode ? { versionNegotiation: { mode } } : undefined);
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const raw = res.content[0].text;
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // plain-text results (errors, "no matches")
  }
  return { isError: !!res.isError, raw, parsed };
}

describe("HTTP edge", () => {
  it("rejects a missing or Basic credential when Basic auth is off, and a foreign Host", async () => {
    const { worker, env } = setup();
    const mcp = (headers: Record<string, string>) =>
      worker.fetch(withHost(new Request("http://localhost/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" })), env);

    const missing = await mcp({});
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect((await mcp({ Authorization: "Basic " + btoa("MAXXXXXXXXXXXXXXXXXX:secret") })).status).toBe(401);

    const foreign = await worker.fetch(withHost(new Request("http://evil.test/mcp", { method: "POST", headers: { Authorization: STK }, body: "{}" })), env);
    expect(foreign.status).toBe(403);
  });

  it.each<[string, Partial<Env>]>([
    ["placeholder upstream", { PLIVO_API_BASE: "https://REPLACE-WITH-PROXY-HOST/v1/proxy" }],
    ["plain-http upstream", { PLIVO_API_BASE: "http://proxy.example/v1/proxy" }],
    ["upstream that is not a URL", { PLIVO_API_BASE: "not a url" }],
    ["confirmation without a secret", { CONFIRM_SECRET: undefined }],
    ["confirmation with a short secret", { CONFIRM_SECRET: "short" }],
    ["allow mode against a real upstream", { CONFIRMATION_MODE: "allow", PLIVO_API_BASE: "https://proxy.example/v1/proxy" }],
  ])(
    "refuses to serve with a %s",
    async (_, overrides) => {
      const { toWorker, sent } = setup(overrides);
      const res = await toWorker("http://localhost/mcp", { method: "POST", headers: { Authorization: STK, "Content-Type": "application/json" }, body: "{}" });
      expect(res.status).toBe(500);
      expect(sent).toHaveLength(0);
    },
  );
});

describe.each([
  ["2025 clients", undefined],
  ["2026-07-28 clients", { pin: "2026-07-28" as const }],
])("MCP tools for %s", (_, mode) => {
  it("lists the four universal tools, search_docs and the shortcuts", async () => {
    const { toWorker } = setup();
    const client = await connect(toWorker, STK, mode);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["plivo_api_details", "plivo_api_read", "plivo_api_search", "plivo_api_write", "search_docs", ...SHORTCUT_DEFS.map((d) => d.name)].sort(),
    );
  });

  it("reads through the proxy with the caller's stk_ token and {auth_id} left for the proxy", async () => {
    const { toWorker, sent } = setup();
    const client = await connect(toWorker, STK, mode);
    const res = await call(client, "plivo_api_read", { id: "GET /Message/{message_uuid}/", path_params: { message_uuid: "abc-123" } });
    expect(res.isError).toBe(false);
    expect(sent).toEqual([{ url: `${API}/v1/Account/me/Message/abc-123/`, method: "GET", auth: STK, body: undefined }]);
    expect(res.parsed).toMatchObject({ status: 200, response: { api_id: "x" } });
  });
});

describe("search and details", () => {
  it.each([
    ["send an sms", "POST /Message/"],
    ["list calls", "GET /Call/"],
    ["buy a phone number", "POST /PhoneNumber/{number}/"],
    ["hang up a call", "DELETE /Call/{call_uuid}/"],
  ])("%s → %s", async (query, id) => {
    const client = await connect(setup().toWorker);
    const res = await call(client, "plivo_api_search", { query, limit: 5 });
    expect((res.parsed as { id: string }[]).map((h) => h.id)).toContain(id);
  });

  it("describes params, spend and which tool to use", async () => {
    const client = await connect(setup().toWorker);
    const res = await call(client, "plivo_api_details", { id: "POST /Message/" });
    const d = res.parsed as { call_with: string; costs_money: boolean; params: { name: string; required?: boolean }[] };
    expect(d.call_with).toBe("plivo_api_write");
    expect(d.costs_money).toBe(true);
    expect(d.params.find((p) => p.name === "dst")?.required).toBe(true);
  });
});

describe("guardrails", () => {
  it("refuses path values that would reach another resource", async () => {
    const { toWorker, sent } = setup();
    const client = await connect(toWorker);
    for (const bad of ["../Call", "a/b", "%2e%2e", "x?y=1", ".."]) {
      const res = await call(client, "plivo_api_read", { id: "GET /Message/{message_uuid}/", path_params: { message_uuid: bad } });
      expect(res.isError, bad).toBe(true);
    }
    expect(sent).toHaveLength(0);
  });

  it("rejects null query values and treats prototype-named params as ordinary params", async () => {
    const { toWorker, sent } = setup();
    const client = await connect(toWorker);
    expect((await call(client, "plivo_api_read", { id: "GET /Call/", params: { limit: null } })).isError).toBe(true);
    const res = await call(client, "plivo_api_read", { id: "GET /Call/?status=live", params: { constructor: "x" } });
    expect(res.isError).toBe(false);
    expect(sent.map((s) => s.url)).toEqual([`${API}/v1/Account/me/Call/?status=live&constructor=x`]);
  });

  it("keeps reads and writes on their own tools", async () => {
    const { toWorker, sent } = setup();
    const client = await connect(toWorker);
    expect((await call(client, "plivo_api_read", { id: "POST /Application/", params: { app_name: "x" } })).isError).toBe(true);
    expect((await call(client, "plivo_api_write", { id: "GET /Call/" })).isError).toBe(true);
    expect((await call(client, "plivo_api_read", { id: "GET /Nope/" })).isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("refuses money-spending and destructive writes in block mode", async () => {
    const { toWorker, sent } = setup({ CONFIRMATION_MODE: "block" });
    const client = await connect(toWorker);
    const send = await call(client, "plivo_api_write", { id: "POST /Message/", params: { src: "+14155550100", dst: "+14155550101", text: "hi" } });
    expect(send.isError).toBe(true);
    expect(send.raw).toContain("costs money");
    expect((await call(client, "plivo_api_write", { id: "DELETE /Call/{call_uuid}/", path_params: { call_uuid: "c1" } })).isError).toBe(true);
    const trunk = await call(client, "plivo_api_write", { id: "POST /Zentrunk/IPAccessControlList/", params: { name: "x", ip_addresses: ["203.0.113.7"] } });
    expect(trunk.raw).toContain("keeps working after this app is disconnected");
    expect(sent).toHaveLength(0);
  });

  it("sends a write as a JSON body and reports undocumented params", async () => {
    const { toWorker, sent } = setup({ CONFIRMATION_MODE: "allow" });
    const client = await connect(toWorker);
    const res = await call(client, "plivo_api_write", { id: "POST /Message/", params: { src: "+14155550100", dst: "+14155550101", text: "hi", made_up: 1 } });
    expect(sent[0]).toMatchObject({ url: `${API}/v1/Account/me/Message/`, method: "POST", body: { src: "+14155550100", dst: "+14155550101", text: "hi", made_up: 1 } });
    expect((res.parsed as { warnings: string[] }).warnings[0]).toContain("made_up");
  });

  it("uses the Basic auth_id in the path when Basic auth is enabled for local development", async () => {
    const { toWorker, sent } = setup({ ALLOW_BASIC_AUTH: "true", PLIVO_API_BASE: "https://api.plivo.test" });
    const basic = "Basic " + btoa("MAXXXXXXXXXXXXXXXXXX:secret");
    const client = await connect(toWorker, basic);
    await call(client, "plivo_api_read", { id: "GET /Call/?status=live" });
    expect(sent[0]).toMatchObject({ url: "https://api.plivo.test/v1/Account/MAXXXXXXXXXXXXXXXXXX/Call/?status=live", auth: basic });
  });

  it.each<[string, { pin: "2026-07-28" } | undefined]>([
    ["2025 client", undefined],
    ["2026-07-28 client", { pin: "2026-07-28" }],
  ])("%s: a token Plivo refuses gets an HTTP 401 that starts sign-in again", async (_, mode) => {
    const oauth = { PLIVO_LOGIN_BASE: "http://127.0.0.1:8798", OAUTH_SECRET: "test-oauth-secret-".padEnd(48, "y") };
    const { toWorker } = setup(oauth, { status: 401, body: { error: { global_error: "Token is expired" } } });
    const replies: Response[] = [];
    const recording = async (input: string | URL | Request, init?: RequestInit) => {
      const res = await toWorker(input, init);
      replies.push(res.clone());
      return res;
    };
    const client = await connect(recording, STK, mode);
    await expect(client.callTool({ name: "plivo_api_read", arguments: { id: "GET /Call/" } })).rejects.toThrow();
    const last = replies.at(-1)!;
    expect(last.status).toBe(401);
    expect(last.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token", resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"');
    expect(await last.json()).toMatchObject({ error: "invalid_token" });
  });

  it("marks an upstream error status as a tool error", async () => {
    const { toWorker } = setup({}, { status: 404, body: { error: "not found" } });
    const client = await connect(toWorker);
    const res = await call(client, "plivo_api_read", { id: "GET /Call/{call_uuid}/", path_params: { call_uuid: "nope" } });
    expect(res.isError).toBe(true);
    expect(res.parsed).toMatchObject({ status: 404 });
  });
});

describe("shortcuts", () => {
  it.each([
    ["get_account", {}, `${API}/v1/Account/me/`],
    ["get_message", { message_uuid: "abc-123" }, `${API}/v1/Account/me/Message/abc-123/`],
    ["list_calls", { end_time__gt: "2026-11-01 00:00", limit: 5 }, `${API}/v1/Account/me/Call/?end_time__gt=2026-11-01+00%3A00&limit=5`],
  ])("%s reads through the proxy", async (name, args, url) => {
    const { toWorker, sent } = setup();
    const res = await call(await connect(toWorker), name, args);
    expect(res.isError).toBe(false);
    expect(res.parsed).not.toHaveProperty("warnings");
    expect(sent).toEqual([{ url, method: "GET", auth: STK, body: undefined }]);
  });

  it("says when Plivo's 7-day default window was used for calls", async () => {
    const client = await connect(setup().toWorker);
    const note = async (name: string, args: Record<string, unknown>) => ((await call(client, name, args)).parsed as { note?: string }).note;
    expect(await note("list_calls", { limit: 5 })).toMatch(/only the last 7 days/);
    expect(await note("plivo_api_read", { id: "GET /Call/", params: { limit: 5 } })).toMatch(/only the last 7 days/);
    expect(await note("list_calls", { end_time__gt: "2026-10-05 00:00" })).toBeUndefined();
    expect(await note("plivo_api_read", { id: "GET /Call/", params: { end_time__lte: "2026-10-20 00:00" } })).toBeUndefined();
  });

  it("asks before the paid and destructive ones", async () => {
    const { toWorker, sent } = setup();
    const client = await connect(toWorker);
    const tries: [string, Record<string, unknown>, string][] = [
      ["send_sms", { src: "+14155550100", dst: "+14155550101", text: "hi" }, "This costs money."],
      ["make_call", { from: "+14155550100", to: "+14155550101", answer_url: "https://example.com/a" }, "This costs money."],
      ["buy_number", { number: "14155550100" }, "This costs money."],
      ["hangup_call", { call_uuid: "c1" }, "This cannot be undone."],
    ];
    for (const [name, args, why] of tries) {
      const res = await call(client, name, args);
      expect(res.parsed, name).toMatchObject({ status: "confirmation_required", action: expect.stringContaining(why) });
    }
    expect(sent).toHaveLength(0);
  });

  it("sends only the given fields, with path params in the path", async () => {
    const { toWorker, sent } = setup({ CONFIRMATION_MODE: "allow" });
    const client = await connect(toWorker);
    await call(client, "send_sms", { src: "+14155550100", dst: "+14155550101", text: "hi" });
    await call(client, "buy_number", { number: "14155550100", app_id: "app-1" });
    expect(sent).toEqual([
      { url: `${API}/v1/Account/me/Message/`, method: "POST", auth: STK, body: { src: "+14155550100", dst: "+14155550101", text: "hi" } },
      { url: `${API}/v1/Account/me/PhoneNumber/14155550100/`, method: "POST", auth: STK, body: { app_id: "app-1" } },
    ]);
  });

  it("rejects unknown, missing and unsafe inputs before calling Plivo", async () => {
    const { toWorker, sent } = setup({ CONFIRMATION_MODE: "allow" });
    const client = await connect(toWorker);
    const bad: [string, Record<string, unknown>][] = [
      ["send_sms", { src: "+14155550100", dst: "+14155550101", text: "hi", made_up: 1 }],
      ["send_sms", { src: "+14155550100", text: "hi" }],
      ["get_message", { message_uuid: "../Call" }],
    ];
    for (const [name, args] of bad) expect((await call(client, name, args)).isError, JSON.stringify(args)).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("publishes strict schemas carrying the catalog's descriptions", async () => {
    const { tools } = await (await connect(setup().toWorker)).listTools();
    const schema = (name: string) => tools.find((t) => t.name === name)!.inputSchema as {
      required?: string[];
      additionalProperties?: boolean;
      properties: Record<string, { description?: string }>;
    };
    expect(schema("send_sms")).toMatchObject({ required: expect.arrayContaining(["src", "dst"]), additionalProperties: false });
    expect(schema("send_sms").properties.dst.description).toContain("E.164");
    expect(schema("list_calls").properties.end_time__gt.description).toMatch(/^end_time greater than this value\. /);
  });

  it("refuses to build a shortcut the catalog does not back", () => {
    expect(() => buildShortcuts([{ name: "x", id: "GET /Nope/", description: "", params: [] }])).toThrow(/not in the catalog/);
    expect(() => buildShortcuts([{ name: "x", id: "GET /Call/", description: "", params: ["end_time__between"] }])).toThrow(/not in the catalog/);
    expect(() => buildShortcuts([{ name: "x", id: "POST /Message/", description: "", params: ["dlt_entity_id"] }])).toThrow(/deprecated/);
  });
});

describe("confirmation", () => {
  const SMS = { src: "+14155550100", dst: "+14155550101", text: "hi" };
  const SENT_SMS = { url: `${API}/v1/Account/me/Message/`, method: "POST", auth: STK, body: SMS };

  it.each<[string, string, Record<string, unknown>, { pin: "2026-07-28" } | undefined]>([
    ["send_sms", "send_sms", SMS, undefined],
    ["plivo_api_write", "plivo_api_write", { id: "POST /Message/", params: SMS }, undefined],
    ["send_sms on a 2026-07-28 client", "send_sms", SMS, { pin: "2026-07-28" }],
  ])("%s: previews first, sends once the code comes back", async (_, tool, args, mode) => {
    const { toWorker, sent } = setup();
    const client = await connect(toWorker, STK, mode);
    const first = await call(client, tool, args);
    const preview = first.parsed as { status: string; action: string; confirmation_code: string };
    expect(preview).toMatchObject({ status: "confirmation_required", nothing_done_yet: true });
    expect(preview.action).toContain('dst: "+14155550101"');
    expect(sent).toHaveLength(0);

    const second = await call(client, tool, { ...args, confirmation_code: preview.confirmation_code });
    expect(second.isError).toBe(false);
    expect(sent).toEqual([SENT_SMS]);
  });

  it("a code approves only that request, for that caller, while it is fresh", async () => {
    const { toWorker, sent } = setup();
    const client = await connect(toWorker);
    const code = ((await call(client, "send_sms", SMS)).parsed as { confirmation_code: string }).confirmation_code;

    const other = await connect(toWorker, "Bearer stk_" + "b".repeat(32));
    const refused: [Client, Record<string, unknown>][] = [
      [client, { ...SMS, text: "something else", confirmation_code: code }],
      [other, { ...SMS, confirmation_code: code }],
      [client, { ...SMS, confirmation_code: "made-up" }],
    ];
    for (const [c, args] of refused) expect((await call(c, "send_sms", args)).isError, JSON.stringify(args)).toBe(true);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + (CODE_TTL_SECONDS + 1) * 1000);
      expect((await call(client, "send_sms", { ...SMS, confirmation_code: code })).raw).toContain("expired");
    } finally {
      vi.useRealTimers();
    }
    expect(sent).toHaveLength(0);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["POST /Zentrunk/Credential/", { params: { username: "sipuser1", password: SIP_PASSWORD } }, "keeps working after this app is disconnected"],
    ["POST /Number/{number}/", { path_params: { number: "14155550134" }, params: { app_id: "12345" } }, "changes where this account's calls or messages are sent"],
    ["POST /Call/{call_uuid}/", { path_params: { call_uuid: "c1" }, params: { legs: "aleg", aleg_url: "https://example.com/x" } }, "moves a live call"],
  ])("%s is free but asks first, and says why", async (id, args, why) => {
    const { toWorker, sent } = setup();
    const client = await connect(toWorker);
    const preview = (await call(client, "plivo_api_write", { id, ...args })).parsed as { status: string; action: string; confirmation_code: string };
    expect(preview.status).toBe("confirmation_required");
    expect(preview.action).toContain(why);
    expect(sent).toHaveLength(0);
    await call(client, "plivo_api_write", { id, ...args, confirmation_code: preview.confirmation_code });
    expect(sent).toHaveLength(1);
  });

  it("never shows a password in the preview", async () => {
    const { toWorker } = setup();
    const client = await connect(toWorker);
    const res = await call(client, "plivo_api_write", { id: "POST /Zentrunk/Credential/", params: { username: "sipuser1", password: SIP_PASSWORD } });
    const action = (res.parsed as { action: string }).action;
    expect(action).not.toContain(SIP_PASSWORD);
    expect(action).toContain("password: (hidden, 10 characters)");
    expect(action).toContain("delete it in the Plivo console");
  });

  it("sends other free writes without asking, and lists the reasons in details", async () => {
    const { toWorker, sent } = setup();
    const client = await connect(toWorker);
    const created = await call(client, "plivo_api_write", { id: "POST /Application/", params: { app_name: "a1", answer_url: "https://example.com/a" } });
    expect(created.isError).toBe(false);
    expect(sent).toHaveLength(1);
    const details = (id: string) => call(client, "plivo_api_details", { id }).then((r) => (r.parsed as { needs_approval: string[] }).needs_approval);
    expect(await details("POST /Application/")).toEqual([]);
    expect(await details("POST /Application/{app_id}/")).toEqual(["This changes where this account's calls or messages are sent."]);
  });

  it("shows required params first and escapes values, whatever the model sends", () => {
    const op = getOperation("POST /Message/")!;
    const filler = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`aaa${i}`, "x"]));
    const req = buildRequest(op, { params: { ...filler, text: "hi\ndst: +19990000000", dst: "+14155550101", src: "+14155550100" } }, { authorization: STK, authId: "me" }, API);
    if ("error" in req) throw new Error(req.error);
    const lines = describeAction(op, req).split("\n");
    expect(lines.slice(2, 5)).toEqual(['src: "+14155550100"', 'dst: "+14155550101"', 'text: "hi\\ndst: +19990000000"']);
    expect(lines.filter((l) => l.startsWith("dst"))).toHaveLength(1);
    expect(lines.at(-1)).toBe("…and 5 more fields");
  });
});

describe("search_docs", () => {
  type Hit = { title: string; section?: string; url: string; text: string };
  const DOCS = "https://plivo.com/docs/";

  it.each([
    ["Speak XML", "voice/xml/audio-output"],
    ["10DLC registration", "messaging/api/10dlc/overview"],
    ["SMS error codes", "messaging/troubleshooting/error-codes"],
    ["forward incoming calls", "voice/use-cases/call-forwarding"],
  ])("%s → %s", async (query, page) => {
    const res = await call(await connect(setup().toWorker), "search_docs", { query, limit: 3 });
    const hits = res.parsed as Hit[];
    expect(hits.map((h) => h.url)).toContain(DOCS + page);
    expect(hits.every((h) => h.text.length > 0)).toBe(true);
  });

  it("returns each section once, at most two per page, within the limit", async () => {
    const hits = (await call(await connect(setup().toWorker), "search_docs", { query: "call", limit: 10 })).parsed as Hit[];
    expect(hits).toHaveLength(10);
    expect(new Set(hits.map((h) => `${h.url} ${h.title} ${h.section}`)).size).toBe(10);
    const perPage = new Map<string, number>();
    for (const h of hits) perPage.set(h.url, (perPage.get(h.url) ?? 0) + 1);
    expect(Math.max(...perPage.values())).toBeLessThanOrEqual(2);
  });

  it("says so when nothing matches", async () => {
    expect((await call(await connect(setup().toWorker), "search_docs", { query: "zzqqxx" })).raw).toContain("No docs match");
  });

  it("is built from the same docs snapshot as the catalog", () => {
    expect(docsSources.docs_sha256).toBe(catalogData.sources.docs_sha256);
  });

  it("gives the auth proxy exactly the catalog's routes", () => {
    const routes = new Map(catalogData.operations.map((o) => [`${o.method} ${o.path}`, o.module]));
    expect(new Map(proxyRoutes.map((r) => [`${r.method} ${r.path}`, r.module]))).toEqual(routes);
  });
});
