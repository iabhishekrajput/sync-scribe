package server

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/config"
	"github.com/abhishek/sync-scribe/api/internal/httpx"
	"github.com/abhishek/sync-scribe/api/internal/store"
	syncpkg "github.com/abhishek/sync-scribe/api/internal/sync"
)

type Server struct {
	cfg       *config.Config
	auth      *auth.Handler
	prov      *auth.Provider
	store     *store.Store
	sync      *syncpkg.Handler
	broker    syncpkg.Broker
}

func New(cfg *config.Config, prov *auth.Provider, st *store.Store, broker syncpkg.Broker) *Server {
	var hub *syncpkg.Hub
	if broker != nil {
		hub = syncpkg.NewHubWithBroker(st, broker)
	} else {
		hub = syncpkg.NewHub(st)
	}
	return &Server{
		cfg:       cfg,
		prov:      prov,
		store:     st,
		sync:      syncpkg.New(hub, prov, st, cfg.FrontendBaseURL),
		broker:    broker,
		auth: &auth.Handler{
			P:               prov,
			CookieSecret:    cfg.CookieSecret,
			CookieSecure:    cfg.CookieSecure,
			FrontendBaseURL: cfg.FrontendBaseURL,
		},
	}
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(httpx.RequestLogger)
	r.Use(httpx.AccessLog)
	r.Use(httpx.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{s.cfg.FrontendBaseURL},
		AllowedMethods:   []string{"GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
	}))

	r.Get("/healthz", s.healthz)
	r.Get("/health/live", s.healthLive)
	r.Get("/health/ready", s.healthReady)
	r.Get("/health/canary", s.healthCanary)
	r.Handle("/metrics", promhttp.Handler())

	r.Route("/admin", func(r chi.Router) {
		r.Get("/stats", s.adminStats)
		r.Get("/retention-runs", s.adminRetentionRuns)
	})

	// Public share-link metadata (no auth — only the token is the secret).
	r.Get("/share/{token}", s.publicShareInfo)
	r.Get("/share/{token}/assets/{assetID}", s.getShareAsset)

	r.Route("/auth", func(r chi.Router) {
		r.Get("/login", s.auth.Login)
		r.Get("/callback", s.auth.Callback)
		r.Post("/refresh", s.auth.Refresh)
		r.Post("/logout", s.auth.Logout)
	})

	// WS sync: auth happens inside the handler (Sec-WebSocket-Protocol
	// channel), not via the JSON Bearer middleware.
	syncpkg.MountOn(r, "/api/sync", s.sync)

	r.Route("/api", func(r chi.Router) {
		r.Use(s.prov.Middleware)
		// Lazy user upsert: handlers that touch FKs to users.id (createDocument,
		// claimInvite, snapshots, etc.) assume the row exists. /api/me used to
		// be the canonical first-hit upsert; this middleware closes the gap if
		// a client lands on any other path first.
		r.Use(s.ensureUser)
		r.Get("/me", s.me)

		r.Route("/documents", func(r chi.Router) {
			r.Get("/", s.listDocuments)
			r.Post("/", s.createDocument)
			r.Route("/{id}", func(r chi.Router) {
				r.Get("/", s.getDocument)
				r.Patch("/", s.renameDocument)
				r.Delete("/", s.deleteDocument)
				r.Get("/access", s.listAccess)
				r.Post("/access", s.upsertAccess)
				r.Delete("/access/{userID}", s.deleteAccess)
				r.Get("/snapshots", s.listSnapshots)
				r.Post("/snapshots", s.publishSnapshot)
				r.Get("/snapshots/{version}", s.getSnapshot)
				r.Post("/snapshots/{version}/restore", s.restoreSnapshot)
				r.Get("/export", s.exportDocument)
				r.Get("/assets", s.listAssets)
				r.Post("/assets", s.uploadAsset)
				r.Get("/assets/{assetID}", s.getAsset)
				r.Get("/attribution", s.getAttribution)
				r.Get("/invites", s.listInvites)
				r.Post("/invites", s.createInvite)
				r.Delete("/invites/{token}", s.revokeInvite)
				r.Post("/invites/{token}/resend", s.resendInvite)
				r.Get("/share-links", s.listShareLinks)
				r.Post("/share-links", s.createShareLink)
				r.Delete("/share-links/{token}", s.revokeShareLink)
				r.Get("/comments", s.listComments)
				r.Post("/comments", s.createComment)
				r.Post("/comments/{commentID}/resolve", s.resolveComment)
				r.Delete("/comments/{commentID}", s.deleteComment)
				r.Get("/activity", s.listActivity)
			})
		})
		r.Post("/invites/{token}/claim", s.claimInvite)
	})

	return r
}
