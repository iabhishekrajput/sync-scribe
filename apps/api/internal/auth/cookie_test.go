package auth

import (
	"errors"
	"strings"
	"testing"
	"time"
)

type payload struct {
	V string `json:"v"`
}

var testSecret = []byte("0123456789abcdef0123456789abcdef")

func TestEncodeDecode_Roundtrip(t *testing.T) {
	in := payload{V: "hello"}
	enc, err := Encode(testSecret, in, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}

	var out payload
	if err := Decode(testSecret, enc, &out); err != nil {
		t.Fatal(err)
	}
	if out.V != "hello" {
		t.Fatalf("got %q want hello", out.V)
	}
}

func TestDecode_DetectsTampering(t *testing.T) {
	enc, err := Encode(testSecret, payload{V: "ok"}, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	// Flip a bit in the signature.
	idx := strings.LastIndex(enc, ".")
	last := enc[len(enc)-1]
	flipped := byte('A')
	if last == 'A' {
		flipped = 'B'
	}
	tampered := enc[:idx+1] + string(rune(flipped)) + enc[idx+2:]

	var out payload
	err = Decode(testSecret, tampered, &out)
	if !errors.Is(err, ErrCookieTampered) {
		t.Fatalf("expected ErrCookieTampered, got %v", err)
	}
}

func TestDecode_RejectsExpired(t *testing.T) {
	enc, err := Encode(testSecret, payload{V: "stale"}, time.Now().Add(-time.Second))
	if err != nil {
		t.Fatal(err)
	}
	var out payload
	err = Decode(testSecret, enc, &out)
	if !errors.Is(err, ErrCookieExpired) {
		t.Fatalf("expected ErrCookieExpired, got %v", err)
	}
}

func TestDecode_RejectsWrongSecret(t *testing.T) {
	enc, err := Encode(testSecret, payload{V: "ok"}, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	var out payload
	err = Decode([]byte("a-different-secret-that-is-32-len!"), enc, &out)
	if !errors.Is(err, ErrCookieTampered) {
		t.Fatalf("expected ErrCookieTampered, got %v", err)
	}
}
