package main

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// Param is one request parameter as the docs describe it.
type Param struct {
	Name        string  `json:"name"`
	In          string  `json:"in"`
	Type        string  `json:"type"`
	Required    bool    `json:"required,omitempty"`
	Deprecated  bool    `json:"deprecated,omitempty"`
	Default     string  `json:"default,omitempty"`
	Description string  `json:"description,omitempty"`
	Items       []Param `json:"items,omitempty"`
	srcLine     int
}

// DocOp is one METHOD URL found in the docs, with the params that follow it.
type DocOp struct {
	Method      string
	Host        string
	Path        string
	FixedQuery  map[string]string
	Title       string
	Section     string
	Description string
	Page        string
	PageTitle   string
	Params      []Param
	Line        int
}

// Anomaly is docs text the parser saw but could not use; it goes to the review report.
type Anomaly struct {
	Line int
	Page string
	Text string
}

var (
	pageSourceRe = regexp.MustCompile(`^Source: (\S+)`)
	endpointRe   = regexp.MustCompile("^`?(GET|POST|PUT|PATCH|DELETE) (https://[^\\s`]+)`?\\s*$")
	paramLineRe  = regexp.MustCompile("^\\*\\*(.+?)\\*\\*\\s+`([^`]+)`(.*)$")
	boldOnlyRe   = regexp.MustCompile(`^\*\*([^*]+)\*\*\s*$`)
	defaultRe    = regexp.MustCompile(`\(default:\s*([^)]*)\)`)
	simpleNameRe = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	nestedNameRe = regexp.MustCompile(`^([a-z][a-z0-9_]*)\[\]\.([a-z][a-z0-9_]*)$`)
	mdLinkRe     = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	tabRe        = regexp.MustCompile(`^> \[tab\] (.+)$`)
	unescaper    = strings.NewReplacer(`\_`, "_", `\[`, "[", `\]`, "]", `\*`, "*", `\<`, "<", `\>`, ">")
)

// Headings that name a page region rather than an operation, so they never become an op title.
var structuralHeadings = map[string]bool{
	"http request": true, "request": true, "endpoint": true, "api endpoint": true,
	"example": true, "example request": true, "sample request": true, "response": true,
	"returns": true, "headers": true, "authentication": true, "attributes": true,
	"success response": true, "error responses": true, "error codes": true,
}

// paramMode maps a param-section heading to where its params go; required reports a heading
// like "Required Arguments" that makes every row in it required.
func paramMode(heading, method string) (mode string, required bool) {
	h := strings.ToLower(heading)
	switch h {
	case "query parameters":
		return "query", false
	case "path parameters":
		return "path", false
	case "arguments", "request parameters", "parameters", "required arguments", "optional arguments":
		if method == "GET" {
			return "query", h == "required arguments"
		}
		return "body", h == "required arguments"
	}
	return "", false
}

func clean(s string) string {
	s = unescaper.Replace(s)
	s = mdLinkRe.ReplaceAllString(s, "$1")
	return strings.Join(strings.Fields(s), " ")
}

func isPlainParagraph(l string) bool {
	t := strings.TrimSpace(l)
	if t == "" {
		return false
	}
	for _, p := range []string{"#", "|", "- ", "* ", ">", "<", "!", "```", "**", "***", "`"} {
		if strings.HasPrefix(t, p) {
			return false
		}
	}
	return true
}

// unwrapTabs turns a tabbed block ("> [tab] Start Playing" and the quoted lines under it) into a
// "### Start Playing" heading over plain lines, the layout the parser reads everywhere else. Each
// pass unwraps one level of nested tabs. Line numbers are unchanged, so anomalies still point at the export.
func unwrapTabs(src string) string {
	lines := strings.Split(src, "\n")
	for changed := true; changed; {
		changed = false
		inTab := false
		for i, l := range lines {
			if m := tabRe.FindStringSubmatch(l); m != nil {
				lines[i], inTab, changed = "### "+m[1], true, true
				continue
			}
			switch {
			case !inTab:
			case l == ">":
				lines[i] = ""
			case strings.HasPrefix(l, "> "):
				lines[i] = l[2:]
			default:
				inTab = false
			}
		}
	}
	return strings.Join(lines, "\n")
}

