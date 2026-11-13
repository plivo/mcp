package main

import (
	"strings"
	"testing"
)

func page(body string) string {
	return "# Some API\nSource: https://plivo.com/docs/x/api/y\n\nIntro.\n\n" + body
}

func findOp(t *testing.T, ops []DocOp, method, path string) DocOp {
	t.Helper()
	for _, o := range ops {
		if o.Method == method && o.Path == path {
			return o
		}
	}
	t.Fatalf("op %s %s not parsed; got %d ops", method, path, len(ops))
	return DocOp{}
}

func names(ps []Param) string {
	var n []string
	for _, p := range ps {
		s := p.Name + ":" + p.In + ":" + p.Type
		if p.Required {
			s += "!"
		}
		if p.Deprecated {
			s += "~"
		}
		if p.Default != "" {
			s += "=" + p.Default
		}
		n = append(n, s)
	}
	return strings.Join(n, " ")
}

func TestParseDocsLayouts(t *testing.T) {
	cases := []struct {
		name, src, method, path, want, title, desc string
	}{
		{
			name: "fenced endpoint with bold-typed arguments",
			src: page("## Send a Message\n\nSend an SMS.\n\n```\nPOST https://api.plivo.com/v1/Account/{auth_id}/Message/\n```\n\n" +
				"### Arguments\n\n**src** `string` *required*\n\nSender ID.\n\n**log** `string` (default: true)\n\nLogging.\n\n" +
				"**dlt\\_entity\\_id** `string`\n\nDeprecated. No longer used.\n\n### Response\n\n**api\\_id** `string`\n\nNot a param.\n"),
			method: "POST", path: "/v1/Account/{auth_id}/Message/",
			want:  "src:body:string! log:body:string=true dlt_entity_id:body:string~",
			title: "Send a Message", desc: "Send an SMS.",
		},
		{
			name: "tabbed operations under one section",
			src: page("## Play Audio\n\n> [tab] Start Playing\n>\n> Play an audio file.\n>\n> ```text\n> POST https://api.plivo.com/v1/Account/{auth_id}/Call/{call_uuid}/Play/\n> ```\n>\n" +
				"> ### Arguments\n>\n> **urls** `string` *required*\n>\n> Audio URLs.\n\n> [tab] Stop Playing\n>\n> Stop the audio.\n>\n> ```text\n> DELETE https://api.plivo.com/v1/Account/{auth_id}/Call/{call_uuid}/Play/\n> ```\n"),
			method: "POST", path: "/v1/Account/{auth_id}/Call/{call_uuid}/Play/",
			want:  "urls:body:string!",
			title: "Start Playing", desc: "Play an audio file.",
		},
		{
			name: "inline endpoint with request-parameters section",
			src: page("## List UCC Complaints\n\nFetch complaints.\n\n### HTTP Request\n\n`GET https://api.plivo.com/v1/Account/{auth_id}/Ucc/`\n\n" +
				"### Request Parameters\n\n**status** `string`\n\nFilter.\n\n**limit** `integer` (default: 20)\n\nPage size.\n"),
			method: "GET", path: "/v1/Account/{auth_id}/Ucc/",
			want:  "status:query:string limit:query:integer=20",
			title: "List UCC Complaints", desc: "Fetch complaints.",
		},
		{
			name: "param table with type, required and default columns",
			src: page("## Create a Trunk\n\nCreate a trunk.\n\n### HTTP Request\n\n`POST https://api.plivo.com/v1/Account/{auth_id}/Zentrunk/Trunk/`\n\n" +
				"### Request Parameters\n\n| Parameter | Type | Required | Default | Description |\n| - | - | - | - | - |\n" +
				"| `trunk_direction` | string | Yes | - | Direction |\n| `secure` | boolean | No | `false` | TLS |\n| `ipacl_uuid` | string | Conditional | - | IP ACL |\n"),
			method: "POST", path: "/v1/Account/{auth_id}/Zentrunk/Trunk/",
			want:  "trunk_direction:body:string! secure:body:boolean=false ipacl_uuid:body:string",
			title: "Create a Trunk",
		},
		{
			name: "required and optional argument tables",
			src: page("## Add a Participant\n\nAdd one.\n\n```\nPOST https://api.plivo.com/v1/Account/{auth_id}/MultiPartyCall/name_{mpc_name}/Participant/\n```\n\n" +
				"### Required Arguments\n\n| Parameter | Description |\n| - | - |\n| `role` | Role. |\n\n" +
				"### Optional Arguments\n\n| Parameter | Default | Description |\n| - | - | - |\n| `ring_timeout` | 45 | Seconds. |\n"),
			method: "POST", path: "/v1/Account/{auth_id}/MultiPartyCall/name_{mpc_name}/Participant/",
			want: "role:body:string! ring_timeout:body:string=45",
		},
		{
			name: "headingless table straight under the endpoint",
			src: page("## Member Operations\n\n**Start Playing**\n\nPlay audio.\n\n```\nPOST https://api.plivo.com/v1/Account/{auth_id}/Conference/{conference_name}/Member/{member_id}/Play/\n```\n\n" +
				"| Parameter | Required | Description |\n| - | - | - |\n| `url` | Yes | Audio URL. |\n\n```bash cURL\ncurl -X POST https://api.plivo.com/x\n```\n"),
			method: "POST", path: "/v1/Account/{auth_id}/Conference/{conference_name}/Member/{member_id}/Play/",
			want:  "url:body:string!",
			title: "Start Playing", desc: "Play audio.",
		},
		{
			name: "comma list, nested item fields and qualifying bold lines",
			src: page("## Link Numbers\n\nLink.\n\n```http\nPOST https://api.plivo.com/v1/Account/{auth_id}/PhoneNumber/Compliance/Link/\n```\n\n### Arguments\n\n" +
				"**numbers** `array` *required*\n\nList.\n\n**numbers\\[].number** `string` *required*\n\nThe number.\n\n" +
				"**created\\_\\_gt, created\\_\\_lt** `string`\n\nRange filters.\n\n**Conditional** - only with numbers.\n"),
			method: "POST", path: "/v1/Account/{auth_id}/PhoneNumber/Compliance/Link/",
			want: "numbers:body:array! created__gt:body:string created__lt:body:string",
		},
		{
			name:   "query placeholder becomes a required query param",
			src:    page("## Delete a Template\n\nDelete.\n\n```http\nDELETE https://api.plivo.com/v1/Account/{auth_id}/WhatsApp/Template/{waba_id}/{template_id}/?name={name}\n```\n"),
			method: "DELETE", path: "/v1/Account/{auth_id}/WhatsApp/Template/{waba_id}/{template_id}/",
			want: "name:query:string!",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ops, _ := ParseDocs(c.src)
			op := findOp(t, ops, c.method, c.path)
			if got := names(op.Params); got != c.want {
				t.Errorf("params\n got: %s\nwant: %s", got, c.want)
			}
			if c.title != "" && op.Title != c.title {
				t.Errorf("title %q, want %q", op.Title, c.title)
			}
			if c.desc != "" && op.Description != c.desc {
				t.Errorf("description %q, want %q", op.Description, c.desc)
			}
		})
	}
}

