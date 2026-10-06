// =============================================================================
// E-Faktúra — Phase 5: používateľské UI.
//
// 1) SSR prezentačných komponentov (react-dom/server) so SKUTOČNÝMI
//    slovníkmi sk/en/de — readiness, odoslanie, stavy, dôkaz doručenia,
//    operátorské akcie, prijaté e-faktúry, nárok, prístupnosť.
// 2) Serverové zostavenie prehľadov (summary-server) nad fake user-scoped
//    klientom: 403 bez financií, allowlist polí (žiadne UUID / ID
//    poskytovateľa / cesty v storage), povolené akcie, dobropis.
// 3) Statické kontroly: telo POST, routy, mobilná statická routa + wrapper,
//    apiUrl most, žiadny hardcoded slovenský text, i18n kľúče v sk/en/de.
//
// Bez siete, bez kľúčov, bez Supabase. Hodnota ESBLU_EFAKTURA_API_KEY nižšie
// je neplatný placeholder iba na to, aby runtime config hlásil „nakonfigurované".
//
// SPUSTENIE: npm run test:einvoice-ui
// =============================================================================

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutboundPanelView, type OutboundPanelProps } from "../app/components/einvoice/OutboundPanelView.tsx";
import { InboundDetailView, InboundListView, type InboundDetailProps } from "../app/components/einvoice/InboundViews.tsx";
import { hasTranslation, translate } from "../lib/i18n/translate.ts";
import type { Locale } from "../lib/i18n/locales.ts";
import { allStaticKeys, feedbackFor, outboundPanelModel } from "../lib/einvoice/ui/view-model.ts";
import { inboundAllowedActions, outboundAllowedActions } from "../lib/einvoice/ops/allowed-actions.ts";
import { loadInboundDetail, loadInboundList, loadInvoiceEinvoiceSummary } from "../lib/einvoice/ui/summary-server.ts";
import { resolveAppHref } from "../lib/app-routes.ts";
import type {
  EinvoiceAccess,
  EinvoiceTimelineItem,
  InboundDetailDto,
  InboundItemDto,
  OutboundAttemptDto,
  OutboundSummaryDto,
} from "../lib/einvoice/ui/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${(error as Error).message.split("\n").join("\n    ")}`);
  }
}

// ----------------------------------------------------------------------------- helpers

const i18n = (locale: Locale) => ({
  t: (k: string, v?: Record<string, string | number>) => translate(locale, k, v),
  has: (k: string) => hasTranslation(locale, k),
});
const sk = i18n("sk");
const fmt = { formatDateTime: (s: string) => `@${s}`, formatDate: (s: string) => `#${s}`, formatMoney: (n: number, c: string | null) => `${n.toFixed(2)} ${c ?? ""}`.trim() };

const FULL: EinvoiceAccess = { financeManage: true, entitlementActive: true, providerConfigured: true, rolloutEnabled: true };
const NO_ENT: EinvoiceAccess = { financeManage: true, entitlementActive: false, providerConfigured: true, rolloutEnabled: true };
const NO_ROLLOUT: EinvoiceAccess = { ...FULL, rolloutEnabled: false };

function attempt(over: Partial<OutboundAttemptDto> = {}): OutboundAttemptDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    attempt: 1,
    state: "queued",
    category: "retryable",
    updatedAt: "2026-10-02T10:00:00Z",
    sentAt: null,
    deliveredAt: null,
    lastErrorCode: null,
    outcomeUnknown: false,
    hasDocument: true,
    evidence: null,
    ...over,
  };
}

const TIMELINE: EinvoiceTimelineItem[] = [
  { at: "2026-10-02T10:00:00Z", kind: "transition", from: null, to: "queued", source: "user", actor: "self", code: null },
  { at: "2026-10-02T10:01:00Z", kind: "transition", from: "queued", to: "sending", source: "system", actor: null, code: null },
];

function outbound(over: Partial<OutboundSummaryDto> = {}): OutboundSummaryDto {
  return {
    kind: "outbound",
    documentStatus: "finalized",
    access: FULL,
    readiness: { ready: true, mode: "send", issues: [], warnings: [] } as OutboundSummaryDto["readiness"],
    attempts: [],
    timeline: [],
    allowed: { send: false, reconcile: false, retry: false },
    ...over,
  };
}

function renderOutbound(summary: OutboundSummaryDto, over: Partial<OutboundPanelProps> = {}, loc = sk): string {
  return renderToStaticMarkup(
    createElement(OutboundPanelView, {
      summary,
      t: loc.t,
      has: loc.has,
      formatDateTime: fmt.formatDateTime,
      busy: null,
      feedback: null,
      onSend() {},
      onDownload() {},
      onAction() {},
      ...over,
    })
  );
}

function inboundItem(over: Partial<InboundItemDto> = {}): InboundItemDto {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    status: "acknowledged",
    category: "acknowledged",
    receivedAt: "2026-10-01T08:00:00Z",
    updatedAt: "2026-10-01T08:05:00Z",
    acknowledgedAt: "2026-10-01T08:05:00Z",
    documentNumber: "FA-2026-0042",
    documentType: "380",
    issueDate: "2026-09-30",
    invoiceId: "33333333-3333-4333-8333-333333333333",
    invoiceStatus: "draft",
    supplierName: "Dodávateľ s.r.o.",
    total: 123.45,
    currency: "EUR",
    lastErrorCode: null,
    reviewReasons: [],
    dedupeMatchedOn: null,
    isTest: false,
    hasXml: true,
    notice: null,
    ...over,
  };
}

function inboundDetail(item: InboundItemDto, over: Partial<InboundDetailDto> = {}): InboundDetailDto {
  return { kind: "inbound", access: FULL, item, timeline: [], allowed: { reprocess: false, ackRetry: false }, ...over };
}

function renderInbound(detail: InboundDetailDto, over: Partial<InboundDetailProps> = {}, loc = sk): string {
  return renderToStaticMarkup(
    createElement(InboundDetailView, {
      detail,
      ...loc,
      ...fmt,
      busy: null,
      feedback: null,
      onDownloadXml() {},
      onAction() {},
      renderInvoiceLink: (id: string, label: string) => createElement("a", { href: `/faktury/${id}`, "data-link": "invoice" }, label),
      ...over,
    })
  );
}

const has = (html: string, s: string) => html.includes(s);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const action = (html: string, a: string) => html.includes(`data-action="${a}"`);

// ============================================================================= 1) OUTBOUND UI
console.log("Outbound panel (SSR)");

