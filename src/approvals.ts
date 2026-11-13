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
  /** Registers an action for the user to approve in the Plivo console, and returns the page to approve it on. */
  create(digest: string, action: string, authorization: string): Promise<{ id: string; url: string } | "absent" | "failed">;
  /** The user's decision. "approved" is given once; "gone" is an approval that expired or was already redeemed. */
  redeem(id: string, digest: string, authorization: string): Promise<"approved" | "pending" | "denied" | "gone" | "failed">;
}

const TIMEOUT_MS = 10_000;

export function proxyApprovals(loginBase: string, fetchImpl: typeof fetch = fetch): Approvals {
  const base = `${loginBase.replace(/\/+$/, "")}/v1/accounts/cli/approvals`;
  const post = async (path: string, authorization: string, body: unknown): Promise<Response | undefined> => {
    try {
      return await fetchImpl(base + path, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return undefined;
    }
  };
  const data = async (res: Response): Promise<Record<string, unknown>> => {
    try {
      const body = (await res.json()) as { data?: unknown };
      return body.data !== null && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return {
    async consume(id, authorization) {
      const res = await post("/consume", authorization, { id });
      if (!res) return "failed";
      await res.body?.cancel();
      if (res.status === 200) return "ok";
      if (res.status === 409) return "used";
      return res.status === 404 ? "absent" : "failed";
    },
    async create(digest, action, authorization) {
      const res = await post("", authorization, { digest, action });
      if (!res) return "failed";
      if (res.status !== 201) {
        await res.body?.cancel();
        // 404 and 405 are a proxy that has no such route yet.
        return res.status === 404 || res.status === 405 ? "absent" : "failed";
      }
      const { id, url } = await data(res);
      return typeof id === "string" && typeof url === "string" && /^https?:\/\//.test(url) ? { id, url } : "failed";
    },
    async redeem(id, digest, authorization) {
      const res = await post(`/${encodeURIComponent(id)}/redeem`, authorization, { digest });
      if (!res) return "failed";
      if (res.status === 404) {
        await res.body?.cancel();
        return "gone";
      }
      const status = res.status === 200 ? (await data(res)).status : (await res.body?.cancel(), undefined);
      return status === "approved" || status === "pending" || status === "denied" ? status : "failed";
    },
  };
}

/** An approval's id at the proxy: a hash, so the signed approval itself never leaves this server. */
export async function approvalId(proof: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
