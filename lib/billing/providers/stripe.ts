// =============================================================================
// Stripe adapter — TEST (sandbox) a LIVE, prísne oddelené (S15, 2026-11-19).
//
// - Prostredie inštancie je pevné (`environment` = "test" | "live"), nikdy sa neodvodzuje z kľúča.
// - test: kľúč `sk_test_` / `rk_test_` / `rkcs_test_`; live kľúč → LIVE_MODE_FORBIDDEN; objekt alebo
//   udalosť s `livemode: true` → LIVE_MODE_FORBIDDEN.
// - live: kľúč `sk_live_` / `rk_live_`; test kľúč → TEST_MODE_FORBIDDEN; objekt alebo udalosť
//   s `livemode: false` → TEST_MODE_FORBIDDEN. Kedy sa live inštancia smie vytvoriť, rozhoduje
//   lib/billing/config.ts (iba VERCEL_ENV=production + výslovné schválenie).
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
import { resolveStripeApiVersion } from "@/lib/billing/stripe-api-version";
import {
  BillingProviderError,
  type BillingDocumentCapture,
  type BillingDocumentRecord,
  type BillingProvider,
  type CanonicalStatus,
  type CheckoutExpireResult,
  type CheckoutRequest,
  type CheckoutSession,
  type BillingEnvironment,
  type NormalizationResult,
  type NormalizedCharge,
  type NormalizedSubscriptionState,
  type ProviderSubscriptionRef,
  type VerifiedProviderEvent,
} from "@/lib/billing/types";

import { STRIPE_STATUS_MAP } from "@/lib/billing/canonical-state";

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

/**
 * P4: udalosti, z ktorých Esblu ukladá účtovnú kópiu dokladu (billing_invoice_documents).
 * `invoice.paid` je zároveň stavová udalosť; ostatné nemenia nárok (normalizácia → DOCUMENT_ONLY).
 */
export const STRIPE_DOCUMENT_EVENTS = new Set([
  "invoice.finalized",
  "invoice.paid",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "credit_note.created",
  "credit_note.updated",
  "credit_note.voided",
]);

/**
 * S12: typy udalostí, ktoré doťahovanie zmeškaných webhookov číta z `GET /v1/events`
 * (stav predplatného, platby, refundácie, spory, P4: doklady). Rovnaká množina ako odoberá webhook.
 * Stripe `types[]` prijme najviac 20 typov.
 */
export const STRIPE_CATCHUP_EVENT_TYPES = [
  ...new Set([
    ...STRIPE_STATE_EVENTS,
    "charge.refunded",
    "charge.dispute.created",
    "charge.dispute.closed",
    ...STRIPE_DOCUMENT_EVENTS,
  ]),
] as readonly string[];

/** Iba audit — žiadna automatická zmena nároku (rozhoduje operátor). */
export const STRIPE_AUDIT_EVENTS = new Set([
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "customer.subscription.trial_will_end",
]);

/**
 * invoice.paid → platba pre reporting obchodom (Google External Transactions /
 * Apple External Purchase). Sumy v centoch; daň = total − total_excluding_tax.
 */
export function stripeChargeFromInvoice(invoice: unknown): NormalizedCharge | null {
  if (!isObj(invoice) || invoice.object !== "invoice" || !str(invoice.id)) return null;
  const total = typeof invoice.total === "number" ? invoice.total : null;
  const excl = typeof invoice.total_excluding_tax === "number" ? invoice.total_excluding_tax : null;
  const transitions = isObj(invoice.status_transitions) ? invoice.status_transitions : {};
  const address = isObj(invoice.customer_address) ? invoice.customer_address : {};
  const country = str(address.country);
  return {
    id: str(invoice.id)!,
    kind: "purchase",
    amount_pre_tax_minor: excl ?? total,
    tax_minor: total !== null && excl !== null ? total - excl : null,
    currency: str(invoice.currency)?.toUpperCase() ?? null,
    at: isoFromUnix(transitions.paid_at) ?? isoFromUnix(invoice.created) ?? new Date().toISOString(),
    tax_country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
  };
}

/**
 * Prefixy Stripe kľúčov: `sk_` (secret), `rk_` (restricted), `rkcs_` (restricted kľúč
 * claimable sandboxu zo `stripe sandboxes create`). Povolený je IBA test mode.
 */
export const STRIPE_TEST_KEY_RE = /^(sk|rk|rkcs)_test_[A-Za-z0-9]{8,}$/;
/** Akýkoľvek live prefix (aj neplatný tvar) — na odmietnutie v test prostredí. */
export const STRIPE_LIVE_KEY_RE = /^(sk|rk|rkcs)_live_/;
/** Platný live kľúč (claimable sandbox `rkcs_` je vždy test). */
export const STRIPE_LIVE_KEY_FULL_RE = /^(sk|rk)_live_[A-Za-z0-9]{8,}$/;

