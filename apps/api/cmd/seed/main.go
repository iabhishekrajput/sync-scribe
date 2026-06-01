package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/abhishek/sync-scribe/api/internal/store"
)

const demoOwnerID = "seed-demo-owner"
const demoUpdateBase64 = "AQHUzNa0BQAEAQdjb250ZW50hAQjIFN5bmNTY3JpYmUgZGVtbwoKVGhpcyBkb2N1bWVudCBpcyBzZWVkZWQgYnkgdGhlIGxvY2FsIGRlbW8gY29tbWFuZCBzbyBhIGZyZXNoIHN0YWNrIGhhcyBhIHJlYWwgY29sbGFib3JhdGl2ZSB0YXJnZXQgaW1tZWRpYXRlbHkuCgojIyBUcnkgdGhpcwoKLSBPcGVuIHRoZSBwdWJsaWMgc2hhcmUgbGluayBwcmludGVkIGJ5IHRoZSBzZWVkIGNvbW1hbmQuCi0gRWRpdCB0aGlzIGxpbmUgZnJvbSB0d28gYnJvd3NlciB0YWJzIHRvIHZlcmlmeSByZWFsdGltZSBzeW5jLgotIFRvZ2dsZSBhdHRyaWJ1dGlvbiBpbiB0aGUgcHJpdmF0ZSBlZGl0b3IgdG8gaW5zcGVjdCBwZXItY2hhcmFjdGVyIGJsYW1lLgoKIyMgUGhhc2UgMwoKVGhpcyByZXBvIG5vdyBzcGVha3Mgc3RvY2sgeS1wcm90b2NvbHMgZnJhbWluZyBvbiB0aGUgV2ViU29ja2V0IHBhdGgsIHdoaWxlIHByZXNlcnZpbmcgU3luY1NjcmliZS1zcGVjaWZpYyByZWFkb25seSBhbmQgQUNLIHNpZ25hbHMgZHVyaW5nIHRoZSBtaWdyYXRpb24gd2luZG93LgoA"
const demoMarkdown = `# SyncScribe demo

This document is seeded by the local demo command so a fresh stack has a real collaborative target immediately.

## Try this

- Open the public share link printed by the seed command.
- Edit this line from two browser tabs to verify realtime sync.
- Toggle attribution in the private editor to inspect per-character blame.

## Phase 3

This repo now speaks stock y-protocols framing on the WebSocket path, while preserving SyncScribe-specific readonly and ACK signals during the migration window.
`

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	frontendBaseURL := envOr("FRONTEND_BASE_URL", "http://localhost:3000")

	st, err := store.Open(ctx, dbURL)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	owner, err := st.UpsertUser(ctx, store.User{
		ID:          demoOwnerID,
		Email:       "demo@syncscribe.local",
		DisplayName: "SyncScribe Demo",
	})
	if err != nil {
		log.Fatalf("upsert demo owner: %v", err)
	}

	doc, err := st.CreateDocument(ctx, owner.ID, "SyncScribe demo")
	if err != nil {
		log.Fatalf("create demo document: %v", err)
	}

	updateBlob, err := base64.StdEncoding.DecodeString(demoUpdateBase64)
	if err != nil {
		log.Fatalf("decode demo update: %v", err)
	}
	if _, err := st.AppendUpdate(ctx, doc.ID, owner.ID, updateBlob); err != nil {
		log.Fatalf("append demo update: %v", err)
	}

	version, err := st.PutSnapshot(ctx, doc.ID, owner.ID, []byte(demoMarkdown))
	if err != nil {
		log.Fatalf("publish demo snapshot: %v", err)
	}

	link, err := st.CreateShareLink(ctx, doc.ID, owner.ID, "editor", nil)
	if err != nil {
		log.Fatalf("create demo share link: %v", err)
	}

	base := strings.TrimRight(frontendBaseURL, "/")
	fmt.Printf("Seeded demo document\n")
	fmt.Printf("Document ID: %s\n", doc.ID)
	fmt.Printf("Snapshot version: %d\n", version)
	fmt.Printf("Public editor link: %s/p/%s\n", base, link.Token)
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
