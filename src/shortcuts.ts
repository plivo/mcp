import * as z from "zod/v4";
import { findParam, getOperation, type Operation, type Param } from "./catalog";
import { confirmationCodeField } from "./confirm";
import type { CallArgs } from "./upstream";

export interface ShortcutDef {
  name: string;
  id: string;
  description: string;
  /**
   * Catalog params to expose, plus documented filter variants such as `end_time__gt`. Kept short on
   * purpose: the point of a shortcut is a small schema, and plivo_api_read/write still reach the rest.
   */
  params: string[];
  /** Shorter text for params whose docs description is long; every tools/list carries it. */
  describe?: Record<string, string>;
  /** Params of which at least one is needed, where the docs mark none of them required. */
  oneOf?: string[];
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  {
    name: "get_account",
    id: "GET /",
    description:
      "Get your Plivo account details: cash_credits (balance in USD), account_type (standard or developer), " +
      "billing_mode (prepaid or postpaid), auto_recharge, name, address, city, state, timezone and auth_id.",
    params: [],
  },
  {
    name: "list_numbers",
    id: "GET /Number/",
    description: "List the phone numbers on your account.",
    params: ["type", "number_startswith", "alias", "services", "subaccount", "limit", "offset"],
  },
  {
    name: "search_numbers",
    id: "GET /PhoneNumber/",
    description: "Search phone numbers available to buy in a country. Buy one with buy_number.",
    params: ["country_iso", "type", "pattern", "region", "city", "services", "npanxx", "limit", "offset"],
  },
  {
    name: "list_messages",
    id: "GET /Message/",
    description: "List sent and received messages.",
    params: [
      "message_direction",
      "message_state",
      "message_type",
      "message_time__gt",
      "message_time__lt",
      "error_code",
      "subaccount",
      "limit",
      "offset",
    ],
  },
  { name: "get_message", id: "GET /Message/{message_uuid}/", description: "Get one message by its UUID.", params: [] },
  {
    name: "list_calls",
    id: "GET /Call/",
    description:
      "List completed calls. With no end_time filter Plivo searches only the last 7 days; for any other period pass " +
      "end_time__gt and/or end_time__lt (a range of at most 30 days, within the last 90).",
    params: ["from_number", "to_number", "call_direction", "end_time__gt", "end_time__lt", "hangup_cause_code", "limit", "offset"],
  },
  { name: "get_call", id: "GET /Call/{call_uuid}/", description: "Get the record of one completed call by its UUID.", params: [] },
  {
    name: "send_sms",
    id: "POST /Message/",
    description: "Send an SMS, MMS or WhatsApp message, from a number (src) or a Powerpack (powerpack_uuid).",
    params: ["src", "powerpack_uuid", "dst", "text", "type", "media_urls", "url", "method"],
    oneOf: ["src", "powerpack_uuid"],
  },
  {
    name: "make_call",
    id: "POST /Call/",
    description: "Start an outbound call. answer_url must return Plivo XML that says what happens on the call.",
    params: ["from", "to", "answer_url", "answer_method", "hangup_url", "hangup_method", "caller_name", "time_limit", "ring_timeout", "machine_detection"],
  },
  {
    name: "buy_number",
    id: "POST /PhoneNumber/{number}/",
    description: "Buy a phone number found with search_numbers.",
    params: ["app_id", "cnam_lookup", "compliance_application_id", "subaccount"],
    describe: {
      compliance_application_id:
        "UUID of an accepted compliance application matching the number's country and type. Optional: without it, " +
        "Plivo attaches the most recent matching accepted application.",
      subaccount: "Auth ID of a subaccount to give the number to. A number that needs documents stays pending until they are approved.",
    },
  },
  { name: "hangup_call", id: "DELETE /Call/{call_uuid}/", description: "Hang up a live call or cancel a queued one.", params: [] },
];

export interface Shortcut {
  name: string;
  op: Operation;
  kind: "read" | "write";
  description: string;
  inputSchema: z.ZodObject;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint: boolean };
  toCall(args: Record<string, unknown>): CallArgs & { id: string; confirmation_code?: string };
}

