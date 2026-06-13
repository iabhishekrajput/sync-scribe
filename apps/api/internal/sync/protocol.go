package sync

// Wire contract — stock y-protocols varint framing, negotiated via the
// Sec-WebSocket-Protocol value "syncscribe.yjs.v1".
//
//	Frame = [msgType: varint] [body...]
//
// MsgSync and MsgAwareness match y-protocols/sync and y-protocols/awareness.
// MsgReadonly and MsgAck are SyncScribe extensions: Readonly tells the client
// its writes are rejected for this conn; the server emits one Ack per
// persisted update from this conn, which clients count against outstanding
// sends to drive a 'Saving / Saved' indicator.
//
// Replay contract: on connect the server streams every persisted update as
// SyncUpdate frames, then SyncStep1 (empty state vector), then MsgReadonly if
// the conn cannot write. A client that observes the server's SyncStep1 can
// treat its local Y.Doc as caught up.
//
// Client SyncStep1 is validated and ignored (history was already replayed at
// connect). Client SyncStep2 is validated and DISCARDED: persisting it would
// append a full-state blob per reconnect with no compaction (P2.6) to absorb
// them. First-party clients resend unacked updates from their outbox instead;
// stock y-protocols clients with offline state will lose it — revisit when
// compaction ships.
const SubprotocolYjs = "syncscribe.yjs.v1"

const (
	MsgSync           uint64 = 0
	MsgAwareness      uint64 = 1
	MsgAuth           uint64 = 2
	MsgQueryAwareness uint64 = 3
	MsgReadonly       uint64 = 4
	MsgAck            uint64 = 5
)

const (
	SyncStep1  uint64 = 0
	SyncStep2  uint64 = 1
	SyncUpdate uint64 = 2
)

func encodeYjsSyncFrame(kind uint64, payload []byte) []byte {
	frame := appendVarUint(nil, MsgSync)
	frame = appendVarUint(frame, kind)
	frame = appendVarBytes(frame, payload)
	return frame
}

func encodeYjsAwarenessFrame(payload []byte) []byte {
	frame := appendVarUint(nil, MsgAwareness)
	frame = appendVarBytes(frame, payload)
	return frame
}

func encodeYjsFlagFrame(kind uint64) []byte {
	return appendVarUint(nil, kind)
}
