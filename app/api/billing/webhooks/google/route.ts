import { processWebhook } from "@/lib/billing/pipeline";
import { GooglePlayProvider } from "@/lib/billing/providers/stores";
import { verifyGoogleOidcToken } from "@/lib/billing/stores/jwt";
import { getGooglePlayApi, getStoreMode } from "@/lib/billing/stores/store-config";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// -----------------------------------------------------------------------------
// POST /api/billing/webhooks/google — Real-time developer notifications
// (Pub/Sub push s autentifikáciou). OIDC bearer: RS256 (Google JWKS), iss,
// aud = GOOGLE_RTDN_AUDIENCE, email = GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL.
// Stav sa vždy načíta cez purchases.subscriptionsv2.get (RTDN je iba signál).
// -----------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function verifyPushToken(bearer: string) {
  const audience = process.env.GOOGLE_RTDN_AUDIENCE;
  const email = process.env.GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL;
  if (!audience || !email) throw new Error("not configured");
  const jwks = await fetch("https://www.googleapis.com/oauth2/v3/certs", { cache: "no-store" }).then((r) => r.json());
  verifyGoogleOidcToken(bearer, { audience, email, jwks });
}

export async function POST(req: Request) {
  const mode = getStoreMode();
  const api = getGooglePlayApi();
  if (mode === "off" || !api) return new Response(null, { status: 404 });
  const rawBody = await req.text();
  if (rawBody.length > 64 * 1024) return new Response(null, { status: 413 });
  const provider = new GooglePlayProvider({
    api,
    packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME ?? "com.esblu.app",
    // fake mode: Pub/Sub neexistuje → RTDN sa simuluje iba v testoch (verifyPushToken null = NOT_CONFIGURED).
    verifyPushToken: mode === "sandbox" ? verifyPushToken : null,
  });
  const result = await processWebhook(provider, rawBody, req.headers, getSupabaseAdmin());
  return Response.json({ received: result.httpStatus < 300, outcome: result.outcome }, { status: result.httpStatus });
}
