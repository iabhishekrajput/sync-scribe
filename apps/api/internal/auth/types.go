package auth

import (
	"context"
	"errors"
)

// Actor identifies whether a principal is a signed-in user or a public-share
// guest.
type Actor string

const (
	ActorHuman Actor = "human"
	// ActorGuest is a public share-link visitor. Distinguished from signed-in
	// users so awareness routing can anonymize the broadcast and so authz layers can
	// reject any write that bypasses the link's role.
	ActorGuest Actor = "guest"
)

// Principal is the authenticated entity behind a request.
type Principal struct {
	// Subject is the OIDC `sub` claim. Stable per-IdP identifier.
	Subject string
	Email   string
	Name    string
	Actor   Actor
}

type ctxKey struct{}

func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// FromContext returns the principal attached by the auth middleware, or nil
// if the request was not authenticated.
func FromContext(ctx context.Context) *Principal {
	p, _ := ctx.Value(ctxKey{}).(*Principal)
	return p
}

var ErrUnauthenticated = errors.New("unauthenticated")
