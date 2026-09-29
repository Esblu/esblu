"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { getMyActiveMembership } from "@/lib/company";
import { chatConversationHref } from "@/lib/entity-links";
import {
  ensureCompanyChatChannel,
  getMyUnreadCounts,
  getOrCreateDirectConversation,
  listCompanyMembersForChat,
  type ChatConversation,
  type CompanyMemberForChat,
} from "@/lib/chat";

type DirectConversationRow = {
  conversation: ChatConversation;
  // null, ak druhý účastník medzičasom zrušil svoj účet — direct_user_low/
  // high sa vtedy nastaví na NULL (ON DELETE SET NULL), konverzácia a jej
  // história ale ostávajú zachované. UI zobrazí formerMember fallback.
  otherUserId: string | null;
  otherMember: CompanyMemberForChat | null;
};

/**
 * Ľavý panel chatu — firemný kanál (pevne navrchu) + súkromné konverzácie,
 * s unread badge pri každej položke. Zdieľaný medzi troma miestami:
 * (1) /chat + /chat/[conversationId] cez app/chat/layout.tsx (plná stránka,
 * navigácia cez URL/Link), (2) plávajúci FloatingChatWidget panel
 * (app/components/chat/FloatingChatWidget.tsx) — kompaktný overlay, ktorý
 * NESMIE navigovať preč zo stránky, na ktorej sa používateľ nachádza.
 *
 * `onSelectConversation`, ak je zadaný, prepne komponent do "panel" módu:
 * riadky konverzácií sa renderujú ako <button onClick> namiesto <Link>, a
 * `startConversationWith` volá tento callback namiesto router.push — žiadna
 * navigácia, iba lokálny stav vo vnútri floating panelu. Bez neho (default)
 * sa správa presne ako doteraz — plnohodnotná URL-based navigácia pre
 * samostatnú /chat stránku.
 *
 * Zoznam konverzácií sa načíta priamo cez normálny SELECT na
 * chat_conversations (RLS už sama vráti presne to, čo má volajúci vidieť —
 * firemný kanál svojej firmy + vlastné direct konverzácie), žiadna
 * samostatná "list my conversations" RPC nie je potrebná.
 */
