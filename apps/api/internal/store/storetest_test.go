package store

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/abhishek/sync-scribe/api/migrations"
)

// Store tests run against a real Postgres so the SQL is what's under test.
// TEST_DATABASE_URL points at a dedicated database (default: syncscribe_test
// on the docker-compose Postgres); tests skip cleanly when it's unreachable
// so `go test ./...` works without infra. Create the database once with:
//
//	docker compose exec postgres psql -U syncscribe -c "CREATE DATABASE syncscribe_test"
const defaultTestDSN = "postgres://syncscribe:syncscribe@localhost:5433/syncscribe_test?sslmode=disable"

var (
	migrateOnce sync.Once
	migrateErr  error
)

func testDSN() string {
	if dsn := os.Getenv("TEST_DATABASE_URL"); dsn != "" {
		return dsn
	}
	return defaultTestDSN
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dsn := testDSN()

	migrateOnce.Do(func() {
		db, err := sql.Open("pgx", dsn)
		if err != nil {
			migrateErr = err
			return
		}
		defer db.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			migrateErr = err
			return
		}
		goose.SetBaseFS(migrations.FS)
		goose.SetLogger(goose.NopLogger())
		if err := goose.SetDialect("postgres"); err != nil {
			migrateErr = err
			return
		}
		migrateErr = goose.UpContext(ctx, db, ".")
	})
	if migrateErr != nil {
		t.Skipf("store tests need Postgres at TEST_DATABASE_URL (%s): %v", dsn, migrateErr)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := Open(ctx, dsn)
	if err != nil {
		t.Skipf("store tests need Postgres at TEST_DATABASE_URL (%s): %v", dsn, err)
	}
	t.Cleanup(func() {
		truncateAll(t, s)
		s.Close()
	})
	return s
}

// truncateAll resets every app table (not goose bookkeeping) so tests stay
// isolated without per-test transaction plumbing.
func truncateAll(t *testing.T, s *Store) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	rows, err := s.Pool.Query(ctx, `
SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND tablename NOT LIKE 'goose%'
`)
	if err != nil {
		t.Fatalf("list tables: %v", err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan table: %v", err)
		}
		tables = append(tables, name)
	}
	if len(tables) == 0 {
		return
	}
	if _, err := s.Pool.Exec(ctx, "TRUNCATE "+strings.Join(tables, ", ")+" RESTART IDENTITY CASCADE"); err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

func mustUser(t *testing.T, s *Store, id string) {
	t.Helper()
	if _, err := s.UpsertUser(context.Background(), User{
		ID:          id,
		Email:       id + "@test.local",
		DisplayName: id,
	}); err != nil {
		t.Fatalf("upsert user %s: %v", id, err)
	}
}
