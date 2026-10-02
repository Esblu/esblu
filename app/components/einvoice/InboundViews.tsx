import type { ReactNode } from "react";
import type { InboundDetailDto, InboundItemDto } from "@/lib/einvoice/ui/types";
import {
  inboundAckKey,
  inboundActions,
  inboundErrorKey,
  inboundStateKey,
  inboundTone,
  reviewReasonKey,
  type Feedback,
  type HasKey,
  type Translate,
} from "@/lib/einvoice/ui/view-model";
import { EinvoiceStatusPill } from "./EinvoiceStatusPill";
import { EinvoiceTimeline } from "./EinvoiceTimeline";
import { einvoiceButtonPrimary, einvoiceButtonSecondary, einvoiceCard } from "./styles";

// =============================================================================
// Prijaté e-faktúry — prezentačné komponenty (iba props, žiadne I/O).
// Odkaz na koncept faktúry dodáva kontajner (renderInvoiceLink), aby sa
// použila zabalená routa webu aj appky.
// =============================================================================

type Common = {
  t: Translate;
  has: HasKey;
  formatDateTime: (iso: string) => string;
  formatDate: (iso: string) => string;
  formatMoney: (amount: number, currency: string | null) => string;
};

function Notice({ item, t, has }: { item: InboundItemDto } & Pick<Common, "t" | "has">) {
  if (item.notice === "credit_note_unsupported") {
    return (
      <p role="note" className="mt-2 break-words rounded-doc-sm border border-warning/40 px-3 py-2 text-sm text-primary" data-notice="credit_note_unsupported">
        <span aria-hidden="true">! </span>
        {t("invoices.einvoice.inbound.creditNoteUnsupported")}
      </p>
    );
  }
  const err = item.status === "failed" || item.lastErrorCode ? inboundErrorKey(item.lastErrorCode, has) : null;
  return err ? <p className="mt-2 break-words text-sm text-secondary" data-error-code={item.lastErrorCode ?? ""}>{t(err)}</p> : null;
}

