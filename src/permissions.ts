import { operations } from "./catalog";

/** What the user left this connection at sign-in, as the auth proxy reports it. */
export interface Permissions {
  limited: boolean;
  modules: string[];
}

// The sign-in screen's areas and levels, so a refusal tells the user which setting to change. The read module comes first.
const AREAS: readonly { name: string; modules: readonly string[] }[] = [
  { name: "Account", modules: ["account.read", "account.write"] },
  { name: "Phone numbers", modules: ["number.read", "number.write"] },
  { name: "Messages", modules: ["message.read", "message.send", "message.write"] },
  { name: "Calls", modules: ["call.read", "call.make"] },
  { name: "Applications and endpoints", modules: ["application.read", "application.write"] },
  { name: "SIP trunks", modules: ["sip.read", "sip.write"] },
  { name: "Verify", modules: ["verify.read", "verify.write"] },
  { name: "AI agents", modules: ["agent.read", "agent.write"] },
];
const READ_ONLY = "Read-only";
const READ_WRITE = "Read and write";

// For a token whose modules fit none of the screen's levels; the auth proxy accepts such a set.
const NAMES: Readonly<Record<string, string>> = {
  "account.read": "view account details and usage",
  "account.write": "change account details",
  "number.read": "view and search phone numbers",
  "number.write": "buy, change and release phone numbers",
  "message.read": "view messages, Powerpacks and messaging registrations",
  "message.send": "send messages",
  "message.write": "manage Powerpacks and messaging registrations",
  "call.read": "view calls, conferences and recordings",
  "call.make": "make and control calls and conferences",
  "application.read": "view applications and SIP endpoints",
  "application.write": "change applications and SIP endpoints",
  "sip.read": "view SIP trunks",
  "sip.write": "change SIP trunks",
  "verify.read": "view Verify sessions",
  "verify.write": "start and check Verify sessions",
  "agent.read": "view AI agents",
  "agent.write": "change AI agents",
};

const areaOf = (module: string) => AREAS.find((a) => a.modules.includes(module));

for (const op of operations) {
  if (!areaOf(op.module) || !Object.hasOwn(NAMES, op.module)) throw new Error(`permission ${op.module} of ${op.id} has no area or plain name`);
}

const RECONNECT = "the user reconnects the Plivo server in their app (removes it and adds it again) and, in the Access field of the Plivo sign-in screen,";

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
  const area = areaOf(module);
  if (!area) return `Nothing was done: this connection was not given the access this action needs at sign-in. To allow it, ${RECONNECT} gives it more access. Do not retry before that.`;
  const need = module === area.modules[0] ? `${READ_ONLY} or ${READ_WRITE}` : READ_WRITE;
  return `Nothing was done: this action needs ${area.name} set to ${need}, which this connection was not given at sign-in. To allow it, ${RECONNECT} sets ${area.name} to ${need}. Do not retry before that.`;
}

function level(area: (typeof AREAS)[number], granted: string[]): string {
  const have = area.modules.filter((m) => granted.includes(m));
  if (have.length === 0) return "No access";
  if (have.length === area.modules.length) return READ_WRITE;
  return have.length === 1 && have[0] === area.modules[0] ? READ_ONLY : `Only: ${have.map((m) => NAMES[m]).join("; ")}`;
}

export function describePermissions(p: Permissions) {
  if (!p.limited) return { access: "full" };
  return {
    access: "limited",
    areas: Object.fromEntries(AREAS.map((a) => [a.name, level(a, p.modules)])),
    note: `Chosen at sign-in, for every organization. To change it, ${RECONNECT} sets each area's level.`,
  };
}

export const permits = (p: Permissions | undefined, module: string) => !p?.limited || p.modules.includes(module);
