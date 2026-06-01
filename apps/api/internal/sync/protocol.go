package sync

const (
	SubprotocolLegacy = "syncscribe.v1"
	SubprotocolYjs    = "syncscribe.yjs.v1"
)

// Legacy tagged wire format:
//   Frame = [tag: u8] [payload: bytes]
//
//   0x00 UPDATE        payload = raw Yjs update bytes
//   0x01 SYNC_COMPLETE payload empty; sent by server after replaying all
//                      stored updates on a fresh connection
//   0x02 AWARENESS     payload = encoded awareness state
//   0x03 PING          payload empty; heartbeat
//   0x04 READONLY      payload empty; server rejected writes for this conn
//   0x05 ACK           payload empty; one ACK per persisted update from this
//                      conn. Clients count outstanding sends vs ACKs to drive
//                      a Google-Docs-style 'Saving / Saved' status indicator.

const (
	TagUpdate       byte = 0x00
	TagSyncComplete byte = 0x01
	TagAwareness    byte = 0x02
	TagPing         byte = 0x03
	TagReadonly     byte = 0x04
	TagAck          byte = 0x05
)

// Yjs-mode top-level varint message types. Sync and awareness match
// y-protocols. Readonly + ACK remain SyncScribe extensions for the migration
// window so the web client can preserve its current UX while we phase out the
// legacy tagged transport.
const (
	MsgSync           uint64 = 0
	MsgAwareness      uint64 = 1
	MsgAuth           uint64 = 2
	MsgQueryAwareness uint64 = 3
	MsgReadonly       uint64 = 4
	MsgAck            uint64 = 5
)

const (
	SyncStep1 uint64 = 0
	SyncStep2 uint64 = 1
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
