"use client";

// Tiny structured wrapper around console.{debug,info,warn,error}. The level
// + ISO timestamp + app=web prefix is enough for browser-devtools triage and
// for piping logs into a remote sink later without rewriting call sites.

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string, fields?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}] [app=web]`;
  if (fields && Object.keys(fields).length > 0) {
    console[level](prefix, message, fields);
  } else {
    console[level](prefix, message);
  }
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};
