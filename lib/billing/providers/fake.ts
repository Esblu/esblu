// =============================================================================
// FAKE billing provider — test double pre staging a testy.
//
// - Rovnaký kontrakt ako Stripe (BillingProvider), rovnaká podpisová schéma
//   (HMAC `t=…,v1=…`) → webhook pipeline sa testuje end-to-end bez Stripe.
// - Žiadne peniaze, žiadne karty, žiadna sieť. Price IDs `fake_price_*` sú
//   iba v test fixtures (environment='test').
// - Stav predplatného drží `FakeStateStore` (testy: pamäť; staging: čítanie
//   z kanonickej DB cez service_role — fake nemá vlastný backend).
// - V produkcii je fake mode tvrdo vypnutý (lib/billing/config.ts).
// =============================================================================

import { randomUUID } from "node:crypto";
import { sha256Hex, signTimestamped, verifyTimestampedSignature } from "@/lib/billing/signature";
import {
  BillingProviderError,
  CANONICAL_STATUSES,
  type BillingProvider,
  type CheckoutRequest,
  type CheckoutSession,
  type NormalizationResult,
  type NormalizedSubscriptionState,
  type ProviderSubscriptionRef,
  type VerifiedProviderEvent,
} from "@/lib/billing/types";

export const FAKE_SIGNATURE_HEADER = "x-esblu-fake-signature";

export interface FakeStateStore {
  get(subscriptionId: string): Promise<NormalizedSubscriptionState | null>;
  put(state: NormalizedSubscriptionState): Promise<void>;
}

export class MemoryFakeStateStore implements FakeStateStore {
  private readonly states = new Map<string, NormalizedSubscriptionState>();
  async get(subscriptionId: string) {
    return this.states.get(subscriptionId) ?? null;
  }
  async put(state: NormalizedSubscriptionState) {
    if (state.provider_subscription_id) this.states.set(state.provider_subscription_id, state);
  }
}

export type FakeEventBody = {
  id: string;
  type: string;
  created: number;
  livemode: false;
  state: NormalizedSubscriptionState;
};

