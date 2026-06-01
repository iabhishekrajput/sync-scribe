package server

import (
	"net/http"
	"sync"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/store"
)

// ensureUser is a middleware that materializes a row in the `users` table on
// the first request a given principal makes after server start. Subsequent
// requests skip the DB write via the process-local seenUsers cache.
//
// Why needed: many handlers INSERT rows whose FKs reference users.id (e.g.
// documents.owner_id, document_access.user_id, document_updates.origin_user).
// If the client never hits /api/me first, those INSERTs
// blow up with an opaque FK violation. This middleware closes the gap.
type userSeen struct{ mu sync.Map }

var seenUsers userSeen

func (s *Server) ensureUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := auth.FromContext(r.Context())
		if p == nil || p.Subject == "" {
			next.ServeHTTP(w, r)
			return
		}
		if _, hit := seenUsers.mu.Load(p.Subject); hit {
			next.ServeHTTP(w, r)
			return
		}
		displayName := p.Name
		if displayName == "" {
			displayName = p.Email
		}
		if displayName == "" {
			displayName = p.Subject
		}
		if _, err := s.store.UpsertUser(r.Context(), store.User{
			ID:          p.Subject,
			Email:       principalEmail(p),
			DisplayName: displayName,
		}); err != nil {
			// Don't fail the request — a transient DB blip shouldn't 500 a
			// read-only path. The downstream handler will surface a clearer
			// error if it actually needs the user row to exist.
			next.ServeHTTP(w, r)
			return
		}
		seenUsers.mu.Store(p.Subject, struct{}{})
		next.ServeHTTP(w, r)
	})
}
