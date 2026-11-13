/**
 * The auth proxy's memory of approvals. This server keeps no state, so it cannot tell on its own that an
 * approval was already acted on; the proxy records each one the first time it is spent.
 */
export interface Approvals {
  /**
   * Spends an approval: "ok" the first time, "used" after that. "absent" is a proxy without the endpoint, which
   * is what a rollout looks like until the proxy is deployed.
   */
  consume(id: string, authorization: string): Promise<"ok" | "used" | "absent" | "failed">;
}

const TIMEOUT_MS = 10_000;

export function proxyApprovals(loginBase: string, fetchImpl: typeof fetch = fetch): Approvals {
  const base = `${loginBase.replace(/\/+$/, "")}/v1/accounts/cli/approvals`;
  return {
    async consume(id, authorization) {
      let res: Response;
      try {
        res = await fetchImpl(`${base}/consume`, {
          method: "POST",
          headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ id }),
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        return "failed";
      }
      await res.body?.cancel();
      if (res.status === 200) return "ok";
      if (res.status === 409) return "used";
      return res.status === 404 ? "absent" : "failed";
    },
  };
}

/** An approval's id at the proxy: a hash, so the signed approval itself never leaves this server. */
export async function approvalId(proof: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
