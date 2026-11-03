# Plivo MCP server

The hosted [Model Context Protocol](https://modelcontextprotocol.io) server for the Plivo API, served at
`mcp.plivo.com`. Claude, ChatGPT, Cursor and other MCP clients connect to one URL; nothing is installed.

It runs as a stateless Cloudflare Worker. It never holds Plivo credentials: each call carries the user's
scoped `stk_` token to Plivo's auth proxy (`/v1/proxy`), which checks the token's scope and swaps in the account's
Auth ID and Auth Token.

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

Shortcuts cover the common tasks in one call: `get_account`, `list_numbers`, `search_numbers`, `list_messages`,
`get_message`, `list_calls`, `get_call`, `send_sms`, `make_call`, `buy_number`, `hangup_call`. Each one maps to a
catalog operation and takes a short list of its params (`src/shortcuts.ts`); types and descriptions come from the
catalog, and the Worker refuses to start if a listed operation or param is missing from it.

## Confirmation

Writes that cost money or cannot be undone (`costs_money` / `destructive` in the catalog) need the user's
approval, whichever tool makes them (`src/confirm.ts`). The first call sends nothing and returns
`confirmation_required`: a preview of the action and a `confirmation_code`, valid for 5 minutes, bound to the
caller and to the exact method, URL and body. The model asks the user, and once they say yes, calls again with
the same arguments plus the code.

The server trusts the model to actually ask; what it enforces is that only the previewed request is sent, by the
same caller, while the code is fresh. Being stateless, a code can be reused for that same request until it
expires. `CONFIRMATION_MODE` is `confirm` (default; needs `CONFIRM_SECRET`, 32+ characters), `block` (refuse such
writes), or `allow` (send them unasked; refused unless `PLIVO_API_BASE` is on localhost).

## The catalog

`catalog/catalog.json` lists every operation the tools can reach. `catalog/gen` builds it from:

- Plivo's docs export (`llms-full.txt`): params, types, required flags, descriptions
- plivo-cli's source: which endpoints to expose (the CLI's surface) and which spend money (`guardSpend`)
- `catalog/overrides.json`: reviewed decisions, each with a reason

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
Basic auth is for local development only; production accepts `stk_` tokens alone.

## Not built yet

- OAuth login, and the auth proxy's `me` account placeholder and catalog-generated `/v1/proxy` allowlist
- AgentFlow operations: the docs have no pages for them; params will come from the AgentFlow service
