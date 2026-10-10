"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { useActiveMembership } from "@/hooks/use-active-membership";
import { mobileNavModel } from "@/lib/mobile-nav";
import { resolveAppHref } from "@/lib/app-routes";
import { isKeyboardEditable } from "@/lib/mobile/lifecycle";
import {
  CHAT_FAB_STORAGE_KEY,
  clampToBounds,
  fabBounds,
  fromStored,
  isDragGesture,
  parseStoredPosition,
  shouldShowChatFab,
  snapToEdge,
  toStored,
  totalUnread,
  unreadBadgeText,
  type FabBounds,
  type FabSide,
} from "@/lib/mobile/chat-fab";
import { getMyUnreadCounts } from "@/lib/chat";
import { supabase } from "@/lib/supabase";
import ChatBubbleIcon from "@/app/components/icons/ChatBubbleIcon";

// =============================================================================
// Plávajúce tlačidlo HUMAN CHATU na mobilnom dashboarde (iba mobilný build —
// mountuje mobile/app/layout.tsx; web má vlastný FloatingChatWidget).
//
// - iba na "/" (dashboard), pre roly s human chatom (mobileNavModel.humanChat
//   — rovnaké pravidlá ako spodná lišta; autorizáciu robí RLS chatu),
// - nad spodnou lištou (--mobile-tabbar-space + safe area), skryté pri
//   otvorenej klávesnici a pri otvorenom paneli „Viac" / dialógu,
// - tap = bežný Link na /chat (rovnaká navigácia ako lišta; Späť sa vráti),
// - badge IBA z autoritatívneho RPC esblu_get_my_unread_counts (pri chybe
//   žiadny badge); obnova pri zobrazení, návrate appky do popredia a pri
//   novej správe (realtime len spúšťa nové načítanie, nič nepripočítava),
// - presúvateľné prstom: po pustení sa prichytí k bližšiemu okraju; nikdy
//   nejde pod horný pruh dashboardu ani na spodnú lištu, rešpektuje safe area;
//   ťuknutie bez pohybu otvorí Chat, ťahanie ho neotvorí; poloha sa ukladá iba
//   lokálne (localStorage tohto zariadenia), relatívne k okraju a výške →
//   po rotácii sa prepočíta a oreže (lib/mobile/chat-fab.ts).
// =============================================================================

