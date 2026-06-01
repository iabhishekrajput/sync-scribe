package sync

import (
	"encoding/json"
	"errors"
	"io"
)

var errBadAwareness = errors.New("bad awareness update")

func parseAwarenessClocks(blob []byte) (map[uint64]uint64, error) {
	r := byteReader{b: blob}
	count, err := r.readVarUint()
	if err != nil {
		return nil, err
	}
	out := make(map[uint64]uint64, count)
	for range count {
		clientID, err := r.readVarUint()
		if err != nil {
			return nil, err
		}
		clock, err := r.readVarUint()
		if err != nil {
			return nil, err
		}
		stateLen, err := r.readVarUint()
		if err != nil {
			return nil, err
		}
		if stateLen > uint64(len(r.b)-r.i) {
			return nil, errBadAwareness
		}
		r.i += int(stateLen)
		out[clientID] = clock
	}
	if r.i != len(r.b) {
		return nil, errBadAwareness
	}
	return out, nil
}

func encodeAwarenessRemoval(clocks map[uint64]uint64) []byte {
	if len(clocks) == 0 {
		return nil
	}
	w := make([]byte, 0, len(clocks)*8)
	w = appendVarUint(w, uint64(len(clocks)))
	for clientID, clock := range clocks {
		w = appendVarUint(w, clientID)
		w = appendVarUint(w, clock+1)
		w = appendVarString(w, "null")
	}
	return w
}

func sanitizeGuestAwareness(blob []byte) ([]byte, error) {
	r := byteReader{b: blob}
	count, err := r.readVarUint()
	if err != nil {
		return nil, err
	}
	out := appendVarUint(nil, count)
	for range count {
		clientID, err := r.readVarUint()
		if err != nil {
			return nil, err
		}
		clock, err := r.readVarUint()
		if err != nil {
			return nil, err
		}
		raw, err := r.readVarString()
		if err != nil {
			return nil, err
		}
		state := sanitizeGuestAwarenessState(raw)
		out = appendVarUint(out, clientID)
		out = appendVarUint(out, clock)
		out = appendVarString(out, state)
	}
	if r.i != len(r.b) {
		return nil, errBadAwareness
	}
	return out, nil
}

func sanitizeGuestAwarenessState(raw string) string {
	if raw == "null" {
		return raw
	}
	var state map[string]any
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return `{"user":{"name":"Guest","actor":"guest","color":"#737373"}}`
	}
	user, _ := state["user"].(map[string]any)
	color, _ := user["color"].(string)
	if color == "" {
		color = "#737373"
	}
	typingAt := user["typingAt"]
	state["user"] = map[string]any{
		"name":     "Guest",
		"actor":    "guest",
		"color":    color,
		"typingAt": typingAt,
	}
	b, err := json.Marshal(state)
	if err != nil {
		return `{"user":{"name":"Guest","actor":"guest","color":"#737373"}}`
	}
	return string(b)
}

type byteReader struct {
	b []byte
	i int
}

func (r *byteReader) readVarUint() (uint64, error) {
	var out uint64
	var shift uint
	for {
		if r.i >= len(r.b) {
			return 0, io.ErrUnexpectedEOF
		}
		b := r.b[r.i]
		r.i++
		out |= uint64(b&0x7f) << shift
		if b < 0x80 {
			return out, nil
		}
		shift += 7
		if shift > 63 {
			return 0, errBadAwareness
		}
	}
}

func (r *byteReader) readVarString() (string, error) {
	n, err := r.readVarUint()
	if err != nil {
		return "", err
	}
	if n > uint64(len(r.b)-r.i) {
		return "", errBadAwareness
	}
	start := r.i
	r.i += int(n)
	return string(r.b[start:r.i]), nil
}

func (r *byteReader) readVarBytes() ([]byte, error) {
	n, err := r.readVarUint()
	if err != nil {
		return nil, err
	}
	if n > uint64(len(r.b)-r.i) {
		return nil, errBadAwareness
	}
	start := r.i
	r.i += int(n)
	return append([]byte(nil), r.b[start:r.i]...), nil
}

func appendVarUint(out []byte, n uint64) []byte {
	for n > 0x7f {
		out = append(out, byte(n&0x7f|0x80))
		n >>= 7
	}
	return append(out, byte(n))
}

func appendVarString(out []byte, s string) []byte {
	out = appendVarUint(out, uint64(len(s)))
	return append(out, s...)
}

func appendVarBytes(out []byte, payload []byte) []byte {
	out = appendVarUint(out, uint64(len(payload)))
	return append(out, payload...)
}