await test("readiness NOT ready → zoznam preložených problémov, žiadne tlačidlo odoslania", () => {
  const html = renderOutbound(
    outbound({
      readiness: { ready: false, mode: "send", issues: [{ code: "MISSING_BUYER_ENDPOINT" }, { code: "SOME_FUTURE_CODE" }], warnings: [] } as never,
    })
  );
  assert.ok(has(html, 'data-testid="einvoice-readiness-issues"'));
  assert.ok(has(html, 'data-code="MISSING_BUYER_ENDPOINT"'));
  assert.ok(has(html, sk.t("invoices.einvoice.panel.notReady")));
  assert.ok(!action(html, "send"));
  // neznámy kód = všeobecná veta s kódom, nie pád
  assert.ok(has(html, sk.t("invoices.einvoice.issueUnknown", { code: "SOME_FUTURE_CODE" })));
});

await test("readiness ready + server povolí → „Odoslať ako eFaktúru“", () => {
  const html = renderOutbound(outbound({ allowed: { send: true, reconcile: false, retry: false } }));
  assert.ok(action(html, "send"));
  assert.ok(has(html, "Odoslať ako eFaktúru"));
  assert.ok(has(html, sk.t("invoices.einvoice.panel.ready")));
});

await test("ready, ale server nepovolí (allowed.send=false) → UI tlačidlo neponúkne (neduplikuje logiku)", () => {
  const html = renderOutbound(outbound());
  assert.ok(!action(html, "send"));
});

await test("potvrdenie odoslania vysvetľuje nemenné UBL + zaradenie do frontu (sk/en/de)", () => {
  for (const loc of ["sk", "en", "de"] as const) {
    const body = translate(loc, "invoices.einvoice.panel.sendConfirmBody");
    assert.ok(body.length > 40 && !body.startsWith("invoices."), `${loc}: ${body}`);
  }
  assert.match(translate("sk", "invoices.einvoice.panel.sendConfirmBody"), /UBL/);
  assert.match(translate("sk", "invoices.einvoice.panel.sendConfirmBody"), /nemenn/i);
});

await test("počas requestu (busy=send) je tlačidlo disabled → dvojklik nemožný", () => {
  const html = renderOutbound(outbound({ allowed: { send: true, reconcile: false, retry: false } }), { busy: "send" });
  assert.match(html, /<button[^>]*disabled=""[^>]*data-action="send"/);
  assert.ok(has(html, sk.t("invoices.einvoice.panel.sendingCta")));
  assert.ok(has(html, 'aria-busy="true"'));
});

await test("stavové štítky presne podľa zadania (SK)", () => {
  const expected: Record<string, string> = {
    queued: "Čaká na odoslanie",
    sending: "Odosiela sa",
    sent: "Odoslané poskytovateľovi",
    deferred: "Doručenie odložené",
    delivered: "Doručené",
    rejected: "Odmietnuté",
    failed: "Zlyhalo",
  };
  for (const [state, label] of Object.entries(expected)) {
    const html = renderOutbound(outbound({ attempts: [attempt({ state })], timeline: TIMELINE }));
    assert.ok(has(html, label), `${state} → ${label}`);
    assert.ok(has(html, "@2026-10-02T10:00:00Z"), "čas poslednej zmeny");
    assert.ok(has(html, 'role="status"'));
  }
});

await test("delivered → „Doručenie potvrdené“, čas, počet transakcií; stiahnutie UBL", () => {
  const html = renderOutbound(
    outbound({
      attempts: [attempt({ state: "delivered", category: "delivered", deliveredAt: "2026-10-02T11:00:00Z", evidence: { deliveryState: "delivered", deliveredAt: "2026-10-02T11:00:00Z", transactions: 2 } })],
      timeline: TIMELINE,
    })
  );
  assert.ok(has(html, 'data-testid="einvoice-evidence"'));
  assert.ok(has(html, "Doručenie potvrdené"));
  assert.ok(has(html, "@2026-10-02T11:00:00Z"));
  assert.ok(action(html, "download"));
  assert.ok(has(html, "Stiahnuť UBL/XML"));
  assert.ok(!action(html, "retry") && !action(html, "reconcile"));
});

await test("rejected → štítok, preložená chyba (nie surový kód), „Skúsiť nové odoslanie“ iba ak server povolí", () => {
  const rejected = attempt({ state: "rejected", category: "rejected", lastErrorCode: "EINVOICE_REJECTED" });
  const allowed = renderOutbound(outbound({ attempts: [rejected], allowed: { send: false, reconcile: false, retry: true } }));
  assert.ok(has(allowed, "Odmietnuté"));
  assert.ok(action(allowed, "retry"));
  assert.ok(has(allowed, "Skúsiť nové odoslanie"));
  assert.ok(!has(allowed, ">EINVOICE_REJECTED<"), "surový kód sa nezobrazuje ako text");
  const denied = renderOutbound(outbound({ attempts: [rejected], allowed: { send: false, reconcile: false, retry: false } }));
  assert.ok(!action(denied, "retry"));
});

await test("retry_exhausted_unknown → IBA „Overiť u poskytovateľa“, NIKDY „Odoslať znova“ (aj keby server poslal retry=true)", () => {
  const unknown = attempt({ state: "sending", category: "retry_exhausted_unknown", lastErrorCode: "EINVOICE_RETRY_EXHAUSTED_UNKNOWN", outcomeUnknown: true });
  const html = renderOutbound(outbound({ attempts: [unknown], allowed: { send: false, reconcile: true, retry: true } }));
  assert.ok(action(html, "reconcile"));
  assert.ok(has(html, "Overiť u poskytovateľa"));
  assert.ok(!action(html, "retry"));
  assert.ok(!action(html, "send"));
  assert.ok(has(html, sk.t("invoices.einvoice.stateHint.unknown")));
  assert.deepEqual(outboundPanelModel(outbound({ attempts: [unknown], allowed: { send: true, reconcile: true, retry: true } })).actions, ["reconcile"]);
});

await test("failed + retry povolený → tlačidlo retry; predchádzajúce pokusy v <details>", () => {
  const html = renderOutbound(
    outbound({
      attempts: [attempt({ id: "a2", attempt: 2, state: "failed", category: "permanent_failure", lastErrorCode: "EINVOICE_SEND_FAILED" }), attempt({ id: "a1", attempt: 1, state: "rejected", category: "rejected" })],
      allowed: { send: false, reconcile: false, retry: true },
    })
  );
  assert.ok(action(html, "retry"));
  assert.ok(has(html, "<details"));
  assert.ok(has(html, sk.t("invoices.einvoice.panel.attemptLabel", { attempt: 2 })));
});

