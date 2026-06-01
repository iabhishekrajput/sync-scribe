/**
 * active-doc.js — Simulates N concurrent users editing the same document over
 * WebSocket. Each VU (virtual user) authenticates, joins the doc WS session,
 * sends a small Yjs update, waits for the ACK, and disconnects.
 *
 * What it stresses:
 *   - Hub session fanout under concurrent editors
 *   - Per-update persist latency (AppendUpdate Postgres write)
 *   - ACK round-trip from origin
 *
 * Prerequisites (set via env vars or k6 -e flag):
 *   WS_URL    ws://localhost:8080/api/sync/<docID>
 *   TOKEN     a valid Bearer token for a user with write access
 *
 * Usage:
 *   k6 run --vus 50 --duration 30s \
 *     -e WS_URL=ws://localhost:8080/api/sync/MY_DOC_ID \
 *     -e TOKEN=eyJ... \
 *     load-tests/k6/active-doc.js
 */

import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

export const options = {
  vus: 50,
  duration: "30s",
  thresholds: {
    ws_connecting: ["p(95)<500"],
    ack_rtt: ["p(95)<2000"],
    errors: ["count<5"],
  },
};

const ackRTT = new Trend("ack_rtt", true);
const errors = new Counter("errors");

// Wire tags mirror apps/api/internal/sync/protocol.go
const TAG_UPDATE = 0x00;
const TAG_SYNC_COMPLETE = 0x01;
const TAG_ACK = 0x05;

// Minimal Yjs v1 update: one item inserted at position 0.
// This is a hand-crafted valid Yjs update binary to avoid a full Yjs dependency
// in the load test. The server treats it opaquely (relay-only).
// Format: length-prefixed varint + a minimal Yjs struct type.
const MINIMAL_YJS_UPDATE = new Uint8Array([
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

function makeFrame(tag, payload) {
  const frame = new Uint8Array(1 + payload.length);
  frame[0] = tag;
  frame.set(payload, 1);
  return frame.buffer;
}

export default function () {
  const url = __ENV.WS_URL;
  const token = __ENV.TOKEN;

  if (!url || !token) {
    console.error("WS_URL and TOKEN must be set");
    errors.add(1);
    return;
  }

  let synced = false;
  let editSent = false;
  const start = Date.now();

  const res = ws.connect(
    url,
    {
      headers: { Authorization: `Bearer ${token}` },
      subprotocols: ["syncscribe.v1"],
    },
    function (socket) {
      socket.on("open", () => {});

      socket.on("binaryMessage", (data) => {
        const bytes = new Uint8Array(data);
        if (bytes.length === 0) return;
        const tag = bytes[0];

        if (tag === TAG_SYNC_COMPLETE && !synced) {
          synced = true;
          editSent = true;
          socket.sendBinary(makeFrame(TAG_UPDATE, MINIMAL_YJS_UPDATE));
        } else if (tag === TAG_ACK && editSent) {
          ackRTT.add(Date.now() - start);
          socket.close();
        }
      });

      socket.on("error", (e) => {
        errors.add(1);
        console.error(`WS error: ${e.error()}`);
      });

      // Safety timeout: close after 10s if we never got an ACK.
      socket.setTimeout(() => {
        if (!editSent || synced) socket.close();
      }, 10000);
    },
  );

  check(res, { "connected successfully": (r) => r && r.status === 101 });
  sleep(0.1);
}
