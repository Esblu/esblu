"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { hasTranslation } from "@/lib/i18n/translate";
import { formatDate, formatDateTime, formatMoney } from "@/lib/i18n/format";
import { confirmAction } from "@/app/components/ui/AppDialog";
import { invoiceDetailHref } from "@/lib/entity-links";
import { downloadEinvoiceDocument, getEinvoiceJson, requestEinvoiceSend, runEinvoiceAction } from "@/lib/einvoice/ui/client";
import type { InvoiceEinvoiceSummaryDto } from "@/lib/einvoice/ui/types";
import { feedbackFor, type Feedback } from "@/lib/einvoice/ui/view-model";
import { OutboundPanelView } from "./OutboundPanelView";
import { InboundDetailView } from "./InboundViews";

// =============================================================================
// Kontajner panelu „E-Faktúra" v detaile faktúry (web aj natívna appka).
// Načíta súhrn zo servera; o oprávneniach rozhoduje server (403 → panel sa
// nezobrazí). Každá akcia: potvrdenie → jeden request → zrozumiteľná správa
// → opätovné načítanie stavu. Počas requestu sú tlačidlá zablokované
// (ochrana pred dvojitým klikom aj cez ref, nielen cez state).
// =============================================================================

type Busy = null | "send" | "download" | "reconcile" | "retry" | "reprocess" | "ackRetry";

const ROUTE = {
  reconcile: "outbound/reconcile",
  retry: "outbound/retry",
  reprocess: "inbound/reprocess",
  ackRetry: "inbound/ack-retry",
} as const;

const CONFIRM_KEY = {
  reconcile: "invoices.einvoice.actions.reconcileConfirm",
  retry: "invoices.einvoice.actions.retryConfirm",
  reprocess: "invoices.einvoice.actions.reprocessConfirm",
  ackRetry: "invoices.einvoice.actions.ackRetryConfirm",
} as const;

export function useEinvoiceHelpers() {
  const { t, locale } = useLocale();
  const has = useCallback((key: string) => hasTranslation(locale, key), [locale]);
  const fmtDateTime = useCallback((iso: string) => formatDateTime(iso, locale), [locale]);
  const fmtDate = useCallback((iso: string) => formatDate(iso, locale), [locale]);
  const fmtMoney = useCallback((amount: number, currency: string | null) => formatMoney(amount, currency, locale), [locale]);
  return { t, locale, has, fmtDateTime, fmtDate, fmtMoney };
}

