import type { OutboundSummaryDto } from "@/lib/einvoice/ui/types";
import {
  outboundPanelModel,
  outboundStateHintKey,
  outboundStateKey,
  outboundTone,
  readinessIssueText,
  transportMessageKey,
  type Feedback,
  type HasKey,
  type Translate,
} from "@/lib/einvoice/ui/view-model";
import { EinvoiceStatusPill } from "./EinvoiceStatusPill";
import { EinvoiceTimeline } from "./EinvoiceTimeline";
import { einvoiceButtonPrimary, einvoiceButtonSecondary, einvoiceCard } from "./styles";

// =============================================================================
// Panel „E-Faktúra" pre VYDANÚ faktúru — prezentačný komponent (iba props).
// Čo je povolené, rozhoduje server (summary.allowed) a pri akcii znova DB.
// =============================================================================

export type OutboundPanelProps = {
  summary: OutboundSummaryDto;
  t: Translate;
  has: HasKey;
  formatDateTime: (iso: string) => string;
  busy: null | "send" | "download" | "reconcile" | "retry";
  feedback: Feedback | null;
  onSend: () => void;
  onDownload: (attemptId: string) => void;
  onAction: (action: "reconcile" | "retry", attemptId: string) => void;
};

export function OutboundPanelView({ summary, t, has, formatDateTime, busy, feedback, onSend, onDownload, onAction }: OutboundPanelProps) {
  const model = outboundPanelModel(summary);
  const current = model.current;
  const readiness = summary.readiness;
  const isBusy = busy !== null;

  return (
    <section className={`${einvoiceCard} mt-8`} aria-labelledby="einvoice-panel-title" aria-busy={isBusy}>
      <h2 id="einvoice-panel-title" className="text-base font-semibold text-primary sm:text-sm">
        {t("invoices.einvoice.panel.title")}
      </h2>

      {model.notices.map((key) => (
        <p key={key} className="mt-3 break-words rounded-doc-sm border border-doc-border bg-surface-2 px-3 py-2 text-sm text-secondary">
          {t(key)}
        </p>
      ))}

      {feedback && (
        <p
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`mt-3 break-words rounded-doc-sm border px-3 py-2 text-sm ${feedback.tone === "error" ? "border-danger/30 text-danger" : "border-success/30 text-primary"}`}
        >
          {t(feedback.key)}
        </p>
      )}

      {model.showReadiness && readiness && (
        <div className="mt-4 min-w-0">
          <h3 className="text-sm font-semibold text-primary">{t("invoices.einvoice.panel.readinessTitle")}</h3>
          {readiness.ready ? (
            <p className="mt-2 text-sm text-primary">
              <span aria-hidden="true">✓ </span>
              {t("invoices.einvoice.panel.ready")}
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-secondary">{t("invoices.einvoice.panel.notReady")}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-primary" data-testid="einvoice-readiness-issues">
                {readiness.issues.map((issue, index) => (
                  <li key={`${issue.code}-${index}`} className="break-words" data-code={issue.code}>
                    {readinessIssueText(issue, t, has)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {readiness.mode === "pre_finalize" && (
            <p className="mt-2 text-xs text-muted-esblu">
              {t("invoices.einvoice.panel.draftHint")} {t("invoices.einvoice.panel.finalizeFirst")}
            </p>
          )}
          {readiness.warnings.length > 0 && (
            <>
              <p className="mt-3 text-xs font-medium text-secondary">{t("invoices.einvoice.panel.warningsTitle")}</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-secondary">
                {readiness.warnings.map((w, index) => (
                  <li key={`${w.code}-${index}`} className="break-words">
                    {readinessIssueText(w, t, has)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {model.showSend && (
        <div className="mt-4">
          <button type="button" className={`${einvoiceButtonPrimary} w-full sm:w-auto`} onClick={onSend} disabled={isBusy} data-action="send">
            {busy === "send" ? t("invoices.einvoice.panel.sendingCta") : t("invoices.einvoice.panel.sendCta")}
          </button>
        </div>
      )}

      {current && (
        <div className="mt-5 min-w-0">
          <h3 className="text-sm font-semibold text-primary">{t("invoices.einvoice.panel.statusTitle")}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <EinvoiceStatusPill tone={outboundTone(current)} label={t(outboundStateKey(current.state, has))} />
            <span className="text-xs text-secondary">{t("invoices.einvoice.panel.attemptLabel", { attempt: current.attempt })}</span>
          </div>
          <p className="mt-1 text-xs text-secondary">{t("invoices.einvoice.panel.lastChange", { time: formatDateTime(current.updatedAt) })}</p>
          {outboundStateHintKey(current, has) && (
            <p className="mt-2 break-words text-sm text-secondary">{t(outboundStateHintKey(current, has)!)}</p>
          )}
          {current.lastErrorCode && current.state !== "delivered" && (
            <p className="mt-2 break-words text-sm text-secondary" data-error-code={current.lastErrorCode}>
              {t(transportMessageKey(current.lastErrorCode, has)!)}
            </p>
          )}

          {model.showEvidence && (
            <div className="mt-3 rounded-doc-sm border border-success/30 px-3 py-2 text-sm" data-testid="einvoice-evidence">
              <p className="font-semibold text-primary">
                <span aria-hidden="true">✓ </span>
                {t("invoices.einvoice.evidence.title")}
              </p>
              {(current.evidence?.deliveredAt ?? current.deliveredAt) && (
                <p className="text-xs text-secondary">
                  {t("invoices.einvoice.evidence.deliveredAt", { time: formatDateTime((current.evidence?.deliveredAt ?? current.deliveredAt)!) })}
                </p>
              )}
              {current.evidence && current.evidence.transactions > 0 && (
                <p className="text-xs text-secondary">{t("invoices.einvoice.evidence.transactions", { count: current.evidence.transactions })}</p>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {model.showDownload && (
              <button type="button" className={einvoiceButtonSecondary} onClick={() => onDownload(current.id)} disabled={isBusy} data-action="download">
                {busy === "download" ? t("invoices.einvoice.panel.downloading") : t("invoices.einvoice.panel.downloadUbl")}
              </button>
            )}
            {model.actions.includes("reconcile") && (
              <button type="button" className={einvoiceButtonSecondary} onClick={() => onAction("reconcile", current.id)} disabled={isBusy} data-action="reconcile">
                {busy === "reconcile" ? t("invoices.einvoice.actions.working") : t("invoices.einvoice.actions.reconcile")}
              </button>
            )}
            {model.actions.includes("retry") && (
              <button type="button" className={einvoiceButtonPrimary} onClick={() => onAction("retry", current.id)} disabled={isBusy} data-action="retry">
                {busy === "retry" ? t("invoices.einvoice.actions.working") : t("invoices.einvoice.actions.retry")}
              </button>
            )}
          </div>

          {model.previous.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs font-medium text-secondary">{t("invoices.einvoice.panel.previousAttempts")}</summary>
              <ul className="mt-2 space-y-1 text-xs text-secondary">
                {model.previous.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <span>{t("invoices.einvoice.panel.attemptLabel", { attempt: a.attempt })}</span>
                    <EinvoiceStatusPill tone={outboundTone(a)} label={t(outboundStateKey(a.state, has))} />
                  </li>
                ))}
              </ul>
            </details>
          )}

          <h3 className="mt-5 text-sm font-semibold text-primary">{t("invoices.einvoice.panel.timelineTitle")}</h3>
          <div className="mt-2">
            <EinvoiceTimeline items={summary.timeline} t={t} has={has} formatDateTime={formatDateTime} />
          </div>
        </div>
      )}
    </section>
  );
}
