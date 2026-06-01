package sync

import (
	"encoding/json"
	"testing"
)

func TestAwarenessRemovalUsesNextClockAndNullState(t *testing.T) {
	update := appendVarUint(nil, 1)
	update = appendVarUint(update, 42)
	update = appendVarUint(update, 7)
	update = appendVarString(update, `{"user":{"name":"RZ"}}`)

	clocks, err := parseAwarenessClocks(update)
	if err != nil {
		t.Fatalf("parse awareness: %v", err)
	}
	if got := clocks[42]; got != 7 {
		t.Fatalf("clock = %d, want 7", got)
	}

	removal := encodeAwarenessRemoval(clocks)
	removed, err := parseAwarenessClocks(removal)
	if err != nil {
		t.Fatalf("parse removal: %v", err)
	}
	if got := removed[42]; got != 8 {
		t.Fatalf("removal clock = %d, want 8", got)
	}
}

func TestParseAwarenessRejectsTrailingBytes(t *testing.T) {
	update := appendVarUint(nil, 0)
	update = append(update, 1)
	if _, err := parseAwarenessClocks(update); err == nil {
		t.Fatal("expected trailing byte error")
	}
}

func TestSanitizeGuestAwarenessDropsIdentifyingFields(t *testing.T) {
	update := appendVarUint(nil, 1)
	update = appendVarUint(update, 42)
	update = appendVarUint(update, 7)
	update = appendVarString(update, `{"user":{"name":"Alice","email":"alice@example.com","actor":"human","color":"#123456","typingAt":99},"cursor":{"anchor":1}}`)

	sanitized, err := sanitizeGuestAwareness(update)
	if err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	r := byteReader{b: sanitized}
	count, _ := r.readVarUint()
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}
	_, _ = r.readVarUint()
	_, _ = r.readVarUint()
	raw, err := r.readVarString()
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	var state map[string]any
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		t.Fatalf("json: %v", err)
	}
	user := state["user"].(map[string]any)
	if user["email"] != nil {
		t.Fatalf("email leaked: %v", user)
	}
	if user["name"] != "Guest" || user["actor"] != "guest" || user["color"] != "#123456" {
		t.Fatalf("bad sanitized user: %v", user)
	}
	if user["typingAt"].(float64) != 99 {
		t.Fatalf("typingAt not preserved: %v", user)
	}
}