// ParseDocs walks the docs' llms-full.txt export. Each METHOD URL line starts an op; the param
// sections after it, up to the next METHOD URL or ## heading, belong to that op.
func ParseDocs(src string) ([]DocOp, []Anomaly) {
	lines := strings.Split(unwrapTabs(src), "\n")
	var ops []DocOp
	var anomalies []Anomaly
	var page, pageTitle, h2, h2Desc, subTitle, subDesc string
	var cur *DocOp
	var curParam *Param
	mode, modeRequired := "", false
	// underEndpoint holds from a METHOD URL until the next heading: a param table there has no heading of its own.
	underEndpoint := false
	// inSample holds under Example/Sample/Response headings, where a fenced METHOD URL shows a request
	// rather than declaring an op; treating it as one would steal the params that follow.
	inSample := false
	inFence, fenceLang := false, ""
	wantDesc := ""

	anomaly := func(i int, s string) { anomalies = append(anomalies, Anomaly{i + 1, page, s}) }

	startOp := func(i int, method, raw string) {
		u, err := url.Parse(raw)
		if err != nil {
			anomaly(i, "unparseable endpoint URL: "+raw)
			return
		}
		op := DocOp{Method: method, Host: u.Host, Path: u.Path, Page: page, PageTitle: pageTitle, Section: h2, Line: i + 1}
		for k, v := range u.Query() {
			// `?name={name}` is a required query param; `?status=live` pins a variant of the op.
			if strings.HasPrefix(v[0], "{") && strings.HasSuffix(v[0], "}") {
				op.Params = append(op.Params, Param{Name: k, In: "query", Type: "string", Required: true, srcLine: i})
				continue
			}
			if op.FixedQuery == nil {
				op.FixedQuery = map[string]string{}
			}
			op.FixedQuery[k] = v[0]
		}
		op.Title, op.Description = h2, h2Desc
		if subTitle != "" {
			op.Title = subTitle
			if subDesc != "" {
				op.Description = subDesc
			}
		}
		ops = append(ops, op)
		cur = &ops[len(ops)-1]
		curParam, mode, modeRequired, underEndpoint = nil, "", false, true
		subTitle, subDesc, wantDesc = "", "", ""
	}

	for i := 0; i < len(lines); i++ {
		l := lines[i]
		t := strings.TrimSpace(l)

		if strings.HasPrefix(l, "# ") && i+1 < len(lines) && pageSourceRe.MatchString(lines[i+1]) {
			pageTitle = strings.TrimPrefix(l, "# ")
			page = pageSourceRe.FindStringSubmatch(lines[i+1])[1]
			h2, h2Desc, subTitle, subDesc, wantDesc = "", "", "", "", ""
			cur, curParam, mode = nil, nil, ""
			i++
			continue
		}

		if strings.HasPrefix(t, "```") {
			if !inFence {
				inFence, fenceLang = true, ""
				if f := strings.Fields(strings.TrimPrefix(t, "```")); len(f) > 0 {
					fenceLang = f[0]
				}
			} else {
				inFence = false
			}
			continue
		}
		if inFence {
			// Endpoint blocks come tagged text, bash or http; a line that is exactly METHOD URL is
			// the declaration, never a cURL sample (those start with `curl`) or a JSON body.
			if fenceLang != "json" && !inSample {
				if m := endpointRe.FindStringSubmatch(t); m != nil {
					startOp(i, m[1], m[2])
				}
			}
			continue
		}

		if m := endpointRe.FindStringSubmatch(t); m != nil {
			startOp(i, m[1], m[2])
			continue
		}

		if strings.HasPrefix(l, "## ") {
			h2 = clean(strings.TrimPrefix(l, "## "))
			h2Desc, subTitle, subDesc = "", "", ""
			wantDesc = "h2"
			cur, curParam, mode, underEndpoint, inSample = nil, nil, "", false, false
			continue
		}
		if strings.HasPrefix(l, "#") {
			level := len(l) - len(strings.TrimLeft(l, "#"))
			name := clean(strings.TrimLeft(l, "# "))
			curParam, underEndpoint = nil, false
			inSample = isSampleHeading(name)
			if cur != nil {
				if m, req := paramMode(name, cur.Method); m != "" {
					mode, modeRequired = m, req
					continue
				}
			}
			mode = ""
			if level == 3 && !structuralHeadings[strings.ToLower(name)] {
				subTitle, subDesc, wantDesc = name, "", "sub"
			}
			continue
		}
		if t == "***" {
			mode, curParam = "", nil
			continue
		}

		if mode != "" && cur != nil {
			if m := paramLineRe.FindStringSubmatch(t); m != nil {
				curParam = addParam(cur, m, mode, i, &anomaly)
				continue
			}
			if b := boldOnlyRe.FindStringSubmatch(t); b != nil && endpointAhead(lines, i) {
				mode, curParam, inSample = "", nil, false
				subTitle, subDesc, wantDesc = clean(b[1]), "", "sub"
				continue
			}
			if strings.HasPrefix(t, "**") {
				// Typeless bold lines ("**Conditional** - …", "**Deprecated.** …") qualify the param above.
				if curParam != nil {
					if strings.HasPrefix(t, "**Deprecated") {
						curParam.Deprecated = true
					}
					curParam.Description = clean(curParam.Description + " " + t)
				} else {
					anomaly(i, "bold line in a param section with no param above: "+t)
				}
				continue
			}
			if strings.HasPrefix(t, "|") {
				i = parseParamTable(lines, i, cur, mode, modeRequired, &anomaly) - 1
				curParam = nil
				continue
			}
			if t != "" && curParam != nil {
				curParam.Description = clean(curParam.Description + " " + t)
			}
			continue
		}

		if cur != nil && underEndpoint && strings.HasPrefix(t, "|") && isParamTableHeader(t) {
			m, _ := paramMode("arguments", cur.Method)
			i = parseParamTable(lines, i, cur, m, false, &anomaly) - 1
			continue
		}
		if b := boldOnlyRe.FindStringSubmatch(t); b != nil && !strings.HasSuffix(b[1], ":") {
			subTitle, subDesc, wantDesc = clean(b[1]), "", "sub"
			inSample = false
			continue
		}
		if wantDesc != "" && isPlainParagraph(l) {
			if wantDesc == "h2" {
				h2Desc = clean(l)
			} else {
				subDesc = clean(l)
			}
			wantDesc = ""
		}
	}
	for i := range ops {
		shareListDescriptions(ops[i].Params)
		for j := range ops[i].Params {
			if strings.HasPrefix(ops[i].Params[j].Description, "Deprecated") {
				ops[i].Params[j].Deprecated = true
			}
		}
	}
	return ops, anomalies
}

