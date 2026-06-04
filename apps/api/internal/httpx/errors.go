// Package httpx is the single home for the JSON error envelope, the typed
// error model handlers raise, and the request-scoped logging middleware.
//
// Wire contract — every error response is a single envelope shape:
//
//	{"error":{"code":"<httpx.Code>","message":"<user-facing>","request_id":"<chi RequestID>"}}
//
// The frontend at apps/web/app/lib/errors.ts depends on this shape; do not
// change field names or nesting without bumping both sides.
package httpx

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/abhishek/sync-scribe/api/internal/store"
)

// Code is the stable machine-readable identifier the frontend branches on.
// Add codes here when a new failure category needs a distinct UI affordance
// (e.g. a "session expired → kick to /login" path).
type Code string

const (
	CodeBadRequest       Code = "bad_request"
	CodeUnauthenticated  Code = "unauthenticated"
	CodeForbidden        Code = "forbidden"
	CodeNotFound         Code = "not_found"
	CodeConflict         Code = "conflict"
	CodePayloadTooLarge  Code = "payload_too_large"
	CodeUnsupportedMedia Code = "unsupported_media_type"
	CodeRateLimited      Code = "rate_limited"
	CodeUnavailable      Code = "unavailable"
	CodeInternal         Code = "internal"
)

// Error is the typed error handlers raise. Message is user-facing and goes on
// the wire; Internal is for logs only and is never serialised.
type Error struct {
	Code     Code
	HTTP     int
	Message  string
	Internal error
	Fields   map[string]any
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Internal != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Internal)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Internal
}

// WithField attaches a structured-log field that lands in the warn/error log
// line written by WriteError. Returns the receiver for fluent use.
func (e *Error) WithField(key string, value any) *Error {
	if e.Fields == nil {
		e.Fields = make(map[string]any, 2)
	}
	e.Fields[key] = value
	return e
}

func BadRequest(msg string, internal error) *Error {
	return &Error{Code: CodeBadRequest, HTTP: http.StatusBadRequest, Message: msg, Internal: internal}
}

func Unauthenticated(msg string, internal error) *Error {
	return &Error{Code: CodeUnauthenticated, HTTP: http.StatusUnauthorized, Message: msg, Internal: internal}
}

func Forbidden(msg string, internal error) *Error {
	return &Error{Code: CodeForbidden, HTTP: http.StatusForbidden, Message: msg, Internal: internal}
}

func NotFound(msg string, internal error) *Error {
	return &Error{Code: CodeNotFound, HTTP: http.StatusNotFound, Message: msg, Internal: internal}
}

func Conflict(msg string, internal error) *Error {
	return &Error{Code: CodeConflict, HTTP: http.StatusConflict, Message: msg, Internal: internal}
}

func PayloadTooLarge(msg string, internal error) *Error {
	return &Error{Code: CodePayloadTooLarge, HTTP: http.StatusRequestEntityTooLarge, Message: msg, Internal: internal}
}

func UnsupportedMedia(msg string, internal error) *Error {
	return &Error{Code: CodeUnsupportedMedia, HTTP: http.StatusUnsupportedMediaType, Message: msg, Internal: internal}
}

func RateLimited(msg string, internal error) *Error {
	return &Error{Code: CodeRateLimited, HTTP: http.StatusTooManyRequests, Message: msg, Internal: internal}
}

func Unavailable(msg string, internal error) *Error {
	return &Error{Code: CodeUnavailable, HTTP: http.StatusServiceUnavailable, Message: msg, Internal: internal}
}

func BadGateway(msg string, internal error) *Error {
	return &Error{Code: CodeUnavailable, HTTP: http.StatusBadGateway, Message: msg, Internal: internal}
}

func Internal(msg string, internal error) *Error {
	return &Error{Code: CodeInternal, HTTP: http.StatusInternalServerError, Message: msg, Internal: internal}
}

// From normalises any error into an *Error. Already-typed errors pass through.
// Store sentinels map to user-facing equivalents; everything else degrades to
// 500. Auth-specific errors live in the auth package — its middleware
// constructs the right Unauthenticated message directly so this package
// stays leaf-level alongside store.
func From(err error) *Error {
	if err == nil {
		return nil
	}
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	switch {
	case errors.Is(err, store.ErrNotFound):
		return NotFound("Not found.", err)
	case errors.Is(err, store.ErrForbidden):
		return Forbidden("You don't have access to this.", err)
	case errors.Is(err, store.ErrInvalidInput):
		return BadRequest(err.Error(), err)
	}
	return Internal("Something went wrong on our end.", err)
}
