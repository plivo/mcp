import type { Operation } from "./catalog";
import { SPEAK_OP, speakError } from "./speech";
import { HIDDEN, pairName, secretNamed, type CallArgs } from "./upstream";

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
const CAPPED: Readonly<Record<string, string>> = {
  "POST /Message/": "dst",
  "POST /Call/": "to",
  "POST /MultiPartyCall/name_{mpc_name}/Participant/": "to",
};

const URL_PARAM = /^(url|urls|media_urls|.+_urls?)$/;
// Plivo documents urls, media_urls and optin_image_url as comma-separated; any other holds one URL, whose query may have a comma.
const URL_LIST_PARAM = /^(.*urls|optin_image_url)$/;
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

function internalHost(u: URL): boolean {
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    // Only global unicast (2000::/3) is public; loopback, link-local, unique-local and v4-mapped forms all fall outside it.
    // 6to4 (2002::/16) and Teredo (2001:0::/32) sit inside it and carry an IPv4 address of their own.
    return !/^\[[23][0-9a-f]{3}:/.test(host) || /^\[(2002:|2001:(0:|:))/.test(host);
  }
  if (/^\d+(\.\d+){3}$/.test(host)) return privateV4(host);
  return !host.includes(".") || /(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host);
}

const INTERNAL = "must point at a public host, not an internal address";

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
  return internalHost(u) ? `${name} ${INTERNAL}` : undefined;
}

const TEMPLATED = /[{}]|%7[bd]/iu;

/** The host of a nested URL, or undefined where it is a template filled in when an agent runs: there is no address to judge yet. */
function nestedHost(text: string): URL | "invalid" | undefined {
  try {
    const u = new URL(text);
    return TEMPLATED.test(u.hostname) ? undefined : u;
  } catch {
    // A template elsewhere, such as the port, fails the parse; the host alone still has to be public.
    const host = /^[a-z]+:[\\/]*([^\\/?#]*)/iu.exec(text)![1].split("@").pop()!.replace(/:[^\]:]*$/u, "");
    if (TEMPLATED.test(host)) return undefined;
    try {
      return new URL(`https://${host}/`);
    } catch {
      return "invalid";
    }
  }
}

/**
 * Why a structured param is refused: a URL to an internal host inside it, under any field name, since Plivo fetches
 * media, template and agent-node URLs wherever they sit. The scheme is Plivo's to judge, and text that only mentions a URL is not one.
 */
function nestedUrlError(v: unknown, at: string, depth = 0): string | undefined {
  if (depth > 50) return `${at} is nested too deeply to check`;
  if (typeof v === "string") {
    // What a URL parser drops before reading: tabs and newlines anywhere, controls and spaces at the ends.
    const text = v.replace(/[\t\n\r]/gu, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/gu, "");
    if (/^[[{]/u.test(text)) {
      try {
        return nestedUrlError(JSON.parse(text), at, depth + 1);
      } catch {
        return undefined;
      }
    }
    if (!/^(https?|wss?):/iu.test(text)) return undefined;
    const u = nestedHost(text);
    if (u === "invalid") return `${at} is not a valid URL; got ${JSON.stringify(v)}`;
    return u && internalHost(u) ? `${at} ${INTERNAL}; got ${JSON.stringify(v)}` : undefined;
  }
  if (v === null || typeof v !== "object") return undefined;
  for (const [k, x] of Object.entries(v)) {
    const err = nestedUrlError(x, Array.isArray(v) ? `${at}[${k}]` : `${at}.${k}`, depth + 1);
    if (err) return err;
  }
  return undefined;
}

/** The values to check: empty for an absent one, undefined for a shape that could carry them past the checks. */
function list(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return [v];
  // Checked as its digits: a number could otherwise carry destinations past the format check and the cap.
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v.map(String);
  return undefined;
}

/** The secret-named field under which a write carries the marker this server puts in replies, which is no credential. */
function hiddenMarkerUnder(v: unknown, under?: string, depth = 0): string | undefined {
  if (depth > 50) return undefined;
  if (typeof v === "string") {
    if (under !== undefined && v.toLowerCase().includes(HIDDEN)) return under;
    if (!/^\s*[[{]/u.test(v)) return undefined;
    try {
      return hiddenMarkerUnder(JSON.parse(v), under, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (v === null || typeof v !== "object") return undefined;
  if (Array.isArray(v)) return v.map((x) => hiddenMarkerUnder(x, under, depth + 1)).find(Boolean);
  const fields = Object.entries(v);
  const name = pairName(fields);
  return fields
    .map(([k, x]) => hiddenMarkerUnder(x, under ?? (secretNamed(k) ? k : /^value$/iu.test(k) ? name : undefined), depth + 1))
    .find(Boolean);
}

const split = (values: string[], sep: string) => values.flatMap((v) => v.split(sep).map((s) => s.trim()));

/**
 * Why a write is refused before the user is asked to approve it: a value that cannot be a phone number or a
 * public URL, or more destinations than one approval may reach. Plivo still validates everything else.
 */
export function inputError(op: Operation, args: CallArgs): string | undefined {
  const params = args.params ?? {};
  const number = args.path_params?.number;
  if (number !== undefined && !E164.test(String(number))) return `number must be ${LOOKS.number[1]}; got ${JSON.stringify(number)}`;

  const marked = hiddenMarkerUnder(params);
  if (marked) return `${marked} holds "${HIDDEN}", which this server put in place of the real value in a reply; supply the real value, or leave the field out`;

  if (op.id === SPEAK_OP) {
    const refused = speakError(params);
    if (refused) return refused;
  }

  // Plivo would split the destinations on it, and the count below on "<" would be wrong.
  if (CAPPED[op.id] && params.delimiter != null) return 'delimiter is not accepted through this server; separate destinations with "<"';

  for (const [name, kind] of Object.entries(NUMBER_PARAMS[op.id] ?? {})) {
    const given = list(params[name]);
    if (!given) return `${name} must be a string or a list of strings`;
    const values = Array.isArray(params[name]) ? given : split(given, "<");
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
    if (!URL_PARAM.test(name)) {
      const err = typeof v === "object" || (typeof v === "string" && /^\s*[[{]/u.test(v)) ? nestedUrlError(v, name) : undefined;
      if (err) return err;
      continue;
    }
    const urls = list(v);
    if (!urls) return `${name} must be a URL or a list of URLs`;
    for (const raw of URL_LIST_PARAM.test(name) ? split(urls, ",") : urls) {
      if (raw === "") continue;
      const err = urlError(name, raw);
      if (err) return `${err}; got ${JSON.stringify(raw)}`;
    }
  }
  return undefined;
}