/** Skutočné px hodnoty CSS premenných (env()/calc sa vyhodnotia cez probe element). */
function measurePx(cssValue: string): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;height:${cssValue};width:0`;
  document.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return Number.isFinite(px) ? px : 0;
}

function currentBounds(): FabBounds {
  return fabBounds({
    width: window.innerWidth,
    height: window.innerHeight,
    safeTop: measurePx("var(--esblu-safe-top, 0px)"),
    safeLeft: measurePx("var(--esblu-safe-left, 0px)"),
    safeRight: measurePx("var(--esblu-safe-right, 0px)"),
    bottomReserve: measurePx("var(--mobile-tabbar-space, 0px)"),
  });
}

function readStored() {
  try {
    return parseStoredPosition(window.localStorage.getItem(CHAT_FAB_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStored(value: { side: FabSide; yRatio: number }) {
  try {
    window.localStorage.setItem(CHAT_FAB_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // súkromný režim / plné úložisko — poloha sa jednoducho nezapamätá
  }
}

export default function MobileChatFab() {
  const pathname = usePathname() ?? "/";
  const { t } = useLocale();
  const { loading, signedIn, membership } = useActiveMembership();
  const humanChat = mobileNavModel(membership ? { role: membership.role, permissions: membership.permissions } : null).humanChat;
  const chatHref = resolveAppHref("/chat") ? "/chat" : null;

  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [unread, setUnread] = useState<number | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const update = () => setKeyboardOpen(isKeyboardEditable(document.activeElement as HTMLInputElement | null));
    const deferred = () => window.setTimeout(update, 0);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", deferred);
    // Modálny panel/dialóg (aria-modal) nad obsahom → tlačidlo ustúpi.
    const observer = new MutationObserver(() => setOverlayOpen(document.querySelector('[aria-modal="true"]') !== null));
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", deferred);
      observer.disconnect();
    };
  }, []);

  const visible = Boolean(chatHref) && shouldShowChatFab({ pathname, loading, signedIn, humanChat, keyboardOpen, overlayOpen });

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = async () => {
      try {
        const total = totalUnread(await getMyUnreadCounts());
        if (!cancelled) setUnread(total);
      } catch {
        if (!cancelled) setUnread(null); // neznámy počet → žiadny badge
      }
    };
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    void supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setUserId(data.user?.id ?? null);
    });
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !userId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel(`mobile-chat-fab-${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          getMyUnreadCounts()
            .then((rows) => setUnread(totalUnread(rows)))
            .catch(() => setUnread(null));
        }, 400);
      })
      .subscribe();
    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [visible, userId]);

  // ----------------------------------------------------------------- drag & snap
  const [pos, setPos] = useState<{ x: number; y: number; side: FabSide } | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const relayout = useCallback(() => {
    setPos(fromStored(readStored(), currentBounds()));
  }, []);

  useEffect(() => {
    if (!visible) return;
    // Meranie safe area / lišty až po vykreslení (rAF) — mimo tela efektu.
    const frame = window.requestAnimationFrame(relayout);
    window.addEventListener("resize", relayout);
    window.addEventListener("orientationchange", relayout);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", relayout);
      window.removeEventListener("orientationchange", relayout);
    };
  }, [visible, relayout]);

  function onPointerDown(event: PointerEvent<HTMLAnchorElement>) {
    if (!pos || (event.pointerType === "mouse" && event.button !== 0)) return;
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, origX: pos.x, origY: pos.y, moved: false };
    suppressClick.current = false;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // staršie WebView bez pointer capture — ťahanie funguje aj tak
    }
  }

  function onPointerMove(event: PointerEvent<HTMLAnchorElement>) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    if (!d.moved && !isDragGesture(dx, dy)) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
    }
    const next = clampToBounds(d.origX + dx, d.origY + dy, currentBounds());
    setPos((current) => ({ x: next.x, y: next.y, side: current?.side ?? "right" }));
  }

  function finishDrag(event: PointerEvent<HTMLAnchorElement>) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (!d.moved) return; // ťuknutie → onClick otvorí Chat
    suppressClick.current = true; // ťahanie nesmie otvoriť Chat
    setDragging(false);
    const bounds = currentBounds();
    const snapped = snapToEdge(d.origX + (event.clientX - d.startX), d.origY + (event.clientY - d.startY), bounds);
    setPos(snapped);
    writeStored(toStored(snapped, bounds));
  }

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (suppressClick.current) {
      event.preventDefault();
      suppressClick.current = false;
    }
  }

  if (!visible || !chatHref) return null;

  const badge = unreadBadgeText(unread);
  const label = badge ? t("chat.openChatUnread", { count: badge }) : t("chat.openPanel");

  return (
    <Link
      href={chatHref}
      aria-label={label}
      data-testid="mobile-chat-fab"
      draggable={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onClick={onClick}
      onContextMenu={(event) => event.preventDefault()}
      className={`fixed z-[44] flex h-14 w-14 select-none items-center justify-center rounded-full bg-accent-cyan text-[#051221] shadow-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${
        dragging ? "scale-105" : "transition-[left,top,transform] duration-200 ease-out active:scale-95"
      }`}
      style={
        pos
          ? { left: pos.x, top: pos.y, touchAction: "none" }
          : { right: 16, bottom: "calc(var(--mobile-tabbar-space, 0px) + 16px)", touchAction: "none" }
      }
    >
      <ChatBubbleIcon />
      {badge && (
        <span
          aria-hidden="true"
          className="badge-danger absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold"
        >
          {badge}
        </span>
      )}
    </Link>
  );
}