await test("bez nároku einvoice → história + UBL ostávajú, neutrálny oznam, žiadne send/retry", () => {
  const html = renderOutbound(
    outbound({
      access: NO_ENT,
      attempts: [attempt({ state: "rejected", category: "rejected" })],
      timeline: TIMELINE,
      allowed: { send: false, reconcile: false, retry: false },
    })
  );
  assert.ok(has(html, sk.t("invoices.einvoice.panel.entitlementRequired")));
  assert.ok(action(html, "download"));
  assert.ok(!action(html, "send") && !action(html, "retry"));
  assert.ok(has(html, "<ol"), "časová os viditeľná");
  assert.ok(!/predplat|subscription|billing|cena|price/i.test(sk.t("invoices.einvoice.panel.entitlementRequired")), "žiadny billing");
});

await test("poskytovateľ nenakonfigurovaný → panel funguje, oznam, žiadne CTA", () => {
  const html = renderOutbound(outbound({ access: { ...FULL, providerConfigured: false } }));
  assert.ok(has(html, sk.t("invoices.einvoice.panel.notConfigured")));
  assert.ok(!action(html, "send"));
});

await test("časová os: čitateľný názov, zdroj, <time dateTime>, žiadne UUID", () => {
  const html = renderOutbound(outbound({ attempts: [attempt({ state: "sending" })], timeline: TIMELINE }));
  assert.ok(has(html, sk.t("invoices.einvoice.events.created")));
  assert.ok(has(html, sk.t("invoices.einvoice.source.self")));
  assert.ok(has(html, sk.t("invoices.einvoice.source.system")));
  assert.ok(has(html, '<time dateTime="2026-10-02T10:00:00Z"'));
  // jediné UUID v HTML by mohlo byť ID pokusu — panel ho do textu nepíše
  assert.ok(!UUID_RE.test(html), "žiadne UUID v markup-e");
});

await test("cudzí používateľ v časovej osi → „Používateľ“, nie UUID", () => {
  const html = renderOutbound(outbound({ attempts: [attempt()], timeline: [{ ...TIMELINE[0], actor: "user" }] }));
  assert.ok(has(html, sk.t("invoices.einvoice.source.user")));
  assert.equal(sk.t("invoices.einvoice.source.user"), "Používateľ");
});

await test("feedback: 409/429/RECONCILE_REQUIRED/ALREADY_REQUESTED → zrozumiteľná správa, role=alert/status", () => {
  assert.equal(feedbackFor(200, "ALREADY_REQUESTED").key, "invoices.einvoice.result.ALREADY_REQUESTED");
  assert.equal(feedbackFor(200, "ALREADY_REQUESTED").tone, "info");
  assert.equal(feedbackFor(409, "ESBLU_EINVOICE_RECONCILE_REQUIRED").key, "invoices.einvoice.errors.RECONCILE_REQUIRED");
  assert.equal(feedbackFor(429, "ESBLU_EINVOICE_RATE_LIMITED").key, "invoices.einvoice.errors.RATE_LIMITED");
  assert.equal(feedbackFor(429, null).key, "invoices.einvoice.errors.RATE_LIMITED");
  assert.equal(feedbackFor(409, "ESBLU_EINVOICE_ACTION_IN_PROGRESS").key, "invoices.einvoice.errors.IN_PROGRESS");
  assert.equal(feedbackFor(409, "SOMETHING_NEW").key, "invoices.einvoice.errors.NOT_ALLOWED");
  assert.equal(feedbackFor(500, "<script>").key, "invoices.einvoice.errors.generic");
  assert.equal(feedbackFor(0, "NETWORK").key, "invoices.einvoice.errors.generic");
  const err = renderOutbound(outbound(), { feedback: feedbackFor(409, "ESBLU_EINVOICE_RECONCILE_REQUIRED") });
  assert.ok(has(err, 'role="alert"') && has(err, "Overiť u poskytovateľa"));
  const ok = renderOutbound(outbound(), { feedback: feedbackFor(200, "QUEUED") });
  assert.ok(has(ok, 'role="status"'));
});

await test("panel v en/de bez slovenčiny a bez chýbajúcich kľúčov", () => {
  for (const loc of ["en", "de"] as const) {
    const html = renderOutbound(
      outbound({ attempts: [attempt({ state: "delivered", category: "delivered", evidence: { deliveryState: "delivered", deliveredAt: "2026-10-02T11:00:00Z", transactions: 1 } })], timeline: TIMELINE }),
      {},
      i18n(loc)
    );
    assert.ok(!/invoices\.einvoice\./.test(html), `${loc}: nepreložený kľúč`);
    assert.ok(!/[čďľňŕšťž]/i.test(html.replace(/E-Fakt[uú]ra/g, "")), `${loc}: slovenské znaky`);
  }
});

// ============================================================================= 2) INBOUND UI
console.log("Prijaté e-faktúry (SSR)");

await test("zoznam: dodávateľ, číslo, dátum, suma, mena, stav, ACK, zdroj „Peppol / eFaktúra“", () => {
  const html = renderToStaticMarkup(createElement(InboundListView, { items: [inboundItem()], ...sk, ...fmt, onOpen() {} }));
  for (const s of ["Dodávateľ s.r.o.", "FA-2026-0042", "#2026-09-30", "123.45 EUR", "Peppol / eFaktúra", sk.t("invoices.einvoice.inbound.ackDone")]) assert.ok(has(html, s), s);
  const empty = renderToStaticMarkup(createElement(InboundListView, { items: [], ...sk, ...fmt, onOpen() {} }));
  assert.ok(has(empty, sk.t("invoices.einvoice.inbound.empty")));
});

await test("received (ešte nespracované) → stav, ACK neodoslané, reprocess podľa servera", () => {
  const item = inboundItem({ status: "received", category: "retryable", invoiceId: null, invoiceStatus: null, supplierName: null, total: null, acknowledgedAt: null });
  const html = renderInbound(inboundDetail(item, { allowed: { reprocess: true, ackRetry: false } }));
  assert.ok(has(html, sk.t("invoices.einvoice.inboundState.received")));
  assert.ok(has(html, sk.t("invoices.einvoice.inbound.ackNotSent")));
  assert.ok(has(html, sk.t("invoices.einvoice.inbound.noDraft")));
  assert.ok(action(html, "reprocess") && has(html, "Spracovať znova"));
});

await test("acknowledged → potvrdené, odkaz na koncept, stiahnutie originálneho XML", () => {
  const html = renderInbound(inboundDetail(inboundItem()));
  assert.ok(has(html, sk.t("invoices.einvoice.inbound.ackDone")));
  assert.ok(has(html, 'data-link="invoice"') && has(html, sk.t("invoices.einvoice.inbound.openDraft")));
  assert.ok(action(html, "download-xml") && has(html, "Stiahnuť originálne XML"));
  assert.ok(!action(html, "reprocess") && !action(html, "ack-retry"));
});

