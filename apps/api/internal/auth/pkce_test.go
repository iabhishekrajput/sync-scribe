package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestNewVerifier_RFC7636(t *testing.T) {
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	if len(v) < 43 || len(v) > 128 {
		t.Fatalf("verifier length %d out of RFC 7636 range [43,128]", len(v))
	}
	for _, c := range v {
		ok := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_'
		if !ok {
			t.Fatalf("verifier contains non-unreserved character %q", c)
		}
	}
}

func TestChallenge_MatchesS256(t *testing.T) {
	v := "test-verifier-1234567890-abcdefghijklmnopqrstuvwxyz"
	got := Challenge(v)

	sum := sha256.Sum256([]byte(v))
	want := base64.RawURLEncoding.EncodeToString(sum[:])

	if got != want {
		t.Fatalf("Challenge mismatch:\n got  %s\n want %s", got, want)
	}
}

func TestNewState_Unique(t *testing.T) {
	seen := make(map[string]bool, 100)
	for i := 0; i < 100; i++ {
		s, err := NewState()
		if err != nil {
			t.Fatal(err)
		}
		if seen[s] {
			t.Fatalf("collision after %d iterations: %s", i, s)
		}
		seen[s] = true
	}
}
