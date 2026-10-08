"use client";

// =============================================================================
// Nastavenia → Predplatné (STAGING). JEDNA obrazovka pre web, Android aj iOS:
//   Predplatné → plán → mesačne/ročne → Kúpiť / Zmeniť plán → platobný flow
//   → serverové potvrdenie → aktívne všade.
//
// - Kanály nákupu určuje server (GET /api/billing/purchase-options podľa
//   platformy a storefrontu obchodu); UI ich iba zobrazí.
// - Výsledok platby NIKDY neurčuje klient:
//     Stripe (web / Apple EÚ odkaz / Google billing choice) → webhook → polling
//     StoreKit / Play → /api/billing/mobile/confirm (server overí u obchodu) → polling
//   ?checkout=returned ani výsledok natívneho dialógu nie sú dôkaz platby.
// - Nároky vynucuje DB pri každej akcii; táto stránka nič neudeľuje.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BackLink from "@/app/components/BackLink";
import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate } from "@/lib/i18n/format";
import { confirmAction } from "@/app/components/ui/AppDialog";
import type { NativeBillingBridge } from "@/lib/billing/native-bridge";
import {
  CHECKOUT_POLL_INTERVAL_MS,
  CHECKOUT_POLL_MAX_ATTEMPTS,
  canStartCheckout,
  hasPaidAccess,
  interpretCheckoutReturn,
  parsePurchaseOptions,
  parseSubscriptionView,
  plansFor,
  purchaseActions,
  type ClientPlatform,
  type PurchaseAction,
  type PurchaseOptions,
  type SubscriptionView,
} from "@/lib/billing/client-model";

type LoadState = "loading" | "ready" | "disabled" | "error";
type Banner = "pending" | "confirmed" | "failed" | "canceled" | "timeout" | "purchasePending" | "purchaseConfirmed" | "purchaseCanceled" | null;

const ERROR_KEYS: Record<string, string> = {
  ESBLU_BILLING_FORBIDDEN: "subscription.errors.forbidden",
  ESBLU_BILLING_ALREADY_SUBSCRIBED: "subscription.errors.alreadySubscribed",
  ESBLU_BILLING_ACTIVE_ON_OTHER_PROVIDER: "subscription.errors.otherProvider",
  ESBLU_BILLING_RATE_LIMITED: "subscription.errors.rateLimited",
};