await test("failed → manuálna kontrola + preložená chyba, žiadny surový kód", () => {
  const item = inboundItem({ status: "failed", category: "failed", invoiceId: null, lastErrorCode: "PARSE_FAILED", notice: "manual_review" });
  const html = renderInbound(inboundDetail(item, { allowed: { reprocess: true, ackRetry: false } }));
  assert.ok(has(html, sk.t("invoices.einvoice.inbound.manualReview")));
  assert.ok(!has(html, ">PARSE_FAILED<"));
  assert.ok(action(html, "reprocess"));
});

await test("ack_pending → „Zopakovať potvrdenie prijatia“ iba ak server povolí", () => {
  const item = inboundItem({ status: "ack_pending", category: "ack_pending", acknowledgedAt: null });
  const yes = renderInbound(inboundDetail(item, { allowed: { reprocess: false, ackRetry: true } }));
  assert.ok(action(yes, "ack-retry") && has(yes, "Zopakovať potvrdenie prijatia"));
  assert.ok(has(yes, sk.t("invoices.einvoice.inbound.ackPending")));
  const no = renderInbound(inboundDetail(item));
  assert.ok(!action(no, "ack-retry"));
});

await test("duplicate → poznámka o duplicite, ACK čaká", () => {
  const html = renderInbound(inboundDetail(inboundItem({ status: "duplicate", category: "duplicate", dedupeMatchedOn: "document_number" })));
  assert.ok(has(html, sk.t("invoices.einvoice.inbound.duplicateNote")));
  assert.ok(has(html, sk.t("invoices.einvoice.inboundState.duplicate")));
});

await test("nepodporovaný dobropis → presná veta, originál XML ostáva, manuálna kontrola, žiadny pád", () => {
  const item = inboundItem({ status: "failed", category: "failed", documentType: null, invoiceId: null, invoiceStatus: null, lastErrorCode: "UNSUPPORTED_PROFILE", notice: "credit_note_unsupported" });
  const html = renderInbound(inboundDetail(item));
  assert.ok(has(html, "Tento typ elektronického dokladu zatiaľ Esblu automaticky nespracuje."));
  assert.ok(has(html, 'data-notice="credit_note_unsupported"'));
  assert.ok(action(html, "download-xml"));
  assert.ok(has(html, sk.t("invoices.einvoice.inbound.manualReview")));
  assert.ok(!action(html, "reprocess"));
});

await test("busy → všetky tlačidlá disabled; feedback role=alert", () => {
  const item = inboundItem({ status: "ack_pending", category: "ack_pending" });
  const html = renderInbound(inboundDetail(item, { allowed: { reprocess: false, ackRetry: true } }), { busy: "ackRetry", feedback: feedbackFor(429, "ESBLU_EINVOICE_RATE_LIMITED") });
  assert.match(html, /<button[^>]*disabled=""[^>]*data-action="download-xml"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*data-action="ack-retry"/);
  assert.ok(has(html, 'role="alert"'));
});

await test("bez nároku → XML a história viditeľné, žiadne reprocess, neutrálny oznam", () => {
  const item = inboundItem({ status: "failed", category: "failed", invoiceId: null, lastErrorCode: "PARSE_FAILED", notice: "manual_review" });
  const allowed = inboundAllowedActions({ access: NO_ENT, status: "failed", invoiceId: null, hasXml: true, lastErrorCode: "PARSE_FAILED" });
  assert.equal(allowed.reprocess, false);
  const html = renderInbound(inboundDetail(item, { access: NO_ENT, allowed }));
  assert.ok(action(html, "download-xml"));
  assert.ok(!action(html, "reprocess"));
  assert.ok(has(html, sk.t("invoices.einvoice.panel.entitlementRequired")));
});

await test("embedded (v detaile faktúry) → bez odkazu na seba samu", () => {
  const html = renderInbound(inboundDetail(inboundItem()), { embedded: true });
  assert.ok(!has(html, 'data-link="invoice"'));
});

await test("DPH K/G/O: zachované v UI prijatej faktúry, preložené v sk/en/de, S/Z/E/AE bez regresie", () => {
  const view = read("app/faktury/InvoiceDetailView.tsx");
  assert.match(view, /const VAT_CATEGORIES: VatCategoryCode\[\] = \["S", "Z", "E", "AE", "K", "G", "O"\]/);
  for (const loc of ["sk", "en", "de"] as const) {
    for (const c of ["S", "Z", "E", "AE", "K", "G", "O"]) assert.ok(hasTranslation(loc, `invoices.newInvoice.vatCategory.${c}`), `${loc} ${c}`);
  }
  // nie-S kategória → sadzba 0 (K/G/O ako Z/E/AE)
  assert.match(view, /vat_rate: code === "S" \? companyDefaultVatRate \?\? NaN : 0/);
});

// ============================================================================= 3) POVOLENÉ AKCIE (server)
console.log("Povolené akcie (server)");

const row = (state: string, over: Record<string, unknown> = {}) => ({ state, provider_submission_id: null, send_outcome_unknown: false, reconciled_absent_at: null, ...over });

await test("send: iba finance.manage + nárok + provider + ready + žiadny pokus", () => {
  assert.equal(outboundAllowedActions({ access: FULL, readinessReady: true, attempts: [] }).send, true);
  assert.equal(outboundAllowedActions({ access: FULL, readinessReady: false, attempts: [] }).send, false);
  assert.equal(outboundAllowedActions({ access: NO_ENT, readinessReady: true, attempts: [] }).send, false);
  assert.equal(outboundAllowedActions({ access: { ...FULL, financeManage: false }, readinessReady: true, attempts: [] }).send, false);
  assert.equal(outboundAllowedActions({ access: { ...FULL, providerConfigured: false }, readinessReady: true, attempts: [] }).send, false);
  assert.equal(outboundAllowedActions({ access: FULL, readinessReady: true, attempts: [row("queued")] }).send, false);
});

await test("retry: nikdy pri neistom výsledku; reconcile pre sending/sent/deferred aj bez nároku", () => {
  assert.equal(outboundAllowedActions({ access: FULL, readinessReady: true, attempts: [row("failed", { send_outcome_unknown: true })] }).retry, false);
  assert.equal(outboundAllowedActions({ access: FULL, readinessReady: true, attempts: [row("failed", { send_outcome_unknown: true, reconciled_absent_at: "x" })] }).retry, true);
  assert.equal(outboundAllowedActions({ access: FULL, readinessReady: true, attempts: [row("rejected")] }).retry, true);
  assert.equal(outboundAllowedActions({ access: NO_ENT, readinessReady: true, attempts: [row("rejected")] }).retry, false);
  for (const s of ["sending", "sent", "deferred"]) {
    const a = outboundAllowedActions({ access: NO_ENT, readinessReady: true, attempts: [row(s)] });
    assert.equal(a.reconcile, true, s);
    assert.equal(a.retry, false, s);
  }
  assert.equal(outboundAllowedActions({ access: FULL, readinessReady: true, attempts: [row("delivered")] }).reconcile, false);
});

