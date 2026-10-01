// =============================================================================
// eFaktura.sk SANDBOX smoke — RUČNÉ spúšťanie, REÁLNE sieťové volania.
//
// NIE JE súčasťou CI ani `npm test`. Spúšťa sa iba lokálne, po krokoch, s
// explicitným --confirm-sandbox. Kľúč sa číta IBA z process.env (napr. cez
// `node --env-file=<súbor MIMO repozitára>`), nikdy sa nevypisuje.
//
// Poistky:
//   - ESBLU_EINVOICE_ENVIRONMENT musí byť "sandbox" a kľúč efk_pk_test_…
//     (live kľúč → okamžitý koniec, pred akýmkoľvek volaním),
//   - iba syntetická firma a testovacia faktúra (self-send → vznikne aj
//     prijatý doklad pre tú istú organizáciu, docs „Testing inbound"),
//   - výstup obsahuje iba nesekretné polia (ID, stavy, počty).
//
// Použitie (PowerShell, z koreňa repa):
//   node --env-file=C:\cesta\mimo\repa\efaktura-sandbox.env `
//     --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs `
//     scripts/einvoice-efaktura-sandbox-smoke.ts --confirm-sandbox --step=org
//
// Kroky (--step=): org | ubl (offline) | recipient | preflight | send (vyžaduje aj --allow-send)
//                  | status | evidence | inbound | ack
// Stav medzi krokmi (org_id, invoice_id — nie sú tajné) sa ukladá do
//   %TEMP%/esblu-efaktura-sandbox-state.json (alebo --state=<cesta>).
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EfakturaSkProvider, buildEfakturaHeaders, resolveEfakturaBaseUrl } from "../lib/einvoice/provider/efaktura-sk.ts";
import { EinvoiceProviderError, type ProviderContext } from "../lib/einvoice/provider/types.ts";
import { generateUbl } from "../lib/einvoice/ubl/generate.ts";
import type { UblInvoiceSnapshot, UblParty } from "../lib/einvoice/ubl/model.ts";

const args = new Map<string, string>();
for (const raw of process.argv.slice(2)) {
  const [k, ...v] = raw.replace(/^--/, "").split("=");
  args.set(k, v.join("=") || "true");
}

function die(message: string): never {
  console.error(`STOP: ${message}`);
  process.exit(2);
}

if (args.get("confirm-sandbox") !== "true") die("chýba --confirm-sandbox (reálne volanie sandbox API)");
const step = args.get("step") ?? die("chýba --step=");
const environment = process.env.ESBLU_EINVOICE_ENVIRONMENT?.trim();
const apiKey = process.env.ESBLU_EFAKTURA_API_KEY?.trim() ?? "";
if (environment !== "sandbox") die("ESBLU_EINVOICE_ENVIRONMENT musí byť 'sandbox'");
if (!apiKey.startsWith("efk_pk_test_")) die("ESBLU_EFAKTURA_API_KEY chýba alebo nie je sandbox (efk_pk_test_) kľúč");

const statePath = args.get("state") ?? path.join(tmpdir(), "esblu-efaktura-sandbox-state.json");
type State = { orgId?: string; participantId?: string | null; invoiceId?: string | null; idempotencyKey?: string; receivedId?: string };
function loadState(): State {
  try { return JSON.parse(readFileSync(statePath, "utf8")) as State; } catch { return {}; }
}
function saveState(s: State) {
  writeFileSync(statePath, JSON.stringify(s, null, 2));
}

// Identita SKUTOČNE vytvorenej sandbox organizácie (org_id b917aa7d-…, participant 9915:2099999999).
// Pôvodný quickstart príklad skončil 409 CONFLICT a organizácia nevznikla — nepoužívať.
// Prepísateľné cez --name= --ico= --dic= …
const NAME = args.get("name") ?? "Tatra Servis s.r.o.";
const ICO = args.get("ico") ?? "87654326";
const DIC = args.get("dic") ?? "2099999999";
const STREET = args.get("street") ?? "Hlavná 1";
const CITY = args.get("city") ?? "Bratislava";
const POSTAL = args.get("postal") ?? "81101";
const COUNTRY = args.get("country") ?? "SK";
if (!/^[0-9]{8}$/.test(ICO) || !/^[0-9]{10}$/.test(DIC)) die("syntetické IČO (8 číslic) / DIČ (10 číslic)");

