# Claude Code project guide — SyncScribe

Read `plan.md` for the full blueprint. Read this file for working norms.

## Repo layout

```
apps/web/      Next.js 16, App Router, TS, Tailwind 4
apps/api/      Go 1.26 backend (chi REST + Gorilla WS + k_yrs_go)
packages/proto/ Shared wire constants (TS) imported by web
infra/dex/     Local-dev OIDC IdP config
```

## Conventions

- **TypeScript:** strict mode on. No `any`. Path alias `@/*` → `app/*`.
- **Go:** stdlib-first. `internal/` for non-exported packages. Errors wrapped with `fmt.Errorf("...: %w", err)`.
- **Migrations:** numbered SQL in `apps/api/migrations/NNNN_name.{up,down}.sql`. Never edit a landed migration.
- **No comments unless the WHY is non-obvious.** Identifier names should carry the WHAT.
- **Don't `pnpm install` or `go mod download` proactively** — those are heavy and the user runs them via `make install`.

## Tech decisions (already made — don't re-litigate)

- Yjs server: `k_yrs_go`. Hocuspocus is the documented M3-spike fallback.
- IAM: standard OIDC against the user's existing authorization server. Dex is the local-dev IdP only.
- `users.id` is `TEXT` (OIDC `sub`), not UUID.
- WS framing follows `y-protocols` varint — no custom byte tag.

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
