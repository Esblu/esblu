// -----------------------------------------------------------------------------
// Zdieľaný build-time prepínač web vs. mobile (Capacitor) build.
//
// AKO TO FUNGUJE: NEXT_PUBLIC_ESBLU_MOBILE je build-time env premenná.
// - Webový build (koreňový next.config.ts, Vercel) ju vôbec nenastavuje →
//   IS_MOBILE_BUILD je vždy false, web sa správa presne ako doteraz.
// - Mobile build (mobile/next.config.ts) ju nastaví na "1" priamo v `env`
//   bloku next.config → počas `next build` v mobile/ sa IS_MOBILE_BUILD
//   vyhodnotí na true a Next.js tuto hodnotu zabuduje ako statický literál
//   (nie je to runtime detekcia platformy, je to čisto build-time konštanta,
//   takže funguje aj po statickom exporte, bez Capacitor balíčkov).
//
// DÔLEŽITÉ: toto NIE JE beh-time detekcia "som v Capacitor WebView" — na to
// by bol potrebný @capacitor/core (Capacitor.isNativePlatform()), ktorý
// zámerne EŠTE NEINŠTALUJEME (pozri FÁZA 1 zadanie — Capacitor balíčky sa
// pridávajú AŽ PO úspešnom static exporte). Tento flag rieši presne to, čo
// PoC teraz potrebuje: web vs. mobile build varianta toho istého zdieľaného
// zdrojového kódu.
// -----------------------------------------------------------------------------

export const IS_MOBILE_BUILD = process.env.NEXT_PUBLIC_ESBLU_MOBILE === "1";

/**
 * Identifikátor mobilného buildu (UTC čas buildu z mobile/next.config.ts).
 * Webový build ho nemá (prázdny reťazec).
 */
export const ESBLU_BUILD_ID = process.env.NEXT_PUBLIC_ESBLU_BUILD_ID ?? "";