// Záznam iba NESEKRETNÝCH polí z odpovedí (HTTP status + telo `data`).
// Hlavičky požiadavky ani kľúč sa nikdy nezaznamenávajú.
let provisionCapture: Record<string, unknown> | null = null;
const responseCapture = new Map<string, Record<string, unknown>>();
const ACK_RECEIVED_ID = (() => {
  const v = args.get("received");
  if (v === undefined) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) die("--received musí byť UUID");
  return v.toLowerCase();
})();
const READ_ONLY_STEPS = new Set(["recipient", "status", "evidence", "inbound"]);
const CAPTURE_PATHS = new Set(["/v1/agent/peppol/recipient", "/v1/agent/peppol/preflight", "/v1/agent/peppol/connector/send"]);
const capturingFetch = async (input: string, init: RequestInit): Promise<Response> => {
  // Poistka: offline krok `ubl` nesmie ísť na sieť.
  if (step === "ubl") die("krok ubl je offline — sieťové volanie zablokované");
  // Poistka: read-only kroky smú posielať IBA GET (žiadny send, žiadny acknowledge).
  if (READ_ONLY_STEPS.has(step) && init.method !== "GET") die(`krok ${step} je read-only — ${init.method} zablokovaný`);
  const url = new URL(input);
  const pathname = url.pathname;
  // Poistka: krok ack smie poslať IBA POST acknowledge pre jeden zadaný doklad, inak len GET.
  if (step === "ack" && init.method !== "GET"
    && !(init.method === "POST" && pathname === `/v1/agent/peppol/received/${ACK_RECEIVED_ID}/acknowledge`)) {
    die(`krok ack: ${init.method} ${pathname} zablokovaný`);
  }
  const res = await fetch(input, init);
  const readOnlyCapture = init.method === "GET"
    && (pathname.startsWith("/v1/agent/peppol/status/")
      || /^\/v1\/agent\/peppol\/sent\/[^/]+\/evidence$/.test(pathname)
      || /^\/v1\/agent\/peppol\/received(\/[^/]+)?$/.test(pathname));
  if (init.method === "GET" && /^\/v1\/agent\/peppol\/received\/[^/]+\/xml$/.test(pathname)) {
    // XML sa nevypisuje; iba status, typ a veľkosť (hash počíta krok inbound).
    responseCapture.set(pathname, {
      http_status: res.status,
      content_type: res.headers.get("content-type"),
      content_length: res.headers.get("content-length"),
    });
  } else if (CAPTURE_PATHS.has(pathname) || readOnlyCapture
    || (init.method === "POST" && /^\/v1\/agent\/peppol\/received\/[^/]+\/acknowledge$/.test(pathname))) {
    let data: unknown = null;
    try {
      const body = (await res.clone().json()) as { data?: unknown; error?: unknown };
      data = body?.data ?? body?.error ?? null;
    } catch { /* ne-JSON odpoveď */ }
    let safe: unknown;
    if (Array.isArray(data)) {
      safe = data;
    } else {
      const obj = data && typeof data === "object" ? { ...(data as Record<string, unknown>) } : { value: data };
      if (typeof obj.normalized_ubl_base64 === "string") {
        obj.normalized_ubl_base64 = `<${obj.normalized_ubl_base64.length} znakov base64, vynechané>`;
      }
      safe = obj;
    }
    responseCapture.set(pathname, { http_status: res.status, query: url.search || null, data: safe });
  }
  if (init.method === "POST" && pathname === "/v1/agent/organizations") {
    let data: Record<string, unknown> = {};
    try {
      const body = (await res.clone().json()) as { data?: Record<string, unknown>; error?: { code?: string } };
      data = body?.data ?? {};
      if (body?.error?.code) data = { error_code: body.error.code };
    } catch { /* ne-JSON odpoveď */ }
    const sandbox = (data.peppol_sandbox ?? null) as Record<string, unknown> | null;
    provisionCapture = {
      http_status: res.status,
      org_id: data.org_id ?? null,
      reused: data.reused ?? null,
      status: data.status ?? null,
      peppol_sandbox_status: sandbox && typeof sandbox === "object" ? sandbox.status ?? null : null,
      peppol_sandbox_participant_id: sandbox && typeof sandbox === "object" ? sandbox.participant_id ?? null : null,
      ...(data.error_code ? { error_code: data.error_code } : {}),
    };
  }
  return res;
};