await test("inbound: reprocess / ackRetry podľa stavu; dobropis (UNSUPPORTED_PROFILE) sa neponúka", () => {
  const base = { access: FULL, invoiceId: null, hasXml: true, lastErrorCode: null };
  assert.equal(inboundAllowedActions({ ...base, status: "received" }).reprocess, true);
  assert.equal(inboundAllowedActions({ ...base, status: "failed" }).reprocess, true);
  assert.equal(inboundAllowedActions({ ...base, status: "failed", lastErrorCode: "UNSUPPORTED_PROFILE" }).reprocess, false);
  assert.equal(inboundAllowedActions({ ...base, status: "acknowledged" }).reprocess, false);
  assert.equal(inboundAllowedActions({ ...base, status: "ack_pending", invoiceId: "x" }).ackRetry, true);
  assert.equal(inboundAllowedActions({ ...base, status: "ack_pending" }).ackRetry, false);
  assert.equal(inboundAllowedActions({ ...base, access: { ...FULL, financeManage: false }, status: "ack_pending", invoiceId: "x" }).ackRetry, false);
});

// ============================================================================= 4) SERVEROVÉ PREHĽADY (fake user-scoped klient)
console.log("Serverové prehľady");

type Row = Record<string, unknown>;
const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
const INV_OUT = "bbbbbbbb-0000-4000-8000-000000000001";
const INV_IN = "bbbbbbbb-0000-4000-8000-000000000002";
const OUT1 = "cccccccc-0000-4000-8000-000000000001";
const IN1 = "dddddddd-0000-4000-8000-000000000001";
const IN2 = "dddddddd-0000-4000-8000-000000000002";
const PARTNER = "eeeeeeee-0000-4000-8000-000000000001";
const PROVIDER_SECRET_ID = "prov-sub-SECRET-123";
const STORAGE_PATH = "company/x/einvoice/outbound/secret-path.xml";

const ENV_OK = { ESBLU_EINVOICE_PROVIDER: "efaktura_sk", ESBLU_EINVOICE_ENVIRONMENT: "sandbox", ESBLU_EFAKTURA_API_KEY: "efk_pk_test_" + "0".repeat(24) };

function fakeDb(opts: { financeView: boolean; financeManage: boolean; einvoice: boolean; rollout?: boolean; tables: Record<string, Row[]> }) {
  const rpc = async (name: string) => {
    switch (name) {
      case "esblu_my_finance_view":
        return { data: opts.financeView, error: null };
      case "esblu_my_finance_manage":
        return { data: opts.financeManage, error: null };
      case "esblu_get_my_company_entitlements":
        return {
          data: { company_id: "co", trial: { started_at: null, ends_at: null, active: false }, entitlements: [{ key: "einvoice", active: opts.einvoice, source: "manual", reason: opts.einvoice ? null : "ENTITLEMENT_REQUIRED" }] },
          error: null,
        };
      case "esblu_einvoice_my_rollout":
        return { data: opts.rollout ?? true, error: null };
      case "esblu_my_active_company_id":
        // readiness sa v teste nenačíta (rovnako ako výpadok) → readiness=null, send=false
        return { data: null, error: { message: "not in test" } };
      default:
        return { data: null, error: { message: `unknown rpc ${name}` } };
    }
  };
  const from = (table: string) => {
    let rows = [...(opts.tables[table] ?? [])];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
      in: (c: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[c]))), q),
      order: (c: string, o: { ascending: boolean }) => ((rows = rows.sort((a, b) => String(a[c]).localeCompare(String(b[c])) * (o.ascending ? 1 : -1))), q),
      limit: (n: number) => ((rows = rows.slice(0, n)), q),
      returns: () => q,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res: (v: { data: Row[]; error: null }) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res, rej),
    };
    return q;
  };
  return { rpc, from } as never;
}

function tables(): Record<string, Row[]> {
  return {
    invoices: [
      { id: INV_OUT, direction: "issued", document_status: "finalized", source: "manual", total_amount: 100, currency: "EUR", supplier_business_partner_id: null },
      { id: INV_IN, direction: "received", document_status: "draft", source: "efaktura_peppol", total_amount: "250.50", currency: "EUR", supplier_business_partner_id: PARTNER },
    ],
    business_partners: [{ id: PARTNER, legal_name: "Peppol Dodávateľ a.s." }],
    einvoice_outbound: [
      {
        id: OUT1, invoice_id: INV_OUT, attempt: 1, state: "rejected", updated_at: "2026-10-02T10:05:00Z", sent_at: "2026-10-02T10:01:00Z", delivered_at: null,
        last_error_code: "EINVOICE_REJECTED", provider_submission_id: PROVIDER_SECRET_ID, next_retry_at: null, send_outcome_unknown: false, reconciled_absent_at: null,
        ubl_storage_path: STORAGE_PATH, evidence: { delivery_state: "rejected", raw_headers: { authorization: "Bearer SECRET" }, transactions: [{ id: "t" }] }, requested_by: ME,
      },
    ],
    einvoice_inbound: [
      {
        id: IN1, invoice_id: INV_IN, processing_status: "ack_pending", received_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:02:00Z", acknowledged_at: null,
        document_number: "IN-1", document_type: "380", issue_date: "2026-09-30", last_error_code: null, review_reasons: ["VAT_MISMATCH", "bad value!"], dedupe_matched_on: null,
        is_test: true, xml_storage_path: "company/x/in/1.xml", xml_sha256: "abc", provider_document_id: "prov-doc-SECRET",
      },
      {
        id: IN2, invoice_id: null, processing_status: "failed", received_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T09:01:00Z", acknowledged_at: null,
        document_number: null, document_type: null, issue_date: null, last_error_code: "UNSUPPORTED_PROFILE", review_reasons: null, dedupe_matched_on: null,
        is_test: false, xml_storage_path: "company/x/in/2.xml", xml_sha256: "def", provider_document_id: "prov-doc-SECRET-2",
      },
    ],
    einvoice_events: [
      { outbound_id: OUT1, inbound_id: null, from_state: null, to_state: "queued", source: "user", provider_code: null, metadata: {}, created_at: "2026-10-02T10:00:00Z" },
      { outbound_id: OUT1, inbound_id: null, from_state: "sent", to_state: "rejected", source: "provider", provider_code: "EINVOICE_REJECTED", metadata: { raw: "Bearer SECRET" }, created_at: "2026-10-02T10:05:00Z" },
      { outbound_id: OUT1, inbound_id: null, from_state: "rejected", to_state: "rejected", source: "user", provider_code: "OPERATOR_RECONCILE", metadata: { actor_user_id: OTHER }, created_at: "2026-10-02T10:06:00Z" },
      { outbound_id: null, inbound_id: IN1, from_state: null, to_state: "received", source: "provider", provider_code: null, metadata: {}, created_at: "2026-10-01T08:00:00Z" },
      { outbound_id: null, inbound_id: IN2, from_state: "parsed", to_state: "failed", source: "system", provider_code: "CREDIT_NOTE_NOT_SUPPORTED", metadata: {}, created_at: "2026-10-01T09:01:00Z" },
    ],
  };
}