export function assertStripeTestKey(secretKey: string | undefined): string {
  const key = (secretKey ?? "").trim();
  if (STRIPE_LIVE_KEY_RE.test(key)) throw new BillingProviderError("LIVE_MODE_FORBIDDEN");
  if (!STRIPE_TEST_KEY_RE.test(key)) throw new BillingProviderError("NOT_CONFIGURED");
  return key;
}

/** S15: kľúč musí presne zodpovedať prostrediu inštancie (fail closed). */
export function assertStripeKeyFor(environment: BillingEnvironment, secretKey: string | undefined): string {
  if (environment === "test") return assertStripeTestKey(secretKey);
  const key = (secretKey ?? "").trim();
  if (/^(sk|rk|rkcs)_test_/.test(key)) throw new BillingProviderError("TEST_MODE_FORBIDDEN");
  if (!STRIPE_LIVE_KEY_FULL_RE.test(key)) throw new BillingProviderError("NOT_CONFIGURED");
  return key;
}

/** S15: `livemode` objektu / udalosti musí zodpovedať prostrediu (chýbajúci = nekontroluje sa, napr. zoznam). */
export function assertStripeLivemode(environment: BillingEnvironment, livemode: unknown, required = false): void {
  if (livemode === undefined && !required) return;
  if (environment === "test" && livemode !== false) throw new BillingProviderError("LIVE_MODE_FORBIDDEN");
  if (environment === "live" && livemode !== true) throw new BillingProviderError("TEST_MODE_FORBIDDEN");
}

export function mapStripeStatus(status: unknown): CanonicalStatus | null {
  // Jediná mapa: lib/billing/canonical-state.ts (incomplete → pending, unpaid → account_hold).
  if (typeof status !== "string" || !Object.prototype.hasOwnProperty.call(STRIPE_STATUS_MAP, status)) return null;
  const mapped = STRIPE_STATUS_MAP[status];
  return mapped === "none" ? null : (mapped as CanonicalStatus);
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
    // S13: `cancel_at` BEZ príznaku cancel_at_period_end=true = ukončenie k zvolenému dátumu (bez 48 h).
    // Rozhoduje iba príznak Stripe, nie porovnanie s koncom obdobia: ak by Stripe pri `cancel_at`
    // skrátil current_period_end na tento dátum, porovnanie by predčasný koniec vydávalo za riadny
    // a Esblu by omylom pridalo 48 h. Riadne zrušenie ku koncu obdobia (Esblu „Zrušiť“, portál) nesie
    // cancel_at_period_end=true (overené na skutočnom Stripe 18. 11., test E3) → null.
    scheduled_end_at: cancelAt !== null && sub.cancel_at_period_end !== true ? isoFromUnix(cancelAt) : null,
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

/** ISO koniec platnosti zámeru → Stripe `expires_at` (unix s); neplatné/žiadne → bez parametra. */
export function stripeExpiresAt(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Obdobie služby faktúry = obdobie riadku predplatného (invoice.period_* je pri predplatnom posunuté). */
export function stripeInvoiceServicePeriod(invoice: unknown): { start: string | null; end: string | null } {
  if (!isObj(invoice)) return { start: null, end: null };
  const lines = isObj(invoice.lines) && Array.isArray(invoice.lines.data) ? (invoice.lines.data as unknown[]) : [];
  const line = lines.find((l) => isObj(l) && isObj(l.period)) as Obj | undefined;
  const p = line && isObj(line.period) ? line.period : null;
  return { start: isoFromUnix(p?.start), end: isoFromUnix(p?.end) };
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null);
const country = (value: unknown): string | null => {
  const c = str(value);
  return c && /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : null;
};

/** Iba primitívne polia (orezané) — daňové riadky „tak, ako prišli“, bez vnorených objektov zákazníka. */
function primitiveFields(value: unknown, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isObj(value)) return out;
  for (const [k, v] of Object.entries(value).slice(0, 20)) {
    if (!/^[a-z_]{1,40}$/.test(k)) continue;
    if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 80);
    else if (depth === 0 && isObj(v)) out[k] = primitiveFields(v, 1);
  }
  return out;
}

function taxRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.slice(0, 20).map((row) => primitiveFields(row)) : [];
}

function taxIds(value: unknown): Array<{ type: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObj)
    .slice(0, 5)
    .map((t) => ({ type: (str(t.type) ?? "unknown").slice(0, 20), value: (str(t.value) ?? "").slice(0, 64) }))
    .filter((t) => t.value.length > 0);
}

