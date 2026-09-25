import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { readVapidKeys, loadPreferences, deliverToUsers, DEFAULT_PREFERENCES } from "@/lib/push/server";
import { buildChatPayload, chatRecipients, type CompanyMember } from "@/lib/push/routing";

// -----------------------------------------------------------------------------
// POST /api/push/chat-message  { messageId }
//
// Volá ho AUTOR hneď po odoslaní správy (udalosť, nie plánovač). Server si
// všetko overí sám:
//   - správa existuje a volajúci ju vidí (user-scoped klient, RLS),
//   - volajúci je jej autor, správa je čerstvá (≤ 5 min) a nie je zmazaná,
//   - príjemcovia = členovia tej istej konverzácie v tej istej firme,
//   - deduplikácia na správu (chat:<messageId>) — opakované volanie nič nepošle.
// Z tela sa neberie nič okrem ID správy.
// -----------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const locale = getRequestLocale(req);
  const { user, error } = await verifyRequestUser(req, locale);
  if (error || !user) return Response.json({ success: false }, { status: 401 });

  const vapid = readVapidKeys();
  if (!vapid) return Response.json({ success: true, sent: 0, configured: false });

  const body = (await req.json().catch(() => null)) as { messageId?: unknown } | null;
  const messageId = typeof body?.messageId === "string" && UUID.test(body.messageId) ? body.messageId : null;
  if (!messageId) return Response.json({ success: false }, { status: 400 });

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const db = getUserScopedSupabaseClient(token);
  const { data: message } = await db
    .from("chat_messages")
    .select("id, conversation_id, company_id, author_id, body, created_at, deleted_at")
    .eq("id", messageId)
    .maybeSingle();
  const row = message as { id: string; conversation_id: string; company_id: string; author_id: string | null; body: string; created_at: string; deleted_at: string | null } | null;
  if (!row || row.author_id !== user.id || row.deleted_at) return Response.json({ success: false }, { status: 404 });
  if (Date.now() - new Date(row.created_at).getTime() > 5 * 60 * 1000) return Response.json({ success: true, sent: 0 });

  const { data: conversation } = await db.from("chat_conversations").select("id, type, company_id").eq("id", row.conversation_id).maybeSingle();
  const conv = conversation as { id: string; type: "company" | "direct"; company_id: string } | null;
  if (!conv || conv.company_id !== row.company_id) return Response.json({ success: false }, { status: 404 });

  const admin = getSupabaseAdmin();
  const [{ data: members }, { data: convMembers }] = await Promise.all([
    admin.from("company_members").select("user_id, role, status").eq("company_id", row.company_id).eq("status", "active"),
    conv.type === "direct"
      ? admin.from("chat_conversation_members").select("user_id").eq("conversation_id", conv.id).eq("company_id", row.company_id)
      : Promise.resolve({ data: [] }),
  ]);
  const companyMembers: CompanyMember[] = ((members as { user_id: string; role: string; status: string }[] | null) ?? []).map((m) => ({ userId: m.user_id, role: m.role, status: m.status }));
  const recipients = chatRecipients(
    { type: conv.type, memberUserIds: ((convMembers as { user_id: string }[] | null) ?? []).map((m) => m.user_id) },
    companyMembers,
    user.id
  );
  const preferences = await loadPreferences(admin, row.company_id, recipients);
  const allowed = recipients.filter((id) => (preferences.get(id) ?? DEFAULT_PREFERENCES).chat_enabled);

  const sent = await deliverToUsers(admin, vapid, {
    companyId: row.company_id,
    userIds: allowed,
    kind: "chat",
    dedupeKey: `chat:${row.id}`,
    payloadFor: (userId) =>
      buildChatPayload({
        locale,
        conversationId: conv.id,
        messageBody: row.body,
        showPreview: (preferences.get(userId) ?? DEFAULT_PREFERENCES).show_message_preview,
      }),
  });
  return Response.json({ success: true, sent });
}
