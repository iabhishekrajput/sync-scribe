/**
 * share-link.js — Benchmarks the unauthenticated public share-link read path
 * (GET /share/:token). This simulates traffic from people clicking a shared
 * document link without being logged in.
 *
 * What it stresses:
 *   - Postgres read for share_links + documents join
 *   - No auth overhead — exercises raw DB + chi routing throughput
 *   - Canary for regressions in the public read-only path
 *
 * Usage:
 *   k6 run --vus 200 --duration 30s \
 *     -e API_URL=http://localhost:8080 \
 *     -e SHARE_TOKEN=abc123 \
 *     load-tests/k6/share-link.js
 *
 * To stress several share tokens at once, set SHARE_TOKENS as a
 * comma-separated list:
 *   -e SHARE_TOKENS=tok1,tok2,tok3
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

export const options = {
  vus: 200,
  duration: "30s",
  thresholds: {
    http_req_duration: ["p(95)<200", "p(99)<500"],
    http_req_failed: ["rate<0.01"],
    not_found_errors: ["count<5"],
  },
};

const notFoundErrors = new Counter("not_found_errors");

export default function () {
  const base = __ENV.API_URL || "http://localhost:8080";
  const tokens = (__ENV.SHARE_TOKENS || __ENV.SHARE_TOKEN || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    console.error("Set SHARE_TOKEN or SHARE_TOKENS");
    return;
  }

  // Round-robin across provided tokens.
  const token = tokens[Math.floor(Math.random() * tokens.length)];
  const url = `${base}/share/${encodeURIComponent(token)}`;

  const res = http.get(url, {
    headers: { Accept: "application/json" },
  });

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "has document_id": (r) => {
      try {
        return JSON.parse(r.body).document_id !== undefined;
      } catch {
        return false;
      }
    },
  });

  if (res.status === 404) notFoundErrors.add(1);
  if (!ok) console.warn(`Unexpected response: ${res.status} ${res.body}`);

  sleep(0.01);
}
