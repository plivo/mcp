package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// seg is one path segment of a CLI URL: a literal, an unknown value ({}), a reference to a
// parameter of the enclosing function, or that function's variadic tail.
type seg struct {
	lit string
	// -1 unless the segment is the enclosing function's param.
	param    int
	variadic bool
}

var anySeg = seg{param: -1}

func (s seg) isVar() bool { return s.lit == "" && s.param < 0 && !s.variadic }

// val is an evaluated method or URL: a URL is account-relative segments, or nonAccount for
// paths outside /v1/Account/{auth_id}/. wholeParam >= 0 means the value is that parameter as a whole.
type val struct {
	segs       []seg
	nonAccount string
	wholeParam int
	method     string
	ok         bool
}

// CLIUse is one (method, path) the CLI calls.
type CLIUse struct {
	Method string
	// Literal segments, "" for any value.
	Segs    []string
	Spend   bool
	Sources []string
}

type CLIInventory struct {
	Uses       map[string]*CLIUse
	Unresolved []string
}

type cliFunc struct {
	decl     *ast.FuncDecl
	file     string
	params   []string
	variadic int
	spend    bool
	locals   map[string]ast.Expr
}

// ScanCLI inventories every API call in plivo-cli's cmd package.
func ScanCLI(root string) (*CLIInventory, error) {
	dir := filepath.Join(root, "cmd")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	fset := token.NewFileSet()
	funcs := map[string]*cliFunc{}
	var unmodelled []string
	for _, e := range entries {
		n := e.Name()
		if !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(dir, n), nil, 0)
		if err != nil {
			return nil, err
		}
		var varInits []ast.Stmt
		for _, d := range f.Decls {
			if gd, ok := d.(*ast.GenDecl); ok && gd.Tok == token.VAR {
				for _, sp := range gd.Specs {
					for _, v := range sp.(*ast.ValueSpec).Values {
						varInits = append(varInits, &ast.ExprStmt{X: v})
					}
				}
				continue
			}
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Body == nil {
				continue
			}
			// Methods and init funcs are not modelled (init can repeat per package). If one makes an
			// API call or guards spend, stop the build for a person to look rather than miss it.
			if fd.Recv != nil || fd.Name.Name == "init" {
				if makesAPICallOrGuards(fd.Body) {
					unmodelled = append(unmodelled, fmt.Sprintf("%s:%s (method or init with an API call or guardSpend)", n, fd.Name.Name))
				}
				continue
			}
			funcs[fd.Name.Name] = newCLIFunc(fd, n)
		}
		// Package-level initializers (`var x = helper("Publish")`) are call sites too.
		if len(varInits) > 0 {
			name := "var@" + n
			funcs[name] = newCLIFunc(&ast.FuncDecl{
				Name: ast.NewIdent(name),
				Type: &ast.FuncType{Params: &ast.FieldList{}},
				Body: &ast.BlockStmt{List: varInits},
			}, n)
		}
	}
	inv := &CLIInventory{Uses: map[string]*CLIUse{}, Unresolved: unmodelled}
	s := &scanner{funcs: funcs, inv: inv, reach: map[string]bool{}}
	s.callers = callGraph(funcs)
	for _, name := range sortedKeys(funcs) {
		s.scanFunc(funcs[name])
	}
	sort.Strings(inv.Unresolved)
	return inv, nil
}

func makesAPICallOrGuards(body *ast.BlockStmt) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok {
			if _, _, ok := apiCall(call); ok {
				found = true
			}
			if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "guardSpend" {
				found = true
			}
		}
		return !found
	})
	return found
}

// callGraph maps each function to the functions that call it.
func callGraph(funcs map[string]*cliFunc) map[string][]string {
	callers := map[string][]string{}
	for _, name := range sortedKeys(funcs) {
		ast.Inspect(funcs[name].decl.Body, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if id, ok := call.Fun.(*ast.Ident); ok && funcs[id.Name] != nil && id.Name != name {
					callers[id.Name] = appendUnique(callers[id.Name], name)
				}
			}
			return true
		})
	}
	return callers
}

