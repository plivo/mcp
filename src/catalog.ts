import data from "../catalog/catalog.json";

export interface Param {
  name: string;
  in: string;
  type: string;
  required?: boolean;
  deprecated?: boolean;
  default?: string;
  description?: string;
  items?: Param[];
}

export interface Operation {
  id: string;
  method: string;
  path: string;
  fixed_query?: Record<string, string>;
  title: string;
  section?: string;
  description?: string;
  group: string;
  docs_url: string;
  path_params?: Param[];
  params: Param[];
  module: string;
  costs_money: boolean;
  destructive: boolean;
}

interface Catalog {
  schema: number;
  operations: Operation[];
}

const catalog = data as Catalog;
if (catalog.schema !== 1) {
  throw new Error(`catalog schema ${catalog.schema} is not supported`);
}

export const operations: readonly Operation[] = catalog.operations;

const byId = new Map(operations.map((op) => [op.id, op]));

export function getOperation(id: string): Operation | undefined {
  return byId.get(id);
}

const VARIANT_RE = /^(.+)__(gt|gte|lt|lte)$/;
const VARIANT_WORDS: Record<string, string> = { gt: "greater than", gte: "greater than or equal to", lt: "less than", lte: "less than or equal to" };

/** A documented param, or a range variant its base param's docs name (e.g. "Supports variants: `end_time__gt`"). */
export function findParam(op: Operation, name: string): Param | undefined {
  const own = op.params.find((p) => p.name === name);
  if (own) return own;
  const m = VARIANT_RE.exec(name);
  const base = m ? op.params.find((p) => p.name === m[1]) : undefined;
  if (!m || !base?.description?.includes(`\`${name}\``)) return undefined;
  return { ...base, name, required: false, description: `${base.name} ${VARIANT_WORDS[m[2]]} this value. ${base.description}` };
}
