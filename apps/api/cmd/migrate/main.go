// Migrate is a thin wrapper around github.com/pressly/goose so that:
//
//   - the repo has a single canonical CLI shape (`go run ./cmd/migrate up`)
//   - CI and the local Makefile don't need a separately installed `goose`
//     binary
//   - migrations are embedded into the Go binary via the migrations package,
//     so the runner behaves the same in a container as on a dev laptop
//
// Anything goose supports (up, down, status, redo, reset, create, fix) is
// passed through verbatim; we don't try to mirror the CLI surface here.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/abhishek/sync-scribe/api/migrations"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: migrate <command> [args]")
		fmt.Fprintln(os.Stderr, "       commands: up, up-to <v>, down, down-to <v>, status, version, redo, reset")
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		exit(fmt.Errorf("DATABASE_URL is required"))
	}

	conn, err := sql.Open("pgx", dsn)
	if err != nil {
		exit(err)
	}
	defer conn.Close()

	if err := conn.PingContext(context.Background()); err != nil {
		exit(fmt.Errorf("ping: %w", err))
	}

	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		exit(err)
	}

	if err := goose.RunContext(context.Background(), cmd, conn, ".", args...); err != nil {
		exit(err)
	}
}

func exit(err error) {
	fmt.Fprintln(os.Stderr, "migrate:", err)
	os.Exit(1)
}
