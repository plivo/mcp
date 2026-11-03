package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestChunkDocsSplitsPagesAndHeadingsButNotCode(t *testing.T) {
	src := strings.Join([]string{
		"# Speak",
		"Source: https://plivo.com/docs/voice/xml/speak",
		"",
		"Reads text aloud. AT\\&T and account\\_id.",
		"",
		"## Basic Usage",
		"",
		"```bash",
		"# install the SDK",
		"## not a heading",
		"echo a\\&b",
		"```",
		"",
		"***",
		"### Attributes",
		"voice and language.",
		"# Not a page",
		"no Source line follows, so this is text",
		"# Play",
		"Source: https://plivo.com/docs/voice/xml/play",
		"## Usage",
		"Plays a file.",
	}, "\n")

	got := ChunkDocs(src)
	want := []DocChunk{
		{Title: "Speak", URL: "https://plivo.com/docs/voice/xml/speak", Text: "Reads text aloud. AT&T and account_id."},
		{Title: "Speak", Section: "Basic Usage", URL: "https://plivo.com/docs/voice/xml/speak",
			Text: "```bash\n# install the SDK\n## not a heading\necho a\\&b\n```"},
		{Title: "Speak", Section: "Basic Usage › Attributes", URL: "https://plivo.com/docs/voice/xml/speak",
			Text: "voice and language.\n# Not a page\nno Source line follows, so this is text"},
		{Title: "Play", Section: "Usage", URL: "https://plivo.com/docs/voice/xml/play", Text: "Plays a file."},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %#v\nwant %#v", got, want)
	}
}

func TestSplitParagraphsNeverCutsACodeSample(t *testing.T) {
	// 150 chars
	para := strings.Repeat("word ", 30)
	sample := "```\n" + strings.Repeat("line of code\n", 20) + "\n" + strings.Repeat("more code\n", 20) + "```"
	text := strings.Join([]string{para, para, sample, para}, "\n\n")

	parts := splitParagraphs(text, 300)
	if len(parts) < 2 {
		t.Fatalf("expected the text to be split, got %d part", len(parts))
	}
	whole := false
	for _, p := range parts {
		whole = whole || strings.Contains(p, sample)
		if strings.Count(p, "```")%2 != 0 {
			t.Fatalf("a part holds half a code fence: %q", p)
		}
	}
	if !whole {
		t.Fatalf("no part holds the whole code sample: %q", parts)
	}
}

func TestChunkDocsScrubsSampleCredentials(t *testing.T) {
	src := strings.Join([]string{
		"# Subaccount",
		"Source: https://plivo.com/docs/account/api/subaccount",
		"",
		"```json",
		`{"resource_uri": "/v1/Account/MA2025RK4E639VJFZAGV/Subaccount/SA2025RK4E639VJFZAMM/",`,
		`  "auth_token": "` + strings.Repeat("x", 40) + `"}`,
		"```",
		"Put sk-your_openai_key in the agent's settings.",
	}, "\n")
	got := ChunkDocs(src)[0].Text
	want := "```json\n" +
		`{"resource_uri": "/v1/Account/<auth_id>/Subaccount/<subaccount_auth_id>/",` + "\n" +
		`  "auth_token": "<auth_token>"}` + "\n```\n" +
		"Put <api_key> in the agent's settings."
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}
