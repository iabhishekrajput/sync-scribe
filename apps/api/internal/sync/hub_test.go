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
	a := &conn{send: make(chan []byte, 16), principal: mockPrincipal()}
	b := &conn{send: make(chan []byte, 16), principal: mockPrincipal()}

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
		msgType, syncType, body := decodeYjsSyncFrame(t, frame)
		if msgType != MsgSync || syncType != SyncUpdate {
			t.Fatalf("peer: got msg=%d sync=%d want sync/update", msgType, syncType)
		}
		if string(body) != string(payload) {
			t.Fatalf("payload mismatch: got %v want %v", body, payload)
		}
	case <-time.After(time.Second):
		t.Fatal("peer never received broadcast")
	}

	// Origin receives an Ack flag frame (the "Saved" signal) but never
	// receives its own update echoed back.
	select {
	case f := <-a.send:
		if msgType := decodeYjsFlagFrame(t, f); msgType != MsgAck {
			t.Fatalf("origin should only receive Ack, got msg=%d", msgType)
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

// Broker-delivered blobs enter the session via broadcast(nil, blob) — every
// local client (no origin to skip) must receive a valid SyncUpdate frame.
func TestSession_BrokerBlobFansOutToAllClients(t *testing.T) {
	st := newMemStore()
	h := &Hub{store: st, sessions: map[uuid.UUID]*docSession{}}
	docID := uuid.New()

	a := &conn{send: make(chan []byte, 16), principal: mockPrincipal()}
	b := &conn{send: make(chan []byte, 16), principal: mockPrincipal()}
	sess := h.join(docID, a)
	h.join(docID, b)
	t.Cleanup(func() {
		sess.unregister(a)
		sess.unregister(b)
	})

	blob := []byte{0x07, 0x08}
	sess.broadcast(nil, blob)

	for name, c := range map[string]*conn{"a": a, "b": b} {
		select {
		case frame := <-c.send:
			msgType, syncType, body := decodeYjsSyncFrame(t, frame)
			if msgType != MsgSync || syncType != SyncUpdate {
				t.Fatalf("%s: got msg=%d sync=%d want sync/update", name, msgType, syncType)
			}
			if string(body) != string(blob) {
				t.Fatalf("%s payload mismatch: got %v want %v", name, body, blob)
			}
		case <-time.After(time.Second):
			t.Fatalf("conn %s never received broker fan-out", name)
		}
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