function taxTotal(total: number | null, excl: number | null, rows: Array<Record<string, unknown>>): number | null {
  if (total !== null && excl !== null) return total - excl;
  if (rows.length === 0) return null;
  return rows.reduce((sum, r) => sum + (typeof r.amount === "number" ? r.amount : 0), 0);
}

/** P4: Stripe Invoice → účtovná kópia (bez mena / e-mailu / adresy odberateľa). */
export function stripeInvoiceDocument(invoice: unknown): BillingDocumentRecord | null {
  if (!isObj(invoice) || invoice.object !== "invoice" || !str(invoice.id)) return null;
  const transitions = isObj(invoice.status_transitions) ? invoice.status_transitions : {};
  const address = isObj(invoice.customer_address) ? invoice.customer_address : {};
  const rows = taxRows(invoice.total_taxes ?? invoice.total_tax_amounts);
  const total = num(invoice.total);
  const excl = num(invoice.total_excluding_tax);
  const period = stripeInvoiceServicePeriod(invoice);
  return {
    kind: "invoice",
    provider_document_id: str(invoice.id)!,
    related_invoice_id: null,
    provider_customer_id: idOf(invoice.customer),
    provider_subscription_id: stripeSubscriptionIdFromEvent("invoice.paid", invoice).subscriptionId,
    payment_intent_id: idOf(invoice.payment_intent),
    document_number: str(invoice.number)?.slice(0, 64) ?? null,
    status: str(invoice.status),
    currency: str(invoice.currency)?.toUpperCase() ?? null,
    subtotal_minor: num(invoice.subtotal),
    subtotal_excl_tax_minor: num(invoice.subtotal_excluding_tax),
    total_minor: total,
    total_excl_tax_minor: excl,
    tax_minor: taxTotal(total, excl, rows),
    amount_paid_minor: num(invoice.amount_paid),
    customer_country: country(address.country),
    customer_tax_exempt: str(invoice.customer_tax_exempt),
    customer_tax_ids: taxIds(invoice.customer_tax_ids),
    tax_details: rows,
    service_period_start: period.start,
    service_period_end: period.end,
    issued_at: isoFromUnix(transitions.finalized_at) ?? (str(invoice.number) ? isoFromUnix(invoice.created) : null),
    paid_at: isoFromUnix(transitions.paid_at),
    voided_at: isoFromUnix(transitions.voided_at),
    hosted_url: str(invoice.hosted_invoice_url),
    pdf_url: str(invoice.invoice_pdf),
    credit_reason: null,
    credit_type: null,
  };
}

/** P4: Stripe Credit Note → účtovná kópia opravného dokladu (väzba na pôvodnú faktúru). */
export function stripeCreditNoteDocument(note: unknown): BillingDocumentRecord | null {
  if (!isObj(note) || note.object !== "credit_note" || !str(note.id)) return null;
  const rows = taxRows(note.total_taxes ?? note.tax_amounts);
  const total = num(note.total);
  const excl = num(note.total_excluding_tax);
  return {
    kind: "credit_note",
    provider_document_id: str(note.id)!,
    related_invoice_id: idOf(note.invoice),
    provider_customer_id: idOf(note.customer),
    provider_subscription_id: null,
    payment_intent_id: null,
    document_number: str(note.number)?.slice(0, 64) ?? null,
    status: str(note.status),
    currency: str(note.currency)?.toUpperCase() ?? null,
    subtotal_minor: num(note.subtotal),
    subtotal_excl_tax_minor: num(note.subtotal_excluding_tax),
    total_minor: total,
    total_excl_tax_minor: excl,
    tax_minor: taxTotal(total, excl, rows),
    amount_paid_minor: null,
    customer_country: null,
    customer_tax_exempt: null,
    customer_tax_ids: [],
    tax_details: rows,
    service_period_start: null,
    service_period_end: null,
    issued_at: isoFromUnix(note.effective_at) ?? isoFromUnix(note.created),
    paid_at: null,
    voided_at: isoFromUnix(note.voided_at),
    hosted_url: null,
    pdf_url: str(note.pdf),
    credit_reason: str(note.reason),
    credit_type: str(note.type),
  };
}

