"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import BackLink from "@/app/components/BackLink";
import { DocumentPageShell, DocumentHeader, DocumentNotice } from "@/app/components/document/DocumentLayout";
import InvoicesIcon from "@/app/components/icons/InvoicesIcon";
import { getMyActiveMembership, hasFinanceView } from "@/lib/company";
import { getEinvoiceJson } from "@/lib/einvoice/ui/client";
import type { InboundDetailDto, InboundListDto } from "@/lib/einvoice/ui/types";
import { InboundDetailView, InboundListView } from "@/app/components/einvoice/InboundViews";
import { renderInvoiceLink, useEinvoiceActions, useEinvoiceHelpers } from "@/app/components/einvoice/EinvoiceInvoicePanel";

// =============================================================================
// Prijaté e-faktúry (Peppol / eFaktúra) — statická routa /faktury/efaktury
// (detail cez ?id=), rovnaká pre web aj natívnu appku. Zoznam a detail vidí
// iba používateľ s finančným prístupom; server to overí znova (RLS + 403).
// =============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "forbidden" } | { state: "notFound" } | { state: "error" };

function InboundDetailSection({ id }: { id: string }) {
  const h = useEinvoiceHelpers();
  const [load, setLoad] = useState<Load<InboundDetailDto>>({ state: "loading" });

  const fetchDetail = useCallback(async (): Promise<Load<InboundDetailDto>> => {
    const res = await getEinvoiceJson<InboundDetailDto>(`/api/einvoice/inbound/${encodeURIComponent(id)}`, h.locale);
    if (res.status === 200 && res.body) return { state: "ready", data: res.body };
    if (res.status === 401 || res.status === 403) return { state: "forbidden" };
    if (res.status === 404 || res.status === 400) return { state: "notFound" };
    return { state: "error" };
  }, [id, h.locale]);

  const reload = useCallback(async () => setLoad(await fetchDetail()), [fetchDetail]);

  useEffect(() => {
    let active = true;
    void fetchDetail().then((r) => {
      if (active) setLoad(r);
    });
    return () => {
      active = false;
    };
  }, [fetchDetail]);

  const actions = useEinvoiceActions(reload);

  if (load.state === "loading") return <p className="mt-6 text-sm text-secondary" role="status">{h.t("invoices.einvoice.panel.loading")}</p>;
  if (load.state === "forbidden") return <div className="mt-6"><DocumentNotice>{h.t("invoices.noFinanceAccess")}</DocumentNotice></div>;
  if (load.state === "notFound") return <div className="mt-6"><DocumentNotice>{h.t("invoices.einvoice.errors.NOT_FOUND")}</DocumentNotice></div>;
  if (load.state === "error") {
    return (
      <div className="mt-6 flex flex-wrap items-center gap-3 text-sm" role="alert">
        <span className="text-secondary">{h.t("invoices.einvoice.panel.loadFailed")}</span>
        <button type="button" className="font-medium text-primary underline underline-offset-2" onClick={() => void reload()}>
          {h.t("invoices.einvoice.panel.reload")}
        </button>
      </div>
    );
  }
  const busy = actions.busy === "download" || actions.busy === "reprocess" || actions.busy === "ackRetry" ? actions.busy : null;
  return (
    <div className="mt-6">
      <InboundDetailView
        detail={load.data}
        t={h.t}
        has={h.has}
        formatDateTime={h.fmtDateTime}
        formatDate={h.fmtDate}
        formatMoney={h.fmtMoney}
        busy={busy}
        feedback={actions.feedback}
        onDownloadXml={(xid) => void actions.download(`/api/einvoice/inbound/${encodeURIComponent(xid)}/xml`, `einvoice-received-${xid}.xml`)}
        onAction={(kind, xid) => void actions.action(kind, xid)}
        renderInvoiceLink={renderInvoiceLink}
      />
    </div>
  );
}

