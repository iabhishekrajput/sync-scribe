package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/abhishek/sync-scribe/api/internal/httpx"
)

// writeJSON is the single JSON response path — every handler (including
// admin and health) goes through it so Content-Type is always set.
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// writeStoreErr is the thin shim that funnels store sentinels through
// httpx.From, so every handler stays on the typed-envelope path even when
// it doesn't know the specific failure mode up-front.
func writeStoreErr(w http.ResponseWriter, r *http.Request, err error) {
	httpx.WriteError(w, r, httpx.From(err))
}

func readLimitedBody(r *http.Request, max int64) ([]byte, error) {
	if r.Body == nil {
		return nil, fmt.Errorf("empty body")
	}
	defer r.Body.Close()
	// +1 so we can detect overflow vs. exactly-max.
	body, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	if int64(len(body)) > max {
		return nil, fmt.Errorf("body too large (max %d bytes)", max)
	}
	return body, nil
}

func parseDocID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	raw := chi.URLParam(r, "id")
	id, err := uuid.Parse(raw)
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Document id is not a valid UUID.", err))
		return uuid.Nil, false
	}
	return id, true
}

func parseVersion(w http.ResponseWriter, r *http.Request) (int64, bool) {
	version, err := strconv.ParseInt(chi.URLParam(r, "version"), 10, 64)
	if err != nil || version <= 0 {
		httpx.WriteError(w, r, httpx.BadRequest("Snapshot version must be a positive integer.", err))
		return 0, false
	}
	return version, true
}
