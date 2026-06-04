"use client";

import { toast } from "sonner";
import { logger } from "./logger";

// Wire shape mirrored from apps/api/internal/httpx — must stay in sync.
export type ApiErrorEnvelope = {
  error: { code: string; message: string; request_id?: string };
};

// Stable error codes emitted by the backend. Keep this list in sync with
// httpx.Code in Go; the union is informational — `code` is typed as string
// at the runtime boundary so unknown codes don't blow up at parse time.
export type ApiErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "unavailable"
  | "internal";

export class ApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;

  constructor(status: number, message: string, code?: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

// parseApiError reads the JSON envelope from a non-OK Response and returns a
// typed ApiError. Falls back to statusText / a generic message so callers
// never have to handle "what if the body isn't JSON" themselves.
export async function parseApiError(res: Response): Promise<ApiError> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const body = (await res.json()) as Partial<ApiErrorEnvelope>;
      if (body?.error && typeof body.error.message === "string") {
        return new ApiError(
          res.status,
          body.error.message,
          body.error.code,
          body.error.request_id,
        );
      }
    } catch {
      // fall through to text fallback
    }
  }
  // Non-JSON or malformed JSON — read the body once for the message but
  // keep it short so a giant HTML 502 page doesn't end up in a toast.
  let text = "";
  try {
    text = (await res.text()).slice(0, 200);
  } catch {
    /* ignore */
  }
  return new ApiError(res.status, text || res.statusText || "Request failed");
}

// userMessage maps any caught value to a string safe to display. ApiError
// branches by code first so we can soften specific backend messages without
// overriding the user-facing copy the server already chose.
export function userMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.message) return err.message;
    switch (err.code) {
      case "unauthenticated":
        return "Sign in to continue.";
      case "forbidden":
        return "You don't have access to do that.";
      case "not_found":
        return "We couldn't find that.";
      case "rate_limited":
        return "Slow down a moment and try again.";
      case "payload_too_large":
        return "That file is too large.";
      case "unsupported_media_type":
        return "That file type isn't supported.";
      case "unavailable":
        return "The server is unavailable right now.";
      default:
        return "Something went wrong.";
    }
  }
  // fetch() throws TypeError for network failures (DNS, offline, CORS).
  if (err instanceof TypeError) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}

// notifyError is the one-stop call site: structured log + user-visible toast.
// Pass a context tag so the log line tells us where the failure originated.
export function notifyError(err: unknown, context?: string): void {
  const msg = userMessage(err);
  const fields: Record<string, unknown> = {};
  if (context) fields.context = context;
  if (err instanceof ApiError) {
    fields.status = err.status;
    if (err.code) fields.code = err.code;
    if (err.requestId) fields.request_id = err.requestId;
  } else if (err instanceof Error) {
    fields.error_name = err.name;
  }
  logger.error(msg, fields);
  toast.error(msg);
}