export function InboundListView({
  items,
  onOpen,
  ...c
}: Common & { items: InboundItemDto[]; onOpen: (id: string) => void }) {
  if (items.length === 0) {
    return <p className="text-sm text-secondary">{c.t("invoices.einvoice.inbound.empty")}</p>;
  }
  return (
    <ul className="min-w-0 space-y-3" aria-label={c.t("invoices.einvoice.inbound.pageTitle")}>
      {items.map((item) => (
        <li key={item.id} className={einvoiceCard}>
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="break-words text-sm font-semibold text-primary">
                {item.supplierName ?? c.t("invoices.einvoice.inbound.unknownSupplier")}
              </p>
              <p className="break-words text-xs text-secondary">
                {c.t("invoices.einvoice.inbound.number")}: {item.documentNumber ?? "—"}
                {item.issueDate ? ` · ${c.formatDate(item.issueDate)}` : ""}
              </p>
            </div>
            {item.total !== null && (
              <p className="shrink-0 text-sm font-semibold tabular-nums text-primary">{c.formatMoney(item.total, item.currency)}</p>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-doc-sm border border-doc-border px-2 py-0.5 text-[11px] font-medium text-muted-esblu">
              {c.t("invoices.einvoice.inbound.sourceLabel")}
            </span>
            <EinvoiceStatusPill tone={inboundTone(item)} label={c.t(inboundStateKey(item.status, c.has))} />
            <span className="text-xs text-secondary">
              {c.t("invoices.einvoice.inbound.ack")}: {c.t(inboundAckKey(item))}
            </span>
            {item.status === "failed" && (
              <span className="text-xs font-semibold text-warning">{c.t("invoices.einvoice.inbound.manualReview")}</span>
            )}
            {item.isTest && <span className="text-xs text-muted-esblu">{c.t("invoices.einvoice.inbound.testDocument")}</span>}
          </div>
          <Notice item={item} t={c.t} has={c.has} />
          <div className="mt-3">
            <button type="button" className={`${einvoiceButtonSecondary} w-full sm:w-auto`} onClick={() => onOpen(item.id)}>
              {c.t("invoices.einvoice.inbound.detail")}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export type InboundDetailProps = Common & {
  detail: InboundDetailDto;
  busy: null | "download" | "reprocess" | "ackRetry";
  feedback: Feedback | null;
  onDownloadXml: (id: string) => void;
  onAction: (action: "reprocess" | "ackRetry", id: string) => void;
  renderInvoiceLink: (invoiceId: string, label: string) => ReactNode;
  /** true = zobrazené vo vnútri detailu faktúry (bez odkazu na samotný koncept). */
  embedded?: boolean;
};

export function InboundDetailView({ detail, busy, feedback, onDownloadXml, onAction, renderInvoiceLink, embedded = false, ...c }: InboundDetailProps) {
  const item = detail.item;
  const actions = inboundActions(detail);
  const isBusy = busy !== null;
  return (
    <section className={`${einvoiceCard} ${embedded ? "mt-8" : ""}`} aria-labelledby={`einvoice-inbound-${item.id}`} aria-busy={isBusy}>
      <h2 id={`einvoice-inbound-${item.id}`} className="text-base font-semibold text-primary sm:text-sm">
        {c.t("invoices.einvoice.panel.title")} · {c.t("invoices.einvoice.inbound.sourceLabel")}
      </h2>

      {detail.access.providerConfigured && !detail.access.rolloutEnabled && (
        <p className="mt-3 break-words rounded-doc-sm border border-doc-border bg-surface-2 px-3 py-2 text-sm text-secondary">
          {c.t("invoices.einvoice.panel.rolloutDisabled")}
        </p>
      )}
      {!detail.access.entitlementActive && (
        <p className="mt-3 break-words rounded-doc-sm border border-doc-border bg-surface-2 px-3 py-2 text-sm text-secondary">
          {c.t("invoices.einvoice.panel.entitlementRequired")}
        </p>
      )}
      {feedback && (
        <p role={feedback.tone === "error" ? "alert" : "status"} className={`mt-3 break-words rounded-doc-sm border px-3 py-2 text-sm ${feedback.tone === "error" ? "border-danger/30 text-danger" : "border-success/30 text-primary"}`}>
          {c.t(feedback.key)}
        </p>
      )}

      <dl className="mt-3 grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-secondary">{c.t("invoices.einvoice.inbound.supplier")}</dt>
          <dd className="break-words text-primary">{item.supplierName ?? c.t("invoices.einvoice.inbound.unknownSupplier")}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-secondary">{c.t("invoices.einvoice.inbound.number")}</dt>
          <dd className="break-words text-primary">{item.documentNumber ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-secondary">{c.t("invoices.einvoice.inbound.date")}</dt>
          <dd className="text-primary">{item.issueDate ? c.formatDate(item.issueDate) : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-secondary">{c.t("invoices.einvoice.inbound.total")}</dt>
          <dd className="tabular-nums text-primary">{item.total !== null ? c.formatMoney(item.total, item.currency) : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-secondary">{c.t("invoices.einvoice.inbound.receivedAt")}</dt>
          <dd className="text-primary">{c.formatDateTime(item.receivedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-secondary">{c.t("invoices.einvoice.inbound.ack")}</dt>
          <dd className="text-primary">{c.t(inboundAckKey(item))}</dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-secondary">{c.t("invoices.einvoice.inbound.processing")}:</span>
        <EinvoiceStatusPill tone={inboundTone(item)} label={c.t(inboundStateKey(item.status, c.has))} />
        {item.status === "failed" && <span className="text-xs font-semibold text-warning">{c.t("invoices.einvoice.inbound.manualReview")}</span>}
      </div>
      <Notice item={item} t={c.t} has={c.has} />
      {item.dedupeMatchedOn && <p className="mt-2 text-sm text-secondary">{c.t("invoices.einvoice.inbound.duplicateNote")}</p>}

      {item.reviewReasons.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-secondary">{c.t("invoices.einvoice.inbound.reviewReasonsTitle")}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-primary">
            {item.reviewReasons.map((code) => (
              <li key={code} className="break-words">{c.t(reviewReasonKey(code, c.has))}</li>
            ))}
          </ul>
        </div>
      )}

      {!embedded && (
        <div className="mt-3 text-sm">
          {item.invoiceId
            ? renderInvoiceLink(item.invoiceId, c.t(item.invoiceStatus === "draft" ? "invoices.einvoice.inbound.openDraft" : "invoices.einvoice.inbound.openInvoice"))
            : <span className="text-secondary">{c.t("invoices.einvoice.inbound.noDraft")}</span>}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {item.hasXml && (
          <button type="button" className={einvoiceButtonSecondary} onClick={() => onDownloadXml(item.id)} disabled={isBusy} data-action="download-xml">
            {busy === "download" ? c.t("invoices.einvoice.panel.downloading") : c.t("invoices.einvoice.inbound.downloadXml")}
          </button>
        )}
        {actions.includes("reprocess") && (
          <button type="button" className={einvoiceButtonPrimary} onClick={() => onAction("reprocess", item.id)} disabled={isBusy} data-action="reprocess">
            {busy === "reprocess" ? c.t("invoices.einvoice.actions.working") : c.t("invoices.einvoice.actions.reprocess")}
          </button>
        )}
        {actions.includes("ackRetry") && (
          <button type="button" className={einvoiceButtonSecondary} onClick={() => onAction("ackRetry", item.id)} disabled={isBusy} data-action="ack-retry">
            {busy === "ackRetry" ? c.t("invoices.einvoice.actions.working") : c.t("invoices.einvoice.actions.ackRetry")}
          </button>
        )}
      </div>

      <h3 className="mt-5 text-sm font-semibold text-primary">{c.t("invoices.einvoice.panel.timelineTitle")}</h3>
      <div className="mt-2">
        <EinvoiceTimeline items={detail.timeline} t={c.t} has={c.has} formatDateTime={c.formatDateTime} />
      </div>
    </section>
  );
}