const assertNoLeak = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const s of [PROVIDER_SECRET_ID, STORAGE_PATH, "SECRET", "storage_path", "provider_submission_id", "provider_document_id", "Bearer", ME, OTHER, "service_role"]) {
    assert.ok(!json.includes(s), `únik: ${s}`);
  }
};

await test("employee / admin bez financií → 403 (detail faktúry, zoznam aj detail inbound)", async () => {
  const db = fakeDb({ financeView: false, financeManage: false, einvoice: true, tables: tables() });
  assert.deepEqual(await loadInvoiceEinvoiceSummary(db, INV_OUT, ME, ENV_OK), { ok: false, status: 403, code: "FORBIDDEN" });
  assert.deepEqual(await loadInboundList(db, ENV_OK), { ok: false, status: 403, code: "FORBIDDEN" });
  assert.deepEqual(await loadInboundDetail(db, IN1, ME, ENV_OK), { ok: false, status: 403, code: "FORBIDDEN" });
});

await test("outbound prehľad: allowlist polí, bez UUID používateľov / ID poskytovateľa / storage ciest / surových dôkazov", async () => {
  const r = await loadInvoiceEinvoiceSummary(fakeDb({ financeView: true, financeManage: true, einvoice: true, tables: tables() }), INV_OUT, ME, ENV_OK);
  assert.ok(r.ok && r.data.kind === "outbound");
  if (!r.ok || r.data.kind !== "outbound") return;
  assertNoLeak(r.data);
  const a = r.data.attempts[0];
  assert.equal(a.hasDocument, true);
  assert.deepEqual(a.evidence, { deliveryState: "rejected", deliveredAt: null, transactions: 1 });
  assert.deepEqual(r.data.allowed, { send: false, reconcile: false, retry: true });
  assert.equal(r.data.readiness, null);
  const actors = r.data.timeline.map((t) => [t.kind, t.source, t.actor]);
  assert.deepEqual(actors, [["transition", "user", "self"], ["transition", "provider", null], ["action", "user", "user"]]);
});

await test("outbound po strate nároku: história + dokument ostávajú, retry/send zakázané", async () => {
  const r = await loadInvoiceEinvoiceSummary(fakeDb({ financeView: true, financeManage: true, einvoice: false, tables: tables() }), INV_OUT, ME, ENV_OK);
  assert.ok(r.ok && r.data.kind === "outbound");
  if (!r.ok || r.data.kind !== "outbound") return;
  assert.equal(r.data.access.entitlementActive, false);
  assert.equal(r.data.attempts[0].hasDocument, true);
  assert.equal(r.data.timeline.length, 3);
  assert.deepEqual(r.data.allowed, { send: false, reconcile: false, retry: false });
});

await test("accountant / read-only finance: prehľad viditeľný, akcie nie", async () => {
  const r = await loadInvoiceEinvoiceSummary(fakeDb({ financeView: true, financeManage: false, einvoice: true, tables: tables() }), INV_OUT, ME, ENV_OK);
  assert.ok(r.ok && r.data.kind === "outbound");
  if (!r.ok || r.data.kind !== "outbound") return;
  assert.deepEqual(r.data.allowed, { send: false, reconcile: false, retry: false });
  assert.ok(outboundPanelModel(r.data).notices.includes("invoices.einvoice.panel.readOnly"));
});

await test("poskytovateľ nenakonfigurovaný: prehľad funguje, providerConfigured=false, žiadne akcie", async () => {
  const r = await loadInvoiceEinvoiceSummary(fakeDb({ financeView: true, financeManage: true, einvoice: true, tables: tables() }), INV_OUT, ME, {});
  assert.ok(r.ok && r.data.kind === "outbound");
  if (!r.ok || r.data.kind !== "outbound") return;
  assert.equal(r.data.access.providerConfigured, false);
  assert.deepEqual(r.data.allowed, { send: false, reconcile: false, retry: false });
});

await test("prijatá faktúra z Peppolu → inbound detail (dodávateľ, suma, ACK retry povolený, test flag, filtrované dôvody)", async () => {
  const r = await loadInvoiceEinvoiceSummary(fakeDb({ financeView: true, financeManage: true, einvoice: true, tables: tables() }), INV_IN, ME, ENV_OK);
  assert.ok(r.ok && r.data.kind === "inbound");
  if (!r.ok || r.data.kind !== "inbound") return;
  assertNoLeak(r.data);
  assert.equal(r.data.item.supplierName, "Peppol Dodávateľ a.s.");
  assert.equal(r.data.item.total, 250.5);
  assert.equal(r.data.item.isTest, true);
  assert.deepEqual(r.data.item.reviewReasons, ["VAT_MISMATCH"]);
  assert.deepEqual(r.data.allowed, { reprocess: false, ackRetry: true });
});

await test("zoznam prijatých: najnovšie prvé, dobropis označený, bez reprocess", async () => {
  const db = fakeDb({ financeView: true, financeManage: true, einvoice: true, tables: tables() });
  const r = await loadInboundList(db, ENV_OK);
  assert.ok(r.ok);
  if (!r.ok) return;
  assertNoLeak(r.data);
  assert.deepEqual(r.data.items.map((i) => i.id), [IN2, IN1]);
  assert.equal(r.data.items[0].notice, "credit_note_unsupported");
  assert.equal(r.data.items[0].hasXml, true);
  const d = await loadInboundDetail(db, IN2, ME, ENV_OK);
  assert.ok(d.ok && d.data.allowed.reprocess === false);
  assert.deepEqual(await loadInboundDetail(db, "dddddddd-0000-4000-8000-00000000ffff", ME, ENV_OK), { ok: false, status: 404, code: "NOT_FOUND" });
});

await test("bežná prijatá faktúra bez e-faktúry → kind=none (panel sa nezobrazí)", async () => {
  const t = tables();
  t.einvoice_inbound = [];
  const r = await loadInvoiceEinvoiceSummary(fakeDb({ financeView: true, financeManage: true, einvoice: true, tables: t }), INV_IN, ME, ENV_OK);
  assert.ok(r.ok && r.data.kind === "none");
});

