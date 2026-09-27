// =============================================================================
// CORS pre natívne mobilné appky (Capacitor) — centrálna, explicitná politika.
//
// PREČO (Mobile M0, 2026-09-27)
// -----------------------------
// Mobilná appka beží z lokálne zabalených assets, teda z iného originu než
// backend: Android (Capacitor 8, server.androidScheme=https, hostname
// localhost — predvolené, capacitor.config.ts ich nemení) → "https://localhost";
// iOS (budúca appka) → "capacitor://localhost". Každé API volanie posiela
// `Authorization: Bearer …` a JSON/multipart, takže WebView najprv pošle
// OPTIONS preflight. Produkcia dnes na preflight odpovedá 204 BEZ
// Access-Control-Allow-Origin → volanie zlyhá.
//
// MODEL
//   - povolené sú IBA presne vymenované originy (žiadne `*`, žiadny
//     endsWith/regex), voliteľne rozšírené server-side premennou
//     ESBLU_CORS_EXTRA_ORIGINS (čiarkou oddelený zoznam presných originov):
//     https://… a capacitor://… presne podľa zápisu, http://… IBA pre
//     lokálny vývoj (localhost, 127.0.0.1, 10.0.2.2); vzdialený http,
//     "*" ani "null" sa nikdy nepovolia,
//   - BEZ Access-Control-Allow-Credentials: API autentifikuje výhradne
//     Bearer tokenom (lib/server-auth.ts), nie cookies — cross-origin
//     požiadavka tak nemôže zneužiť cookies webového používateľa (CSRF
//     ochrana webu sa nemení),
//   - nepovolený origin dostane odpoveď bez CORS hlavičiek (prehliadač
//     volanie zablokuje); server-side autorizácia ostáva nezmenená —
//     CORS nie je autorizácia, iba povolenie pre prehliadač,
//   - cron/serverové routy (/api/cron/*) CORS nedostanú vôbec.
//
// Modul je bez importov (testovateľný v Node aj v proxy.ts).
// =============================================================================

/** Natívne originy Capacitor appiek (presné hodnoty, žiadne vzory). */
export const NATIVE_APP_ORIGINS = ["https://localhost", "capacitor://localhost"] as const;

export const CORS_ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

/** Hlavičky, ktoré klient Esblu reálne posiela (lowercase). */
export const CORS_ALLOWED_HEADERS = ["authorization", "content-type", "idempotency-key", "x-esblu-locale"] as const;

/** Hlavičky odpovedí, ktoré klient číta (exporty/balíky). */
export const CORS_EXPOSED_HEADERS = [
  "Content-Disposition",
  "Content-Length",
  "X-Esblu-Package-Id",
  "X-Esblu-Package-Sha256",
  "X-Esblu-Manifest-Sha256",
  "X-Esblu-Item-Count",
  "X-Esblu-File-Count",
  "X-Esblu-Excluded-Count",
  "X-Esblu-Excluded",
  "X-Esblu-Export-Id",
  "X-Esblu-Invoice-Count",
  "X-Esblu-Excluded-Drafts",
].join(", ");

export const CORS_MAX_AGE_SECONDS = "600";

/** Cesty, na ktoré sa CORS nikdy neaplikuje (server-to-server). */
export function isCorsExcludedPath(pathname: string): boolean {
  return pathname === "/api/cron" || pathname.startsWith("/api/cron/");
}

// Lokálne vývojové hosty — iba pre ne sa v ESBLU_CORS_EXTRA_ORIGINS povolí http.
const DEV_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

/**
 * Jeden záznam ESBLU_CORS_EXTRA_ORIGINS → presný origin, alebo null.
 *   - https://host[:port]            — áno (explicitne nakonfigurovaný),
 *   - capacitor://host               — áno (natívny origin),
 *   - http://localhost|127.0.0.1|10.0.2.2[:port] — áno (lokálny vývoj),
 *   - čokoľvek iné (vzdialený http, *, null, cesta, query, credentials) — nie.
 * Záznam musí byť presne origin (bez cesty); jediná tolerancia je koncové "/".
 */
export function parseExtraOrigin(raw: string): string | null {
  const candidate = raw.trim().replace(/\/$/, "");
  if (!candidate || candidate === "*" || candidate === "null" || candidate.includes("*")) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname && url.pathname !== "/" && url.pathname !== "") return null;

  let normalized: string;
  if (url.protocol === "https:") {
    normalized = url.origin;
  } else if (url.protocol === "capacitor:") {
    if (!url.host) return null;
    normalized = `capacitor://${url.host}`;
  } else if (url.protocol === "http:") {
    if (!DEV_HTTP_HOSTS.has(url.hostname)) return null;
    normalized = url.origin;
  } else {
    return null;
  }
  // Presná zhoda so zápisom (žiadne implicitné úpravy hostu/portu).
  return normalized === candidate ? normalized : null;
}

function parseExtraOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const result: string[] = [];
  for (const part of raw.split(",")) {
    const origin = parseExtraOrigin(part);
    if (origin) result.push(origin);
  }
  return result;
}

export function allowedCorsOrigins(extraOriginsEnv: string | undefined = process.env.ESBLU_CORS_EXTRA_ORIGINS): string[] {
  return [...NATIVE_APP_ORIGINS, ...parseExtraOrigins(extraOriginsEnv)];
}

export function isAllowedCorsOrigin(origin: string | null | undefined, extraOriginsEnv?: string): boolean {
  if (!origin || origin === "null") return false;
  return allowedCorsOrigins(extraOriginsEnv).includes(origin);
}

/**
 * CORS hlavičky pre odpoveď. Pre nepovolený origin iba `Vary: Origin`
 * (správne cachovanie), nikdy Allow-Origin.
 */
export function corsResponseHeaders(origin: string | null | undefined, extraOriginsEnv?: string): Record<string, string> {
  if (!isAllowedCorsOrigin(origin, extraOriginsEnv)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin as string,
    "Access-Control-Expose-Headers": CORS_EXPOSED_HEADERS,
    Vary: "Origin",
  };
}

/**
 * Hlavičky pre OPTIONS preflight. Povolí iba známe hlavičky — ak klient
 * žiada inú, preflight ju nepotvrdí a prehliadač volanie zablokuje.
 */
export function corsPreflightHeaders(origin: string | null | undefined, extraOriginsEnv?: string): Record<string, string> {
  if (!isAllowedCorsOrigin(origin, extraOriginsEnv)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin as string,
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS.join(", "),
    "Access-Control-Max-Age": CORS_MAX_AGE_SECONDS,
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  };
}
