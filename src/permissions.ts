import { operations } from "./catalog";

/** What the user left this connection at sign-in, as the auth proxy reports it. */
export interface Permissions {
  limited: boolean;
  modules: string[];
}

// Our words for the auth proxy's permission ids, so its own text never reaches the model.
const NAMES: Readonly<Record<string, string>> = {
  "account.read": "View account details and usage",
  "account.write": "Change account details",
  "number.read": "View and search phone numbers",
  "number.write": "Buy, change and release phone numbers",
  "message.read": "View messages, Powerpacks and messaging registrations",
  "message.send": "Send messages",
  "message.write": "Manage Powerpacks and messaging registrations",
  "call.read": "View calls, conferences and recordings",
  "call.make": "Make and control calls and conferences",
  "application.read": "View applications and SIP endpoints",
  "application.write": "Change applications and SIP endpoints",
  "sip.read": "View SIP trunks",
  "sip.write": "Change SIP trunks",
  "verify.read": "View Verify sessions",
  "verify.write": "Start and check Verify sessions",
  "agent.read": "View AI agents",
  "agent.write": "Change AI agents",
};

for (const op of operations) {
  if (!Object.hasOwn(NAMES, op.module)) throw new Error(`permission ${op.module} of ${op.id} has no plain name`);
}

const RECONNECT =
  "the user reconnects the Plivo server in their app (removes it and adds it again) and switches that permission on at the Plivo sign-in screen";

export function parsePermissions(v: unknown): Permissions | undefined {
  const p = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  if (typeof p.limited !== "boolean" || !Array.isArray(p.modules) || !p.modules.every((m) => typeof m === "string")) return undefined;
  return { limited: p.limited, modules: p.modules as string[] };
}

/** The module a 403 from the auth proxy names as one the user chose not to grant; an older token's refusal carries no such code. */
export function notGrantedModule(status: number, body: unknown): string | undefined {
  const errors = (body as { errors?: { error?: unknown; required_module?: unknown } } | null)?.errors;
  return status === 403 && errors?.error === "permission_not_granted" && typeof errors.required_module === "string" ? errors.required_module : undefined;
}

/** The refusal a model relays. The module id comes from another system, so only a known one is named, by our own words. */
export function notGranted(module: string): string {
  const which = Object.hasOwn(NAMES, module) ? `the "${NAMES[module]}" permission` : "the permission this action needs";
  return `Nothing was done: this connection was not given ${which} at sign-in. To allow it, ${RECONNECT}. Do not retry before that.`;
}

export function describePermissions(p: Permissions) {
  if (!p.limited) return { access: "full" };
  const named = (granted: boolean) => Object.keys(NAMES).filter((m) => p.modules.includes(m) === granted).map((m) => NAMES[m]);
  return { access: "limited", allowed: named(true), not_allowed: named(false), note: `Chosen at sign-in, for every organization. To change it, ${RECONNECT}.` };
}

export const permits = (p: Permissions | undefined, module: string) => !p?.limited || p.modules.includes(module);
