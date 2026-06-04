package sync

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"

	docstore "github.com/abhishek/sync-scribe/api/internal/store"
)

// Hub owns the in-process registry of per-document sessions. Lookup is keyed
// by doc UUID; first connect creates the session, last disconnect schedules
// idle shutdown.
//
// Plan §3.2: cold-doc thundering herd uses a per-key once-pattern; we wrap
// docSession init in a mutex-guarded check-then-create so 100 simultaneous
// connects only spawn one goroutine.
type Hub struct {
	store  updateStore
	broker Broker // nil = single-node mode

	mu       sync.Mutex
	sessions map[uuid.UUID]*docSession
}

func NewHub(st *docstore.Store) *Hub {
	return &Hub{
		store:    &dbStore{s: st},
		sessions: make(map[uuid.UUID]*docSession),
	}
}

// NewHubWithBroker creates a Hub that relays updates to/from peer API nodes via
// the supplied Broker. Call this from main when VALKEY_URL is configured.
func NewHubWithBroker(st *docstore.Store, broker Broker) *Hub {
	h := &Hub{
		store:    &dbStore{s: st},
		broker:   broker,
		sessions: make(map[uuid.UUID]*docSession),
	}
	go h.brokerLoop()
	return h
}

// brokerLoop runs for the lifetime of the Hub and routes cross-node update
// frames (received via the Broker) to the appropriate local docSession.
// It is a no-op when broker is nil.
func (h *Hub) brokerLoop() {
	if h.broker == nil {
		return
	}
	for msg := range h.broker.Chan() {
		h.mu.Lock()
		s := h.sessions[msg.DocID]
		h.mu.Unlock()
		if s != nil {
			s.broadcast(nil, msg.Blob)
		}
	}
}

// join attaches a fresh connection to the doc session, creating it lazily.
// The caller must subsequently call session.serve(conn) to start pumping.
func (h *Hub) join(docID uuid.UUID, c *conn) *docSession {
	h.mu.Lock()
	defer h.mu.Unlock()

	s, ok := h.sessions[docID]
	if !ok {
		s = newDocSession(h, docID)
		h.sessions[docID] = s
		activeSessions.Inc()
		go s.loop()
	}
	s.register(c)
	return s
}

// detach is called by docSession when a connection leaves. If the session
// has no remaining clients, it schedules a grace-period close.
func (h *Hub) detach(s *docSession) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s.clientCount() == 0 {
		delete(h.sessions, s.docID)
		activeSessions.Dec()
		close(s.done)
	}
}

// --- per-document session ---

type docSession struct {
	hub   *Hub
	docID uuid.UUID

	mu      sync.RWMutex
	clients map[*conn]struct{}

	incoming  chan inboundUpdate
	awareness chan awarenessUpdate
	done      chan struct{}
}

type inboundUpdate struct {
	from       *conn
	blob       []byte
	originUser string
}

type awarenessUpdate struct {
	from *conn
	blob []byte
}

func newDocSession(h *Hub, id uuid.UUID) *docSession {
	return &docSession{
		hub:               h,
		docID:             id,
		clients:           make(map[*conn]struct{}),
		incoming:          make(chan inboundUpdate, 256),
		awareness:         make(chan awarenessUpdate, 256),
		done:              make(chan struct{}),
	}
}

func (s *docSession) register(c *conn) {
	s.mu.Lock()
	s.clients[c] = struct{}{}
	s.mu.Unlock()
	activeConnections.Inc()
}

func (h *Hub) SetWriteAccess(docID uuid.UUID, userID string, canWrite bool) {
	h.mu.Lock()
	s := h.sessions[docID]
	h.mu.Unlock()
	if s == nil {
		return
	}
	s.setWriteAccess(userID, canWrite)
}

func (s *docSession) unregister(c *conn) {
	s.mu.Lock()
	delete(s.clients, c)
	left := len(s.clients) == 0
	s.mu.Unlock()
	activeConnections.Dec()

	if left {
		// Could schedule a grace window before shutting down — plan §3.2 says
		// 60s. M3 collapses immediately to keep state machine simple; we
		// revisit when reconnect-storm metrics show churn.
		s.hub.detach(s)
	}
}

func (s *docSession) clientCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.clients)
}

func (s *docSession) setWriteAccess(userID string, canWrite bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for c := range s.clients {
		if c.principal.Subject == userID {
			c.setCanWrite(canWrite)
		}
	}
}

// loop drains incoming updates: persist, then fan out to all OTHER clients.
// A single goroutine owns persistence ordering, matching plan §3.3's
// "single state-machine" guidance even though M3 doesn't have snapshots yet.
func (s *docSession) loop() {
	for {
		select {
		case <-s.done:
			return
		case up := <-s.incoming:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_, err := s.hub.store.AppendUpdate(ctx, s.docID, up.originUser, up.blob)
			cancel()
			if err != nil {
				wsErrors.WithLabelValues("persist").Inc()
				log.Error().Err(err).
					Str("doc_id", s.docID.String()).
					Str("origin_user", up.originUser).
					Int("bytes", len(up.blob)).
					Msg("persist update")
				continue
			}
			updatesPersisted.Inc()
			// ACK back to origin so the client can drive a "Saved" indicator.
			// One ACK per persisted update; pure count match — no payload —
			// because origin already knows the bytes it shipped.
			if up.from.protocol == SubprotocolYjs {
				up.from.enqueue(encodeYjsFlagFrame(MsgAck))
			} else {
				up.from.enqueue([]byte{TagAck})
			}
			s.broadcast(up.from, up.blob)

			// Publish to peer nodes so connections on other API instances also
			// receive this update. Fire-and-forget: a single dropped cross-node
			// frame causes a temporary divergence that resolves on the next
			// client reconnect (the full update history is in Postgres).
			if s.hub.broker != nil {
				blob := up.blob
				go func() {
					ctx4, cancel4 := context.WithTimeout(context.Background(), 2*time.Second)
					defer cancel4()
					_ = s.hub.broker.Publish(ctx4, s.docID, blob)
				}()
			}

		case aw := <-s.awareness:
			s.broadcastAwareness(aw.from, aw.blob)
		}
	}
}

// broadcast sends an update frame to every connected client except origin.
func (s *docSession) broadcast(origin *conn, blob []byte) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	peers := 0
	for c := range s.clients {
		if c == origin {
			continue
		}
		frame := make([]byte, 0, len(blob)+1)
		if c.protocol == SubprotocolYjs {
			frame = encodeYjsSyncFrame(SyncUpdate, blob)
		} else {
			frame = append(frame, TagUpdate)
			frame = append(frame, blob...)
		}
		c.enqueue(frame)
		peers++
		broadcastBytes.Add(float64(len(frame)))
	}
	_ = peers
}

func (s *docSession) broadcastAwareness(origin *conn, blob []byte) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	peers := 0
	for c := range s.clients {
		if c == origin {
			continue
		}
		frame := make([]byte, 0, len(blob)+1)
		if c.protocol == SubprotocolYjs {
			frame = encodeYjsAwarenessFrame(blob)
		} else {
			frame = append(frame, TagAwareness)
			frame = append(frame, blob...)
		}
		c.enqueue(frame)
		peers++
		broadcastBytes.Add(float64(len(frame)))
	}
	_ = peers
}
