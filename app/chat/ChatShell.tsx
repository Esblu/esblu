"use client";

import type { ReactNode } from "react";
import BackLink from "@/app/components/BackLink";
import ChatConversationList from "@/app/components/chat/ChatConversationList";
import { useLocale } from "@/lib/i18n/LocaleProvider";

/**
 * /chat layout — dvojpanelový desktop (zoznam vľavo, konverzácia vpravo),
 * na mobile buď zoznam ALEBO konverzácia (nikdy oboje naraz), podľa
 * aktuálnej cesty. Rovnaký "hub & spoke" princíp ako /vozidla/[id] a pod.
 * (BackLink návrat na Dashboard), iba s vlastným vnútorným dvojpanelovým
 * rozložením namiesto jednej stránky.
 */
/**
 * Zdieľaný chat shell (Mobile M1): web ho volá z layoutu podľa cesty
 * (/chat, /chat/[id]), mobil z mobile/app/chat/page.tsx podľa ?id=.
 */
export function ChatShell({
  activeConversationId,
  children,
}: {
  activeConversationId: string | null;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const hasSelectedConversation = Boolean(activeConversationId);
  return (
    <main className="app-shell-bg relative min-h-[calc(100dvh-var(--mobile-tabbar-space,0px))] w-full min-w-0">
      <div className="mx-auto flex h-[calc(100dvh-var(--mobile-tabbar-space,0px))] max-w-6xl flex-col px-4 pb-4 pt-4 sm:px-6 sm:pt-6">
        <div
          className={`shrink-0 ${hasSelectedConversation ? "hidden lg:block" : "block"}`}
        >
          <BackLink href="/" label={t("common.buttons.back")} />
        </div>

        <div className="mt-4 flex min-h-0 flex-1 gap-4">
          <aside
            className={`surface-card w-full shrink-0 overflow-hidden p-4 lg:block lg:w-80 ${
              hasSelectedConversation ? "hidden" : "block"
            }`}
          >
            <ChatConversationList activeConversationId={activeConversationId} />
          </aside>

          <section
            className={`surface-card min-h-0 flex-1 overflow-hidden lg:block ${
              hasSelectedConversation ? "block" : "hidden"
            }`}
          >
            {hasSelectedConversation ? (
              <div className="flex h-full flex-col">
                <div className="shrink-0 px-4 pt-3 lg:hidden">
                  <BackLink href="/chat" label={t("chat.backToList")} />
                </div>
                <div className="min-h-0 flex-1">{children}</div>
              </div>
            ) : (
              <div className="hidden h-full items-center justify-center text-sm text-muted-esblu lg:flex">
                {t("chat.noConversationSelected")}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
