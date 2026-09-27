import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { corsPreflightHeaders, corsResponseHeaders, isCorsExcludedPath } from "@/lib/cors";

// =============================================================================
// Next.js 16 Proxy (predtým Middleware) — IBA CORS pre /api/* (Mobile M0).
//
// Politika je v lib/cors.ts: explicitný allowlist natívnych originov
// (https://localhost = Capacitor Android, capacitor://localhost = iOS),
// bez `*`, bez credentials. Nerobí autentifikáciu ani presmerovania; web
// (same-origin, bez Origin z allowlistu) prejde nezmenený.
// =============================================================================

export function proxy(request: NextRequest) {
  if (isCorsExcludedPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const origin = request.headers.get("origin");

  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: corsPreflightHeaders(origin) });
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(corsResponseHeaders(origin))) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
