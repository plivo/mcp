# Plivo MCP server

The hosted [Model Context Protocol](https://modelcontextprotocol.io) server for the Plivo API, served at
`mcp.plivo.com`. Claude, ChatGPT, Cursor and other MCP clients connect to one URL; nothing is installed.

It runs as a stateless Cloudflare Worker. It never holds Plivo credentials: each call carries the user's
scoped `stk_` token to Plivo's auth proxy (`/v1/proxy`), which checks the token's scope and swaps in the account's
Auth ID and Auth Token. For the proxy's logs, each call also carries a fresh `X-Request-Id`, the MCP app's
`User-Agent` as `X-MCP-Client`, the connecting IP as `X-MCP-Client-IP` and the inbound `X-Forwarded-For` as
`X-MCP-Forwarded-For`: CloudFront sits in front of the Worker, so the connecting IP is its edge and the caller's own
address is only in the forwarded list.

Opened in a browser, `https://mcp.plivo.com/` serves a landing page (`src/landing.ts`); other clients get one plain line.

```
MCP client ──Bearer stk_──▶ mcp.plivo.com (this Worker) ──Bearer stk_──▶ auth proxy /v1/proxy ──Basic──▶ api.plivo.com
```

## Tools

| Tool | What it does |
|---|---|
| `plivo_api_search` | Find operations by intent ("send an SMS", "list calls") |
| `plivo_api_details` | An operation's params, path params, and whether it costs money |
| `plivo_api_read` | Call a `GET` operation |
| `plivo_api_write` | Call a `POST` / `PATCH` / `DELETE` operation |
| `search_docs` | Search Plivo's guides and reference: how something works, Plivo XML, error codes, FAQs |
| `diagnose_call` | Ask Plivo's support assistant what happened on a call, from traces the API does not expose |
| `diagnose_message` | Ask Plivo's support assistant why a message failed or what its status means |
| `list_organizations` | List the organizations the connection may use and which one is current |
| `switch_organization` | Move the connection to another of those organizations, after the user approves |

Shortcuts cover the common tasks in one call: `get_account`, `list_numbers`, `search_numbers`, `list_messages`,
`get_message`, `list_calls`, `get_call`, `send_sms`, `make_call`, `buy_number`, `hangup_call`. Each one maps to a
catalog operation and takes a short list of its params (`src/shortcuts.ts`); types and descriptions come from the
catalog, and the Worker refuses to start if a listed operation or param is missing from it.

The diagnose tools first check that the call or message is on the account, then send only its id to the auth proxy,
which asks Plivo's support assistant a fixed question and streams the answer back (30 seconds to 2 minutes for a
call). The assistant is told not to file a support ticket or change the account; the result says if it tried
(`src/diagnose.ts`). Because it can still file one, the tools are not marked read-only. They need the auth proxy, so
they refuse Basic auth.

Every reply from Plivo has its credential fields replaced with `[hidden]` before the model sees it, at any depth and
on reads and writes alike (`hideSecrets` in `src/upstream.ts`): a field named like a password, secret, token, key,
bearer, JWT, authorization or cookie, and the `value` beside such a `name` in a list of headers. An endpoint read, for
one, returns the SIP password. Only a value that could be a credential is hidden: cursors (`next_page_token`),
counts (`prompt_tokens`), booleans, state fields (`authorization_status`), error reasons, JSON Schemas and the
`***REDACTED***` placeholder Plivo sends for a stored agent secret all stay. A write that carries `[hidden]` back under
a secret-named field is refused, so the marker can never replace a real credential. A reply cut at
the 1 MB limit that names a secret is not shown at all. Reads that return text from outside the account (messages,
calls, recordings, caller names, verification sessions, AI agents and their runs, and the diagnose tools) carry a
`note` telling the model to treat that text as data (`UNTRUSTED_NOTE` in `src/server.ts`).

## Confirmation

Calls that cost money or cannot be undone (`costs_money` / `destructive` in the catalog) need the user's
approval, whichever tool makes them (`src/confirm.ts`); that includes the number and caller-name lookups, which only
read. So do free writes that keep working after the token is revoked or send traffic elsewhere: SIP endpoints,
credentials, IP lists and trunks, origination URIs, creating an application, pointing a number, application or
Powerpack somewhere new, adding a number to a Powerpack, changing an AI agent, and transferring a live call (`ASKS_FIRST` in
`src/confirm.ts`). The preview hides any field named like a password or secret. The first call sends nothing and returns
`confirmation_required`: a preview of the action and a `confirmation_code`, valid for 5 minutes, bound to the
caller and to the exact method, URL and body. The model asks the user, and once they say yes, calls again with
the same arguments plus the code.

