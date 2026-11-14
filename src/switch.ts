import { createRequestStateCodec, type McpServer, type RequestStateCodec, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { getOperation } from "./catalog";
import type { ServerConfig } from "./server";
import { buildRequest, callUpstream, type Credential } from "./upstream";

export type Switcher = RequestStateCodec<{ k: "switch" }>;

const CODE_TTL_SECONDS = 300;

export function createSwitcher(oauthSecret: string): Switcher {
  // Bound to the token: once the user has signed in again the same code no longer verifies, so a client that
  // retries the call after sign-in gets an answer instead of another sign-in.
  const bind = (ctx: ServerContext) => ctx.http?.authInfo?.token ?? "";
  return createRequestStateCodec({ key: `switch.${oauthSecret}`, ttlSeconds: CODE_TTL_SECONDS, bind });
}

function result(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

async function currentAccount(caller: Credential, config: ServerConfig): Promise<{ name: unknown; auth_id: unknown } | "unavailable"> {
  const req = buildRequest(getOperation("GET /")!, {}, caller, config.apiBase);
  if ("error" in req) return "unavailable";
  try {
    const res = await callUpstream(req, caller, config.fetchImpl);
    if (res.tokenRejected) config.onTokenRejected?.();
    const body = res.ok && res.body !== null && typeof res.body === "object" ? (res.body as Record<string, unknown>) : undefined;
    return body ? { name: body.name, auth_id: body.auth_id } : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * The tool never chooses an organization. It can only send the user back to Plivo's sign-in, where the user picks one
 * and approves; the model sees neither that screen nor the token it ends in.
 */
export function registerSwitchTool(server: McpServer, switcher: Switcher, caller: Credential | undefined, config: ServerConfig): void {
  server.registerTool(
    "switch_organization",
    {
      title: "Show or switch the Plivo organization",
      description:
        "Show which Plivo account (organization) this connection uses. To move the connection to another organization " +
        "the user belongs to, call again with the returned switch_code: the user then signs in to Plivo again and picks " +
        "the organization there. Switch only when the user asks to.",
      inputSchema: z.strictObject({
        switch_code: z.string().max(2000).optional().describe("Only to start a switch the user asked for: the switch_code a previous call returned."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ switch_code }, reqCtx) => {
      if (!caller) return result("This request has no Plivo credentials.", true);
      const startsSwitch =
        switch_code !== undefined &&
        (await switcher.verify(switch_code, reqCtx).then(
          () => true,
          () => false,
        ));
      if (startsSwitch) {
        config.onSwitchRequested?.();
        return result("The user has to sign in to Plivo again to choose the organization.");
      }
      const account = await currentAccount(caller, config);
      if (switch_code !== undefined) {
        return result({
          account,
          note:
            "No sign-in was started: switch_code does not belong to this connection as it is now. If the user has just signed " +
            "in again, the switch is finished and this is the account in use. To switch again, call without switch_code first.",
        });
      }
      return result({
        account,
        switch_code: await switcher.mint({ k: "switch" }, reqCtx),
        expires_in_seconds: CODE_TTL_SECONDS,
        instructions:
          "This is the Plivo account this connection uses. Only if the user asked to switch organization, call " +
          "switch_organization again with switch_code. The user then picks the organization on Plivo's own sign-in page; you cannot pick it for them.",
      });
    },
  );
}
