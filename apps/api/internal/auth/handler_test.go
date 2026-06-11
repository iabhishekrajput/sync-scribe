package auth

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

func TestCallback_AllowsProviderWithoutRefreshToken(t *testing.T) {
	handler := refreshTestHandler()
	handler.FrontendBaseURL = "https://app.example.test"
	req := httptest.NewRequest(http.MethodGet, "/auth/callback?code=auth-code&state=flow-state", nil)
	req = req.WithContext(context.WithValue(req.Context(), oauth2.HTTPClient, &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if got := r.Form.Get("code"); got != "auth-code" {
				t.Fatalf("code = %q, want auth-code", got)
			}
			return jsonTokenResponse(`{"access_token":"access-only","token_type":"Bearer","expires_in":1800}`), nil
		}),
	}))
	addFlowCookie(t, req, flowState{
		State:    "flow-state",
		Verifier: "verifier",
		ReturnTo: "/d/doc-1",
	})
	rr := httptest.NewRecorder()

	handler.Callback(rr, req)

	if rr.Code != http.StatusFound {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Location"); got != "https://app.example.test/d/doc-1" {
		t.Fatalf("Location = %q", got)
	}
	session := decodeSessionCookie(t, rr.Result())
	if session.AccessToken != "access-only" {
		t.Fatalf("cookie access token = %q, want access-only", session.AccessToken)
	}
	if session.RefreshToken != "" {
		t.Fatalf("cookie refresh token = %q, want empty", session.RefreshToken)
	}
}

func TestRefresh_UsesRefreshTokenAndRotatesCookie(t *testing.T) {
	handler := refreshTestHandler()
	req := httptest.NewRequest(http.MethodPost, "/auth/refresh", nil)
	req = req.WithContext(context.WithValue(req.Context(), oauth2.HTTPClient, &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if got := r.Form.Get("grant_type"); got != "refresh_token" {
				t.Fatalf("grant_type = %q, want refresh_token", got)
			}
			if got := r.Form.Get("refresh_token"); got != "old-refresh" {
				t.Fatalf("refresh_token = %q, want old-refresh", got)
			}
			return jsonTokenResponse(`{"access_token":"new-access","refresh_token":"new-refresh","token_type":"Bearer","expires_in":3600}`), nil
		}),
	}))
	addSessionCookie(t, req, sessionState{
		AccessToken:  "old-access",
		RefreshToken: "old-refresh",
		ExpiresAt:    time.Now().Add(-time.Minute).Unix(),
	})
	rr := httptest.NewRecorder()

	handler.Refresh(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var body refreshResponse
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.AccessToken != "new-access" {
		t.Fatalf("access_token = %q, want new-access", body.AccessToken)
	}

	session := decodeSessionCookie(t, rr.Result())
	if session.AccessToken != "new-access" {
		t.Fatalf("cookie access token = %q, want new-access", session.AccessToken)
	}
	if session.RefreshToken != "new-refresh" {
		t.Fatalf("cookie refresh token = %q, want new-refresh", session.RefreshToken)
	}
	if session.ExpiresAt <= time.Now().Unix() {
		t.Fatalf("cookie expiry = %d, want future", session.ExpiresAt)
	}
}

func TestRefresh_KeepsRefreshTokenWhenProviderDoesNotRotate(t *testing.T) {
	handler := refreshTestHandler()
	req := httptest.NewRequest(http.MethodPost, "/auth/refresh", nil)
	req = req.WithContext(context.WithValue(req.Context(), oauth2.HTTPClient, &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return jsonTokenResponse(`{"access_token":"new-access","token_type":"Bearer","expires_in":1800}`), nil
		}),
	}))
	addSessionCookie(t, req, sessionState{
		AccessToken:  "old-access",
		RefreshToken: "stable-refresh",
		ExpiresAt:    time.Now().Add(-time.Minute).Unix(),
	})
	rr := httptest.NewRecorder()

	handler.Refresh(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	session := decodeSessionCookie(t, rr.Result())
	if session.RefreshToken != "stable-refresh" {
		t.Fatalf("cookie refresh token = %q, want stable-refresh", session.RefreshToken)
	}
}

func TestRefresh_AllowsLegacyUnexpiredAccessTokenCookie(t *testing.T) {
	handler := refreshTestHandler()
	req := httptest.NewRequest(http.MethodPost, "/auth/refresh", nil)
	addSessionCookie(t, req, sessionState{
		AccessToken: "legacy-access",
		ExpiresAt:   time.Now().Add(time.Hour).Unix(),
	})
	rr := httptest.NewRecorder()

	handler.Refresh(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var body refreshResponse
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.AccessToken != "legacy-access" {
		t.Fatalf("access_token = %q, want legacy-access", body.AccessToken)
	}
}

func refreshTestHandler() *Handler {
	return &Handler{
		P: &Provider{
			OAuth2: &oauth2.Config{
				Endpoint: oauth2.Endpoint{TokenURL: "https://auth.example.test/token"},
			},
		},
		CookieSecret: testSecret,
	}
}

func addSessionCookie(t *testing.T, r *http.Request, session sessionState) {
	t.Helper()
	enc, err := Encode(testSecret, session, time.Now().Add(sessionCookieTTL))
	if err != nil {
		t.Fatal(err)
	}
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: enc})
}

func addFlowCookie(t *testing.T, r *http.Request, flow flowState) {
	t.Helper()
	enc, err := Encode(testSecret, flow, time.Now().Add(flowCookieTTL))
	if err != nil {
		t.Fatal(err)
	}
	r.AddCookie(&http.Cookie{Name: flowCookieName, Value: enc})
}

func decodeSessionCookie(t *testing.T, res *http.Response) sessionState {
	t.Helper()
	for _, cookie := range res.Cookies() {
		if cookie.Name != sessionCookieName {
			continue
		}
		var session sessionState
		if err := Decode(testSecret, cookie.Value, &session); err != nil {
			t.Fatal(err)
		}
		return session
	}
	t.Fatal("session cookie not set")
	return sessionState{}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func jsonTokenResponse(body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
