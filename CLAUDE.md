# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `PLAN.md` for the full blueprint; §8 tracks the active phase. The repo is in Phase 3: agent-code retirement, stock `y-protocols` interop (P3.1), and the per-user provenance surface (P3.2).

## Commands

All day-to-day work goes through the Makefile (it auto-loads `.env`):

- `make up` / `make down` — Docker infra: Postgres (:5433), Valkey (:6380), Mailpit (SMTP :1026, UI :8026). Add `docker compose --profile dex up -d` for the optional local OIDC IdP (:5556).
- `make migrate` — apply goose migrations (`migrate-status`, `migrate-down`, `migrate-reset` also exist).
- `make seed` — demo document + public `/p/<token>` link.
- `make dev` — web (:3000) + api (:8080) concurrently; `make web` / `make api` individually.
- `make test` — `pnpm -r test` + `go test ./...`. `make lint`, `make typecheck` similarly fan out.
- Single Go test: `cd apps/api && go test ./internal/sync -run TestName`. Real test coverage lives on the Go side; the TS packages' `test` scripts are placeholders.
- Single workspace: `pnpm --filter web typecheck` (web's typecheck runs `next typegen` first — needed after route changes).

## Repo layout

```
apps/web/      Next.js 16, App Router, React 19, TS strict, Tailwind 4
apps/api/      Go 1.26 backend (chi REST + Gorilla WS custom Yjs relay)
packages/client/  @syncscribe/client — reusable WS sync + attribution SDK (TS)
packages/proto/   Shared wire constants (TS) imported by web + client
syncscribe-integration-example/  Standalone Node client using @syncscribe/client
infra/dex/     Local-dev OIDC IdP config
load-tests/    k6-style load scripts
```

## Architecture

**Realtime sync path** (`apps/api/internal/sync`): `Hub` keeps an in-process registry of per-document sessions — lazily created on first connect, idle-shutdown after last disconnect. Persistence is an append-only Yjs update log in Postgres (`store.AppendUpdate`/`LoadUpdates`, with `origin_user` per update — this is the provenance substrate). Fresh connections replay the stored log, then get SYNC_COMPLETE; each persisted update from a conn is ACKed back to drive the client's "Saving / Saved" indicator. Multi-node fan-out goes through the `Broker` interface (Valkey pub-sub on `sync:doc:{id}`), enabled when `REDIS_URL` is set; nil broker = single-node mode.

**Two WS subprotocols** coexist during the migration window (negotiated via `Sec-WebSocket-Protocol`): legacy `syncscribe.v1` (1-byte tag frames) and target `syncscribe.yjs.v1` (stock `y-protocols` varint framing, plus Readonly/Ack extension message types). Wire constants are defined twice — `packages/proto/src/index.ts` (TS) and `apps/api/internal/sync/protocol.go` (Go) — change both together. WS auth happens inside the sync handler via the subprotocol channel, not the REST bearer middleware.

**REST** (`apps/api/internal/server`): chi routes under `/api` behind OIDC bearer middleware plus a lazy user-upsert middleware (`ensureUser`) — handlers may assume the `users` row exists. Handlers are thin wrappers over `internal/store` (pgx, no ORM). Unauthenticated surface: `/share/{token}` (token is the secret), `/auth/*`, health endpoints, `/metrics` (Prometheus).

**Auth flow** (`apps/api/internal/auth` + `apps/web/app/lib/auth.ts`): backend-driven OIDC code+PKCE; refresh token lives in an encrypted cookie, the SPA keeps a short-lived access token in memory only and renews via `POST /auth/refresh`. `OIDC_CLIENT_SECRET` empty = public PKCE client.

**Frontend** (`apps/web/app`): all API calls go through the typed fetch wrapper in `lib/api.ts`. Editor is Monaco + y-monaco, wired to `@syncscribe/client` via `lib/yjs.ts`. Key routes: `/d/[id]` (authed editor), `/p/[token]` (public share), `/invites/[token]`.

## Conventions

- **TypeScript:** strict mode on. No `any`. Path alias `@/*` → `app/*`.
- **Go:** stdlib-first. `internal/` for non-exported packages. Errors wrapped with `fmt.Errorf("...: %w", err)`.
- **Migrations:** goose single-file SQL in `apps/api/migrations/NNNNN_name.sql` with `-- +goose Up` / `-- +goose Down` sections (embedded via `embed.go`). Never edit a landed migration.
- **No comments unless the WHY is non-obvious.** Identifier names should carry the WHAT.
- **Don't `pnpm install` or `go mod download` proactively** — those are heavy and the user runs them via `make install`.

## Tech decisions (already made — don't re-litigate)

- Yjs server: custom Go relay in `internal/sync` (PLAN.md P1.1, Option A). The `k_yrs_go` persistence sidecar is deferred indefinitely — revisit only if compaction-driven latency is measurable.
- IAM: standard OIDC against the user's existing authorization server. Dex is the local-dev IdP only.
- `users.id` is `TEXT` (OIDC `sub`), not UUID.
- WS target framing: stock `y-protocols` varint (`syncscribe.yjs.v1`). The tagged `syncscribe.v1` transport exists only for the migration window — don't extend it.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
