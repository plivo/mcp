package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const (
	apiHost    = "api.plivo.com"
	lookupHost = "lookup.plivo.com"
	// lookupPrefix is where the auth proxy serves the Lookup API; it forwards to lookupHost's /v1/.
	lookupPrefix  = "/v1/Lookup/"
	accountPrefix = "/v1/Account/{auth_id}"
)

// Operation is one catalog entry, the unit the MCP tools search, describe and call.
type Operation struct {
	ID          string            `json:"id"`
	Method      string            `json:"method"`
	Path        string            `json:"path"`
	FixedQuery  map[string]string `json:"fixed_query,omitempty"`
	Title       string            `json:"title"`
	Section     string            `json:"section,omitempty"`
	Description string            `json:"description,omitempty"`
	Group       string            `json:"group"`
	DocsURL     string            `json:"docs_url"`
	PathParams  []Param           `json:"path_params,omitempty"`
	Params      []Param           `json:"params"`
	Module      string            `json:"module"`
	CostsMoney  bool              `json:"costs_money"`
	Destructive bool              `json:"destructive"`
}

type Excluded struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Reason string `json:"reason"`
}

type Catalog struct {
	Schema     int         `json:"schema"`
	Sources    Sources     `json:"sources"`
	Operations []Operation `json:"operations"`
	Excluded   []Excluded  `json:"excluded"`
}

type Sources struct {
	DocsURL    string `json:"docs_url"`
	DocsSHA256 string `json:"docs_sha256"`
	CLIRepo    string `json:"cli_repo"`
	CLICommit  string `json:"cli_commit"`
}

// Overrides are the hand-reviewed decisions the generator cannot make from source code.
type Overrides struct {
	CLIManual []struct {
		Method string `json:"method"`
		Path   string `json:"path"`
		Source string `json:"source"`
	} `json:"cli_manual"`
	CLIIgnore map[string]string     `json:"cli_ignore"`
	Ops       map[string]OpOverride `json:"ops"`
	ExtraOps  []ExtraOp             `json:"extra_ops"`
}

