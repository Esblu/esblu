// =============================================================================
// Predplatné — čistý klientsky model (bez I/O). UI z neho iba ZOBRAZUJE stav,
// ktorý vrátil server (esblu_get_my_subscription). Nič tu neudeľuje prístup:
// nároky vynucuje DB (esblu_resolve_entitlement) pri každom zápise/akcii.
//
// Platobný adaptér podľa platformy a storefrontu určuje SERVER
// (billing_channel_rules → /api/billing/purchase-options). Klient iba
// zobrazí povolené kanály a spustí ich flow:
//   web      → Stripe-hosted Checkout
//   android  → Google Play Billing; v EEA billing choice (Play alebo Esblu/Stripe v appke)
//   ios      → StoreKit 2 IAP; v EÚ navyše ExternalPurchaseCustomLink → Stripe Checkout
// Stav predplatného je na všetkých platformách ten istý (jedna odpoveď servera).
// =============================================================================

export type ClientPlatform = "web" | "android" | "ios";
export type PurchaseChannel = "web_checkout" | "mobile_purchase" | "none";

export type SubscriptionStatus =
  | "none"
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "paused"
  | "canceled"
  | "expired";

export type PlanEntitlement = { key: string; limit: number | null; limit_period: string | null };

export type SubscriptionView = {
  serverTime: string;
  canManage: boolean;
  canViewDetails: boolean;
  planCode: string | null;
  status: SubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  planEntitlements: PlanEntitlement[];
  trial: { endsAt: string | null; active: boolean };
  billingInterval: "month" | "year" | null;
  billingProvider: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  version: number | null;
};

export type PlanOption = { planCode: string; intervals: ("month" | "year")[]; entitlements: PlanEntitlement[] };

const STATUSES: readonly SubscriptionStatus[] = ["none", "incomplete", "trialing", "active", "past_due", "unpaid", "paused", "canceled", "expired"];
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown) => (typeof v === "string" && v ? v : null);

function parseEntitlements(value: unknown): PlanEntitlement[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObj).map((e) => ({
    key: String(e.key ?? ""),
    limit: typeof e.limit === "number" ? e.limit : null,
    limit_period: strOrNull(e.limit_period),
  })).filter((e) => e.key);
}

/** Fail closed: neplatná odpoveď → null (UI ukáže chybu, nie „aktívne"). */
export function parseSubscriptionView(data: unknown): SubscriptionView | null {
  if (!isObj(data)) return null;
  const status = STATUSES.includes(data.status as SubscriptionStatus) ? (data.status as SubscriptionStatus) : null;
  if (!status) return null;
  const trial = isObj(data.trial) ? data.trial : {};
  const interval = data.billing_interval === "month" || data.billing_interval === "year" ? data.billing_interval : null;
  return {
    serverTime: String(data.server_time ?? ""),
    canManage: data.can_manage === true,
    canViewDetails: data.can_view_details === true,
    planCode: strOrNull(data.plan_code),
    status,
    cancelAtPeriodEnd: data.cancel_at_period_end === true,
    planEntitlements: parseEntitlements(data.plan_entitlements),
    trial: { endsAt: strOrNull(trial.ends_at), active: trial.active === true },
    billingInterval: interval,
    billingProvider: strOrNull(data.billing_provider),
    currentPeriodEnd: strOrNull(data.current_period_end),
    graceUntil: strOrNull(data.grace_until),
    version: typeof data.version === "number" ? data.version : null,
  };
}

export function parsePlanOptions(data: unknown): PlanOption[] {
  if (!isObj(data) || !Array.isArray(data.plans)) return [];
  return data.plans.filter(isObj).map((p) => ({
    planCode: String(p.plan_code ?? ""),
    intervals: (Array.isArray(p.intervals) ? p.intervals : []).filter((i): i is "month" | "year" => i === "month" || i === "year"),
    entitlements: parseEntitlements(p.entitlements),
  })).filter((p) => p.planCode && p.intervals.length > 0);
}

export function purchaseChannel(platform: ClientPlatform, view: Pick<SubscriptionView, "canManage">): PurchaseChannel {
  if (!view.canManage) return "none";
  return platform === "web" ? "web_checkout" : "mobile_purchase";
}

// ----------------------------------------------------------------------------- nákupné kanály
export type PurchaseMethod =
  | "stripe_web_checkout"
  | "apple_iap"
  | "apple_eu_link_checkout"
  | "apple_eu_in_app_checkout"
  | "apple_us_link"
  | "google_play"
  | "google_choice_developer";

const METHODS: readonly PurchaseMethod[] = [
  "stripe_web_checkout", "apple_iap", "apple_eu_link_checkout", "apple_eu_in_app_checkout", "apple_us_link", "google_play", "google_choice_developer",
];

export type MethodPlan = {
  planCode: string;
  intervals: { interval: "month" | "year"; storeProductId: string | null }[];
  entitlements: PlanEntitlement[];
};

export type PurchaseOptionMethod = { method: PurchaseMethod; provider: string; reporting: string; plans: MethodPlan[] };
export type PurchaseOptions = { platform: ClientPlatform; storefront: string | null; canManage: boolean; methods: PurchaseOptionMethod[]; viewOnly: boolean };

