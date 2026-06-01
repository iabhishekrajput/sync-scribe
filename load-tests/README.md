# SyncScribe load tests

[k6](https://k6.io) scripts for the three core load scenarios from P2.6.

## Prerequisites

Install k6: `brew install k6` or see https://k6.io/docs/getting-started/installation/

The API must be running and migrations applied. Set env vars per script.

## Scripts

### active-doc.js — Concurrent editors on one document

Simulates N users connecting to the same document WS session, each sending one
Yjs update and waiting for the server ACK.

```sh
k6 run --vus 50 --duration 30s \
  -e WS_URL=ws://localhost:8080/api/sync/<DOC_ID> \
  -e TOKEN=<bearer token with write access> \
  load-tests/k6/active-doc.js
```

Key metrics: `ack_rtt` (p95 target < 2 s), `errors` (target < 5).

### reconnect-storm.js — Hub session churn

100 VUs connecting and immediately disconnecting, stressing `Hub.join`/`Hub.detach`
and the per-connect update replay path.

```sh
k6 run --vus 100 --duration 60s \
  -e WS_URL=ws://localhost:8080/api/sync/<DOC_ID> \
  -e TOKEN=<bearer token with read access> \
  load-tests/k6/reconnect-storm.js
```

Key metrics: `sync_latency` (p95 target < 1 s), `resync_closes`, `hard_errors`.

### share-link.js — Public share-link reads

High-concurrency unauthenticated GET `/share/:token` to benchmark the cold
read path.

```sh
k6 run --vus 200 --duration 30s \
  -e API_URL=http://localhost:8080 \
  -e SHARE_TOKEN=<token> \
  load-tests/k6/share-link.js
```

Multiple tokens: `-e SHARE_TOKENS=tok1,tok2,tok3` (k6 round-robins).

Key metrics: `http_req_duration` (p95 < 200 ms, p99 < 500 ms), `http_req_failed` (< 1%).

## Canary / CI integration

Add to CI by running each script with `--out json=results.json` and checking
the exit code (non-zero when any threshold is breached):

```sh
k6 run --vus 20 --duration 10s \
  -e WS_URL="$WS_URL" -e TOKEN="$TOKEN" \
  --out json=active-doc-results.json \
  load-tests/k6/active-doc.js
```
