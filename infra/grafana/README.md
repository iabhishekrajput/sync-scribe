# Grafana dashboards

Import `syncscribe-sync.json` into Grafana (Dashboards → New → Import → upload JSON).
The dashboard expects a Prometheus datasource scraping the API's `/metrics`
endpoint.

## Panels
- Active WS connections / active document sessions
- Update receive vs persist throughput (gap indicates persistence lag)
- WS errors broken out by `reason` label
- Resync closes and IP-cap rejects (saturation signals)
- Broadcast bandwidth
- Replay bytes per connect, p50/p95/p99 (a rising p95 motivates the P2.8
  persistence-sidecar work — see plan §8 P2.8)

## Scrape config snippet
```yaml
scrape_configs:
  - job_name: syncscribe-api
    metrics_path: /metrics
    static_configs:
      - targets: ['syncscribe-api:8080']
```

## Canary alert
The `/health/canary` endpoint returns 503 when the DB, broker, or retention
loop is degraded. Wire it to your uptime checker (e.g. Pingdom, Better Stack,
or a Prometheus blackbox exporter).