export function parsePurchaseOptions(data: unknown): PurchaseOptions | null {
  if (!isObj(data)) return null;
  const platform = data.platform === "web" || data.platform === "android" || data.platform === "ios" ? data.platform : null;
  if (!platform) return null;
  const methods = (Array.isArray(data.methods) ? data.methods : []).filter(isObj).flatMap((m): PurchaseOptionMethod[] => {
    if (!METHODS.includes(m.method as PurchaseMethod)) return [];
    const plans = (Array.isArray(m.plans) ? m.plans : []).filter(isObj).map((p) => ({
      planCode: String(p.plan_code ?? ""),
      intervals: (Array.isArray(p.intervals) ? p.intervals : []).filter(isObj).flatMap((i) =>
        i.interval === "month" || i.interval === "year" ? [{ interval: i.interval as "month" | "year", storeProductId: strOrNull(i.store_product_id) }] : []),
      entitlements: parseEntitlements(p.entitlements),
    })).filter((p) => p.planCode && p.intervals.length > 0);
    return [{ method: m.method as PurchaseMethod, provider: String(m.provider ?? ""), reporting: String(m.reporting ?? "none"), plans }];
  });
  return { platform, storefront: strOrNull(data.storefront), canManage: data.can_manage === true, methods, viewOnly: methods.length === 0 };
}

/**
 * Tlačidlá pre UI. Android: Play + billing choice = JEDNO tlačidlo (Google
 * choice screen ponúkne Play aj Esblu billing). iOS EÚ: IAP a Stripe odkaz
 * ako dve rovnocenné voľby (IAP rovnako výrazné — Apple Attachment 14).
 */
export type PurchaseAction =
  | { kind: "web_checkout"; method: "stripe_web_checkout" }
  | { kind: "apple_iap"; method: "apple_iap" }
  | { kind: "apple_external"; method: "apple_eu_link_checkout" | "apple_eu_in_app_checkout" | "apple_us_link"; notice: "browser" | "withinApp" | null }
  | { kind: "google"; method: "google_play"; billingChoice: boolean };

export function purchaseActions(options: PurchaseOptions): PurchaseAction[] {
  const has = (m: PurchaseMethod) => options.methods.some((x) => x.method === m);
  const actions: PurchaseAction[] = [];
  if (has("stripe_web_checkout")) actions.push({ kind: "web_checkout", method: "stripe_web_checkout" });
  if (has("google_play")) actions.push({ kind: "google", method: "google_play", billingChoice: has("google_choice_developer") });
  if (has("apple_iap")) actions.push({ kind: "apple_iap", method: "apple_iap" });
  if (has("apple_eu_link_checkout")) actions.push({ kind: "apple_external", method: "apple_eu_link_checkout", notice: "browser" });
  if (has("apple_eu_in_app_checkout")) actions.push({ kind: "apple_external", method: "apple_eu_in_app_checkout", notice: "withinApp" });
  if (has("apple_us_link")) actions.push({ kind: "apple_external", method: "apple_us_link", notice: null });
  return actions;
}

/** Plány pre daný kanál a interval (product ID obchodu, ak ide o Apple/Google). */
export function plansFor(options: PurchaseOptions, method: PurchaseMethod, interval: "month" | "year"): { planCode: string; storeProductId: string | null; entitlements: PlanEntitlement[] }[] {
  const m = options.methods.find((x) => x.method === method);
  if (!m) return [];
  return m.plans.flatMap((p) => {
    const i = p.intervals.find((x) => x.interval === interval);
    return i ? [{ planCode: p.planCode, storeProductId: i.storeProductId, entitlements: p.entitlements }] : [];
  });
}

/** Má firma platený prístup z predplatného? (iba na zobrazenie — autoritou je DB). */
export function hasPaidAccess(view: Pick<SubscriptionView, "status">): boolean {
  return view.status === "active" || view.status === "trialing" || view.status === "past_due";
}

/** Je povolený nový checkout? (DB to aj tak overí — ESBLU_BILLING_ALREADY_SUBSCRIBED). */
export function canStartCheckout(view: Pick<SubscriptionView, "status" | "canManage">): boolean {
  return view.canManage && (view.status === "none" || view.status === "canceled" || view.status === "expired");
}

export type CheckoutReturnState = "confirmed" | "pending" | "failed" | "unknown";

/**
 * Návrat z checkoutu. Query parameter (?checkout=success) NIE JE dôkaz platby —
 * rozhoduje iba serverový stav checkout zámeru + kanonické predplatné.
 */
export function interpretCheckoutReturn(
  _query: { checkout?: string | null },
  server: { checkoutStatus: string | null; subscription: Pick<SubscriptionView, "status"> | null },
): CheckoutReturnState {
  if (server.checkoutStatus === "rejected" || server.checkoutStatus === "expired") return "failed";
  if (server.checkoutStatus === "completed" && server.subscription && hasPaidAccess(server.subscription)) return "confirmed";
  if (server.checkoutStatus === "created" || server.checkoutStatus === "open" || server.checkoutStatus === "completed") return "pending";
  return "unknown";
}

export const CHECKOUT_POLL_INTERVAL_MS = 2000;
export const CHECKOUT_POLL_MAX_ATTEMPTS = 30;