function resolveParam(op: Operation, name: string): Param {
  const p = findParam(op, name);
  if (!p) throw new Error(`shortcut param ${op.id} ${name} is not in the catalog`);
  if (p.deprecated) throw new Error(`shortcut param ${op.id} ${name} is deprecated`);
  return p;
}

function field(p: Param, description = p.description, optional = !p.required): z.ZodType {
  let f: z.ZodType;
  switch (p.type) {
    case "string":
      f = optional ? z.string() : z.string().min(1);
      break;
    case "integer":
      f = z.number().int();
      break;
    case "boolean":
      f = z.boolean();
      break;
    case "array":
      f = z.array(z.string());
      break;
    case "object":
      f = z.record(z.string(), z.unknown());
      break;
    default:
      throw new Error(`no schema for param type "${p.type}" (${p.name})`);
  }
  if (optional) f = f.optional();
  return description ? f.describe(description) : f;
}

export function buildShortcuts(defs: ShortcutDef[]): Shortcut[] {
  const seen = new Set<string>();
  return defs.map((def) => {
    const op = getOperation(def.id);
    if (!op) throw new Error(`shortcut ${def.name}: ${def.id} is not in the catalog`);
    if (seen.has(def.name)) throw new Error(`shortcut ${def.name} is defined twice`);
    seen.add(def.name);

    const pathNames = (op.path_params ?? []).map((p) => p.name);
    const shape: Record<string, z.ZodType> = {};
    for (const p of op.path_params ?? []) {
      shape[p.name] = z.union([z.string().min(1), z.number()]).describe(p.description ?? `The ${p.name.replaceAll("_", " ")}.`);
    }
    const oneOf = def.oneOf ?? [];
    for (const name of [...Object.keys(def.describe ?? {}), ...oneOf]) {
      if (!def.params.includes(name)) throw new Error(`shortcut ${def.name}: ${name} is not one of its params`);
    }
    for (const name of def.params) {
      const p = resolveParam(op, name);
      shape[name] = field(p, def.describe?.[name] ?? p.description, !p.required || oneOf.includes(name));
    }
    const kind = op.method === "GET" ? "read" : "write";
    const confirmable = kind === "write" && (op.costs_money || op.destructive);
    if (confirmable) {
      if (shape.confirmation_code) throw new Error(`shortcut ${def.name}: confirmation_code clashes with a param`);
      shape.confirmation_code = confirmationCodeField;
    }

    const notes = [op.costs_money && "Costs money.", op.destructive && "Cannot be undone."].filter(Boolean).join(" ");
    const other = `For other options, use ${kind === "read" ? "plivo_api_read" : "plivo_api_write"} with id "${op.id}".`;
    return {
      name: def.name,
      op,
      kind,
      description: [def.description, notes, def.params.length ? other : ""].filter(Boolean).join(" "),
      // Strict, so a misspelt or unlisted param is reported to the model instead of silently dropped.
      inputSchema: oneOf.length
        ? z.strictObject(shape).refine((a) => oneOf.some((k) => a[k] !== undefined && a[k] !== ""), {
            message: `Pass ${oneOf.join(" or ")}.`,
          })
        : z.strictObject(shape),
      annotations:
        kind === "read"
          ? { readOnlyHint: true, openWorldHint: true }
          : { readOnlyHint: false, destructiveHint: op.destructive, openWorldHint: true },
      toCall(args) {
        const path_params: Record<string, string | number> = {};
        const params: Record<string, unknown> = {};
        let confirmation_code: string | undefined;
        for (const [k, v] of Object.entries(args)) {
          if (v === undefined) continue;
          if (confirmable && k === "confirmation_code") confirmation_code = v as string;
          else if (pathNames.includes(k)) path_params[k] = v as string | number;
          else params[k] = v;
        }
        return { id: op.id, path_params, params, confirmation_code };
      },
    };
  });
}

export const shortcuts: readonly Shortcut[] = buildShortcuts(SHORTCUT_DEFS);
