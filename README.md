# Plivo MCP server

The hosted [Model Context Protocol](https://modelcontextprotocol.io) server for the Plivo API, served at
`mcp.plivo.com`. Claude, ChatGPT, Cursor and other MCP clients connect to one URL; nothing is installed.

It runs as a stateless Cloudflare Worker. It never holds Plivo credentials: each call carries the user's
scoped `stk_` token to Plivo's auth proxy (`/v1/proxy`), which checks the token's scope and swaps in the account's
Auth ID and Auth Token.

```
MCP client ──Bearer stk_──▶ CloudFront ──▶ this Worker ──Bearer stk_──▶ auth proxy /v1/proxy ──Basic──▶ api.plivo.com
```

Every call to the auth proxy also carries:

- The Worker's own client secret (`MCP_CLIENT_SECRET`) in `X-Plivo-MCP-Client-Key`. The auth proxy honours an MCP
  token only beside it, so a token cannot be used around this server and its approvals (`asThisServer` in
  `src/index.ts`).
- For the proxy's logs: a fresh `X-Request-Id`, the MCP app's `User-Agent` as `X-MCP-Client`, the connecting IP as
  `X-MCP-Client-IP` and the inbound `X-Forwarded-For` as `X-MCP-Forwarded-For` (`clientHeaders` in
  `src/upstream.ts`). CloudFront sits in front of the Worker, so the connecting IP is its edge and the caller's own
  address is only in the forwarded list.

Opened in a browser, `https://mcp.plivo.com/` serves a landing page (`src/landing.ts`); other clients get one plain
line there. Any path other than `/`, `/mcp` and the sign-in routes answers 404.

## Tools

The server registers 22 tools (`src/server.ts`): the 9 below and 13 shortcuts.

| Tool | What it does |
|---|---|
| `plivo_api_search` | Find operations by intent ("send an SMS", "list calls") |
| `plivo_api_details` | An operation's params, path params, whether it costs money and why it needs approval |
| `plivo_api_read` | Call a `GET` operation |
| `plivo_api_write` | Call a `POST` / `PATCH` / `DELETE` operation |
| `search_docs` | Search Plivo's guides and reference: how something works, Plivo XML, error codes, FAQs |
| `diagnose_call` | Ask Plivo's support assistant what happened on a call, from traces the API does not expose |
| `diagnose_message` | Ask Plivo's support assistant why a message failed or what its status means |
| `list_organizations` | List the organizations the connection may use, which one is current, and the access it was given at sign-in |
| `switch_organization` | Move the connection to another of those organizations, after the user approves |

Shortcuts cover the common tasks in one call: `get_account`, `list_numbers`, `search_numbers`, `list_messages`,
`get_message`, `list_calls`, `get_call`, `send_sms`, `make_call`, `buy_number`, `hangup_call`, `list_voices`,
`text_to_speech`. Each one maps to a
catalog operation and takes a short list of its params (`src/shortcuts.ts`); types and descriptions come from the
catalog, and the Worker refuses to start if a listed operation or param is missing from it. The four `plivo_api_*`
tools reach all 148 operations in the catalog (68 `GET`, 50 `POST`, 29 `DELETE`, 1 `PATCH`); 19 cost money and 23
cannot be undone.

### Text-to-speech

`text_to_speech` (`POST /TTS/`) is the one operation that answers with audio, so it has its own path through the
Worker (`src/speech.ts`). The reply is a short text summary followed by the clip as an MCP audio part. To keep the
clip inside one reply, a request speaks at most 1,000 characters, `output_format` is not accepted, and the audio is
always mp3 at 24 kHz and 48 kbps, at most 750 KB. All of that is checked before the user is asked to approve, since
Plivo bills per character. Longer text and other formats stay with the Plivo CLI (`plivo tts speak`). Voices,
lexicons and usage are plain JSON operations: `list_voices`, or `plivo_api_search` for the rest. A speak call that
times out or fails with a 5xx may already have been billed, and the reply says to check `GET /TTS/Usage/` before
retrying. The `/TTS/Realtime/` WebSocket is not exposed.

The diagnose tools first check that the call or message is on the account, then send only its id (and a message's
channel) to the auth proxy, which asks Plivo's support assistant and streams the answer back (30 seconds to 2 minutes
for a call). The assistant can file a support ticket; the result says if it did or tried (`src/diagnose.ts`), and for
that reason the tools are not marked read-only. They need the auth proxy, so they refuse Basic auth.