func newCLIFunc(fd *ast.FuncDecl, file string) *cliFunc {
	cf := &cliFunc{decl: fd, file: file, variadic: -1, locals: map[string]ast.Expr{}}
	for _, fl := range fd.Type.Params.List {
		_, isEll := fl.Type.(*ast.Ellipsis)
		for _, n := range fl.Names {
			if isEll {
				cf.variadic = len(cf.params)
			}
			cf.params = append(cf.params, n.Name)
		}
	}
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.CallExpr:
			if id, ok := v.Fun.(*ast.Ident); ok && id.Name == "guardSpend" {
				cf.spend = true
			}
		case *ast.AssignStmt:
			if len(v.Lhs) == len(v.Rhs) {
				for i, l := range v.Lhs {
					if id, ok := l.(*ast.Ident); ok {
						cf.locals[id.Name] = v.Rhs[i]
					}
				}
			}
		}
		return true
	})
	return cf
}

type scanner struct {
	funcs   map[string]*cliFunc
	inv     *CLIInventory
	callers map[string][]string
	reach   map[string]bool
}

// spendReach reports whether f, or anything that calls it, runs guardSpend. A guard in the command
// that calls a request helper must flag that helper's request; over-flagging only adds a prompt.
func (s *scanner) spendReach(f *cliFunc) bool {
	name := f.decl.Name.Name
	if v, ok := s.reach[name]; ok {
		return v
	}
	// Also breaks call cycles.
	s.reach[name] = f.spend
	if !f.spend {
		for _, c := range s.callers[name] {
			if s.spendReach(s.funcs[c]) {
				s.reach[name] = true
				break
			}
		}
	}
	return s.reach[name]
}

func (cf *cliFunc) paramIndex(name string) int {
	for i, p := range cf.params {
		if p == name {
			return i
		}
	}
	return -1
}

func lit(e ast.Expr) (string, bool) {
	if b, ok := e.(*ast.BasicLit); ok && b.Kind == token.STRING {
		s, err := strconv.Unquote(b.Value)
		return s, err == nil
	}
	return "", false
}

// evalMethod resolves a method argument: a literal, http.MethodX, or a param of cf.
func (cf *cliFunc) evalMethod(e ast.Expr) val {
	if s, ok := lit(e); ok {
		return val{method: strings.ToUpper(s), ok: true, wholeParam: -1}
	}
	if sel, ok := e.(*ast.SelectorExpr); ok && strings.HasPrefix(sel.Sel.Name, "Method") {
		return val{method: strings.ToUpper(strings.TrimPrefix(sel.Sel.Name, "Method")), ok: true, wholeParam: -1}
	}
	if id, ok := e.(*ast.Ident); ok {
		if i := cf.paramIndex(id.Name); i >= 0 {
			return val{wholeParam: i, ok: true}
		}
	}
	return val{wholeParam: -1}
}

func (cf *cliFunc) evalSeg(e ast.Expr) seg {
	if s, ok := lit(e); ok {
		return seg{lit: s, param: -1}
	}
	if id, ok := e.(*ast.Ident); ok {
		if i := cf.paramIndex(id.Name); i >= 0 {
			return seg{param: i}
		}
		if rhs, ok := cf.locals[id.Name]; ok {
			if s, ok := lit(rhs); ok {
				return seg{lit: s, param: -1}
			}
		}
	}
	return anySeg
}

