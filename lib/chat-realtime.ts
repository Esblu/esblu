// =============================================================================
// Interný firemný chat (human-to-human) — rozsah Realtime odberov.
//
// Cost control (2026-10-25): odbery `postgres_changes` na chat_messages /
// chat_attachments / chat_message_references boli bez filtra → Realtime
// vyhodnocoval KAŽDÝ INSERT celej platformy pre každého pripojeného klienta
// (RLS rozhodla až na konci). Teraz má každý odber filter na AKTÍVNU firmu
// (alebo konverzáciu), takže Realtime posiela/autorizuje iba udalosti tej
// firmy. RLS ostáva poslednou bezpečnostnou vrstvou — filter je iba
// zúženie, nikdy nie oprávnenie.
//
// Bez platného UUID sa nevytvorí žiadny odber (fail closed: žiadny
// celoplatformový odber; badge sa obnoví pri návrate do appky / otvorení).
// =============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `company_id=eq.<uuid>` alebo null (bez odberu). */
export function chatCompanyFilter(companyId: string | null | undefined): string | null {
  return typeof companyId === "string" && UUID.test(companyId) ? `company_id=eq.${companyId}` : null;
}

/** `conversation_id=eq.<uuid>` alebo null (bez odberu). */
export function chatConversationFilter(conversationId: string | null | undefined): string | null {
  return typeof conversationId === "string" && UUID.test(conversationId) ? `conversation_id=eq.${conversationId}` : null;
}
