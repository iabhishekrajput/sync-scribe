import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-current/10 p-6 text-center">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="mt-2 text-sm opacity-70">
          We couldn&apos;t find what you were looking for.
        </p>
        <Link
          href="/"
          className="mt-4 inline-block rounded-md bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
        >
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
