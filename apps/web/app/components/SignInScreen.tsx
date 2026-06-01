"use client";

import { loginURL } from "../lib/auth";
import { ThemeToggle } from "./ThemeToggle";

const oidcProviderName = process.env.NEXT_PUBLIC_OIDC_PROVIDER_NAME?.trim() || "OIDC";

export function SignInScreen({ returnTo = "/" }: { returnTo?: string }) {
  return (
    <main className="min-h-screen bg-white text-neutral-950 dark:bg-neutral-950 dark:text-neutral-50">
      <header className="flex h-14 items-center justify-between border-b border-current/10 px-4 sm:px-6">
        <a href="/" className="text-sm font-semibold tracking-tight">
          SyncScribe
        </a>
        <ThemeToggle />
      </header>

      <section className="grid min-h-[calc(100vh-3.5rem)] grid-cols-1 lg:grid-cols-[minmax(22rem,0.85fr)_minmax(34rem,1.15fr)]">
        <div className="flex items-center justify-center border-b border-current/10 px-5 py-10 lg:border-b-0 lg:border-r lg:px-8">
          <div className="w-full max-w-sm">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide opacity-50">Workspace access</p>
            <h1 className="text-3xl font-semibold tracking-tight">Sign in to SyncScribe</h1>
            <p className="mt-3 text-sm leading-6 opacity-65">
              Open your collaborative Markdown workspace and continue from your latest saved document state.
            </p>
            <a
              href={loginURL(returnTo)}
              className="mt-8 flex h-11 w-full items-center justify-center rounded-md bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200"
            >
              Continue with {oidcProviderName}
            </a>
            <div className="mt-5 flex items-center justify-between text-xs opacity-55">
              <span>Secure workspace session</span>
              <span>SyncScribe v1</span>
            </div>
          </div>
        </div>

        <div className="hidden min-h-0 items-center justify-center bg-neutral-50 px-8 py-10 dark:bg-neutral-900/40 lg:flex">
          <div className="w-full max-w-3xl overflow-hidden rounded-lg border border-current/10 bg-white shadow-2xl shadow-black/10 dark:bg-neutral-950 dark:shadow-black/30">
            <div className="flex h-11 items-center justify-between border-b border-current/10 px-4">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
              </div>
              <span className="text-xs font-medium opacity-45">PLAN - SyncScribe</span>
            </div>
            <div className="grid h-[28rem] grid-cols-[12rem_1fr]">
              <aside className="border-r border-current/10 bg-current/[0.025] p-3">
                <div className="mb-4 h-3 w-24 rounded-full bg-current/15" />
                <div className="space-y-2">
                  <div className="rounded-md bg-current/10 px-2 py-2">
                    <div className="h-2.5 w-28 rounded-full bg-current/25" />
                    <div className="mt-2 h-2 w-10 rounded-full bg-current/15" />
                  </div>
                  <div className="rounded-md px-2 py-2">
                    <div className="h-2.5 w-24 rounded-full bg-current/15" />
                    <div className="mt-2 h-2 w-8 rounded-full bg-current/10" />
                  </div>
                  <div className="rounded-md px-2 py-2">
                    <div className="h-2.5 w-20 rounded-full bg-current/15" />
                    <div className="mt-2 h-2 w-12 rounded-full bg-current/10" />
                  </div>
                </div>
              </aside>
              <div className="grid grid-cols-2">
                <div className="border-r border-current/10 p-5 font-mono text-xs leading-6">
                  <div className="mb-3 h-4 w-40 rounded-full bg-current/15" />
                  <p className="text-blue-700 dark:text-blue-300"># Phase 1 Ship Gate</p>
                  <p className="opacity-55">- protocol closure</p>
                  <p className="opacity-55">- recovery tests</p>
                  <p className="opacity-55">- realtime limits</p>
                  <p className="mt-4 text-emerald-700 dark:text-emerald-300">Saved</p>
                </div>
                <div className="p-5">
                  <div className="mb-4 h-5 w-48 rounded-full bg-current/15" />
                  <div className="space-y-3">
                    <div className="h-3 w-full rounded-full bg-current/10" />
                    <div className="h-3 w-11/12 rounded-full bg-current/10" />
                    <div className="h-3 w-4/5 rounded-full bg-current/10" />
                  </div>
                  <div className="mt-8 rounded-md border border-current/10 p-4">
                    <div className="mb-3 h-3 w-24 rounded-full bg-current/15" />
                    <div className="grid grid-cols-3 gap-2">
                      <div className="h-16 rounded bg-current/10" />
                      <div className="h-16 rounded bg-current/10" />
                      <div className="h-16 rounded bg-current/10" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
