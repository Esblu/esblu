// =============================================================================
// Priečinky dokladov, balík s originálmi, stav stiahnutia, hlasové príkazy.
//
// SPUSTENIE
//   npm run test:folders
//
// ČO SA TU CHRÁNI
// ---------------
//   1. Priečinok organizuje odkazy — balík berie kanonické doklady a ich
//      SKUTOČNÉ originály, nič nenahrádza.
//   2. Prijatá faktúra: originál je VÝHRADNE source_document_id; sprievodný
//      dokument sa nikdy netvári ako originál.
//   3. Do balíka ani medzi „stiahnuté" sa nedostane koncept ani doklad bez
//      originálu.
//   4. Manifest sedí s obsahom ZIP-u bajt po bajte.
//   5. „Stiahnuté" je história, nie zámok; neúplné bajty sa nepotvrdia.
//   6. Nástenka rozumie príkazom k priečinkom a nepoužije „tento doklad"
//      bez výberu.
//
// Databázové oprávnenia (RLS matica, cudzí tenant, anon, nemennosť
// udalostí) testuje scripts/sql/document-folders-rls-matrix.sql.
// =============================================================================

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import {
  buildDownloadStateMap,
  categoryOf,
  decodeExcludedHeader,
  downloadStateOf,
  encodeExcludedHeader,
  entryDirectory,
  folderPackageProblems,
  isFolderDocumentType,
  matchesDownloadFilter,
  planEntry,
  verifyPackageBytes,
  documentPackageRoot,
  type PackageDocumentInput,
  type PackageInvoiceInput,
} from "../lib/invoicing/document-package.ts";
import { isSafeZipPath } from "../lib/invoicing/handoff-package.ts";
import { buildDocumentPackage, DOCUMENT_PACKAGE_ERROR_CODES } from "../lib/invoicing/document-package-server.ts";
import { parseIntentDeterministic } from "../lib/intents/parse.ts";
import { folderIntentPermission, isFolderFamilyIntent, isFolderWriteIntent } from "../lib/intents/folder-intents.ts";
import { INTENT_REGISTRY, isRegisteredWriteIntent, isRegisteredReadOnlyIntent } from "../lib/intents/registry.ts";
import { matchFolderByName, normalizeFolderName } from "../lib/document-folders.ts";
import { hasTranslation } from "../lib/i18n/translate.ts";

let passed = 0;
let failed = 0;

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const enc = (text: string) => new TextEncoder().encode(text);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// -----------------------------------------------------------------------------
// Mock Supabase klienta — iba to, čo builder naozaj volá.
// -----------------------------------------------------------------------------

type Row = Record<string, unknown>;

function mockDb(tables: Record<string, Row[]>, objects: Record<string, Uint8Array>) {
  const inserts: Record<string, Row[]> = {};
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let single = false;
    const builder = {
      select: () => builder,
      in: (col: string, values: unknown[]) => (filters.push((r) => values.includes(r[col])), builder),
      eq: (col: string, value: unknown) => (filters.push((r) => r[col] === value), builder),
      is: (col: string, value: unknown) => (filters.push((r) => (r[col] ?? null) === value), builder),
      gte: () => builder,
      lte: () => builder,
      order: () => builder,
      limit: () => builder,
      returns: () => builder,
      maybeSingle: () => ((single = true), builder),
      insert: (rows: Row | Row[]) => {
        inserts[table] = [...(inserts[table] ?? []), ...(Array.isArray(rows) ? rows : [rows])];
        return Promise.resolve({ error: null });
      },
      then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
        const rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
        return Promise.resolve(resolve({ data: single ? rows[0] ?? null : rows, error: null }));
      },
    };
    return builder;
  };
  const storage = {
    from: (bucket: string) => ({
      download: async (path: string) => {
        const bytes = objects[`${bucket}/${path}`];
        return bytes ? { data: new Blob([bytes as unknown as BlobPart]), error: null } : { data: null, error: { message: "not found" } };
      },
    }),
  };
  return { db: { from, storage } as never, inserts };
}

const COMPANY = uuid(1);

