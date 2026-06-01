package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// Signed cookie helpers. Format: base64url(payload) "." base64url(hmac).
// Payload is JSON-encoded by the caller. We don't encrypt — the only thing
// stored here is short-lived flow state and refresh tokens, and the user's
// own browser is the audience.

var ErrCookieTampered = errors.New("cookie signature mismatch")
var ErrCookieExpired = errors.New("cookie expired")

func sign(secret, payload []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Encode signs and serializes the payload. expiresAt is embedded so the server
// can reject stale cookies even before the browser drops them.
func Encode(secret []byte, payload any, expiresAt time.Time) (string, error) {
	envelope := struct {
		ExpiresAt int64           `json:"exp"`
		Data      json.RawMessage `json:"d"`
	}{ExpiresAt: expiresAt.Unix()}

	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	envelope.Data = raw

	body, err := json.Marshal(envelope)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding.EncodeToString(body)
	return enc + "." + sign(secret, []byte(enc)), nil
}

// Decode validates the signature, checks expiry, and unmarshals payload into out.
func Decode(secret []byte, raw string, out any) error {
	dot := -1
	for i := 0; i < len(raw); i++ {
		if raw[i] == '.' {
			dot = i
			break
		}
	}
	if dot < 0 {
		return fmt.Errorf("malformed cookie")
	}
	body, sig := raw[:dot], raw[dot+1:]
	expected := sign(secret, []byte(body))
	if !hmac.Equal([]byte(expected), []byte(sig)) {
		return ErrCookieTampered
	}

	bodyBytes, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return err
	}

	var envelope struct {
		ExpiresAt int64           `json:"exp"`
		Data      json.RawMessage `json:"d"`
	}
	if err := json.Unmarshal(bodyBytes, &envelope); err != nil {
		return err
	}
	if time.Now().Unix() > envelope.ExpiresAt {
		return ErrCookieExpired
	}
	return json.Unmarshal(envelope.Data, out)
}

// SetCookie writes a signed httpOnly cookie. secure should mirror the env
// (false in local dev, true in prod) so SameSite=Lax + Secure work together.
func SetCookie(w http.ResponseWriter, name, value string, maxAge time.Duration, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(maxAge.Seconds()),
	})
}

// ClearCookie writes a same-named cookie with MaxAge=-1 to delete it.
func ClearCookie(w http.ResponseWriter, name string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

// MaxAgeFromHeader is a tiny helper for parsing OIDC `expires_in` strings.
func MaxAgeFromHeader(s string) (time.Duration, error) {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, err
	}
	return time.Duration(n) * time.Second, nil
}
