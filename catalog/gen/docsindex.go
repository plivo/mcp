package main

import (
	"regexp"
	"strings"
)

// DocChunk is one searchable section of a docs page: the text under one ## or ### heading.
type DocChunk struct {
	Title   string `json:"title"`
	Section string `json:"section,omitempty"`
	URL     string `json:"url"`
	Text    string `json:"text"`
}

// DocsIndex is catalog/docs.json, what search_docs searches.
type DocsIndex struct {
	Schema  int `json:"schema"`
	Sources struct {
		DocsURL    string `json:"docs_url"`
		DocsSHA256 string `json:"docs_sha256"`
	} `json:"sources"`
	Chunks []DocChunk `json:"chunks"`
}

// The docs' sample auth IDs, tokens and key placeholders would read as leaked secrets in this repo.
var docSamples = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`\bMA[A-Z0-9]{18}\b`), "<auth_id>"},
	{regexp.MustCompile(`\bSA[A-Z0-9]{18}\b`), "<subaccount_auth_id>"},
	{regexp.MustCompile(`("auth_token":\s*")[A-Za-z0-9]{20,}"`), `${1}<auth_token>"`},
	{regexp.MustCompile(`\bsk-[A-Za-z0-9_]{8,}`), "<api_key>"},
}

func scrubSamples(s string) string {
	for _, c := range docSamples {
		s = c.re.ReplaceAllString(s, c.with)
	}
	return s
}

// maxChunkChars keeps one search hit readable; longer sections are split at paragraph breaks.
const maxChunkChars = 4000

// ChunkDocs splits the llms-full.txt export into sections. Headings inside code fences are code
// comments (`# install`), not structure, so they never start a page or a section.
func ChunkDocs(src string) []DocChunk {
	var out []DocChunk
	var title, url, h2, h3 string
	var body []string
	inFence := false

	flush := func() {
		text := tidy(body)
		body = nil
		if title == "" || text == "" {
			return
		}
		section := h2
		if h3 != "" {
			section = strings.TrimSpace(h2 + " › " + h3)
			section = strings.TrimPrefix(section, "› ")
		}
		for _, part := range splitParagraphs(text, maxChunkChars) {
			out = append(out, DocChunk{Title: title, Section: section, URL: url, Text: part})
		}
	}

	lines := strings.Split(scrubSamples(src), "\n")
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		if strings.HasPrefix(l, "# ") && i+1 < len(lines) && pageSourceRe.MatchString(lines[i+1]) {
			flush()
			title = clean(strings.TrimPrefix(l, "# "))
			url = pageSourceRe.FindStringSubmatch(lines[i+1])[1]
			h2, h3, inFence = "", "", false
			i++
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(l), "```") {
			inFence = !inFence
		} else if !inFence && strings.HasPrefix(l, "## ") {
			flush()
			h2, h3 = clean(strings.TrimPrefix(l, "## ")), ""
			continue
		} else if !inFence && strings.HasPrefix(l, "### ") {
			flush()
			h3 = clean(strings.TrimPrefix(l, "### "))
			continue
		}
		body = append(body, l)
	}
	flush()
	return out
}

var proseUnescaper = strings.NewReplacer(`\_`, "_", `\[`, "[", `\]`, "]", `\*`, "*", `\<`, "<", `\>`, ">", `\&`, "&")

// tidy drops the docs' *** separators and runs of blank lines, and undoes markdown escapes in prose.
// Code samples are left byte for byte: there a backslash can be part of the code.
func tidy(lines []string) string {
	var b strings.Builder
	blank, inFence := true, false
	for _, l := range lines {
		l = strings.TrimRight(l, " \t\r")
		fence := strings.HasPrefix(strings.TrimSpace(l), "```")
		if fence {
			inFence = !inFence
		} else if !inFence {
			if l == "***" {
				continue
			}
			l = proseUnescaper.Replace(l)
		}
		if l == "" {
			if !blank {
				b.WriteString("\n")
			}
			blank = true
			continue
		}
		b.WriteString(l)
		b.WriteString("\n")
		blank = false
	}
	return strings.TrimSpace(b.String())
}

// splitParagraphs cuts text into pieces of about max characters: at a blank line once a piece is half
// full, or at a line break when the next line would overflow it. Never inside a code fence, so a
// sample is not cut in half; a piece holding one long sample can therefore exceed max.
func splitParagraphs(text string, max int) []string {
	if len(text) <= max {
		return []string{text}
	}
	var parts []string
	var cur strings.Builder
	inFence := false
	for _, l := range strings.Split(text, "\n") {
		if !inFence {
			if l == "" && cur.Len() >= max/2 {
				parts = append(parts, strings.TrimSpace(cur.String()))
				cur.Reset()
				continue
			}
			if cur.Len()+len(l) > max && cur.Len() > 0 {
				parts = append(parts, strings.TrimSpace(cur.String()))
				cur.Reset()
			}
		}
		cur.WriteString(l)
		cur.WriteString("\n")
		// Toggled after the line is placed, so a closing fence stays with its sample.
		if strings.HasPrefix(strings.TrimSpace(l), "```") {
			inFence = !inFence
		}
	}
	if s := strings.TrimSpace(cur.String()); s != "" {
		parts = append(parts, s)
	}
	return parts
}