function invoice(n: number, over: Partial<Row>): Row {
  return {
    id: uuid(n), company_id: COMPANY, direction: "issued", kind: "regular_invoice", document_status: "finalized",
    payment_status: "unpaid", invoice_number: `FA2026${n}`, supplier_invoice_number: null, issue_date: "2026-08-10",
    delivery_date: null, tax_point_date: null, due_date: null, currency: "EUR", variable_symbol: null,
    subtotal_amount: 100, vat_total_amount: 23, rounding_amount: 0, total_amount: 123, finalized_at: "2026-08-10T10:00:00Z",
    source_document_id: null, supplier_business_partner_id: null, customer_business_partner_id: null, ...over,
  };
}

function doc(n: number, over: Partial<Row>, bytes?: Uint8Array, hashOk = true): Row {
  return {
    id: uuid(n), company_id: COMPANY, document_type: "receipt", status: "confirmed", storage_bucket: "ai-inbox-documents",
    storage_path: `u/${n}.jpg`, original_filename: `blocek-${n}.jpg`, mime_type: "image/jpeg", file_size: 10,
    content_sha256: bytes ? (hashOk ? sha(bytes) : "f".repeat(64)) : null, deleted_at: null,
    extracted_fields: { merchant: `Obchod ${n}`, purchaseDate: "2026-08-0" + (n % 9 || 1), totalAmount: "12.50", currency: "EUR" },
    note: null, created_at: "2026-08-02T08:00:00Z", ...over,
  };
}

function fixture() {
  const objects: Record<string, Uint8Array> = {};
  const docs: Row[] = [];
  for (const n of [11, 12, 13]) {
    const bytes = enc(`JPEG-receipt-${n}`);
    objects[`ai-inbox-documents/u/${n}.jpg`] = bytes;
    docs.push(doc(n, {}, n === 13 ? undefined : bytes)); // jeden bez uloženého odtlačku
  }
  // pokus o path traversal v mene obchodníka
  docs[0].extracted_fields = { merchant: "../../etc/passwd", purchaseDate: "2026-08-01", totalAmount: "1", currency: "EUR" };

  for (const n of [21, 22]) {
    const bytes = enc(`%PDF-supplier-original-${n}`);
    objects[`ai-inbox-documents/u/${n}.pdf`] = bytes;
    docs.push(doc(n, { document_type: "invoice", storage_path: `u/${n}.pdf`, original_filename: `dodavatel-${n}.pdf`, mime_type: "application/pdf" }, bytes));
  }
  // sprievodný dokument k prijatej faktúre 31 (dodací list)
  const supportingBytes = enc("delivery-note-bytes");
  objects["ai-inbox-documents/u/25.jpg"] = supportingBytes;
  docs.push(doc(25, { document_type: "delivery_note", storage_path: "u/25.jpg", original_filename: "dodaci-list.jpg" }, supportingBytes));

  const invoices = [
    invoice(31, { direction: "received", invoice_number: null, supplier_invoice_number: "DF-31", source_document_id: uuid(21) }),
    invoice(32, { direction: "received", invoice_number: null, supplier_invoice_number: "DF-32", source_document_id: uuid(22) }),
    invoice(33, { direction: "issued" }),
    invoice(34, { direction: "issued", document_status: "draft", invoice_number: null, finalized_at: null }),
    invoice(35, { direction: "received", invoice_number: null, supplier_invoice_number: "DF-35", source_document_id: null }),
  ];

  const tables: Record<string, Row[]> = {
    invoices,
    invoice_items: [{ invoice_id: uuid(33), position: 1, description: "Práca", quantity: 1, unit: "ks", unit_price: 100 }],
    invoice_parties: [{ invoice_id: uuid(33), role: "seller", legal_name: "Esblu test s.r.o." }],
    invoice_tax_breakdowns: [],
    document_links: [{ document_id: uuid(25), invoice_id: uuid(31) }, { document_id: uuid(21), invoice_id: uuid(31) }],
    documents: docs,
    document_attachments: [],
    business_partners: [],
    document_folders: [{ id: uuid(90), name: "August 2026" }],
  };
  return { tables, objects };
}

const fakePdf = async () => enc("%PDF-1.4 generated-by-test");

// =============================================================================
// 1. Pravidlá originálu a vynechania
// =============================================================================