### What the model sees in a reply

Every reply from Plivo has its credential fields replaced with `[hidden]` before the model sees it, at any depth and
on reads and writes alike (`hideSecrets` in `src/upstream.ts`): text under a field named like a password, passphrase,
PIN, secret, token, API key, private key, bearer, JWT, authorization or cookie, a number under a password-like field,
and the `value` beside such a `name` or `key` in a list of headers. JSON held in a text field is searched too. An
endpoint read, for one, returns the SIP password. Only a value that could be a credential is hidden: cursors
(`next_page_token`), counts (`prompt_tokens`), booleans, state fields (`authorization_status`), error reasons, JSON
Schemas and the `***REDACTED***` placeholder Plivo sends for a stored agent secret all stay. A reply cut at the 1 MB
limit that names a secret is not shown at all.

A write that carries `[hidden]` back under a secret-named field is refused, so the marker can never replace a real
credential (`inputError` in `src/validate.ts`).

Reads that return text from outside the account (messages, calls, conferences, recordings, caller names,
verification sessions, AI agents and their runs, and the diagnose tools) carry a `note` telling the model to treat
that text as data, never as instructions (`UNTRUSTED_NOTE` in `src/server.ts`).

### Input checks

A write is checked before the user is asked and before anything is sent (`src/validate.ts`); Plivo validates the rest.

- Phone numbers must look like phone numbers: the number in a path, and the sender and destination fields of
  messages, calls, multi-party call participants, masking sessions, toll-free verifications and 10DLC campaign
  numbers. Calls also take `sip:` URIs, and a message sender may be a short code or an alphanumeric sender ID.
- One message, call or multi-party call request reaches at most 10 destinations (`MAX_DESTINATIONS`). The
  `delimiter` param is not accepted on those requests.
- A URL param (`url`, `urls`, `media_urls`, or a name ending in `_url` or `_urls`) must be `https` (`wss` for
  `service_url`), carry no username or password, and point at a public host. A URL nested inside a structured param
  must point at a public host too, unless its host is a template filled in when an agent runs.

## Approvals

Calls that cost money or cannot be undone (`costs_money` / `destructive` in the catalog) need the user's
approval, whichever tool makes them (`src/confirm.ts`); that includes the number and caller-name lookups, which only
read. So do free writes that keep working after the token is revoked, send traffic elsewhere or act on live traffic
(`ASKS_FIRST` in `src/confirm.ts`):

- SIP endpoints, trunks, trunk credentials, IP lists and origination URIs
- creating or changing an application, pointing a number or Powerpack somewhere new, adding a number to a Powerpack
- creating, changing, publishing, pausing or resuming an AI agent
- transferring a live call, pressing keypad digits on one, removing a member from a conference
- changing the account's own details
- registrations that carriers or regulators review: 10DLC campaign numbers, compliance links, toll-free verification

`switch_organization` needs approval as well.

The first call sends nothing. How the user is asked depends on the MCP app (`approvalGate` in `src/confirm.ts`):

1. **The app's own dialog.** An app that supports MCP elicitation shows the action in its own dialog, and the user
   approves or declines there. The model sees neither the question nor the answer, so it cannot approve for the user.
   Anything but a clear approval sends nothing.
2. **An approval link.** For any other app the Worker registers the action at the auth proxy and returns
   `approval_required` with an `approval_url` and a `confirmation_code`. The link opens a Plivo Console page where
   the signed-in user approves or denies; only an admin of that organization can approve. The model then calls again
   with the same arguments plus the code, and the Worker asks the auth proxy what the user decided
   (`src/approvals.ts`). The link and the code approve nothing by themselves.
