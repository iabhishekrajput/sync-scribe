package server

import (
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/httpx"
	"github.com/abhishek/sync-scribe/api/internal/store"
)

// allowedAssetTypes is intentionally narrow. Anything outside this set is
// rejected at upload, so the editor cannot accidentally hand the browser an
// executable disguised as an image.
// sanitizeAssetFilename strips path components and falls back to a default
// name keyed on the content type. The handler relies on this for both
// safety (no directory escape in Content-Disposition) and ergonomics (a
// pasted screenshot with no filename still gets a sensible extension).
func sanitizeAssetFilename(raw, contentType string) string {
	name := raw
	if name == "" {
		ext := allowedAssetTypes[contentType]
		if ext == "" {
			ext = ".bin"
		}
		return "upload" + ext
	}
	if i := strings.LastIndexAny(name, "/\\"); i >= 0 {
		name = name[i+1:]
	}
	if name == "" {
		ext := allowedAssetTypes[contentType]
		if ext == "" {
			ext = ".bin"
		}
		return "upload" + ext
	}
	return name
}

var allowedAssetTypes = map[string]string{
	"image/png":     ".png",
	"image/jpeg":    ".jpg",
	"image/gif":     ".gif",
	"image/webp":    ".webp",
	"image/svg+xml": ".svg",
}

func (s *Server) uploadAsset(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}

	doc, err := s.store.GetDocument(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	if !s.store.CanWrite(r.Context(), doc, p.Subject) {
		httpx.WriteError(w, r, httpx.Forbidden("You only have read access to this document.", nil))
		return
	}

	if err := r.ParseMultipartForm(store.MaxAssetBytes + 1024); err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Could not read the uploaded form.", err))
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("A file field is required.", err))
		return
	}
	defer file.Close()

	ct := header.Header.Get("Content-Type")
	if ct == "" {
		ct = r.FormValue("content_type")
	}
	if _, allowed := allowedAssetTypes[ct]; !allowed {
		httpx.WriteError(w, r, httpx.UnsupportedMedia("That file type isn't supported.", nil))
		return
	}
	if header.Size > store.MaxAssetBytes {
		httpx.WriteError(w, r, httpx.PayloadTooLarge("File is too large (max 8 MiB).", nil))
		return
	}

	data, err := io.ReadAll(io.LimitReader(file, store.MaxAssetBytes+1))
	if err != nil {
		httpx.WriteError(w, r, httpx.Internal("Could not read the uploaded file.", err))
		return
	}
	if len(data) > store.MaxAssetBytes {
		httpx.WriteError(w, r, httpx.PayloadTooLarge("File is too large (max 8 MiB).", nil))
		return
	}

	filename := sanitizeAssetFilename(header.Filename, ct)

	a, err := s.store.InsertAsset(r.Context(), store.Asset{
		DocumentID:  id,
		UploadedBy:  p.Subject,
		Filename:    filename,
		ContentType: ct,
		SizeBytes:   len(data),
	}, data)
	if err != nil {
		httpx.WriteError(w, r, httpx.Internal("Could not save the uploaded file.", err))
		return
	}

	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "asset.uploaded", map[string]any{
		"asset_id":     a.ID.String(),
		"filename":     a.Filename,
		"content_type": a.ContentType,
		"size_bytes":   a.SizeBytes,
	})

	writeJSON(w, http.StatusCreated, map[string]any{
		"asset": a,
		"url":   "/api/documents/" + id.String() + "/assets/" + a.ID.String(),
	})
}

func (s *Server) getAsset(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	assetID, err := uuid.Parse(chi.URLParam(r, "assetID"))
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Asset id is not a valid UUID.", err))
		return
	}

	// Read access required — same as fetching the document body.
	doc, err := s.store.GetDocument(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	if !s.store.CanRead(r.Context(), doc, p.Subject) {
		httpx.WriteError(w, r, httpx.Forbidden("You don't have access to this asset.", nil))
		return
	}

	blob, err := s.store.GetAsset(r.Context(), id, assetID)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}

	w.Header().Set("Content-Type", blob.ContentType)
	w.Header().Set("Content-Disposition", "inline; filename=\""+strings.ReplaceAll(blob.Filename, "\"", "")+"\"")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("Last-Modified", blob.CreatedAt.UTC().Format(time.RFC1123))
	_, _ = w.Write(blob.Data)
}

func (s *Server) listAssets(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	doc, err := s.store.GetDocument(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	if !s.store.CanRead(r.Context(), doc, p.Subject) {
		httpx.WriteError(w, r, httpx.Forbidden("You don't have access to this document.", nil))
		return
	}

	assets, err := s.store.ListAssets(r.Context(), id)
	if err != nil {
		httpx.WriteError(w, r, httpx.Internal("Could not list assets.", err))
		return
	}
	writeJSON(w, http.StatusOK, assets)
}
