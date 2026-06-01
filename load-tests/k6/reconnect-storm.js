/**
 * reconnect-storm.js — Hammers the WS endpoint with rapid connect/disconnect
 * cycles to stress Hub session creation and teardown, the IP registry, and the
 * Postgres replay path on each fresh connection.
 *
 * What it stresses:
 *   - Hub.join / Hub.detach under concurrent churn
 *   - IP registry slot allocation and release
 *   - LoadUpdates replay on every connect
 *   - RESYNC close code (4010) handling when the outbound buffer overflows
 *
 * Usage:
 *   k6 run --vus 100 --duration 60s \
 *     -e WS_URL=ws://localhost:8080/api/sync/MY_DOC_ID \
 *     -e TOKEN=eyJ... \
 *     load-tests/k6/reconnect-storm.js
 */

import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

export const options = {
  vus: 100,
  duration: "60s",
  thresholds: {
    // p(95) of time from connect → SYNC_COMPLETE should stay under 1 s.
    sync_latency: ["p(95)<1000"],
    // We tolerate some 4010 RESYNC closes under storm conditions; fatal if
    // more than 5% of connects hit a hard error (non-4010 close code).
    hard_errors: ["count<10"],
  },
};

const syncLatency = new Trend("sync_latency", true);
const resyncCloses = new Counter("resync_closes");
const hardErrors = new Counter("hard_errors");

const TAG_SYNC_COMPLETE = 0x01;
const CLOSE_RESYNC = 4010;

export default function () {
  const url = __ENV.WS_URL;
  const token = __ENV.TOKEN;

  if (!url || !token) {
    hardErrors.add(1);
    return;
  }

  const connectTime = Date.now();
  let gotSync = false;

  const res = ws.connect(
    url,
    {
      headers: { Authorization: `Bearer ${token}` },
      subprotocols: ["syncscribe.v1"],
    },
    function (socket) {
      socket.on("binaryMessage", (data) => {
        const bytes = new Uint8Array(data);
        if (bytes.length > 0 && bytes[0] === TAG_SYNC_COMPLETE && !gotSync) {
          gotSync = true;
          syncLatency.add(Date.now() - connectTime);
          // Immediately disconnect — this is what creates the "storm".
          socket.close(1000);
        }
      });

      socket.on("close", (code) => {
        if (code === CLOSE_RESYNC) resyncCloses.add(1);
        else if (code !== 1000 && code !== 1001) hardErrors.add(1);
      });

      socket.on("error", () => hardErrors.add(1));

      // Safety: never hold the socket longer than 5 s.
      socket.setTimeout(() => socket.close(), 5000);
    },
  );

  check(res, { "upgraded": (r) => r && r.status === 101 });
  // Brief pause between reconnects; at 100 VUs this is still ~20 connects/s.
  sleep(0.05);
}
