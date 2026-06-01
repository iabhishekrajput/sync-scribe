package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
)

// PKCE per RFC 7636. We use code_challenge_method=S256 throughout.

// NewVerifier returns a high-entropy URL-safe code_verifier.
// 32 random bytes → 43 chars base64url, well within the 43–128 spec range.
func NewVerifier() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// Challenge derives the S256 code_challenge from a verifier.
func Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// NewState returns 16 random bytes encoded as URL-safe base64. Used as the
// OAuth `state` parameter to bind the callback to the original request.
func NewState() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
