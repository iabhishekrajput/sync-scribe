"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { fetchMe, loginURL } from "../../lib/auth";

type ClaimState = "checking" | "claiming" | "claimed" | "error";

export default function InviteClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [state, setState] = useState<ClaimState>("checking");

  useEffect(() => {
    let alive = true;
    (async () => {
      const me = await fetchMe();
      if (!alive) return;
      if (!me) {
        window.location.href = loginURL(`/invites/${token}`);
        return;
      }
      setState("claiming");
      try {
        const res = await api.claimInvite(token);
        if (!alive) return;
        setState("claimed");
        router.replace(`/d/${res.document.id}`);
      } catch {
        if (alive) setState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [router, token]);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="text-center">
        <h1 className="text-xl font-semibold">Document invite</h1>
        <p className="mt-2 text-sm opacity-70">{copyForState(state)}</p>
        {state === "error" && (
          <button onClick={() => router.push("/")} className="mt-4 text-sm underline">
            Back to dashboard
          </button>
        )}
      </div>
    </main>
  );
}

function copyForState(state: ClaimState) {
  switch (state) {
    case "checking":
      return "Checking sign-in…";
    case "claiming":
      return "Accepting invite…";
    case "claimed":
      return "Opening document…";
    case "error":
      return "This invite is expired, already used, or for a different email.";
  }
}