const inv = (over: Partial<PackageInvoiceInput>): PackageInvoiceInput => ({
  entityType: "invoice", id: uuid(1), direction: "received", document_status: "finalized",
  invoice_number: null, supplier_invoice_number: "X", issue_date: "2026-08-01", source_document_id: uuid(2), ...over,
});
const dd = (over: Partial<PackageDocumentInput>): PackageDocumentInput => ({
  entityType: "document", id: uuid(3), document_type: "receipt", storage_path: "a/b.jpg", deleted_at: null,
  original_filename: "b.jpg", extracted_fields: null, created_at: null, ...over,
});

await check("prijatá faktúra: originál = source_document_id", () => {
  assert.deepEqual(planEntry(inv({}), { sourceDocumentAvailable: true }), {
    included: true, original: { kind: "source_document", documentId: uuid(2) },
  });
});
await check("prijatá faktúra bez source_document_id sa vynechá (žiadna náhrada)", () => {
  assert.deepEqual(planEntry(inv({ source_document_id: null }), { sourceDocumentAvailable: true }), {
    included: false, reason: "missing_original",
  });
});
await check("prijatá faktúra s nedostupným originálom sa vynechá", () => {
  assert.deepEqual(planEntry(inv({}), { sourceDocumentAvailable: false }), { included: false, reason: "missing_original" });
});
await check("koncept vydanej faktúry sa vynechá", () => {
  assert.deepEqual(planEntry(inv({ direction: "issued", document_status: "draft" })), {
    included: false, reason: "draft_not_finalized",
  });
});
await check("finalizovaná vydaná faktúra = PDF z dokladu", () => {
  assert.deepEqual(planEntry(inv({ direction: "issued" })), { included: true, original: { kind: "generated_pdf" } });
});
await check("bloček = vlastný nahraný súbor", () => {
  assert.deepEqual(planEntry(dd({})), { included: true, original: { kind: "own_object" } });
});
await check("zmazaný dokument a PZP sa do balíka nedostanú", () => {
  assert.equal(planEntry(dd({ deleted_at: "2026-01-01" })).included, false);
  assert.equal(planEntry(dd({ document_type: "insurance" })).included, false);
  assert.equal(isFolderDocumentType("vehicle_registration"), false);
});
await check("dokument bez súboru = chýba originál", () => {
  assert.deepEqual(planEntry(dd({ storage_path: null })), { included: false, reason: "missing_original" });
});
await check("kategórie priečinkov v ZIP-e", () => {
  assert.equal(categoryOf(dd({})), "receipts");
  assert.equal(categoryOf(inv({})), "received_invoices");
  assert.equal(categoryOf(inv({ direction: "issued" })), "issued_invoices");
  assert.ok(entryDirectory(dd({ extracted_fields: { merchant: "../../x" } })).startsWith("blocky/"));
  assert.ok(isSafeZipPath(entryDirectory(dd({ extracted_fields: { merchant: "..\\..\\evil/../x" } }))));
});
await check("koreň balíka je bezpečné meno priečinka", () => {
  assert.equal(documentPackageRoot("August 2026", new Date()), "August-2026");
  assert.ok(isSafeZipPath(documentPackageRoot("../../Stavba Žilina", new Date())));
  assert.match(documentPackageRoot(null, new Date(2026, 8, 23, 14, 5)), /^esblu-doklady-2026-09-23-1405$/);
});
await check("kontrola balíka chytí duplicitu a nebezpečnú cestu", () => {
  const codes = folderPackageProblems([{ path: "a/x", bytes: 1 }, { path: "a/x", bytes: 1 }, { path: "../y", bytes: 1 }], 1)
    .map((p) => p.code);
  assert.ok(codes.includes("duplicate_path"));
  assert.ok(codes.includes("unsafe_path"));
  assert.deepEqual(folderPackageProblems([], 0).map((p) => p.code), ["empty_package"]);
});
await check("hlavička vynechaných dokladov je ohraničená a odolná voči podvrhu", () => {
  const encoded = encodeExcludedHeader([{ entity_type: "invoice", entity_id: uuid(5), label: "FA-1", reason: "missing_original" }]);
  assert.deepEqual(decodeExcludedHeader(encoded), [{ entity_type: "invoice", entity_id: uuid(5), label: "FA-1", reason: "missing_original" }]);
  assert.deepEqual(decodeExcludedHeader(encodeURIComponent(JSON.stringify([{ t: "x", i: "1", l: "a", r: "hack" }]))), []);
  assert.deepEqual(decodeExcludedHeader("%%%"), []);
});

