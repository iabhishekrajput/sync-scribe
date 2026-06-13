package server

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/httpx"
	"github.com/abhishek/sync-scribe/api/internal/store"
)

func (s *Server) exportDocument(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	format := r.URL.Query().Get("format")
	if format == "" {
		format = "md"
	}
	if format != "md" {
		httpx.WriteError(w, r, httpx.BadRequest("Export format must be md.", nil))
		return
	}
	export, err := s.store.ExportMarkdown(r.Context(), id, p.Subject)
	if err != nil {
		if errors.Is(err, store.ErrInvalidInput) {
			httpx.WriteError(w, r, httpx.Conflict("Publish a snapshot before exporting markdown.", err))
			return
		}
		writeStoreErr(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", export.Filename))
	w.Header().Set("X-SyncScribe-Version", strconv.FormatInt(export.Version, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(export.Body)
}
