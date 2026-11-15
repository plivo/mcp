import { AUTH_ID_RE, callUpstream, type BuiltRequest, type Credential, type UpstreamResult } from "./upstream";

export interface Organization {
  auth_id: string;
  name: string;
  region?: string;
  current: boolean;
}

export interface OrgFailure {
  error: string;
  tokenRejected?: boolean;
  scopeMissing?: boolean;
}

const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// The only two readers of the auth proxy's bodies for these routes. Its envelope is read loosely: the payload at the
// top level or under `data`, the refusal code beside or inside `errors` / `error`.
function payload(body: unknown): Record<string, unknown> {
  const b = record(body);
  return Array.isArray(b.organizations) ? b : record(b.data);
}
function notAllowed(res: UpstreamResult): boolean {
  const b = record(res.body);
  return res.status === 403 && [b, record(b.errors), record(b.error), record(b.data)].some((o) => o.error === "organization_not_allowed");
}

const route = (apiBase: string, name: string) => `${apiBase.replace(/\/+$/, "")}/mcp/${name}`;

/** The switch as a request, so the approval machinery can bind an approval to it. */
export function switchRequest(apiBase: string, authId: string): BuiltRequest {
  return { url: route(apiBase, "organization"), method: "POST", body: JSON.stringify({ auth_id: authId }), warnings: [] };
}

export const NOT_ALLOWED = "Nothing was changed: that is not one of the organizations allowed at sign-in. Sign in again to change the list.";

function failure(res: UpstreamResult, doing: string): OrgFailure {
  // A plain tool error: a new sign-in is the user's choice here, not a challenge the client should act on by itself.
  if (notAllowed(res)) return { error: NOT_ALLOWED };
  if (res.status === 404) return { error: "Switching organizations is not available on this Plivo server yet." };
  return { error: `Nothing was changed: Plivo could not ${doing} (HTTP ${res.status}).`, tokenRejected: res.tokenRejected, scopeMissing: res.scopeMissing };
}

export async function listOrganizations(cred: Credential, apiBase: string, fetchImpl?: typeof fetch): Promise<{ organizations: Organization[] } | OrgFailure> {
  let res: UpstreamResult;
  try {
    res = await callUpstream({ url: route(apiBase, "organizations"), method: "GET", warnings: [] }, cred, fetchImpl);
  } catch {
    return { error: "Nothing was changed: Plivo could not be reached to list the organizations." };
  }
  if (!res.ok) return failure(res, "list the organizations");
  const raw = payload(res.body).organizations;
  if (!Array.isArray(raw)) return { error: "Nothing was changed: Plivo's list of organizations could not be read." };
  const organizations = raw.map(record).flatMap((o): Organization[] =>
    typeof o.auth_id === "string" && AUTH_ID_RE.test(o.auth_id)
      ? [{ auth_id: o.auth_id, name: typeof o.name === "string" ? o.name : "", ...(typeof o.region === "string" ? { region: o.region } : {}), current: o.current === true }]
      : [],
  );
  return { organizations };
}

export async function switchOrganization(req: BuiltRequest, cred: Credential, fetchImpl?: typeof fetch): Promise<{ ok: true } | OrgFailure> {
  let res: UpstreamResult;
  try {
    res = await callUpstream(req, cred, fetchImpl);
  } catch {
    return { error: "The switch could not be confirmed. Call switch_organization with no arguments to see which organization this connection is on." };
  }
  return res.ok ? { ok: true } : failure(res, "switch organization");
}
