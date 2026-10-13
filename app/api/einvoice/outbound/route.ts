import "server-only";

import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { getEinvoiceProvider } from "@/lib/einvoice/provider";
import { handleOutboundSendRequest } from "@/lib/einvoice/outbound/route-handler";
import { createSupabaseOutboundStore } from "@/lib/einvoice/outbound/supabase-store";

// =============================================================================
// POST /api/einvoice/outbound — požiadavka „odoslať ako e-faktúru".
//
// Telo: { "invoice_id": "<uuid>", "confirm_send": true } — NIČ iné. company_id,
// prostredie, rola, participant ID ani kľúče sa z klienta neprijímajú (iné
// polia = 400). Identita z overeného Bearer JWT; firma, oprávnenie, nárok a
// dáta pod RLS volajúceho; prostredie a poskytovateľ iba zo serverového env.
//
// Route NIČ NEODOSIELA: po readiness + overení príjemcu + preflighte vznikne
// pokus `queued` (alebo sa vráti existujúci). Odosiela worker.
// Odpoveď: { code, outbound?: {id, state}, readiness?, issues? } — strojové
// kódy, bez tajomstiev a bez surovej odpovede poskytovateľa.
// =============================================================================

export const runtime = "nodejs";

export async function POST(req: Request) {
  const locale = getRequestLocale(req);
  const result = await handleOutboundSendRequest(req, {
    authenticate: async (request) => {
      const { user, error } = await verifyRequestUser(request, locale);
      return error || !user ? null : { userId: user.id };
    },
    userDbFor: getUserScopedSupabaseClient,
    store: createSupabaseOutboundStore,
    runtime: () => {
      try {
        return getEinvoiceProvider();
      } catch {
        return null;
      }
    },
  });
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "private, no-store" } });
}