const provider = new EfakturaSkProvider({
  apiKey,
  environment: "sandbox",
  baseUrl: process.env.ESBLU_EFAKTURA_BASE_URL?.trim() || undefined,
  fetchImpl: capturingFetch,
});

function ctxOf(s: State): ProviderContext {
  if (!s.orgId) die("najprv --step=org");
  return { environment: "sandbox", providerOrgId: s.orgId };
}

/**
 * Participant sandbox organizácie: --peppol=… alebo participant uložený krokom `org`.
 * DIČ participanta MUSÍ zodpovedať DIČ organizácie (--dic / default) — inak koniec.
 */
function participantOf(s: State): { participantId: string; dic: string } {
  const participantId = args.get("peppol") ?? s.participantId ?? die("chýba participant (--peppol= alebo --step=org)");
  const m = /^9915:([0-9]{10})$/.exec(participantId);
  if (!m) die("participant musí byť sandbox 9915:<10 číslic DIČ>");
  if (m[1] !== DIC) die("DIČ participanta nezodpovedá DIČ sandbox organizácie");
  return { participantId, dic: m[1] };
}

/** Seller aj buyer = tá istá sandbox organizácia (self-send). Bez IBAN, bez osôb, bez e-mailu. */
function party(role: "seller" | "buyer", dic: string): UblParty {
  return {
    role, legal_name: NAME, ico: ICO, dic, ic_dph: `SK${dic}`,
    address_line1: STREET, address_line2: null, city: CITY, postal_code: POSTAL, country_code: COUNTRY,
    iban: null, bic: null, email: null,
    // EndpointID = Peppol participant (EAS 9915 = sandbox/test schéma, hodnota DIČ).
    electronic_address: dic, electronic_address_scheme_id: "9915",
    legal_registration_id: ICO, legal_registration_scheme_id: null, vat_identifier: null,
  };
}

/**
 * Deterministická syntetická faktúra: rovnaký vstup → rovnaký UBL → rovnaký SHA-256.
 * Pevný testovací dátum (--date=, default 2026-09-30), 1 položka 10,00 EUR + 23 % DPH.
 * Bez PaymentMeans (žiadne platobné údaje).
 */
function syntheticUbl(dic: string): { bytes: Uint8Array; sha256: string; xml: string; number: string; warnings: string[] } {
  const date = args.get("date") ?? "2026-09-30";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die("--date=YYYY-MM-DD");
  const number = args.get("number") ?? "SBX-2026-0001";
  const snapshot: UblInvoiceSnapshot = {
    invoice: {
      id: "00000000-0000-4000-8000-000000000001", company_id: "00000000-0000-4000-8000-000000000c01",
      direction: "issued", kind: "regular_invoice", document_status: "finalized",
      invoice_number: number, issue_date: date, due_date: date, delivery_date: date, tax_point_date: null, currency: "EUR",
      subtotal_amount: 10, vat_total_amount: 2.3, total_amount: 12.3, rounding_amount: 0, buyer_reference: "SANDBOX-TEST",
      purchase_order_reference: null, payment_means_code: null, payment_reference: null, corrects_invoice_id: null,
    },
    seller: party("seller", dic),
    buyer: party("buyer", dic),
    items: [{ position: 1, description: "Syntetická testovacia služba (sandbox)", quantity: 1, unit_code: "C62", unit_price: 10, price_mode: "net",
      vat_category_code: "S", vat_rate: 23, line_net_amount: 10 }],
    taxBreakdowns: [{ vat_category_code: "S", vat_rate: 23, taxable_amount: 10, vat_amount: 2.3, vat_exemption_reason_code: null, vat_exemption_reason_text: null }],
    correctedInvoice: null,
  };
  const r = generateUbl(snapshot);
  if (!r.ok) die(`UBL sa nevygeneroval: ${r.issues.map((i) => `${i.code} (${i.rule})`).join(", ")}`);
  return { bytes: r.bytes, sha256: r.sha256, xml: r.xml, number, warnings: r.warnings.map((w) => `${w.code} (${w.rule})`) };
}