func isSampleHeading(name string) bool {
	h := strings.ToLower(name)
	for _, p := range []string{"example", "sample", "response", "returns", "success response", "error"} {
		if strings.HasPrefix(h, p) {
			return true
		}
	}
	return false
}

// endpointAhead reports whether the next content after line i is a METHOD URL, so a bold line
// there titles the next op instead of qualifying the param above it.
func endpointAhead(lines []string, i int) bool {
	for j := i + 1; j < len(lines) && j <= i+8; j++ {
		t := strings.TrimSpace(lines[j])
		if t == "" || strings.HasPrefix(t, "```") {
			continue
		}
		return endpointRe.MatchString(t)
	}
	return false
}

// shareListDescriptions gives every name from one "a, b, c" line the description written after it.
func shareListDescriptions(ps []Param) {
	for i := len(ps) - 2; i >= 0; i-- {
		if ps[i].srcLine == ps[i+1].srcLine && ps[i].Description == "" {
			ps[i].Description = ps[i+1].Description
		}
	}
}

func tableCells(l string) []string {
	t := strings.TrimSpace(l)
	t = strings.TrimSuffix(strings.TrimPrefix(t, "|"), "|")
	cells := strings.Split(t, "|")
	for i := range cells {
		cells[i] = strings.TrimSpace(cells[i])
	}
	return cells
}

