// =============================================================================
// Cieľ po kliknutí na push notifikáciu — ALLOWLIST obrazoviek, nikdy URL.
//
// Server do notifikácie vkladá iba `{ screen, id? }` (data payload FCM/APNs,
// JSON web pushu). Klient (service worker, natívna appka) z toho SÁM zloží
// kanonickú webovú cestu podľa tejto tabuľky; mobilný build ju ešte preloží
// cez resolveAppHref() na statickú routu. Neznáma obrazovka, chýbajúce alebo
// neplatné ID, ľubovoľné iné polia (url, link, href…) → domov "/".
// Rovnaká tabuľka je (bez importov) v public/sw.js — test ich porovnáva.
// Bez závislostí (testovateľné v Node).
// =============================================================================

export const PUSH_SCREENS = ["home", "chat", "chat_index", "deadlines", "vehicle", "machine", "settings"] as const;
export type PushScreen = (typeof PUSH_SCREENS)[number];

const SCREENS_WITH_ID: ReadonlySet<PushScreen> = new Set(["chat", "vehicle", "machine"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PushTarget =
  | { screen: "chat" | "vehicle" | "machine"; id: string }
  | { screen: "home" | "chat_index" | "deadlines" | "settings" };

export const HOME_TARGET: PushTarget = { screen: "home" };

function isScreen(value: unknown): value is PushScreen {
  return typeof value === "string" && (PUSH_SCREENS as readonly string[]).includes(value);
}

/** Overí cieľ (server pred odoslaním, klient po prijatí). */
export function readPushTarget(data: unknown): PushTarget | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (!isScreen(record.screen)) return null;
  if (SCREENS_WITH_ID.has(record.screen)) {
    if (typeof record.id !== "string" || !UUID.test(record.id)) return null;
    return { screen: record.screen as "chat" | "vehicle" | "machine", id: record.id.toLowerCase() };
  }
  return { screen: record.screen as "home" | "chat_index" | "deadlines" | "settings" };
}

/** Dátové polia notifikácie (iba reťazce — FCM data payload to vyžaduje). */
export function pushTargetData(target: PushTarget): { screen: string; id?: string } {
  const valid = readPushTarget(target);
  if (!valid) return { screen: "home" };
  return "id" in valid ? { screen: valid.screen, id: valid.id } : { screen: valid.screen };
}

/** Kanonická webová cesta cieľa (mobil ju preloží cez resolveAppHref). */
export function pushTargetHref(target: PushTarget | null): string {
  if (!target) return "/";
  switch (target.screen) {
    case "chat":
      return `/chat/${target.id}`;
    case "chat_index":
      return "/chat";
    case "vehicle":
      return `/vozidla/${target.id}`;
    case "machine":
      return `/stroje/${target.id}`;
    case "settings":
      return "/nastavenia";
    case "deadlines":
    case "home":
    default:
      return "/";
  }
}

/** Z prijatých dát notifikácie priamo cesta (neplatné → "/"). */
export function pushHrefFromData(data: unknown): string {
  return pushTargetHref(readPushTarget(data));
}
