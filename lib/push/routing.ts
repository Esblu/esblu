// =============================================================================
// Komu a čo poslať — čisté pravidlá (bez DB), testované v Node.
//
// PRAVIDLÁ
// --------
//   Chat      príjemcovia = členovia konverzácie OKREM autora; firemný kanál =
//             všetci aktívni členovia firmy (tak, ako ho vidia v appke).
//             Platí pre každú rolu vrátane zamestnanca.
//   Termíny   IBA vlastník a administrátor (STK, EK, známka, servis sú
//             prevádzkové termíny firmy). Zamestnanec ani účtovník nie.
//   Obsah     Na zamknutej obrazovke všeobecný text („Nová správa v Esblu").
//             Text správy iba po výslovnom zapnutí; nikdy sumy ani mená
//             partnerov. Kliknutie vedie na RELATÍVNU cestu v Esblu — appka
//             si pri otvorení vyžiada prihlásenie ako vždy.
// =============================================================================

export type MemberRole = "owner" | "admin" | "accountant" | "employee" | string;
export type CompanyMember = { userId: string; role: MemberRole; status?: string };

export type ChatConversation = { type: "company" | "direct"; memberUserIds: string[] };

/** Príjemcovia chatovej správy (bez autora, iba aktívni členovia firmy). */
export function chatRecipients(conversation: ChatConversation, members: CompanyMember[], authorId: string): string[] {
  const active = new Set(members.filter((member) => (member.status ?? "active") === "active").map((member) => member.userId));
  const candidates = conversation.type === "company" ? Array.from(active) : conversation.memberUserIds.filter((id) => active.has(id));
  return Array.from(new Set(candidates.filter((id) => id !== authorId)));
}

/** Príjemcovia upozornení na termíny: vlastník a administrátor. */
export function deadlineRecipients(members: CompanyMember[]): string[] {
  return members
    .filter((member) => (member.status ?? "active") === "active" && (member.role === "owner" || member.role === "admin"))
    .map((member) => member.userId);
}

/** Relatívna cesta v Esblu — nikdy iná doména ani „//evil". */
export function isSafeNotificationUrl(url: unknown): url is string {
  return typeof url === "string" && /^\/(?!\/)[A-Za-z0-9\-._~/?=&%]*$/.test(url) && !url.includes("..");
}

const TEXT = {
  sk: { chatTitle: "Nová správa v Esblu", chatBody: "Máte novú správu. Otvorte Esblu a prečítajte si ju.", deadlineTitle: "Blížiace sa termíny v Esblu", deadlineBody: (n: number) => (n === 1 ? "Blíži sa 1 termín (STK, EK, známka alebo servis)." : `Blíži sa ${n} termínov (STK, EK, známka alebo servis).`) },
  en: { chatTitle: "New message in Esblu", chatBody: "You have a new message. Open Esblu to read it.", deadlineTitle: "Upcoming deadlines in Esblu", deadlineBody: (n: number) => (n === 1 ? "1 deadline is coming up (inspection, vignette or service)." : `${n} deadlines are coming up (inspection, vignette or service).`) },
  de: { chatTitle: "Neue Nachricht in Esblu", chatBody: "Sie haben eine neue Nachricht. Öffnen Sie Esblu, um sie zu lesen.", deadlineTitle: "Anstehende Fristen in Esblu", deadlineBody: (n: number) => (n === 1 ? "1 Frist steht an (HU, Vignette oder Service)." : `${n} Fristen stehen an (HU, Vignette oder Service).`) },
} as const;

function textFor(locale: string) {
  return locale === "en" ? TEXT.en : locale === "de" ? TEXT.de : TEXT.sk;
}

export type PushPayload = { title: string; body: string; url: string; tag: string };

/**
 * Notifikácia o novej správe. Text správy iba pri `showPreview` a skrátený;
 * inak všeobecná veta. Nikdy meno autora ani príloha.
 */
export function buildChatPayload(input: { locale: string; conversationId: string; messageBody?: string; showPreview: boolean }): PushPayload {
  const text = textFor(input.locale);
  const preview = input.showPreview && input.messageBody ? input.messageBody.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return {
    title: text.chatTitle,
    body: preview || text.chatBody,
    url: `/chat/${encodeURIComponent(input.conversationId)}`,
    tag: `chat-${input.conversationId}`,
  };
}

/** Súhrnná notifikácia o termínoch — iba počet, nikdy ŠPZ ani názvy. */
export function buildDeadlinePayload(input: { locale: string; count: number }): PushPayload {
  const text = textFor(input.locale);
  return { title: text.deadlineTitle, body: text.deadlineBody(input.count), url: "/", tag: "deadlines" };
}

export type DeadlineForNotification = { deadlineType: string; entityId: string; dueDate: string; daysRemaining: number };

/**
 * Ktoré termíny treba dnes pripomenúť: presne v niektorom okne (napr. 30,
 * 7, 1, 0 dní) alebo po termíne (iba raz — kľúč je bez dňa). Kľúč slúži na
 * deduplikáciu v notification_deliveries.
 */
export function deadlinesToNotify(items: DeadlineForNotification[], windows: number[]): { item: DeadlineForNotification; dedupeKey: string }[] {
  const wanted = new Set(windows.filter((day) => Number.isInteger(day) && day >= 0 && day <= 365));
  const out: { item: DeadlineForNotification; dedupeKey: string }[] = [];
  for (const item of items) {
    if (item.daysRemaining < 0) {
      out.push({ item, dedupeKey: `deadline:${item.deadlineType}:${item.entityId}:${item.dueDate}:overdue` });
    } else if (wanted.has(item.daysRemaining)) {
      out.push({ item, dedupeKey: `deadline:${item.deadlineType}:${item.entityId}:${item.dueDate}:${item.daysRemaining}` });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Vlastníctvo push endpointu
// -----------------------------------------------------------------------------

export type ExistingSubscription = { userId: string; companyId: string; revoked: boolean } | null;
export type SubscriptionWrite = "insert" | "update" | "reject";

/**
 * Smie volajúci zaregistrovať tento endpoint?
 *   - nový endpoint                         → insert
 *   - vlastný (ten istý používateľ)         → update (aj pri inej aktívnej
 *                                             firme — je to jeho zariadenie)
 *   - cudzí, ale ZRUŠENÝ (odhlásenie)       → update (zariadenie prevzal nový
 *                                             používateľ po odhlásení)
 *   - cudzí a AKTÍVNY                       → reject (bez prezradenia komu patrí)
 * Endpoint je tajná adresa, ale na jej utajení sa nespoliehame.
 */
export function decideSubscriptionWrite(existing: ExistingSubscription, caller: { userId: string; companyId: string }): SubscriptionWrite {
  if (!existing) return "insert";
  if (existing.userId === caller.userId) return "update";
  return existing.revoked ? "update" : "reject";
}
