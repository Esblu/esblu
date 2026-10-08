// =============================================================================
// Predplatné — čistý klientsky model (bez I/O). UI z neho iba ZOBRAZUJE stav,
// ktorý vrátil server (esblu_get_my_subscription). Nič tu neudeľuje prístup:
// nároky vynucuje DB (esblu_resolve_entitlement) pri každom zápise/akcii.
//
// Platobný adaptér podľa platformy (docs/subscriptions-store-compliance-2026-10-08.md):
//   web     → Stripe-hosted Checkout (test mode na stagingu)
//   android → bez nákupu v appke (Google Play „consumption-only"); povolený
//             je iba text bez odkazu, že plán sa mení na webe
//   ios     → bez nákupu a bez výzvy na nákup mimo appky (App Review 3.1.1/3.1.3)
// Stav predplatného je na všetkých platformách ten istý (jedna odpoveď servera).
// =============================================================================

export type ClientPlatform = "web" | "android" | "ios";
export type PurchaseChannel = "web_checkout" | "web_info_text" | "none";

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
  if (platform === "ios") return "none";
  if (platform === "android") return view.canManage ? "web_info_text" : "none";
  return view.canManage ? "web_checkout" : "none";
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
