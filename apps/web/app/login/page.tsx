"use client";

import { useSearchParams } from "next/navigation";
import { SignInScreen } from "../components/SignInScreen";

export default function LoginPage() {
  const params = useSearchParams();
  // Accept ?next= (internal redirect) – keep it relative and safe.
  const next = params.get("next");
  const returnTo = next && next.startsWith("/") ? next : "/";
  return <SignInScreen returnTo={returnTo} />;
}
