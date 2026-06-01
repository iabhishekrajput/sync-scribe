.PHONY: help up down dev web api migrate migrate-status migrate-down migrate-reset seed test lint typecheck install

ifneq (,$(wildcard .env))
include .env
export
endif

help:
	@echo "Targets:"
	@echo "  install      Install all deps (pnpm + go mod)"
	@echo "  up           docker compose up (Postgres, Valkey, Mailpit)"
	@echo "  down         docker compose down"
	@echo "  dev          Run web + api concurrently"
	@echo "  web          Run Next.js dev server only"
	@echo "  api          Run Go API only"
	@echo "  migrate      Run goose 'up' (apply pending migrations)"
	@echo "  migrate-status  Show goose migration status"
	@echo "  migrate-down Roll back one migration"
	@echo "  migrate-reset Drop all migrations (destructive)"
	@echo "  seed         Seed dev database"
	@echo "  test         Run all tests"
	@echo "  lint         Lint all packages"
	@echo "  typecheck    Type-check TS packages"

install:
	pnpm install
	cd apps/api && go mod download

up:
	docker compose up -d
	@echo "Waiting for Postgres..."
	@until docker compose exec -T postgres pg_isready -U syncscribe >/dev/null 2>&1; do sleep 1; done
	@echo "Stack is up."

down:
	docker compose down

dev:
	@trap 'kill 0' INT; \
	$(MAKE) web & \
	$(MAKE) api & \
	wait

web:
	pnpm --filter web dev

api:
	cd apps/api && go run ./cmd/api

migrate:
	cd apps/api && go run ./cmd/migrate up

migrate-status:
	cd apps/api && go run ./cmd/migrate status

migrate-down:
	cd apps/api && go run ./cmd/migrate down

migrate-reset:
	cd apps/api && go run ./cmd/migrate reset

seed:
	cd apps/api && go run ./cmd/seed

test:
	pnpm -r test
	cd apps/api && go test ./...

lint:
	pnpm -r lint
	cd apps/api && go vet ./...

typecheck:
	pnpm -r typecheck
