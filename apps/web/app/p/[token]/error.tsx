"use client";

import { useEffect } from "react";
import { notifyError } from "../../lib/errors";

export default function PublicShareError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    notifyError(error, "public-share-boundary");
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-current/10 p-6 text-center">
        <h1 className="text-lg font-semibold">Could not open this shared document.</h1>
        <p className="mt-2 text-sm opacity-70">
          The link may be revoked or expired.
        </p>
        <button
          onClick={reset}
          className="mt-4 rounded-md bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
