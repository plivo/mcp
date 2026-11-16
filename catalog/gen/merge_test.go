package main

import (
	"strings"
	"testing"
)

func inventory(uses ...string) *CLIInventory {
	inv := &CLIInventory{Uses: map[string]*CLIUse{}}
	for _, u := range uses {
		parts := strings.SplitN(u, " ", 2)
		var segs []string
		for _, s := range strings.Split(strings.Trim(parts[1], "/"), "/") {
			if s == "{}" {
				s = ""
			}
			if parts[1] != "/" {
				segs = append(segs, s)
			}
		}
		inv.Uses[u] = &CLIUse{Method: parts[0], Segs: segs, Sources: []string{"x.go:f"}}
	}
	return inv
}

func TestCoversWildcardOnlyMatchesPlaceholders(t *testing.T) {
	inv := inventory("POST /10dlc/Campaign/{}/", "GET /Call/", "GET /")
	cases := map[string]bool{
		"POST /10dlc/Campaign/{campaign_id}/": true,
		"POST /10dlc/Campaign/Import/":        false,
		"GET /Call/":                          true,
		"POST /Call/":                         false,
		"GET /":                               true,
	}
	for in, want := range cases {
		p := strings.SplitN(in, " ", 2)
		if got := len(inv.Covers(p[0], p[1])) > 0; got != want {
			t.Errorf("%s covered=%v, want %v", in, got, want)
		}
	}
}

func TestModuleFor(t *testing.T) {
	cases := map[string]string{
		"POST /Message/":              "message.send",
		"POST /Powerpack/":            "message.write",
		"GET /Message/{id}/":          "message.read",
		"DELETE /Call/{call_uuid}/":   "call.make",
		"POST /PhoneNumber/{number}/": "number.write",
		"GET /":                       "account.read",
		"POST /Zentrunk/Trunk/":       "sip.write",
		"GET /SomethingNew/":          "",
	}
	for in, want := range cases {
		p := strings.SplitN(in, " ", 2)
		if got := moduleFor(p[0], p[1]); got != want {
			t.Errorf("%s → %q, want %q", in, got, want)
		}
	}
}

func docOp(method, rel string, params ...string) DocOp {
	d := DocOp{Method: method, Host: apiHost, Path: accountPrefix + rel, Title: "t", Page: "https://plivo.com/docs/voice/api/x"}
	for _, n := range params {
		d.Params = append(d.Params, Param{Name: n, In: "body", Type: "string"})
	}
	return d
}

