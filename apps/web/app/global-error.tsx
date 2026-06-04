"use client";

// global-error replaces the root layout when error.tsx itself throws, so it
// must render its own <html>/<body>. Keep dependencies minimal — no Toaster,
// no app shell — because the surrounding tree is unreliable here.

import { useEffect } from "react";
import { logger } from "./lib/logger";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error("global-error boundary", { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem", textAlign: "center" }}>
          <div>
            <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Something went very wrong.</h1>
            <p style={{ marginTop: "0.5rem", opacity: 0.7 }}>
              Please reload the page. If the problem persists, contact support.
            </p>
            <button
              onClick={reset}
              style={{
                marginTop: "1rem",
                padding: "0.5rem 1rem",
                borderRadius: "0.375rem",
                background: "black",
                color: "white",
                border: "none",
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
