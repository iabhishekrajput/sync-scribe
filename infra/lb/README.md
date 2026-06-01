# Load balancer — multi-node WS placement

Multi-node WS works two ways, and you want **both** for best behavior:

1. **Valkey pub-sub** (already wired). Every API node subscribes to
   `sync:doc:*`; updates fan out cross-node. Set `REDIS_URL` to enable.
2. **Consistent-hash by docId** at the LB. Even with pub-sub, hashing reduces
   cross-node chatter and keeps a doc's hot state co-resident on one node.

WS sessions are long-lived, so plain round-robin LBs work for correctness, but
without affinity each frame is relayed through Valkey — costly under heavy
fan-out.

## Hash key
The `docId` is the second-to-last path segment of `/api/sync/{id}`. The full
path also works as a hash key since `{id}` dominates the variation.

## nginx (open-source)
```nginx
upstream syncscribe_api {
  hash $request_uri consistent;        # docId-stable bucket
  server api-1:8080;
  server api-2:8080;
  server api-3:8080;
}

server {
  listen 443 ssl http2;
  server_name api.example.com;

  location /api/sync/ {
    proxy_pass         http://syncscribe_api;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;             # WS keepalive
  }

  location / {
    proxy_pass http://syncscribe_api;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

## AWS ALB
ALB does not support consistent hashing, so use **stickiness** as a fallback —
the first hit pins the session to a target via a cookie; subsequent frames for
that connection stay on the same node.

Target group:
```
attributes:
  stickiness.enabled = true
  stickiness.type = app_cookie
  stickiness.app_cookie.cookie_name = SYNCSCRIBE_STICKY
  stickiness.app_cookie.duration_seconds = 3600
```

The application emits no cookie itself; the ALB-issued cookie is opaque to the
backend. For WS-only stickiness use `lb_cookie` instead.

## HAProxy
```
backend syncscribe_api
  balance hdr(X-Forwarded-Path) if { req.hdr(X-Forwarded-Path) -m beg /api/sync/ }
  balance roundrobin
  hash-type consistent
  server api1 api-1:8080 check
  server api2 api-2:8080 check
  server api3 api-3:8080 check
```

## Verifying placement
The `/health/canary` endpoint reports per-node DB, broker, and retention
state. Hit each node directly (bypassing the LB) to confirm the broker is up
on every replica.
