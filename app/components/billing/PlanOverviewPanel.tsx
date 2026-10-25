"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  ADDON_IDS,
  ADDONS,
  BASE_MODULE_IDS,
  formatEurCents,
  previewAddModule,
  quote,
  sellableModules,
  type BaseModuleId,
  type PriceTier,
} from "@/lib/pricing";

// =============================================================================
// Plán a čerpanie firmy (STAGING UI, pricing + entitlements 2026-10-26).
//
// - Čerpanie (AI, hlas, používatelia, úložisko, eFaktúra) z DB
//   esblu_my_plan_overview() — vždy AKTÍVNA firma; každý člen vidí čerpanie.
// - Výber modulov / Komplet / add-ony je iba SIMULÁCIA cez kanonický engine
//   (lib/pricing.ts) a iba pre ownera. Nič sa neaktivuje ani neúčtuje:
//   žiadny checkout, žiadna platobná session, tlačidlá sú vypnuté
//   („Platby pripravujeme“). Aktivácia = iba potvrdený billing event.
// =============================================================================

type UsageItem = { active?: boolean; used?: number; reserved?: number; limit?: number | null };
type Overview = {
  role: string;
  trial: { active: boolean; ends_at: string | null };
  usage: {
    ai_processings: UsageItem;
    voice: { active?: boolean; used_seconds?: number; limit_minutes?: number | null };
    users: UsageItem;
    storage: { used_bytes?: number; limit_mb?: number | null };
    einvoice_transactions: { active?: boolean };
  };
  price_tier?: PriceTier;
  plan?: { kind: string; modules: string[] } | null;
};

function Meter({ label, used, limit, unit }: { label: string; used: number; limit: number | null; unit: string }) {
  const pct = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const exhausted = limit !== null && used >= limit;
  return (
    <div className="py-2">
      <div className="flex justify-between gap-3 text-sm">
        <span className="text-primary">{label}</span>
        <span className={exhausted ? "font-bold text-accent-orange" : "text-secondary"}>
          {limit === null ? `${used} ${unit}` : `${used} / ${limit} ${unit}`}
        </span>
      </div>
      {limit !== null && (
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
          <div className={`h-full ${exhausted ? "bg-accent-orange" : "bg-accent-cyan"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export default function PlanOverviewPanel() {
  const { t, locale } = useLocale();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<BaseModuleId[]>([]);
  const [capNotice, setCapNotice] = useState<{ sum: number; complete: number } | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.rpc("esblu_my_plan_overview").then(({ data, error }) => {
      if (!alive) return;
      if (error || !data) setFailed(true);
      else setOverview(data as Overview);
    });
    return () => {
      alive = false;
    };
  }, []);

  const tier: PriceTier = overview?.price_tier === "secondary" ? "secondary" : "primary";
  const current = useMemo(() => quote({ modules: selected, tier }), [selected, tier]);

  if (failed) return <p className="text-sm text-secondary">{t("subscription.planPanel.loadError")}</p>;
  if (!overview) return <p className="text-sm text-secondary">{t("subscription.loading")}</p>;

  const isOwner = overview.role === "owner";
  const u = overview.usage;
  const toggle = (id: BaseModuleId) => {
    if (selected.includes(id)) {
      setCapNotice(null);
      setSelected(selected.filter((x) => x !== id));
      return;
    }
    const preview = previewAddModule({ modules: selected, tier }, id);
    setCapNotice(preview.exceedsCap ? { sum: preview.modulesSumAfterCents, complete: preview.completeCents } : null);
    setSelected([...selected, id]);
  };

  return (
    <section className="surface-card space-y-4 p-4 sm:p-6" aria-labelledby="plan-panel-title">
      <div>
        <h2 id="plan-panel-title" className="text-lg font-black text-primary">{t("subscription.planPanel.title")}</h2>
        <p className="mt-1 text-xs text-muted-esblu">{t("subscription.planPanel.stagingNotice")}</p>
        {overview.trial.active && <p className="mt-2 text-sm text-accent-cyan">{t("subscription.planPanel.trialActive")}</p>}
      </div>

      <div className="divide-y divide-white/10">
        <Meter label={t("subscription.planPanel.ai")} used={u.ai_processings.used ?? 0} limit={u.ai_processings.active ? u.ai_processings.limit ?? null : 0} unit="" />
        <Meter
          label={t("subscription.planPanel.voice")}
          used={Math.ceil((u.voice.used_seconds ?? 0) / 60)}
          limit={u.voice.active ? u.voice.limit_minutes ?? null : 0}
          unit="min"
        />
        <Meter label={t("subscription.planPanel.users")} used={u.users.reserved ?? u.users.used ?? 0} limit={u.users.active ? u.users.limit ?? null : null} unit="" />
        <Meter
          label={t("subscription.planPanel.storage")}
          used={Math.round((u.storage.used_bytes ?? 0) / 1048576)}
          limit={u.storage.limit_mb ?? null}
          unit="MB"
        />
        <p className="py-2 text-sm text-muted-esblu">{t("subscription.planPanel.einvoiceBlocked")}</p>
      </div>

      {isOwner ? (
        <div className="space-y-3">
          <p className="text-sm font-bold text-primary">
            {tier === "secondary" ? t("subscription.planPanel.secondaryTier") : t("subscription.planPanel.primaryTier")}
          </p>
          <div className="flex flex-wrap gap-2">
            {BASE_MODULE_IDS.map((m) => (
              <button
                key={m}
                type="button"
                disabled={!sellableModules(false).includes(m)}
                aria-pressed={selected.includes(m)}
                onClick={() => toggle(m)}
                className={`ui-btn ${selected.includes(m) ? "ui-btn-primary" : "ui-btn-secondary"} disabled:opacity-50`}
              >
                {t(`pricing.modules.items.${m}.name`)}
              </button>
            ))}
          </div>
          {capNotice && (
            <p className="rounded-xl border border-accent-cyan/40 bg-accent-cyan/10 p-3 text-sm text-primary">
              {t("pricing.summary.capNotice", { sum: formatEurCents(capNotice.sum, locale), complete: formatEurCents(capNotice.complete, locale) })}
            </p>
          )}
          <p className="text-base font-black text-primary">{t("pricing.summary.total", { amount: formatEurCents(current.totalCents, locale) })}</p>
          <ul className="space-y-1 text-sm text-secondary">
            {ADDON_IDS.map((id) => (
              <li key={id} className="flex justify-between gap-3">
                <span>{t(`pricing.addons.${id}`, { units: ADDONS[id].units })}</span>
                <span>{t("pricing.addons.perMonth", { price: formatEurCents(ADDONS[id].priceCents, locale) })}</span>
              </li>
            ))}
          </ul>
          <button type="button" disabled className="ui-btn ui-btn-primary w-full opacity-60">
            {t("subscription.planPanel.checkoutDisabled")}
          </button>
        </div>
      ) : (
        <p className="text-sm text-secondary">{t("entitlements.limitReached.ownerOnly")}</p>
      )}
    </section>
  );
}
