// =============================================================================
// Čistá (bez Capacitor/React) logika prekladu externého https odkazu Esblu na
// lokálnu cestu statického exportu. Vyčlenené z DeepLinkBridge.tsx (Mobile M0,
// 2026-09-27), aby sa dala testovať v Node (scripts/mobile-m0-tests.ts).
// Správanie je totožné; pribudol iba www host a formát tokenu pozvánky.
// =============================================================================

/**
 * Preloží externú https://esblu.com URL na lokálnu static-export cestu.
 * Vracia `null`, ak URL nezodpovedá prísne povolenému hostu/protokolu/ceste
 * — volajúci v tom prípade odkaz IGNORUJE (žiadna navigácia, žiadny fallback
 * na "otvor to inak").
 *
 * Exportované samostatne, aby bola táto čisto funkčná (bez Capacitor
 * závislosti) logika ľahko auditovateľná/testovateľná nezávisle od
 * React/Capacitor obalu.
 */
const ESBLU_LINK_HOSTS = new Set(["www.esblu.com", "esblu.com"]);
const INVITE_TOKEN_FORMAT = /^[0-9a-fA-F]{64}$/;

export function resolveEsbluDeepLink(rawUrl: string): string | null {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  // Mobile Platform (2026-10-08): návrat OAuth do natívnej appky cez custom
  // scheme (com.esblu.app://auth/callback?code=…). Prepúšťa sa IBA táto
  // jedna cesta; PKCE `code` je bez code_verifiera z tohto WebView bezcenný.
  if (url.protocol === "com.esblu.app:") {
    if (url.hostname === "auth" && (url.pathname === "/callback" || url.pathname === "/callback/")) {
      // Supabase vracia na presný allowlistovaný redirect bez `?oauth=` —
      // značku OAuth návratu doplníme (hodnota sa nikde neinterpretuje ako cieľ).
      return buildLocalTarget("/auth/callback.html", url.searchParams.has("oauth") ? {} : { oauth: "native" }, url);
    }
    return null;
  }

  // Prísny allowlist — presne https a presne esblu.com (žiadny endsWith/
  // includes, ktorý by prepustil napr. "esblu.com.evil.example").
  if (url.protocol !== "https:") {
    return null;
  }

  // Mobile M0 (2026-09-27): kanonický App Link host je www.esblu.com
  // (apex presmerúva a Android verifikácia presmerovanie nenasleduje).
  // Apex sa stále akceptuje — iba ak by ho systém doručil (napr. adb
  // s explicitným package cieľom); presná zhoda, žiadne subdomény.
  if (!ESBLU_LINK_HOSTS.has(url.hostname)) {
    return null;
  }

  const inviteMatch = url.pathname.match(/^\/invite\/([^/]+)\/?$/);

  if (inviteMatch) {
    let token: string;

    try {
      token = decodeURIComponent(inviteMatch[1]);
    } catch {
      // Nevalidný percent-encoding v tokene — fail closed, nič sa
      // nenavigujeme.
      return null;
    }

    // Token pozvánky je vždy 64 hex znakov (esblu_create_company_invite) —
    // čokoľvek iné sa do appky vôbec neodovzdá (fail closed).
    if (!INVITE_TOKEN_FORMAT.test(token)) {
      return null;
    }

    // ".html" — pozri bod 6 v komentári na začiatku súboru (Capacitor
    // html5mode fallback na index.html pre extensionless cesty).
    return buildLocalTarget("/invite.html", { token }, url);
  }

  if (url.pathname === "/reset-hesla" || url.pathname === "/reset-hesla/") {
    return buildLocalTarget("/reset-hesla.html", {}, url);
  }

  if (
    url.pathname === "/onboarding/company" ||
    url.pathname === "/onboarding/company/"
  ) {
    return buildLocalTarget("/onboarding/company.html", {}, url);
  }

  // AUTH CALLBACK BEZPEČNOSTNÁ OPRAVA (2026-08-31, RELEASE BLOCKER,
  // TokenHash revízia): nový dedikovaný auth callback
  // (app/auth/callback/page.tsx) — skutočné signup potvrdenie aj reset hesla
  // odkazy (Supabase Email Templates, Dashboard) teraz smerujú SEM, s
  // `?token_hash=...&type=email|recovery` v query stringu (NIE priamo na
  // /onboarding/company alebo /reset-hesla), aby callback vedel explicitne
  // zavolať supabase.auth.verifyOtp({ token_hash, type }) a nezávisle
  // (getUser()) overiť identitu namiesto ticheho ponechania prípadnej
  // existujúcej session iného účtu. `token_hash`/`type` sú bežné query
  // parametre — buildLocalTarget() nižšie ich zachová 1:1 (rovnaký
  // mechanizmus ako pri ostatných cieľoch vyššie), žiadna extra logika
  // potrebná. Rovnaký ".html" dôvod ako pri ostatných cieľoch vyššie —
  // mobile/out/auth/callback.html.
  if (url.pathname === "/auth/callback" || url.pathname === "/auth/callback/") {
    return buildLocalTarget("/auth/callback.html", {}, url);
  }

  // Čokoľvek iné na esblu.com (napr. /vozidla, /login, marketing landing) —
  // zámerne IGNOROVANÉ, nikdy sa neotvára v appke automaticky.
  return null;
}

/**
 * Zostaví lokálnu cieľovú cestu vrátane zachovaného query stringu (z
 * pôvodnej externej URL, zlúčeného s `extraParams` — napr. `token`) A
 * hash fragmentu (Supabase #access_token=..., type=recovery/signup atď.)
 * — hash sa kopíruje 1:1, nikdy sa needituje/needecoduje, presne ako ho
 * poslal Supabase v e-mailovom odkaze.
 *
 * `extraParams` (napr. token) sa vkladá cez URLSearchParams.set(), ktoré
 * hodnotu vždy korektne percent-enkóduje ako JEDEN query parameter — token
 * sa preto nikdy nemôže "rozpadnúť" na ďalšiu cestu ani na iný parameter.
 */
function buildLocalTarget(
  basePath: string,
  extraParams: Record<string, string>,
  sourceUrl: URL
): string {
  const params = new URLSearchParams(sourceUrl.search);

  for (const [key, value] of Object.entries(extraParams)) {
    params.set(key, value);
  }

  const query = params.toString();

  return `${basePath}${query ? `?${query}` : ""}${sourceUrl.hash}`;
}
