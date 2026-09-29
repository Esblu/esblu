"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ChatShell } from "@/app/chat/ChatShell";

/**
 * /chat layout (web) — "/chat" → žiadna vybraná konverzácia,
 * "/chat/{id}" → vybraná. Rozloženie je v ChatShell (zdieľané s mobilom).
 */
export default function ChatLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const activeConversationId = pathname !== "/chat" ? pathname.replace("/chat/", "") : null;
  return <ChatShell activeConversationId={activeConversationId}>{children}</ChatShell>;
}