await test("rollout nepovolený (firma mimo allowlistu) → neutrálny oznam, história ostáva, žiadne send/retry", () => {
  const html = renderOutbound(outbound({ access: NO_ROLLOUT, attempts: [attempt({ state: "rejected", category: "rejected" })], timeline: TIMELINE }));
  assert.ok(has(html, sk.t("invoices.einvoice.panel.rolloutDisabled")));
  assert.ok(action(html, "download"));
  assert.ok(!action(html, "send") && !action(html, "retry"));
  assert.deepEqual(outboundAllowedActions({ access: NO_ROLLOUT, readinessReady: true, attempts: [] }), { send: false, reconcile: false, retry: false });
  assert.equal(outboundAllowedActions({ access: NO_ROLLOUT, readinessReady: true, attempts: [row("sent")] }).reconcile, true, "reconcile = iba čítanie stavu");
  assert.deepEqual(inboundAllowedActions({ access: NO_ROLLOUT, status: "ack_pending", invoiceId: "x", hasXml: true, lastErrorCode: null }), { reprocess: false, ackRetry: false });
  const inb = renderInbound(inboundDetail(inboundItem(), { access: NO_ROLLOUT }));
  assert.ok(has(inb, sk.t("invoices.einvoice.panel.rolloutDisabled")));
});

await test("server: firma mimo rollout allowlistu → rolloutEnabled=false, žiadne akcie (ani pri plných právach)", async () => {
  const r = await loadInvoiceEinvoiceSummary(fakeDb({ financeView: true, financeManage: true, einvoice: true, rollout: false, tables: tables() }), INV_OUT, ME, ENV_OK);
  assert.ok(r.ok && r.data.kind === "outbound");
  if (!r.ok || r.data.kind !== "outbound") return;
  assert.equal(r.data.access.rolloutEnabled, false);
  assert.deepEqual(r.data.allowed, { send: false, reconcile: false, retry: false });
});

// ============================================================================= 5) STATICKÉ KONTROLY
console.log("Statické kontroly (API, mobil, i18n, prístupnosť)");

const COMPONENT_FILES = [
  "app/components/einvoice/OutboundPanelView.tsx",
  "app/components/einvoice/InboundViews.tsx",
  "app/components/einvoice/EinvoiceTimeline.tsx",
  "app/components/einvoice/EinvoiceStatusPill.tsx",
  "app/components/einvoice/EinvoiceInvoicePanel.tsx",
  "app/faktury/efaktury/page.tsx",
];

await test("POST odoslania má telo presne {invoice_id, confirm_send: true}; akcie {confirm_action: true}", () => {
  const client = read("lib/einvoice/ui/client.ts");
  assert.match(client, /"\/api\/einvoice\/outbound", locale, \{ method: "POST", body: \{ invoice_id: invoiceId, confirm_send: true \} \}/);
  assert.match(client, /body: \{ confirm_action: true \}/);
  assert.match(client, /apiUrl\(path\)/);
  assert.match(client, /Authorization: `Bearer \$\{session\.access_token\}`/);
  assert.ok(!/company_id|role|service_role/.test(client.replace(/\/\/.*$/gm, "")), "klient neposiela firmu ani rolu");
});

await test("kontajner: potvrdenie pred requestom, ochrana pred dvojklikom, 403 → panel skrytý, správne download routy", () => {
  const c = read("app/components/einvoice/EinvoiceInvoicePanel.tsx");
  const send = c.slice(c.indexOf("const send = useCallback"));
  assert.ok(send.indexOf("confirmAction(") < send.indexOf("requestEinvoiceSend("), "confirm pred POST");
  assert.match(c, /if \(inFlight\.current\) return;/);
  assert.match(c, /res\.status === 403/);
  assert.match(c, /`\/api\/einvoice\/outbound\/\$\{encodeURIComponent\(attemptId\)\}\/ubl`/);
  assert.match(c, /`\/api\/einvoice\/inbound\/\$\{encodeURIComponent\(id\)\}\/xml`/);
  assert.match(c, /`\/api\/invoices\/\$\{encodeURIComponent\(invoiceId\)\}\/einvoice`/);
  const view = read("app/faktury/InvoiceDetailView.tsx");
  assert.match(view, /\{canView && <EinvoiceInvoicePanel invoiceId=\{invoice\.id\} \/>\}/);
});

await test("serverové routy existujú, sú server-only a nodejs runtime", () => {
  for (const p of ["app/api/invoices/[id]/einvoice/route.ts", "app/api/einvoice/inbound/route.ts", "app/api/einvoice/inbound/[id]/route.ts"]) {
    const s = read(p);
    assert.match(s, /^import "server-only";/m, p);
    assert.match(s, /export const runtime = "nodejs"/, p);
    assert.ok(!/service_role|getServiceRole|createAdmin/i.test(s), `${p}: bez service_role`);
  }
  const summary = read("lib/einvoice/ui/summary-server.ts");
  assert.ok(!/service_role|SUPABASE_SERVICE_ROLE|supabase-store/.test(summary.replace(/\/\/.*$/gm, "")));
});

await test("mobil: statická routa /faktury/efaktury + re-export wrapper + resolveAppHref", () => {
  assert.ok(existsSync(path.join(ROOT, "mobile/app/faktury/efaktury/page.tsx")));
  assert.match(read("mobile/app/faktury/efaktury/page.tsx"), /export \{ default \} from "@\/app\/faktury\/efaktury\/page";/);
  assert.equal(resolveAppHref("/faktury/efaktury", true), "/faktury/efaktury");
  assert.equal(resolveAppHref("/faktury/efaktury?id=abc", true), "/faktury/efaktury?id=abc");
  assert.equal(resolveAppHref("/faktury/efaktury", false), "/faktury/efaktury");
  // detail faktúry (s panelom) je v appke statická routa zdieľajúca InvoiceDetailView
  assert.match(read("mobile/app/faktury/detail/page.tsx"), /InvoiceDetailView/);
  const page = read("app/faktury/efaktury/page.tsx");
  assert.match(page, /useSearchParams\(\)\.get\("id"\)/);
  assert.match(page, /<Suspense/);
});