3. **A typed code.** Where there is no auth proxy to hold approvals (local development), the call returns
   `confirmation_required` with a preview and a `confirmation_code`. The model shows the user the action and, once
   they say yes, calls again with the same arguments plus the code. Here the server trusts the model to actually ask.

Every approval:

- **covers one exact request.** It is bound to the method, URL and body, and to the caller's token. A changed
  argument needs a new approval.
- **expires** after 5 minutes.
- **works once.** The auth proxy records each approval the first time it is used and refuses it after that. Local
  development has no auth proxy to remember this, so there an approval works until it expires.
- **names the account** it will run on (Auth ID and name) and is kept with that Auth ID. The account is read again
  when the answer arrives, and the request is sent only if the connection is still on that account. An approved
  request is addressed to that Auth ID rather than `me`, so the auth proxy itself refuses it if a switch lands after
  the check (the Lookup path carries no Auth ID, so there the check alone decides). A token without the account
  permission is named from the organizations route instead; if Plivo cannot say which account the connection is on,
  nothing is asked or sent.

The preview shows every field of the request; for a paid action it adds the account balance, and for a number
purchase the price. It hides any field named like a password or secret, and credentials inside URLs. An action whose
preview passes 8,000 characters is refused instead of being cut short.

`CONFIRMATION_MODE` is `confirm` (default; needs `CONFIRM_SECRET`, 32+ characters), `block` (refuse such actions),
or `allow` (send them unasked; refused unless `PLIVO_API_BASE` is on localhost).

## Organizations

A user who belongs to several organizations ticks, at sign-in, the ones the connection may use. The token starts on
the sign-in organization, and the auth proxy runs every call on the token's current organization, so the other tools
take no organization parameter. `list_organizations` lists the allowed organizations
(`GET /v1/proxy/mcp/organizations`). `switch_organization` takes an Auth ID from that list, asks the user, naming both
organizations, and then moves the token (`POST /v1/proxy/mcp/organization`). The Worker keeps nothing: it reads the
current organization from the proxy on each call (`src/organizations.ts`). A switch applies to calls made after it
returns, so a call sent alongside it may run on either organization.

A switch between an approval's question and its answer voids that approval. An organization outside the list is a
plain tool error; changing the list takes a new sign-in.

## Permissions

On the sign-in screen the user can set Access to Read-only or Custom instead of Full access. Custom gives each of
9 areas (Account, Phone numbers, Messages, ..., Text-to-speech) a level: No access, Read-only, or Read and write. The auth proxy stores
the result as a subset of its 19 permissions (its modules, such as `message.send`) for the whole connection. The
proxy enforces the choice; the Worker only reports it and keeps nothing about it.

- A call the proxy refuses with `errors.error: "permission_not_granted"` is a plain tool error. It tells the model
  that nothing was done, names the area and the level the action needs (`src/permissions.ts`), says the user must
  reconnect the server and set that level, and says not to retry before then. It is not a sign-in challenge.
- A 403 with `required_module` alone is a sign-in challenge: that token predates the module. The tool call gets an
  HTTP 403 with `error="insufficient_scope"`, and the client signs in again.
- `list_organizations` adds `permissions`: full access, or each area's level.
- Before asking the user to approve an action, the Worker reads the permissions from the organizations route,
  alongside the account read, and refuses at once if the action's permission is off. Only the question does this:
  plain reads, writes that need no approval and the call that carries the answer add no request. If the proxy
  reports no permissions or cannot be read, the question is asked as before.
- Tools are not hidden from `tools/list`.

## Sign-in

MCP clients sign in with OAuth 2.1, and this Worker is the authorization server (`src/oauth.ts`). It stores nothing:
client ids (from dynamic client registration), the login in progress (an HttpOnly cookie) and authorization codes are
all HMAC-signed with `OAUTH_SECRET`.

