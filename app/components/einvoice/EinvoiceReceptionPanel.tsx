"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { enrollEinvoiceReception, getEinvoiceJson } from "@/lib/einvoice/ui/client";
import { useEinvoiceHelpers } from "@/app/components/einvoice/EinvoiceInvoicePanel";

// =============================================================================
// E-Faktúra — stav PRÍJMU (oddelene od odosielania) a aktivácia príjmu FS
// overovacím kódom. Server je autorita: zobrazenie aj formulár riadi odpoveď
// /api/einvoice/reception (RLS + finance.view / finance.manage). Employee
// dostane 403 a panel sa nezobrazí. Kód sa po odoslaní okamžite vymaže,
// nikam sa neukladá (žiadne úložisko prehliadača, žiadne logovanie).
// =============================================================================

type ReceptionState = "not_configured" | "pending" | "active" | "send_only" | "failed" | "deactivated" | "legacy";
type ReceptionDto = {
  access: { financeView: true; financeManage: boolean; entitlementActive: boolean; providerConfigured: boolean; rolloutEnabled: boolean };
  environment: "sandbox" | "live" | null;
  reception: { state: ReceptionState; receivingActive: boolean; sendingEnabled: boolean; errorCode: string | null };
};
type Load = { state: "loading" } | { state: "hidden" } | { state: "error" } | { state: "ready"; data: ReceptionDto };

const TONE: Record<ReceptionState, string> = {
  active: "bg-emerald-100 text-emerald-900",
  pending: "bg-amber-100 text-amber-900",
  send_only: "bg-sky-100 text-sky-900",
  failed: "bg-red-100 text-red-900",
  deactivated: "bg-slate-200 text-slate-900",
  not_configured: "bg-slate-200 text-slate-900",
  legacy: "bg-slate-200 text-slate-900",
};

export default function EinvoiceReceptionPanel() {
  const h = useEinvoiceHelpers();
  const tr = h.t;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [code, setCode] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; code: string } | null>(null);
  const inFlight = useRef(false);

  const fetchState = useCallback(async (): Promise<Load> => {
    const res = await getEinvoiceJson<ReceptionDto>("/api/einvoice/reception", h.locale);
    if (res.status === 200 && res.body) return { state: "ready", data: res.body };
    if (res.status === 401 || res.status === 403) return { state: "hidden" };
    return { state: "error" };
  }, [h.locale]);

  useEffect(() => {
    let active = true;
    void fetchState().then((r) => {
      if (active) setLoad(r);
    });
    return () => {
      active = false;
    };
  }, [fetchState]);

  const submit = useCallback(async () => {
    if (inFlight.current) return;
    const value = code.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]{2,128}$/.test(value)) {
      setFeedback({ ok: false, code: "INVALID_CODE_FORMAT" });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    setCode(""); // kód sa nedrží v stave dlhšie, než je nutné
    try {
      const res = await enrollEinvoiceReception(value, h.locale);
      const ok = res.status === 200;
      setFeedback({ ok, code: res.code ?? (ok ? "ENROLLED" : "UNKNOWN") });
      setConfirmed(false);
      setLoad(await fetchState());
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [code, fetchState, h.locale]);

  if (load.state === "hidden") return null;
  if (load.state === "loading") return <p className="mt-4 text-sm text-secondary" role="status">{tr("invoices.einvoice.reception.loading")}</p>;
  if (load.state === "error") return <p className="mt-4 text-sm text-secondary" role="alert">{tr("invoices.einvoice.reception.loadFailed")}</p>;

  const { access, reception, environment } = load.data;
  const canActivate =
    access.financeManage && access.entitlementActive && access.providerConfigured && access.rolloutEnabled && reception.state !== "active";
  const msg = (key: string) => (h.has(key) ? tr(key) : null);

  return (
    <section className="mt-6 rounded-2xl border border-subtle p-4" aria-labelledby="einvoice-reception-title">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id="einvoice-reception-title" className="font-semibold text-primary">{tr("invoices.einvoice.reception.title")}</h4>
        {environment === "sandbox" && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">{tr("invoices.einvoice.reception.sandbox")}</span>
        )}
      </div>

      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-secondary">{tr("invoices.einvoice.reception.receivingLabel")}</dt>
          <dd className="mt-1">
            <span className={`inline-block rounded-full px-2.5 py-1 text-sm font-semibold ${TONE[reception.state]}`} data-testid="reception-state">
              {tr(`invoices.einvoice.reception.state.${reception.state}`)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-secondary">{tr("invoices.einvoice.reception.sendingLabel")}</dt>
          <dd className="mt-1">
            <span
              className={`inline-block rounded-full px-2.5 py-1 text-sm font-semibold ${reception.sendingEnabled ? "bg-emerald-100 text-emerald-900" : "bg-slate-200 text-slate-900"}`}
              data-testid="sending-state"
            >
              {tr(reception.sendingEnabled ? "invoices.einvoice.reception.sendingOn" : "invoices.einvoice.reception.sendingOff")}
            </span>
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-sm text-secondary">{tr(`invoices.einvoice.reception.explain.${reception.state}`)}</p>
      {reception.errorCode && reception.state !== "active" && (
        <p className="mt-2 text-sm text-red-700">{msg(`invoices.einvoice.reception.errors.${reception.errorCode}`) ?? tr("invoices.einvoice.reception.errors.GENERIC")}</p>
      )}

      {canActivate ? (
        <form
          className="mt-4 space-y-3"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block text-sm font-semibold" htmlFor="einvoice-fs-code">{tr("invoices.einvoice.reception.codeLabel")}</label>
          <input
            id="einvoice-fs-code"
            name="einvoice-fs-code"
            type="password"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-xl border p-3 font-mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={busy}
            maxLength={160}
          />
          <p className="text-xs text-secondary">{tr("invoices.einvoice.reception.codeHint")}</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />
            <span>{tr("invoices.einvoice.reception.confirm")}</span>
          </label>
          <button type="submit" className="btn-primary px-5 py-2.5 font-semibold disabled:opacity-60" disabled={busy || !confirmed || code.trim().length === 0}>
            {busy ? tr("invoices.einvoice.reception.submitting") : tr("invoices.einvoice.reception.submit")}
          </button>
        </form>
      ) : (
        reception.state !== "active" && (
          <p className="mt-4 text-sm text-secondary">
            {!access.financeManage
              ? tr("invoices.einvoice.reception.manageRequired")
              : !access.entitlementActive
                ? tr("invoices.einvoice.reception.entitlementRequired")
                : tr("invoices.einvoice.reception.notAvailable")}
          </p>
        )
      )}

      {feedback && (
        <p className={`mt-3 text-sm ${feedback.ok ? "text-emerald-800" : "text-red-700"}`} role={feedback.ok ? "status" : "alert"}>
          {msg(`invoices.einvoice.reception.result.${feedback.code}`) ?? tr(feedback.ok ? "invoices.einvoice.reception.result.ENROLLED" : "invoices.einvoice.reception.result.GENERIC")}
        </p>
      )}
    </section>
  );
}
