// =============================================================================
// Komu a čo poslať — čisté pravidlá (bez DB), testované v Node.
//
// PRAVIDLÁ
// --------
//   Chat      HUMAN CHAT (nie AI asistent). Príjemcovia sa v produkcii
//             počítajú v DB (esblu_push_chat_recipients — M1 membership
//             model); chatRecipients() je jeho presné zrkadlo pre testy:
//             firemný kanál = všetci aktívni členovia firmy, direct = iba
//             dvojica direct_user_low/high s riadkom členstva. Bez autora.
//             Platí pre každú rolu vrátane zamestnanca a účtovníka; rozsah
//             AI asistenta (lib/mobile-nav.ts aiAssistantAccess) sa tu
//             NEPOUŽÍVA a nesmie sa sem zamiešať.
//   Termíny   IBA vlastník a administrátor (STK, EK, známka, servis sú
//             prevádzkové termíny firmy). Musí zároveň platiť canOperate
//             (prevádzkové moduly smie čítať). Zamestnanec ani účtovník nie.
//   Obsah     Na zamknutej obrazovke všeobecný text v JAZYKU ZARIADENIA
//             príjemcu („Nová správa v Esblu"). Text správy iba po výslovnom
//             zapnutí; nikdy sumy, ŠPZ ani mená partnerov. Cieľ kliknutia je
//             obrazovka z allowlistu (lib/push/deep-link.ts), nikdy URL.
// =============================================================================

import { normalizeLocale, type Locale } from "@/lib/i18n/locales";
import type { PushTarget } from "@/lib/push/deep-link";

export type MemberRole = "owner" | "admin" | "accountant" | "employee" | string;
export type CompanyMember = { userId: string; role: MemberRole; status?: string };

export type ChatConversation = {
  type: "company" | "direct";
  /** direct: direct_user_low / direct_user_high */
  directUserIds?: (string | null)[];
  /** direct: používatelia s riadkom chat_conversation_members */
  memberUserIds: string[];
};

/** Príjemcovia chatovej správy (zrkadlo esblu_push_chat_recipients). */
export function chatRecipients(conversation: ChatConversation, members: CompanyMember[], authorId: string | null): string[] {
  const active = new Set(members.filter((member) => (member.status ?? "active") === "active").map((member) => member.userId));
  let candidates: string[];
  if (conversation.type === "company") {
    candidates = Array.from(active);
  } else {
    const pair = new Set((conversation.directUserIds ?? []).filter((id): id is string => typeof id === "string"));
    const rows = new Set(conversation.memberUserIds);
    candidates = Array.from(pair).filter((id) => active.has(id) && rows.has(id));
  }
  return Array.from(new Set(candidates.filter((id) => id !== authorId)));
}

const OPERATE_ROLES = new Set(["owner", "admin", "employee"]);
const DEADLINE_ROLES = new Set(["owner", "admin"]);

/** Príjemcovia upozornení na termíny: vlastník a administrátor (aktívni). */
export function deadlineRecipients(members: CompanyMember[]): string[] {
  return members
    .filter((member) => (member.status ?? "active") === "active" && DEADLINE_ROLES.has(member.role) && OPERATE_ROLES.has(member.role))
    .map((member) => member.userId);
}

const TEXT: Record<Locale, { chatTitle: string; chatBody: string; deadlineTitle: string; deadlineBody: (n: number) => string }> = {
  sk: {
    chatTitle: "Nová správa v Esblu",
    chatBody: "Máte novú správu. Otvorte Esblu a prečítajte si ju.",
    deadlineTitle: "Blížiace sa termíny v Esblu",
    deadlineBody: (n) =>
      n === 1
        ? "Blíži sa 1 termín (STK, EK, známka alebo servis)."
        : n >= 2 && n <= 4
          ? `Blížia sa ${n} termíny (STK, EK, známka alebo servis).`
          : `Blíži sa ${n} termínov (STK, EK, známka alebo servis).`,
  },
  en: {
    chatTitle: "New message in Esblu",
    chatBody: "You have a new message. Open Esblu to read it.",
    deadlineTitle: "Upcoming deadlines in Esblu",
    deadlineBody: (n) => (n === 1 ? "1 deadline is coming up (inspection, vignette or service)." : `${n} deadlines are coming up (inspection, vignette or service).`),
  },
  de: {
    chatTitle: "Neue Nachricht in Esblu",
    chatBody: "Sie haben eine neue Nachricht. Öffnen Sie Esblu, um sie zu lesen.",
    deadlineTitle: "Anstehende Fristen in Esblu",
    deadlineBody: (n) => (n === 1 ? "1 Frist steht an (HU, Vignette oder Service)." : `${n} Fristen stehen an (HU, Vignette oder Service).`),
  },
};

/** Obsah notifikácie nezávislý od poskytovateľa (web push / FCM / APNs). */
export type PushMessage = { title: string; body: string; tag: string; target: PushTarget };

/**
 * Notifikácia o novej správe v jazyku PRÍJEMCU (jeho zariadenia). Text
 * správy iba pri `showPreview` a skrátený; inak všeobecná veta. Nikdy meno
 * autora ani príloha.
 */
export function buildChatPayload(input: { locale: string; conversationId: string; messageBody?: string; showPreview: boolean }): PushMessage {
  const text = TEXT[normalizeLocale(input.locale)];
  const preview = input.showPreview && input.messageBody ? input.messageBody.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return {
    title: text.chatTitle,
    body: preview || text.chatBody,
    tag: `chat-${input.conversationId}`,
    target: { screen: "chat", id: input.conversationId },
  };
}

export type DeadlineEntity = { entityType: "vehicle" | "machine" | string; entityId: string };

/**
 * Súhrnná notifikácia o termínoch — iba počet, nikdy ŠPZ ani názvy. Jediný
 * termín otvorí detail vozidla/stroja, viac termínov prehľad (nástenka).
 */
export function buildDeadlinePayload(input: { locale: string; count: number; single?: DeadlineEntity | null }): PushMessage {
  const text = TEXT[normalizeLocale(input.locale)];
  let target: PushTarget = { screen: "deadlines" };
  if (input.count === 1 && input.single && (input.single.entityType === "vehicle" || input.single.entityType === "machine")) {
    target = { screen: input.single.entityType, id: input.single.entityId };
  }
  return { title: text.deadlineTitle, body: text.deadlineBody(input.count), tag: "deadlines", target };
}

export type DeadlineForNotification = { deadlineType: string; entityId: string; dueDate: string; daysRemaining: number; entityType?: string };

/**
 * Ktoré termíny treba dnes pripomenúť: presne v niektorom okne (napr. 30,
 * 7, 1, 0 dní) alebo po termíne (iba raz — kľúč je bez dňa). Kľúč slúži na
 * deduplikáciu v notification_deliveries.
 */
export function deadlinesToNotify<T extends DeadlineForNotification>(items: T[], windows: number[]): { item: T; dedupeKey: string }[] {
  const wanted = new Set(windows.filter((day) => Number.isInteger(day) && day >= 0 && day <= 365));
  const out: { item: T; dedupeKey: string }[] = [];
  for (const item of items) {
    if (item.daysRemaining < 0) {
      out.push({ item, dedupeKey: `deadline:${item.deadlineType}:${item.entityId}:${item.dueDate}:overdue` });
    } else if (wanted.has(item.daysRemaining)) {
      out.push({ item, dedupeKey: `deadline:${item.deadlineType}:${item.entityId}:${item.dueDate}:${item.daysRemaining}` });
    }
  }
  return out;
}