```
MCP client ─/authorize─▶ Worker ─302 client=mcp─▶ Plivo login ─▶ Console consent ─▶ /oauth/callback ─▶ MCP client
MCP client ─/token (PKCE)─▶ Worker ─/v1/accounts/cli/token (its own PKCE)─▶ auth proxy mints stk_ ─▶ access_token
```

The token is an `stk_` scope token for 30 days, limited to the catalog's modules and routes; there is no
refresh token, so a client signs in again when it expires. A 401 from `/mcp` carries
`WWW-Authenticate: Bearer resource_metadata=…`, which is how clients find the sign-in. Setting
`PLIVO_LOGIN_BASE` turns this on; `OAUTH_SECRET` and `MCP_CLIENT_SECRET` must then be at least 32 characters.

A redirect URI may be `https`, `http` on a loopback address, or an app's own scheme (`cursor://`, `vscode://`,
`com.example.app:/…`). Schemes the browser or the operating system handles itself (`ftp`, `tel`, `mailto`, `ms-…`,
`chrome-extension` and the like) are refused at `/register`, and again at `/authorize` for a client id issued before
the rule. The consent screen names the redirect host first; for an app scheme it reads `cursor: app link to <host>`,
so an app link can never look like a website. Each login in progress has its own cookie, so several sign-ins can run
in one browser; at most 5 are kept (fewer when their cookies would pass 6 KB together), and each lasts 10 minutes.

Redeeming a login code also sends `MCP_CLIENT_SECRET`, which must equal the auth proxy's `mcp_client_secret`, so only
this Worker can turn an MCP login into a token.

Behind a proxy that forwards the Worker's own Host (CloudFront in front of the workers.dev name), set `PUBLIC_ORIGIN`
to the address clients use, e.g. `https://mcp.plivo.com`. The metadata, the issuer, the 401 challenge and the login
cookie then name that origin, and the auth proxy's `mcp_callback_url` must be `<PUBLIC_ORIGIN>/oauth/callback`.
`ALLOWED_HOSTS` lists the Host values the Worker accepts on `/mcp` and the sign-in routes.

### The token is checked on every call

Before any request to `/mcp` is handled, tool calls included, the Worker reads the account through the auth proxy
with the caller's token (`src/tokencheck.ts`). If the proxy refuses the token (its 401 says `error="invalid_token"`),
the request gets an HTTP 401 with the same error, and the client signs in again. An accepted token is not asked about
again for 60 seconds, and if the proxy cannot be reached the request goes on. A token refused during a tool call gets
the same 401. A 401 from Plivo for a valid token stays a tool error, so it cannot cause a sign-in loop.

### Disconnecting

`POST /oauth/revoke` ends a token when an app disconnects (RFC 7009); the sign-in metadata names it as the
`revocation_endpoint`. The Worker passes the token to the auth proxy's `/v1/accounts/cli/revoke` and answers 200
only once the proxy has dealt with it, so a client is never told a live token is gone. If the proxy cannot be
reached or fails, the answer is 503. A value that cannot be one of these tokens answers 200, as the RFC asks.

### Registration rate limit

`/register` is open to anyone, as MCP requires, so it is rate limited per caller address with a Workers Rate Limiting
binding (`REGISTER_LIMITER`, under `ratelimits` in `wrangler.jsonc`): 20 registrations a minute, after which the
caller gets a 429 with `Retry-After: 60`. The caller is the address in CloudFront's `CloudFront-Viewer-Address`
header, or failing that the address CloudFront appended to `X-Forwarded-For`; an IPv6 caller is counted by its /64.
`CF-Connecting-IP` is never used, because behind CloudFront it is CloudFront's address. The limit relies on
`EDGE_SECRET` (below), which makes CloudFront the only source of those headers. Counts are kept per Cloudflare
location and are approximate. Without the binding, without an address, or if the limiter fails, registration is not
limited. To change the numbers, edit `limit` and `period` (10 or 60 seconds) in `wrangler.jsonc` and deploy.

