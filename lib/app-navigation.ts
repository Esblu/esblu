// =============================================================================
// Tvrdá navigácia (plný reload stránky) bezpečná pre web aj mobilnú appku.
//
// PREČO (Mobile M1, 2026-09-28)
// -----------------------------
// Stránky po vypršaní session / odhlásení / zrušení účtu robia
// `window.location.href = "/login"` — zámerne plný reload, aby sa zahodil
// všetok stav v pamäti. V Capacitor appke však lokálny server pre cestu BEZ
// prípony (".../login") vráti index.html (SPA fallback) — používateľ
// skončil na koreňovej stránke namiesto prihlásenia. Statický export má
// každú stránku ako "<cesta>.html" (napr. login.html, auth/callback.html).
//
// MODEL
//   - web    → presne doterajšie správanie (`location.href = href`),
//   - mobile → href sa najprv preloží cez resolveAppHref (neexistujúci cieľ
//              → "/"), potom na statický súbor "<cesta>.html" s query/hash.
// Iba interné relatívne cesty; čokoľvek iné sa nahradí "/".
// =============================================================================

import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { resolveAppHref } from "@/lib/app-routes";

/** Interný href → cesta pre plný reload v danom builde. */
export function hardNavigationTarget(href: string, isMobile: boolean = IS_MOBILE_BUILD): string {
  const resolved = resolveAppHref(href, isMobile) ?? "/";
  if (!isMobile) return resolved;
  const match = resolved.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const pathname = match?.[1] || "/";
  const rest = `${match?.[2] ?? ""}${match?.[3] ?? ""}`;
  if (pathname === "/") return `/${rest}`;
  return `${pathname}.html${rest}`;
}

/** Plný reload na interný cieľ (napr. po odhlásení alebo vypršaní session). */
export function navigateHard(href: string): void {
  if (typeof window === "undefined") return;
  window.location.href = hardNavigationTarget(href);
}
