import { processWebhook } from "@/lib/billing/pipeline";
import { AppleAppStoreProvider } from "@/lib/billing/providers/stores";
import { appleBundleId, getAppleVerifier, getStoreMode } from "@/lib/billing/stores/store-config";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/billing/webhooks/apple — App Store Server Notifications V2
// (Sandbox URL v App Store Connect). signedPayload → JWS reťaz k Apple rootu
// → notificationUUID dedupe → normalizácia → kanonický stav → nároky.
// EXTERNAL_PURCHASE_TOKEN (UNREPORTED / ACTIVE_TOKEN_REMINDER) → audit.
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (getStoreMode() === "off") return new Response(null, { status: 404 });
  const rawBody = await req.text();
  if (rawBody.length > 256 * 1024) return new Response(null, { status: 413 });
  const provider = new AppleAppStoreProvider(getAppleVerifier(), appleBundleId());
  const result = await processWebhook(provider, rawBody, req.headers, getSupabaseAdmin());
  return Response.json({ received: result.httpStatus < 300, outcome: result.outcome }, { status: result.httpStatus });
}
