package store

import (
	"context"
	"errors"
	"testing"
)

func TestDocumentCRUDAndRoles(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	mustUser(t, s, "owner")
	mustUser(t, s, "editor")
	mustUser(t, s, "viewer")
	mustUser(t, s, "stranger")

	// Callers (handlers) trim; the store defaults only the exact empty string.
	doc, err := s.CreateDocument(ctx, "owner", "")
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if doc.Title != "Untitled" {
		t.Fatalf("empty title should default to Untitled, got %q", doc.Title)
	}

	if _, err := s.UpsertAccess(ctx, doc.ID, "owner", "editor", "editor"); err != nil {
		t.Fatalf("grant editor: %v", err)
	}
	if _, err := s.UpsertAccess(ctx, doc.ID, "owner", "viewer", "viewer"); err != nil {
		t.Fatalf("grant viewer: %v", err)
	}

	for _, tc := range []struct {
		user string
		role string
		err  error
	}{
		{"owner", "owner", nil},
		{"editor", "editor", nil},
		{"viewer", "viewer", nil},
		{"stranger", "", ErrForbidden},
	} {
		_, role, err := s.ResolveDocumentRole(ctx, doc.ID, tc.user)
		if !errors.Is(err, tc.err) {
			t.Fatalf("ResolveDocumentRole(%s): err=%v want %v", tc.user, err, tc.err)
		}
		if role != tc.role {
			t.Fatalf("ResolveDocumentRole(%s): role=%q want %q", tc.user, role, tc.role)
		}
	}

	// Non-owner cannot grant or list access.
	if _, err := s.UpsertAccess(ctx, doc.ID, "editor", "stranger", "viewer"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("editor granting access: err=%v want ErrForbidden", err)
	}
	if _, err := s.ListAccess(ctx, doc.ID, "editor"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("editor listing access: err=%v want ErrForbidden", err)
	}

	// Revoke flips the viewer to forbidden.
	if err := s.DeleteAccess(ctx, doc.ID, "owner", "viewer"); err != nil {
		t.Fatalf("DeleteAccess: %v", err)
	}
	if _, _, err := s.ResolveDocumentRole(ctx, doc.ID, "viewer"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("revoked viewer: err=%v want ErrForbidden", err)
	}

	// Rename is owner-only (RenameDocument matches owner_id in SQL).
	if _, err := s.RenameDocument(ctx, doc.ID, "editor", "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("editor rename: err=%v want ErrNotFound", err)
	}
	renamed, err := s.RenameDocument(ctx, doc.ID, "owner", "Spec")
	if err != nil || renamed.Title != "Spec" {
		t.Fatalf("owner rename: doc=%+v err=%v", renamed, err)
	}

	// Soft delete hides the doc from every reader.
	if err := s.SoftDeleteDocument(ctx, doc.ID, "owner"); err != nil {
		t.Fatalf("SoftDeleteDocument: %v", err)
	}
	if _, err := s.GetDocument(ctx, doc.ID, "owner"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted doc: err=%v want ErrNotFound", err)
	}
}

func TestListDocumentsScopes(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	mustUser(t, s, "u1")
	mustUser(t, s, "u2")

	mine, err := s.CreateDocument(ctx, "u1", "Mine")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	theirs, err := s.CreateDocument(ctx, "u2", "Theirs Shared")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := s.UpsertAccess(ctx, theirs.ID, "u2", "u1", "viewer"); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if _, err := s.CreateDocument(ctx, "u2", "Invisible"); err != nil {
		t.Fatalf("create: %v", err)
	}

	cases := []struct {
		scope string
		query string
		want  map[string]bool
	}{
		{"all", "", map[string]bool{"Mine": true, "Theirs Shared": true}},
		{"owned", "", map[string]bool{"Mine": true}},
		{"shared", "", map[string]bool{"Theirs Shared": true}},
		{"all", "shared", map[string]bool{"Theirs Shared": true}},
	}
	for _, tc := range cases {
		docs, err := s.ListDocumentsForUser(ctx, "u1", DocumentListOptions{Scope: tc.scope, Query: tc.query})
		if err != nil {
			t.Fatalf("list %s: %v", tc.scope, err)
		}
		got := map[string]bool{}
		for _, d := range docs {
			got[d.Title] = true
		}
		if len(got) != len(tc.want) {
			t.Fatalf("scope=%q q=%q: got %v want %v", tc.scope, tc.query, got, tc.want)
		}
		for title := range tc.want {
			if !got[title] {
				t.Fatalf("scope=%q q=%q: missing %q in %v", tc.scope, tc.query, title, got)
			}
		}
	}
	_ = mine
}

