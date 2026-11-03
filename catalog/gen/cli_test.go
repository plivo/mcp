package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// cliFixture writes a fake plivo-cli cmd/ package and scans it.
func cliFixture(t *testing.T, src string) *CLIInventory {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "cmd"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "cmd", "x.go"), []byte("package cmd\n"+src), 0o644); err != nil {
		t.Fatal(err)
	}
	inv, err := ScanCLI(root)
	if err != nil {
		t.Fatal(err)
	}
	return inv
}

func TestScanCLIResolvesHelpersAndSpend(t *testing.T) {
	inv := cliFixture(t, `
func runSend() error { guardSpend("send"); return sendHelper() }
func sendHelper() error { _, err := client.Do("POST", client.AccountURL("Message"), nil, nil, nil); return err }
func runList() error { return fetchList(client, client.AccountURL("Message"), nil, "objects", nil) }
func fetchList(c any, endpoint string, q any, key string, out any) error { _, err := c.Do("GET", endpoint, nil, q, out); return err }
func runRent() error { guardSpend("rent"); return postIt(client, "PhoneNumber", num) }
func postIt(c any, parts ...string) error { _, err := c.Do("POST", c.AccountURL(parts...), nil, nil, nil); return err }
func runMute() error { return member("POST", name, "Mute") }
func member(method, name, sub string) error { _, err := client.Do(method, client.AccountURL("Conference", name, sub), nil, nil, nil); return err }
`)
	// key → spend
	want := map[string]bool{
		// guardSpend in the caller of the request helper
		"POST /Message": true,
		"GET /Message":  false,
		// variadic parts inlined; spend from the call site
		"POST /PhoneNumber/":     true,
		"POST /Conference//Mute": false,
	}
	for k, spend := range want {
		u, ok := inv.Uses[k]
		if !ok {
			t.Errorf("missing %s; got %v", k, sortedKeys(inv.Uses))
			continue
		}
		if u.Spend != spend {
			t.Errorf("%s spend=%v, want %v", k, u.Spend, spend)
		}
	}
	if len(inv.Unresolved) != 0 {
		t.Errorf("unexpected unresolved: %v", inv.Unresolved)
	}
}

func TestScanCLIStopsOnUnmodelledAPICalls(t *testing.T) {
	inv := cliFixture(t, `
type s struct{}
func (x *s) send() error { _, err := client.Do("POST", client.AccountURL("Message"), nil, nil, nil); return err }
func init() { guardSpend("x") }
`)
	if len(inv.Unresolved) != 2 || !strings.Contains(strings.Join(inv.Unresolved, " "), "method or init") {
		t.Errorf("a method or init making API calls must be surfaced, got %v", inv.Unresolved)
	}
}