function addInterval(from: Date, interval: "month" | "year"): Date {
  const next = new Date(from.getTime());
  if (interval === "year") next.setUTCFullYear(next.getUTCFullYear() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

export class FakeBillingProvider implements BillingProvider {
  readonly id = "fake" as const;
  readonly environment = "test" as const;

  private readonly secret: string | undefined;
  private readonly store: FakeStateStore;
  private readonly now: () => Date;
  private readonly checkoutBaseUrl: string;

  constructor(
    secret: string | undefined,
    store: FakeStateStore = new MemoryFakeStateStore(),
    now: () => Date = () => new Date(),
    checkoutBaseUrl: string = "/nastavenia/predplatne/fake-checkout",
  ) {
    this.secret = secret;
    this.store = store;
    this.now = now;
    this.checkoutBaseUrl = checkoutBaseUrl;
  }

  private requireSecret(): string {
    const secret = (this.secret ?? "").trim();
    if (secret.length < 16) throw new BillingProviderError("NOT_CONFIGURED");
    return secret;
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    this.requireSecret();
    return {
      providerSessionId: `fake_cs_${request.checkoutId.replace(/-/g, "")}`,
      url: `${this.checkoutBaseUrl}?checkout=${encodeURIComponent(request.checkoutId)}`,
    };
  }

  /** Simuluje dokončenú platbu: vytvorí aktívne predplatné (nie je to webhook — ten treba podpísať zvlášť). */
  async simulateCheckoutPaid(input: { checkoutId: string; providerPriceId: string; interval: "month" | "year"; customerId?: string }): Promise<NormalizedSubscriptionState> {
    const start = this.now();
    const state: NormalizedSubscriptionState = {
      provider_subscription_id: `fake_sub_${input.checkoutId.replace(/-/g, "")}`,
      provider_customer_id: input.customerId ?? `fake_cus_${input.checkoutId.replace(/-/g, "").slice(0, 16)}`,
      provider_price_id: input.providerPriceId,
      status: "active",
      current_period_start: start.toISOString(),
      current_period_end: addInterval(start, input.interval).toISOString(),
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      trial_start: null,
      trial_end: null,
      checkout_ref: input.checkoutId,
      account_token: null,
      state_at: start.toISOString(),
    };
    await this.store.put(state);
    return state;
  }

  private async mutate(ref: ProviderSubscriptionRef, patch: Partial<NormalizedSubscriptionState>): Promise<NormalizedSubscriptionState> {
    const current = await this.store.get(ref.providerSubscriptionId);
    if (!current) throw new BillingProviderError("PROVIDER_ERROR", "fake subscription not found");
    const next: NormalizedSubscriptionState = { ...current, ...patch, checkout_ref: null, state_at: this.now().toISOString() };
    await this.store.put(next);
    return next;
  }

  async getSubscription(ref: ProviderSubscriptionRef) {
    const current = await this.store.get(ref.providerSubscriptionId);
    if (!current) throw new BillingProviderError("PROVIDER_ERROR", "fake subscription not found");
    return { ...current, checkout_ref: null, state_at: this.now().toISOString() };
  }

  cancelSubscription(ref: ProviderSubscriptionRef) {
    return this.mutate(ref, { cancel_at_period_end: true, canceled_at: this.now().toISOString() });
  }

  resumeSubscription(ref: ProviderSubscriptionRef) {
    return this.mutate(ref, { cancel_at_period_end: false, canceled_at: null });
  }

  changePlan(ref: ProviderSubscriptionRef, newProviderPriceId: string) {
    return this.mutate(ref, { provider_price_id: newProviderPriceId, cancel_at_period_end: false, canceled_at: null });
  }

  async createPortalSession(): Promise<{ url: string }> {
    // Fake nemá platobný portál — UI ukáže správu predplatného priamo v Esblu.
    throw new BillingProviderError("UNSUPPORTED_OPERATION", "fake provider has no portal");
  }

  /** Podpíše fake webhook (staging „hosted checkout" a testy). */
  signEvent(body: FakeEventBody, timestampSeconds = Math.floor(this.now().getTime() / 1000)): { rawBody: string; headers: Headers } {
    const rawBody = JSON.stringify(body);
    return { rawBody, headers: new Headers({ [FAKE_SIGNATURE_HEADER]: signTimestamped(rawBody, this.requireSecret(), timestampSeconds) }) };
  }

  buildEvent(type: string, state: NormalizedSubscriptionState, id: string = `fake_evt_${randomUUID().replace(/-/g, "")}`): FakeEventBody {
    return { id, type, created: Math.floor(new Date(state.state_at).getTime() / 1000), livemode: false, state };
  }

  async verifyWebhook(rawBody: string, headers: Headers): Promise<VerifiedProviderEvent> {
    const secret = this.requireSecret();
    const check = verifyTimestampedSignature(headers.get(FAKE_SIGNATURE_HEADER), rawBody, secret, Math.floor(this.now().getTime() / 1000));
    if (check === "stale") throw new BillingProviderError("STALE_SIGNATURE");
    if (check !== "ok") throw new BillingProviderError("INVALID_SIGNATURE");
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new BillingProviderError("MALFORMED_PAYLOAD");
    }
    const event = body as Partial<FakeEventBody> | null;
    if (!event || typeof event.id !== "string" || typeof event.type !== "string" || typeof event.created !== "number" || !event.state) {
      throw new BillingProviderError("MALFORMED_PAYLOAD");
    }
    if (event.livemode !== false) throw new BillingProviderError("LIVE_MODE_FORBIDDEN");
    return {
      provider: "fake",
      environment: "test",
      eventId: event.id,
      eventType: event.type,
      createdAt: new Date(event.created * 1000).toISOString(),
      payloadSha256: sha256Hex(rawBody),
      data: event.state,
    };
  }

  async normalizeEvent(event: VerifiedProviderEvent): Promise<NormalizationResult> {
    const state = event.data as NormalizedSubscriptionState | null;
    if (!state || !(CANONICAL_STATUSES as readonly string[]).includes(state.status)) {
      throw new BillingProviderError("MALFORMED_PAYLOAD");
    }
    if (event.eventType === "fake.audit") return { kind: "ignore", reason: "AUDIT_ONLY" };
    // Fake nemá API na refetch → stav eventu, čas = čas eventu (ochrana poradia v DB).
    return { kind: "state", state: { ...state, state_at: state.state_at ?? event.createdAt } };
  }
}
