import { randomUUID, timingSafeEqual } from "node:crypto";
import { drainVaultQueue, purgeVault, reconcileVault, supabaseVaultRpc, supabaseVaultStorage, VaultNotInstalledError } from "@/lib/storage-vault/worker";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// GET /api/cron/storage-vault?mode=queue|reconcile — Trezor súborov (NÁVRH, vypnutý).
//   queue     (každú minútu): kópie nových / zmenených súborov z fronty (trigger na storage.objects)
//   reconcile (každú hodinu): doplnenie chýbajúcich kópií, zmazané originály, poistka hromadného zmazania, purge po lehote
// Beží IBA pri ESBLU_STORAGE_VAULT_ENABLED=1 (inak configured:false, žiadne volanie DB ani Storage).
// Chránené CRON_SECRET. Odpoveď: iba počty a kódy, žiadne cesty súborov.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ success: false }, { status: 401 });
  if (process.env.ESBLU_STORAGE_VAULT_ENABLED !== "1") return Response.json({ success: true, configured: false });
  const mode = new URL(req.url).searchParams.get("mode") === "reconcile" ? "reconcile" : "queue";
  const admin = getSupabaseAdmin();
  const rpc = supabaseVaultRpc(admin);
  const storage = supabaseVaultStorage(admin);
  try {
    if (mode === "queue") {
      const r = await drainVaultQueue(rpc, storage, randomUUID(), 50);
      return Response.json({ success: r.failed === 0, configured: true, mode, ...r }, { headers: { "Cache-Control": "no-store" } });
    }
    const rec = await reconcileVault(rpc);
    const purge = await purgeVault(rpc, storage, 200);
    // Upozornenie (HTTP 503 -> monitoring): pozastavený purge, mŕtva fronta, alebo kópie meškajú > 60 min.
    const alert = rec.mass_delete_pause || rec.dead_queue > 0 || rec.oldest_pending_minutes > 60;
    return Response.json({ success: !alert, configured: true, mode, ...rec, ...purge }, { status: alert ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const code = e instanceof VaultNotInstalledError ? "ESBLU_VAULT_NOT_INSTALLED" : "ESBLU_VAULT_FAILED";
    return Response.json({ success: false, configured: true, mode, code }, { status: 500 });
  }
}
