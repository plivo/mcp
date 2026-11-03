import { operations, type Operation } from "./catalog";

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "my", "me", "i", "all", "with",
  "by", "from", "is", "are", "be", "it", "this", "that", "please", "plivo", "api", "how", "do",
  "can", "what", "which", "some", "any",
]);

// Words people use that the docs spell differently. Values are stems, as tokenize produces them.
const SYNONYMS: Record<string, string[]> = {
  sms: ["message"], text: ["message"], mms: ["message"], whatsapp: ["message"],
  phone: ["number"], did: ["number"], buy: ["rent", "phonenumber"], purchase: ["rent", "phonenumber"],
  hangup: ["hang", "delete"], end: ["hang", "delete"], dial: ["call"],
  show: ["retrieve", "list"], get: ["retrieve"], fetch: ["retrieve"], find: ["search", "list"],
  remove: ["delete"], cancel: ["delete"], edit: ["update"], change: ["update"], modify: ["update"],
  new: ["create"], add: ["create", "add"], make: ["create", "make"], start: ["start", "create"],
  sip: ["zentrunk", "endpoint", "trunk"], trunk: ["zentrunk", "trunk"], otp: ["verify", "session"],
  recording: ["record"], conference: ["conference"], agent: ["agentflow"],
};

/** Lowercases, splits camelCase path words (PhoneNumber → phone number) and strips a plural s. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

interface Indexed {
  op: Operation;
  fields: { weight: number; tokens: Set<string> }[];
}

const index: Indexed[] = operations.map((op) => ({
  op,
  fields: [
    { weight: 3, tokens: new Set(tokenize(op.title)) },
    { weight: 2, tokens: new Set(tokenize(`${op.section ?? ""} ${op.path.replace(/\{[^}]+\}/g, " ")}`)) },
    { weight: 1, tokens: new Set(tokenize(`${op.group} ${op.description ?? ""}`)) },
    { weight: 0.5, tokens: new Set(tokenize(op.params.map((p) => p.name).join(" "))) },
  ],
}));

const VERB_METHOD: Record<string, string> = {
  list: "GET", retrieve: "GET", search: "GET", create: "POST", send: "POST", make: "POST",
  update: "POST", delete: "DELETE", hang: "DELETE",
};

export interface SearchHit {
  id: string;
  title: string;
  method: string;
  path: string;
  group: string;
  costs_money: boolean;
  destructive: boolean;
}

export function searchOperations(query: string, limit: number): SearchHit[] {
  const words = tokenize(query);
  const terms = new Set(words.flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]));
  if (terms.size === 0) return [];
  const wantMethods = new Set(words.map((w) => VERB_METHOD[w]).filter(Boolean));

  const scored = index
    .map(({ op, fields }) => {
      let score = 0;
      for (const term of terms) {
        let best = 0;
        for (const f of fields) if (f.tokens.has(term)) best = Math.max(best, f.weight);
        score += best;
      }
      if (score > 0 && wantMethods.has(op.method)) score += 1;
      return { op, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.op.id.localeCompare(b.op.id));

  return scored.slice(0, limit).map(({ op }) => ({
    id: op.id,
    title: op.title,
    method: op.method,
    path: op.path,
    group: op.group,
    costs_money: op.costs_money,
    destructive: op.destructive,
  }));
}
