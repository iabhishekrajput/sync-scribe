package auth

import (
	"context"
	"fmt"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Provider wraps the OIDC discovery document and an OAuth2 config. The
// underlying go-oidc library refreshes JWKS automatically (KeySet caches and
// re-fetches on signature lookup failure).
type Provider struct {
	OIDC           *oidc.Provider
	OAuth2         *oauth2.Config
	IDVerifier     *oidc.IDTokenVerifier // strict: checks aud == client_id (used at callback)
	AccessVerifier *oidc.IDTokenVerifier // relaxed: skips aud check (used in Bearer middleware)
	ClientID       string
	IssuerURL      string
	UsePKCE        bool
	// Audience is the OAuth2 resource server audience appended to the
	// authorization request. Required for Auth0: without it Auth0 issues an
	// opaque/JWE access token that go-oidc cannot verify. Set to the Auth0
	// API identifier (e.g. "https://api.syncscribe.dev").
	Audience string
}

type ProviderConfig struct {
	IssuerURL    string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Scopes       []string
	// Audience is the resource server audience to request. Optional for
	// generic OIDC (Dex, Keycloak) but required for Auth0.
	Audience string
}

func NewProvider(ctx context.Context, c ProviderConfig) (*Provider, error) {
	p, err := oidc.NewProvider(ctx, c.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}

	scopes := c.Scopes
	if len(scopes) == 0 {
		// auth.anekdote.in advertises only openid/profile/email — no
		// offline_access, no refresh_token grant. We use access-token-only
		// sessions (see handler.go) so refresh tokens aren't needed.
		scopes = []string{oidc.ScopeOpenID, "profile", "email"}
	}

	oauth2Cfg := &oauth2.Config{
		ClientID:     c.ClientID,
		ClientSecret: c.ClientSecret,
		RedirectURL:  c.RedirectURL,
		Endpoint:     p.Endpoint(),
		Scopes:       scopes,
	}

	return &Provider{
		OIDC:           p,
		OAuth2:         oauth2Cfg,
		IDVerifier:     p.Verifier(&oidc.Config{ClientID: c.ClientID}),
		AccessVerifier: p.Verifier(&oidc.Config{ClientID: c.ClientID, SkipClientIDCheck: true}),
		ClientID:       c.ClientID,
		IssuerURL:      c.IssuerURL,
		UsePKCE:        c.ClientSecret == "",
		Audience:       c.Audience,
	}, nil
}