export default function ChatConversationList({
  activeConversationId,
  onSelectConversation,
}: {
  activeConversationId: string | null;
  onSelectConversation?: (conversationId: string) => void;
}) {
  const router = useRouter();
  const { t } = useLocale();

  const [loading, setLoading] = useState(true);
  const [companyConversationId, setCompanyConversationId] = useState<
    string | null
  >(null);
  const [directRows, setDirectRows] = useState<DirectConversationRow[]>([]);
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({});
  const [members, setMembers] = useState<CompanyMemberForChat[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [creatingWith, setCreatingWith] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const activeConversationIdRef = useRef<string | null>(activeConversationId);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  // Zámerne PLAIN funkcia (nie useCallback) volaná priamo z useEffect nižšie
  // s prázdnym dependency array — rovnaký vzor ako checkUser()/loadVehicle()
  // atď. naprieč zvyškom Esblu (napr. app/components/Dashboard.tsx,
  // app/vozidla/[id]/page.tsx). useCallback + "fn()" v efekte, kde fn je aj
  // v dependency array, nová ESLint pravidlo react-hooks/set-state-in-effect
  // nahlasuje ako anti-pattern nezávisle od poradia await/setState vnútri
  // tela — tento (už zaužívaný, inde v appke tolerovaný) vzor sa tomu
  // vyhýba.
  async function loadAll() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    setLoading(true);
    setLoadError(null);

    try {
      if (!session) {
        setLoading(false);
        return;
      }

      setMyUserId(session.user.id);

      const membership = await getMyActiveMembership();
      if (!membership) {
        setLoading(false);
        return;
      }

      const [companyId, memberRows, unreadRows] = await Promise.all([
        ensureCompanyChatChannel(),
        listCompanyMembersForChat(),
        getMyUnreadCounts(),
      ]);

      setCompanyConversationId(companyId);
      setMembers(memberRows);

      const map: Record<string, number> = {};
      unreadRows.forEach((row) => {
        map[row.conversation_id] = row.unread_count;
      });
      setUnreadMap(map);

      const { data: conversations, error } = await supabase
        .from("chat_conversations")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;

      const directConversations = (
        (conversations as ChatConversation[]) || []
      ).filter((c) => c.type === "direct");

      const rows: DirectConversationRow[] = directConversations.map((c) => {
        // Buď low, alebo high je "ja" (RLS/RPC to garantuje pri vytvorení);
        // druhý slot môže byť po zrušení účtu protistrany NULL — vtedy
        // otherUserId ostáva null a nižšie sa korektne zobrazí formerMember.
        const otherUserId =
          c.direct_user_low === session.user.id
            ? c.direct_user_high
            : c.direct_user_low;
        const otherMember = otherUserId
          ? memberRows.find((m) => m.user_id === otherUserId) || null
          : null;

        return { conversation: c, otherUserId, otherMember };
      });

      setDirectRows(rows);
      setLoading(false);
    } catch {
      setLoadError(t("chat.errors.loadFailed"));
      setLoading(false);
    }
  }

  useEffect(() => {
    // "Načítaj dáta pri mounte" — rovnaký, v appke už zaužívaný vzor ako
    // napr. checkUser() v app/components/Dashboard.tsx alebo loadVehicle()
    // v app/vozidla/[id]/page.tsx. react-hooks/set-state-in-effect (nová,
    // prísnejšia pravidlo) toto pri overovaní niekedy nahlasuje nekonzistentne
    // naprieč viac-súborovými lint behmi (potvrdené opakovaným behom — ten
    // istý súbor raz čistý, raz nie, bez zmeny kódu) — funkčne je vzor
    // bezpečný (žiadny nekonečný render loop, cleanup nepotrebný).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
  }, []);

  // Realtime: nová správa v ktorejkoľvek mojej konverzácii → ak nie je práve
  // otvorená, zvýš lokálny unread counter. RLS platí aj tu — appka dostane
  // iba eventy pre správy, ktoré by aj tak videla cez SELECT.
  useEffect(() => {
    if (!myUserId) return;

    const channel = supabase
      .channel(`chat-unread-${myUserId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload) => {
          const message = payload.new as {
            conversation_id: string;
            author_id: string | null;
          };

          if (message.author_id === myUserId) return;
          if (activeConversationIdRef.current === message.conversation_id) return;

          setUnreadMap((current) => ({
            ...current,
            [message.conversation_id]: (current[message.conversation_id] || 0) + 1,
          }));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [myUserId]);

  async function startConversationWith(otherUserId: string) {
    setCreatingWith(otherUserId);

    try {
      const conversationId = await getOrCreateDirectConversation(otherUserId);
      setShowNewConversation(false);
      await loadAll();

      if (onSelectConversation) {
        onSelectConversation(conversationId);
      } else {
        router.push(chatConversationHref(conversationId));
      }
    } catch {
      setLoadError(t("chat.errors.conversationLoadFailed"));
    } finally {
      setCreatingWith(null);
    }
  }

  const totalUnread = Object.values(unreadMap).reduce((sum, n) => sum + n, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 px-1 pb-3">
        <h2 className="text-lg font-bold text-primary">{t("chat.title")}</h2>
        {totalUnread > 0 && (
          <span className="badge-danger shrink-0 rounded-full px-2.5 py-1 text-xs font-bold">
            {totalUnread}
          </span>
        )}
      </div>

      {loadError && (
        <p className="mb-2 rounded-xl border border-subtle bg-surface-1/60 p-3 text-xs text-secondary">
          {loadError}
        </p>
      )}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-2">
        <div>
          <p className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-wide text-muted-esblu">
            {t("chat.companyChannel")}
          </p>

          {companyConversationId && (
            <ConversationRow
              href={chatConversationHref(companyConversationId)}
              onSelect={
                onSelectConversation
                  ? () => onSelectConversation(companyConversationId)
                  : undefined
              }
              active={activeConversationId === companyConversationId}
              title={t("chat.companyChannel")}
              unread={unreadMap[companyConversationId] || 0}
              icon="🏢"
            />
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between px-1">
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-esblu">
              {t("chat.directMessages")}
            </p>
            <button
              type="button"
              onClick={() => setShowNewConversation(true)}
              className="text-xs font-bold text-accent-cyan hover:underline"
            >
              + {t("chat.newConversation")}
            </button>
          </div>

          {loading ? (
            <p className="px-1 text-xs text-muted-esblu">
              {t("common.buttons.loading")}
            </p>
          ) : directRows.length === 0 ? (
            <p className="px-1 text-xs text-muted-esblu">
              {t("chat.noConversationSelected")}
            </p>
          ) : (
            <div className="space-y-1">
              {directRows.map((row) => (
                <ConversationRow
                  key={row.conversation.id}
                  href={chatConversationHref(row.conversation.id)}
                  onSelect={
                    onSelectConversation
                      ? () => onSelectConversation(row.conversation.id)
                      : undefined
                  }
                  active={activeConversationId === row.conversation.id}
                  title={row.otherMember?.email || t("chat.formerMember")}
                  unread={unreadMap[row.conversation.id] || 0}
                  icon="👤"
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {showNewConversation && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 backdrop-blur-sm sm:items-center">
          <div className="surface-card w-full max-w-sm p-5 sm:rounded-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-bold text-primary">
                {t("chat.selectMember")}
              </h3>
              <button
                type="button"
                onClick={() => setShowNewConversation(false)}
                aria-label={t("common.buttons.close")}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-secondary"
              >
                ✕
              </button>
            </div>

            <div className="max-h-80 space-y-1 overflow-y-auto">
              {members
                .filter((m) => m.user_id !== myUserId)
                .map((member) => (
                  <button
                    key={member.user_id}
                    type="button"
                    disabled={creatingWith === member.user_id}
                    onClick={() => startConversationWith(member.user_id)}
                    className="surface-card-hover flex w-full items-center justify-between gap-3 rounded-xl border border-subtle bg-surface-1/60 px-3.5 py-3 text-left text-sm font-medium text-primary transition disabled:opacity-60"
                  >
                    <span className="min-w-0 truncate">{member.email}</span>
                    <span className="shrink-0 text-xs text-muted-esblu">
                      {t(`common.roles.${member.role}`)}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConversationRow({
  href,
  onSelect,
  active,
  title,
  unread,
  icon,
}: {
  href: string;
  /** Ak zadané, riadok sa renderuje ako button (panel mód) namiesto Link
   * (route mód) — pozri komentár nad ChatConversationList vyššie. */
  onSelect?: () => void;
  active: boolean;
  title: string;
  unread: number;
  icon: string;
}) {
  const className = `flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left text-sm font-semibold transition ${
    active
      ? "bg-accent-cyan/12 text-accent-cyan"
      : "text-secondary hover:bg-surface-hover hover:text-primary"
  }`;

  const content = (
    <>
      <span aria-hidden="true" className="text-base leading-none">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {unread > 0 && (
        <span className="badge-danger shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">
          {unread}
        </span>
      )}
    </>
  );

  if (onSelect) {
    return (
      <button type="button" onClick={onSelect} className={className}>
        {content}
      </button>
    );
  }

  return (
    <Link href={href} className={className}>
      {content}
    </Link>
  );
}