function saveUbl(xml: string, sha256: string): string {
  const file = path.join(tmpdir(), `esblu-sbx-${sha256.slice(0, 12)}.xml`);
  writeFileSync(file, xml);
  return file;
}

const out = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value, null, 2)}`);

try {
  const s = loadState();
  switch (step) {
    case "org": {
      const info = await provider.provisionOrganization({
        environment: "sandbox", legalName: NAME, ico: ICO, dic: DIC, icDph: `SK${DIC}`,
        address: { street: STREET, city: CITY, postalCode: POSTAL, countryCode: COUNTRY },
      }).catch((error: unknown) => {
        if (provisionCapture) out("provision_response", provisionCapture);
        throw error;
      });
      saveState({ ...s, orgId: info.providerOrgId, participantId: info.participantId });
      out("provision_response", provisionCapture);
      out("organization_detail", info);
      break;
    }
    case "ubl": {
      // OFFLINE: iba vygeneruje UBL, uloží ho do %TEMP% a vypíše SHA-256. Žiadna sieť.
      const { participantId, dic } = participantOf(s);
      const ubl = syntheticUbl(dic);
      out("ubl", { participantId, documentNumber: ubl.number, sha256: ubl.sha256, bytes: ubl.bytes.byteLength, generatorWarnings: ubl.warnings, file: saveUbl(ubl.xml, ubl.sha256) });
      break;
    }
    case "recipient": {
      const { participantId } = participantOf(s);
      const result = await provider.verifyRecipient(ctxOf(s), participantId);
      out("recipient_response", responseCapture.get("/v1/agent/peppol/recipient") ?? null);
      out("recipient", result);
      break;
    }
    case "preflight": {
      // Iba preflight (bez zápisu, bez kreditu). Connector/send sa tu NEVOLÁ; autoRepair sa tu vôbec neposiela.
      const { participantId, dic } = participantOf(s);
      const ubl = syntheticUbl(dic);
      out("ubl", { documentNumber: ubl.number, sha256: ubl.sha256, bytes: ubl.bytes.byteLength, generatorWarnings: ubl.warnings, file: saveUbl(ubl.xml, ubl.sha256) });
      const result = await provider.preflight(ctxOf(s), { ubl: ubl.bytes, receiverParticipantId: participantId }).catch((error: unknown) => {
        out("preflight_response", responseCapture.get("/v1/agent/peppol/preflight") ?? null);
        throw error;
      });
      out("preflight_response", responseCapture.get("/v1/agent/peppol/preflight") ?? null);
      out("preflight", result);
      break;
    }
    case "send": {
      if (args.get("allow-send") !== "true") die("send vyžaduje --allow-send (reálne odoslanie do Peppol TEST siete)");
      const { participantId, dic } = participantOf(s);
      const ubl = syntheticUbl(dic);
      // Poistka: odošle sa IBA presne ten UBL, ktorý prešiel preflightom.
      const expected = args.get("expect-sha256") ?? die("send vyžaduje --expect-sha256=<SHA-256 UBL z preflightu>");
      if (expected !== ubl.sha256) die(`UBL SHA-256 ${ubl.sha256} ≠ očakávaný ${expected} — neodosielam`);
      // Stabilný, nesekretný kľúč odvodený z hashu UBL: retry = replay, nikdy druhé odoslanie.
      const idempotencyKey = `esblu-sbx-${ubl.sha256.slice(0, 32)}`;
      const res = await provider.sendUbl(ctxOf(s), { ubl: ubl.bytes, ublSha256: ubl.sha256, idempotencyKey, receiverParticipantId: participantId })
        .catch((error: unknown) => {
          out("send_response", responseCapture.get("/v1/agent/peppol/connector/send") ?? null);
          throw error;
        });
      saveState({ ...s, invoiceId: res.providerSubmissionId, idempotencyKey });
      out("send_response", responseCapture.get("/v1/agent/peppol/connector/send") ?? null);
      out("send", { ...res, documentNumber: ubl.number, ublSha256: ubl.sha256, idempotencyKey });
      break;
    }
    case "status": {
      // READ-ONLY: GET /v1/agent/peppol/status/{invoiceId}. Nič neodosiela.
      const invoiceId = args.get("invoice") ?? s.invoiceId ?? die("chýba invoice_id (--invoice= alebo --step=send)");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invoiceId)) die("--invoice musí byť UUID");
      const statusPath = `/v1/agent/peppol/status/${invoiceId}`;
      const result = await provider.getOutboundStatus(ctxOf(s), { providerSubmissionId: invoiceId }).catch((error: unknown) => {
        out("status_response", responseCapture.get(statusPath) ?? null);
        throw error;
      });
      out("status_response", responseCapture.get(statusPath) ?? null);
      out("status", { invoiceId, ...result });
      break;
    }
    case "evidence": {
      // READ-ONLY: GET /v1/agent/peppol/sent/{invoiceId}/evidence. Nič neodosiela.
      const invoiceId = args.get("invoice") ?? s.invoiceId ?? die("chýba invoice_id (--invoice= alebo --step=send)");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invoiceId)) die("--invoice musí byť UUID");
      const evidencePath = `/v1/agent/peppol/sent/${invoiceId}/evidence`;
      const ev = await provider.getDeliveryEvidence(ctxOf(s), { providerSubmissionId: invoiceId }).catch((error: unknown) => {
        out("evidence_response", responseCapture.get(evidencePath) ?? null);
        throw error;
      });
      out("evidence_response", responseCapture.get(evidencePath) ?? null);
      const expected = args.get("expect-sha256");
      out("evidence", ev
        ? {
          invoiceId,
          documentId: ev.documentId,
          ublSha256: ev.ublSha256,
          ...(expected ? { ublSha256MatchesSent: ev.ublSha256 === expected.toLowerCase() } : {}),
          deliveredAt: ev.deliveredAt,
        }
        : { invoiceId, evidence: null, note: "404 — pre invoice zatiaľ neexistuje Peppol prenos" });
      break;
    }
    case "inbound": {
      // READ-ONLY: zoznam neacknowledged → nájdi SBX-2026-0001 → detail + XML. Žiadny acknowledge, žiadna DB.
      const ctx = ctxOf(s);
      const wanted = args.get("number") ?? "SBX-2026-0001";
      const list = await provider.listUnacknowledgedInbound(ctx, { limit: 50 }).catch((error: unknown) => {
        out("received_list_response", responseCapture.get("/v1/agent/peppol/received") ?? null);
        throw error;
      });
      const listCapture = responseCapture.get("/v1/agent/peppol/received");
      out("received_list_response", {
        http_status: listCapture?.http_status ?? null,
        query: listCapture?.query ?? null,
        total_returned: Array.isArray(listCapture?.data) ? (listCapture!.data as unknown[]).length : null,
      });
      out("unacknowledged", list);
      const matches = list.filter((d) => d.documentNumber === wanted);
      if (matches.length === 0) {
        out("match", { documentNumber: wanted, found: false, note: "sandbox doklad sa ešte nemusel zmaterializovať — zopakuj neskôr" });
        break;
      }
      if (matches.length > 1) out("warning", { documentNumber: wanted, matches: matches.map((m) => m.providerReceivedId) });
      const target = matches[0];
      const rid = target.providerReceivedId;

      // Detail (metadata vrátane ubl_sha256) — priamy read-only GET, ten istý host a hlavičky ako adaptér.
      const detailPath = `/v1/agent/peppol/received/${encodeURIComponent(rid)}`;
      await capturingFetch(new URL(detailPath, resolveEfakturaBaseUrl(process.env.ESBLU_EFAKTURA_BASE_URL)).toString(), {
        method: "GET",
        headers: buildEfakturaHeaders({ apiKey, providerOrgId: ctx.providerOrgId }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      const detail = responseCapture.get(detailPath);
      out("received_detail_response", detail ?? null);

      // Pôvodné XML (read-only), hash a porovnanie s odoslaným UBL.
      const doc = await provider.getInboundDocument(ctx, rid);
      const xmlSha = createHash("sha256").update(doc.xml).digest("hex");
      const sent = syntheticUbl(participantOf(s).dic);
      const detailSha = (detail?.data as Record<string, unknown> | undefined)?.ubl_sha256;
      const file = path.join(tmpdir(), `esblu-sbx-inbound-${xmlSha.slice(0, 12)}.xml`);
      writeFileSync(file, doc.xml);
      saveState({ ...s, receivedId: rid });
      out("received_xml_response", responseCapture.get(`${detailPath}/xml`) ?? null);
      out("inbound", {
        providerReceivedId: rid,
        senderParticipantId: target.senderParticipantId,
        documentNumber: target.documentNumber,
        documentType: target.documentType,
        receivedAt: target.receivedAt,
        isTest: target.isTest,
        acknowledged: false,
        xmlBytes: doc.xml.byteLength,
        xmlSha256: xmlSha,
        sentUblSha256: sent.sha256,
        xmlMatchesSentUbl: xmlSha === sent.sha256,
        providerDetailUblSha256: typeof detailSha === "string" ? detailSha : null,
        xmlMatchesProviderDetailSha: typeof detailSha === "string" ? detailSha.toLowerCase() === xmlSha : null,
        file,
      });
      break;
    }
    case "ack": {
      if (args.get("allow-ack") !== "true") die("ack vyžaduje --allow-ack (zapisuje acknowledged_at u poskytovateľa)");
      // Iba JEDEN explicitne zadaný doklad; musí sa zhodovať s dokladom z kroku inbound.
      const rid = ACK_RECEIVED_ID ?? die("ack vyžaduje --received=<providerReceivedId UUID>");
      if (s.receivedId && s.receivedId !== rid) die("--received sa nezhoduje s dokladom z kroku inbound");
      const ctx = ctxOf(s);
      const ackPath = `/v1/agent/peppol/received/${rid}/acknowledge`;
      const detailPath = `/v1/agent/peppol/received/${rid}`;

      await provider.acknowledgeInbound(ctx, rid).catch((error: unknown) => {
        out("ack_response", responseCapture.get(ackPath) ?? null);
        throw error;
      });
      const ack = responseCapture.get(ackPath);
      out("ack_response", ack ?? null);

      // Overenie: iba read-only GET detailu.
      await capturingFetch(new URL(detailPath, resolveEfakturaBaseUrl(process.env.ESBLU_EFAKTURA_BASE_URL)).toString(), {
        method: "GET",
        headers: buildEfakturaHeaders({ apiKey, providerOrgId: ctx.providerOrgId }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      const detail = responseCapture.get(detailPath);
      const ackData = (ack?.data ?? {}) as Record<string, unknown>;
      const detailData = (detail?.data ?? {}) as Record<string, unknown>;
      out("received_detail_after_ack", {
        http_status: detail?.http_status ?? null,
        id: detailData.id ?? null,
        document_number: detailData.document_number ?? null,
        status: detailData.status ?? null,
        acknowledged_at: detailData.acknowledged_at ?? null,
        ubl_sha256: detailData.ubl_sha256 ?? null,
      });
      saveState({ ...s, receivedId: rid });
      out("ack", {
        providerReceivedId: rid,
        ackHttpStatus: ack?.http_status ?? null,
        acknowledgedAt: ackData.acknowledged_at ?? null,
        alreadyAcknowledged: ackData.already_acknowledged ?? null,
        detailAcknowledgedAt: detailData.acknowledged_at ?? null,
        verified: typeof detailData.acknowledged_at === "string" && detailData.acknowledged_at === ackData.acknowledged_at,
      });
      break;
    }
    default:
      die(`neznámy krok ${step}`);
  }
} catch (error) {
  if (error instanceof EinvoiceProviderError) {
    console.error(`PROVIDER ERROR ${error.code} (retryable=${error.retryable}): ${error.message}`);
  } else {
    console.error("UNEXPECTED ERROR", error instanceof Error ? error.name : typeof error);
  }
  process.exit(1);
}
