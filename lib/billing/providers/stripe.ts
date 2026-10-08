// =============================================================================
// Stripe adapter — IBA TEST MODE / SANDBOX.
//
// - Kľúč musí začínať `sk_test_` alebo `rk_test_`; `*_live_*` → LIVE_MODE_FORBIDDEN
//   (tvrdá poistka v kóde, nie iba konfigurácia). Event s `livemode: true` sa odmietne.
// - Stripe-hosted Checkout (mode=subscription): Esblu nikdy nevidí PAN/CVC
//   (PCI SAQ A). Apple Pay / Google Pay ponúka hosted Checkout sám podľa
//   nastavení platobných metód v Stripe Dashboarde (bez registrácie domény).
// - Bez závislosti na `stripe` npm balíku: priamy REST (form-encoded) +
//   vlastné overenie podpisu (lib/billing/signature.ts) podľa docs.stripe.com/webhooks.
// - Normalizácia vždy znova načíta predplatné z API (Stripe negarantuje
//   poradie eventov) → do DB ide čerstvý stav s časom načítania (state_at).
// - Nikdy sa neukladá celý payload — iba normalizovaný stav.
// =============================================================================

import { sha256Hex, verifyTimestampedSignature } from "@/lib/billing/signature";
import {
  BillingProviderError,
  type BillingProvider,
  type CanonicalStatus,
  type CheckoutRequest,
  type CheckoutSession,
  type NormalizationResult,
  type NormalizedSubscriptionState,
  type ProviderSubscriptionRef,
  type VerifiedProviderEvent,
} from "@/lib/billing/types";

const STRIPE_API = "https://api.stripe.com/v1";

/** Eventy, ktoré menia kanonický stav (overené v docs.stripe.com/billing/subscriptions/webhooks). */
export const STRIPE_STATE_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
]);

/** Iba audit — žiadna automatická zmena nároku (rozhoduje operátor). */
export const STRIPE_AUDIT_EVENTS = new Set([
  "charge.refunded",
  "charge.dispute.created",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "customer.subscription.trial_will_end",
]);

export function assertStripeTestKey(secretKey: string | undefined): string {
  const key = (secretKey ?? "").trim();
  if (/^(sk|rk)_live_/.test(key)) throw new BillingProviderError("LIVE_MODE_FORBIDDEN");
  if (!/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(key)) throw new BillingProviderError("NOT_CONFIGURED");
  return key;
}

export function mapStripeStatus(status: unknown): CanonicalStatus | null {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
    case "paused":
    case "canceled":
    case "incomplete":
      return status;
    case "incomplete_expired":
      return "expired";
    default:
      return null;
  }
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const idOf = (value: unknown): string | null => str(value) ?? (isObj(value) ? str(value.id) : null);
const isoFromUnix = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;

/**
 * Stripe Subscription objekt → kanonický stav. Podporuje staré (period na
 * subscription) aj nové API verzie (period na subscription item).
 */
export function normalizeStripeSubscription(sub: unknown, stateAt: string, checkoutRef: string | null = null): NormalizedSubscriptionState {
  if (!isObj(sub) || sub.object !== "subscription") throw new BillingProviderError("MALFORMED_PAYLOAD");
  const status = mapStripeStatus(sub.status);
  if (!status) throw new BillingProviderError("MALFORMED_PAYLOAD", "unknown subscription status");
  const items = isObj(sub.items) && Array.isArray(sub.items.data) ? (sub.items.data as unknown[]) : [];
  // Jeden plán = jedna položka. Viac položiek → price null → DB odmietne (UNKNOWN_PRICE).
  const item = items.length === 1 && isObj(items[0]) ? (items[0] as Obj) : null;
  const priceId = item && isObj(item.price) ? str(item.price.id) : null;
  const periodStart = isoFromUnix(item?.current_period_start ?? sub.current_period_start);
  const periodEnd = isoFromUnix(item?.current_period_end ?? sub.current_period_end);
  const cancelAt = typeof sub.cancel_at === "number" ? sub.cancel_at : null;
  const periodEndUnix = typeof (item?.current_period_end ?? sub.current_period_end) === "number"
    ? Number(item?.current_period_end ?? sub.current_period_end)
    : null;
  const metadata = isObj(sub.metadata) ? sub.metadata : {};
  return {
    provider_subscription_id: str(sub.id),
    provider_customer_id: idOf(sub.customer),
    provider_price_id: priceId,
    status,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    cancel_at_period_end:
      sub.cancel_at_period_end === true || (cancelAt !== null && periodEndUnix !== null && cancelAt <= periodEndUnix),
    canceled_at: isoFromUnix(sub.canceled_at),
    ended_at: isoFromUnix(sub.ended_at),
    trial_start: isoFromUnix(sub.trial_start),
    trial_end: isoFromUnix(sub.trial_end),
    checkout_ref: checkoutRef ?? str(metadata.esblu_checkout_id),
    account_token: null,
    state_at: stateAt,
  };
}