var paramColumn = map[string]bool{"parameter": true, "name": true, "field": true, "argument": true}

func isParamTableHeader(l string) bool {
	for _, h := range tableCells(l) {
		if paramColumn[strings.ToLower(clean(h))] {
			return true
		}
	}
	return false
}

// parseParamTable reads a "| Parameter | Type | Required | Default | Description |" table (any
// subset of those columns, in any order) starting at line i, and returns the first line after it.
// allRequired marks every row required when the section heading says so ("Required Arguments").
func parseParamTable(lines []string, i int, op *DocOp, mode string, allRequired bool, anomaly *func(int, string)) int {
	col := map[string]int{}
	for j, h := range tableCells(lines[i]) {
		switch k := strings.ToLower(clean(h)); {
		case paramColumn[k]:
			col["name"] = j
		case k == "type":
			col["type"] = j
		case k == "required":
			col["required"] = j
		case k == "default":
			col["default"] = j
		case k == "description":
			col["description"] = j
		}
	}
	end := i + 1
	for end < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[end]), "|") {
		end++
	}
	if _, ok := col["name"]; !ok {
		(*anomaly)(i, "table in a param section without a Parameter column: "+strings.TrimSpace(lines[i]))
		return end
	}
	cell := func(cells []string, k string) string {
		if j, ok := col[k]; ok && j < len(cells) {
			return cells[j]
		}
		return ""
	}
	for r := i + 2; r < end; r++ {
		cells := tableCells(lines[r])
		name := strings.TrimSpace(strings.ReplaceAll(unescaper.Replace(cell(cells, "name")), "`", ""))
		typ := strings.Trim(clean(cell(cells, "type")), "`")
		if typ == "" {
			typ = "string"
		}
		req := strings.ToLower(clean(cell(cells, "required")))
		desc := clean(cell(cells, "description"))
		if req == "conditional" {
			desc = clean("Conditionally required. " + desc)
		}
		def := strings.Trim(clean(cell(cells, "default")), "`")
		if def == "-" || def == "—" {
			def = ""
		}
		m := []string{"", name, typ, ""}
		if req == "yes" || req == "required" || req == "true" || (allRequired && req == "") {
			m[3] = "*required*"
		}
		if def != "" {
			m[3] += " (default: " + def + ")"
		}
		if p := addParam(op, m, mode, r, anomaly); p != nil {
			p.Description = desc
		}
	}
	return end
}

// addParam records one param line; a comma list ("a, b, c") yields several, and a nested
// "parent[].child" line becomes an item field of its parent.
func addParam(op *DocOp, m []string, mode string, line int, anomaly *func(int, string)) *Param {
	name := unescaper.Replace(m[1])
	rest := m[3]
	base := Param{In: mode, Type: m[2], srcLine: line}
	if strings.Contains(rest, "*required*") {
		base.Required = true
	}
	if strings.Contains(rest, "*deprecated*") {
		base.Deprecated = true
	}
	if d := defaultRe.FindStringSubmatch(rest); d != nil {
		base.Default = strings.Trim(strings.TrimSpace(d[1]), "`")
	}

	if n := nestedNameRe.FindStringSubmatch(name); n != nil {
		for j := range op.Params {
			if op.Params[j].Name == n[1] {
				child := base
				child.Name, child.In = n[2], ""
				op.Params[j].Items = append(op.Params[j].Items, child)
				return &op.Params[j].Items[len(op.Params[j].Items)-1]
			}
		}
		(*anomaly)(line, "nested param without a parent: "+name)
		return nil
	}

	var names []string
	for _, n := range strings.Split(name, ",") {
		n = strings.TrimSpace(n)
		if !simpleNameRe.MatchString(n) {
			(*anomaly)(line, fmt.Sprintf("skipped non-param bold line %q (%s %s)", name, op.Method, op.Path))
			return nil
		}
		names = append(names, n)
	}
	for _, n := range names {
		p := base
		p.Name = n
		op.Params = append(op.Params, p)
	}
	return &op.Params[len(op.Params)-1]
}