// ExtraOp is an operation the CLI calls that the docs do not describe, written from the CLI's
// commands and the server's validation. It then goes through the same rules as a docs op.
type ExtraOp struct {
	Method      string  `json:"method"`
	Path        string  `json:"path"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Group       string  `json:"group"`
	Source      string  `json:"source"`
	Params      []Param `json:"params"`
}

type OpOverride struct {
	Include    *bool  `json:"include,omitempty"`
	CostsMoney *bool  `json:"costs_money,omitempty"`
	Module     string `json:"module,omitempty"`
	// Description replaces the docs' when they do not say how to use the op, e.g. which id it takes.
	Description string `json:"description,omitempty"`
	Reason      string `json:"reason"`
}

// Review collects everything a person must read before trusting the catalog.
type Review struct {
	Included     []reviewRow
	Excluded     []Excluded
	CLIOnly      []string
	Unresolved   []string
	Anomalies    []Anomaly
	Duplicates   []string
	ParamDiffs   []string
	PricingCheck []string
	NewModules   map[string][]string
}

type reviewRow struct {
	op     Operation
	cli    []string
	reason string
}

// Scope modules the auth proxy can already gate on.
var existingModules = map[string]bool{
	"number.read": true, "number.write": true, "application.read": true, "application.write": true,
	"message.read": true, "message.send": true, "call.read": true, "call.make": true,
	"agent.read": true, "agent.write": true, "ucc.read": true, "ucc.write": true,
}

// moduleArea maps the first path segment under /v1/Account/{auth_id}/ to a consent area.
var moduleArea = map[string]string{
	"": "account", "Subaccount": "account", "UsageSummary": "account", "JWT": "account", "SipAuth": "account",
	"Message": "message", "Media": "message", "Powerpack": "message", "NumberPool": "message", "10dlc": "message", "Profile": "message",
	"TollfreeVerification": "message", "WhatsApp": "message",
	"Call": "call", "Conference": "call", "MultiPartyCall": "call", "Recording": "call", "Transcription": "call",
	"Request": "call", "Masking": "call", "VerifiedCallerId": "call",
	"Number": "number", "PhoneNumber": "number", "CnamLookup": "number",
	"Application": "application", "Endpoint": "application",
	"Zentrunk": "sip", "Verify": "verify", "Ucc": "ucc", "AgentFlow": "agent", "AgentFlowNode": "agent",
}

// module names follow the auth proxy's existing ones: message writes that send are message.send, every
// call-control write is call.make.
func moduleFor(method, rel string) string {
	if strings.HasPrefix(rel, lookupPrefix) {
		return "number.read"
	}
	segs := splitPath(rel)
	first := ""
	if len(segs) > 0 {
		first = segs[0]
	}
	area, ok := moduleArea[first]
	if !ok {
		return ""
	}
	if method == "GET" {
		return area + ".read"
	}
	switch {
	case area == "message" && method == "POST" && rel == "/Message/":
		return "message.send"
	case area == "message":
		return "message.write"
	case area == "call":
		return "call.make"
	}
	return area + ".write"
}

type costRule struct {
	method string
	path   *regexp.Regexp
	reason string
}

// costRules add spend flags the CLI's guardSpend does not carry. Over-flagging only costs a
// confirmation; under-flagging lets an agent spend without one.
var costRules = []costRule{
	{"POST", regexp.MustCompile(`^/Transcription/[^/]+/$`), "transcription is billed"},
	{"POST", regexp.MustCompile(`/Record/$`), "recording may enable billed transcription"},
	{"POST", regexp.MustCompile(`^/MultiPartyCall/[^/]+/Participant/$`), "dials a participant"},
	{"GET", regexp.MustCompile(`^/v1/Lookup/`), "the docs price a lookup at USD 0.004"},
}

// pricingToConfirm are writes whose billing the docs do not state. They are flagged as costing money
// until someone confirms they are free; then an override clears them with that evidence as the reason.
var pricingToConfirm = []costRule{
	{"POST", regexp.MustCompile(`^/Call/[^/]+/(Speak|Play)/$`), "text-to-speech / playback on a live call"},
	{"POST", regexp.MustCompile(`^/Call/[^/]+/Stream/$`), "audio streaming minutes"},
	{"POST", regexp.MustCompile(`^/MultiPartyCall/[^/]+/$`), "activating a multiparty call"},
	{"POST", regexp.MustCompile(`^/VerifiedCallerId/$`), "caller-ID verification places a call or SMS"},
	{"POST", regexp.MustCompile(`^/Conference/[^/]+/Member/[^/]+/(Speak|Play)/$`), "speak/play to a conference member"},
}

var placeholderRe = regexp.MustCompile(`\{([^}]+)\}`)

func opID(method, rel string, fixed map[string]string) string {
	id := method + " " + rel
	if len(fixed) > 0 {
		var kv []string
		for _, k := range sortedKeys(fixed) {
			kv = append(kv, k+"="+fixed[k])
		}
		id += "?" + strings.Join(kv, "&")
	}
	return id
}

// relPath returns the path under /v1/Account/{auth_id}, always with a trailing slash (the CLI
// calls every account path that way), or ok=false for anything the auth proxy cannot route.
func relPath(host, path string) (string, bool) {
	if host != apiHost || !strings.HasPrefix(path, accountPrefix) {
		return "", false
	}
	rel := strings.TrimPrefix(path, accountPrefix)
	if !strings.HasSuffix(rel, "/") {
		rel += "/"
	}
	if !strings.HasPrefix(rel, "/") {
		rel = "/" + rel
	}
	return rel, true
}

func docsGroup(page string) string {
	rest := strings.SplitN(page, "/docs/", 2)
	if len(rest) < 2 {
		return ""
	}
	return strings.SplitN(rest[1], "/", 2)[0]
}

// pickBest keeps one docs op per id: the reference page over a guide repeating the endpoint,
// then the copy with the most params.
func pickBest(ops []DocOp) (map[string]DocOp, []string) {
	best := map[string]DocOp{}
	var dups []string
	score := func(o DocOp) int {
		s := len(o.Params) * 2
		if strings.Contains(o.Page, "/api/") {
			s++
		}
		return s
	}
	for _, o := range ops {
		rel, ok := relPath(o.Host, o.Path)
		if !ok {
			rel = o.Host + o.Path
		}
		id := opID(o.Method, rel, o.FixedQuery)
		if prev, seen := best[id]; seen {
			dups = append(dups, fmt.Sprintf("%s — kept %s (L%d, %d params), dropped %s (L%d, %d params)",
				id, prev.Page, prev.Line, len(prev.Params), o.Page, o.Line, len(o.Params)))
			if score(o) <= score(prev) {
				continue
			}
		}
		best[id] = o
	}
	return best, dups
}

// Build turns docs ops plus CLI coverage and overrides into the catalog and its review notes.
func Build(docOps []DocOp, anomalies []Anomaly, inv *CLIInventory, ov *Overrides, sdks []SDKEndpoint) (*Catalog, *Review, error) {
	rv := &Review{Anomalies: anomalies, NewModules: map[string][]string{}}
	for _, m := range ov.CLIManual {
		u := &CLIUse{Method: m.Method, Sources: []string{"manual: " + m.Source}}
		for _, s := range strings.Split(strings.Trim(m.Path, "/"), "/") {
			if s == "{}" {
				s = ""
			}
			u.Segs = append(u.Segs, s)
		}
		inv.Uses[m.Method+" /"+strings.Join(u.Segs, "/")] = u
	}
	for _, site := range inv.Unresolved {
		if !reviewedSite(site, ov) {
			return nil, nil, fmt.Errorf("CLI call site not reviewed (add it to cli_manual or cli_ignore in overrides.json): %s", site)
		}
		rv.Unresolved = append(rv.Unresolved, site)
	}

	best, dups := pickBest(docOps)
	rv.Duplicates = dups
	extra := map[string]ExtraOp{}
	for _, e := range ov.ExtraOps {
		rel, _ := relPath(apiHost, accountPrefix+e.Path)
		id := opID(e.Method, rel, nil)
		if _, documented := best[id]; documented {
			return nil, nil, fmt.Errorf("extra op %s is now in the docs; remove it from extra_ops", id)
		}
		if _, dup := extra[id]; dup || e.Title == "" || e.Source == "" {
			return nil, nil, fmt.Errorf("extra op %s is listed twice or has no title or source", id)
		}
		extra[id] = e
		best[id] = DocOp{Method: e.Method, Host: apiHost, Path: accountPrefix + rel, Title: e.Title, Section: e.Title,
			Description: e.Description, Params: e.Params}
	}
	usedOverride := map[string]bool{}
	coveredCLI := map[*CLIUse]bool{}
	cat := &Catalog{Schema: 1}

	for _, id := range sortedKeys(best) {
		d := best[id]
		rel, routable := relPath(d.Host, d.Path)
		path := accountPrefix + rel
		if d.Host == lookupHost && strings.HasPrefix(d.Path, "/v1/") {
			path = lookupPrefix + strings.TrimPrefix(d.Path, "/v1/")
			rel, routable = path, true
		}
		var cli []*CLIUse
		if routable {
			cli = inv.Covers(d.Method, rel)
		}
		var cliSources []string
		cliSpend := false
		for _, u := range cli {
			coveredCLI[u] = true
			cliSources = append(cliSources, u.Sources...)
			cliSpend = cliSpend || u.Spend
		}

		op := Operation{
			ID: id, Method: d.Method, Path: path, FixedQuery: d.FixedQuery,
			Title: d.Title, Section: d.Section, Description: d.Description,
			Group: docsGroup(d.Page), DocsURL: d.Page, Params: []Param{},
			Destructive: d.Method == "DELETE",
		}
		op.PathParams, op.Params = splitPathParams(rel, d.Params)
		e, isExtra := extra[id]
		if isExtra {
			op.Group = e.Group
		}
		if routable {
			op.Module = moduleFor(d.Method, rel)
		}

		costReason := ""
		if cliSpend {
			costReason = "CLI guards it with guardSpend"
		}
		for _, r := range costRules {
			if r.method == d.Method && r.path.MatchString(rel) && costReason == "" {
				costReason = r.reason
			}
		}
		ruleSpend := costReason != ""
		for _, r := range pricingToConfirm {
			if r.method == d.Method && r.path.MatchString(rel) {
				rv.PricingCheck = append(rv.PricingCheck, id+" — "+r.reason)
				if costReason == "" {
					costReason = "billing unconfirmed: " + r.reason
				}
			}
		}
		op.CostsMoney = costReason != ""

		include, reason := false, ""
		switch {
		case !routable:
			reason = "outside api.plivo.com/v1/Account/{auth_id}/, which the auth proxy does not route"
		case op.Module == "":
			reason = "no consent module for this resource"
		case len(cli) == 0:
			reason = "not in the CLI's surface; review before exposing"
		default:
			include, reason = true, "covered by the CLI"
		}

		if o, ok := ov.Ops[id]; ok {
			usedOverride[id] = true
			if o.Reason == "" {
				return nil, nil, fmt.Errorf("override for %s has no reason", id)
			}
			if o.Include != nil {
				include, reason = *o.Include, "override: "+o.Reason
			}
			if o.CostsMoney != nil {
				if !*o.CostsMoney && ruleSpend {
					return nil, nil, fmt.Errorf("override for %s clears a spend flag set by the CLI's guardSpend or a cost rule; fix the source instead", id)
				}
				op.CostsMoney = *o.CostsMoney
				costReason = "override: " + o.Reason
			}
			if o.Module != "" {
				op.Module = o.Module
			}
			if o.Description != "" {
				op.Description = o.Description
			}
		}
		if include && (!routable || op.Module == "") {
			return nil, nil, fmt.Errorf("%s cannot be included: it is not routable through /v1/proxy or has no consent module", id)
		}

		if isExtra {
			if !include {
				return nil, nil, fmt.Errorf("extra op %s would be excluded (%s); only CLI calls belong in extra_ops", id, reason)
			}
			reason += "; not in the docs, written from " + e.Source
		}
		if !include {
			cat.Excluded = append(cat.Excluded, Excluded{ID: id, Title: d.Title, Reason: reason})
			rv.Excluded = append(rv.Excluded, Excluded{ID: id, Title: d.Title, Reason: reason})
			continue
		}
		if !existingModules[op.Module] {
			rv.NewModules[op.Module] = append(rv.NewModules[op.Module], id)
		}
		cat.Operations = append(cat.Operations, op)
		row := reviewRow{op: op, cli: cliSources, reason: reason}
		if costReason != "" {
			row.reason += "; costs money: " + costReason
		}
		rv.Included = append(rv.Included, row)
		rv.ParamDiffs = append(rv.ParamDiffs, diffParams(op, sdks)...)
	}

	for _, id := range sortedKeys(ov.Ops) {
		if !usedOverride[id] {
			return nil, nil, fmt.Errorf("override for unknown op %q (docs changed or a typo)", id)
		}
	}
	for _, k := range sortedKeys(inv.Uses) {
		u := inv.Uses[k]
		if !coveredCLI[u] && (len(u.Segs) == 0 || !strings.HasPrefix(u.Segs[0], "!")) {
			rv.CLIOnly = append(rv.CLIOnly, k+"  ("+strings.Join(u.Sources, ", ")+")")
		}
	}
	sort.Slice(cat.Operations, func(i, j int) bool { return cat.Operations[i].ID < cat.Operations[j].ID })
	return cat, rv, nil
}

// splitPathParams returns one path param per {placeholder} in rel, taking its description from a
// docs param of the same name (some pages list path params under "Arguments"), and the rest.
func splitPathParams(rel string, docs []Param) (path, rest []Param) {
	byName := map[string]Param{}
	for _, p := range docs {
		byName[p.Name] = p
	}
	inPath := map[string]bool{}
	for _, m := range placeholderRe.FindAllStringSubmatch(rel, -1) {
		p := Param{Name: m[1], In: "path", Type: "string", Required: true}
		if d, ok := byName[m[1]]; ok {
			p.Description = d.Description
		}
		path = append(path, p)
		inPath[m[1]] = true
	}
	rest = []Param{}
	for _, p := range docs {
		if !inPath[p.Name] {
			rest = append(rest, p)
		}
	}
	return path, rest
}

func reviewedSite(site string, ov *Overrides) bool {
	for prefix := range ov.CLIIgnore {
		if strings.HasPrefix(site, prefix) {
			return true
		}
	}
	for _, m := range ov.CLIManual {
		if strings.HasPrefix(site, m.Source) {
			return true
		}
	}
	return false
}
