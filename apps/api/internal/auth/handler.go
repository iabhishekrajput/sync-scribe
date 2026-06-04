package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/oauth2"

	"github.com/abhishek/sync-scribe/api/internal/httpx"
)

const (
	flowCookieName    = "ss_flow"
	sessionCookieName = "ss_session"

	flowCookieTTL = 10 * time.Minute
	// Session cookie outlives the access token so we can detect "had a
	// session, token now expired" and steer the user to re-login cleanly.
	sessionCookieTTL = 24 * time.Hour
)

// Handler wires the OIDC RP HTTP routes. Stateless — all flow state lives in
// short-lived signed cookies. Tokens never traverse the URL or the
// browser-accessible JS scope.
type Handler struct {
	P               *Provider
	CookieSecret    []byte
	CookieSecure    bool
	FrontendBaseURL string
}

type flowState struct {
	State    string `json:"s"`
	Verifier string `json:"v"`
	ReturnTo string `json:"r"`
}

// sessionState holds the access token directly because the IdP at
// auth.anekdote.in doesn't issue refresh tokens (no refresh_token grant in
// discovery). When ExpiresAt passes, the next /auth/refresh call returns 401
// and the frontend kicks the user to /login.
type sessionState struct {
	AccessToken string `json:"at"`
	ExpiresAt   int64  `json:"e"`
}

// Login: GET /auth/login?return_to=/some/path
// Sets a short-lived ss_flow cookie binding state+code_verifier+return_to,
// then 302s to the IdP authorize endpoint with PKCE.
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	state, err := NewState()
	if err != nil {
		httpx.WriteError(w, r, httpx.Internal("Could not start the sign-in flow.", err))
		return
	}
	verifier, err := NewVerifier()
	if err != nil {
		httpx.WriteError(w, r, httpx.Internal("Could not start the sign-in flow.", err))
		return
	}

	returnTo := safeReturnTo(r.URL.Query().Get("return_to"))

	flow := flowState{State: state, Verifier: verifier, ReturnTo: returnTo}
	encoded, err := Encode(h.CookieSecret, flow, time.Now().Add(flowCookieTTL))
	if err != nil {
		httpx.WriteError(w, r, httpx.Internal("Could not start the sign-in flow.", err))
		return
	}
	SetCookie(w, flowCookieName, encoded, flowCookieTTL, h.CookieSecure)

	params := []oauth2.AuthCodeOption{
		oauth2.SetAuthURLParam("code_challenge", Challenge(verifier)),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	}
	// Auth0 requires an audience param to issue a signed JWT access token.
	// Without it Auth0 issues an opaque/JWE token that go-oidc cannot verify.
	if h.P.Audience != "" {
		params = append(params, oauth2.SetAuthURLParam("audience", h.P.Audience))
	}
	authURL := h.P.OAuth2.AuthCodeURL(state, params...)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// Callback: GET /auth/callback?code=...&state=...
