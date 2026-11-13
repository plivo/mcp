import type { Operation } from "./catalog";
import type { CallArgs } from "./upstream";

// One approval must not reach a crowd: Plivo takes up to 1,000 destinations in one `to`.
export const MAX_DESTINATIONS = 10;

const E164 = /^\+?[1-9]\d{6,14}$/;
const SIP = /^sip:[^\s<>]+$/i;
// Sender IDs also come as short codes and alphanumeric names.
const SENDER = /^\+?[A-Za-z0-9 ]{1,15}$/;

type Kind = "number" | "numberOrSip" | "sender";
const LOOKS: Record<Kind, [RegExp[], string]> = {
  number: [[E164], "a phone number in E.164 format, e.g. 14155550100"],
  numberOrSip: [[E164, SIP], "a phone number in E.164 format or a sip: URI"],
  sender: [[SENDER], "a phone number, short code or alphanumeric sender ID"],
};

/** Body params that hold phone numbers, `<`-separated where Plivo takes several. Whether the account owns one is Plivo's check. */
const NUMBER_PARAMS: Readonly<Record<string, Record<string, Kind>>> = {
  "POST /Message/": { dst: "number", src: "sender" },
  "POST /Call/": { to: "numberOrSip", from: "numberOrSip" },
  "POST /MultiPartyCall/name_{mpc_name}/Participant/": { to: "numberOrSip", from: "numberOrSip" },
  "POST /Masking/Session/": { first_party: "number", second_party: "number" },
  "POST /TollfreeVerification/": { number: "number" },
  "POST /10dlc/Campaign/{campaign_id}/Number/": { numbers: "number" },
};
const CAPPED: Readonly<Record<string, string>> = { "POST /Message/": "dst", "POST /Call/": "to" };

const URL_PARAM = /^(url|urls|media_urls|.+_urls?)$/;
const SCHEME: Readonly<Record<string, string>> = { service_url: "wss:" };

function privateV4(host: string): boolean {
  const p = host.split(".").map(Number);
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && p[2] === 0))) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Why Plivo's platform must not be pointed at this URL, or undefined. The URL parser has already normalised odd IP spellings. */
function urlError(name: string, raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `${name} is not a valid URL`;
  }
  const scheme = SCHEME[name] ?? "https:";
  if (u.protocol !== scheme) return `${name} must start with ${scheme}//`;
  if (u.username || u.password) return `${name} must not carry a username or password`;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const internal = `${name} must point at a public host, not an internal address`;
  if (host.startsWith("[")) {
    // Only global unicast (2000::/3) is public; loopback, link-local, unique-local and v4-mapped forms all fall outside it.
    return /^\[[23][0-9a-f]{3}:/.test(host) ? undefined : internal;
  }
  if (/^\d+(\.\d+){3}$/.test(host)) return privateV4(host) ? internal : undefined;
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host)) return internal;
  return undefined;
}

function list(v: unknown, sep: string): string[] | undefined {
  if (typeof v === "string") return v.split(sep).map((s) => s.trim());
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}

/**
 * Why a write is refused before the user is asked to approve it: a value that cannot be a phone number or a
 * public URL, or more destinations than one approval may reach. Plivo still validates everything else.
 */
export function inputError(op: Operation, args: CallArgs): string | undefined {
  const params = args.params ?? {};
  const number = args.path_params?.number;
  if (number !== undefined && !E164.test(String(number))) return `number must be ${LOOKS.number[1]}; got ${JSON.stringify(number)}`;

  for (const [name, kind] of Object.entries(NUMBER_PARAMS[op.id] ?? {})) {
    const values = list(params[name], "<");
    if (!values) continue;
    const [patterns, what] = LOOKS[kind];
    const bad = values.find((v) => !patterns.some((re) => re.test(v)));
    if (bad !== undefined) return `${name} must be ${what}; got ${JSON.stringify(bad)}`;
    if (CAPPED[op.id] === name && values.length > MAX_DESTINATIONS) {
      return (
        `${name} has ${values.length} destinations; one request through this server may reach at most ${MAX_DESTINATIONS}. ` +
        "Split it into smaller requests, or use the Plivo API or console for bulk sends."
      );
    }
  }

  for (const [name, v] of Object.entries(params)) {
    if (!URL_PARAM.test(name)) continue;
    for (const raw of list(v, ",") ?? []) {
      if (raw === "") continue;
      const err = urlError(name, raw);
      if (err) return `${err}; got ${JSON.stringify(raw)}`;
    }
  }
  return undefined;
}
