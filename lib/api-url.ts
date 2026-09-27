import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { mobileApiOrigin } from "@/lib/app-origin";

// -----------------------------------------------------------------------------
// Zdieľaný helper na volanie existujúcich Next.js API routes (app/api/**) tak,
// aby fungovali nezmenené AJ vo webovom builde (relatívna cesta, rovnaký
// origin), AJ v mobile Capacitor builde (absolútna URL na produkčný backend,
// keďže mobile frontend beží z lokálne zabalených assets — origin
// https://localhost na Androide, capacitor://localhost na iOS).
//
// - web    → apiUrl("/api/x") === "/api/x"  (bez zmeny)
// - mobile → apiUrl("/api/x") === "https://www.esblu.com/api/x"
//
// Mobile M0 (2026-09-27): predtým "https://esblu.com" — apex odpovedá 308 na
// www a CORS preflight s presmerovaním WebView odmietne. Origin je teraz
// jediný, v lib/app-origin.ts (kanonický www, voliteľný build-time override
// NEXT_PUBLIC_ESBLU_API_ORIGIN pre staging/lokálny vývoj).
//
// Server musí mobilný origin povoliť v CORS — pozri lib/cors.ts + proxy.ts.
// -----------------------------------------------------------------------------

export function apiUrl(path: string): string {
  const base = IS_MOBILE_BUILD ? mobileApiOrigin() : "";
  return `${base}${path}`;
}
