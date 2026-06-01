package sync

import (
	"context"
	"encoding/base64"
	"strings"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// Broker is the interface the Hub uses to relay Yjs updates to peer nodes.
// nil = single-node mode (no cross-node relay).
//
// The contract: Publish sends a blob to ALL OTHER nodes; Receive returns blobs
// published by OTHER nodes. The implementation must filter out its own node's
// publishes so origin connections don't receive an echo.
type Broker interface {
	// Publish sends a Yjs update blob to all peer nodes serving docID.
	Publish(ctx context.Context, docID uuid.UUID, blob []byte) error
	// Chan returns the channel on which this node receives blobs published by
	// peers. The channel is closed when the broker is closed.
	Chan() <-chan BrokerMessage
	// Ping verifies the broker backend is reachable. Used by canary health.
	Ping(ctx context.Context) error
	// Close releases all broker resources.
	Close() error
}

// BrokerMessage is a Yjs update blob received from a peer node.
type BrokerMessage struct {
	DocID uuid.UUID
	Blob  []byte
}

// channelForDoc returns the Redis pub-sub channel name for a document.
// Format: "sync:doc:{docID}" — all nodes subscribe to the same channel.
func channelForDoc(docID uuid.UUID) string {
	return "sync:doc:" + docID.String()
}

// ValkeyBroker implements Broker using Redis/Valkey pub-sub. It is safe for
// concurrent use. The Publish path uses PUBLISH; the receive path uses
// PSUBSCRIBE "sync:doc:*" on a dedicated connection so a single goroutine
// routes all incoming frames to the Hub.
type ValkeyBroker struct {
	client *redis.Client
	nodeID string // 36-byte UUID string, included in every published message
	ch     chan BrokerMessage
	sub    *redis.PubSub
	done   chan struct{}
}

// NewValkeyBroker connects to addr (e.g. "redis://localhost:6379") and starts
// the background receive goroutine. Call Close when done.
func NewValkeyBroker(addr string) (*ValkeyBroker, error) {
	opts, err := redis.ParseURL(addr)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(opts)

	nodeID := uuid.New().String()
	sub := client.PSubscribe(context.Background(), "sync:doc:*")

	b := &ValkeyBroker{
		client: client,
		nodeID: nodeID,
		ch:     make(chan BrokerMessage, 512),
		sub:    sub,
		done:   make(chan struct{}),
	}
	go b.receiveLoop()
	return b, nil
}

func (b *ValkeyBroker) receiveLoop() {
	defer close(b.done)
	msgCh := b.sub.Channel()
	for msg := range msgCh {
		// Message format: "{nodeID}\n{base64blob}"
		nl := strings.IndexByte(msg.Payload, '\n')
		if nl < 0 {
			continue
		}
		senderNode := msg.Payload[:nl]
		if senderNode == b.nodeID {
			continue // our own publish — skip
		}
		blobB64 := msg.Payload[nl+1:]
		blob, err := base64.StdEncoding.DecodeString(blobB64)
		if err != nil {
			log.Warn().Str("channel", msg.Channel).Msg("broker: invalid base64 in pub-sub message")
			continue
		}
		// Extract docID from channel name "sync:doc:{uuid}".
		const prefix = "sync:doc:"
		if !strings.HasPrefix(msg.Channel, prefix) {
			continue
		}
		docID, err := uuid.Parse(msg.Channel[len(prefix):])
		if err != nil {
			continue
		}
		select {
		case b.ch <- BrokerMessage{DocID: docID, Blob: blob}:
		default:
			log.Warn().Str("doc", docID.String()).Msg("broker: receive channel full, dropping cross-node frame")
		}
	}
}

func (b *ValkeyBroker) Publish(ctx context.Context, docID uuid.UUID, blob []byte) error {
	payload := b.nodeID + "\n" + base64.StdEncoding.EncodeToString(blob)
	return b.client.Publish(ctx, channelForDoc(docID), payload).Err()
}

func (b *ValkeyBroker) Chan() <-chan BrokerMessage {
	return b.ch
}

func (b *ValkeyBroker) Ping(ctx context.Context) error {
	return b.client.Ping(ctx).Err()
}

func (b *ValkeyBroker) Close() error {
	if err := b.sub.Close(); err != nil {
		return err
	}
	<-b.done
	return b.client.Close()
}
