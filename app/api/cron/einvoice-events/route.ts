import "server-only";

import { timingSafeEqual } from "node:crypto";
import { getEfakturaWebhookSecrets, getEinvoiceProvider } from "@/lib/einvoice/provider";
import { EfakturaSkProvider } from "@/lib/einvoice/provider/efaktura-sk";
import { runPartnerFeedSync } from "@/lib/einvoice/inbound/feed";
import { createSupabaseEventCursorStore, createSupabaseInboundStore } from "@/lib/einvoice/inbound/supabase-store";
import { createSupabaseOutboundStore } from "@/lib/einvoice/outbound/supabase-store";

// =============================================================================
// GET /api/cron/einvoice-events — partnerský feed udalostí s kurzorom v DB.
//
// Chránené CRON_SECRET. Fallback k webhookom: tie isté udalosti, to isté
// spracovanie (firma IBA z mapovania org), idempotentné. Kurzor (provider,
// environment) sa posúva iba za spracované udalosti; súbežný beh = LOCKED.
// Plánovanie vo vercel.json sa ZATIAĽ nepridáva (rovnako ako ostatné E-Faktúra crony).
// Odpoveď: iba kurzor, počty a strojové kódy.
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
  if (!runtimeConfig || !(runtimeConfig.provider instanceof EfakturaSkProvider)) return Response.json({ success: true, configured: false });
  const provider = runtimeConfig.provider;

  const result = await runPartnerFeedSync(
    {
      cursor: createSupabaseEventCursorStore(),
      listEvents: (input) => provider.listPartnerEvents(input),
      webhook: {
        inbound: createSupabaseInboundStore(),
        outbound: createSupabaseOutboundStore(),
        provider,
        environment: runtimeConfig.environment,
        secrets: getEfakturaWebhookSecrets(),
        nowSeconds: () => Math.floor(Date.now() / 1000),
      },
    },
    { maxPages: 5, pageSize: 100, leaseSeconds: 120 }
  );
  return Response.json({ success: true, configured: true, environment: runtimeConfig.environment, ...result }, { headers: { "Cache-Control": "no-store" } });
}
