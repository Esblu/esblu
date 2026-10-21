"use client";

// =============================================================================
// Panel „Dnes" — odpoveď na otázku „Čo dnes musím riešiť?" (2026-10-22).
//
// Iba zobrazenie: položky skladá lib/dashboard/today.ts z dát AKTÍVNEJ firmy,
// ktoré Dashboard načítal pod RLS. Každá položka má akciu (odkaz na miesto,
// kde sa vec vybaví). Žiadne meranie, žiadne volanie navonok.
//
// Telefón: kompaktný blok nad valcom modulov (2 položky + „Zobraziť všetko").
// Desktop: bočný panel vedľa valca.
// =============================================================================

import { useState } from "react";
import { AppLink } from "@/app/components/AppLink";
import { resolveAppHref } from "@/lib/app-routes";
import {
  countBySeverity,
  TODAY_SEVERITY_ORDER,
  type FirstStep,
  type TodayItem,
  type TodaySeverity,
} from "@/lib/dashboard/today";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export type FirstStepAction = { labelKey: string; href: string };

const SEVERITY_STYLE: Record<TodaySeverity, string> = {
  urgent: "bg-danger-soft text-danger",
  today: "bg-warning-soft text-warning",
  soon: "bg-info-soft text-info",
  info: "bg-surface-2 text-secondary",
};

const MOBILE_PREVIEW = 2;