const BANNER_KEYS: Record<Exclude<Banner, null>, string> = {
  pending: "subscription.checkoutPending",
  confirmed: "subscription.checkoutConfirmed",
  failed: "subscription.checkoutFailed",
  canceled: "subscription.checkoutCanceled",
  timeout: "subscription.checkoutTimeout",
  purchasePending: "subscription.purchasePending",
  purchaseConfirmed: "subscription.purchaseConfirmed",
  purchaseCanceled: "subscription.purchaseCanceled",
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function SubscriptionPage() {
  const { locale, t } = useLocale();
  const platform = useMemo(() => detectPlatform(), []);
  const [state, setState] = useState<LoadState>("loading");
  const [view, setView] = useState<SubscriptionView | null>(null);
  const [options, setOptions] = useState<PurchaseOptions | null>(null);
  const [interval, setInterval_] = useState<"month" | "year">("month");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [bridge, setBridge] = useState<NativeBillingBridge | null>(null);
  const storefrontRef = useRef<string | null>(null);

  const loadSubscription = useCallback(async (): Promise<SubscriptionView | null> => {
    const headers = await authHeaders();
    if (!headers) return null;
    const response = await fetch(apiUrl("/api/billing/subscription"), { headers, cache: "no-store" }).catch(() => null);
    if (!response) return null;
    if (response.status === 404 || response.status === 503) {
      setState("disabled");
      return null;
    }
    const json = (await response.json().catch(() => null)) as { subscription?: unknown } | null;
    const parsed = parseSubscriptionView(json?.subscription);
    if (parsed) setView(parsed);
    return parsed;
  }, []);

  const loadOptions = useCallback(async (storefront: string | null) => {
    const headers = await authHeaders();
    if (!headers) return;
    const query = new URLSearchParams({ platform, ...(storefront ? { storefront } : {}) });
    const response = await fetch(apiUrl(`/api/billing/purchase-options?${query}`), { headers, cache: "no-store" }).catch(() => null);
    const json = response?.ok ? ((await response.json().catch(() => null)) as { options?: unknown } | null) : null;
    setOptions(parsePurchaseOptions(json?.options));
  }, [platform]);

  /** Serverové potvrdenie: čaká na kanonický stav (webhook / overenie obchodu). */
  const waitForServer = useCallback(async (check: (v: SubscriptionView | null, checkoutStatus: string | null) => "done" | "failed" | "wait", checkoutId?: string) => {
    for (let attempt = 0; attempt < CHECKOUT_POLL_MAX_ATTEMPTS; attempt++) {
      let checkoutStatus: string | null = null;
      if (checkoutId) {
        const headers = await authHeaders();
        if (headers) {
          const r = await fetch(apiUrl(`/api/billing/checkout/${encodeURIComponent(checkoutId)}`), { headers, cache: "no-store" }).catch(() => null);
          const j = r ? ((await r.json().catch(() => null)) as { checkout?: { status?: string } } | null) : null;
          checkoutStatus = j?.checkout?.status ?? null;
        }
      }
      const v = await loadSubscription();
      const verdict = check(v, checkoutStatus);
      if (verdict !== "wait") return verdict;
      await sleep(CHECKOUT_POLL_INTERVAL_MS);
    }
    return "timeout" as const;
  }, [loadSubscription]);

  const waitForCheckout = useCallback(async (checkoutId: string) => {
    setBanner("pending");
    const result = await waitForServer((v, status) => {
      const verdict = interpretCheckoutReturn({}, { checkoutStatus: status, subscription: v });
      return verdict === "confirmed" ? "done" : verdict === "failed" ? "failed" : "wait";
    }, checkoutId);
    setBanner(result === "done" ? "confirmed" : result === "failed" ? "failed" : "timeout");
  }, [waitForServer]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let storefront: string | null = null;
      if (platform !== "web") {
        const { loadNativeBillingBridge } = await import("@/lib/billing/native-bridge");
        const b = await loadNativeBillingBridge(platform);
        if (cancelled) return;
        setBridge(b);
        storefront = (await b.getStorefront().catch(() => null))?.country ?? null;
      }
      storefrontRef.current = storefront;
      const v = await loadSubscription();
      await loadOptions(storefront);
      if (cancelled) return;
      setState((s) => (s === "disabled" ? s : v ? "ready" : "error"));
      const params = new URLSearchParams(window.location.search);
      const checkoutId = params.get("checkout_id");
      if (checkoutId) {
        if (params.get("checkout") === "canceled") setBanner("canceled");
        else await waitForCheckout(checkoutId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [platform, loadSubscription, loadOptions, waitForCheckout]);

  async function post<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<(T & { success?: boolean; code?: string }) | null> {
    const headers = await authHeaders();
    if (!headers) {
      setActionError(t("subscription.errors.generic"));
      return null;
    }
    const response = await fetch(apiUrl(path), { method: "POST", headers, body: JSON.stringify(body) }).catch(() => null);
    const json = response ? ((await response.json().catch(() => null)) as (T & { success?: boolean; code?: string }) | null) : null;
    if (!response?.ok || !json?.success) {
      setActionError(t(ERROR_KEYS[json?.code ?? ""] ?? "subscription.errors.generic"));
      return null;
    }
    return json;
  }

  type Intent = { kind: "redirect" | "store"; checkoutId: string; url?: string; productId?: string; basePlanId?: string | null; accountToken?: string; replacesSubscriptionId?: string | null };

  const intentFor = (planCode: string, method: string, mode: "new" | "change", storeToken?: string | null) =>
    post<Intent>("/api/billing/purchase-intent", { planCode, interval, platform, method, storefront: storefrontRef.current, mode, storeToken: storeToken ?? null });

  /** Store nákup potvrdí server u obchodu; potom čakáme na kanonický stav. */
  async function confirmStorePurchase(provider: "apple" | "google", checkoutId: string | null, payload: Record<string, string>, planCode: string) {
    setBanner("purchasePending");
    const result = await post("/api/billing/mobile/confirm", { provider, checkoutId, ...payload });
    if (!result) {
      setBanner(null);
      return;
    }
    const verdict = await waitForServer((v) => (v && hasPaidAccess(v) && v.planCode === planCode ? "done" : "wait"));
    setBanner(verdict === "done" ? "purchaseConfirmed" : "timeout");
  }

  async function runAction(action: PurchaseAction, planCode: string, mode: "new" | "change") {
    setBusy(true);
    setActionError(null);
    try {
      if (action.kind === "web_checkout") {
        const intent = await intentFor(planCode, action.method, "new");
        if (intent?.url) window.location.assign(intent.url);
        return;
      }
      if (!bridge?.available) {
        setActionError(t("subscription.storeUnavailable"));
        return;
      }
      if (action.kind === "apple_iap") {
        const intent = await intentFor(planCode, "apple_iap", mode);
        if (!intent?.productId || !intent.accountToken) return;
        const result = await bridge.purchaseApple({ productId: intent.productId, appAccountToken: intent.accountToken });
        if ("canceled" in result) {
          setBanner("purchaseCanceled");
          return;
        }
        await confirmStorePurchase("apple", intent.checkoutId, { signedTransaction: result.signedTransaction }, planCode);
        return;
      }
      if (action.kind === "apple_external") {
        // EÚ: povinný systémový disclosure (ExternalPurchaseCustomLink.showNotice) + token pre reporting.
        let token: string | null = null;
        if (action.notice) {
          const notice = await bridge.appleExternalPurchaseNotice(action.notice);
          if (!notice.proceed) {
            setBanner("purchaseCanceled");
            return;
          }
          token = notice.token;
        }
        const intent = await intentFor(planCode, action.method, "new", token);
        if (!intent?.url) return;
        await bridge.openCheckout(intent.url, action.notice === "withinApp" ? "in_app" : "browser");
        await waitForCheckout(intent.checkoutId);
        return;
      }
      // Google Play (v EEA s billing choice: Google choice screen → Play alebo Esblu/Stripe).
      const intent = await intentFor(planCode, "google_play", mode);
      if (!intent?.productId || !intent.basePlanId || !intent.accountToken) return;
      const result = await bridge.purchaseGoogle({
        productId: intent.productId,
        basePlanId: intent.basePlanId,
        obfuscatedAccountId: intent.accountToken,
        oldPurchaseToken: intent.replacesSubscriptionId ?? null,
        billingChoice: action.billingChoice && mode === "new",
      });
      if (result.kind === "canceled") {
        setBanner("purchaseCanceled");
        return;
      }
      if (result.kind === "play") {
        await confirmStorePurchase("google", intent.checkoutId, { purchaseToken: result.purchaseToken }, planCode);
        return;
      }
      // Používateľ zvolil Esblu billing → Stripe Checkout v appke (Custom Tab) + reporting tokenu do 24 h.
      const devIntent = await intentFor(planCode, "google_choice_developer", "new", result.externalTransactionToken);
      if (!devIntent?.url) return;
      await bridge.openCheckout(devIntent.url, "in_app");
      await waitForCheckout(devIntent.checkoutId);
    } catch {
      setActionError(t("subscription.errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  async function manageStripe(action: "cancel" | "resume" | "change" | "portal", planCode?: string) {
    if (action === "cancel" && !(await confirmAction({ message: t("subscription.confirmCancel"), destructive: true }))) return;
    setBusy(true);
    setActionError(null);
    const result = await post<{ url?: string }>("/api/billing/manage", { action, planCode, interval });
    setBusy(false);
    if (action === "portal" && result?.url) {
      if (bridge?.available) await bridge.openCheckout(result.url, "in_app");
      else window.location.assign(result.url);
      return;
    }
    if (result) await loadSubscription();
  }

  async function restoreApple() {
    if (!bridge?.available) return;
    setBusy(true);
    try {
      for (const jws of await bridge.restoreApple()) {
        await post("/api/billing/mobile/confirm", { provider: "apple", checkoutId: null, signedTransaction: jws });
      }
      await loadSubscription();
    } finally {
      setBusy(false);
    }
  }

  const fmt = (iso: string | null) => (iso ? formatDate(iso, locale) : "");
  const planName = (code: string | null) => (code ? t(`subscription.plans.${code}`) : t("subscription.noPlan"));
  const moduleName = (key: string) => t(`entitlements.modules.${key}`);
  const limitText = (limit: number | null, period: string | null) =>
    limit === null ? t("subscription.unlimited") : period === "month" ? t("subscription.limitPerMonth", { limit }) : t("subscription.limitTotal", { limit });

  const actions = options ? purchaseActions(options) : [];
  const storeProvider = view?.billingProvider === "apple" || view?.billingProvider === "google" ? view.billingProvider : null;
  const paid = view ? hasPaidAccess(view) : false;
  // Plány: z prvého kanálu (všetky kanály predávajú ten istý katalóg plánov).
  const planList = options && actions[0] ? plansFor(options, actions[0].method, interval) : [];
  const actionLabel = (a: PurchaseAction) =>
    a.kind === "web_checkout" ? t("subscription.buy.web")
      : a.kind === "apple_iap" ? t("subscription.buy.appStore")
        : a.kind === "google" ? t("subscription.buy.googlePlay")
          : a.method === "apple_us_link" ? t("subscription.buy.cardEsbluUs") : t("subscription.buy.cardEsblu");

  // Zmena plánu: u obchodu, ktorý predplatné vlastní (StoreKit / Play), Stripe cez /manage.
  const changeAction = (): PurchaseAction | null => {
    if (storeProvider === "apple") return actions.find((a) => a.kind === "apple_iap") ?? null;
    if (storeProvider === "google") return actions.find((a) => a.kind === "google") ?? null;
    return null;
  };

  const buttonClass = "rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50";
  // Apple Attachment 14: IAP aspoň rovnako výrazné ako alternatíva → rovnaký štýl pre všetky voľby.
  const primary = `${buttonClass} bg-accent-esblu text-white`;
  const secondary = `${buttonClass} border border-subtle text-primary`;

  return (
    <main className="app-shell-bg min-h-screen p-4 sm:p-6 lg:p-10">
      <BackLink href="/nastavenia" label={t("settings.pageTitle")} className="mb-4" />
      <h1 className="text-2xl sm:text-4xl font-bold text-primary">{t("subscription.title")}</h1>

      <div className="mt-8 max-w-2xl space-y-6">
        <p className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 text-sm text-primary">{t("subscription.stagingNotice")}</p>

        {state === "loading" && <p className="text-sm text-muted-esblu">{t("subscription.loading")}</p>}
        {state === "disabled" && <p className="text-sm text-muted-esblu">{t("subscription.disabled")}</p>}
        {state === "error" && <p className="text-sm text-red-500">{t("subscription.loadError")}</p>}
        {banner && (
          <p role="status" className="rounded-2xl border border-subtle bg-surface-1 p-4 text-sm text-primary">
            {t(BANNER_KEYS[banner])}
          </p>
        )}

        {state === "ready" && view && (
          <>
            <section className="rounded-3xl border border-subtle bg-surface-1 p-5 sm:p-8 shadow-lg">
              <h2 className="text-xl font-bold text-primary">{t("subscription.currentPlan")}</h2>
              <p className="mt-2 text-lg text-primary">{planName(view.planCode)}</p>
              <p className="mt-1 text-sm text-muted-esblu">
                {t("subscription.status")}: {t(`subscription.statuses.${view.status}`, { date: fmt(view.graceUntil) })}
              </p>
              {view.canViewDetails && view.billingInterval && <p className="mt-1 text-sm text-muted-esblu">{t(`subscription.interval.${view.billingInterval}`)}</p>}
              {view.canViewDetails && view.billingProvider && <p className="mt-1 text-sm text-muted-esblu">{t(`subscription.provider.${view.billingProvider}`)}</p>}
              {view.canViewDetails && paid && view.currentPeriodEnd && (
                <p className="mt-1 text-sm text-muted-esblu">
                  {view.cancelAtPeriodEnd ? t("subscription.endsOn", { date: fmt(view.currentPeriodEnd) }) : t("subscription.renewsOn", { date: fmt(view.currentPeriodEnd) })}
                </p>
              )}
              {!paid && view.trial.endsAt && (
                <p className="mt-1 text-sm text-muted-esblu">
                  {view.trial.active ? t("subscription.trialRemaining", { date: fmt(view.trial.endsAt) }) : t("subscription.trialEnded")}
                </p>
              )}
              {view.planEntitlements.length > 0 && (
                <>
                  <h3 className="mt-5 text-sm font-semibold text-primary">{t("subscription.includes")}</h3>
                  <ul className="mt-2 space-y-1 text-sm text-muted-esblu">
                    {view.planEntitlements.map((e) => (
                      <li key={e.key}>{moduleName(e.key)} — {limitText(e.limit, e.limit_period)}</li>
                    ))}
                  </ul>
                </>
              )}

              {view.canManage && paid && (
                <div className="mt-5 flex flex-wrap gap-3">
                  {storeProvider ? (
                    <>
                      <p className="w-full text-sm text-muted-esblu">{t("subscription.manageInStore", { store: t(`subscription.provider.${storeProvider}`) })}</p>
                      {bridge?.available && (
                        <button type="button" disabled={busy} onClick={() => bridge.manageStoreSubscription(storeProvider)} className={secondary}>
                          {t("subscription.manageInStoreButton")}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {view.cancelAtPeriodEnd ? (
                        <button type="button" disabled={busy} onClick={() => manageStripe("resume")} className={primary}>{t("subscription.resume")}</button>
                      ) : (
                        <button type="button" disabled={busy} onClick={() => manageStripe("cancel")} className={secondary}>{t("subscription.cancel")}</button>
                      )}
                      {view.billingProvider === "stripe" && (
                        <button type="button" disabled={busy} onClick={() => manageStripe("portal")} className={secondary}>{t("subscription.portal")}</button>
                      )}
                    </>
                  )}
                </div>
              )}
              {platform === "ios" && view.canManage && bridge?.available && (
                <button type="button" disabled={busy} onClick={restoreApple} className={`mt-4 ${secondary}`}>{t("subscription.restore")}</button>
              )}
            </section>

            {!view.canManage && <p className="text-sm text-muted-esblu">{t("subscription.readOnly")}</p>}
            {view.canManage && options?.viewOnly && <p className="text-sm text-muted-esblu">{t("subscription.viewOnly")}</p>}
            {view.canManage && platform !== "web" && bridge && !bridge.available && !options?.viewOnly && (
              <p className="text-sm text-muted-esblu">{t("subscription.storeUnavailable")}</p>
            )}
            {actionError && <p role="alert" className="text-sm text-red-500">{actionError}</p>}

            {view.canManage && planList.length > 0 && (
              <section className="rounded-3xl border border-subtle bg-surface-1 p-5 sm:p-8 shadow-lg">
                <h2 className="text-xl font-bold text-primary">{t("subscription.choosePlan")}</h2>
                <div className="mt-3 flex gap-2">
                  {(["month", "year"] as const).map((value) => (
                    <button key={value} type="button" onClick={() => setInterval_(value)} aria-pressed={interval === value}
                      className={`rounded-xl px-3 py-1 text-sm ${interval === value ? "bg-accent-esblu text-white" : "border border-subtle text-primary"}`}>
                      {t(`subscription.interval.${value}`)}
                    </button>
                  ))}
                </div>
                {actions.some((a) => a.kind === "apple_external" && a.notice) && <p className="mt-3 text-xs text-muted-esblu">{t("subscription.buy.appleExternalHint")}</p>}
                {actions.some((a) => a.kind === "google" && a.billingChoice) && <p className="mt-3 text-xs text-muted-esblu">{t("subscription.buy.googleChoiceHint")}</p>}
                <div className="mt-4 space-y-4">
                  {planList.map((plan) => {
                    const isCurrent = plan.planCode === view.planCode && paid;
                    const change = changeAction();
                    return (
                      <div key={plan.planCode} className="rounded-2xl border border-subtle p-4">
                        <p className="font-semibold text-primary">{planName(plan.planCode)}</p>
                        <ul className="mt-2 space-y-1 text-sm text-muted-esblu">
                          {plan.entitlements.map((e) => (
                            <li key={e.key}>{moduleName(e.key)} — {limitText(e.limit, e.limit_period)}</li>
                          ))}
                        </ul>
                        <div className="mt-3 flex flex-wrap gap-3">
                          {!isCurrent && canStartCheckout(view) && actions.map((a) => (
                            <button key={a.method} type="button" disabled={busy} onClick={() => runAction(a, plan.planCode, "new")} className={primary}>
                              {actionLabel(a)}
                            </button>
                          ))}
                          {!isCurrent && paid && change && (
                            <button type="button" disabled={busy} onClick={() => runAction(change, plan.planCode, "change")} className={secondary}>{t("subscription.changePlan")}</button>
                          )}
                          {!isCurrent && paid && !storeProvider && (
                            <button type="button" disabled={busy} onClick={() => manageStripe("change", plan.planCode)} className={secondary}>{t("subscription.changePlan")}</button>
                          )}
                        </div>
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
