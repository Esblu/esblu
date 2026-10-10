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
