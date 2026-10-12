// =============================================================================
// Billing — serverové pomocné funkcie pre app/api/billing/** (SERVER ONLY).
// Volajúci sa overí Bearer tokenom; rola/firma/plán/price sa určujú v DB.
// service_role sa používa iba na: attach checkout session, pipeline eventov,
// čítanie fake stavu na stagingu.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { getBillingServerMode, webProviderForMode } from "@/lib/billing/config";
import { getStoreMode } from "@/lib/billing/stores/store-config";
import { FakeBillingProvider, type FakeStateStore } from "@/lib/billing/providers/fake";
import { StripeTestProvider } from "@/lib/billing/providers/stripe";
import type { BillingProvider, NormalizedSubscriptionState } from "@/lib/billing/types";

export const BILLING_ERROR_STATUS: Record<string, number> = {
  NOT_AUTHENTICATED: 401,
  ESBLU_NO_ACTIVE_COMPANY: 403,
  ESBLU_BILLING_FORBIDDEN: 403,
  ESBLU_BILLING_DISABLED: 503,
  ESBLU_BILLING_PLAN_NOT_PURCHASABLE: 400,
  ESBLU_BILLING_PRICE_NOT_CONFIGURED: 400,
  ESBLU_BILLING_INTERVAL_INVALID: 400,
  ESBLU_BILLING_ALREADY_SUBSCRIBED: 409,
  ESBLU_BILLING_ACTIVE_ON_OTHER_PROVIDER: 409,
  ESBLU_BILLING_RATE_LIMITED: 429,
  ESBLU_BILLING_CHECKOUT_STATE: 409,
  ESBLU_BILLING_PLATFORM_INVALID: 400,
  ESBLU_BILLING_METHOD_NOT_ALLOWED: 403,
  ESBLU_BILLING_STORE_TOKEN_REQUIRED: 400,
  ESBLU_BILLING_CHANGE_NOT_ALLOWED: 409,
  ESBLU_BILLING_MODE_INVALID: 400,
};

export function billingErrorCode(error: { message?: string } | null | undefined): string {
  const message = error?.message ?? "";
  return Object.keys(BILLING_ERROR_STATUS).find((code) => message.includes(code)) ?? "BILLING_ERROR";
}

/** Chyba → HTTP odpoveď so stabilným kódom (bez detailov DB/providera). */
export function billingErrorResponse(error: { message?: string } | null | undefined): Response {
  const code = billingErrorCode(error);
  return Response.json({ success: false, code }, { status: BILLING_ERROR_STATUS[code] ?? 500 });
}

export async function authorizeBillingCaller(req: Request): Promise<{ userId: string; db: SupabaseClient } | { response: Response }> {
  if (getBillingServerMode() === "off" && getStoreMode() === "off") {
    return { response: Response.json({ success: false, code: "ESBLU_BILLING_DISABLED" }, { status: 404 }) };
  }
  const { user, error } = await verifyRequestUser(req, getRequestLocale(req));
  if (error || !user) return { response: Response.json({ success: false, code: "NOT_AUTHENTICATED" }, { status: 401 }) };
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return { userId: user.id, db: getUserScopedSupabaseClient(token) };
}

/** Fake stav na stagingu = kanonický riadok v DB (fake nemá vlastný backend). */
class DbBackedFakeStore implements FakeStateStore {
  async get(subscriptionId: string): Promise<NormalizedSubscriptionState | null> {
    const { data } = await getSupabaseAdmin()
      .from("subscription_accounts")
      .select("provider_subscription_id, provider_customer_id, plan_code, billing_interval, status, current_period_start, current_period_end, cancel_at_period_end, canceled_at, ended_at")
      .eq("billing_provider", "fake")
      .eq("provider_subscription_id", subscriptionId)
      .maybeSingle();
    if (!data) return null;
    const { data: price } = await getSupabaseAdmin().rpc("esblu_billing_resolve_price", {
      p_provider: "fake",
      p_environment: "test",
      p_plan_code: data.plan_code,
      p_interval: data.billing_interval,
    });
    return {
      provider_subscription_id: data.provider_subscription_id,
      provider_customer_id: data.provider_customer_id,
      provider_price_id: typeof price === "string" ? price : null,
      status: data.status,
      current_period_start: data.current_period_start,
      current_period_end: data.current_period_end,
      cancel_at_period_end: data.cancel_at_period_end,
      canceled_at: data.canceled_at,
      ended_at: data.ended_at,
      trial_start: null,
      trial_end: null,
      checkout_ref: null,
      account_token: null,
      state_at: new Date().toISOString(),
    };
  }
  async put(): Promise<void> {
    // Stav sa ukladá výhradne cez esblu_billing_apply_event.
  }
}

/** Webový provider podľa režimu servera. `provider` z DB musí súhlasiť. */
export function getWebBillingProvider(expected?: string | null): BillingProvider | null {
  const mode = getBillingServerMode();
  const id = webProviderForMode(mode);
  if (!id || (expected && expected !== id)) return null;
  if (id === "stripe") {
    return new StripeTestProvider({
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      apiVersion: process.env.STRIPE_API_VERSION || undefined,
    });
  }
  return new FakeBillingProvider(process.env.ESBLU_FAKE_BILLING_SECRET, new DbBackedFakeStore());
}

export function getFakeProviderForStaging(): FakeBillingProvider | null {
  if (getBillingServerMode() !== "fake") return null;
  return new FakeBillingProvider(process.env.ESBLU_FAKE_BILLING_SECRET, new DbBackedFakeStore());
}
