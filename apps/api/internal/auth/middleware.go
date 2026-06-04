package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/abhishek/sync-scribe/api/internal/httpx"
)

// Middleware validates a Bearer access token on every protected request,
// attaches a Principal to the context, and rejects unauthenticated requests
// with the typed JSON envelope. Designed to be cheap on the hot path —
// token verification reuses the underlying go-oidc KeySet cache.
func (p *Provider) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, err := p.PrincipalFromRequest(r)
		if err != nil {
			httpx.WriteError(w, r, unauthError(err))
			return
		}
		ctx := WithPrincipal(r.Context(), principal)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// unauthError maps the four auth sentinels to user-facing 401 envelopes.
// Wire code stays "unauthenticated" for all of them so the frontend can
// branch on the message or simply prompt re-login.
func unauthError(err error) *httpx.Error {
	switch {
	case errors.Is(err, ErrTokenExpired):
		return httpx.Unauthenticated("Your session has expired. Sign in again to continue.", err)
	case errors.Is(err, ErrTokenMissing):
		return httpx.Unauthenticated("Sign in to continue.", err)
	default:
		return httpx.Unauthenticated("Sign in to continue.", err)
	}
}

// PrincipalFromRequest extracts and verifies the Bearer token. Exported so
// the WS upgrade handler can call it before accepting the connection (no
// hidden middleware on the WS path).
func (p *Provider) PrincipalFromRequest(r *http.Request) (*Principal, error) {
	token := bearerToken(r)
	if token == "" {
		return nil, ErrTokenMissing
	}
	return p.PrincipalFromToken(r.Context(), token)
}

func (p *Provider) PrincipalFromToken(ctx context.Context, token string) (*Principal, error) {
	verified, err := p.AccessVerifier.Verify(ctx, token)
	if err != nil {
		var expired *oidc.TokenExpiredError
		if errors.As(err, &expired) {
			return nil, ErrTokenExpired
		}
		return nil, ErrTokenInvalid
	}

	var claims struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if err := verified.Claims(&claims); err != nil {
		return nil, err
	}

	// Many IdPs (auth.anekdote.in included) keep profile claims out of the
	// access token and only return them from the UserInfo endpoint. Hit it
	// when the JWT is missing email/name so /api/me, comment attribution,
	// share-list rendering etc. don't fall back to `<sub>@syncscribe.local`.
	if claims.Email == "" || claims.Name == "" {
		ts := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: token, TokenType: "Bearer"})
		if ui, err := p.OIDC.UserInfo(ctx, ts); err == nil {
			var uiClaims map[string]any
			if cerr := ui.Claims(&uiClaims); cerr == nil {
				if claims.Email == "" {
					if v, ok := uiClaims["email"].(string); ok {
						claims.Email = v
					}
				}
				if claims.Name == "" {
					for _, key := range []string{"name", "preferred_username", "nickname", "given_name"} {
						if v, ok := uiClaims[key].(string); ok && v != "" {
							claims.Name = v
							break
						}
					}
				}
			}
		}
	}

	return &Principal{
		Subject: claims.Sub,
		Email:   claims.Email,
		Name:    claims.Name,
		Actor:   ActorHuman,
	}, nil
}

func bearerToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	// Browsers can't set arbitrary headers on WS upgrade; fall back to the
	// `Sec-WebSocket-Protocol` channel. Format:
	// "syncscribe.v1, <token>" or "syncscribe.yjs.v1, <token>".
	if h := r.Header.Get("Sec-WebSocket-Protocol"); h != "" {
		parts := strings.Split(h, ",")
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p != "" && p != "syncscribe.v1" && p != "syncscribe.yjs.v1" {
				return p
			}
		}
	}
	return ""
}

// WriteUnauthorized preserves a tiny JSON shape used by a handful of
// pre-httpx callers (auth.Refresh, auth.Me). New code should call
// httpx.WriteError(w, r, httpx.Unauthenticated(...)) directly instead.
//
// Deprecated: prefer httpx.WriteError.
func WriteUnauthorized(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
