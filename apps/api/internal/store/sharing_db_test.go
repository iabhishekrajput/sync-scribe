package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestShareLinkLifecycle(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	mustUser(t, s, "owner")
	mustUser(t, s, "other")
	doc, err := s.CreateDocument(ctx, "owner", "Doc")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := s.CreateShareLink(ctx, doc.ID, "other", "viewer", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-owner mint: err=%v want ErrForbidden", err)
	}

	link, err := s.CreateShareLink(ctx, doc.ID, "owner", "editor", nil)
	if err != nil {
		t.Fatalf("CreateShareLink: %v", err)
	}
	gotLink, gotDoc, err := s.LookupShareLink(ctx, link.Token)
	if err != nil || gotDoc.ID != doc.ID || gotLink.Role != "editor" {
		t.Fatalf("lookup: link=%+v doc=%+v err=%v", gotLink, gotDoc, err)
	}

	// Expired links don't resolve.
	past := time.Now().Add(-time.Hour)
	expired, err := s.CreateShareLink(ctx, doc.ID, "owner", "viewer", &past)
	if err != nil {
		t.Fatalf("create expired: %v", err)
	}
	if _, _, err := s.LookupShareLink(ctx, expired.Token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired lookup: err=%v want ErrNotFound", err)
	}

	// Revoked links don't resolve.
	if err := s.RevokeShareLink(ctx, doc.ID, "owner", link.Token); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, _, err := s.LookupShareLink(ctx, link.Token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked lookup: err=%v want ErrNotFound", err)
	}
}

func TestInviteClaimGrantsAccess(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	mustUser(t, s, "owner")
	doc, err := s.CreateDocument(ctx, "owner", "Doc")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	invite, err := s.CreateInvite(ctx, doc.ID, "owner", "new@test.local", "editor")
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	// Invitee email has no account yet, so nothing is granted up-front.
	if invite.GrantedUserID != "" {
		t.Fatalf("pre-claim grant for unknown email: %q", invite.GrantedUserID)
	}

	mustUser(t, s, "newcomer")
	claimed, err := s.ClaimInvite(ctx, invite.Token, "newcomer", "new@test.local")
	if err != nil || claimed.ID != doc.ID {
		t.Fatalf("ClaimInvite: doc=%+v err=%v", claimed, err)
	}
	_, role, err := s.ResolveDocumentRole(ctx, doc.ID, "newcomer")
	if err != nil || role != "editor" {
		t.Fatalf("post-claim role = %q err=%v, want editor", role, err)
	}
}

func TestAccessRequestApproveFlow(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	mustUser(t, s, "owner")
	mustUser(t, s, "requester")
	doc, err := s.CreateDocument(ctx, "owner", "Doc")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := s.UpsertAccess(ctx, doc.ID, "owner", "requester", "viewer"); err != nil {
		t.Fatalf("grant viewer: %v", err)
	}

	req, err := s.RequestAccess(ctx, doc.ID, "requester", "editor", "please")
	if err != nil {
		t.Fatalf("RequestAccess: %v", err)
	}
	if req.Status != "pending" {
		t.Fatalf("status = %q, want pending", req.Status)
	}
	// Re-requesting while one is pending is idempotent: the same request
	// comes back instead of a second row (partial unique index backstops).
	dup, err := s.RequestAccess(ctx, doc.ID, "requester", "editor", "again")
	if err != nil || dup.ID != req.ID {
		t.Fatalf("duplicate request: id=%v err=%v, want existing %v", dup.ID, err, req.ID)
	}

	// Only the owner can resolve.
	if _, err := s.ResolveAccessRequest(ctx, doc.ID, req.ID, "requester", "approved"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("requester self-approve: err=%v want ErrForbidden", err)
	}
	resolved, err := s.ResolveAccessRequest(ctx, doc.ID, req.ID, "owner", "approved")
	if err != nil || resolved.Status != "approved" {
		t.Fatalf("approve: req=%+v err=%v", resolved, err)
	}
	_, role, err := s.ResolveDocumentRole(ctx, doc.ID, "requester")
	if err != nil || role != "editor" {
		t.Fatalf("post-approve role = %q err=%v, want editor", role, err)
	}
}
