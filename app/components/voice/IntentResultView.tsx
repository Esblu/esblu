"use client";

import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { IntentResult } from "@/lib/intents/types";
import { storePartnerPrefill } from "@/lib/partner-prefill";

// =============================================================================
// Zobrazenie výsledku Intent Enginu.
//
// Bolo to 190 riadkov priamo v Dashboarde, takže výsledok hlasového alebo
// písaného príkazu sa dal ukázať iba tam. Globálny launcher potrebuje to
// isté — a dva renderery toho istého typu by sa časom rozišli.
//
// Komponent je ZÁMERNE hlúpy: nič nevykonáva, iba vykresľuje. Potvrdenie
// akcie deleguje nahor cez `onConfirm`, pretože ho vybavuje volajúci,
// ktorý drží prihlasovací token.
//
// TYPOGRAFIA
// ----------
// Obsah, ktorý má používateľ prečítať — popisy položiek, poznámky, sumy —
// nikdy nie je menší než `text-sm`. Panel sa po odpovedi opticky
// zmenšoval práve preto, že tieto texty boli `text-xs`, zatiaľ čo otázka
// nad nimi `text-sm`. Menšie písmo zostáva iba na štítkoch sekcií a
// odznakoch, ktoré sa nečítajú, iba označujú.
//
// Dlhý obsah sa ZALAMUJE, neskracuje: odrezaný popis položky na faktúre
// je horší než o riadok vyšší panel.
// =============================================================================

/**
 * Tlačidlá rýchlej odpovede („Áno" / „Nie"). Pošlú text tou istou cestou ako
 * vyslovená odpoveď — o význame rozhoduje server so zapečatenou otázkou.
 */
export function QuickReplies({
  replies,
  onQuickReply,
  disabled = false,
}: {
  replies: { label: string; text: string }[] | undefined;
  onQuickReply?: (text: string) => void;
  disabled?: boolean;
}) {
  if (!replies || replies.length === 0 || !onQuickReply) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {replies.map((reply, index) => (
        <button
          key={reply.text}
          type="button"
          disabled={disabled}
          onClick={() => onQuickReply(reply.text)}
          className={`${index === 0 ? "btn-primary" : "btn-secondary"} min-h-11 px-4 py-2 text-sm font-bold disabled:opacity-60`}
        >
          {reply.label}
        </button>
      ))}
    </div>
  );
}

