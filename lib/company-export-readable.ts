// =============================================================================
// Čitateľná vrstva exportu firmy (CITATELNY_EXPORT/) — iba PREZENTÁCIA.
//
// Pravidlá (GDPR / rozsah dát):
//   - Vstupom sú VÝHRADNE riadky, ktoré už technický export obsahuje
//     (COMPANY_EXPORT_TABLES, rovnaký filter na firmu) — tento modul nič nečíta
//     z DB ani zo Storage. Povolené zdroje sú v READABLE_SOURCE_DATASETS.
//   - Žiadne nové kategórie údajov, žiadne interné/bezpečnostné logy, žiadne
//     webhook záznamy, žiadne IP adresy, žiadne AI surové výstupy.
//   - Originálne súbory sa NEDUPLIKUJÚ: čitateľné zoznamy odkazujú na cestu
//     súboru v dávkach „files/…“ toho istého exportu.
//   - Nič sa neukladá na serveri; obsah vzniká iba v pamäti pre jeden ZIP.
// =============================================================================

import { zipSafePath, type EinvoiceLifecycleEntry } from "./company-export.ts";

export const READABLE_ROOT = "CITATELNY_EXPORT";
export const HUMAN_READABLE_VERSION = "1";

/** Jediné datasety technického exportu, z ktorých čitateľná vrstva smie čerpať. */
export const READABLE_SOURCE_DATASETS = [
  "companies",
  "company_billing_profile",
  "company_legal_identities",
  "business_partners",
  "vehicles",
  "machines",
  "inventory_items",
  "documents",
  "invoices",
  "invoice_parties",
  "invoice_items",
  "invoice_tax_breakdowns",
  "invoice_advance_deductions",
  "einvoice_inbound",
  "einvoice_outbound",
  "einvoice_lifecycle",
] as const;
export type ReadableSource = (typeof READABLE_SOURCE_DATASETS)[number];

type Row = Record<string, unknown>;
export type ReadableDatasets = Partial<Record<Exclude<ReadableSource, "einvoice_lifecycle">, Row[]>> & { einvoice_lifecycle?: EinvoiceLifecycleEntry[] };

export type ReadableFile = { path: string; content: string | Uint8Array; sources: ReadableSource[]; kind: "csv" | "pdf" | "txt" };

