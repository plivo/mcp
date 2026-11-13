// Compares the rebuilt catalog with the committed one.
//   node catalog-refresh.mjs check  exits 0 when the rebuild changed something worth a PR, 10 when not
//   node catalog-refresh.mjs body   prints the PR description
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const before = (file) => git("show", `HEAD:catalog/${file}`);
const after = (file) => readFileSync(`catalog/${file}`, "utf8");

const oldCat = JSON.parse(before("catalog.json"));
const newCat = JSON.parse(after("catalog.json"));
const withoutSources = (cat) => JSON.stringify({ ...cat, sources: null });
// The sources lines name the docs sha and CLI commit, which move every week whether or not anything else does.
const reviewBody = (text) => text.split("\n").filter((l) => !/^- (Docs|CLI): /.test(l)).join("\n");
const routesChanged = before("proxy-routes.json") !== after("proxy-routes.json");

function meaningful() {
  return (
    routesChanged ||
    withoutSources(oldCat) !== withoutSources(newCat) ||
    before("docs.json") !== after("docs.json") ||
    reviewBody(before("REVIEW.md")) !== reviewBody(after("REVIEW.md"))
  );
}

function cliOnly(review) {
  const start = review.indexOf("## CLI calls with no docs entry");
  if (start < 0) return new Set();
  const section = review.slice(start).split("\n## ")[0];
  return new Set(section.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).split("  (")[0]));
}

const list = (items) => (items.length ? items.map((i) => `  - ${i}`).join("\n") : "  - none");

function body() {
  const oldOps = new Map(oldCat.operations.map((o) => [o.id, o]));
  const newOps = new Map(newCat.operations.map((o) => [o.id, o]));
  const added = [...newOps.keys()].filter((id) => !oldOps.has(id)).map((id) => `\`${id}\` ${newOps.get(id).title}`);
  const removed = [...oldOps.keys()].filter((id) => !newOps.has(id)).map((id) => `\`${id}\` ${oldOps.get(id).title}`);
  const changed = [...newOps.keys()]
    .filter((id) => oldOps.has(id) && JSON.stringify(oldOps.get(id)) !== JSON.stringify(newOps.get(id)))
    .map((id) => {
      const o = oldOps.get(id);
      const n = newOps.get(id);
      const fields = Object.keys({ ...o, ...n }).filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
      return `\`${id}\` (${fields.join(", ")})`;
    });
  const opsChanged = added.length + removed.length + changed.length > 0;

  const oldCli = cliOnly(before("REVIEW.md"));
  const newCli = cliOnly(after("REVIEW.md"));
  const sections = (text) => JSON.parse(text).chunks.length.toLocaleString("en-US");

  const numstat = git("diff", "--numstat", "--", "catalog/").trim().split("\n").filter(Boolean);
  const plus = numstat.reduce((s, l) => s + Number(l.split("\t")[0]), 0);
  const minus = numstat.reduce((s, l) => s + Number(l.split("\t")[1]), 0);

  const short = (sha) => sha.slice(0, 12);
  const out = [];
  out.push("## Size", "", "| | files | +lines | -lines |", "|---|---|---|---|");
  out.push(`| Generated (catalog rebuild) | ${numstat.length} | ${plus} | ${minus} |`);
  out.push(`| **Total** | **${numstat.length}** | **${plus}** | **${minus}** |`, "");
  const docsNote = numstat.some((l) => l.endsWith("catalog/docs.json"))
    ? " `docs.json` is a single line, so its 1/1 hides the size of a search-index change."
    : "";
  out.push(`No test lines: this PR only regenerates catalog files, and the run below tested them.${docsNote}`, "");
  if (routesChanged) {
    out.push("> **`proxy-routes.json` changed: copy `catalog/proxy-routes.json` to plivocx/hodor `config/mcpProxyRoutes.json` and deploy hodor BEFORE deploying the Worker.**", "");
  }
  out.push("## What", "", "Weekly rebuild of the MCP catalog from today's Plivo docs and plivo-cli. Nothing is deployed.", "");
  out.push(`- Operations: ${oldCat.operations.length} → ${newCat.operations.length}`);
  out.push("- Added:", list(added), "- Removed:", list(removed), "- Changed:", list(changed));
  out.push(`- Search index: ${sections(before("docs.json"))} → ${sections(after("docs.json"))} sections`);
  out.push("- New CLI calls the docs don't describe (not reachable from the MCP until added to `extra_ops`):");
  out.push(list([...newCli].filter((c) => !oldCli.has(c)).map((c) => `\`${c}\``)));
  out.push("- CLI calls no longer made:", list([...oldCli].filter((c) => !newCli.has(c)).map((c) => `\`${c}\``)), "");
  out.push("## Why", "", "The Worker serves the catalog built at merge time, so docs and CLI changes reach it only through a rebuild.", "");
  out.push("## How", "", "`npm run catalog` on:");
  out.push(`- docs.plivo.com \`llms-full.txt\` sha256 \`${short(newCat.sources.docs_sha256)}\` (was \`${short(oldCat.sources.docs_sha256)}\`)`);
  out.push(`- plivo-cli \`${short(newCat.sources.cli_commit)}\` (was \`${short(oldCat.sources.cli_commit)}\`)`, "");
  out.push("Read `catalog/REVIEW.md` in the diff for new exclusions, pricing to confirm and new scope modules before merging.", "");
  out.push("## Testing", "", `\`npm test\` and \`go test ./...\` in \`catalog/gen\` passed in [this run](${process.env.RUN_URL ?? "the workflow run"}). Not tested: a deploy.`, "");
  out.push("## Risk", "");
  out.push(opsChanged ? "Once the Worker is deployed, every MCP user sees the operation changes above." : "Low: no operation changes; tool behaviour stays the same.");
  out.push("The next weekly run rewrites this branch; push any fix to another branch.", "");
  out.push("**PRs:** none");
  out.push(
    routesChanged
      ? "**Merge/deploy:** copy `proxy-routes.json` to hodor and deploy hodor first, then merge this and deploy the Worker. Rollback: revert, or roll back the Worker version in Cloudflare."
      : "**Merge/deploy:** independent; deploy the Worker after merging. Rollback: revert, or roll back the Worker version in Cloudflare.",
  );
  out.push("", "Opened by the weekly catalog-refresh workflow.");
  return out.join("\n");
}

const mode = process.argv[2];
if (mode === "check") process.exit(meaningful() ? 0 : 10);
if (mode === "body") console.log(body());
else {
  console.error("usage: catalog-refresh.mjs check|body");
  process.exit(2);
}
