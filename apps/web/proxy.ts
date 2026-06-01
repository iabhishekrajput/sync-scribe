import { NextResponse, type NextRequest } from "next/server";

// /p/* is the public share-link view (M9); /share/* is reserved for any
// future server-rendered public surface.
const PUBLIC_PATHS = ["/login", "/auth/callback", "/p/", "/share/", "/favicon.ico", "/_next"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Refresh cookie is httpOnly + on the API host. Probe via a Set-Cookie
  // hint cookie that the API sets (non-secret, just a presence marker).
  // For M1, allow through and let client-side auth.ts kick off /auth/refresh
  // which redirects to /login on failure.
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image).*)"],
};
