"use client";

// =============================================================================
// STAGING ONLY — „hosted checkout" FAKE providera. Žiadna platba. Tlačidlo
// zavolá /api/billing/fake/complete, ktoré vytvorí PODPÍSANÝ fake webhook a
// pošle ho tou istou pipeline ako Stripe. Potom návrat na Predplatné, kde UI
// čaká na serverové potvrdenie (nie na query parameter).
// Mimo ESBLU_BILLING_MODE=fake API vracia 404.
// =============================================================================

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function FakeCheckoutPage() {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);

  async function complete(outcome: "paid" | "failed") {
    const id = new URLSearchParams(window.location.search).get("checkout");
    const checkoutId = id && UUID_RE.test(id) ? id : null;
    if (!checkoutId) return;
    setBusy(true);
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) {
      await fetch(apiUrl("/api/billing/fake/complete"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ checkoutId, outcome }),
      }).catch(() => null);
    }
    const back = `/nastavenia/predplatne?checkout_id=${encodeURIComponent(checkoutId)}&checkout=${outcome === "paid" ? "returned" : "canceled"}`;
    window.location.assign(back);
  }

  return (
    <main className="app-shell-bg min-h-screen p-4 sm:p-6 lg:p-10">
      <div className="mx-auto mt-10 max-w-md rounded-3xl border border-amber-400/40 bg-surface-1 p-6 shadow-lg">
        <h1 className="text-xl font-bold text-primary">{t("subscription.fakeCheckout.title")}</h1>
        <p className="mt-2 text-sm text-muted-esblu">{t("subscription.fakeCheckout.body")}</p>
        <div className="mt-5 flex flex-col gap-3">
          <button type="button" disabled={busy} onClick={() => complete("paid")} className="rounded-xl bg-accent-esblu px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {t("subscription.fakeCheckout.pay")}
          </button>
          <button type="button" disabled={busy} onClick={() => complete("failed")} className="rounded-xl border border-subtle px-4 py-2 text-sm font-semibold text-primary disabled:opacity-50">
            {t("subscription.fakeCheckout.fail")}
          </button>
          <a href="/nastavenia/predplatne" className="text-center text-sm text-muted-esblu underline">
            {t("subscription.fakeCheckout.back")}
          </a>
        </div>
      </div>
    </main>
  );
}