function InboundListSection() {
  const h = useEinvoiceHelpers();
  const router = useRouter();
  const [load, setLoad] = useState<Load<InboundListDto>>({ state: "loading" });

  const fetchList = useCallback(async (): Promise<Load<InboundListDto>> => {
    const res = await getEinvoiceJson<InboundListDto>("/api/einvoice/inbound", h.locale);
    if (res.status === 200 && res.body) return { state: "ready", data: res.body };
    if (res.status === 401 || res.status === 403) return { state: "forbidden" };
    return { state: "error" };
  }, [h.locale]);

  const reload = useCallback(async () => setLoad(await fetchList()), [fetchList]);

  useEffect(() => {
    let active = true;
    void fetchList().then((r) => {
      if (active) setLoad(r);
    });
    return () => {
      active = false;
    };
  }, [fetchList]);

  if (load.state === "loading") return <p className="mt-6 text-sm text-secondary" role="status">{h.t("invoices.einvoice.panel.loading")}</p>;
  if (load.state === "forbidden") return <div className="mt-6"><DocumentNotice>{h.t("invoices.noFinanceAccess")}</DocumentNotice></div>;
  if (load.state !== "ready") {
    return (
      <div className="mt-6 flex flex-wrap items-center gap-3 text-sm" role="alert">
        <span className="text-secondary">{h.t("invoices.einvoice.panel.loadFailed")}</span>
        <button type="button" className="font-medium text-primary underline underline-offset-2" onClick={() => void reload()}>
          {h.t("invoices.einvoice.panel.reload")}
        </button>
      </div>
    );
  }
  return (
    <div className="mt-6 min-w-0">
      {load.data.access.providerConfigured && !load.data.access.rolloutEnabled && (
        <p className="mb-3 break-words rounded-doc-sm border border-doc-border bg-surface-2 px-3 py-2 text-sm text-secondary">
          {h.t("invoices.einvoice.panel.rolloutDisabled")}
        </p>
      )}
      {!load.data.access.entitlementActive && (
        <p className="mb-3 break-words rounded-doc-sm border border-doc-border bg-surface-2 px-3 py-2 text-sm text-secondary">
          {h.t("invoices.einvoice.panel.entitlementRequired")}
        </p>
      )}
      <InboundListView
        items={load.data.items}
        t={h.t}
        has={h.has}
        formatDateTime={h.fmtDateTime}
        formatDate={h.fmtDate}
        formatMoney={h.fmtMoney}
        onOpen={(id) => router.push(`/faktury/efaktury?id=${encodeURIComponent(id)}`)}
      />
    </div>
  );
}

function ReceivedEinvoicesRoute() {
  const { t } = useEinvoiceHelpers();
  const rawId = useSearchParams().get("id") ?? "";
  const id = UUID.test(rawId) ? rawId : "";
  const [access, setAccess] = useState<"loading" | "allowed" | "denied">("loading");

  useEffect(() => {
    let cancelled = false;
    void getMyActiveMembership()
      .then((m) => {
        if (!cancelled) setAccess(hasFinanceView(m) ? "allowed" : "denied");
      })
      .catch(() => {
        if (!cancelled) setAccess("denied");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <DocumentPageShell moduleContext="invoices">
      <BackLink
        href={id ? "/faktury/efaktury" : "/faktury"}
        label={id ? t("invoices.einvoice.inbound.backToList") : t("invoices.backToList")}
        className="mb-3 sm:mb-6"
      />
      <DocumentHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <InvoicesIcon size={18} />
            {t("invoices.title")}
          </span>
        }
        title={t("invoices.einvoice.inbound.pageTitle")}
        meta={t("invoices.einvoice.inbound.pageIntro")}
      />
      {access === "loading" && <p className="mt-6 text-sm text-secondary" role="status">{t("invoices.einvoice.panel.loading")}</p>}
      {access === "denied" && (
        <div className="mt-6">
          <DocumentNotice>{t("invoices.noFinanceAccess")}</DocumentNotice>
        </div>
      )}
      {access === "allowed" && (id ? <InboundDetailSection key={id} id={id} /> : <InboundListSection />)}
    </DocumentPageShell>
  );
}

export default function ReceivedEinvoicesPage() {
  return (
    <Suspense fallback={null}>
      <ReceivedEinvoicesRoute />
    </Suspense>
  );
}
