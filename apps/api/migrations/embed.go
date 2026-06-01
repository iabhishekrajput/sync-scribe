// Package migrations exposes the SQL migration files as an embedded
// filesystem so cmd/migrate (and any future inline migrator) can ship a
// single binary without a side-loaded directory.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
