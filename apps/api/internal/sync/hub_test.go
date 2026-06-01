package sync

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/abhishek/sync-scribe/api/internal/auth"
)

type memStore struct {
	mu      sync.Mutex
	updates map[uuid.UUID][][]byte
}

func newMemStore() *memStore {
	return &memStore{updates: map[uuid.UUID][][]byte{}}
}

func (m *memStore) AppendUpdate(_ context.Context, docID uuid.UUID, _ string, blob []byte) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.updates[docID] = append(m.updates[docID], blob)
	return int64(len(m.updates[docID])), nil
}

func (m *memStore) LoadUpdates(_ context.Context, docID uuid.UUID) ([][]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([][]byte, len(m.updates[docID]))
	copy(out, m.updates[docID])
	return out, nil
}

func TestSession_PersistsAndBroadcasts(t *testing.T) {
	st := newMemStore()
	h := &Hub{store: st, sessions: map[uuid.UUID]*docSession{}}

	docID := uuid.New()
	a := &conn{send: make(chan []byte, 16)}
	a.principal = mockPrincipal()
	b := &conn{send: make(chan []byte, 16)}
	b.principal = mockPrincipal()

	sess := h.join(docID, a)
	h.join(docID, b)
	t.Cleanup(func() {
		sess.unregister(a)
		sess.unregister(b)
	})

	payload := []byte{0x01, 0x02, 0x03}
	sess.incoming <- inboundUpdate{
		from: a, blob: payload,
		originUser: a.principal.Subject,
	}

	select {
	case frame := <-b.send:
		if len(frame) < 2 || frame[0] != TagUpdate {
			t.Fatalf("expected TagUpdate frame, got %v", frame)
		}
		if string(frame[1:]) != string(payload) {
			t.Fatalf("payload mismatch: got %v want %v", frame[1:], payload)
		}
	case <-time.After(time.Second):
		t.Fatal("peer never received broadcast")
	}

	// Origin receives a TagAck frame (the "Saved" signal) but never receives
	// its own update echoed back.
	select {
	case f := <-a.send:
		if len(f) != 1 || f[0] != TagAck {
			t.Fatalf("origin should only receive TagAck, got %v", f)
		}
	case <-time.After(time.Second):
		t.Fatal("origin never received ACK")
	}
	select {
	case f := <-a.send:
		t.Fatalf("origin should NOT receive additional frames, got %v", f)
	case <-time.After(50 * time.Millisecond):
	}

	stored, _ := st.LoadUpdates(context.Background(), docID)
	if len(stored) != 1 || string(stored[0]) != string(payload) {
		t.Fatalf("expected 1 persisted update equal to payload, got %v", stored)
	}
}

func TestSession_PersistsAndBroadcastsAcrossProtocols(t *testing.T) {
	st := newMemStore()
	h := &Hub{store: st, sessions: map[uuid.UUID]*docSession{}}

	docID := uuid.New()
	origin := &conn{send: make(chan []byte, 16), principal: mockPrincipal(), protocol: SubprotocolYjs}
	legacyPeer := &conn{send: make(chan []byte, 16), principal: mockPrincipal(), protocol: SubprotocolLegacy}
	yjsPeer := &conn{send: make(chan []byte, 16), principal: mockPrincipal(), protocol: SubprotocolYjs}

	sess := h.join(docID, origin)
	h.join(docID, legacyPeer)
	h.join(docID, yjsPeer)
	t.Cleanup(func() {
		sess.unregister(origin)
		sess.unregister(legacyPeer)
		sess.unregister(yjsPeer)
	})

	payload := []byte{0x04, 0x05, 0x06}
	sess.incoming <- inboundUpdate{
		from:       origin,
		blob:       payload,
		originUser: origin.principal.Subject,
	}

	select {
	case frame := <-legacyPeer.send:
		if len(frame) < 2 || frame[0] != TagUpdate {
			t.Fatalf("legacy peer: expected TagUpdate, got %v", frame)
		}
		if string(frame[1:]) != string(payload) {
			t.Fatalf("legacy peer payload mismatch: got %v want %v", frame[1:], payload)
		}
	case <-time.After(time.Second):
		t.Fatal("legacy peer never received broadcast")
	}

	select {
	case frame := <-yjsPeer.send:
		msgType, syncType, body := decodeYjsSyncFrame(t, frame)
		if msgType != MsgSync || syncType != SyncUpdate {
			t.Fatalf("yjs peer: got msg=%d sync=%d want sync/update", msgType, syncType)
		}
		if string(body) != string(payload) {
			t.Fatalf("yjs peer payload mismatch: got %v want %v", body, payload)
		}
	case <-time.After(time.Second):
		t.Fatal("yjs peer never received broadcast")
	}

	select {
	case frame := <-origin.send:
		msgType := decodeYjsFlagFrame(t, frame)
		if msgType != MsgAck {
			t.Fatalf("origin should receive ACK, got %d", msgType)
		}
	case <-time.After(time.Second):
		t.Fatal("origin never received ACK")
	}
}

func TestHub_OnlyOneSessionPerDoc(t *testing.T) {
	st := newMemStore()
	h := &Hub{store: st, sessions: map[uuid.UUID]*docSession{}}
	docID := uuid.New()

	a := &conn{send: make(chan []byte, 1), principal: mockPrincipal()}
	b := &conn{send: make(chan []byte, 1), principal: mockPrincipal()}

	s1 := h.join(docID, a)
	s2 := h.join(docID, b)
	if s1 != s2 {
		t.Fatalf("second join created a new session; want same instance")
	}
	if s1.clientCount() != 2 {
		t.Fatalf("client count = %d, want 2", s1.clientCount())
	}
	s1.unregister(a)
	s1.unregister(b)
}

func TestSession_AwarenessAfterOriginDisconnectDoesNotPanic(t *testing.T) {
	st := newMemStore()
	h := &Hub{store: st, sessions: map[uuid.UUID]*docSession{}}
	docID := uuid.New()
	a := &conn{send: make(chan []byte, 1), principal: mockPrincipal()}

	sess := h.join(docID, a)
	sess.unregister(a)

	done := make(chan struct{})
	go func() {
		defer close(done)
		sess.broadcastAwareness(a, []byte{0x01, 0x02})
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("broadcast did not return")
	}
}

func mockPrincipal() *auth.Principal {
	return &auth.Principal{Subject: "u-test", Actor: auth.ActorHuman}
}
