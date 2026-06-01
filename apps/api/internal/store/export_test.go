package store

import (
	"strings"
	"testing"
)

func TestSafeMarkdownFilename(t *testing.T) {
	cases := []struct {
		title string
		want  string
	}{
		{"My Document", "My-Document.md"},
		{"hello world", "hello-world.md"},
		{"  leading-trailing spaces  ", "leading-trailing-spaces.md"},
		// Non-ASCII letters are stripped; spaces become dashes.
		{"café résumé", "caf-rsum.md"},
		{"report_2024", "report_2024.md"},
		{"file-with-dashes-and_underscores", "file-with-dashes-and_underscores.md"},
		// Empty / whitespace-only → Untitled.
		{"", "Untitled.md"},
		{"   ", "Untitled.md"},
		// All non-alphanumeric non-separator chars → Untitled.
		{"!!@#$%^&*()", "Untitled.md"},
		// Long title passes through (no truncation).
		{strings.Repeat("a", 300), strings.Repeat("a", 300) + ".md"},
		{"Hello 123 World", "Hello-123-World.md"},
		// Non-separator symbols are stripped but surrounding letters are kept.
		{"only!!symbols!!", "onlysymbols.md"},
	}
	for _, tc := range cases {
		got := safeMarkdownFilename(tc.title)
		if got != tc.want {
			t.Errorf("safeMarkdownFilename(%q) = %q, want %q", tc.title, got, tc.want)
		}
	}
}
