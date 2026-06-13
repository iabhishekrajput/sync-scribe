package sync

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/httpx"
	docstore "github.com/abhishek/sync-scribe/api/internal/store"
)

type Handler struct {
	Hub           *Hub
	Provider      *auth.Provider
	Store         *docstore.Store
	AllowedOrigin string
	upgrader      websocket.Upgrader
	initialized   bool
	ips           *ipRegistry
}

// New returns a chi-mountable WebSocket sync handler.
func New(hub *Hub, prov *auth.Provider, st *docstore.Store, allowedOrigin string) *Handler {
	h := &Handler{
		Hub:           hub,
		Provider:      prov,
		Store:         st,
		AllowedOrigin: allowedOrigin,
		ips:           newIPRegistry(defaultConnsPerIP),
	}
	h.upgrader = websocket.Upgrader{
		ReadBufferSize:  4 << 10,
		WriteBufferSize: 4 << 10,
		Subprotocols:    []string{SubprotocolYjs},
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true // non-browser (curl, native clients)
			}
			return originMatches(origin, allowedOrigin)
		},
	}
	h.initialized = true
	return h
}

func originMatches(got, allowed string) bool {
	a, err := url.Parse(allowed)
	if err != nil {
		return false
	}
	b, err := url.Parse(got)
	if err != nil {
		return false
	}
	return a.Scheme == b.Scheme && a.Host == b.Host
}

// ServeHTTP upgrades the request to WebSocket after authenticating and
// authorizing the user against the requested document.
//
// Auth tokens come via either Authorization: Bearer (curl / native) or the
// Sec-WebSocket-Protocol channel "syncscribe.yjs.v1, <token>" (browser —
// can't set arbitrary headers on WS upgrades).
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	docID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Document id is not a valid UUID.", err))
		return
	}

	// Per-IP concurrent connection cap. This runs *before* auth so an
	// unauthenticated attacker can't cheaply burn CPU on JWKS verification.
	// Per-user concurrent caps are intentionally deferred; the IP cap already
	// bounds the simple-flood case.
	ip := clientIP(r)
	if !h.ips.tryAcquire(ip) {
		ipCapRejects.Inc()
		httpx.WriteError(w, r, httpx.RateLimited("Too many connections from this address.", nil))
		return
	}
	releaseIP := func() { h.ips.release(ip) }

	var (
		principal *auth.Principal
		doc       *docstore.Document
		canWrite  bool
	)
	// Errors from here on must release the IP slot; success path transfers
	// ownership to the conn (released when readPump exits).
	releaseOnError := releaseIP
	defer func() {
		if releaseOnError != nil {
			releaseOnError()
		}
	}()

	if token := r.URL.Query().Get("share_token"); token != "" {
		// Public share-link path: no OIDC verification — the link itself
		// proves the bearer is allowed on this doc, scoped to link.role.
		lookupCtx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		link, d, err := h.Store.LookupShareLink(lookupCtx, token)
		cancel()
		if err != nil {
			wsErrors.WithLabelValues("authz").Inc()
			httpx.WriteError(w, r, httpx.Forbidden("This share link is invalid, revoked, or expired.", err))
			return
		}
		// Strict: WS route param must match the link's doc. Prevents one
		// link being reused for a different doc by URL fiddling.
		if d.ID != docID {
			wsErrors.WithLabelValues("authz").Inc()
			httpx.WriteError(w, r, httpx.Forbidden("Share link does not match this document.", nil))
			return
		}
		principal = &auth.Principal{
			Subject: "guest:" + token,
			Name:    "Guest",
			Actor:   auth.ActorGuest,
		}
		doc = d
		canWrite = link.Role == "editor"
	} else {
		p, err := h.Provider.PrincipalFromRequest(r)
		if err != nil {
			wsErrors.WithLabelValues("auth").Inc()
			httpx.WriteError(w, r, httpx.Unauthenticated("Sign in to continue.", err))
			return
		}
		principal = p
		displayName := principal.Name
		if displayName == "" {
			displayName = principal.Email
		}
		if displayName == "" {
			displayName = principal.Subject
		}
		if _, err := h.Store.UpsertUser(r.Context(), docstore.User{
			ID:          principal.Subject,
			Email:       principalEmail(principal),
			DisplayName: displayName,
		}); err != nil {
			wsErrors.WithLabelValues("auth").Inc()
			httpx.WriteError(w, r, httpx.Internal("Could not register your account.", err))
			return
		}

		authCtx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		d, role, err := h.Store.ResolveDocumentRole(authCtx, docID, principal.Subject)
		cancel()
		if err != nil {
			wsErrors.WithLabelValues("authz").Inc()
			httpx.WriteError(w, r, httpx.Forbidden("You don't have access to this document.", err))
			return
		}
		doc = d
		canWrite = docstore.CanRoleWrite(role)
	}
	_ = doc

	ws, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		wsErrors.WithLabelValues("upgrade").Inc()
		log.Debug().Err(err).Msg("ws upgrade")
		return
	}

	if !ensureYjsSubprotocol(ws) {
		return
	}
	c := newConn(ws, principal, canWrite)
	c.remoteIP = ip
	c.onClose = releaseIP
	// Hand IP-slot ownership to the conn; the deferred releaseOnError above
	// now becomes a no-op.
	releaseOnError = nil
	session := h.Hub.join(docID, c)

	// Replay history before the writePump goroutine takes over. Enqueueing
	// straight into c.send respects the same backpressure budget as live
	// fanout; outbound buffer is 256 frames so very long histories will
	// spill and trip a RESYNC close — acceptable until P2.6 ships update
	// compaction.
	replayCtx, replayCancel := context.WithTimeout(context.Background(), 10*time.Second)
	updates, err := h.Hub.store.LoadUpdates(replayCtx, docID)
	replayCancel()
	if err != nil {
		log.Error().Err(err).Msg("replay load")
		session.unregister(c)
		releaseIP()
		_ = ws.Close()
		return
	}
	replayYjsInto(c, updates, canWrite)

	pumpCtx, pumpCancel := context.WithCancel(context.Background())
	go c.writePump(pumpCtx)
	go func() {
		c.readPump(session)
		pumpCancel()
	}()
}

