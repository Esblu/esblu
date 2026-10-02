import "server-only";

import { timingSafeEqual } from "node:crypto";
import { runEinvoiceMaintenance } from "@/lib/einvoice/ops/maintenance";
import { createSupabaseOpsStore } from "@/lib/einvoice/ops/supabase-store";

// =============================================================================
// GET /api/cron/einvoice-maintenance — interný health, alert kandidáti,
// retencia technických webhook dát (90 dní) a kontrola konzistencie storage.
//
// Chránené CRON_SECRET (Authorization: Bearer …) — nie bežný prihlásený
// klient. Výstup iba agregované počty a strojové kódy: žiadne firmy, IČO,
// čísla dokladov, XML, participant ID ani tajomstvá. Nič sa nemaže okrem
// uzavretých webhook metadát po retencii. Plánovanie (vercel.json) ZATIAĽ nie.
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
  const report = await runEinvoiceMaintenance(createSupabaseOpsStore(), { retention: true });
  return Response.json({ success: true, ...report }, { headers: { "Cache-Control": "no-store" } });
}
