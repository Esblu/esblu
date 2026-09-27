// =============================================================================
// Jediný zdroj pravdy pre produkčný origin Esblu mimo webového same-origin
// kontextu (mobilná appka, odkazy zdieľané mimo appky, e-mailové redirecty).
//
// PREČO (Mobile M0, 2026-09-27)
// -----------------------------
// Apex https://esblu.com na Verceli odpovedá `308 → https://www.esblu.com`
// pre VŠETKY cesty (overené aj na /api/* a /.well-known/*). Mobilná appka
// volala https://esblu.com/api/... — CORS preflight, na ktorý server
// odpovie presmerovaním, prehliadač (WebView) odmietne, takže žiadne API
// volanie z appky neprešlo. Rovnako Android App Links verifikácia
// presmerovanie nenasleduje.
//
// Kanonický host je preto https://www.esblu.com (priamo slúži stránky, API
// aj /.well-known/assetlinks.json bez presmerovania).
//
// Web build sa tým NEMENÍ: API volania na webe zostávajú relatívne
// (same-origin, fungujú aj na preview deploymentoch) — pozri lib/api-url.ts.
// =============================================================================

import { IS_MOBILE_BUILD } from "@/lib/build-target";

/** Kanonický verejný origin produkčnej aplikácie (bez koncového lomítka). */
export const CANONICAL_WEB_ORIGIN = "https://www.esblu.com";

// Lokálne vývojové hosty, pre ktoré sa povolí aj http (emulátor Androidu
// vidí počítač ako 10.0.2.2).
const DEV_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

/**
 * Overí a znormalizuje voliteľný override originu (napr. staging/lokálny
 * backend pre mobilný build). Neplatná hodnota → null (použije sa
 * kanonický origin), nikdy nie cesta, query ani iná schéma.
 */
export function normalizeOriginOverride(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const httpsOk = url.protocol === "https:";
  const devHttpOk = url.protocol === "http:" && DEV_HTTP_HOSTS.has(url.hostname);
  if (!httpsOk && !devHttpOk) return null;
  if (url.username || url.password) return null;
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return null;
  return url.origin;
}

/**
 * Origin backendu pre mobilný build. Build-time override
 * NEXT_PUBLIC_ESBLU_API_ORIGIN (iba mobilný build) slúži na staging/lokálny
 * vývoj; bez neho vždy kanonický produkčný origin.
 */
export function mobileApiOrigin(): string {
  return normalizeOriginOverride(process.env.NEXT_PUBLIC_ESBLU_API_ORIGIN) ?? CANONICAL_WEB_ORIGIN;
}

/**
 * Absolútna URL na verejnú webovú stránku (napr. auth redirect, zdieľaný
 * odkaz). Vždy kanonický produkčný origin — nikdy lokálny WebView origin.
 */
export function canonicalWebUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${CANONICAL_WEB_ORIGIN}${normalized}`;
}

/** Je daný build mobilný (Capacitor)? Re-export pre čitateľnosť volajúcich. */
export { IS_MOBILE_BUILD };
