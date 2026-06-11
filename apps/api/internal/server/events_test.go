package server

import (
	"net/http"
	"testing"
)

func TestParseEventCursor(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "/documents/doc/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseEventCursor(req)
	if err != nil || got != 0 {
		t.Fatalf("empty cursor = %d, %v; want 0, nil", got, err)
	}

	req.Header.Set("Last-Event-ID", "41")
	got, err = parseEventCursor(req)
	if err != nil || got != 41 {
		t.Fatalf("Last-Event-ID cursor = %d, %v; want 41, nil", got, err)
	}

	req, err = http.NewRequest(http.MethodGet, "/documents/doc/events?sinceEventId=99", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Last-Event-ID", "41")
	got, err = parseEventCursor(req)
	if err != nil || got != 99 {
		t.Fatalf("query cursor = %d, %v; want 99, nil", got, err)
	}
}

func TestParseEventCursorRejectsInvalidValues(t *testing.T) {
	for _, raw := range []string{"abc", "-1"} {
		req, err := http.NewRequest(http.MethodGet, "/documents/doc/events?sinceEventId="+raw, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := parseEventCursor(req); err == nil {
			t.Fatalf("parseEventCursor(%q) succeeded, want error", raw)
		}
	}
}
