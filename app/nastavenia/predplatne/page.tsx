"use client";

// =============================================================================
// Nastavenia → Predplatné (STAGING). Jedna obrazovka pre web, Android aj iOS.
//
// - Stav sa VŽDY načíta zo servera (GET /api/billing/subscription) — UI nič
//   neudeľuje; nároky vynucuje DB pri každej akcii.
// - Návrat z checkoutu: ?checkout=returned NIE JE dôkaz platby. UI polluje
//   serverový stav checkout zámeru a predplatného, kým webhook nepotvrdí.
// - Platobný kanál podľa platformy (lib/billing/client-model.ts):
//   web → Stripe-hosted Checkout; Android → iba text bez odkazu; iOS → nič.
// - Mimo staging režimu API vracia 404 → stránka ukáže „nedostupné".
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import BackLink from "@/app/components/BackLink";
import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate } from "@/lib/i18n/format";
import { confirmAction } from "@/app/components/ui/AppDialog";
import {
  CHECKOUT_POLL_INTERVAL_MS,
  CHECKOUT_POLL_MAX_ATTEMPTS,
  canStartCheckout,
  hasPaidAccess,
  interpretCheckoutReturn,
  parsePlanOptions,
  parseSubscriptionView,
  purchaseChannel,
  type ClientPlatform,
  type PlanOption,
  type SubscriptionView,
} from "@/lib/billing/client-model";

type LoadState = "loading" | "ready" | "disabled" | "error";
type ReturnBanner = "pending" | "confirmed" | "failed" | "canceled" | "timeout" | null;

const ERROR_KEYS: Record<string, string> = {
  ESBLU_BILLING_FORBIDDEN: "subscription.errors.forbidden",
  ESBLU_BILLING_ALREADY_SUBSCRIBED: "subscription.errors.alreadySubscribed",
  ESBLU_BILLING_ACTIVE_ON_OTHER_PROVIDER: "subscription.errors.otherProvider",
  ESBLU_BILLING_RATE_LIMITED: "subscription.errors.rateLimited",
};

