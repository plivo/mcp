import { cleanName } from "./oauth";
import { parsePermissions, type Permissions } from "./permissions";
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
}

const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const REGION_RE = /^[a-z0-9-]{1,32}$/;

function organization(v: unknown, current = false): Organization | undefined {
  const o = record(v);
  if (typeof o.auth_id !== "string" || !AUTH_ID_RE.test(o.auth_id)) return undefined;
  // The name is chosen by whoever administers that organization, and ends up in approvals and in front of the model.
  return { auth_id: o.auth_id, name: cleanName(o.name), ...(typeof o.region === "string" && REGION_RE.test(o.region) ? { region: o.region } : {}), current };
}

const route = (apiBase: string, name: string) => `${apiBase.replace(/\/+$/, "")}/mcp/${name}`;

/** The switch as a request, so the approval machinery can bind an approval to it. */
export function switchRequest(apiBase: string, authId: string): BuiltRequest {
  return { url: route(apiBase, "organization"), method: "POST", body: JSON.stringify({ auth_id: authId }), warnings: [] };
}

export const NOT_ALLOWED = "Nothing was changed: that is not one of the organizations allowed at sign-in. Sign in again to change the list.";

function failure(res: UpstreamResult, what: string): OrgFailure {
  const errors = record(record(res.body).errors);
  // A plain tool error: a new sign-in is the user's choice here, not a challenge the client should act on by itself.
  if (res.status === 403 && errors.error === "organization_not_allowed") return { error: NOT_ALLOWED };
  if (res.status === 404) return { error: "Switching organizations is not available on this Plivo server yet." };
  const why = typeof errors.global_error === "string" ? `: ${errors.global_error}` : "";
  return { error: `${what} (HTTP ${res.status})${why}.`, tokenRejected: res.tokenRejected };
}

export async function listOrganizations(
  cred: Credential,
  apiBase: string,
  fetchImpl?: typeof fetch,
  timeoutMs?: number,
): Promise<{ organizations: Organization[]; permissions?: Permissions } | OrgFailure> {
  let res: UpstreamResult;
  try {
    res = await callUpstream({ url: route(apiBase, "organizations"), method: "GET", warnings: [] }, cred, fetchImpl, timeoutMs);
  } catch {
    return { error: "Plivo could not be reached to list the organizations." };
  }
  if (!res.ok) return failure(res, "Plivo could not list the organizations");
  const data = record(record(res.body).data);
  const raw = data.organizations;
  if (!Array.isArray(raw)) return { error: "Plivo's list of organizations could not be read." };
  const permissions = parsePermissions(data.permissions);
  return { organizations: raw.flatMap((v) => organization(v, record(v).current === true) ?? []), ...(permissions ? { permissions } : {}) };
}

const UNCONFIRMED = "The switch could not be confirmed. Call list_organizations to see which organization this connection is on.";

export async function switchOrganization(req: BuiltRequest, cred: Credential, fetchImpl?: typeof fetch): Promise<Organization | OrgFailure> {
  let res: UpstreamResult;
  try {
    res = await callUpstream(req, cred, fetchImpl);
  } catch {
    return { error: UNCONFIRMED };
  }
  // A gateway can fail after the auth proxy has already moved the connection.
  if (res.status >= 500) return { error: UNCONFIRMED };
  if (!res.ok) return failure(res, "Nothing was changed: Plivo could not switch organization");
  const now = organization(record(res.body).data, true);
  return now && req.body === JSON.stringify({ auth_id: now.auth_id }) ? now : { error: UNCONFIRMED };
}