// evalURL resolves a URL argument to account-relative segments.
func (cf *cliFunc) evalURL(e ast.Expr, depth int) val {
	if depth > 4 {
		return val{wholeParam: -1}
	}
	switch v := e.(type) {
	case *ast.Ident:
		if i := cf.paramIndex(v.Name); i >= 0 {
			return val{wholeParam: i, ok: true}
		}
		if rhs, ok := cf.locals[v.Name]; ok {
			return cf.evalURL(rhs, depth+1)
		}
	case *ast.BinaryExpr:
		if v.Op != token.ADD {
			break
		}
		left := cf.evalURL(v.X, depth+1)
		tail, ok := lit(v.Y)
		if !left.ok || !ok || left.wholeParam >= 0 || left.nonAccount != "" {
			break
		}
		for _, p := range strings.Split(tail, "/") {
			if p != "" {
				left.segs = append(left.segs, seg{lit: p, param: -1})
			}
		}
		return left
	case *ast.CallExpr:
		name := ""
		switch f := v.Fun.(type) {
		case *ast.SelectorExpr:
			name = f.Sel.Name
		case *ast.Ident:
			name = f.Name
		}
		switch name {
		case "AccountURL":
			out := val{wholeParam: -1, ok: true}
			for j, a := range v.Args {
				if j == len(v.Args)-1 && v.Ellipsis.IsValid() {
					if id, ok := a.(*ast.Ident); ok && cf.paramIndex(id.Name) == cf.variadic && cf.variadic >= 0 {
						out.segs = append(out.segs, seg{param: cf.variadic, variadic: true})
						continue
					}
					return val{wholeParam: -1}
				}
				out.segs = append(out.segs, cf.evalSeg(a))
			}
			return out
		case "mpcResourceURL":
			// mpcResourceURL(client, id, parts...) is AccountURL("MultiPartyCall", "uuid_<id>"|"name_<id>", parts...).
			out := val{wholeParam: -1, ok: true, segs: []seg{{lit: "MultiPartyCall", param: -1}, anySeg}}
			for _, a := range v.Args[2:] {
				out.segs = append(out.segs, cf.evalSeg(a))
			}
			return out
		case "LookupURL":
			return val{wholeParam: -1, ok: true, nonAccount: "/v1/Lookup/Number/{}"}
		}
	}
	return val{wholeParam: -1}
}

// apiCall returns the method and URL arguments of an api.Client request. Both Do and DoMultipart
// take exactly five arguments; net/http's Client.Do takes one, so it never matches.
func apiCall(call *ast.CallExpr) (methodArg, urlArg ast.Expr, ok bool) {
	sel, isSel := call.Fun.(*ast.SelectorExpr)
	if isSel && (sel.Sel.Name == "Do" || sel.Sel.Name == "DoMultipart") && len(call.Args) == 5 {
		return call.Args[0], call.Args[1], true
	}
	return nil, nil, false
}

func (s *scanner) scanFunc(cf *cliFunc) {
	ast.Inspect(cf.decl.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		mArg, uArg, ok := apiCall(call)
		if !ok {
			return true
		}
		m := cf.evalMethod(mArg)
		u := cf.evalURL(uArg, 0)
		src := fmt.Sprintf("%s:%s", cf.file, cf.decl.Name.Name)
		if !m.ok || !u.ok {
			s.inv.Unresolved = append(s.inv.Unresolved, src+" "+exprString(uArg))
			return true
		}
		if !needsInlining(m, u) {
			s.add(m.method, u, s.spendReach(cf), src)
			return true
		}
		// A shared helper (fetchList, postSIP) takes its spend flag per call site, not from every caller.
		s.resolve(cf, m, u, cf.spend, src, 0)
		return true
	})
}

func needsInlining(m, u val) bool {
	if m.wholeParam >= 0 || u.wholeParam >= 0 {
		return true
	}
	for _, sg := range u.segs {
		if sg.param >= 0 {
			return true
		}
	}
	return false
}

