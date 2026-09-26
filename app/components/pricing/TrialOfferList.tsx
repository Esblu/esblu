"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";
import { TRIAL_OFFER } from "@/lib/pricing";

// Obsah 14-dňovej skúšobnej verzie — čísla výhradne z lib/pricing.ts
// (TRIAL_OFFER, zrkadlo DB katalógu nárokov). Zdieľané úvodnou stránkou aj
// /cennik, aby sa texty a limity nikdy nerozišli.

function Check() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="mt-0.5 h-5 w-5 shrink-0 text-accent-cyan">
      <path d="m5 10 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cross() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="mt-0.5 h-5 w-5 shrink-0 text-muted-esblu">
      <path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function TrialOfferList({ showExcluded = true }: { showExcluded?: boolean }) {
  const { t, tCount } = useLocale();
  const { limits } = TRIAL_OFFER;

  const included = [
    tCount("pricing.trial.users", limits.users),
    tCount("pricing.trial.vehicles", limits.vehicles),
    tCount("pricing.trial.machines", limits.machines),
    tCount("pricing.trial.inventory", limits.inventoryItems),
    tCount("pricing.trial.ai", limits.aiProcessings),
    ...(TRIAL_OFFER.includesInvoicing ? [t("pricing.trial.invoicing")] : []),
    t("pricing.trial.manual"),
  ];

  return (
    <div>
      <p className="text-sm font-bold uppercase tracking-[0.14em] text-muted-esblu">{t("pricing.trial.includesTitle")}</p>
      <ul className="mt-3 space-y-3">
        {included.map((text) => (
          <li key={text} className="flex items-start gap-3 text-secondary">
            <Check />
            <span>{text}</span>
          </li>
        ))}
      </ul>
      {showExcluded && !TRIAL_OFFER.includesVoice && (
        <>
          <p className="mt-6 text-sm font-bold uppercase tracking-[0.14em] text-muted-esblu">{t("pricing.trial.excludedTitle")}</p>
          <ul className="mt-3 space-y-3">
            <li className="flex items-start gap-3 text-secondary">
              <Cross />
              <span>{t("pricing.trial.voice")}</span>
            </li>
          </ul>
        </>
      )}
    </div>
  );
}
