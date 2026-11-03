import data from "../catalog/docs.json";
import { tokenize } from "./search";

interface DocChunk {
  title: string;
  section?: string;
  url: string;
  text: string;
}

interface DocsIndex {
  schema: number;
  sources: { docs_url: string; docs_sha256: string };
  chunks: DocChunk[];
}

const docs = data as DocsIndex;
if (docs.schema !== 1) {
  throw new Error(`docs index schema ${docs.schema} is not supported`);
}

export const docsSources = docs.sources;

// BM25 over sections. Words in the page title or section heading count as several body words: a
// section headed "Speak" is about Speak, while a passing mention elsewhere is not.
const K1 = 1.2;
const B = 0.75;
const HEADING_WEIGHT = 3;
const MAX_HITS_PER_PAGE = 2;
const MAX_TEXT_CHARS = 2000;

interface Index {
  /** term → flat [chunk, weighted term frequency, chunk, frequency, …] */
  postings: Map<string, number[]>;
  lengths: Float64Array;
  avgLength: number;
}

let index: Index | undefined;

// Layout tags from the docs' HTML tables; XML tags such as <Speak> stay, since people search for them.
const TABLE_TAG = /<\/?(?:table|thead|tbody|tr|td|th|br|p|div|span|strong|em|a)\b[^>]*>/gi;

/** A light stem, applied alike to the docs and the query, so "forwarding" finds "forward". */
function terms(text: string): string[] {
  return tokenize(text.replace(TABLE_TAG, " ")).map((t) =>
    t.length > 5 && t.endsWith("ing") ? t.slice(0, -3) : t.length > 4 && t.endsWith("ed") ? t.slice(0, -2) : t,
  );
}

// Built on first use rather than at startup, so requests that never search the docs do not pay for it.
function buildIndex(): Index {
  const postings = new Map<string, number[]>();
  const lengths = new Float64Array(docs.chunks.length);
  let total = 0;
  docs.chunks.forEach((c, i) => {
    const tf = new Map<string, number>();
    for (const t of terms(`${c.title} ${c.section ?? ""}`)) tf.set(t, (tf.get(t) ?? 0) + HEADING_WEIGHT);
    const body = terms(c.text);
    for (const t of body) tf.set(t, (tf.get(t) ?? 0) + 1);
    lengths[i] = body.length;
    total += body.length;
    for (const [t, n] of tf) {
      let p = postings.get(t);
      if (!p) postings.set(t, (p = []));
      p.push(i, n);
    }
  });
  return { postings, lengths, avgLength: total / Math.max(1, docs.chunks.length) };
}

export interface DocHit {
  title: string;
  section?: string;
  url: string;
  text: string;
}

export function searchDocs(query: string, limit: number): DocHit[] {
  index ??= buildIndex();
  const { postings, lengths, avgLength } = index;
  const n = docs.chunks.length;
  const scores = new Map<number, number>();
  for (const term of new Set(terms(query))) {
    const p = postings.get(term);
    if (!p) continue;
    const df = p.length / 2;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (let k = 0; k < p.length; k += 2) {
      const i = p[k];
      const f = p[k + 1];
      const tf = (f * (K1 + 1)) / (f + K1 * (1 - B + (B * lengths[i]) / avgLength));
      scores.set(i, (scores.get(i) ?? 0) + idf * tf);
    }
  }

  const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const perPage = new Map<string, number>();
  const sections = new Set<string>();
  const hits: DocHit[] = [];
  for (const [i] of ranked) {
    const c = docs.chunks[i];
    // A long section is stored in parts; return only its best-matching part.
    const key = `${c.url}\n${c.title}\n${c.section ?? ""}`;
    const seen = perPage.get(c.url) ?? 0;
    if (seen >= MAX_HITS_PER_PAGE || sections.has(key)) continue;
    perPage.set(c.url, seen + 1);
    sections.add(key);
    const text = c.text.length > MAX_TEXT_CHARS ? `${c.text.slice(0, MAX_TEXT_CHARS)}\n… (section continues at ${c.url})` : c.text;
    hits.push({ title: c.title, ...(c.section ? { section: c.section } : {}), url: c.url, text });
    if (hits.length >= limit) break;
  }
  return hits;
}
