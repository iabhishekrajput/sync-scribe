package server

import (
	"net/http"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/httpx"
	"github.com/abhishek/sync-scribe/api/internal/store"
)

func (s *Server) listSnapshots(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	snapshots, err := s.store.ListSnapshots(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshots)
}

func (s *Server) getSnapshot(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	version, ok := parseVersion(w, r)
	if !ok {
		return
	}
	snapshot, err := s.store.GetSnapshot(r.Context(), id, version, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// publishSnapshot stores the editor's current text as a new snapshot. The
// client POSTs the live Y.Text content as text/plain or text/markdown; the
// server doesn't parse — just persists bytes. Required for Export Markdown
// to have anything to serve, since M3 took out the M2 auto-save path.
func (s *Server) publishSnapshot(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	doc, role, err := s.store.ResolveDocumentRole(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	if !store.CanRoleWrite(role) {
		httpx.WriteError(w, r, httpx.Forbidden("You only have read access to this document.", nil))
		return
	}
	// Cap at 4 MiB — beyond that, the doc is past the markdown editor's
	// reasonable scope and someone is probably misusing the endpoint.
	body, err := readLimitedBody(r, 4<<20)
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Snapshot body is invalid or too large.", err))
		return
	}
	version, err := s.store.PutSnapshot(r.Context(), doc.ID, p.Subject, body)
	if err != nil {
		httpx.WriteError(w, r, httpx.Internal("Could not save the snapshot.", err))
		return
	}
	_ = s.store.RecordActivity(r.Context(), doc.ID, p.Subject, "snapshot.published", map[string]any{"version": version})
	writeJSON(w, http.StatusCreated, map[string]any{"version": version})
}

func (s *Server) restoreSnapshot(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	version, ok := parseVersion(w, r)
	if !ok {
		return
	}
	doc, newVersion, err := s.store.RestoreSnapshot(r.Context(), id, version, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "snapshot.restored", map[string]any{"from_version": version, "version": newVersion})
	writeJSON(w, http.StatusCreated, map[string]any{"document": doc, "version": newVersion})
}