// resolve records a request, or, when its method or path comes from cf's params, substitutes the
// arguments at every call site of cf (recursing while those are params of the caller in turn).
func (s *scanner) resolve(cf *cliFunc, m, u val, spend bool, src string, depth int) {
	if !needsInlining(m, u) {
		s.add(m.method, u, spend, src)
		return
	}
	if depth >= 4 {
		s.inv.Unresolved = append(s.inv.Unresolved, src+" (indirection too deep)")
		return
	}
	found := false
	for _, caller := range sortedKeys(s.funcs) {
		g := s.funcs[caller]
		ast.Inspect(g.decl.Body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			id, ok := call.Fun.(*ast.Ident)
			if !ok || id.Name != cf.decl.Name.Name {
				return true
			}
			found = true
			at := fmt.Sprintf("%s:%s→%s", g.file, g.decl.Name.Name, src)
			mv := m
			if m.wholeParam >= 0 {
				if m.wholeParam >= len(call.Args) {
					return true
				}
				mv = g.evalMethod(call.Args[m.wholeParam])
				if !mv.ok {
					s.inv.Unresolved = append(s.inv.Unresolved, at+" (method not literal)")
					return true
				}
			}
			var uv val
			if u.wholeParam >= 0 {
				if u.wholeParam >= len(call.Args) {
					return true
				}
				uv = g.evalURL(call.Args[u.wholeParam], 0)
				if !uv.ok {
					s.inv.Unresolved = append(s.inv.Unresolved, at+" (url not resolvable)")
					return true
				}
			} else {
				uv = val{ok: true, wholeParam: -1, nonAccount: u.nonAccount}
				for _, sg := range u.segs {
					switch {
					case sg.variadic:
						if sg.param < len(call.Args) {
							for _, a := range call.Args[sg.param:] {
								uv.segs = append(uv.segs, g.evalSeg(a))
							}
						}
					case sg.param >= 0:
						if sg.param < len(call.Args) {
							uv.segs = append(uv.segs, g.evalSeg(call.Args[sg.param]))
						} else {
							uv.segs = append(uv.segs, anySeg)
						}
					default:
						uv.segs = append(uv.segs, sg)
					}
				}
			}
			// Intermediate helpers (walkPages → fetchList) add only their own guard; the call site that
			// makes the request concrete adds every guard above it.
			next := spend || g.spend
			if !needsInlining(mv, uv) {
				next = spend || s.spendReach(g)
			}
			s.resolve(g, mv, uv, next, at, depth+1)
			return true
		})
	}
	if !found {
		s.inv.Unresolved = append(s.inv.Unresolved, src+" (helper with no call sites)")
	}
}

func (s *scanner) add(method string, u val, spend bool, src string) {
	var segs []string
	if u.nonAccount != "" {
		segs = []string{"!" + u.nonAccount}
	}
	for _, sg := range u.segs {
		if sg.lit == "" && sg.param < 0 && !sg.variadic {
			segs = append(segs, "")
			continue
		}
		// An empty literal ("") is how callers ask a helper for the bare resource path.
		if sg.lit == "" {
			continue
		}
		segs = append(segs, sg.lit)
	}
	key := method + " /" + strings.Join(segs, "/")
	use, ok := s.inv.Uses[key]
	if !ok {
		use = &CLIUse{Method: method, Segs: segs}
		s.inv.Uses[key] = use
	}
	use.Spend = use.Spend || spend
	use.Sources = appendUnique(use.Sources, src)
}

// Covers reports the CLI uses that match a docs op: same method, same segment count, every CLI
// literal equal to the docs segment. A CLI wildcard is an ID the CLI fills in, so it only matches a
// docs placeholder: /10dlc/Campaign/{id}/ must not cover the literal /10dlc/Campaign/Import/.
func (inv *CLIInventory) Covers(method, accountRelPath string) []*CLIUse {
	docs := splitPath(accountRelPath)
	// A use off the account API is one "!"-marked segment, its {} the CLI's wildcard.
	nonAccount := "!" + placeholderRe.ReplaceAllString(accountRelPath, "{}")
	var out []*CLIUse
	for _, k := range sortedKeys(inv.Uses) {
		u := inv.Uses[k]
		if u.Method == method && len(u.Segs) == 1 && u.Segs[0] == nonAccount {
			out = append(out, u)
			continue
		}
		if u.Method != method || len(u.Segs) != len(docs) {
			continue
		}
		match := true
		for i, sg := range u.Segs {
			if (sg == "" && !strings.Contains(docs[i], "{")) || (sg != "" && sg != docs[i]) {
				match = false
				break
			}
		}
		if match {
			out = append(out, u)
		}
	}
	return out
}

func splitPath(p string) []string {
	var out []string
	for _, s := range strings.Split(p, "/") {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func exprString(e ast.Expr) string {
	switch v := e.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.CallExpr:
		return exprString(v.Fun) + "(…)"
	case *ast.SelectorExpr:
		return exprString(v.X) + "." + v.Sel.Name
	}
	return fmt.Sprintf("%T", e)
}

func appendUnique(xs []string, x string) []string {
	for _, y := range xs {
		if y == x {
			return xs
		}
	}
	return append(xs, x)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