The server trusts the model to actually ask; what it enforces is that only the previewed request is sent, by the
same caller, while the code is fresh. Being stateless, a code can be reused for that same request until it
expires. `CONFIRMATION_MODE` is `confirm` (default; needs `CONFIRM_SECRET`, 32+ characters), `block` (refuse such
writes), or `allow` (send them unasked; refused unless `PLIVO_API_BASE` is on localhost).

Every approval names the account it will run on (Auth ID and name) and is kept with that Auth ID. The account is
read again when the answer arrives, and the request is sent only if the connection is still on that account. An
approved request is addressed to that Auth ID rather than `me`, so the auth proxy itself refuses it if a switch lands
after the check (the Lookup paths carry no Auth ID, so there the check alone decides). A token without the account permission is named from the organizations route instead; if Plivo
cannot say which account the connection is on, nothing is asked or sent.

## Organizations

A user who belongs to several organizations ticks, at sign-in, the ones the connection may use. The token starts on
the sign-in organization, and the auth proxy runs every call on the token's current organization, so the other tools
take no organization parameter. `list_organizations` lists the allowed organizations
(`GET /v1/proxy/mcp/organizations`). `switch_organization` takes an Auth ID from that list, asks the user, naming both
organizations, and then moves the token (`POST /v1/proxy/mcp/organization`). The Worker keeps nothing: it reads the
current organization from the proxy on each call. A switch applies to calls made after it returns, so a call sent
alongside it may run on either organization.

A switch between an approval's question and its answer voids that approval. An organization outside the list is a
plain tool error; changing the list takes a new sign-in.

## Sign-in

MCP clients sign in with OAuth 2.1, and this Worker is the authorization server. It stores nothing: client ids
(from dynamic client registration), the login in progress (an HttpOnly cookie) and authorization codes are all
HMAC-signed with `OAUTH_SECRET`.

```
MCP client ─/authorize─▶ Worker ─302 client=mcp─▶ Plivo login ─▶ Console consent ─▶ /oauth/callback ─▶ MCP client
MCP client ─/token (PKCE)─▶ Worker ─/v1/accounts/cli/token (its own PKCE)─▶ auth proxy mints stk_ ─▶ access_token
```

The token is an `stk_` scope token for 90 days, limited to the catalog's modules and routes; there is no
refresh token, so a client signs in again when it expires. A 401 from `/mcp` carries
`WWW-Authenticate: Bearer resource_metadata=…`, which is how clients find the sign-in. Setting
`PLIVO_LOGIN_BASE` turns this on; `OAUTH_SECRET` must then be at least 32 characters.

A redirect URI may be `https`, `http` on a loopback address, or an app's own scheme (`cursor://`, `vscode://`,
`com.example.app:/…`). Schemes the browser or the operating system handles itself (`ftp`, `tel`, `mailto`, `ms-…`,
`chrome-extension` and the like) are refused at `/register`, and again at `/authorize` for a client id issued before
the rule. The consent screen names the redirect host first; for an app scheme it reads `cursor: app link to <host>`,
so an app link can never look like a website. Each login in progress has its own cookie, so several sign-ins can run
in one browser; at most 5 are kept (fewer when their cookies would pass 6 KB together), and each lasts 10 minutes.

Redeeming a login code also sends `MCP_CLIENT_SECRET`, which must equal the auth proxy's `mcp_client_secret`
(32+ characters), so only this Worker can turn an MCP login into a token. When the auth proxy refuses a token that
expired or was revoked (its 401 says `error="invalid_token"`), the tool call gets the same HTTP 401, and the client signs
in again. A 401 from Plivo for a valid token stays a tool error, so it cannot cause a sign-in loop.

Requests that never reach the auth proxy (`initialize`, `tools/list`, the search tools) are checked too: the Worker
reads the account through the proxy with the caller's token and answers the same 401 if the proxy refuses it. An
accepted token is not asked about again for 60 seconds, and if the proxy cannot be reached the request goes on.