export function TodayPanel({
  t,
  variant,
  state,
  items,
  companyName,
  roleLabel,
  firstSteps,
  firstStepActions,
  onDismissFirstSteps,
  suggestions,
  onAsk,
  onRetry,
}: {
  t: Translate;
  variant: "compact" | "full";
  state: "loading" | "ready" | "error";
  items: TodayItem[];
  companyName: string;
  roleLabel: string | null;
  /** Prázdne pole = nezobrazovať. */
  firstSteps: FirstStep[];
  firstStepActions: Partial<Record<FirstStep["key"], FirstStepAction[]>>;
  onDismissFirstSteps: () => void;
  /** Overené príklady otázok pre asistenta (podľa roly); prázdne = skryť. */
  suggestions: string[];
  onAsk: (text: string) => void;
  onRetry: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const counts = countBySeverity(items);
  const compact = variant === "compact";
  const visibleItems = compact && !expanded ? items.slice(0, MOBILE_PREVIEW) : items;
  const hidden = items.length - visibleItems.length;

  return (
    <section
      aria-labelledby={`today-title-${variant}`}
      data-testid={`today-panel-${variant}`}
      className={compact ? "mb-2 shrink-0" : "surface-card flex min-h-0 flex-col p-4"}
    >
      <div className={compact ? "flex items-center justify-between gap-2" : ""}>
        <div className="min-w-0">
          <h3 id={`today-title-${variant}`} className="text-[15px] font-semibold text-primary">
            {t("today.title")}
          </h3>
          {!compact && (
            <p className="mt-0.5 truncate text-xs text-muted-esblu">
              {roleLabel ? t("today.scopeWithRole", { company: companyName, role: roleLabel }) : t("today.scope", { company: companyName })}
            </p>
          )}
        </div>
        {state === "ready" && items.length > 0 && (
          <ul
            className={compact ? "flex shrink-0 items-center gap-1" : "mt-2 flex flex-wrap items-center gap-1"}
            aria-label={t("today.summaryLabel")}
          >
            {TODAY_SEVERITY_ORDER.filter((severity) => counts[severity] > 0 && (!compact || severity === "urgent" || severity === "today")).map((severity) => (
              <li key={severity} className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${SEVERITY_STYLE[severity]}`}>
                {t(`today.severity.${severity}`)} {counts[severity]}
              </li>
            ))}
          </ul>
        )}
      </div>

      {firstSteps.length > 0 && (
        <FirstSteps t={t} steps={firstSteps} actions={firstStepActions} onDismiss={onDismissFirstSteps} compact={compact} />
      )}

      <div className={compact ? (expanded ? "mt-1.5 max-h-[38dvh] overflow-y-auto" : "mt-1.5") : "mt-2 min-h-0 flex-1 overflow-y-auto"}>
        {state === "loading" ? (
          <div role="status" aria-busy="true" aria-label={t("today.loading")} className="space-y-1.5">
            {[0, 1].map((index) => (
              <div key={index} className="h-11 animate-pulse rounded-doc border border-subtle bg-surface-1 motion-reduce:animate-none" />
            ))}
          </div>
        ) : state === "error" ? (
          <p role="status" className="flex items-center gap-2 rounded-doc border border-subtle bg-surface-1 px-3 py-2 text-[13px] text-secondary">
            <span className="min-w-0 flex-1">{t("today.error")}</span>
            <button type="button" onClick={onRetry} className="ui-btn ui-btn-ghost ui-btn-sm shrink-0">
              {t("dashboard.cylinder.retry")}
            </button>
          </p>
        ) : items.length === 0 ? (
          firstSteps.length > 0 ? null : (
            <p className="rounded-doc border border-subtle bg-surface-1 px-3 py-2 text-[13px] text-secondary">
              <span className="font-semibold text-primary">{t("today.allClearTitle")}</span>{" "}
              {t("today.allClearBody")}
            </p>
          )
        ) : (
          <ul className="space-y-1.5">
            {visibleItems.map((item) => (
              <TodayRow key={item.id} item={item} t={t} compact={compact} />
            ))}
          </ul>
        )}
      </div>

      {compact && state === "ready" && (hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="mt-1 min-h-8 w-full rounded-doc text-center text-xs font-semibold text-brand-300 hover:bg-surface-hover"
        >
          {expanded ? t("today.showLess") : t("today.showAll", { count: items.length })}
        </button>
      )}

      {!compact && suggestions.length > 0 && firstSteps.length === 0 && (
        <div className="mt-3 border-t border-subtle pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-esblu">{t("today.askTitle")}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {suggestions.map((text) => (
              <button
                key={text}
                type="button"
                onClick={() => onAsk(text)}
                className="rounded-full border border-subtle bg-surface-1 px-2.5 py-1 text-xs text-secondary transition hover:bg-surface-hover hover:text-primary"
              >
                {text}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function TodayRow({ item, t, compact }: { item: TodayItem; t: Translate; compact: boolean }) {
  const target = resolveAppHref(item.href);
  const badge = (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${SEVERITY_STYLE[item.severity]}`}>
      {t(`today.severity.${item.severity}`)}
    </span>
  );
  const title = t(item.titleKey, item.vars);

  // Telefón: celý riadok je jedno ťuknutie (akcia je v aria-label), aby
  // blok „Dnes" nezobral valcu modulov priveľa výšky.
  if (compact) {
    const body = (
      <>
        {badge}
        <span className="line-clamp-2 min-w-0 flex-1 text-[13px] font-medium leading-snug text-primary">{title}</span>
        {target && <span aria-hidden="true" className="shrink-0 text-brand-300">›</span>}
      </>
    );
    return (
      <li>
        {target ? (
          <AppLink
            href={item.href}
            aria-label={`${title} — ${t(item.ctaKey)}`}
            className="flex min-h-11 items-center gap-2 rounded-doc border border-subtle bg-surface-1 px-2.5 py-1.5 transition hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
          >
            {body}
          </AppLink>
        ) : (
          <div className="flex min-h-11 items-center gap-2 rounded-doc border border-subtle bg-surface-1 px-2.5 py-1.5">{body}</div>
        )}
      </li>
    );
  }

  return (
    <li className="rounded-doc border border-subtle bg-surface-1 px-2.5 py-2">
      <div className="flex items-start gap-2">
        {badge}
        <p className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-primary">{title}</p>
      </div>
      {target && (
        <div className="mt-1 flex justify-end">
          <AppLink
            href={item.href}
            className="rounded-doc-sm px-2 py-0.5 text-xs font-semibold text-brand-300 transition hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
          >
            {t(item.ctaKey)} →
          </AppLink>
        </div>
      )}
    </li>
  );
}

function FirstSteps({
  t,
  steps,
  actions,
  onDismiss,
  compact,
}: {
  t: Translate;
  steps: FirstStep[];
  actions: Partial<Record<FirstStep["key"], FirstStepAction[]>>;
  onDismiss: () => void;
  compact: boolean;
}) {
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done) ?? null;
  const shown = compact ? steps.filter((step) => step === next) : steps;

  return (
    <div data-testid="first-steps" className="mt-2 rounded-doc border border-brand-400/30 bg-surface-1 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-primary">
          {t("today.firstSteps.title")} <span className="font-normal text-muted-esblu">· {t("today.firstSteps.progress", { done, total: steps.length })}</span>
        </p>
        <button type="button" onClick={onDismiss} className="shrink-0 text-xs text-muted-esblu hover:text-primary">
          {t("today.firstSteps.dismiss")}
        </button>
      </div>
      {!compact && <p className="mt-0.5 text-xs text-secondary">{t("today.firstSteps.intro")}</p>}
      <ol className="mt-2 space-y-1.5">
        {shown.map((step) => (
          <li key={step.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            <span
              aria-hidden="true"
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                step.done ? "bg-success-soft text-success" : "border border-subtle text-muted-esblu"
              }`}
            >
              {step.done ? "✓" : ""}
            </span>
            <span className={step.done ? "text-muted-esblu line-through" : "font-medium text-primary"}>
              {t(`today.firstSteps.steps.${step.key}`)}
              {step.optional && <span className="ml-1 text-xs font-normal text-muted-esblu">({t("today.firstSteps.optional")})</span>}
              <span className="sr-only">{step.done ? ` — ${t("today.firstSteps.done")}` : ""}</span>
            </span>
            {!step.done && (actions[step.key] ?? []).filter((action) => resolveAppHref(action.href)).length > 0 && (
              <span className="flex w-full flex-wrap gap-1.5 pl-7">
                {(actions[step.key] ?? [])
                  .filter((action) => resolveAppHref(action.href))
                  .map((action) => (
                    <AppLink key={action.href} href={action.href} className="ui-btn ui-btn-secondary ui-btn-sm">
                      {t(action.labelKey)}
                    </AppLink>
                  ))}
              </span>
            )}
          </li>
        ))}
      </ol>
      {!compact && <p className="mt-2 text-xs text-muted-esblu">{t("today.firstSteps.outcome")}</p>}
    </div>
  );
}
