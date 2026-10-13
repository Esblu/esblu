import "server-only";

import { timingSafeEqual } from "node:crypto";
import { getEinvoiceProvider } from "@/lib/einvoice/provider";
import { runInboundPoll } from "@/lib/einvoice/inbound/processor";
import { createSupabaseInboundStore } from "@/lib/einvoice/inbound/supabase-store";

// =============================================================================
// GET /api/cron/einvoice-inbound — poll fallback príjmu E-Faktúr.
//
// Chránené CRON_SECRET (Authorization: Bearer …). Bez nakonfigurovaného
// poskytovateľa nič nerobí. Pre každú pripravenú organizáciu načíta zoznam
// nepotvrdených dokladov, zaregistruje ich (idempotentne) a spracuje dávku
// (claim FOR UPDATE SKIP LOCKED + lease). Webhook nie je jediný mechanizmus.
// Plánovanie (vercel.json) sa ZATIAĽ nepridáva — Phase 6.
// Odpoveď: iba počty a strojové kódy.
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

  let runtimeConfig = null;
  try {
    runtimeConfig = getEinvoiceProvider();
  } catch {
    runtimeConfig = null;
  }
  if (!runtimeConfig) return Response.json({ success: true, configured: false });

  const result = await runInboundPoll(
    { store: createSupabaseInboundStore(), provider: runtimeConfig.provider, environment: runtimeConfig.environment },
    { batchSize: 5, leaseSeconds: 120 }
  );
  return Response.json(
    {
      success: true,
      configured: true,
      environment: runtimeConfig.environment,
      sync: { organizations: result.sync.organizations, listed: result.sync.listed, registered: result.sync.registered, errors: result.sync.errors.map((e) => e.code) },
      processed: { claimed: result.processed.claimed, results: result.processed.results.map((r) => ({ id: r.inboundId, from: r.from, to: r.to, code: r.code })) },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
