// =============================================================================
// Čistá logika životného cyklu mobilnej appky (Mobile Platform 2026-10-08) —
// bez Capacitor/React, aby sa dala testovať v Node.
// =============================================================================

/** Cesty, ktoré sú dostupné aj bez prihlásenia (nepresmerovávať na /login). */
const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/reset-hesla",
  "/auth/callback",
  "/invite",
  "/onboarding",
  "/cookies",
  "/dpa",
  "/kontakt",
  "/zrusenie-uctu",
  "/ochrana-osobnych-udajov",
  "/podmienky-pouzivania",
  "/subprocessors",
];

/** Normalizuje lokálnu cestu static exportu ("/vozidla.html" → "/vozidla"). */
export function normalizeLocalPath(pathname: string): string {
  const withoutHtml = pathname.replace(/\.html$/, "").replace(/\/index$/, "/");
  return withoutHtml.length > 1 ? withoutHtml.replace(/\/+$/, "") : "/";
}

export function isPublicPath(pathname: string): boolean {
  const path = normalizeLocalPath(pathname);
  return PUBLIC_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Po odhlásení (aj vypršaní/odvolaní session na inom zariadení) presmerovať
 * na prihlásenie — iba z chránenej obrazovky. Domov "/" rieši app/page.tsx sám.
 */
export function shouldRedirectToLoginAfterSignOut(event: string, pathname: string): boolean {
  if (event !== "SIGNED_OUT") return false;
  const path = normalizeLocalPath(pathname);
  return path !== "/" && !isPublicPath(path);
}

export type ConnectivityState = "online" | "offline";

export function connectivityFrom(navigatorOnLine: boolean | undefined): ConnectivityState {
  // navigator.onLine === false je spoľahlivé „offline"; true neznamená istotu
  // spojenia — volajúce obrazovky ďalej riešia chyby požiadaviek samostatne.
  return navigatorOnLine === false ? "offline" : "online";
}

const NON_TEXT_INPUT_TYPES = new Set(["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color", "hidden"]);

/** Otvorí softvérovú klávesnicu? (spodná navigácia sa vtedy skryje, aby neprekrývala formulár). */
export function isKeyboardEditable(element: { tagName?: string; type?: string; isContentEditable?: boolean; readOnly?: boolean } | null): boolean {
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = (element.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return !element.readOnly;
  if (tag === "INPUT") return !element.readOnly && !NON_TEXT_INPUT_TYPES.has((element.type ?? "text").toLowerCase());
  return false;
}
