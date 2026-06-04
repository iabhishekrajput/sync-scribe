import { SignInScreen } from "../components/SignInScreen";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  // Accept ?next= (internal redirect) – keep it relative and safe.
  const next = params.next;
  const returnTo = next && next.startsWith("/") ? next : "/";
  return <SignInScreen returnTo={returnTo} />;
}
