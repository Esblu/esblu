"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { useActiveMembership } from "@/hooks/use-active-membership";
import { mobileNavModel } from "@/lib/mobile-nav";
import { resolveAppHref } from "@/lib/app-routes";
import { isKeyboardEditable } from "@/lib/mobile/lifecycle";
import { shouldShowChatFab, totalUnread, unreadBadgeText } from "@/lib/mobile/chat-fab";
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
//   novej správe (realtime len spúšťa nové načítanie, nič nepripočítava).
// =============================================================================

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

  if (!visible || !chatHref) return null;

  const badge = unreadBadgeText(unread);
  const label = badge ? t("chat.openChatUnread", { count: badge }) : t("chat.openPanel");

  return (
    <Link
      href={chatHref}
      aria-label={label}
      data-testid="mobile-chat-fab"
      className="fixed right-4 z-[44] flex h-14 w-14 items-center justify-center rounded-full bg-accent-cyan text-[#051221] shadow-2xl transition active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
      style={{ bottom: "calc(var(--mobile-tabbar-space, 0px) + 16px)" }}
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
