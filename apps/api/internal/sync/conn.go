package sync

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"

	"github.com/abhishek/sync-scribe/api/internal/auth"
)

// Per-connection buffer caps. Plan §3.4 calls for size-bounded (1MB or 256
// msgs); we encode that as 256 outbound frames * up to 1MB each. Overflow
// emits a RESYNC close (4010) so the client knows to drop its provider state
// and reconnect — see packages/proto/src/index.ts for the shared code.
const (
	outboundBuffer   = 256
	maxIncomingFrame = 1 << 20 // 1 MiB
	writeDeadline    = 10 * time.Second
	pongWait         = 60 * time.Second
	pingInterval     = 30 * time.Second
)

type conn struct {
	ws              *websocket.Conn
	send            chan []byte
	principal       *auth.Principal
	canWrite        atomic.Bool
	awarenessClocks map[uint64]uint64

	// Per-connection rate limiting. Frames-per-second and bytes-per-second
	// have separate buckets so a flood of tiny edits and a flood of giant
	// blobs each hit a meaningful cap. nil buckets disable a dimension —
	// used by unit tests that don't care about limits.
	updateBucket *tokenBucket
	byteBucket   *tokenBucket
	// remoteIP is recorded so the IP registry slot can be released when this
	// connection ends, regardless of how readPump exits.
	remoteIP string
	// onClose runs once when readPump exits — used to release the IP
	// registry slot. nil in unit tests that bypass the handler.
	onClose func()
	// resyncOnce guards the close-with-4010 path so concurrent overflows on
	// the read and write sides don't double-send a close frame.
	resyncOnce sync.Once
}

func newConn(ws *websocket.Conn, p *auth.Principal, canWrite bool) *conn {
	c := &conn{
		ws:              ws,
		send:            make(chan []byte, outboundBuffer),
		principal:       p,
		awarenessClocks: make(map[uint64]uint64),
		updateBucket:    newTokenBucket(defaultUpdatesPerSec, defaultUpdateBurst),
		byteBucket:      newTokenBucket(defaultBytesPerSec, defaultByteBurst),
	}
	c.canWrite.Store(canWrite)
	return c
}

func (c *conn) setCanWrite(canWrite bool) {
	c.canWrite.Store(canWrite)
	if !canWrite {
		c.enqueue(encodeYjsFlagFrame(MsgReadonly))
	}
}

// enqueue tries to push a frame to the outbound buffer. On overflow we emit
// a RESYNC close (4010) so the client knows its view of the doc is now stale
// and must drop local provider state before reconnecting.
func (c *conn) enqueue(frame []byte) {
	select {
	case c.send <- frame:
	default:
		wsErrors.WithLabelValues("send_overflow").Inc()
		c.closeWithResync()
	}
}

// closeWithResync writes a close-control frame with code 4010 then shuts the
// socket. Safe to call from multiple goroutines; only the first caller emits
// the frame. The matching close code is exported as CLOSE_RESYNC in
// packages/proto/src/index.ts; the web provider listens for it and clears
// local Y.Doc state before reconnecting.
func (c *conn) closeWithResync() {
	c.resyncOnce.Do(func() {
		resyncCloses.Inc()
		_ = c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
		_ = c.ws.WriteMessage(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(closeResync, "resync"),
		)
		_ = c.ws.Close()
	})
}

// closeWithCode writes a CloseMessage with the given code then shuts the
// socket. Used for permission revocation and rate-limit kicks where the
// client should know exactly why it was hung up on.
func (c *conn) closeWithCode(code int, reason string) {
	c.resyncOnce.Do(func() {
		_ = c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
		_ = c.ws.WriteMessage(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(code, reason),
		)
		_ = c.ws.Close()
		// 4008/4010/4404 events are user-visible and a hot signal during
		// triage — emit a warn line with enough fields to pin the session.
		log.Warn().
			Int("code", code).
			Str("reason", reason).
			Str("user_id", c.principal.Subject).
			Msg("ws close")
	})
}