Behind a proxy that forwards the Worker's own Host (CloudFront in front of the workers.dev name), set `PUBLIC_ORIGIN`
to the address clients use, e.g. `https://mcp.plivo.com`. The metadata, the issuer, the 401 challenge and the login
cookie then name that origin, and the auth proxy's `mcp_callback_url` must be `<PUBLIC_ORIGIN>/oauth/callback`.

### Closing the workers.dev address

CloudFront reaches the Worker on its workers.dev name, and so can anyone else, skipping whatever CloudFront enforces.
`EDGE_SECRET` closes that: when it is set, the Worker answers 403 to every request that does not carry the same value
in the `X-Plivo-Edge-Secret` header, before it does anything else. Unset (or empty), nothing is checked, so the code
is safe to deploy first. A value under 32 characters makes every request fail with 500.

Roll it out in this order; step 2 before step 1 takes the server down for everyone:

1. In CloudFront, add a custom header named `X-Plivo-Edge-Secret` on the Worker origin, holding a random value of
   32+ characters, and wait until the distribution is deployed. CloudFront overwrites a header of that name sent by
   a client.
2. Set the same value on the Worker: `npx wrangler secret put EDGE_SECRET`.
3. Check that `https://mcp.plivo.com/` still answers 200 and the workers.dev address answers 403.

To undo, or to change the value: `npx wrangler secret delete EDGE_SECRET` first, then change CloudFront, then set the
new value. The check is off in between.

`catalog/proxy-routes.json` is the auth proxy's allow-list for these tokens, one route per catalog operation.
`npm run catalog` rewrites it; copy it to the proxy's `config/mcpProxyRoutes.json` whenever it changes.

## The catalog

`catalog/catalog.json` lists every operation the tools can reach. `catalog/gen` builds it from:

- Plivo's docs export (`llms-full.txt`): params, types, required flags, descriptions
- plivo-cli's source: which endpoints to expose (the CLI's surface) and which spend money (`guardSpend`)
- `catalog/overrides.json`: reviewed decisions, each with a reason, and `extra_ops`: operations the CLI calls that the
  docs do not describe (the Agents API, CNAM lookups), written from the CLI's commands and the server's validation

Each run also writes `catalog/REVIEW.md`: what was included and why, what was excluded, new scope modules
the auth proxy needs, pricing to confirm, and param names where the docs and the SDKs disagree. The build fails on a
CLI call site nobody has reviewed or an override that no longer matches an operation.

The same run writes `catalog/docs.json`, the docs split into sections at their `##`/`###` headings, which
`search_docs` ranks with BM25 (`src/docs.ts`). Building both from one snapshot keeps them in step; a test checks
that their docs hashes match.

```sh
curl -sO https://docs.plivo.com/docs/llms-full.txt
DOCS=$PWD/llms-full.txt PLIVO_CLI=/path/to/plivo-cli npm run catalog
```

## Development

```sh
npm install
npm test                              # Worker, end to end through an MCP client
(cd catalog/gen && go test ./...)     # generator
npm run typecheck
```

To run the Worker against `api.plivo.com`, copy `.dev.vars.example` to `.dev.vars`, fill in `CONFIRM_SECRET`, and `npm run dev`, then
point an MCP client at `http://localhost:8787/mcp` with an `Authorization: Basic <auth_id:auth_token>` header.
Basic auth is for local development only; production accepts `stk_` tokens alone. Number lookups need the auth
proxy's `/v1/Lookup/` route, so they fail under Basic auth.

## Deploy

A merge to `main` deploys the Worker: `.github/workflows/deploy.yml` runs the type check and the tests, then
`wrangler deploy`. Pull requests run the same checks without deploying (`ci.yml`).

The deploy needs two settings on the repository:

- `CLOUDFLARE_API_TOKEN`, a secret in the `production` environment: a Cloudflare token with Workers Scripts: Edit
  on the account that owns the Worker. Limit the environment to `main`.
- `CF_ACCOUNT_ID`, a repository variable: that account's id.

The Worker's own secrets are set once in Cloudflare with `wrangler secret put` and outlive deploys. To roll back,
pick the previous version in the Cloudflare dashboard, or run `npx wrangler rollback`.

## Not built yet

- Client ID Metadata Documents (URL client ids); clients register with dynamic client registration instead
- The consent screen still reads "Authorize the Plivo CLI"; it names the MCP client only in its device line
- AgentFlow operations: the docs have no pages for them; params will come from the AgentFlow service