func TestAppendUpdate_GuestStoresNullOrigin(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	mustUser(t, s, "owner")
	doc, err := s.CreateDocument(ctx, "owner", "Doc")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := s.AppendUpdate(ctx, doc.ID, "owner", []byte{0x01}); err != nil {
		t.Fatalf("append as owner: %v", err)
	}
	// Guests pass empty originUser; NULLIF must store NULL or the users FK
	// would reject the synthetic guest subject.
	seq, err := s.AppendUpdate(ctx, doc.ID, "", []byte{0x02})
	if err != nil {
		t.Fatalf("append as guest: %v", err)
	}
	if seq != 2 {
		t.Fatalf("guest seq = %d, want 2", seq)
	}

	var nullCount int
	if err := s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM document_updates WHERE document_id = $1 AND origin_user IS NULL`,
		doc.ID).Scan(&nullCount); err != nil {
		t.Fatalf("count: %v", err)
	}
	if nullCount != 1 {
		t.Fatalf("expected 1 NULL origin_user row, got %d", nullCount)
	}

	updates, err := s.LoadUpdates(ctx, doc.ID)
	if err != nil || len(updates) != 2 {
		t.Fatalf("LoadUpdates: %v len=%d", err, len(updates))
	}
	if updates[0][0] != 0x01 || updates[1][0] != 0x02 {
		t.Fatalf("updates out of seq order: %v", updates)
	}
}

func TestSnapshotPublishRestoreVersionMath(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	mustUser(t, s, "owner")
	mustUser(t, s, "viewer")
	doc, err := s.CreateDocument(ctx, "owner", "Doc")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	v1, err := s.PutSnapshot(ctx, doc.ID, "owner", []byte("first"))
	if err != nil || v1 != 1 {
		t.Fatalf("PutSnapshot v1: v=%d err=%v", v1, err)
	}
	v2, err := s.PutSnapshot(ctx, doc.ID, "owner", []byte("second"))
	if err != nil || v2 != 2 {
		t.Fatalf("PutSnapshot v2: v=%d err=%v", v2, err)
	}

	// Restore v1 creates v3 with v1's bytes — branch-not-overwrite.
	if _, err := s.UpsertAccess(ctx, doc.ID, "owner", "viewer", "viewer"); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if _, _, err := s.RestoreSnapshot(ctx, doc.ID, 1, "viewer"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer restore: err=%v want ErrForbidden", err)
	}
	restored, v3, err := s.RestoreSnapshot(ctx, doc.ID, 1, "owner")
	if err != nil || v3 != 3 {
		t.Fatalf("restore: v=%d err=%v", v3, err)
	}
	if restored.CurrentVersion != 3 {
		t.Fatalf("document current_version = %d, want 3", restored.CurrentVersion)
	}
	snap, err := s.GetSnapshot(ctx, doc.ID, 3, "owner")
	if err != nil || snap.Body != "first" {
		t.Fatalf("restored body = %q err=%v, want \"first\"", snap.Body, err)
	}

	export, err := s.ExportMarkdown(ctx, doc.ID, "owner")
	if err != nil || string(export.Body) != "first" || export.Version != 3 {
		t.Fatalf("export: %+v err=%v", export, err)
	}
}

func TestAttributionCursorPagination(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	mustUser(t, s, "owner")
	doc, err := s.CreateDocument(ctx, "owner", "Doc")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	for i := 0; i < 5; i++ {
		if _, err := s.AppendUpdate(ctx, doc.ID, "owner", []byte{byte(i)}); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}

	page1, err := s.GetAttributionUpdates(ctx, doc.ID, "owner", AttributionQuery{Limit: 3})
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if len(page1.Updates) != 3 || page1.NextSinceUpdateID != 3 {
		t.Fatalf("page1: len=%d next=%d, want 3/3", len(page1.Updates), page1.NextSinceUpdateID)
	}
	page2, err := s.GetAttributionUpdates(ctx, doc.ID, "owner", AttributionQuery{SinceUpdateID: page1.NextSinceUpdateID, Limit: 3})
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(page2.Updates) != 2 || page2.Updates[0].Seq != 4 {
		t.Fatalf("page2: len=%d firstSeq=%d, want 2/4", len(page2.Updates), page2.Updates[0].Seq)
	}
	if page2.Updates[0].OriginUser != "owner" {
		t.Fatalf("origin_user = %q, want owner", page2.Updates[0].OriginUser)
	}
}