func TestBuildIncludeSpendAndPathParams(t *testing.T) {
	inv := inventory("POST /Message/", "GET /Message/{}/", "POST /Call/{}/Record/")
	inv.Uses["POST /Message/"].Spend = true
	ops := []DocOp{
		docOp("POST", "/Message/", "src", "dst"),
		docOp("GET", "/Message/{message_uuid}/", "message_uuid"),
		docOp("POST", "/Call/{call_uuid}/Record/"),
		docOp("DELETE", "/Message/{message_uuid}/"),
	}
	cat, _, err := Build(ops, nil, inv, &Overrides{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Operation{}
	for _, o := range cat.Operations {
		got[o.ID] = o
	}
	if send := got["POST /Message/"]; !send.CostsMoney || send.Module != "message.send" {
		t.Errorf("send message: costs=%v module=%q", send.CostsMoney, send.Module)
	}
	if rec := got["POST /Call/{call_uuid}/Record/"]; !rec.CostsMoney {
		t.Error("recording should be flagged by the cost rules")
	}
	read := got["GET /Message/{message_uuid}/"]
	if len(read.Params) != 0 || len(read.PathParams) != 1 || read.PathParams[0].Name != "message_uuid" {
		t.Errorf("a documented path param must not be sent as a query param: path=%+v params=%+v", read.PathParams, read.Params)
	}
	if _, ok := got["DELETE /Message/{message_uuid}/"]; ok || len(cat.Excluded) != 1 {
		t.Error("an op outside the CLI surface must be excluded by default")
	}
}

func TestBuildRejectsUnreviewedInput(t *testing.T) {
	ops := []DocOp{docOp("POST", "/Message/")}

	inv := inventory("POST /Message/")
	inv.Unresolved = []string{"new.go:helper url"}
	if _, _, err := Build(ops, nil, inv, &Overrides{}, nil); err == nil || !strings.Contains(err.Error(), "not reviewed") {
		t.Errorf("an unresolved CLI call site must stop the build, got %v", err)
	}

	no := false
	ov := &Overrides{Ops: map[string]OpOverride{"POST /Mesage/": {Include: &no, Reason: "typo"}}}
	if _, _, err := Build(ops, nil, inventory("POST /Message/"), ov, nil); err == nil || !strings.Contains(err.Error(), "unknown op") {
		t.Errorf("an override for a missing op must stop the build, got %v", err)
	}

	ov = &Overrides{Ops: map[string]OpOverride{"POST /Message/": {Include: &no}}}
	if _, _, err := Build(ops, nil, inventory("POST /Message/"), ov, nil); err == nil || !strings.Contains(err.Error(), "no reason") {
		t.Errorf("an override without a reason must stop the build, got %v", err)
	}

	spendInv := inventory("POST /Message/")
	spendInv.Uses["POST /Message/"].Spend = true
	ov = &Overrides{Ops: map[string]OpOverride{"POST /Message/": {CostsMoney: &no, Reason: "looks free"}}}
	if _, _, err := Build(ops, nil, spendInv, ov, nil); err == nil || !strings.Contains(err.Error(), "clears a spend flag") {
		t.Errorf("an override must not clear a CLI spend flag, got %v", err)
	}

	yes := true
	unmapped := []DocOp{docOp("GET", "/SomethingNew/")}
	ov = &Overrides{Ops: map[string]OpOverride{"GET /SomethingNew/": {Include: &yes, Reason: "want it"}}}
	if _, _, err := Build(unmapped, nil, inventory(), ov, nil); err == nil || !strings.Contains(err.Error(), "cannot be included") {
		t.Errorf("an op without a consent module must not be included, got %v", err)
	}
}

func TestExtraOps(t *testing.T) {
	agentDelete := ExtraOp{Method: "DELETE", Path: "/AgentFlow/{agent_id}/", Title: "Delete an Agent", Group: "agents", Source: "agent.go:runAgentDelete",
		Params: []Param{{Name: "agent_id", In: "path", Type: "string", Description: "The agent's UUID."}}}
	ov := &Overrides{ExtraOps: []ExtraOp{agentDelete}}

	cat, _, err := Build(nil, nil, inventory("DELETE /AgentFlow/{}/"), ov, nil)
	if err != nil {
		t.Fatal(err)
	}
	op := cat.Operations[0]
	if op.ID != "DELETE /AgentFlow/{agent_id}/" || op.Module != "agent.write" || !op.Destructive || op.Group != "agents" ||
		len(op.PathParams) != 1 || op.PathParams[0].Description != "The agent's UUID." {
		t.Errorf("an extra op must follow the docs-op rules: %+v", op)
	}

	if _, _, err := Build([]DocOp{docOp("DELETE", "/AgentFlow/{agent_id}/")}, nil, inventory("DELETE /AgentFlow/{}/"), ov, nil); err == nil ||
		!strings.Contains(err.Error(), "now in the docs") {
		t.Errorf("an extra op the docs now describe must stop the build, got %v", err)
	}
	if _, _, err := Build(nil, nil, inventory(), ov, nil); err == nil || !strings.Contains(err.Error(), "would be excluded") {
		t.Errorf("an extra op the CLI does not call must stop the build, got %v", err)
	}
}

func TestDestructiveOverride(t *testing.T) {
	no := false
	ov := &Overrides{Ops: map[string]OpOverride{"DELETE /Call/{call_uuid}/Play/": {Destructive: &no, Reason: "stops audio"}}}
	ops := []DocOp{docOp("DELETE", "/Call/{call_uuid}/Play/"), docOp("DELETE", "/Call/{call_uuid}/")}
	cat, _, err := Build(ops, nil, inventory("DELETE /Call/{}/Play/", "DELETE /Call/{}/"), ov, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, o := range cat.Operations {
		got[o.ID] = o.Destructive
	}
	if got["DELETE /Call/{call_uuid}/Play/"] || !got["DELETE /Call/{call_uuid}/"] {
		t.Errorf("only the overridden DELETE stops being permanent: %v", got)
	}
}

func TestUnconfirmedPricingIsFlagged(t *testing.T) {
	cat, rv, err := Build([]DocOp{docOp("POST", "/Call/{call_uuid}/Speak/")}, nil, inventory("POST /Call/{}/Speak/"), &Overrides{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !cat.Operations[0].CostsMoney || len(rv.PricingCheck) != 1 {
		t.Errorf("an op with unconfirmed billing must be flagged and listed: costs=%v pricing=%v", cat.Operations[0].CostsMoney, rv.PricingCheck)
	}
}
