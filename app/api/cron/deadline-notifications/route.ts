import { timingSafeEqual } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { buildMachineDeadlines, buildVehicleDeadlines, type MinimalServiceRecord } from "@/lib/deadlines";
import type { VehicleVignette } from "@/lib/vehicle-vignettes";
import { configuredProviders, hasAnyProvider, loadPreferences, deliverToUsers, DEFAULT_PREFERENCES } from "@/lib/push/server";
import { buildDeadlinePayload, deadlineRecipients, deadlinesToNotify, type CompanyMember } from "@/lib/push/routing";

// -----------------------------------------------------------------------------
// GET /api/cron/deadline-notifications — denne (Vercel Cron, vercel.json).
//
// 1. Upratanie: zariadenia so skončenou session alebo členstvom sa zrušia
//    (esblu_push_revoke_ended).
// 2. Zdroje termínov sú IBA existujúce dáta Esblu (lib/deadlines.ts): STK, EK,
//    diaľničná známka, najbližší servis vozidla a stroja. Nič sa nevymýšľa.
// 3. Pre každú firmu zvlášť: jej termíny → jej vlastník/administrátori
//    (oprávnenie na prevádzkové moduly; zamestnanec ani účtovník nie) → ich
//    zariadenia v tej istej firme (web, Android, iOS). Deduplikácia na
//    termín a okno (30/7/1/0 dní, podľa predvoľby). Text v jazyku zariadenia.
// Chránené tajomstvom CRON_SECRET (Authorization: Bearer …).
// -----------------------------------------------------------------------------

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ success: false }, { status: 401 });
  const providers = configuredProviders();
  if (!hasAnyProvider(providers)) return Response.json({ success: true, configured: false, sent: 0 });

  const admin = getSupabaseAdmin();
  await admin.rpc("esblu_push_revoke_ended");

  // Iba firmy, ktoré majú aspoň jedno aktívne zariadenie — ostatné netreba čítať.
  const { data: companies } = await admin.rpc("esblu_push_companies_with_targets");
  const companyIds = ((companies as string[] | null) ?? []).filter((id) => typeof id === "string");

  let sent = 0;
  for (const companyId of companyIds) {
    const { data: members } = await admin.from("company_members").select("user_id, role, status").eq("company_id", companyId).eq("status", "active");
    const recipients = deadlineRecipients(((members as { user_id: string; role: string; status: string }[] | null) ?? []).map((m) => ({ userId: m.user_id, role: m.role, status: m.status }) as CompanyMember));
    if (recipients.length === 0) continue;

    const [vehicles, machines, vignettes, vehicleServices, machineServices] = await Promise.all([
      admin.from("vehicles").select("id, spz, vin, znacka, model, stk, ek").eq("company_id", companyId),
      admin.from("machines").select("id, name, category").eq("company_id", companyId),
      admin.from("vehicle_vignettes").select("*").eq("company_id", companyId),
      admin.from("vehicle_services").select("vehicle_id, service_date, next_service_date").eq("company_id", companyId),
      admin.from("machine_services").select("machine_id, service_date, next_service_date").eq("company_id", companyId),
    ]);
    const items = [
      ...buildVehicleDeadlines(vehicles.data ?? [], (vignettes.data as VehicleVignette[]) ?? [], (vehicleServices.data as MinimalServiceRecord[]) ?? [], "sk"),
      ...buildMachineDeadlines(machines.data ?? [], (machineServices.data as MinimalServiceRecord[]) ?? []),
    ];
    if (items.length === 0) continue;

    const preferences = await loadPreferences(admin, companyId, recipients);
    for (const userId of recipients) {
      const prefs = preferences.get(userId) ?? DEFAULT_PREFERENCES;
      if (!prefs.deadlines_enabled) continue;
      const due = deadlinesToNotify(items, prefs.deadline_days);
      if (due.length === 0) continue;
      // Deduplikácia PO TERMÍNOCH: každý termín v danom okne (alebo „po
      // termíne") sa pripomenie práve raz. Do súhrnu idú iba nové.
      const fresh: (typeof due)[number][] = [];
      for (const entry of due) {
        const { error } = await admin
          .from("notification_deliveries")
          .insert({ user_id: userId, company_id: companyId, kind: "deadline", dedupe_key: entry.dedupeKey });
        if (!error) fresh.push(entry);
      }
      if (fresh.length === 0) continue;
      const single = fresh.length === 1 ? { entityType: fresh[0].item.entityType, entityId: fresh[0].item.entityId } : null;
      const result = await deliverToUsers(admin, providers, {
        companyId,
        userIds: [userId],
        kind: "deadline",
        dedupeKey: null,
        messageFor: (_userId, locale) => buildDeadlinePayload({ locale, count: fresh.length, single }),
      });
      sent += result.sent;
    }
  }
  return Response.json({ success: true, sent });
}
