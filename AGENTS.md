# Codex project guide — SyncScribe

Read `plan.md` for the full blueprint. Read this file for working norms.

## Repo layout

```
apps/web/      Next.js 16, App Router, TS, Tailwind 4
apps/api/      Go 1.26 backend (chi REST + Gorilla WS custom Yjs relay)
packages/client/  @syncscribe/client — WS sync + attribution SDK (TS)
packages/proto/   Shared wire constants (TS) imported by web + client
infra/dex/     Local-dev OIDC IdP config
```

For the full architecture and command reference, see `CLAUDE.md` — it is kept current; this file is the short working-norms companion.

## Conventions

- **TypeScript:** strict mode on. No `any`. Path alias `@/*` → `app/*`.
- **Go:** stdlib-first. `internal/` for non-exported packages. Errors wrapped with `fmt.Errorf("...: %w", err)`.
- **Migrations:** goose single-file SQL in `apps/api/migrations/NNNNN_name.sql` (`-- +goose Up` / `-- +goose Down`). Never edit a landed migration.
- **No comments unless the WHY is non-obvious.** Identifier names should carry the WHAT.
- **Don't `pnpm install` or `go mod download` proactively** — those are heavy and the user runs them via `make install`.

## Tech decisions (already made — don't re-litigate)

- Yjs server: custom Go relay in `internal/sync` (PLAN.md P1.1, Option A). No `k_yrs_go`.
- IAM: standard OIDC against the user's existing authorization server. Dex is the local-dev IdP only.
- `users.id` is `TEXT` (OIDC `sub`), not UUID.
- WS framing: stock `y-protocols` varint, single subprotocol `syncscribe.yjs.v1`. The legacy tagged transport was removed — no custom byte tag.

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