func TestParseDocsNestedAndListDescriptions(t *testing.T) {
	src := page("## Link Numbers\n\nLink.\n\n```http\nPOST https://api.plivo.com/v1/Account/{auth_id}/X/\n```\n\n### Arguments\n\n" +
		"**numbers** `array` *required*\n\nList.\n\n**numbers\\[].number** `string` *required*\n\nThe number.\n\n" +
		"**created\\_\\_gt, created\\_\\_lt** `string`\n\nRange filters.\n")
	ops, anomalies := ParseDocs(src)
	if len(anomalies) != 0 {
		t.Fatalf("unexpected anomalies: %+v", anomalies)
	}
	op := findOp(t, ops, "POST", "/v1/Account/{auth_id}/X/")
	if len(op.Params[0].Items) != 1 || op.Params[0].Items[0].Name != "number" || !op.Params[0].Items[0].Required {
		t.Errorf("numbers[].number not attached to numbers: %+v", op.Params[0].Items)
	}
	if op.Params[1].Description != "Range filters." || op.Params[2].Description != "Range filters." {
		t.Errorf("comma-list names should share the description: %q / %q", op.Params[1].Description, op.Params[2].Description)
	}
}

func TestParseDocsMultipleOpsInOneSection(t *testing.T) {
	src := page("## Record a Call\n\n**Start Recording**\n\n```text\nPOST https://api.plivo.com/v1/Account/{auth_id}/Call/{call_uuid}/Record/\n```\n\n" +
		"### Arguments\n\n**time\\_limit** `integer`\n\nMax seconds.\n\n**Stop Recording**\n\n```text\nDELETE https://api.plivo.com/v1/Account/{auth_id}/Call/{call_uuid}/Record/\n```\n\n" +
		"### Arguments\n\n**URL** `string`\n\nNot a param.\n")
	ops, anomalies := ParseDocs(src)
	start := findOp(t, ops, "POST", "/v1/Account/{auth_id}/Call/{call_uuid}/Record/")
	stop := findOp(t, ops, "DELETE", "/v1/Account/{auth_id}/Call/{call_uuid}/Record/")
	if start.Title != "Start Recording" || stop.Title != "Stop Recording" {
		t.Errorf("titles %q / %q", start.Title, stop.Title)
	}
	if names(start.Params) != "time_limit:body:integer" || len(stop.Params) != 0 {
		t.Errorf("params start=%q stop=%q", names(start.Params), names(stop.Params))
	}
	if len(anomalies) != 1 || !strings.Contains(anomalies[0].Text, `"URL"`) {
		t.Errorf("the URL line should be reported as a skipped non-param: %+v", anomalies)
	}
}

func TestParseDocsIgnoresSampleBlocks(t *testing.T) {
	src := page("## Make a Call\n\nCall.\n\n```json\nPOST https://api.plivo.com/v1/Account/{auth_id}/Nope/\n```\n\n" +
		"```bash cURL\ncurl -X POST https://api.plivo.com/v1/Account/{auth_id}/AlsoNope/\n```\n")
	if ops, _ := ParseDocs(src); len(ops) != 0 {
		t.Fatalf("sample blocks must not become ops: %+v", ops)
	}
}

func TestParseDocsSampleRequestDoesNotStealParams(t *testing.T) {
	src := page("## Update a Number\n\nUpdate.\n\n```\nPOST https://api.plivo.com/v1/Account/{auth_id}/Number/{number}/\n```\n\n" +
		"### Example\n\n```http\nPOST https://api.plivo.com/v1/Account/{auth_id}/Number/14155550100/\n```\n\n" +
		"### Arguments\n\n**alias** `string`\n\nA name.\n")
	ops, _ := ParseDocs(src)
	if len(ops) != 1 || names(ops[0].Params) != "alias:body:string" {
		t.Fatalf("the sample request must not start an op or take the params: %+v", ops)
	}
}