// MountOn registers the handler at /api/sync/{id} on a chi.Router that already
// has its own middleware stack; we DO NOT compose the JSON Bearer middleware
// here because WS auth uses the Sec-WebSocket-Protocol channel rather than
// the Authorization header on the upgrade request.
func MountOn(r chi.Router, prefix string, h *Handler) {
	r.Get(strings.TrimRight(prefix, "/")+"/{id}", h.ServeHTTP)
}

// ensureYjsSubprotocol verifies the upgrade negotiated syncscribe.yjs.v1.
// Clients that offered no matching subprotocol are refused with close code
// 4002 so they fail loudly instead of waiting on frames that never come.
func ensureYjsSubprotocol(ws *websocket.Conn) bool {
	if ws.Subprotocol() == SubprotocolYjs {
		return true
	}
	wsErrors.WithLabelValues("subprotocol").Inc()
	_ = ws.SetWriteDeadline(time.Now().Add(writeDeadline))
	_ = ws.WriteMessage(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(closeUnsupportedProtocol, "unsupported subprotocol"),
	)
	_ = ws.Close()
	return false
}

// replayYjsInto streams persisted updates to a freshly-connected conn, then
// signals SyncStep1, then (if applicable) Readonly. Returns the total bytes
// pushed onto c.send.
//
// Contract — the order matters and is part of the P1.2 durable-save
// guarantee: every byte the server has already persisted reaches the client
// before the server's SyncStep1 flips it to `live`. A client that observes
// `live` can treat its local Y.Doc as caught up.
func replayYjsInto(c *conn, updates [][]byte, canWrite bool) int {
	var total int
	for _, u := range updates {
		frame := encodeYjsSyncFrame(SyncUpdate, u)
		c.enqueue(frame)
		total += len(frame)
	}
	c.enqueue(encodeYjsSyncFrame(SyncStep1, nil))
	total += len(encodeYjsSyncFrame(SyncStep1, nil))
	if !canWrite {
		c.enqueue(encodeYjsFlagFrame(MsgReadonly))
		total += len(encodeYjsFlagFrame(MsgReadonly))
	}
	replayBytes.Observe(float64(total))
	return total
}

func principalEmail(p *auth.Principal) string {
	if p.Email != "" {
		return p.Email
	}
	return p.Subject + "@syncscribe.local"
}
