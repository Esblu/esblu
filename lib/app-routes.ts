// =============================================================================
// Normalizácia interných odkazov medzi webom a mobilnou (Capacitor) appkou.
//
// PREČO (Mobile M0, 2026-09-27)
// -----------------------------
// Server (asistent, intent handlery, notifikácie) aj zdieľané komponenty
// vytvárajú odkazy v KANONICKOM webovom tvare, napr. "/vozidla/<id>",
// "/faktury/<id>", "/stroje/<id>?tab=photos". Webový build ich používa
// priamo. Mobilný build je statický export: detail sa otvára cez
// "/vozidla/detail?id=<id>" a niektoré moduly (faktúry, partneri,
// priečinky, chat) boli pridané v M1; cenník v natívnej appke zámerne nie je
// (store billing politika) — odkaz naň by skončil na prázdnej stránke.
//
// MODEL
//   - kanonický tvar odkazu = relatívna webová cesta (server ho produkuje
//     rovnako pre web aj appku, nikdy absolútnu URL ani host),
//   - klient ho pred vykreslením preloží cez resolveAppHref():
//       web    → bez zmeny,
//       mobile → na lokálnu statickú routu, alebo null, ak routa v appke
//                neexistuje (volajúci vtedy odkaz nevykreslí ako link),
//   - absolútne URL, protocol-relative ("//…"), javascript: a pod. sa
//     nikdy neprepustia (null) — interné odkazy sú výhradne relatívne.
//
// Nový modul v appke = nová routa tu (test porovnáva so stránkami v
// mobile/app/**).
// =============================================================================

import { IS_MOBILE_BUILD } from "@/lib/build-target";

/** Routy, ktoré mobilný build (mobile/app/**) reálne obsahuje. */
export const MOBILE_STATIC_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/ai-evidencia",
  "/vozidla",
  "/stroje",
  "/sklad",
  "/nastavenia",
  "/login",
  "/reset-hesla",
  "/onboarding/company",
  "/auth/callback",
  "/invite",
  "/cookies",
  "/dpa",
  "/kontakt",
  "/ochrana-osobnych-udajov",
  "/podmienky-pouzivania",
  "/subprocessors",
  "/vozidla/detail",
  "/stroje/detail",
  "/sklad/detail",
  // Mobile M1 (2026-09-28)
  "/faktury",
  "/faktury/new",
  "/faktury/detail",
  "/obchodni-partneri",
  "/obchodni-partneri/detail",
  "/priecinky",
  "/priecinky/detail",
  "/chat",
]);

/** Webové detailové routy `/<modul>/<id>` → mobilná `/<modul>/detail?id=`. */
const MOBILE_DETAIL_MODULES = new Set(["vozidla", "stroje", "sklad", "faktury", "obchodni-partneri", "priecinky"]);

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Preloží kanonický (webový) interný odkaz pre aktuálny build.
 * Vracia null, ak odkaz nie je bezpečný interný odkaz alebo ak cieľ
 * v tomto builde neexistuje.
 */
export function resolveAppHref(href: string | null | undefined, isMobile: boolean = IS_MOBILE_BUILD): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  // Iba relatívne interné cesty. "//host" a "/\\host" sú v prehliadači
  // absolútne (protocol-relative) — nikdy.
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) return null;

  let url: URL;
  try {
    url = new URL(trimmed, "https://app.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://app.invalid") return null;

  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const query = url.search;
  const hash = url.hash;

  if (!isMobile) return `${pathname}${query}${hash}`;

  if (MOBILE_STATIC_ROUTES.has(pathname)) return `${pathname}${query}${hash}`;

  // Webový detail /<modul>/<id> → mobilný /<modul>/detail?id=<id>
  const detail = pathname.match(/^\/([a-z-]+)\/([^/]+)$/);
  if (detail && MOBILE_DETAIL_MODULES.has(detail[1]) && detail[2] !== "detail") {
    let id: string;
    try {
      id = decodeURIComponent(detail[2]);
    } catch {
      return null;
    }
    if (!SAFE_ID.test(id)) return null;
    const params = new URLSearchParams(url.search);
    params.set("id", id);
    return `/${detail[1]}/detail?${params.toString()}${hash}`;
  }

  // Webová konverzácia /chat/<id> → mobilná /chat?id=<id>
  const chat = pathname.match(/^\/chat\/([^/]+)$/);
  if (chat) {
    let id: string;
    try {
      id = decodeURIComponent(chat[1]);
    } catch {
      return null;
    }
    if (!SAFE_ID.test(id)) return null;
    return `/chat?id=${id}${hash}`;
  }

  // Webová pozvánka /invite/<token> → mobilná /invite?token=<token>
  const invite = pathname.match(/^\/invite\/([0-9a-fA-F]{64})$/);
  if (invite) return `/invite?token=${invite[1].toLowerCase()}${hash}`;

  return null;
}

/** Existuje cieľ odkazu v aktuálnom builde? */
export function isAppRouteAvailable(href: string | null | undefined, isMobile: boolean = IS_MOBILE_BUILD): boolean {
  return resolveAppHref(href, isMobile) !== null;
}