/** Z eventu zistí ID predplatného, ktoré treba znova načítať. */
export function stripeSubscriptionIdFromEvent(eventType: string, object: unknown): { subscriptionId: string | null; checkoutRef: string | null } {
  if (!isObj(object)) return { subscriptionId: null, checkoutRef: null };
  if (eventType.startsWith("checkout.session.")) {
    if (object.mode !== "subscription") return { subscriptionId: null, checkoutRef: null };
    return { subscriptionId: idOf(object.subscription), checkoutRef: str(object.client_reference_id) };
  }
  if (eventType.startsWith("customer.subscription.")) return { subscriptionId: str(object.id), checkoutRef: null };
  if (eventType.startsWith("invoice.")) {
    const parent = isObj(object.parent) ? object.parent : null;
    const details = parent && isObj(parent.subscription_details) ? parent.subscription_details : null;
    return { subscriptionId: idOf(details?.subscription) ?? idOf(object.subscription), checkoutRef: null };
  }
  return { subscriptionId: null, checkoutRef: null };
}

function formEncode(params: Record<string, string | number | boolean | null | undefined>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    body.append(key, String(value));
  }
  return body.toString();
}

export type StripeTestProviderOptions = {
  secretKey: string | undefined;
  webhookSecret: string | undefined;
  apiVersion?: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export class StripeTestProvider implements BillingProvider {
  readonly id = "stripe" as const;
  readonly environment = "test" as const;
  private readonly options: StripeTestProviderOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: StripeTestProviderOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private async request(method: "GET" | "POST", path: string, params?: Record<string, string | number | boolean | null | undefined>, idempotencyKey?: string): Promise<Obj> {
    const key = assertStripeTestKey(this.options.secretKey);
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (this.options.apiVersion) headers["Stripe-Version"] = this.options.apiVersion;
    let url = `${STRIPE_API}${path}`;
    let body: string | undefined;
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      body = formEncode(params ?? {});
    } else if (params) {
      url += `?${formEncode(params)}`;
    }
    const response = await this.fetchImpl(url, { method, headers, body, cache: "no-store" });
    const json = (await response.json().catch(() => null)) as unknown;
    if (!response.ok || !isObj(json)) {
      // Nikdy neprepúšťame text chyby Stripe ďalej (môže obsahovať identifikátory).
      throw new BillingProviderError("PROVIDER_ERROR", `stripe ${method} ${path.split("/")[1]} ${response.status}`);
    }
    if (json.livemode === true) throw new BillingProviderError("LIVE_MODE_FORBIDDEN");
    return json;
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const session = await this.request(
      "POST",
      "/checkout/sessions",
      {
        mode: "subscription",
        "line_items[0][price]": request.providerPriceId,
        "line_items[0][quantity]": 1,
        client_reference_id: request.checkoutId,
        "metadata[esblu_checkout_id]": request.checkoutId,
        "subscription_data[metadata][esblu_checkout_id]": request.checkoutId,
        customer: request.providerCustomerId,
        "customer_update[name]": request.providerCustomerId ? "auto" : null,
        "customer_update[address]": request.providerCustomerId ? "auto" : null,
        billing_address_collection: "required",
        "tax_id_collection[enabled]": true,
        locale: "sk",
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
      },
      `esblu-checkout-${request.checkoutId}`,
    );
    const id = str(session.id);
    const url = str(session.url);
    if (!id || !url) throw new BillingProviderError("PROVIDER_ERROR", "checkout session without url");
    return { providerSessionId: id, url };
  }

  async getSubscription(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState> {
    const sub = await this.request("GET", `/subscriptions/${encodeURIComponent(ref.providerSubscriptionId)}`);
    return normalizeStripeSubscription(sub, this.now().toISOString());
  }

  async cancelSubscription(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState> {
    const sub = await this.request("POST", `/subscriptions/${encodeURIComponent(ref.providerSubscriptionId)}`, { cancel_at_period_end: true });
    return normalizeStripeSubscription(sub, this.now().toISOString());
  }

  async resumeSubscription(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState> {
    const sub = await this.request("POST", `/subscriptions/${encodeURIComponent(ref.providerSubscriptionId)}`, { cancel_at_period_end: false });
    return normalizeStripeSubscription(sub, this.now().toISOString());
  }

  async changePlan(ref: ProviderSubscriptionRef, newProviderPriceId: string): Promise<NormalizedSubscriptionState> {
    const current = await this.request("GET", `/subscriptions/${encodeURIComponent(ref.providerSubscriptionId)}`);
    const items = isObj(current.items) && Array.isArray(current.items.data) ? (current.items.data as unknown[]) : [];
    const itemId = items.length === 1 && isObj(items[0]) ? str((items[0] as Obj).id) : null;
    if (!itemId) throw new BillingProviderError("UNSUPPORTED_OPERATION", "subscription must have exactly one item");
    const sub = await this.request("POST", `/subscriptions/${encodeURIComponent(ref.providerSubscriptionId)}`, {
      "items[0][id]": itemId,
      "items[0][price]": newProviderPriceId,
      proration_behavior: "create_prorations",
      cancel_at_period_end: false,
    });
    return normalizeStripeSubscription(sub, this.now().toISOString());
  }

  async createPortalSession(providerCustomerId: string, returnUrl: string): Promise<{ url: string }> {
    const session = await this.request("POST", "/billing_portal/sessions", { customer: providerCustomerId, return_url: returnUrl, locale: "sk" });
    const url = str(session.url);
    if (!url) throw new BillingProviderError("PROVIDER_ERROR", "portal session without url");
    return { url };
  }

  async verifyWebhook(rawBody: string, headers: Headers): Promise<VerifiedProviderEvent> {
    const secret = (this.options.webhookSecret ?? "").trim();
    if (!/^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(secret)) throw new BillingProviderError("NOT_CONFIGURED");
    const check = verifyTimestampedSignature(headers.get("stripe-signature"), rawBody, secret, Math.floor(this.now().getTime() / 1000));
    if (check === "stale") throw new BillingProviderError("STALE_SIGNATURE");
    if (check !== "ok") throw new BillingProviderError("INVALID_SIGNATURE");
    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new BillingProviderError("MALFORMED_PAYLOAD");
    }
    if (!isObj(event) || event.object !== "event" || !str(event.id) || !str(event.type) || typeof event.created !== "number") {
      throw new BillingProviderError("MALFORMED_PAYLOAD");
    }
    if (event.livemode !== false) throw new BillingProviderError("LIVE_MODE_FORBIDDEN");
    const data = isObj(event.data) ? event.data.object : null;
    return {
      provider: "stripe",
      environment: "test",
      eventId: str(event.id)!,
      eventType: str(event.type)!,
      createdAt: new Date((event.created as number) * 1000).toISOString(),
      payloadSha256: sha256Hex(rawBody),
      data,
    };
  }

  async normalizeEvent(event: VerifiedProviderEvent): Promise<NormalizationResult> {
    if (STRIPE_AUDIT_EVENTS.has(event.eventType)) return { kind: "ignore", reason: "AUDIT_ONLY" };
    if (!STRIPE_STATE_EVENTS.has(event.eventType)) return { kind: "ignore", reason: "UNSUPPORTED_EVENT" };
    const { subscriptionId, checkoutRef } = stripeSubscriptionIdFromEvent(event.eventType, event.data);
    if (!subscriptionId) return { kind: "ignore", reason: "NO_SUBSCRIPTION" };
    // Čerstvý stav z API (nie snapshot z eventu) — ochrana pred nesprávnym poradím.
    const sub = await this.request("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    return { kind: "state", state: normalizeStripeSubscription(sub, this.now().toISOString(), checkoutRef) };
  }
}
