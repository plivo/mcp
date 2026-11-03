package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// SDKEndpoint is one entry of an SDK inventory: method, path and the param names the SDK sends.
type SDKEndpoint struct {
	SDK     string
	Method  string `json:"method"`
	BaseURL string `json:"base_url"`
	Path    string `json:"path"`
	Params  []struct {
		Name string `json:"name"`
		In   string `json:"in"`
	} `json:"params"`
}

func loadSDK(path string) ([]SDKEndpoint, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var eps []SDKEndpoint
	if err := json.Unmarshal(raw, &eps); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	name := strings.TrimSuffix(filepath.Base(path), ".endpoints.json")
	for i := range eps {
		eps[i].SDK = name
	}
	return eps, nil
}

// shapeKey reduces a path to its literal skeleton so docs and SDK paths compare regardless of
// placeholder names or a trailing slash.
func shapeKey(method, path string) string {
	segs := splitPath(path)
	for i, s := range segs {
		if strings.Contains(s, "{") {
			segs[i] = "{}"
		}
	}
	return method + " /" + strings.Join(segs, "/")
}

// diffParams reports param names an SDK sends that the docs do not list, and docs params no SDK
// knows. Neither side is ground truth; the report asks a person to decide.
func diffParams(op Operation, sdks []SDKEndpoint) []string {
	key := shapeKey(op.Method, op.Path)
	docs := map[string]bool{}
	for _, p := range op.Params {
		docs[p.Name] = true
	}
	sdkHas := map[string][]string{}
	matched := false
	for _, e := range sdks {
		if !strings.HasSuffix(e.BaseURL, apiHost) || shapeKey(e.Method, "/"+strings.TrimPrefix(e.Path, "/")) != key {
			continue
		}
		matched = true
		for _, p := range e.Params {
			if p.In == "path" {
				continue
			}
			sdkHas[p.Name] = appendUnique(sdkHas[p.Name], e.SDK)
		}
	}
	if !matched {
		return nil
	}
	// plivo-python adds callback_url/callback_method to every request for its own async callbacks.
	for _, n := range []string{"callback_url", "callback_method"} {
		if s := sdkHas[n]; len(s) == 1 && s[0] == "plivo-python" {
			delete(sdkHas, n)
		}
	}
	for _, p := range op.PathParams {
		docs[p.Name] = true
		delete(sdkHas, p.Name)
	}
	var notInDocs, notInSDK []string
	for _, n := range sortedKeys(sdkHas) {
		if !docs[n] {
			notInDocs = append(notInDocs, fmt.Sprintf("%s (%s)", n, strings.Join(sdkHas[n], "+")))
		}
	}
	for n := range docs {
		if _, ok := sdkHas[n]; !ok {
			notInSDK = append(notInSDK, n)
		}
	}
	sort.Strings(notInSDK)
	var out []string
	if len(notInDocs) > 0 {
		out = append(out, fmt.Sprintf("%s — SDK sends, docs omit: %s", op.ID, strings.Join(notInDocs, ", ")))
	}
	if len(notInSDK) > 0 {
		out = append(out, fmt.Sprintf("%s — docs list, no SDK sends: %s", op.ID, strings.Join(notInSDK, ", ")))
	}
	return out
}
