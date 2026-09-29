"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ChatShell } from "@/app/chat/ChatShell";
import ChatMessageView from "@/app/components/chat/ChatMessageView";

// Mobile M1 (2026-09-28): jediná statická chat routa. /chat → zoznam
// konverzácií, /chat?id=… → konverzácia (web: /chat a /chat/[id]).
// Rozloženie aj logika sú zdieľané (ChatShell, ChatConversationList,
// ChatMessageView); oprávnenia rieši RLS chat tabuliek.
function ChatMobileRoute() {
  const id = useSearchParams().get("id");
  const activeConversationId = id && /^[0-9a-fA-F-]{36}$/.test(id) ? id : null;
  return (
    <ChatShell activeConversationId={activeConversationId}>
      {activeConversationId ? <ChatMessageView conversationId={activeConversationId} /> : null}
    </ChatShell>
  );
}

export default function ChatMobilePage() {
  return (
    <Suspense fallback={null}>
      <ChatMobileRoute />
    </Suspense>
  );
}
