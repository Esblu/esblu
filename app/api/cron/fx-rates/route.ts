import "server-only";

import { timingSafeEqual } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ECB_HIST_90D_URL, buildEcbImportBatch, importEcbBatch } from "@/lib/fx/ecb-reference-rates";

// =============================================================================
// GET /api/cron/fx-rates — import oficiálnych referenčných kurzov ECB (eurofxref-hist-90d.xml)
// do append-only tabuľky fx_reference_rates (20261008100004). Jediné miesto so sieťovým volaním;
// zobrazenie ani finalizácia faktúry nikdy nesťahuje kurzy.
//
// Chránené CRON_SECRET (Authorization: Bearer …). Idempotentné (rovnaký súbor = rovnaký SHA-256).
// Rozpor s uloženými kurzami → chyba, nič sa neprepíše. Plánovanie (vercel.json) ZATIAĽ nie —
// odporúčané denne ráno (napr. 05:00 UTC), aby bol uzavretý predchádzajúci deň.
// =============================================================================

export const runtime = "nodejs";
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
  const fetchedAt = new Date();
  let xml: string;
  try {
    const res = await fetch(ECB_HIST_90D_URL, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
    if (!res.ok) return Response.json({ success: false, code: "ECB_FETCH_FAILED", status: res.status }, { status: 502 });
    xml = await res.text();
  } catch {
    return Response.json({ success: false, code: "ECB_FETCH_FAILED" }, { status: 502 });
  }
  try {
    const batch = buildEcbImportBatch(xml, ECB_HIST_90D_URL, fetchedAt);
    const db = getSupabaseAdmin();
    const result = await importEcbBatch((fn, args) => db.rpc(fn, args), batch);
    return Response.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message.split(/\s/)[0].slice(0, 60) : "ESBLU_FX_IMPORT_FAILED";
    return Response.json({ success: false, code }, { status: 500 });
  }
}