// writePump drains c.send onto the wire. Owns all writes on the ws — gorilla
// is not safe for concurrent writes.
func (c *conn) writePump(ctx context.Context) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	defer c.ws.Close()

	for {
		select {
		case <-ctx.Done():
			return
		case frame, ok := <-c.send:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
			if !ok {
				_ = c.ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
			}
			if err := c.ws.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				if !isExpectedClose(err) {
					log.Debug().Err(err).Msg("ws write")
				}
				return
			}
		case <-ticker.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// readPump pulls frames off the wire and pushes UPDATE bodies onto the
// session's incoming queue. Awareness is relayed but never persisted.
func (c *conn) readPump(s *docSession) {
	defer func() {
		if removal := c.awarenessRemoval(); len(removal) > 0 {
			s.broadcastAwareness(c, removal)
		}
		s.unregister(c)
		_ = c.ws.Close()
		if c.onClose != nil {
			c.onClose()
		}
	}()

	c.ws.SetReadLimit(maxIncomingFrame)
	_ = c.ws.SetReadDeadline(time.Now().Add(pongWait))
	c.ws.SetPongHandler(func(string) error {
		return c.ws.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		mt, payload, err := c.ws.ReadMessage()
		if err != nil {
			if !isExpectedClose(err) {
				wsErrors.WithLabelValues("read").Inc()
				log.Debug().Err(err).Msg("ws read")
			}
			return
		}
		if mt != websocket.BinaryMessage || len(payload) == 0 {
			wsErrors.WithLabelValues("bad_frame").Inc()
			continue
		}
		c.handleYjsFrame(s, payload)
	}
}

func (c *conn) handleYjsFrame(s *docSession, payload []byte) {
	r := byteReader{b: payload}
	msgType, err := r.readVarUint()
	if err != nil {
		wsErrors.WithLabelValues("bad_frame").Inc()
		return
	}
	switch msgType {
	case MsgSync:
		syncType, err := r.readVarUint()
		if err != nil {
			wsErrors.WithLabelValues("bad_frame").Inc()
			return
		}
		switch syncType {
		case SyncStep1:
			// History was already replayed at connection-open; a client's
			// SyncStep1 is validated and ignored. See protocol.go.
			if _, err := r.readVarBytes(); err != nil || r.i != len(r.b) {
				wsErrors.WithLabelValues("bad_frame").Inc()
			}
		case SyncStep2:
			// Validated and discarded — see protocol.go for why.
			if _, err := r.readVarBytes(); err != nil {
				wsErrors.WithLabelValues("bad_frame").Inc()
			}
		case SyncUpdate:
			body, err := r.readVarBytes()
			if err != nil || r.i != len(r.b) {
				wsErrors.WithLabelValues("bad_frame").Inc()
				return
			}
			c.acceptUpdate(s, body)
		default:
			wsErrors.WithLabelValues("unknown_tag").Inc()
		}
	case MsgAwareness:
		body, err := r.readVarBytes()
		if err != nil || r.i != len(r.b) {
			wsErrors.WithLabelValues("bad_awareness").Inc()
			return
		}
		c.acceptAwareness(s, body)
	case MsgReadonly:
		return
	case MsgAck:
		return
	default:
		wsErrors.WithLabelValues("unknown_tag").Inc()
	}
}

func (c *conn) acceptUpdate(s *docSession, body []byte) {
	if !c.canWrite.Load() {
		wsErrors.WithLabelValues("readonly_update").Inc()
		c.setCanWrite(false)
		return
	}
	if c.updateBucket != nil && !c.updateBucket.take(1) {
		wsErrors.WithLabelValues("rate_frames").Inc()
		c.closeWithCode(closeRateLimited, "update frame rate")
		return
	}
	if c.byteBucket != nil && !c.byteBucket.take(float64(len(body) + 1)) {
		wsErrors.WithLabelValues("rate_bytes").Inc()
		c.closeWithCode(closeRateLimited, "update byte rate")
		return
	}
	updatesReceived.Inc()
	originUser := c.principal.Subject
	if c.principal.Actor == auth.ActorGuest {
		originUser = ""
	}
	select {
	case s.incoming <- inboundUpdate{
		from:       c,
		blob:       body,
		originUser: originUser,
	}:
	default:
		wsErrors.WithLabelValues("incoming_overflow").Inc()
	}
}

func (c *conn) acceptAwareness(s *docSession, body []byte) {
	if c.principal.Actor == auth.ActorGuest {
		sanitized, err := sanitizeGuestAwareness(body)
		if err != nil {
			wsErrors.WithLabelValues("bad_awareness").Inc()
			return
		}
		body = sanitized
	}
	c.rememberAwareness(body)
	select {
	case s.awareness <- awarenessUpdate{from: c, blob: body}:
	default:
		wsErrors.WithLabelValues("awareness_overflow").Inc()
	}
}

func (c *conn) rememberAwareness(blob []byte) {
	clocks, err := parseAwarenessClocks(blob)
	if err != nil {
		return
	}
	for clientID, clock := range clocks {
		c.awarenessClocks[clientID] = clock
	}
}

func (c *conn) awarenessRemoval() []byte {
	return encodeAwarenessRemoval(c.awarenessClocks)
}

func isExpectedClose(err error) bool {
	if errors.Is(err, net.ErrClosed) {
		return true
	}
	if websocket.IsCloseError(err,
		websocket.CloseNormalClosure,
		websocket.CloseGoingAway,
		websocket.CloseNoStatusReceived,
		websocket.CloseAbnormalClosure,
	) {
		return true
	}
	return false
}