async function authHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` } : null;
}

function detectPlatform(): ClientPlatform {
  if (!IS_MOBILE_BUILD) return "web";
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent) ? "android" : "ios";
}

export default function SubscriptionPage() {
  const { locale, t } = useLocale();
  const [state, setState] = useState<LoadState>("loading");
  const [view, setView] = useState<SubscriptionView | null>(null);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [interval, setInterval_] = useState<"month" | "year">("month");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [banner, setBanner] = useState<ReturnBanner>(null);
  const platform = useMemo(() => detectPlatform(), []);

  const load = useCallback(async (): Promise<SubscriptionView | null> => {
    const headers = await authHeaders();
    if (!headers) {
      setState("error");
      return null;
    }
    try {
      const response = await fetch(apiUrl("/api/billing/subscription"), { headers, cache: "no-store" });
      if (response.status === 404 || response.status === 503) {
        setState("disabled");
        return null;
      }
      const json = (await response.json().catch(() => null)) as { subscription?: unknown; plans?: unknown } | null;
      const parsed = parseSubscriptionView(json?.subscription);
      if (!response.ok || !parsed) {
        setState("error");
        return null;
      }
      setView(parsed);
      setPlans(parsePlanOptions(json?.plans));
      setState("ready");
      return parsed;
    } catch {
      setState("error");
      return null;
    }
  }, []);

  // Návrat z checkoutu: čakáme na serverové potvrdenie (webhook), nie na query.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const checkoutId = params.get("checkout_id");
    const returned = params.get("checkout");

    (async () => {
      await load();
      if (!checkoutId || cancelled) return;
      if (returned === "canceled") {
        setBanner("canceled");
        return;
      }
      setBanner("pending");
      for (let attempt = 0; attempt < CHECKOUT_POLL_MAX_ATTEMPTS && !cancelled; attempt++) {
        const headers = await authHeaders();
        if (!headers) break;
        const response = await fetch(apiUrl(`/api/billing/checkout/${encodeURIComponent(checkoutId)}`), { headers, cache: "no-store" }).catch(() => null);
        const json = response ? ((await response.json().catch(() => null)) as { checkout?: { status?: string } } | null) : null;
        const subscription = await load();
        const outcome = interpretCheckoutReturn({ checkout: returned }, {
          checkoutStatus: json?.checkout?.status ?? null,
          subscription,
        });
        if (outcome === "confirmed" || outcome === "failed") {
          if (!cancelled) setBanner(outcome);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, CHECKOUT_POLL_INTERVAL_MS));
      }
      if (!cancelled) setBanner("timeout");
    })();

    return () => {
      cancelled = true;
    };
  }, [load]);

  async function post(path: string, body: Record<string, unknown>): Promise<{ url?: string } | null> {
    setBusy(true);
    setActionError(null);
    try {
      const headers = await authHeaders();
      if (!headers) throw new Error("auth");
      const response = await fetch(apiUrl(path), { method: "POST", headers, body: JSON.stringify(body) });
      const json = (await response.json().catch(() => null)) as { success?: boolean; url?: string; code?: string } | null;
      if (!response.ok || !json?.success) {
        setActionError(t(ERROR_KEYS[json?.code ?? ""] ?? "subscription.errors.generic"));
        return null;
      }
      return json;
    } catch {
      setActionError(t("subscription.errors.generic"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function startCheckout(planCode: string) {
    const result = await post("/api/billing/checkout", { planCode, interval });
    if (result?.url) window.location.assign(result.url);
  }

  async function manage(action: "cancel" | "resume" | "change" | "portal", planCode?: string) {
    if (action === "cancel" && !(await confirmAction({ message: t("subscription.confirmCancel"), destructive: true }))) return;
    const result = await post("/api/billing/manage", { action, planCode, interval });
    if (action === "portal" && result?.url) {
      window.location.assign(result.url);
      return;
    }
    if (result) await load();
  }

  const fmt = (iso: string | null) => (iso ? formatDate(iso, locale) : "");
  const planName = (code: string | null) => (code ? t(`subscription.plans.${code}`) : t("subscription.noPlan"));
  const moduleName = (key: string) => t(`entitlements.modules.${key}`);
  const limitText = (limit: number | null, period: string | null) =>
    limit === null
      ? t("subscription.unlimited")
      : period === "month"
        ? t("subscription.limitPerMonth", { limit })
        : t("subscription.limitTotal", { limit });

  const channel = view ? purchaseChannel(platform, view) : "none";
  const storeManaged = view?.billingProvider === "apple" || view?.billingProvider === "google";

  return (
    <main className="app-shell-bg min-h-screen p-4 sm:p-6 lg:p-10">
      <BackLink href="/nastavenia" label={t("settings.pageTitle")} className="mb-4" />
      <h1 className="text-2xl sm:text-4xl font-bold text-primary">{t("subscription.title")}</h1>

      <div className="mt-8 max-w-2xl space-y-6">
        <p className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 text-sm text-primary">
          {t("subscription.stagingNotice")}
        </p>

        {state === "loading" && <p className="text-sm text-muted-esblu">{t("subscription.loading")}</p>}
        {state === "disabled" && <p className="text-sm text-muted-esblu">{t("subscription.disabled")}</p>}
        {state === "error" && <p className="text-sm text-red-500">{t("subscription.loadError")}</p>}

        {banner && (
          <p role="status" className="rounded-2xl border border-subtle bg-surface-1 p-4 text-sm text-primary">
            {t(
              {
                pending: "subscription.checkoutPending",
                confirmed: "subscription.checkoutConfirmed",
                failed: "subscription.checkoutFailed",
                canceled: "subscription.checkoutCanceled",
                timeout: "subscription.checkoutTimeout",
              }[banner],
            )}
          </p>
        )}

        {state === "ready" && view && (
          <>
            <section className="rounded-3xl border border-subtle bg-surface-1 p-5 sm:p-8 shadow-lg">
              <h2 className="text-xl font-bold text-primary">{t("subscription.currentPlan")}</h2>
              <p className="mt-2 text-lg text-primary">{planName(view.planCode)}</p>
              <p className="mt-1 text-sm text-muted-esblu">
                {t("subscription.status")}:{" "}
                {t(`subscription.statuses.${view.status}`, { date: fmt(view.graceUntil) })}
              </p>
              {view.canViewDetails && view.billingInterval && (
                <p className="mt-1 text-sm text-muted-esblu">{t(`subscription.interval.${view.billingInterval}`)}</p>
              )}
              {view.canViewDetails && view.billingProvider && (
                <p className="mt-1 text-sm text-muted-esblu">{t(`subscription.provider.${view.billingProvider}`)}</p>
              )}
              {view.canViewDetails && hasPaidAccess(view) && view.currentPeriodEnd && (
                <p className="mt-1 text-sm text-muted-esblu">
                  {view.cancelAtPeriodEnd
                    ? t("subscription.endsOn", { date: fmt(view.currentPeriodEnd) })
                    : t("subscription.renewsOn", { date: fmt(view.currentPeriodEnd) })}
                </p>
              )}
              {!hasPaidAccess(view) && view.trial.endsAt && (
                <p className="mt-1 text-sm text-muted-esblu">
                  {view.trial.active
                    ? t("subscription.trialRemaining", { date: fmt(view.trial.endsAt) })
                    : t("subscription.trialEnded")}
                </p>
              )}

              {view.planEntitlements.length > 0 && (
                <>
                  <h3 className="mt-5 text-sm font-semibold text-primary">{t("subscription.includes")}</h3>
                  <ul className="mt-2 space-y-1 text-sm text-muted-esblu">
                    {view.planEntitlements.map((e) => (
                      <li key={e.key}>
                        {moduleName(e.key)} — {limitText(e.limit, e.limit_period)}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {storeManaged && (
                <p className="mt-4 text-sm text-muted-esblu">
                  {t("subscription.manageInStore", { store: t(`subscription.provider.${view.billingProvider}`) })}
                </p>
              )}

              {channel === "web_checkout" && !storeManaged && hasPaidAccess(view) && (
                <div className="mt-5 flex flex-wrap gap-3">
                  {view.cancelAtPeriodEnd ? (
                    <button type="button" disabled={busy} onClick={() => manage("resume")} className="rounded-xl bg-accent-esblu px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                      {t("subscription.resume")}
                    </button>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => manage("cancel")} className="rounded-xl border border-subtle px-4 py-2 text-sm font-semibold text-primary disabled:opacity-50">
                      {t("subscription.cancel")}
                    </button>
                  )}
                  {view.billingProvider === "stripe" && (
                    <button type="button" disabled={busy} onClick={() => manage("portal")} className="rounded-xl border border-subtle px-4 py-2 text-sm font-semibold text-primary disabled:opacity-50">
                      {t("subscription.portal")}
                    </button>
                  )}
                </div>
              )}
            </section>

            {!view.canManage && <p className="text-sm text-muted-esblu">{t("subscription.readOnly")}</p>}
            {channel === "web_info_text" && <p className="text-sm text-muted-esblu">{t("subscription.manageOnWeb")}</p>}
            {actionError && <p role="alert" className="text-sm text-red-500">{actionError}</p>}

            {channel === "web_checkout" && !storeManaged && plans.length > 0 && (
              <section className="rounded-3xl border border-subtle bg-surface-1 p-5 sm:p-8 shadow-lg">
                <h2 className="text-xl font-bold text-primary">{t("subscription.choosePlan")}</h2>
                <div className="mt-3 flex gap-2">
                  {(["month", "year"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setInterval_(value)}
                      aria-pressed={interval === value}
                      className={`rounded-xl px-3 py-1 text-sm ${interval === value ? "bg-accent-esblu text-white" : "border border-subtle text-primary"}`}
                    >
                      {t(`subscription.interval.${value}`)}
                    </button>
                  ))}
                </div>
                <div className="mt-4 space-y-4">
                  {plans.map((plan) => {
                    const isCurrent = plan.planCode === view.planCode && hasPaidAccess(view);
                    const available = plan.intervals.includes(interval);
                    return (
                      <div key={plan.planCode} className="rounded-2xl border border-subtle p-4">
                        <p className="font-semibold text-primary">{planName(plan.planCode)}</p>
                        <ul className="mt-2 space-y-1 text-sm text-muted-esblu">
                          {plan.entitlements.map((e) => (
                            <li key={e.key}>
                              {moduleName(e.key)} — {limitText(e.limit, e.limit_period)}
                            </li>
                          ))}
                        </ul>
                        {!isCurrent && available && canStartCheckout(view) && (
                          <button type="button" disabled={busy} onClick={() => startCheckout(plan.planCode)} className="mt-3 rounded-xl bg-accent-esblu px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                            {t("subscription.subscribe")}
                          </button>
                        )}
                        {!isCurrent && available && view.canManage && hasPaidAccess(view) && (
                          <button type="button" disabled={busy} onClick={() => manage("change", plan.planCode)} className="mt-3 rounded-xl border border-subtle px-4 py-2 text-sm font-semibold text-primary disabled:opacity-50">
                            {t("subscription.changePlan")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
