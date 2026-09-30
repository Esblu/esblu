import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { configuredProviders, hasAnyProvider, loadPreferences, deliverToUsers, DEFAULT_PREFERENCES } from "@/lib/push/server";
import { buildChatPayload } from "@/lib/push/routing";
import { authorizePushCaller } from "@/lib/push/request";

// -----------------------------------------------------------------------------
// POST /api/push/chat-message  { messageId }
//
// HUMAN CHAT (nie AI asistent). Volá ho AUTOR hneď po odoslaní správy.
// Server si všetko overí sám:
//   - správa existuje a volajúci ju vidí (user-scoped klient, M1 RLS
//     esblu_chat_can_access_conversation), je jej autor, je čerstvá (≤ 5 min)
//     a nie je zmazaná,
//   - príjemcovia = esblu_push_chat_recipients (DB, M1 membership model):
//     firemný kanál → aktívni členovia firmy, direct → druhý účastník;
//     každá rola vrátane zamestnanca; rozsah AI asistenta sa nepoužíva,
//   - zariadenia iba tej istej firmy, so živou session (esblu_push_delivery_targets),
//   - text v jazyku ZARIADENIA príjemcu, cieľ = obrazovka konverzácie,
//   - deduplikácia na správu (chat:<messageId>) — opakované volanie nič nepošle.
// Z tela sa neberie nič okrem ID správy.
// -----------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const who = await authorizePushCaller(req);
  if ("response" in who) return who.response;

  const providers = configuredProviders();
  if (!hasAnyProvider(providers)) return Response.json({ success: true, sent: 0, configured: false });

  const body = (await req.json().catch(() => null)) as { messageId?: unknown } | null;
  const messageId = typeof body?.messageId === "string" && UUID.test(body.messageId) ? body.messageId : null;
  if (!messageId) return Response.json({ success: false }, { status: 400 });

  const { data: message } = await who.db
    .from("chat_messages")
    .select("id, conversation_id, company_id, author_id, body, created_at, deleted_at")
    .eq("id", messageId)
    .maybeSingle();
  const row = message as { id: string; conversation_id: string; company_id: string; author_id: string | null; body: string; created_at: string; deleted_at: string | null } | null;
  if (!row || row.author_id !== who.userId || row.deleted_at) return Response.json({ success: false }, { status: 404 });
  if (Date.now() - new Date(row.created_at).getTime() > 5 * 60 * 1000) return Response.json({ success: true, sent: 0 });

  const admin = getSupabaseAdmin();
  const { data: recipientRows, error } = await admin.rpc("esblu_push_chat_recipients", { p_message_id: row.id });
  if (error) return Response.json({ success: false }, { status: 500 });
  const recipients = ((recipientRows as string[] | null) ?? []).filter((id) => typeof id === "string" && id !== who.userId);

  const preferences = await loadPreferences(admin, row.company_id, recipients);
  const allowed = recipients.filter((id) => (preferences.get(id) ?? DEFAULT_PREFERENCES).chat_enabled);

  const result = await deliverToUsers(admin, providers, {
    companyId: row.company_id,
    userIds: allowed,
    kind: "chat",
    dedupeKey: `chat:${row.id}`,
    messageFor: (userId, locale) =>
      buildChatPayload({
        locale,
        conversationId: row.conversation_id,
        messageBody: row.body,
        showPreview: (preferences.get(userId) ?? DEFAULT_PREFERENCES).show_message_preview,
      }),
  });
  return Response.json({ success: true, sent: result.sent });
}