// =============================================================================
// 2. Priečinok naprieč modulmi → ZIP s originálmi
// =============================================================================

await check("priečinok August 2026: 3 bločky + 2 prijaté + 1 vydaná = 6 dokladov, koncept a doklad bez originálu vynechané", async () => {
  const { tables, objects } = fixture();
  const { db, inserts } = mockDb(tables, objects);
  const refs = [
    ...[11, 12, 13].map((n) => ({ type: "document" as const, id: uuid(n) })),
    ...[31, 32, 33, 34, 35].map((n) => ({ type: "invoice" as const, id: uuid(n) })),
  ];
  const result = await buildDocumentPackage({
    db, locale: "sk", companyId: COMPANY, userId: uuid(2), kind: "folder", folderId: uuid(90), refs, renderPdf: fakePdf,
  });
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;

  assert.equal(result.fileName, "August-2026.zip");
  assert.equal(result.manifest.entry_count, 6);
  assert.deepEqual(
    result.manifest.excluded.map((e) => [e.entity_id, e.reason]).sort(),
    [[uuid(34), "draft_not_finalized"], [uuid(35), "missing_original"]].sort()
  );

  const zip = await JSZip.loadAsync(result.zipBytes);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const root = "August-2026/";
  assert.ok(names.every((n) => n.startsWith(root) && isSafeZipPath(n)), "všetko pod koreňom, bezpečné cesty");

  const receiptOriginals = names.filter((n) => n.startsWith(`${root}blocky/`) && /\/original\.jpg$/.test(n));
  assert.equal(receiptOriginals.length, 3, "3 originály bločkov");
  const receivedOriginals = names.filter((n) => n.startsWith(`${root}prijate-faktury/`) && /\/original\.pdf$/.test(n));
  assert.equal(receivedOriginals.length, 2, "2 originály prijatých faktúr");
  assert.equal(names.filter((n) => n.startsWith(`${root}vystavene-faktury/`) && n.endsWith("/invoice.pdf")).length, 1);
  assert.ok(names.includes(`${root}prehlad.xlsx`));
  assert.ok(names.includes(`${root}manifest.json`));

  // Originál prijatej faktúry sú bajty zo source_document_id, nie sprievodný dokument.
  const df31 = receivedOriginals.find((n) => n.includes("DF-31"))!;
  assert.equal(new TextDecoder().decode(await zip.file(df31)!.async("uint8array")), "%PDF-supplier-original-21");
  const supporting = names.filter((n) => n.includes("/supporting/"));
  assert.equal(supporting.length, 1, "dodací list je sprievodný dokument");
  assert.ok(!supporting[0].includes("original"));

  // Manifest: každý súbor sedí bajt po bajte.
  const manifest = JSON.parse(await zip.file(`${root}manifest.json`)!.async("string"));
  assert.equal(manifest.file_count, names.length - 1);
  for (const file of manifest.files as { path: string; sha256: string }[]) {
    const bytes = await zip.file(`${root}${file.path}`)!.async("uint8array");
    assert.equal(sha(bytes), file.sha256, file.path);
  }
  assert.equal(sha(result.zipBytes), result.packageSha256);

  // Evidované sú PRESNE zahrnuté doklady — nie koncept ani doklad bez originálu.
  const items = inserts["document_export_package_items"] ?? [];
  assert.equal(items.length, 6);
  assert.ok(!items.some((i) => i.entity_ref === uuid(34) || i.entity_ref === uuid(35)));
  assert.equal(inserts["document_export_packages"]?.[0]?.package_sha256, result.packageSha256);
  // Balík NEZAPISUJE stiahnutie.
  assert.equal(inserts["document_download_events"], undefined);
});