function stripeCheckoutStatus(status: unknown): CheckoutExpireResult {
  return status === "complete" ? "complete" : status === "expired" ? "expired" : "open";
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
  /** Override pripnutej verzie (lib/billing/stripe-api-version.ts) — iba overená verzia, inak NOT_CONFIGURED. */
  apiVersion?: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export class StripeProvider implements BillingProvider {
  readonly id = "stripe" as const;
  readonly environment: BillingEnvironment;
  /** P4: verzia posielaná v KAŽDOM requeste (`Stripe-Version`); null = neoverený override → fail closed. */
  readonly apiVersion: string | null;
  private readonly options: StripeTestProviderOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(environment: BillingEnvironment, options: StripeTestProviderOptions) {
    if (environment !== "test" && environment !== "live") throw new BillingProviderError("NOT_CONFIGURED");
    this.environment = environment;
    this.apiVersion = resolveStripeApiVersion(options.apiVersion);
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private async request(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, string | number | boolean | null | undefined>, idempotencyKey?: string): Promise<Obj> {
    const key = assertStripeKeyFor(this.environment, this.options.secretKey);
    if (!this.apiVersion) throw new BillingProviderError("NOT_CONFIGURED", "stripe api version not validated");
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Stripe-Version": this.apiVersion };
    let url = `${STRIPE_API}${path}`;
    let body: string | undefined;
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      body = formEncode(params ?? {});
    } else if (params && Object.keys(params).length > 0) {
      url += `?${formEncode(params)}`;
    }
    let response = await this.fetchImpl(url, { method, headers, body, cache: "no-store" });
    // Súbežná požiadavka s tým istým Idempotency-Key (dve karty prehliadača) → Stripe 409
    // `idempotency_key_in_use`. Počkať a zopakovať: dostaneme odpoveď prvej požiadavky.
    for (let attempt = 1; response.status === 409 && idempotencyKey && attempt <= 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      response = await this.fetchImpl(url, { method, headers, body, cache: "no-store" });
    }
    const json = (await response.json().catch(() => null)) as unknown;
    if (!response.ok || !isObj(json)) {
      // Nikdy neprepúšťame text chyby Stripe ďalej (môže obsahovať identifikátory).
      throw new BillingProviderError("PROVIDER_ERROR", `stripe ${method} ${path.split("/")[1]} ${response.status}`);
    }
    assertStripeLivemode(this.environment, json.livemode);
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
        // Checkout otvorený z appky (in-app browser / Safari) — docs.stripe.com/mobile/digital-goods/checkout
        origin_context: request.mobileApp ? "mobile_app" : null,
        // Relácia platí presne tak dlho ako zámer v DB (min. 30 min podľa Stripe).
        expires_at: stripeExpiresAt(request.expiresAt),
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

  /**
   * Zrušenie rozpracovanej platby: POST /v1/checkout/sessions/{id}/expire. Ak Stripe
   * expiráciu odmietne (už dokončená / už expirovaná), rozhodne aktuálny stav relácie.
   */
  async expireCheckout(providerSessionId: string): Promise<CheckoutExpireResult> {
    const path = `/checkout/sessions/${encodeURIComponent(providerSessionId)}`;
    try {
      const session = await this.request("POST", `${path}/expire`, {}, `esblu-expire-${providerSessionId}`);
      return stripeCheckoutStatus(session.status);
    } catch (error) {
      if (error instanceof BillingProviderError && (error.code === "LIVE_MODE_FORBIDDEN" || error.code === "TEST_MODE_FORBIDDEN")) throw error;
      const session = await this.request("GET", path);
      return stripeCheckoutStatus(session.status);
    }
  }

  async getSubscription(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState> {
    const sub = await this.request("GET", `/subscriptions/${encodeURIComponent(ref.providerSubscriptionId)}`);
    return normalizeStripeSubscription(sub, this.now().toISOString());
  }

  async cancelSubscription(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState> {
    const sub = await this.request("POST", `/subscriptions/${encodeURIComponent(ref.providerSubscriptionId)}`, { cancel_at_period_end: true });
    return normalizeStripeSubscription(sub, this.now().toISOString());
  }

  /**
   * Okamžité ukončenie (DELETE /v1/subscriptions/{id}, bez faktúry a bez prorácie). Ak je už
   * ukončené, Stripe vráti chybu → rozhodne aktuálny stav z API (idempotentné).
   */
  async cancelSubscriptionNow(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState> {
    const path = `/subscriptions/${encodeURIComponent(ref.providerSubscriptionId)}`;
    try {
      const sub = await this.request("DELETE", path, { invoice_now: false, prorate: false });
      return normalizeStripeSubscription(sub, this.now().toISOString());
    } catch (error) {
      if (error instanceof BillingProviderError && (error.code === "LIVE_MODE_FORBIDDEN" || error.code === "TEST_MODE_FORBIDDEN")) throw error;
      const sub = await this.request("GET", path);
      const state = normalizeStripeSubscription(sub, this.now().toISOString());
      if (state.status !== "canceled" && state.status !== "expired") throw error;
      return state;
    }
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

  /** S12: identifikátor Stripe účtu, ku ktorému patrí kľúč (kontrola, že doťahujeme zo SPRÁVNEHO účtu). */
  async accountRef(): Promise<string> {
    const account = await this.request("GET", "/account");
    const id = str(account.id);
    if (!id || !/^acct_[A-Za-z0-9]+$/.test(id)) throw new BillingProviderError("PROVIDER_ERROR", "account id missing");
    return id;
  }

  /**
   * S12: jedna stránka udalostí (Stripe vracia od najnovšej). `endingBefore` = udalosti NOVŠIE ako
   * kurzor (stránka bezprostredne pred ním), `startingAfter` + `createdGte` = bootstrap odzadu.
   * Chýbajúci kurzor (udalosť staršia ako retencia Stripe) → `cursor_missing`.
   */
  async listEvents(params: { endingBefore?: string; startingAfter?: string; createdGte?: number; limit?: number }): Promise<{ events: Obj[]; hasMore: boolean } | "cursor_missing"> {
    const query: Record<string, string | number> = { limit: Math.min(Math.max(params.limit ?? 100, 1), 100) };
    STRIPE_CATCHUP_EVENT_TYPES.forEach((type, i) => { query[`types[${i}]`] = type; });
    if (params.endingBefore) query.ending_before = params.endingBefore;
    if (params.startingAfter) query.starting_after = params.startingAfter;
    if (params.createdGte !== undefined) query["created[gte]"] = params.createdGte;
    let page: Obj;
    try {
      page = await this.request("GET", "/events", query);
    } catch (error) {
      if (params.endingBefore && error instanceof BillingProviderError && / (400|404)$/.test(error.message)) return "cursor_missing";
      throw error;
    }
    const events = Array.isArray(page.data) ? (page.data.filter(isObj) as Obj[]) : [];
    return { events, hasMore: page.has_more === true };
  }

  /** S12: udalosť načítaná z API (autentická — kľúčom overený kanál) → rovnaký tvar ako po overení podpisu. */
  eventFromApi(event: Obj): VerifiedProviderEvent {
    if (event.object !== "event" || !str(event.id) || !str(event.type) || typeof event.created !== "number") {
      throw new BillingProviderError("MALFORMED_PAYLOAD");
    }
    assertStripeLivemode(this.environment, event.livemode, true);
    return {
      provider: "stripe",
      environment: this.environment,
      eventId: str(event.id)!,
      eventType: str(event.type)!,
      createdAt: new Date((event.created as number) * 1000).toISOString(),
      // P4 (nález § 2.3): bez hashu. Serializácia z API sa od tela webhooku vždy líši; s hashom by
      // DB udalosť, ktorá vo webhooku zlyhala, označila ako `payload_mismatch` a nikdy ju nezopakovala.
      payloadSha256: null,
      apiVersion: str(event.api_version),
      data: isObj(event.data) ? event.data.object : null,
    };
  }

  /**
   * P4: jedna udalosť podľa ID (retry zlyhanej udalosti, ktorej telo Esblu neukladá). `null` = udalosť
   * u Stripe už neexistuje (mimo 30-dňovej retencie) → volajúci ju presunie do dead-letter.
   */
  async fetchEvent(eventId: string): Promise<Obj | null> {
    if (!/^evt_[A-Za-z0-9]+$/.test(eventId)) return null;
    try {
      return await this.request("GET", `/events/${encodeURIComponent(eventId)}`);
    } catch (error) {
      if (error instanceof BillingProviderError && / 404$/.test(error.message)) return null;
      throw error;
    }
  }

  /** P4 reporting: stránka balance transactions (hrubá suma, poplatok, čistá suma, zdroj). */
  async listBalanceTransactions(params: { createdGte?: number; createdLt?: number; payout?: string; startingAfter?: string; limit?: number }): Promise<{ data: Obj[]; hasMore: boolean }> {
    const query: Record<string, string | number> = { limit: Math.min(Math.max(params.limit ?? 100, 1), 100), "expand[0]": "data.source" };
    if (params.createdGte !== undefined) query["created[gte]"] = params.createdGte;
    if (params.createdLt !== undefined) query["created[lt]"] = params.createdLt;
    if (params.payout) query.payout = params.payout;
    if (params.startingAfter) query.starting_after = params.startingAfter;
    const page = await this.request("GET", "/balance_transactions", query);
    return { data: Array.isArray(page.data) ? (page.data.filter(isObj) as Obj[]) : [], hasMore: page.has_more === true };
  }

  /** P4 reporting: stránka výplat (payouts) podľa dátumu vytvorenia. */
  async listPayouts(params: { createdGte?: number; createdLt?: number; startingAfter?: string; limit?: number }): Promise<{ data: Obj[]; hasMore: boolean }> {
    const query: Record<string, string | number> = { limit: Math.min(Math.max(params.limit ?? 100, 1), 100) };
    if (params.createdGte !== undefined) query["created[gte]"] = params.createdGte;
    if (params.createdLt !== undefined) query["created[lt]"] = params.createdLt;
    if (params.startingAfter) query.starting_after = params.startingAfter;
    const page = await this.request("GET", "/payouts", query);
    return { data: Array.isArray(page.data) ? (page.data.filter(isObj) as Obj[]) : [], hasMore: page.has_more === true };
  }

  /**
   * P4: účtovná kópia dokladu z udalosti. Faktúra / dobropis z `event.data` (finalizovaný doklad je
   * u Stripe nemenný; stav sa v DB posúva iba dopredu). Pri `invoice.paid` sa doplní PaymentIntent
   * (od API 2025-03-31 nie je na faktúre) cez `/v1/invoice_payments` — väzba na balance transactions.
   * `charge.refunded` → pozorovanie refundácie (kontrola, že vznikol dobropis).
   */
  async captureDocuments(event: VerifiedProviderEvent): Promise<BillingDocumentCapture | null> {
    if (event.eventType === "charge.refunded") {
      const charge = event.data;
      if (!isObj(charge) || charge.object !== "charge") return null;
      const pi = idOf(charge.payment_intent);
      const refunded = typeof charge.amount_refunded === "number" ? charge.amount_refunded : null;
      if (!pi || refunded === null || refunded <= 0) return null;
      return { documents: [], refunds: [{ payment_intent_id: pi, amount_refunded_minor: refunded, currency: str(charge.currency)?.toUpperCase() ?? null, observed_at: event.createdAt }] };
    }
    if (!STRIPE_DOCUMENT_EVENTS.has(event.eventType)) return null;
    const object = event.data;
    if (isObj(object) && object.object === "invoice") {
      const doc = stripeInvoiceDocument(object);
      if (!doc) return null;
      if (!doc.payment_intent_id && doc.status === "paid" && doc.provider_document_id) {
        const payments = await this.request("GET", "/invoice_payments", { invoice: doc.provider_document_id, limit: 3 });
        const list = Array.isArray(payments.data) ? (payments.data.filter(isObj) as Obj[]) : [];
        const paid = list.find((p) => p.status === "paid") ?? list[0];
        const payment = paid && isObj(paid.payment) ? paid.payment : null;
        doc.payment_intent_id = payment ? idOf(payment.payment_intent) : null;
      }
      return { documents: [doc], refunds: [] };
    }
    if (isObj(object) && object.object === "credit_note") {
      const doc = stripeCreditNoteDocument(object);
      return doc ? { documents: [doc], refunds: [] } : null;
    }
    return null;
  }

  /**
   * S12: autoritatívny stav pre reconciliation VRÁTANE platby aktuálneho obdobia. Predplatné ostáva u
   * Stripe `active` aj po plnej refundácii či prehratom spore — bez tejto kontroly by úplne chýbajúci
   * webhook `charge.refunded` / `charge.dispute.closed` ostal neodhalený (prístup aj účtovanie by bežali).
   *   plná refundácia platby aktuálnej faktúry → `refunded` + ukončiť u providera
   *   prehraný spor platby aktuálnej faktúry    → `revoked`  + ukončiť u providera
   */
  async getReconcileState(ref: ProviderSubscriptionRef): Promise<NormalizedSubscriptionState & { providerOpen: boolean; followUp?: "cancel_provider_now" }> {
    const sub = await this.request("GET", `/subscriptions/${encodeURIComponent(ref.providerSubscriptionId)}`);
    const stateAt = this.now().toISOString();
    const state = normalizeStripeSubscription(sub, stateAt);
    const providerOpen = !["canceled", "expired"].includes(state.status);
    const invoiceId = idOf(sub.latest_invoice);
    if (!invoiceId) return { ...state, providerOpen };
    const payments = await this.request("GET", "/invoice_payments", { invoice: invoiceId, limit: 3 });
    const list = Array.isArray(payments.data) ? (payments.data.filter(isObj) as Obj[]) : [];
    for (const p of list) {
      const payment = isObj(p.payment) ? p.payment : null;
      const pi = payment ? idOf(payment.payment_intent) : null;
      if (!pi) continue;
      const intent = await this.request("GET", `/payment_intents/${encodeURIComponent(pi)}`, { "expand[0]": "latest_charge" });
      const charge = isObj(intent.latest_charge) ? intent.latest_charge : null;
      if (!charge) continue;
      const amount = typeof charge.amount === "number" ? charge.amount : null;
      const refunded = typeof charge.amount_refunded === "number" ? charge.amount_refunded : 0;
      if (charge.refunded === true || (amount !== null && amount > 0 && refunded >= amount)) {
        return { ...state, status: "refunded", ended_at: stateAt, review_flag: null, providerOpen, followUp: "cancel_provider_now" };
      }
      if (charge.disputed === true && str(charge.id)) {
        const disputes = await this.request("GET", "/disputes", { charge: str(charge.id)!, limit: 1 });
        const dispute = Array.isArray(disputes.data) && isObj(disputes.data[0]) ? (disputes.data[0] as Obj) : null;
        if (dispute && dispute.status === "lost") {
          return { ...state, status: "revoked", ended_at: stateAt, review_flag: null, providerOpen, followUp: "cancel_provider_now" };
        }
      }
    }
    return { ...state, providerOpen };
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
    assertStripeLivemode(this.environment, event.livemode, true);
    const data = isObj(event.data) ? event.data.object : null;
    return {
      provider: "stripe",
      environment: this.environment,
      eventId: str(event.id)!,
      eventType: str(event.type)!,
      createdAt: new Date((event.created as number) * 1000).toISOString(),
      payloadSha256: sha256Hex(rawBody),
      apiVersion: str(event.api_version),
      data,
    };
  }

  async normalizeEvent(event: VerifiedProviderEvent): Promise<NormalizationResult> {
    if (STRIPE_AUDIT_EVENTS.has(event.eventType)) return { kind: "ignore", reason: "AUDIT_ONLY" };
    if (event.eventType === "charge.refunded") return this.normalizeRefund(event);
    if (event.eventType === "charge.dispute.created" || event.eventType === "charge.dispute.closed") return this.normalizeDispute(event);
    if (!STRIPE_STATE_EVENTS.has(event.eventType)) {
      // P4: doklad bez vplyvu na nárok (zápis dokladu robí pipeline cez captureDocuments).
      return { kind: "ignore", reason: STRIPE_DOCUMENT_EVENTS.has(event.eventType) ? "DOCUMENT_ONLY" : "UNSUPPORTED_EVENT" };
    }
    const { subscriptionId, checkoutRef } = stripeSubscriptionIdFromEvent(event.eventType, event.data);
    if (!subscriptionId) return { kind: "ignore", reason: "NO_SUBSCRIPTION" };
    // Čerstvý stav z API (nie snapshot z eventu) — ochrana pred nesprávnym poradím.
    const sub = await this.request("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const state = normalizeStripeSubscription(sub, this.now().toISOString(), checkoutRef);
    if (event.eventType === "invoice.paid") state.charge = stripeChargeFromInvoice(event.data);
    return { kind: "state", state };
  }

  /**
   * Refund → reporting obchodu (iba pre predplatné z kanálov s reportingom).
   * Od API 2025-03-31 charge nemá `invoice`; cesta: payment_intent →
   * invoice_payments → invoice → subscription. Ak sa nedá určiť → audit
   * (REFUND_NEEDS_OPERATOR) — operátor nahlási ručne.
   */
  /** charge → (payment_intent → invoice_payments →) invoice → subscription. */
  private async subscriptionIdForCharge(charge: Obj): Promise<{ subscriptionId: string | null; invoiceId: string | null; invoice?: Obj }> {
    let invoiceId = idOf(charge.invoice);
    const paymentIntent = idOf(charge.payment_intent);
    if (!invoiceId && paymentIntent) {
      const payments = await this.request("GET", "/invoice_payments", {
        "payment[type]": "payment_intent",
        "payment[payment_intent]": paymentIntent,
        limit: 1,
      }).catch(() => null);
      const first = payments && Array.isArray(payments.data) && isObj(payments.data[0]) ? (payments.data[0] as Obj) : null;
      invoiceId = first ? idOf(first.invoice) : null;
    }
    if (!invoiceId) return { subscriptionId: null, invoiceId: null };
    const invoice = await this.request("GET", `/invoices/${encodeURIComponent(invoiceId)}`);
    return { subscriptionId: stripeSubscriptionIdFromEvent("invoice.paid", invoice).subscriptionId, invoiceId, invoice };
  }

  /**
   * Refund. Od API 2025-03-31 charge nemá `invoice`; cesta: payment_intent →
   * invoice_payments → invoice → subscription. Ak sa nedá určiť → audit
   * (REFUND_NEEDS_OPERATOR).
   *  - ÚPLNÝ refund → kanonický stav `refunded` (nároky okamžite odvolané,
   *    dáta ostávajú) + refund charge pre reporting obchodu.
   *  - ČIASTOČNÝ refund → iba charge (reporting) bez zmeny nároku; operátor.
   * Politika „úplný refund = koniec prístupu" je PRODUKTOVÉ/CLIA rozhodnutie
   * (docs/subscriptions-production-readiness-2026-10-11.md).
   */
  private async normalizeRefund(event: VerifiedProviderEvent): Promise<NormalizationResult> {
    const charge = event.data;
    if (!isObj(charge) || charge.object !== "charge") return { kind: "ignore", reason: "AUDIT_ONLY" };
    const { subscriptionId, invoiceId, invoice } = await this.subscriptionIdForCharge(charge);
    if (!subscriptionId) return { kind: "ignore", reason: "REFUND_NEEDS_OPERATOR" };
    const period = stripeInvoiceServicePeriod(invoice);
    const refunded = typeof charge.amount_refunded === "number" ? charge.amount_refunded : null;
    const amount = typeof charge.amount === "number" ? charge.amount : null;
    const refundCharge: NormalizedCharge = {
      id: `refund_${str(charge.id) ?? event.eventId}_${refunded ?? 0}`,
      kind: "refund",
      amount_pre_tax_minor: refunded,
      tax_minor: null,
      currency: str(charge.currency)?.toUpperCase() ?? null,
      at: event.createdAt,
      tax_country: null,
      refunded_charge_id: invoiceId,
      invoice_period_start: period.start,
      invoice_period_end: period.end,
      refund_scope: "partial",
    };
    const full = charge.refunded === true || (refunded !== null && amount !== null && refunded >= amount);
    if (!full) return { kind: "charge", providerSubscriptionId: subscriptionId, charge: refundCharge };
    const sub = await this.request("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    // Plná refundácia STARŠEJ faktúry (nie aktuálneho obdobia) = iba účtovný záznam; aktuálne
    // obdobie je zaplatené, prístup ostáva. Aktuálne obdobie = posledná faktúra predplatného.
    if (invoiceId && idOf(sub.latest_invoice) !== invoiceId) {
      return { kind: "charge", providerSubscriptionId: subscriptionId, charge: { ...refundCharge, refund_scope: "older_invoice" } };
    }
    const state = normalizeStripeSubscription(sub, this.now().toISOString()); // čas načítania = ochrana poradia
    return {
      kind: "state",
      state: { ...state, status: "refunded", ended_at: event.createdAt, review_flag: null, charge: { ...refundCharge, refund_scope: "current_period" } },
      // Prístup končí → predplatné u Stripe ukončiť hneď, aby sa ďalej neúčtovalo.
      followUp: "cancel_provider_now",
    };
  }

  /**
   * Chargeback: dispute.created → príznak `dispute_open` (prístup sa NEMENÍ —
   * rozhoduje výsledok); dispute.closed: lost → `revoked`, won → príznak zmazaný.
   */
  private async normalizeDispute(event: VerifiedProviderEvent): Promise<NormalizationResult> {
    const dispute = event.data;
    if (!isObj(dispute) || dispute.object !== "dispute") return { kind: "ignore", reason: "AUDIT_ONLY" };
    const chargeId = idOf(dispute.charge);
    if (!chargeId) return { kind: "ignore", reason: "DISPUTE_NEEDS_OPERATOR" };
    const charge = await this.request("GET", `/charges/${encodeURIComponent(chargeId)}`);
    const { subscriptionId } = await this.subscriptionIdForCharge(charge);
    if (!subscriptionId) return { kind: "ignore", reason: "DISPUTE_NEEDS_OPERATOR" };
    const sub = await this.request("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const state = normalizeStripeSubscription(sub, this.now().toISOString()); // čas načítania = ochrana poradia
    if (event.eventType === "charge.dispute.created") return { kind: "state", state: { ...state, review_flag: "dispute_open" } };
    if (dispute.status === "lost") return { kind: "state", state: { ...state, status: "revoked", ended_at: event.createdAt, review_flag: null }, followUp: "cancel_provider_now" };
    if (dispute.status === "won") return { kind: "state", state: { ...state, review_flag: null } };
    return { kind: "ignore", reason: "DISPUTE_PENDING" };
  }
}

/** Test (sandbox) provider — zachovaný názov pre existujúci kód a testy. */
export class StripeTestProvider extends StripeProvider {
  constructor(options: StripeTestProviderOptions) {
    super("test", options);
  }
}

/** S15: live provider — vytvára ho IBA lib/billing/server.ts v schválenom produkčnom režime. */
export class StripeLiveProvider extends StripeProvider {
  constructor(options: StripeTestProviderOptions) {
    super("live", options);
  }
}