### The front door

CloudFront reaches the Worker on its workers.dev name. When `EDGE_SECRET` is set, the Worker answers only requests
that carry the same value in the `X-Plivo-Edge-Secret` header, which CloudFront adds; every other request gets a 403
before anything else happens. Production sets it, so the workers.dev address answers 403 to everyone but CloudFront.
Unset (or empty), nothing is checked. A value under 32 characters makes every request fail with 500.

To set it for the first time, follow this order; step 2 before step 1 takes the server down for everyone:

1. In CloudFront, add a custom header named `X-Plivo-Edge-Secret` on the Worker origin, holding a random value of
   32+ characters, and wait until the distribution is deployed. CloudFront overwrites a header of that name sent by
   a client.
2. Set the same value on the Worker: `npx wrangler secret put EDGE_SECRET`.
3. Check that `https://mcp.plivo.com/` still answers 200 and the workers.dev address answers 403.

To rotate or remove it: `npx wrangler secret delete EDGE_SECRET` first, then change CloudFront, then set the new
value on the Worker. The check is off in between.

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

It also writes `catalog/proxy-routes.json`, the auth proxy's allow-list for these tokens: one route per method and
path in the catalog, with the permission it needs. Copy it to the proxy's `config/mcpProxyRoutes.json` whenever it
changes.

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

To run the Worker against `api.plivo.com`, copy `.dev.vars.example` to `.dev.vars`, fill in `CONFIRM_SECRET`, and
`npm run dev`, then point an MCP client at `http://localhost:8787/mcp` with an
`Authorization: Basic <auth_id:auth_token>` header. Basic auth is for local development only; production accepts
`stk_` tokens alone. The number lookup, the diagnose tools and the organization tools need the auth proxy, so they
fail under Basic auth, and approvals use the app's dialog or the typed code.

## Deploy

A merge to `main` deploys the Worker to production: `.github/workflows/deploy.yml` runs the type check and the tests,
then `wrangler deploy`. A newer deploy waits for the running one. Pull requests run the same checks and the generator's
tests without deploying (`ci.yml`). `main` takes changes only through a pull request that passes the `test` check and
has an approval from a code owner (`.github/CODEOWNERS`).

To roll back, run `npx wrangler rollback` or pick the previous version in the Cloudflare dashboard. `main` still
holds the bad change, and the next merge deploys it again, so revert it on `main` as well. Running the Deploy
workflow by hand redeploys `main`.

Settings, by name. The Worker's secrets are set once in Cloudflare with `npx wrangler secret put <NAME>` and outlive
deploys.

| Where | Name | What it is |
|---|---|---|
| `wrangler.jsonc` vars | `PLIVO_API_BASE` | The auth proxy's `/v1/proxy` base |
| | `PLIVO_LOGIN_BASE` | Origin of Plivo's browser login; turns sign-in on |
| | `ALLOW_BASIC_AUTH`, `CONFIRMATION_MODE` | `false` and `confirm` in production |
| `wrangler.jsonc` binding | `REGISTER_LIMITER` | The registration rate limit |
| Worker secrets | `CONFIRM_SECRET` | Signs approval state and codes |
| | `OAUTH_SECRET` | Signs client ids, logins and authorization codes |
| | `MCP_CLIENT_SECRET` | The auth proxy's `mcp_client_secret` |
| | `EDGE_SECRET` | The value CloudFront sends in `X-Plivo-Edge-Secret` |
| | `ALLOWED_HOSTS` | Host values the Worker accepts, comma-separated |
| | `PUBLIC_ORIGIN` | The origin clients use |
| GitHub `production` environment secret | `CLOUDFLARE_API_TOKEN` | A Cloudflare token with Workers Scripts: Edit on the account that owns the Worker. The environment is limited to `main` |
| GitHub repository variable | `CF_ACCOUNT_ID` | That account's id |

## Not built yet

- Client ID Metadata Documents (URL client ids); clients register with dynamic client registration instead