/** Spoločná logika akcií (send / operátorské akcie / stiahnutie) s ochranou proti dvojkliku. */
export function useEinvoiceActions(reload: () => Promise<void>) {
  const { t, locale } = useLocale();
  const [busy, setBusy] = useState<Busy>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const inFlight = useRef(false);

  const guard = useCallback(
    async (kind: Exclude<Busy, null>, run: () => Promise<Feedback | null>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(kind);
      setFeedback(null);
      try {
        const result = await run();
        if (result) setFeedback(result);
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
    },
    []
  );

  const send = useCallback(
    async (invoiceId: string) => {
      if (inFlight.current) return;
      const ok = await confirmAction({
        title: t("invoices.einvoice.panel.sendConfirmTitle"),
        message: t("invoices.einvoice.panel.sendConfirmBody"),
        confirmLabel: t("invoices.einvoice.panel.sendConfirmLabel"),
      });
      if (!ok) return;
      await guard("send", async () => {
        const res = await requestEinvoiceSend(invoiceId, locale);
        await reload();
        return feedbackFor(res.status, res.code);
      });
    },
    [guard, locale, reload, t]
  );

  const action = useCallback(
    async (kind: keyof typeof ROUTE, id: string) => {
      if (inFlight.current) return;
      const ok = await confirmAction({
        title: t(`invoices.einvoice.actions.${kind}`),
        message: t(CONFIRM_KEY[kind]),
        confirmLabel: t("invoices.einvoice.actions.confirm"),
      });
      if (!ok) return;
      await guard(kind, async () => {
        const res = await runEinvoiceAction(ROUTE[kind], id, locale);
        await reload();
        return feedbackFor(res.status, res.code);
      });
    },
    [guard, locale, reload, t]
  );

  const download = useCallback(
    async (path: string, fileName: string) => {
      await guard("download", async () => {
        const ok = await downloadEinvoiceDocument(path, fileName, locale);
        return ok ? null : { tone: "error", key: "invoices.einvoice.errors.DOWNLOAD_FAILED" };
      });
    },
    [guard, locale]
  );

  return { busy, feedback, send, action, download };
}

export function renderInvoiceLink(invoiceId: string, label: string) {
  return (
    <Link href={invoiceDetailHref(invoiceId)} className="font-medium text-primary underline underline-offset-2">
      {label}
    </Link>
  );
}

export default function EinvoiceInvoicePanel({ invoiceId }: { invoiceId: string }) {
  const h = useEinvoiceHelpers();
  const [summary, setSummary] = useState<InvoiceEinvoiceSummaryDto | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");

  const fetchSummary = useCallback(async (): Promise<{ state: "ready" | "hidden" | "error"; data: InvoiceEinvoiceSummaryDto | null }> => {
    const res = await getEinvoiceJson<InvoiceEinvoiceSummaryDto>(`/api/invoices/${encodeURIComponent(invoiceId)}/einvoice`, h.locale);
    if (res.status === 200 && res.body) return { state: "ready", data: res.body };
    // Bez finančného prístupu (alebo bez faktúry) sa panel nezobrazí vôbec.
    if (res.status === 401 || res.status === 403 || res.status === 404) return { state: "hidden", data: null };
    return { state: "error", data: null };
  }, [invoiceId, h.locale]);

  const apply = useCallback((r: { state: "ready" | "hidden" | "error"; data: InvoiceEinvoiceSummaryDto | null }) => {
    if (r.data) setSummary(r.data);
    setState(r.state);
  }, []);

  const load = useCallback(async () => apply(await fetchSummary()), [apply, fetchSummary]);

  useEffect(() => {
    if (!invoiceId) return;
    let active = true;
    void fetchSummary().then((r) => {
      if (active) apply(r);
    });
    return () => {
      active = false;
    };
  }, [invoiceId, fetchSummary, apply]);

  const actions = useEinvoiceActions(load);

  if (state === "hidden" || !invoiceId) return null;
  if (state === "loading") {
    return (
      <p className="mt-8 text-sm text-secondary" role="status">
        {h.t("invoices.einvoice.panel.loading")}
      </p>
    );
  }
  if (state === "error" || !summary) {
    return (
      <div className="mt-8 flex flex-wrap items-center gap-3 text-sm" role="alert">
        <span className="text-secondary">{h.t("invoices.einvoice.panel.loadFailed")}</span>
        <button type="button" className="font-medium text-primary underline underline-offset-2" onClick={() => void load()}>
          {h.t("invoices.einvoice.panel.reload")}
        </button>
      </div>
    );
  }

  if (summary.kind === "outbound") {
    const busy = actions.busy === "reprocess" || actions.busy === "ackRetry" ? null : actions.busy;
    return (
      <OutboundPanelView
        summary={summary}
        t={h.t}
        has={h.has}
        formatDateTime={h.fmtDateTime}
        busy={busy}
        feedback={actions.feedback}
        onSend={() => void actions.send(invoiceId)}
        onDownload={(attemptId) =>
          void actions.download(`/api/einvoice/outbound/${encodeURIComponent(attemptId)}/ubl`, `einvoice-sent-${attemptId}.xml`)
        }
        onAction={(kind, attemptId) => void actions.action(kind, attemptId)}
      />
    );
  }

  if (summary.kind === "inbound") {
    const busy = actions.busy === "download" || actions.busy === "reprocess" || actions.busy === "ackRetry" ? actions.busy : null;
    return (
      <InboundDetailView
        embedded
        detail={summary}
        t={h.t}
        has={h.has}
        formatDateTime={h.fmtDateTime}
        formatDate={h.fmtDate}
        formatMoney={h.fmtMoney}
        busy={busy}
        feedback={actions.feedback}
        onDownloadXml={(id) => void actions.download(`/api/einvoice/inbound/${encodeURIComponent(id)}/xml`, `einvoice-received-${id}.xml`)}
        onAction={(kind, id) => void actions.action(kind, id)}
        renderInvoiceLink={renderInvoiceLink}
      />
    );
  }

  return null;
}
