import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { CANONICAL_WEB_ORIGIN } from "@/lib/app-origin";

// -----------------------------------------------------------------------------
// Zdieľaný helper na generovanie CANONICAL verejnej web URL (na zdieľanie mimo
// appky — napr. invite odkaz, ktorý si owner skopíruje a pošle pozvanému mimo
// Esblu). Rieši presne jeden problém: `window.location.origin` v mobile
// (Capacitor) builde nie je https://esblu.com, ale lokálny WebView origin
// (napr. https://localhost alebo capacitor://localhost, podľa platformy) —
// odkaz vygenerovaný z takého origin by bol mimo appku nepoužiteľný.
//
// Princíp (rovnaká štruktúra ako lib/api-url.ts a lib/entity-links.ts):
// - web    → `${window.location.origin}${path}` — zachováva DOTERAJŠIE
//            správanie (funguje rovnako na produkcii aj na Vercel preview
//            deploymentoch, kde je to žiaduce).
// - mobile → `https://esblu.com${path}` — vždy stabilná produkčná doména,
//            nikdy lokálny WebView origin.
//
// POZOR: toto NIE JE helper pre Supabase emailRedirectTo/redirectTo (signUp,
// resetPasswordForEmail) — tie už DNES natvrdo používajú "https://esblu.com/..."
// (nikdy window.location.origin), teda sú voči tomuto bugu imúnne a zámerne sa
// touto zmenou nemenia (aby e-mailový redirect vždy mieril na stabilnú
// produkčnú doménu, nezávisle od toho, z akého originu/prostredia bol signup
// spustený).
//
// Web build IS_MOBILE_BUILD je vždy false (pozri lib/build-target.ts), takže
// pre existujúci web produkčný build sa touto zmenou nič nemení.
// -----------------------------------------------------------------------------

// Mobile M0 (2026-09-27): kanonický www host (apex presmerúva, Android App
// Links sú deklarované pre www — pozri lib/app-origin.ts).
const MOBILE_PUBLIC_WEB_URL = CANONICAL_WEB_ORIGIN;

export function publicWebUrl(path: string): string {
  if (IS_MOBILE_BUILD) {
    return `${MOBILE_PUBLIC_WEB_URL}${path}`;
  }

  if (typeof window !== "undefined") {
    return `${window.location.origin}${path}`;
  }

  // Server-side fallback (mal by nastať iba teoreticky — táto funkcia sa
  // dnes volá výhradne z klientských event handlerov po interakcii
  // používateľa) — nikdy nevráti prázdny/relatívny reťazec.
  return `${MOBILE_PUBLIC_WEB_URL}${path}`;
}