await test("komponenty: žiadna desktop-only navigácia, žiadny priamy fetch mimo apiUrl, žiadne window.location", () => {
  for (const f of COMPONENT_FILES) {
    const s = read(f);
    assert.ok(!/from "next\/router"/.test(s), `${f}: next/router`);
    assert.ok(!/window\.location|window\.open\(/.test(s), `${f}: window navigácia`);
    assert.ok(!/\bfetch\(/.test(s), `${f}: priamy fetch (má ísť cez client.ts → apiUrl)`);
    assert.ok(!/DocumentLayout"|VoiceLauncher/.test(s) || f.endsWith("page.tsx"), `${f}: desktop-only layout import`);
  }
});

await test("prezentačné komponenty sú čisté (bez supabase / next importov)", () => {
  for (const f of COMPONENT_FILES.slice(0, 4)) {
    const s = read(f);
    assert.ok(!/@\/lib\/supabase|from "next\//.test(s), f);
  }
});

await test("žiadny hardcoded slovenský text v komponentoch (mimo komentárov)", () => {
  for (const f of COMPONENT_FILES) {
    const code = read(f)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s\/\/ .*$/gm, "");
    const m = code.match(/[áäčďéíĺľňóôŕšťúýž]/i);
    assert.ok(!m, `${f}: „${m ? code.slice(Math.max(0, code.indexOf(m[0]) - 30), code.indexOf(m[0]) + 30) : ""}“`);
  }
});

await test("prístupnosť: aria-labelledby/aria-busy, role=status pri stave, symbol okrem farby, <ol aria-label>, type=button", () => {
  const out = read("app/components/einvoice/OutboundPanelView.tsx");
  assert.match(out, /aria-labelledby="einvoice-panel-title"/);
  assert.match(out, /aria-busy=\{isBusy\}/);
  assert.match(read("app/components/einvoice/EinvoiceStatusPill.tsx"), /role="status"[\s\S]*toneSymbol\(tone\)/);
  assert.match(read("app/components/einvoice/EinvoiceTimeline.tsx"), /<ol[^>]*aria-label=/);
  for (const f of COMPONENT_FILES) {
    const s = read(f);
    const buttons = s.match(/<button\b[^>]*>/g) ?? [];
    for (const b of buttons) assert.match(b, /type="button"/, `${f}: ${b.slice(0, 60)}`);
  }
  // potvrdenia idú cez mobilne bezpečný AppDialog (fokus, Esc, klávesnica)
  assert.match(read("app/components/einvoice/EinvoiceInvoicePanel.tsx"), /import \{ confirmAction \} from "@\/app\/components\/ui\/AppDialog"/);
});

await test("mobil: bez horizontálneho pretečenia (min-w-0, break-words, tlačidlá na plnú šírku pod sm)", () => {
  const out = read("app/components/einvoice/OutboundPanelView.tsx");
  assert.match(out, /flex-col gap-2 sm:flex-row/);
  assert.match(out, /w-full sm:w-auto/);
  assert.ok((out.match(/break-words/g) ?? []).length >= 4);
  const inb = read("app/components/einvoice/InboundViews.tsx");
  assert.match(inb, /grid-cols-1[^"]*sm:grid-cols-2/);
  assert.ok(!/whitespace-nowrap|overflow-x-scroll|w-\[\d{3,}px\]|min-w-\[\d{3,}px\]/.test(out + inb), "žiadne fixné šírky / nowrap");
});

function collectKeys(src: string): string[] {
  const keys = new Set<string>();
  for (const m of src.matchAll(/\bt\(\s*"(invoices\.[A-Za-z0-9_.]+)"/g)) keys.add(m[1]);
  for (const m of src.matchAll(/"(invoices\.einvoice\.[A-Za-z0-9_.]+)"/g)) keys.add(m[1]);
  return [...keys];
}

await test("i18n: všetky použité a dynamické kľúče existujú v sk/en/de", () => {
  const keys = new Set<string>(allStaticKeys());
  for (const f of [...COMPONENT_FILES, "app/faktury/page.tsx"]) for (const k of collectKeys(read(f))) if (k.startsWith("invoices.einvoice") || k === "invoices.noFinanceAccess" || k === "invoices.backToList" || k === "invoices.title") keys.add(k);
  for (const s of ["queued", "sending", "sent", "deferred", "delivered", "rejected", "failed"]) {
    keys.add(`invoices.einvoice.state.${s}`);
    keys.add(`invoices.einvoice.stateHint.${s}`);
    keys.add(`invoices.einvoice.events.to.${s}`);
  }
  for (const s of ["received", "stored", "parsed", "draft_created", "ack_pending", "acknowledged", "duplicate", "failed"]) keys.add(`invoices.einvoice.inboundState.${s}`);
  for (const a of ["reconcile", "retry", "reprocess", "ackRetry"]) keys.add(`invoices.einvoice.actions.${a}`);
  keys.add("invoices.einvoice.errors.DOWNLOAD_FAILED");
  const missing: string[] = [];
  for (const loc of ["sk", "en", "de"] as const) {
    for (const k of keys) {
      const v = translate(loc, k);
      if (!hasTranslation(loc, k) || v === k) missing.push(`${loc}:${k}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(keys.size > 80, `počet kľúčov ${keys.size}`);
});

await test("i18n: en/de nie sú kópie slovenčiny pre stavy a CTA", () => {
  for (const k of ["panel.sendCta", "panel.downloadUbl", "inbound.downloadXml", "actions.reconcile", "state.delivered", "inbound.creditNoteUnsupported", "evidence.title"]) {
    const s = translate("sk", `invoices.einvoice.${k}`);
    assert.notEqual(translate("en", `invoices.einvoice.${k}`), s, `en ${k}`);
    assert.notEqual(translate("de", `invoices.einvoice.${k}`), s, `de ${k}`);
  }
});

await test("zoznam faktúr odkazuje na prijaté e-faktúry iba pri finančnom prístupe", () => {
  const list = read("app/faktury/page.tsx");
  assert.match(list, /\{canView && \(\s*<div className="mt-4">\s*<Link\s*href="\/faktury\/efaktury"/);
  // zdroj efaktura_peppol je v registri už označený odznakom
  assert.ok(hasTranslation("sk", "invoices.source.efaktura_peppol"));
});

await test("migrácie E-Faktúry končia súčtami prijatého konceptu z XML (UI iba číta cez RLS)", () => {
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.startsWith("20261002") || f.startsWith("2026100"));
  // 20261005100000: API partner onboarding (iba einvoice_organizations + service_role RPC, UI nemení).
  const allowed = new Set(["20261005100000_einvoice_partner_onboarding.sql", "20261005110000_einvoice_enroll_error_code_active.sql", "20261006100000_einvoice_supplier_dic_feed_cursor.sql", "20261007100000_einvoice_event_ops_enroll_limit.sql", "20261008100000_invoicing_sk_compliance.sql", "20261008100001_invoicing_sk_trigger_fn_revoke.sql"]);
  assert.ok(migrations.every((f) => f <= "20261003100000_einvoice_inbound_draft_totals.sql" || allowed.has(f)), migrations.join(","));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
