"use client";

import Link from "next/link";
import { loginURL } from "../lib/auth";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu, type MeShape } from "./UserMenu";
import type { AvatarStatus } from "./Avatar";

type Props = {
  me?: MeShape | null;
  onSignedOut?: () => void;
  /** Inline content between the logo and the right-side cluster. */
  center?: React.ReactNode;
  /** Right-side content placed before the theme toggle + avatar. */
  right?: React.ReactNode;
  /** Realtime status — rendered as a colored pip on the user avatar. */
  status?: AvatarStatus;
};

// Reusable header shared between the dashboard and the editor. Brand on the
// left, free-form content in the middle, then the always-on theme toggle +
// user menu on the right.
export function TopBar({ me, onSignedOut, center, right, status }: Props) {
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center justify-between gap-2 border-b border-current/10 bg-white/90 px-3 backdrop-blur dark:bg-neutral-950/90 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <Link href="/" className="shrink-0 text-sm font-semibold tracking-tight">
          SyncScribe
        </Link>
        {center && <div className="flex min-w-0 flex-1 items-center gap-2">{center}</div>}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        {right}
        <ThemeToggle />
        {me ? (
          <UserMenu me={me} status={status} onSignedOut={onSignedOut} />
        ) : (
          <a
            href={loginURL("/")}
            className="rounded-md border border-current/15 px-2.5 py-1 text-sm hover:bg-current/5"
          >
            Sign in
          </a>
        )}
      </div>
    </header>
  );
}