await check("Inbox export 2 bločkov obsahuje oba pôvodné súbory", async () => {
  const { tables, objects } = fixture();
  const { db } = mockDb(tables, objects);
  const result = await buildDocumentPackage({
    db, locale: "sk", companyId: COMPANY, userId: uuid(2), kind: "inbox_selection", folderId: null,
    refs: [{ type: "document", id: uuid(12) }, { type: "document", id: uuid(13) }], renderPdf: fakePdf,
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  const zip = await JSZip.loadAsync(result.zipBytes);
  const originals = Object.keys(zip.files).filter((n) => /\/blocky\/.+\/original\.jpg$/.test(n));
  assert.equal(originals.length, 2);
  const contents = await Promise.all(originals.map((n) => zip.file(n)!.async("string")));
  assert.deepEqual(contents.sort(), ["JPEG-receipt-12", "JPEG-receipt-13"]);
});

await check("zmenený originál (nesedí odtlačok) zastaví balík a nič sa nezaeviduje", async () => {
  const { tables, objects } = fixture();
  tables.documents[1].content_sha256 = "e".repeat(64);
  const { db, inserts } = mockDb(tables, objects);
  const result = await buildDocumentPackage({
    db, locale: "sk", companyId: COMPANY, userId: uuid(2), kind: "selection", folderId: null,
    refs: [{ type: "document", id: uuid(12) }], renderPdf: fakePdf,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "INTEGRITY_FAILED");
  assert.equal(inserts["document_export_packages"], undefined);
  assert.equal(inserts["document_export_package_items"], undefined);
});

await check("chýbajúci súbor v úložisku = vynechanie, nie náhrada", async () => {
  const { tables, objects } = fixture();
  delete objects["ai-inbox-documents/u/11.jpg"];
  const { db, inserts } = mockDb(tables, objects);
  const result = await buildDocumentPackage({
    db, locale: "sk", companyId: COMPANY, userId: uuid(2), kind: "selection", folderId: null,
    refs: [{ type: "document", id: uuid(11) }, { type: "document", id: uuid(12) }], renderPdf: fakePdf,
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.manifest.entry_count, 1);
  assert.deepEqual(result.manifest.excluded.map((e) => e.reason), ["missing_original"]);
  assert.equal(inserts["document_export_package_items"]?.length, 1);
});

await check("samé koncepty = žiadny balík", async () => {
  const { tables, objects } = fixture();
  const { db, inserts } = mockDb(tables, objects);
  const result = await buildDocumentPackage({
    db, locale: "sk", companyId: COMPANY, userId: uuid(2), kind: "selection", folderId: null,
    refs: [{ type: "invoice", id: uuid(34) }], renderPdf: fakePdf,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "NOTHING_TO_PACKAGE");
  assert.equal(inserts["document_export_packages"], undefined);
});

await check("doklad cudzej firmy (vrátený mimo RLS) sa nezabalí", async () => {
  const { tables, objects } = fixture();
  tables.documents[0].company_id = uuid(999);
  const { db } = mockDb(tables, objects);
  const result = await buildDocumentPackage({
    db, locale: "sk", companyId: COMPANY, userId: uuid(2), kind: "selection", folderId: null,
    refs: [{ type: "document", id: uuid(11) }], renderPdf: fakePdf,
  });
  assert.equal(result.ok, false);
});

await check("každý chybový kód balíka má preklad v SK/DE/EN", () => {
  for (const code of [...DOCUMENT_PACKAGE_ERROR_CODES, "INCOMPLETE_TRANSFER"]) {
    for (const locale of ["sk", "de", "en"] as const) {
      assert.ok(hasTranslation(locale, `folders.package.errors.${code}`), `${locale} ${code}`);
    }
  }
  for (const reason of ["draft_not_finalized", "missing_original", "unknown_direction", "deleted", "not_accessible"]) {
    assert.ok(hasTranslation("de", `folders.excludedReason.${reason}`));
  }
});

// =============================================================================
// 3. Stav stiahnutia
// =============================================================================

await check("stav stiahnutia: nikdy / 1× / 2× a filter", () => {
  const map = buildDownloadStateMap([
    { entity_type: "invoice", entity_ref: uuid(1), download_count: "2", accountant_download_count: 1, last_downloaded_at: "2026-09-23T10:00:00Z", last_downloaded_by: uuid(9) },
    { entity_type: "document", entity_ref: uuid(2), download_count: 1, accountant_download_count: 0, last_downloaded_at: null, last_downloaded_by: null },
    { garbage: true },
    null,
  ]);
  assert.equal(downloadStateOf(map, "invoice", uuid(1)).count, 2);
  assert.equal(downloadStateOf(map, "invoice", uuid(1)).downloaded, true);
  assert.equal(downloadStateOf(map, "document", uuid(2)).accountantCount, 0);
  const never = downloadStateOf(map, "invoice", uuid(3));
  assert.equal(never.downloaded, false);
  assert.ok(matchesDownloadFilter(never, "not_downloaded"));
  assert.ok(!matchesDownloadFilter(never, "downloaded"));
  assert.ok(matchesDownloadFilter(downloadStateOf(map, "invoice", uuid(1)), "downloaded"));
  assert.ok(matchesDownloadFilter(never, "all"));
});

await check("prijaté bajty: celé = potvrdí sa; neúplné/iné/bez hlavičky = nepotvrdí sa", async () => {
  const bytes = enc("zip-bytes-complete");
  const good = sha(bytes);
  assert.equal((await verifyPackageBytes(bytes, good)).ok, true);
  assert.equal((await verifyPackageBytes(bytes.slice(0, 5), good)).ok, false, "neúplný prenos");
  assert.equal((await verifyPackageBytes(enc("iné"), good)).ok, false);
  assert.equal((await verifyPackageBytes(bytes, null)).ok, false, "chýba hlavička");
  assert.equal((await verifyPackageBytes(bytes, "abc")).ok, false);
});

// =============================================================================
// 4. Nástenka — prirodzené príkazy
// =============================================================================

type Expect = { name: string; args?: Record<string, unknown> };
const commands: [string, Expect][] = [
  ["Vytvor priečinok August 2026.", { name: "FOLDER_CREATE", args: { folderName: "August 2026" } }],
  ["Daj všetky bločky za august do priečinka August 2026.", { name: "FOLDER_ADD_ITEMS", args: { folderName: "August 2026", documentTypes: ["receipt"] } }],
  ["Pridaj do priečinka August aj prijaté faktúry za august.", { name: "FOLDER_ADD_ITEMS", args: { folderName: "August", invoiceDirection: "received", documentTypes: ["invoice"] } }],
  ["Ukáž mi nestiahnuté doklady za august.", { name: "DOCUMENTS_LIST_UNDOWNLOADED" }],
  ["Stiahni priečinok August 2026.", { name: "FOLDER_EXPORT", args: { folderName: "August 2026" } }],
  ["Koľko faktúr ešte účtovníčka nestiahla?", { name: "DOCUMENTS_DOWNLOAD_STATUS", args: { byAccountant: true, documentTypes: ["invoice"] } }],
  ["Otvor priečinok Podklady pre účtovníčku.", { name: "FOLDER_OPEN", args: { folderName: "Podklady pre účtovníčku" } }],
  ["Presuň tieto doklady do priečinka September.", { name: "FOLDER_ADD_ITEMS", args: { folderName: "September", useSelection: true, move: true } }],
  ["Daj tam bločky za august", { name: "FOLDER_ADD_ITEMS", args: { documentTypes: ["receipt"] } }],
  ["Ukáž nestiahnuté faktúry za august", { name: "DOCUMENTS_LIST_UNDOWNLOADED", args: { documentTypes: ["invoice"] } }],
  ["Stiahni August 2026", { name: "FOLDER_EXPORT", args: { folderName: "August 2026" } }],
  ["Stiahni všetky faktúry", { name: "DOCUMENTS_EXPORT", args: { documentTypes: ["invoice"] } }],
  ["Create accounting folder August 2026", { name: "FOLDER_CREATE", args: { folderName: "August 2026" } }],
  ["Erstelle Belegordner August 2026", { name: "FOLDER_CREATE", args: { folderName: "August 2026" } }],
  ["How many invoices has the accountant not downloaded?", { name: "DOCUMENTS_DOWNLOAD_STATUS", args: { byAccountant: true } }],
  ["Wie viele Rechnungen hat der Buchhalter noch nicht heruntergeladen?", { name: "DOCUMENTS_DOWNLOAD_STATUS", args: { byAccountant: true } }],
  // Bez regresie existujúcich príkazov:
  ["Vytvor zložku Reklamácie", { name: "CREATE_DOCUMENT_CATEGORY" }],
  ["Exportuj bločky za august", { name: "EXPORT_DOCUMENTS" }],
  ["Otvor sklad", { name: "OPEN_MODULE" }],
];

for (const [text, expected] of commands) {
  await check(`príkaz: ${text}`, () => {
    const parsed = parseIntentDeterministic(text);
    assert.ok(parsed, "rozpoznaný");
    assert.equal(parsed!.name, expected.name);
    for (const [key, value] of Object.entries(expected.args ?? {})) {
      assert.deepEqual((parsed!.args as Record<string, unknown>)[key], value, key);
    }
  });
}

await check("„tento rok“ nie je výber dokladov", () => {
  const parsed = parseIntentDeterministic("Daj všetky doklady za tento rok do priečinka X");
  assert.equal(parsed?.name, "FOLDER_ADD_ITEMS");
  assert.equal(parsed?.args.useSelection, undefined);
});
await check("„Ukáž stiahnuté faktúry“ nespustí sťahovanie", () => {
  assert.notEqual(parseIntentDeterministic("Ukáž stiahnuté faktúry")?.name, "DOCUMENTS_EXPORT");
});
await check("mazanie priečinka = FOLDER_DELETE (s potvrdením); „z priečinka“ = vyradenie", () => {
  const deleted = parseIntentDeterministic("Vymaž priečinok August 2026");
  assert.equal(deleted?.name, "FOLDER_DELETE");
  assert.equal(deleted?.args.folderName, "August 2026");
  assert.notEqual(parseIntentDeterministic("Vymaž tento doklad z priečinka August 2026")?.name, "FOLDER_DELETE");
});

await check("oprávnenia intentov: priečinky = manage, stav = view; zápisy s potvrdením", () => {
  for (const name of ["FOLDER_CREATE", "FOLDER_ADD_ITEMS", "FOLDER_REMOVE_ITEMS", "FOLDER_EXPORT", "DOCUMENTS_EXPORT", "FOLDER_OPEN", "FOLDER_LIST_ITEMS"] as const) {
    assert.equal(folderIntentPermission(name), "manage", name);
    assert.ok(isFolderFamilyIntent(name));
  }
  assert.equal(folderIntentPermission("DOCUMENTS_LIST_UNDOWNLOADED"), "view");
  assert.equal(folderIntentPermission("DOCUMENTS_DOWNLOAD_STATUS"), "view");
  for (const name of ["FOLDER_CREATE", "FOLDER_ADD_ITEMS", "FOLDER_REMOVE_ITEMS"] as const) {
    assert.ok(isFolderWriteIntent(name));
    assert.ok(isRegisteredWriteIntent(name), `${name} vyžaduje potvrdenie`);
    assert.equal(INTENT_REGISTRY[name].requiresConfirmation, true);
  }
  assert.ok(isRegisteredReadOnlyIntent("FOLDER_OPEN"));
  assert.ok(!isFolderWriteIntent("FOLDER_EXPORT"));
});

await check("meno priečinka: normalizácia a zhoda bez hádania", () => {
  assert.equal(normalizeFolderName("  August   2026 "), "August 2026");
  assert.equal(normalizeFolderName(""), null);
  assert.equal(normalizeFolderName("x".repeat(121)), null);
  const folders = [{ name: "August 2026" }, { name: "September 2026" }, { name: "Stavba Žilina" }];
  assert.deepEqual(matchFolderByName(folders, "august 2026"), { folder: folders[0] });
  assert.deepEqual(matchFolderByName(folders, "stavba zilina"), { folder: folders[2] });
  const ambiguous = matchFolderByName(folders, "2026");
  assert.ok(ambiguous && "ambiguous" in ambiguous && ambiguous.ambiguous.length === 2);
  assert.equal(matchFolderByName(folders, "Október"), null);
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
