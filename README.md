# SyncScribe

Google Docs-style collaborative Markdown editor with realtime sharing, comments, version history, and a stock `y-protocols` WebSocket path.

See [`plan.md`](./plan.md) for the full blueprint.

## Stack

- **Frontend:** Next.js 16 (App Router), React 19, TypeScript 5.7, Tailwind 4
- **Backend:** Go 1.26 (chi, Gorilla WebSocket), custom Yjs update relay
- **Data:** PostgreSQL 18, Valkey (Redis-compatible)
- **Auth:** OIDC against your existing authorization server (Dex profile available for offline dev)

## Quick start

```bash
cp .env.example .env

# Boot infra. Add `--profile dex` if you want the optional local IdP too.
docker compose up -d

# Apply migrations.
make migrate

# Seed a demo document plus a public editor link.
make seed

# Run the web app and API.
make dev
```

`make seed` prints a public `/p/<token>` link so a fresh local stack has a real collaborative document immediately.

## Manual dev flow

```bash
# Optional: customize the sign-in button label.
export NEXT_PUBLIC_OIDC_PROVIDER_NAME="Dex"

# Boot infra (Postgres + Valkey + Mailpit). Add `--profile dex` for offline IdP.
make up

# Run migrations
make migrate

# Seed a demo document + public editor link
make seed

# Run web + api in dev mode
make dev

# Stop infra
make down
```

Web → http://localhost:3000
API → http://localhost:8080
Postgres → :5433 · Valkey → :6380
Mailpit UI → http://localhost:8026
Dex (optional, `--profile dex`) → http://localhost:5556

## Layout

```
apps/
  web/        Next.js app
  api/        Go API + WS gateway
packages/
  client/     Reusable WebSocket + attribution SDK
  proto/      Shared wire constants (TS)
syncscribe-integration-example/
  src/        Standalone Node client example using @syncscribe/client
```

## Milestones

Tracked in `PLAN.md` §8. The repo is transitioning into Phase 3: cleanup, protocol interop, and the per-user provenance surface on top of the existing collaboration core.