// Validates state, exchanges code+verifier for tokens, sets the refresh cookie,
// redirects to the frontend's stored return_to.
func (h *Handler) Callback(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(flowCookieName)
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Sign-in cookie missing. Try signing in again.", err))
		return
	}
	var flow flowState
	if err := Decode(h.CookieSecret, cookie.Value, &flow); err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Sign-in cookie is invalid or expired. Try again.", err))
		return
	}
	ClearCookie(w, flowCookieName, h.CookieSecure)

	if state := r.URL.Query().Get("state"); state != flow.State {
		httpx.WriteError(w, r, httpx.BadRequest("Sign-in state mismatch. Try again.", nil))
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		httpx.WriteError(w, r, httpx.BadRequest("Sign-in callback is missing the authorization code.", nil))
		return
	}

	tok, err := h.P.OAuth2.Exchange(r.Context(), code,
		oauth2.SetAuthURLParam("code_verifier", flow.Verifier),
	)
	if err != nil {
		httpx.WriteError(w, r, httpx.BadGateway("The identity provider rejected the token exchange.", err))
		return
	}

	// Validate the ID token strictly (aud == client_id). Belt-and-braces: the
	// access token gets re-verified by the Bearer middleware on every call.
	rawID, _ := tok.Extra("id_token").(string)
	if rawID != "" {
		if _, err := h.P.IDVerifier.Verify(r.Context(), rawID); err != nil {
			httpx.WriteError(w, r, httpx.BadGateway("The identity provider returned an invalid id_token.", err))
			return
		}
	}

	if tok.AccessToken == "" {
		httpx.WriteError(w, r, httpx.BadGateway("The identity provider did not return an access token.", nil))
		return
	}
	session := sessionState{
		AccessToken: tok.AccessToken,
		ExpiresAt:   tok.Expiry.Unix(),
	}
	enc, err := Encode(h.CookieSecret, session, time.Now().Add(sessionCookieTTL))
	if err != nil {
		httpx.WriteError(w, r, httpx.Internal("Could not save the session cookie.", err))
		return
	}
	SetCookie(w, sessionCookieName, enc, sessionCookieTTL, h.CookieSecure)

	// Defense-in-depth — the flow cookie is HMAC-signed so a tampered
	// ReturnTo can't reach here, but if a future code path ever serializes
	// a raw URL into ReturnTo this guard keeps the redirect on our origin.
	dest := h.FrontendBaseURL + safeReturnTo(flow.ReturnTo)
	http.Redirect(w, r, dest, http.StatusFound)
}

// safeReturnTo collapses to "/" unless the value is a clearly-relative path
// under our frontend. Rejects absolute URLs, scheme prefixes, and the
// "//host" protocol-relative form.
func safeReturnTo(p string) string {
	if p == "" {
		return "/"
	}
	if !strings.HasPrefix(p, "/") {
		return "/"
	}
	if strings.HasPrefix(p, "//") {
		return "/"
	}
	// Reject backslashes — some browsers normalize \evil to /evil-host.
	if strings.ContainsAny(p, "\\\r\n") {
		return "/"
	}
	return p
}

// Refresh: POST /auth/refresh
// Reads the refresh cookie, exchanges it for a new access token, returns
// { access_token, expires_in } as JSON. Frontend holds the access token in
// memory and attaches it as Bearer on REST + WS calls.
type refreshResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
	TokenType   string `json:"token_type"`
}

func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		httpx.WriteError(w, r, httpx.Unauthenticated("Sign in to continue.", err))
		return
	}
	var ss sessionState
	if err := Decode(h.CookieSecret, cookie.Value, &ss); err != nil {
		if errors.Is(err, ErrCookieExpired) {
			ClearCookie(w, sessionCookieName, h.CookieSecure)
		}
		httpx.WriteError(w, r, httpx.Unauthenticated("Your session is invalid. Sign in again to continue.", err))
		return
	}

	now := time.Now().Unix()
	if ss.ExpiresAt <= now {
		ClearCookie(w, sessionCookieName, h.CookieSecure)
		httpx.WriteError(w, r, httpx.Unauthenticated("Your session has expired. Sign in again to continue.", nil))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(refreshResponse{
		AccessToken: ss.AccessToken,
		ExpiresIn:   ss.ExpiresAt - now,
		TokenType:   "Bearer",
	})
}

// Logout: POST /auth/logout
// Clears the session cookie. The IdP session is left intact — we don't drive
// federated single-logout in M1.
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	ClearCookie(w, sessionCookieName, h.CookieSecure)
	w.WriteHeader(http.StatusNoContent)
}

// Me: GET /api/me
// Requires the Bearer middleware to have attached a Principal.
func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	p := FromContext(r.Context())
	if p == nil {
		httpx.WriteError(w, r, httpx.Unauthenticated("Sign in to continue.", nil))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(p)
}