export function IntentResultView({
  intentResult,
  actionSubmitting,
  onConfirm,
  onCancel,
  onQuickReply,
}: {
  intentResult: IntentResult | null;
  actionSubmitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onQuickReply?: (text: string) => void;
}) {
  const { t } = useLocale();

  if (!intentResult) return null;


    const cardClass =
      "surface-card-hover block rounded-2xl border border-subtle bg-surface-1/60 p-4 transition";
    const boxClass =
      "rounded-2xl border border-subtle bg-surface-1/60 p-4 text-sm text-secondary";

    switch (intentResult.kind) {
      case "navigate":
        return (
          <Link href={intentResult.entity.href} className={cardClass}>
            <p className="min-h-11 py-2 text-sm font-bold text-accent-cyan">
              {t("search.ui.openAction")}
            </p>
            <p className="mt-1 text-base font-bold text-primary">
              {intentResult.entity.label}
            </p>
          </Link>
        );

      case "answer":
        return (
          <div className={boxClass}>
            <p className="text-sm font-medium text-primary">{intentResult.text}</p>
            {intentResult.entity && (
              <Link
                href={intentResult.entity.href}
                className="mt-2 inline-block min-h-11 py-2 text-sm font-bold text-accent-cyan"
              >
                {intentResult.entity.label} →
              </Link>
            )}
            <QuickReplies replies={intentResult.quickReplies} onQuickReply={onQuickReply} disabled={actionSubmitting} />
          </div>
        );

      case "report":
        return (
          <div className="rounded-2xl border border-subtle bg-surface-1/60 p-4">
            <Link
              href={intentResult.entity.href}
              className="min-h-11 py-2 text-sm font-bold text-accent-cyan"
            >
              {intentResult.entity.label} →
            </Link>
            <div className="mt-3 space-y-4">
              {intentResult.sections.map((section) => (
                <div key={section.title}>
                  <p className="text-xs font-bold uppercase tracking-wide text-muted-esblu">
                    {section.title}
                  </p>
                  <div className="mt-1.5 space-y-1">
                    {section.rows.map((row) => (
                      <div key={row.label} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-secondary">{row.label}</span>
                        <span className="font-semibold text-primary">{row.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );

      case "list":
        return (
          <div className="space-y-2.5">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-esblu">
              {intentResult.title}
            </p>
            {intentResult.items.map((item) => (
              <Link key={item.id} href={item.href} className={cardClass}>
                <p className="text-base font-bold text-primary">{item.label}</p>
              </Link>
            ))}
            <QuickReplies replies={intentResult.quickReplies} onQuickReply={onQuickReply} disabled={actionSubmitting} />
          </div>
        );

      case "deadline_list":
        if (intentResult.items.length === 0) {
          return <p className={boxClass}>{t("search.ui.noDeadlines")}</p>;
        }
        return (
          <div className="space-y-2.5">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-esblu">
              {intentResult.title}
            </p>
            {intentResult.items.map((item, index) => (
              <Link key={`${item.entity.id}-${index}`} href={item.entity.href} className={cardClass}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-bold text-primary">
                      {item.entity.label}
                    </p>
                    <p className="text-sm text-secondary">
                      {item.typeLabel} — {item.dueDateLabel}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-amber-400/12 px-2.5 py-1 text-xs font-bold text-amber-400">
                    {item.severityLabel}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        );

      case "document_list":
        return (
          <div className="space-y-2.5">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-esblu">
              {intentResult.title}
            </p>
            {intentResult.items.map((item, index) => (
              <Link key={`${item.href}-${index}`} href={item.href} className={cardClass}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-bold text-primary">{item.label}</p>
                    <p className="text-sm text-secondary">
                      {item.typeLabel}
                      {item.dateLabel ? ` — ${item.dateLabel}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-accent-cyan/12 px-2.5 py-1 text-xs font-bold text-accent-cyan">
                    {item.linkLabel}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        );

      case "disambiguate":
        return (
          <div className="space-y-2.5">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-esblu">
              {t("search.ui.multipleMatches")}
            </p>
            {intentResult.candidates.map((candidate) => (
              <Link key={candidate.id} href={candidate.href} className={cardClass}>
                <p className="text-base font-bold text-primary">{candidate.label}</p>
              </Link>
            ))}
          </div>
        );

      case "not_found":
        return (
          <div className={boxClass}>
            <p>{intentResult.text}</p>
            <QuickReplies replies={intentResult.quickReplies} onQuickReply={onQuickReply} disabled={actionSubmitting} />
          </div>
        );
      case "error":
        return <p className={boxClass}>{intentResult.text}</p>;

      case "action_preview":
        return (
          <div
            className={
              intentResult.destructive
                ? "rounded-2xl border border-danger/40 bg-danger-soft p-4 text-sm text-secondary"
                : boxClass
            }
          >
            <p className={`text-sm font-medium ${intentResult.destructive ? "text-danger" : "text-primary"}`}>
              {intentResult.summary}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onConfirm}
                disabled={actionSubmitting}
                className="btn-primary min-h-11 px-4 py-2 text-sm font-bold disabled:opacity-60"
              >
                {intentResult.confirmLabel}
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={actionSubmitting}
                className="btn-secondary min-h-11 px-4 py-2 text-sm font-bold disabled:opacity-60"
              >
                {intentResult.cancelLabel}
              </button>
            </div>
          </div>
        );

      case "action_result":
        return (
          <div className={boxClass}>
            <p className={intentResult.success ? "text-primary" : "text-secondary"}>
              {intentResult.text}
            </p>
            {intentResult.folder && (
              <Link
                href={`/priecinky/${intentResult.folder.id}`}
                className="mt-2 inline-block min-h-11 py-2 text-sm font-bold text-accent-cyan"
              >
                {intentResult.folder.name} →
              </Link>
            )}
          </div>
        );

      // Draft, ktorý sa MUSÍ skontrolovať. Súhrn je tu preto, aby
      // používateľ videl, čo vzniklo, EŠTE PRED tým, než niekam klikne —
      // odkaz bez súhrnu by znamenal, že sa o obsahu dokladu dozvie až na
      // inej obrazovke.
      case "draft_created":
        return (
          <div className="rounded-2xl border border-subtle bg-surface-1/60 p-4">
            <p className="text-sm font-bold text-primary">{intentResult.title}</p>

            <div className="mt-3 space-y-1">
              {intentResult.summary.map((row) => (
                <div key={row.label} className="flex items-start justify-between gap-3 text-sm">
                  <span className="shrink-0 text-secondary">{row.label}</span>
                  <span className="min-w-0 break-words text-right font-semibold text-primary">
                    {row.value}
                  </span>
                </div>
              ))}
            </div>

            <p className="mt-3 text-sm leading-relaxed text-secondary">{intentResult.note}</p>

            <Link
              href={intentResult.entity.href}
              className="mt-3 inline-block min-h-11 py-2 text-sm font-bold text-accent-cyan"
            >
              {intentResult.entity.label} →
            </Link>
          </div>
        );

      // Nový obchodný partner: nič sa neuložilo. Odkaz odovzdá vyslovené
      // údaje formuláru (sessionStorage) a uloží ich až človek.
      case "partner_review": {
        const prefill = intentResult.prefill;
        return (
          <div className={boxClass}>
            <p className="text-sm font-medium text-primary">{intentResult.text}</p>
            <Link
              href={intentResult.href}
              onClick={() => storePartnerPrefill(prefill)}
              className="mt-2 inline-block min-h-11 py-2 text-sm font-bold text-accent-cyan"
            >
              {intentResult.openLabel} →
            </Link>
          </div>
        );
      }

      // `clarify` sem NEPATRÍ — otázku vykresľuje launcher sám, pretože k
      // nej patrí aj pole na odpoveď, ktoré tento komponent (zámerne
      // hlúpy, bez vlastného stavu) držať nemá.
      case "clarify":
        return null;

      default:
        return null;
    }
}
