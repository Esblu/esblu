import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { readVapidKeys } from "@/lib/push/server";
import { decideSubscriptionWrite } from "@/lib/push/routing";

// -----------------------------------------------------------------------------
// POST   /api/push/subscribe  — zaregistruje TOTO zariadenie pre push.
// DELETE /api/push/subscribe  — odhlási toto zariadenie (odhlásenie, vypnutie).
//
// Firma a používateľ sa NIKDY neberú z tela požiadavky: používateľ z tokenu,
// firma z jeho AKTÍVNEHO členstva (user-scoped klient, RLS). Endpoint je
// unikátny; AKTÍVNY endpoint iného používateľa sa neprevezme (409 bez
// prezradenia vlastníka) — prevziať sa dá iba zrušený (po odhlásení) alebo
// vlastný (lib/push/routing.ts#decideSubscriptionWrite).
// -----------------------------------------------------------------------------

type Body = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };

function readSubscription(body: Body | null): { endpoint: string; p256dh: string; auth: string } | null {
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";
  if (!/^https:\/\/[^\s]+$/.test(endpoint) || endpoint.length > 2048) return null;
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{10,100}$/.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

async function activeMembership(req: Request) {
  const locale = getRequestLocale(req);
  const { user, error } = await verifyRequestUser(req, locale);
  if (error || !user) return { response: Response.json({ success: false }, { status: 401 }) } as const;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const db = getUserScopedSupabaseClient(token);
  const { data: membership } = await db
    .from("company_members")
    .select("company_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!membership) return { response: Response.json({ success: false }, { status: 403 }) } as const;
  return { userId: user.id, companyId: (membership as { company_id: string }).company_id } as const;
}

export async function POST(req: Request) {
  const who = await activeMembership(req);
  if ("response" in who) return who.response;
  if (!readVapidKeys()) return Response.json({ success: false, error: "PUSH_NOT_CONFIGURED" }, { status: 503 });
  const subscription = readSubscription((await req.json().catch(() => null)) as Body | null);
  if (!subscription) return Response.json({ success: false }, { status: 400 });

  const admin = getSupabaseAdmin();
  const { data: existingRow, error: readError } = await admin
    .from("push_subscriptions")
    .select("id, user_id, company_id, revoked_at")
    .eq("endpoint", subscription.endpoint)
    .maybeSingle();
  if (readError) return Response.json({ success: false }, { status: 500 });
  const existing = existingRow as { id: string; user_id: string; company_id: string; revoked_at: string | null } | null;
  const decision = decideSubscriptionWrite(
    existing ? { userId: existing.user_id, companyId: existing.company_id, revoked: existing.revoked_at !== null } : null,
    who
  );
  // Aktívny endpoint iného používateľa sa NEPREVEZME. Odpoveď neprezradí,
  // komu patrí — rovnaká ako pri neplatnom vstupe.
  if (decision === "reject") return Response.json({ success: false }, { status: 409 });

  const row = {
    endpoint: subscription.endpoint,
    p256dh: subscription.p256dh,
    auth_secret: subscription.auth,
    user_id: who.userId,
    company_id: who.companyId,
    user_agent: (req.headers.get("user-agent") || "").slice(0, 300),
    revoked_at: null,
  };
  const { data: written, error } = decision === "insert"
    ? await admin.from("push_subscriptions").insert(row).select("id")
    : await admin
        .from("push_subscriptions")
        .update(row)
        .eq("id", (existing as { id: string }).id)
        // Súbeh: riadok sa medzitým nesmel stať aktívnym riadkom iného
        // používateľa (userId pochádza z overeného tokenu, nie z tela).
        .or(`user_id.eq.${who.userId},revoked_at.not.is.null`)
        .select("id");
  if (error) return Response.json({ success: false }, { status: error.code === "23505" ? 409 : 500 });
  if ((written ?? []).length !== 1) return Response.json({ success: false }, { status: 409 });
  return Response.json({ success: true });
}

export async function DELETE(req: Request) {
  const who = await activeMembership(req);
  if ("response" in who) return who.response;
  const body = (await req.json().catch(() => null)) as Body | null;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) return Response.json({ success: false }, { status: 400 });
  const admin = getSupabaseAdmin();
  // Iba vlastné zariadenie volajúceho.
  await admin
    .from("push_subscriptions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("endpoint", endpoint)
    .eq("user_id", who.userId);
  return Response.json({ success: true });
}