// ---------------------------------------------------------------- formátovanie
const s = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** ISO dátum / čas → „14. 11. 2026“ / „14. 11. 2026 09:40“ (UTC). Iné hodnoty bez zmeny. */
export function skDate(v: unknown): string {
  const t = s(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(t);
  if (!m) return t;
  const d = `${Number(m[3])}. ${Number(m[2])}. ${m[1]}`;
  return m[4] ? `${d} ${m[4]}:${m[5]}` : d;
}

/** Číslo → „1 234,50“ (desatinná čiarka, Excel SK). */
export function skNumber(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return s(v);
  const [i, f] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${f}`;
}

const cell = (v: string) => (/[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV pre Excel (SK): UTF-8 BOM, oddeľovač „;“, pevné stĺpce s čitateľnými názvami. */
export function readableCsv(columns: string[], rows: string[][]): string {
  const lines = [columns.map(cell).join(";"), ...rows.map((r) => r.map(cell).join(";"))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

type Col = [label: string, get: (r: Row) => string];
function table(rows: Row[] | undefined, cols: Col[], sortKey?: (r: Row) => string): string {
  const list = [...(rows ?? [])];
  if (sortKey) list.sort((a, b) => sortKey(a).localeCompare(sortKey(b), "sk"));
  return readableCsv(cols.map((c) => c[0]), list.map((r) => cols.map((c) => c[1](r))));
}
const f = (k: string): ((r: Row) => string) => (r) => s(r[k]);
const fd = (k: string): ((r: Row) => string) => (r) => skDate(r[k]);
const fn = (k: string): ((r: Row) => string) => (r) => skNumber(r[k]);

// ---------------------------------------------------------------- číselníky
const DIRECTION: Record<string, string> = { issued: "vydaná", received: "prijatá" };
const DOC_STATUS: Record<string, string> = { draft: "koncept", finalized: "finalizovaná", cancelled: "stornovaná" };
const PAYMENT: Record<string, string> = { unpaid: "neuhradená", partially_paid: "čiastočne uhradená", paid: "uhradená", overpaid: "preplatená" };
const KIND: Record<string, string> = {
  regular_invoice: "faktúra", credit_note: "dobropis", debit_note: "ťarchopis", proforma_invoice: "zálohová faktúra",
  advance_invoice: "zálohová faktúra", payment_received_invoice: "faktúra k prijatej platbe",
};
const PARTNER_KIND: Record<string, string> = { customer: "odberateľ", supplier: "dodávateľ", both: "odberateľ aj dodávateľ" };
// documents.document_type / documents.status (CHECK v DB); popisky ako v appke. Neznáma hodnota = pôvodná.
const DOCUMENT_TYPE: Record<string, string> = {
  weigh_ticket: "vážny lístok", delivery_note: "dodací list", invoice: "faktúra", receipt: "bloček",
  insurance: "PZP / poistná zmluva", service_document: "servisný doklad", vehicle_registration: "technický preukaz vozidla", other: "iný dokument",
};
const DOCUMENT_STATE: Record<string, string> = {
  uploaded: "nahraný", processing: "spracúva sa", extracted: "vyčítaný", needs_review: "na kontrolu", confirmed: "potvrdený", failed: "chyba spracovania",
};

/** Označenie na každej strane PDF faktúry v čitateľnom exporte (nie je to nový originál dokladu). */
export const INVOICE_PREVIEW_NOTICE =
  "ČITATEĽNÝ NÁHĽAD z exportu údajov Esblu — vizualizácia uložených údajov faktúry. Nenahrádza originál dokladu ani originál e-faktúry (XML).";
const label = (map: Record<string, string>, v: unknown) => map[s(v)] ?? s(v);

// ---------------------------------------------------------------- CSV tabuľky
export function buildReadableCsvFiles(d: ReadableDatasets): ReadableFile[] {
  const out: ReadableFile[] = [];
  const partners = new Map((d.business_partners ?? []).map((p) => [s(p.id), s(p.legal_name)]));
  const filePath = (bucket: unknown, path: unknown) => (s(bucket) && s(path) ? zipSafePath(s(bucket), s(path)) : "");

  out.push({
    path: `${READABLE_ROOT}/Obchodni_partneri.csv`, kind: "csv", sources: ["business_partners"],
    content: table(d.business_partners, [
      ["Názov", f("legal_name")], ["Typ", (r) => label(PARTNER_KIND, r.kind)], ["IČO", f("ico")], ["DIČ", f("dic")], ["IČ DPH", f("ic_dph")],
      ["Ulica", f("address_line1")], ["Doplnok adresy", f("address_line2")], ["Mesto", f("city")], ["PSČ", f("postal_code")], ["Krajina", f("country_code")],
      ["E-mail", f("email")], ["Telefón", f("phone")], ["IBAN", f("iban")], ["BIC", f("bic")], ["Peppol ID", f("peppol_identifier")],
      ["Splatnosť (dni)", f("default_payment_terms_days")], ["Mena", f("default_currency")], ["Vytvorené", fd("created_at")],
    ], (r) => s(r.legal_name)),
  });

  out.push({
    path: `${READABLE_ROOT}/Vozidla.csv`, kind: "csv", sources: ["vehicles"],
    content: table(d.vehicles, [
      ["ŠPZ", f("spz")], ["VIN", f("vin")], ["Značka", f("znacka")], ["Model", f("model")], ["Rok výroby", f("rok_vyroby")],
      ["Palivo", f("palivo")], ["Objem", f("objem")], ["Výkon", f("vykon")], ["Farba", f("farba")], ["Hmotnosť", f("hmotnost")],
      ["Počet miest", f("pocet_miest")], ["Prvá evidencia", fd("datum_prvej_evidencie")], ["STK do", fd("stk")], ["EK do", fd("ek")],
    ], (r) => s(r.spz)),
  });

  out.push({
    path: `${READABLE_ROOT}/Stroje.csv`, kind: "csv", sources: ["machines"],
    content: table(d.machines, [
      ["Názov", f("name")], ["Kategória", f("category")], ["Výrobca", f("manufacturer")], ["Model", f("model")], ["Výrobné číslo", f("serial_number")],
      ["Rok", f("year")], ["Dátum kúpy", fd("purchase_date")], ["Stav", f("status")], ["Poznámka", f("notes")], ["Vytvorené", fd("created_at")],
    ], (r) => s(r.name)),
  });

  out.push({
    path: `${READABLE_ROOT}/Sklad.csv`, kind: "csv", sources: ["inventory_items"],
    content: table(d.inventory_items, [
      ["Položka", f("name")], ["Kategória", f("category")], ["Množstvo", fn("quantity")], ["Jednotka", f("unit")],
      ["Minimálne množstvo", fn("min_quantity")], ["Umiestnenie", f("location")], ["Poznámka", f("notes")], ["Vytvorené", fd("created_at")],
    ], (r) => s(r.name)),
  });

  // Dokumenty: iba popisné polia + odkaz na originál v dávkach súborov (žiadna kópia, žiadne AI výstupy).
  out.push({
    path: `${READABLE_ROOT}/Dokumenty.csv`, kind: "csv", sources: ["documents"],
    content: table((d.documents ?? []).filter((r) => !r.deleted_at), [
      ["Názov súboru", f("original_filename")], ["Typ dokladu", (r) => label(DOCUMENT_TYPE, r.document_type)], ["Stav", (r) => label(DOCUMENT_STATE, r.status)], ["Poznámka", f("note")],
      ["Nahrané", fd("created_at")], ["Veľkosť (B)", f("file_size")], ["SHA-256", f("content_sha256")],
      ["Súbor v exporte (dávky súborov)", (r) => filePath(r.storage_bucket, r.storage_path)],
    ], (r) => `${s(r.created_at)}${s(r.id)}`),
  });

  // Faktúry: zoznam všetkých dokladov (vydané aj prijaté); originál e-faktúry = XML v dávkach súborov.
  const xmlByInvoice = new Map<string, string>();
  for (const r of d.einvoice_inbound ?? []) if (r.invoice_id && r.xml_storage_path) xmlByInvoice.set(s(r.invoice_id), zipSafePath("einvoice-documents", s(r.xml_storage_path)));
  for (const r of d.einvoice_outbound ?? []) if (r.invoice_id && r.ubl_storage_path) xmlByInvoice.set(s(r.invoice_id), zipSafePath("einvoice-documents", s(r.ubl_storage_path)));
  const pdfName = new Map(issuedInvoicePdfNames(d.invoices).map((x) => [x.id, x.path]));
  out.push({
    path: `${READABLE_ROOT}/Faktury/Zoznam_faktur.csv`, kind: "csv", sources: ["invoices", "business_partners", "einvoice_inbound", "einvoice_outbound"],
    content: table(d.invoices, [
      ["Číslo", (r) => s(r.invoice_number) || s(r.supplier_invoice_number)], ["Smer", (r) => label(DIRECTION, r.direction)], ["Druh", (r) => label(KIND, r.kind)],
      ["Stav", (r) => label(DOC_STATUS, r.document_status)], ["Úhrada", (r) => label(PAYMENT, r.payment_status)],
      ["Odberateľ / dodávateľ", (r) => partners.get(s(r.direction === "received" ? r.supplier_business_partner_id : r.customer_business_partner_id)) ?? ""],
      ["Dátum vystavenia", fd("issue_date")], ["Dátum dodania", fd("delivery_date")], ["Splatnosť", fd("due_date")], ["Mena", f("currency")],
      ["Základ", fn("subtotal_amount")], ["DPH", fn("vat_total_amount")], ["Spolu", fn("total_amount")], ["Variabilný symbol", f("variable_symbol")],
      ["Vizualizácia PDF (CITATELNY_EXPORT)", (r) => pdfName.get(s(r.id)) ?? ""],
      ["Originál e-faktúry XML (dávky súborov)", (r) => xmlByInvoice.get(s(r.id)) ?? ""],
    ], (r) => `${s(r.issue_date)}${s(r.invoice_number)}${s(r.id)}`),
  });

  // eFaktúra: kanonický životný cyklus (rovnaké údaje ako data/einvoice_lifecycle.*), bez webhook logov.
  out.push({
    path: `${READABLE_ROOT}/eFaktury_historia.csv`, kind: "csv", sources: ["einvoice_lifecycle"],
    content: readableCsv(
      ["Smer", "Číslo dokladu", "Stav", "ID u poskytovateľa", "ID dokumentu poskytovateľa", "Protistrana (Peppol)", "SBDH InstanceIdentifier", "AS4 message ID",
        "SHA-256 originálu", "Originál (dávky súborov)", "Prijaté", "Potvrdené (ACK)", "Odoslané", "Doručené", "Zlyhanie", "Posledný kód chyby", "Dôkaz doručenia", "História stavov"],
      (d.einvoice_lifecycle ?? []).map((e) => [
        e.direction === "inbound" ? "prijatá" : "odoslaná", s(e.document_number), s(e.state), s(e.provider_reference), s(e.provider_document_id),
        s(e.counterparty_participant_id), s(e.sbdh_instance_identifier), s(e.as4_message_id), s(e.sha256), s(e.original_file),
        skDate(e.received_at), skDate(e.acknowledged_at), skDate(e.sent_at), skDate(e.delivered_at), skDate(e.failed_at), s(e.last_error_code),
        e.delivery_evidence ? s(e.delivery_evidence) : "",
        e.history.map((h) => `${skDate(h.at)} ${s(h.from) || "∅"}→${s(h.to)}${h.provider_code ? ` (${h.provider_code})` : ""}`).join(" | "),
      ])
    ),
  });
  return out;
}

/** Názvy PDF vizualizácií finalizovaných vydaných faktúr (bezpečné, deterministické). */
export function issuedInvoicePdfNames(invoices: Row[] | undefined): { id: string; path: string }[] {
  const used = new Set<string>();
  return (invoices ?? [])
    .filter((r) => r.direction === "issued" && r.document_status === "finalized")
    .sort((a, b) => `${s(a.issue_date)}${s(a.invoice_number)}`.localeCompare(`${s(b.issue_date)}${s(b.invoice_number)}`))
    .map((r) => {
      const base = (s(r.invoice_number) || s(r.id)).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "faktura";
      let name = `${base}.pdf`;
      for (let i = 2; used.has(name); i++) name = `${base}_${i}.pdf`;
      used.add(name);
      return { id: s(r.id), path: `${READABLE_ROOT}/Faktury/${name}` };
    });
}

/** Podklady pre PDF vizualizáciu vydanej faktúry — iba z exportovaných riadkov (rovnaká logika ako /api/invoices/[id]/pdf). */
export function issuedInvoiceBundles(d: ReadableDatasets): Array<{ id: string; path: string; invoice: Row; seller: Row | null; buyer: Row | null; items: Row[]; taxBreakdowns: Row[]; correctedInvoiceNumber: string | null; advanceDeductions: { taxable_amount: number; vat_amount: number; advance_number: string | null }[] }> {
  const byInv = <T extends Row>(rows: T[] | undefined) => {
    const m = new Map<string, T[]>();
    for (const r of rows ?? []) {
      const k = s(r.invoice_id);
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const parties = byInv(d.invoice_parties), items = byInv(d.invoice_items), tax = byInv(d.invoice_tax_breakdowns), ded = byInv(d.invoice_advance_deductions);
  const numberOf = new Map((d.invoices ?? []).map((i) => [s(i.id), (i.invoice_number as string | null) ?? null]));
  const invById = new Map((d.invoices ?? []).map((i) => [s(i.id), i]));
  return issuedInvoicePdfNames(d.invoices).map(({ id, path }) => {
    const invoice = invById.get(id)!;
    const ps = parties.get(id) ?? [];
    const its = [...(items.get(id) ?? [])].sort((a, b) => Number(a.position) - Number(b.position));
    const hasDeductionLines = its.some((i) => i.is_advance_deduction === true);
    return {
      id, path, invoice,
      seller: ps.find((p) => p.role === "seller") ?? null,
      buyer: ps.find((p) => p.role === "buyer") ?? null,
      items: its,
      taxBreakdowns: [...(tax.get(id) ?? [])].sort((a, b) => s(a.vat_category_code).localeCompare(s(b.vat_category_code))),
      correctedInvoiceNumber: invoice.corrects_invoice_id ? numberOf.get(s(invoice.corrects_invoice_id)) ?? null : null,
      advanceDeductions: hasDeductionLines ? [] : (ded.get(id) ?? []).map((x) => ({
        taxable_amount: Number(x.taxable_amount), vat_amount: Number(x.vat_amount), advance_number: numberOf.get(s(x.advance_invoice_id)) ?? null,
      })),
    };
  });
}

/** Údaje prehľadu firmy (PDF) — iba z exportovaných riadkov. */
export function companyOverview(d: ReadableDatasets, generatedAt: string, counts: Record<string, number>) {
  const company = (d.companies ?? [])[0] ?? {};
  const bp = (d.company_billing_profile ?? [])[0] ?? {};
  const li = (d.company_legal_identities ?? [])[0] ?? {};
  const address = [s(bp.address_line1), s(bp.address_line2), [s(bp.postal_code), s(bp.city)].filter(Boolean).join(" "), s(bp.country_code)].filter(Boolean).join(", ");
  return {
    name: s(bp.legal_name) || s(company.name),
    ico: s(bp.ico) || s(li.registration_id),
    dic: s(bp.dic),
    icDph: s(bp.ic_dph),
    address,
    contactEmail: s(bp.contact_email),
    generatedAt: skDate(generatedAt),
    areas: [
      ["Obchodní partneri", counts.business_partners ?? 0],
      ["Vozidlá", counts.vehicles ?? 0],
      ["Stroje", counts.machines ?? 0],
      ["Skladové položky", counts.inventory_items ?? 0],
      ["Dokumenty", counts.documents ?? 0],
      ["Faktúry (vydané aj prijaté)", counts.invoices ?? 0],
      ["eFaktúry (záznamy životného cyklu)", counts.einvoice_lifecycle ?? 0],
    ] as [string, number][],
  };
}

export const README_TEXT = [
  "ČITATEĽNÝ EXPORT ÚDAJOV FIRMY (Esblu)",
  "",
  "Tento priečinok je iba prehľadnejšia prezentácia tých istých údajov, ktoré sú v technickej časti exportu",
  "(data/*.json, data/*.csv, manifest.json) a v dávkach originálnych súborov (files/...). Nepridáva nové údaje.",
  "",
  "Prehlad_firmy.pdf             – súhrn firmy a rozsah exportu",
  "Faktury/Zoznam_faktur.csv     – všetky faktúry (vydané aj prijaté)",
  "Faktury/*.pdf                 – VIZUALIZÁCIA finalizovaných vydaných faktúr z uložených údajov;",
  "                                 nie je to nový právny originál. Originál e-faktúry je XML v dávkach súborov.",
  "Dokumenty.csv                 – zoznam dokumentov; originály sú v dávkach súborov (stĺpec „Súbor v exporte“)",
  "Vozidla.csv, Stroje.csv, Sklad.csv, Obchodni_partneri.csv – tabuľky pre Excel (oddeľovač ;)",
  "eFaktury_historia.csv         – životný cyklus e-faktúr (identifikátory, stavy, časy, dôkaz doručenia)",
  "",
  "Export nie je zákonný archív. Za uchovávanie účtovných dokladov zodpovedá firma.",
  "",
].join("\r\n");
