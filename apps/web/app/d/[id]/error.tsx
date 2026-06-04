"use client";

import { useEffect } from "react";
import Link from "next/link";
import { notifyError } from "../../lib/errors";

export default function EditorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    notifyError(error, "editor-boundary");
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-current/10 p-6 text-center">
        <h1 className="text-lg font-semibold">Could not load this document.</h1>
        <p className="mt-2 text-sm opacity-70">
          The document may have been deleted, or your access has changed.
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-md border border-current/15 px-4 py-2 text-sm hover:bg-current/5"
          >
            Back to documents
          </Link>
        </div>
      </div>
    </main>
  );
}
