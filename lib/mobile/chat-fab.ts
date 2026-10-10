// =============================================================================
// Rýchly vstup do HUMAN CHATU na mobilnom dashboarde (Mobile Platform 2026-10-10).
// Čistá logika (bez React/Capacitor) — testovateľná v Node.
// =============================================================================

export type ChatFabInput = {
  pathname: string;
  loading: boolean;
  signedIn: boolean;
  /** mobileNavModel(...).humanChat — tie isté pravidlá ako spodná navigácia. */
  humanChat: boolean;
  /** Fokus v textovom poli (klávesnica) → skryť, nič neprekrývať. */
  keyboardOpen: boolean;
  /** Otvorený spodný panel / dialóg nad dashboardom. */
  overlayOpen: boolean;
};

/** Iba hlavný mobilný dashboard ("/" resp. statický "/index.html"). */
export function isMobileDashboardPath(pathname: string): boolean {
  const path = pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "").replace(/\/+$/, "") || "/";
  return path === "/";
}

export function shouldShowChatFab(input: ChatFabInput): boolean {
  return (
    !input.loading &&
    input.signedIn &&
    input.humanChat &&
    !input.keyboardOpen &&
    !input.overlayOpen &&
    isMobileDashboardPath(input.pathname)
  );
}

type UnreadRow = { unread_count: number | string | null | undefined };

/**
 * Súčet neprečítaných z autoritatívneho RPC esblu_get_my_unread_counts.
 * null = počet nie je spoľahlivo známy (chyba / neplatné dáta) → žiadny badge.
 */
export function totalUnread(rows: unknown): number | null {
  if (!Array.isArray(rows)) return null;
  let total = 0;
  for (const row of rows as UnreadRow[]) {
    const n = Number(row?.unread_count ?? 0);
    if (!Number.isFinite(n) || n < 0) return null;
    total += Math.floor(n);
  }
  return total;
}

/** Text badge; null = nezobrazovať (neznámy počet alebo 0). */
export function unreadBadgeText(total: number | null): string | null {
  if (total === null || total <= 0) return null;
  return total > 99 ? "99+" : String(total);
}

// -----------------------------------------------------------------------------
// Presúvanie (drag) + prichytenie k okraju (Mobile Platform 2026-10-10).
// Poloha sa ukladá IBA lokálne (localStorage tohto zariadenia), relatívne:
// strana (ľavá/pravá) + pomer výšky v povolenom pásme → po rotácii / zmene
// viewportu sa prepočíta a vždy ostane v povolenom priestore.
// -----------------------------------------------------------------------------

export const CHAT_FAB_SIZE = 56;
export const CHAT_FAB_MARGIN = 16;
/** Rezerva pre horný pruh dashboardu (logo + názov firmy, ~64 px) — FAB nikdy nejde pod header. */
export const CHAT_FAB_HEADER_RESERVE = 72;
/** Posun prsta (px), od ktorého ide o ťahanie, nie o ťuknutie. */
export const CHAT_FAB_DRAG_THRESHOLD = 8;
export const CHAT_FAB_STORAGE_KEY = "esblu.mobile.chatFab.position.v1";

export type FabSide = "left" | "right";
export type StoredFabPosition = { side: FabSide; yRatio: number };
export type FabViewport = {
  width: number;
  height: number;
  safeTop: number;
  safeLeft: number;
  safeRight: number;
  /** Výška spodnej lišty vrátane spodnej safe area (--mobile-tabbar-space). */
  bottomReserve: number;
};
export type FabBounds = { minX: number; maxX: number; minY: number; maxY: number };

const finite = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export function fabBounds(v: FabViewport, size = CHAT_FAB_SIZE, margin = CHAT_FAB_MARGIN): FabBounds {
  const minX = finite(v.safeLeft) + margin;
  const maxX = Math.max(minX, finite(v.width) - finite(v.safeRight) - margin - size);
  const minY = finite(v.safeTop) + CHAT_FAB_HEADER_RESERVE;
  const maxY = Math.max(minY, finite(v.height) - finite(v.bottomReserve) - margin - size);
  return { minX, maxX, minY, maxY };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Pustenie prsta: k bližšiemu okraju (podľa stredu tlačidla), y orezané do pásma. */
export function snapToEdge(x: number, y: number, b: FabBounds, size = CHAT_FAB_SIZE): { x: number; y: number; side: FabSide } {
  const center = x + size / 2;
  const mid = (b.minX + b.maxX + size) / 2;
  const side: FabSide = center < mid ? "left" : "right";
  return { x: side === "left" ? b.minX : b.maxX, y: clamp(Number.isFinite(y) ? y : b.maxY, b.minY, b.maxY), side };
}

/** Počas ťahania: voľný pohyb, ale nikdy mimo povolenej plochy. */
export function clampToBounds(x: number, y: number, b: FabBounds): { x: number; y: number } {
  return { x: clamp(x, b.minX, b.maxX), y: clamp(y, b.minY, b.maxY) };
}

export function toStored(pos: { y: number; side: FabSide }, b: FabBounds): StoredFabPosition {
  const span = b.maxY - b.minY;
  return { side: pos.side, yRatio: span > 0 ? clamp((pos.y - b.minY) / span, 0, 1) : 1 };
}

/** Uložená poloha → px v aktuálnom viewporte (vždy orezaná). Predvolené: vpravo dole. */
export function fromStored(stored: StoredFabPosition | null, b: FabBounds): { x: number; y: number; side: FabSide } {
  const s = stored ?? { side: "right", yRatio: 1 };
  return { x: s.side === "left" ? b.minX : b.maxX, y: b.minY + clamp(s.yRatio, 0, 1) * (b.maxY - b.minY), side: s.side };
}

/** Bezpečné čítanie uloženej hodnoty (poškodená / cudzia → null = predvolená poloha). */
export function parseStoredPosition(raw: string | null | undefined): StoredFabPosition | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredFabPosition>;
    if ((v.side !== "left" && v.side !== "right") || typeof v.yRatio !== "number" || !Number.isFinite(v.yRatio)) return null;
    return { side: v.side, yRatio: clamp(v.yRatio, 0, 1) };
  } catch {
    return null;
  }
}

export function isDragGesture(dx: number, dy: number, threshold = CHAT_FAB_DRAG_THRESHOLD): boolean {
  return Math.hypot(dx, dy) >= threshold;
}
