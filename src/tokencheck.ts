import { getOperation } from "./catalog";
import { buildRequest, callUpstream, type Credential } from "./upstream";

const VALID_FOR_MS = 60_000;
const MAX_CACHED = 1000;
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Asks the auth proxy whether it still accepts a token. The answer is false only when the proxy refuses the token
 * itself: if it cannot be asked the request goes on, since every tool call that reaches Plivo is checked again.
 */
export function createTokenCheck() {
  // Keyed by a hash, so the isolate holds no token after its request. Only acceptances are kept.
  const acceptedUntil = new Map<string, number>();
  return async (cred: Credential, apiBase: string, fetchImpl?: typeof fetch): Promise<boolean> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cred.authorization));
    const key = String.fromCharCode(...new Uint8Array(digest));
    if ((acceptedUntil.get(key) ?? 0) > Date.now()) return true;
    // The account read: the cheapest route on the proxy's allow-list, which it checks before it looks at the token.
    const req = buildRequest(getOperation("GET /")!, {}, cred, apiBase);
    if ("error" in req) return true;
    try {
      const res = await callUpstream(req, cred, fetchImpl, PROBE_TIMEOUT_MS);
      if (res.tokenRejected) return false;
      // A token without the account module was still accepted as a token.
      if (res.ok || res.scopeMissing || res.notGranted !== undefined) {
        acceptedUntil.delete(key);
        if (acceptedUntil.size >= MAX_CACHED) acceptedUntil.delete(acceptedUntil.keys().next().value!);
        acceptedUntil.set(key, Date.now() + VALID_FOR_MS);
      }
    } catch {
      // Unreachable or timed out: not an answer about the token.
    }
    return true;
  };
}
