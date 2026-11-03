// Command gen builds catalog/catalog.json, the list of Plivo API operations the MCP server exposes.
//
// Inputs: the docs' llms-full.txt export (params, types, descriptions), a plivo-cli checkout (which
// endpoints to expose and which spend money), catalog/overrides.json (reviewed decisions) and,
// optionally, SDK inventories to cross-check param names.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	docsPath := flag.String("docs", "", "docs llms-full.txt snapshot")
	docsURL := flag.String("docs-url", "https://docs.plivo.com/docs/llms-full.txt", "where the snapshot came from")
	cliRoot := flag.String("cli", "", "plivo-cli checkout")
	overridesPath := flag.String("overrides", "catalog/overrides.json", "reviewed decisions")
	out := flag.String("out", "catalog/catalog.json", "catalog output")
	reviewOut := flag.String("review", "catalog/REVIEW.md", "review report output")
	docsIndexOut := flag.String("docs-index", "catalog/docs.json", "search_docs index output")
	var sdkPaths multiFlag
	flag.Var(&sdkPaths, "sdk", "SDK inventory JSON to cross-check param names (repeatable)")
	dumpDocs := flag.Bool("dump-docs", false, "print parsed docs ops as JSON and exit")
	dumpCLI := flag.Bool("dump-cli", false, "print the CLI inventory as JSON and exit")
	flag.Parse()

	if *dumpCLI {
		inv, err := ScanCLI(*cliRoot)
		check(err)
		printJSON(inv)
		return
	}
	raw, err := os.ReadFile(*docsPath)
	check(err)
	ops, anomalies := ParseDocs(string(raw))
	if *dumpDocs {
		printJSON(map[string]any{"ops": ops, "anomalies": anomalies})
		return
	}

	inv, err := ScanCLI(*cliRoot)
	check(err)
	var ov Overrides
	ovRaw, err := os.ReadFile(*overridesPath)
	check(err)
	dec := json.NewDecoder(bytes.NewReader(ovRaw))
	dec.DisallowUnknownFields()
	check(dec.Decode(&ov))
	var sdks []SDKEndpoint
	for _, p := range sdkPaths {
		eps, err := loadSDK(p)
		check(err)
		sdks = append(sdks, eps...)
	}

	cat, rv, err := Build(ops, anomalies, inv, &ov, sdks)
	check(err)
	sum := sha256.Sum256(raw)
	cat.Sources = Sources{
		DocsURL: *docsURL, DocsSHA256: hex.EncodeToString(sum[:]),
		CLIRepo: "github.com/plivo/plivo-cli", CLICommit: gitHead(*cliRoot),
	}

	writeJSON(*out, cat, "  ")

	var rb bytes.Buffer
	writeReview(&rb, cat, rv)
	check(os.WriteFile(*reviewOut, rb.Bytes(), 0o644))

	// Built from the same snapshot as the catalog, so the two never describe different docs.
	idx := DocsIndex{Schema: 1, Chunks: ChunkDocs(string(raw))}
	idx.Sources.DocsURL, idx.Sources.DocsSHA256 = cat.Sources.DocsURL, cat.Sources.DocsSHA256
	// Not indented: the index is bundled into the Worker, where every byte counts against its size limit.
	writeJSON(*docsIndexOut, idx, "")
	fmt.Printf("%d operations included, %d excluded, %d docs sections → %s, %s, %s\n",
		len(cat.Operations), len(cat.Excluded), len(idx.Chunks), *out, *reviewOut, *docsIndexOut)
}

func writeJSON(path string, v any, indent string) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", indent)
	enc.SetEscapeHTML(false)
	check(enc.Encode(v))
	check(os.WriteFile(path, buf.Bytes(), 0o644))
}

func gitHead(dir string) string {
	b, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(b))
}

func printJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	check(enc.Encode(v))
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "catalog-gen:", err)
		os.Exit(1)
	}
}
