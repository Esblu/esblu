// =============================================================================
// Úplný balík pre účtovníka — pravidlá obsahu, bezpečnosť ciest, manifest.
//
// SPUSTENIE
//   npm run test:handoff
//
// ČO SA TU CHRÁNI
// ---------------
// Tri vety, z ktorých každá raz niekoho stála doklad:
//
//   1. Zošit s údajmi NIE JE odovzdanie dokladov.
//   2. Prijatý doklad bez originálu sa NESMIE označiť za odovzdaný.
//   3. Nič z toho, čo človek napísal, sa nesmie stať cestou v ZIP-e.
//
// Skutočné zbalenie (jszip, Storage, PDF) beží na serveri a testuje sa
// zostavením balíka v sandboxe — tu sú pravidlá, ktoré o obsahu rozhodujú.
// =============================================================================

import assert from "node:assert/strict";
import {
  buildManifest,
  directionFolder,
  eligibilityProblems,
  invoiceFolderName,
  isSafeZipPath,
  packageFileName,
  packageProblems,
  packageRootFolder,
  safeExtension,
  safeSegment,
  MANIFEST_SCHEMA_VERSION,
  PACKAGE_LIMITS,
  type ManifestFile,
  type PackageInvoice,
} from "../lib/invoicing/handoff-package.ts";
import {
  retentionStatus,
  removalBlockers,
  isEligibleForRemoval,
} from "../lib/invoicing/accounting-lifecycle.ts";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    passed++;
  } catch {
    failed++;
    console.error(
      `FAIL  ${label}\n      dostal: ${JSON.stringify(actual)}\n      čakal:  ${JSON.stringify(expected)}`
    );
  }
}

const ISSUED: PackageInvoice = {
  id: "11111111-1111-4111-8111-111111111111",
  direction: "issued",
  kind: "regular_invoice",
  document_status: "finalized",
  invoice_number: "FA20260001",
  supplier_invoice_number: null,
  issue_date: "2026-09-16",
  currency: "EUR",
  subtotal_amount: 300,
  vat_total_amount: 69,
  total_amount: 369,
};

const RECEIVED: PackageInvoice = {
  id: "22222222-2222-4222-8222-222222222222",
  direction: "received",
  kind: "regular_invoice",
  document_status: "finalized",
  invoice_number: null,
  supplier_invoice_number: "TEST-2026-002",
  issue_date: "2026-09-20",
  currency: "EUR",
  subtotal_amount: 100,
  vat_total_amount: 23,
  total_amount: 123,
};

// -----------------------------------------------------------------------------
// 1. BEZPEČNÉ MENÁ
//
// Do mena priečinka ide číslo dokladu a do mena súboru názov nahratého
// súboru. Oboje píše človek alebo dodávateľ, takže tam môže byť čokoľvek.
// -----------------------------------------------------------------------------
check("bežné číslo prejde", safeSegment("FA20260001"), "FA20260001");
check("lomka sa nestane priečinkom", safeSegment("FA/2026/0001"), "FA_2026_0001");
check("spätná lomka takisto", safeSegment("FA\\2026"), "FA_2026");
check("cesta nahor sa rozbije", safeSegment("../../etc/passwd"), "etc_passwd");
check("samotné bodky nezostanú", safeSegment("..").length > 0, true);
check("absolútna cesta", safeSegment("/etc/passwd"), "etc_passwd");
check("disk vo Windows", safeSegment("C:\\Windows"), "C_Windows");
check("diakritika sa zjednoduší", safeSegment("Odvoz materiálu"), "Odvoz_materialu");
check("riadiace znaky zmiznú", safeSegment("faktura\u0000\u001f.pdf"), "faktura.pdf");
// Neviditeľné znaky sa MAŽÚ, nenahrádzajú podčiarkovníkom. Podčiarkovník by
// tvrdil, že tam niečo bolo — a pri mene súboru je to zbytočná lož.
check("nový riadok zmizne bez stopy", safeSegment("a\nb"), "ab");
check("zero-width zmizne", safeSegment("fakt\u200bura"), "faktura");
check("smerový prepínač zmizne", safeSegment("\u202efdp.exe"), "fdp.exe");
check("dlhé meno sa skráti", safeSegment("x".repeat(500)).length, 80);
check("prázdne meno dostane náhradu", safeSegment(""), "polozka");
check("meno zo samých zakázaných znakov", safeSegment("///"), "polozka");
check("vlastná náhrada", safeSegment("", "doklad"), "doklad");

// Žiadny výstup nesmie obsahovať oddeľovač.
{
  const adversarial = [
    "../..", "a/b/c", "a\\b", "\u0000", "...", "./.", "C:/x", "%2e%2e/", "a\u2028b",
    "..\u200b/..", "\u202e\u202dx", "  ..  ", "..%00", "a".repeat(300) + "/../b",
  ];
  const bad = adversarial.filter((raw) => {
    const out = safeSegment(raw);
    return out.includes("/") || out.includes("\\") || out.includes("..") || out.length === 0;
  });
  check("žiadny vstup nevyrobí oddeľovač ani ..", bad, []);
}

// -----------------------------------------------------------------------------
// 2. PRÍPONY — nehádame
// -----------------------------------------------------------------------------
check("prípona z názvu", safeExtension("faktura.PDF", null), "pdf");
check("prípona z MIME", safeExtension(null, "application/pdf"), "pdf");
check("MIME s parametrom", safeExtension(null, "image/jpeg; charset=binary"), "jpg");
check("nič sa nedá určiť → bin", safeExtension(null, null), "bin");
check("neznámy MIME → bin", safeExtension("subor", "application/x-vymyslene"), "bin");
check("dvojitá prípona berie poslednú", safeExtension("a.tar.gz", null), "gz");
check("prípona sa nevymyslí z ničoho", safeExtension("faktura", "application/octet-stream"), "bin");

// -----------------------------------------------------------------------------
// 3. CESTY V ZIP-e
// -----------------------------------------------------------------------------
check("bežná cesta", isSafeZipPath("issued/FA20260001__11111111/invoice.pdf"), true);
check("cesta nahor", isSafeZipPath("issued/../../etc/passwd"), false);
check("absolútna", isSafeZipPath("/etc/passwd"), false);
check("spätná lomka", isSafeZipPath("issued\\x\\y"), false);
check("disk", isSafeZipPath("C:/x"), false);
check("prázdny segment", isSafeZipPath("issued//invoice.pdf"), false);
check("bodka ako segment", isSafeZipPath("issued/./invoice.pdf"), false);
check("riadiaci znak", isSafeZipPath("issued/\u0000/x"), false);
check("prázdna cesta", isSafeZipPath(""), false);
check("príliš dlhá cesta", isSafeZipPath("a/".repeat(300) + "b"), false);

// -----------------------------------------------------------------------------
// 4. PRIEČINOK DOKLADU
// -----------------------------------------------------------------------------
check("vydaná podľa čísla", invoiceFolderName(ISSUED), "FA20260001__11111111");
check("prijatá podľa čísla dodávateľa", invoiceFolderName(RECEIVED), "TEST-2026-002__22222222");
check(
  "bez čísla nastúpi dátum",
  invoiceFolderName({ ...ISSUED, invoice_number: null }),
  "2026-09-16__11111111"
);
// Dva doklady s rovnakým číslom dodávateľa sa v jednom priečinku neprepíšu.
check(
  "rovnaké číslo, iné id → iný priečinok",
  invoiceFolderName(RECEIVED) !== invoiceFolderName({ ...RECEIVED, id: "33333333-3333-4333-8333-333333333333" }),
  true
);
check("smer issued", directionFolder("issued"), "issued");
check("smer received", directionFolder("received"), "received");
check("neznámy smer sa odmietne", directionFolder("vymyslene"), null);

// -----------------------------------------------------------------------------
// 5. KTO SA DO BALÍKA DOSTANE
//
// Toto je jadro. `complete_handoff` sa má raz viazať na odstránenie
// prevádzkovej kópie, takže sem nesmie prejsť nič nekompletné.
// -----------------------------------------------------------------------------
check(
  "vydaná finalizovaná s položkami prejde",
  eligibilityProblems({ invoice: ISSUED, itemCount: 1, hasOriginalDocument: false }),
  []
);
check(
  "prijatá finalizovaná s originálom prejde",
  eligibilityProblems({ invoice: RECEIVED, itemCount: 1, hasOriginalDocument: true }),
  []
);

// PRIJATÁ BEZ ORIGINÁLU — najdôležitejší test v tomto súbore.
check(
  "prijatá BEZ originálu neprejde",
  eligibilityProblems({ invoice: RECEIVED, itemCount: 1, hasOriginalDocument: false }),
  ["missing_original_document"]
);

// KONCEPT — nemá číslo ani finalizáciu, môže sa ešte zmeniť.
check(
  "koncept neprejde",
  eligibilityProblems({
    invoice: { ...ISSUED, document_status: "draft", invoice_number: null },
    itemCount: 1,
    hasOriginalDocument: false,
  }),
  ["not_finalized", "missing_invoice_number"]
);

check(
  "doklad bez položiek neprejde",
  eligibilityProblems({ invoice: ISSUED, itemCount: 0, hasOriginalDocument: false }),
  ["missing_items"]
);
check(
  "chýbajúci dátum vystavenia neprejde",
  eligibilityProblems({ invoice: { ...ISSUED, issue_date: "" }, itemCount: 1, hasOriginalDocument: false }),
  ["missing_issue_date"]
);
check(
  "prijatá bez čísla dodávateľa neprejde",
  eligibilityProblems({
    invoice: { ...RECEIVED, supplier_invoice_number: null },
    itemCount: 1,
    hasOriginalDocument: true,
  }),
  ["missing_supplier_invoice_number"]
);
check(
  "neznámy smer neprejde",
  eligibilityProblems({ invoice: { ...ISSUED, direction: "x" }, itemCount: 1, hasOriginalDocument: false }),
  ["unknown_direction"]
);

// Doklad, ktorý si protirečí, sa nesmie odovzdať ako účtovný podklad.
// Toto je presne ten stav 1800,01 z predchádzajúcej opravy.
check(
  "základ + daň sa nerovná spolu → neprejde",
  eligibilityProblems({
    invoice: { ...ISSUED, subtotal_amount: 1463.42, vat_total_amount: 336.59, total_amount: 1800.0 },
    itemCount: 3,
    hasOriginalDocument: false,
  }),
  ["totals_do_not_reconcile"]
);
check(
  "a keď sedí, prejde",
  eligibilityProblems({
    invoice: { ...ISSUED, subtotal_amount: 1463.41, vat_total_amount: 336.59, total_amount: 1800.0 },
    itemCount: 3,
    hasOriginalDocument: false,
  }),
  []
);

// Viac problémov naraz sa vypíše všetko, nie len prvý.
check(
  "koncept bez položiek hlási oboje",
  eligibilityProblems({
    invoice: { ...RECEIVED, document_status: "draft", supplier_invoice_number: null },
    itemCount: 0,
    hasOriginalDocument: false,
  }).sort(),
  ["missing_items", "missing_original_document", "missing_supplier_invoice_number", "not_finalized"]
);

// -----------------------------------------------------------------------------
// 6. KONTROLA BALÍKA PRED ZBALENÍM
// -----------------------------------------------------------------------------
function file(path: string, bytes = 100): ManifestFile {
  return {
    path,
    kind: "invoice_metadata",
    invoice_id: null,
    source_document_id: null,
    provenance: "generated",
    mime_type: "application/json",
    original_filename: null,
    bytes,
    sha256: "a".repeat(64),
  };
}

check("bežný balík je v poriadku", packageProblems([file("a/b.json")], 1), []);
check("prázdny balík sa odmietne", packageProblems([], 0), [{ code: "empty_package" }]);
check(
  "dva súbory na tom istom mieste",
  packageProblems([file("a/b.json"), file("a/b.json")], 1),
  [{ code: "duplicate_path", path: "a/b.json" }]
);
check(
  "nebezpečná cesta sa zachytí aj tu",
  packageProblems([file("../x")], 1),
  [{ code: "unsafe_path", path: "../x" }]
);
check(
  "priveľký jeden súbor",
  packageProblems([file("a.bin", PACKAGE_LIMITS.maxSingleFileBytes + 1)], 1).map((p) => p.code),
  ["file_too_large"]
);
check(
  "priveľa dokladov",
  packageProblems([file("a.json")], PACKAGE_LIMITS.maxInvoices + 1).map((p) => p.code),
  ["too_many_invoices"]
);
{
  // Limit celkovej veľkosti sa počíta zo súčtu, nie z najväčšieho súboru.
  const chunk = Math.floor(PACKAGE_LIMITS.maxSingleFileBytes / 2);
  const many = Array.from({ length: 20 }, (_, i) => file(`f${i}.bin`, chunk));
  check(
    "súčet cez limit",
    packageProblems(many, 1).map((p) => p.code),
    ["package_too_large"]
  );
}

// -----------------------------------------------------------------------------
// 7. MANIFEST A ODTLAČKY
// -----------------------------------------------------------------------------
{
  const files: ManifestFile[] = [
    { ...file("received/TEST__2222/original.pdf", 2048), kind: "received_original",
      provenance: "original", mime_type: "application/pdf", invoice_id: RECEIVED.id,
      source_document_id: "doc-1", original_filename: "Faktúra od dodávateľa.pdf",
      sha256: "b".repeat(64) },
    { ...file("issued/FA20260001__1111/invoice.pdf", 4096), kind: "invoice_pdf",
      provenance: "generated", mime_type: "application/pdf", invoice_id: ISSUED.id,
      sha256: "c".repeat(64) },
    { ...file("README.txt", 512), kind: "readme", mime_type: "text/plain", sha256: "d".repeat(64) },
  ];

  const manifest = buildManifest({
    exportId: "exp-1",
    companyId: "co-1",
    generatedAt: "2026-09-23T12:00:00.000Z",
    generatedBy: "user-1",
    appCommit: "abc123",
    invoices: [
      { invoice_id: ISSUED.id, direction: "issued", kind: "regular_invoice",
        invoice_number: "FA20260001", supplier_invoice_number: null, issue_date: "2026-09-16",
        currency: "EUR", subtotal_amount: "300.00", vat_total_amount: "69.00",
        total_amount: "369.00", folder: "issued/FA20260001__1111", artifact_count: 2 },
      { invoice_id: RECEIVED.id, direction: "received", kind: "regular_invoice",
        invoice_number: null, supplier_invoice_number: "TEST-2026-002", issue_date: "2026-09-20",
        currency: "EUR", subtotal_amount: "100.00", vat_total_amount: "23.00",
        total_amount: "123.00", folder: "received/TEST__2222", artifact_count: 2 },
    ],
    files,
  });

  check("verzia schémy", manifest.manifest_schema_version, MANIFEST_SCHEMA_VERSION);
  check("počet dokladov", manifest.invoice_count, 2);
  check("vydané", manifest.issued_count, 1);
  check("prijaté", manifest.received_count, 1);
  check("počet súborov", manifest.file_count, 3);
  check("súčet bajtov", manifest.total_bytes, 2048 + 4096 + 512);

  // Manifest sám seba neobsahuje — inak by sa jeho odtlačok nedal spočítať.
  check(
    "manifest neobsahuje sám seba",
    manifest.files.some((f) => f.path.endsWith("manifest.json")),
    false
  );
  check("stratégia je napísaná v manifeste", manifest.hash_strategy.algorithm, "sha256");
  check("a povie, čo nepokrýva", manifest.hash_strategy.excludes, "manifest.json");
  check(
    "odtlačok manifestu je v databáze",
    manifest.hash_strategy.manifest_hash_location,
    "accounting_handoff_exports.manifest_sha256"
  );
  check(
    "odtlačok celého ZIP-u tiež",
    manifest.hash_strategy.package_hash_location,
    "accounting_handoff_exports.package_sha256"
  );

  // Poradie je deterministické — dva rovnaké balíky dajú rovnaký manifest.
  const again = buildManifest({
    exportId: "exp-1", companyId: "co-1", generatedAt: "2026-09-23T12:00:00.000Z",
    generatedBy: "user-1", appCommit: "abc123",
    invoices: [...manifest.invoices].reverse(),
    files: [...files].reverse(),
  });
  check("manifest je deterministický", JSON.stringify(again), JSON.stringify(manifest));

  // Pôvodné meno súboru sa nestráca, hoci cesta je sanitizovaná.
  check(
    "pôvodný názov je zachovaný v manifeste",
    manifest.files.find((f) => f.kind === "received_original")?.original_filename,
    "Faktúra od dodávateľa.pdf"
  );
  // Originál je označený ako originál, PDF ako vyrobené Esblom.
  check(
    "pôvod je rozlíšený",
    manifest.files.map((f) => `${f.kind}:${f.provenance}`).sort(),
    ["invoice_pdf:generated", "readme:generated", "received_original:original"]
  );
  check("disclaimer je v manifeste", manifest.disclaimer.includes("zakonny archiv"), true);
}

// -----------------------------------------------------------------------------
// 8. NÁZOV BALÍKA
// -----------------------------------------------------------------------------
{
  const at = new Date(2026, 8, 23, 14, 5);
  check("názov ZIP-u", packageFileName(at), "esblu-accounting-handoff-2026-09-23-1405.zip");
  check("koreňový priečinok", packageRootFolder(packageFileName(at)),
    "esblu-accounting-handoff-2026-09-23-1405");
  check("v názve nie je nič o firme", /company|firma|\d{8,}/.test(packageFileName(at)), false);
}

// -----------------------------------------------------------------------------
// 9. ČO Z BALÍKA VYPLÝVA PRE ODSTRÁNENIE
//
// Nič sa nemaže. Overuje sa iba brána: bez úplného odovzdania sa doklad
// odstrániteľným nestane, ani keď je dávno po lehote.
// -----------------------------------------------------------------------------
const OLD = { issueDate: "2020-01-15", today: "2026-09-23" };

check(
  "po lehote bez odovzdania = NIE je na odstránenie",
  retentionStatus({ ...OLD, handoffStatus: "none" }).state,
  "retention_exceeded"
);
check(
  "po lehote so stiahnutým zošitom = STÁLE nie",
  retentionStatus({ ...OLD, handoffStatus: "metadata_exported" }).state,
  "retention_exceeded"
);
check(
  "po lehote s úplným balíkom = brána otvorená",
  retentionStatus({ ...OLD, handoffStatus: "complete_handoff" }).state,
  "eligible_for_removal"
);
check(
  "pred lehotou ani s úplným balíkom",
  retentionStatus({ issueDate: "2026-01-15", today: "2026-09-23", handoffStatus: "complete_handoff" }).state,
  "active"
);
check(
  "zošit sa nevydáva za odovzdanie",
  removalBlockers({ ...OLD, handoffStatus: "metadata_exported" }),
  ["only_metadata_exported"]
);
check(
  "bez ničoho chýba odovzdanie",
  removalBlockers({ ...OLD, handoffStatus: "none" }),
  ["complete_handoff_missing"]
);
check(
  "s úplným balíkom po lehote už nič nebráni",
  removalBlockers({ ...OLD, handoffStatus: "complete_handoff" }),
  []
);
check(
  "eligible iba pri úplnom odovzdaní",
  [
    isEligibleForRemoval({ ...OLD, handoffStatus: "none" }),
    isEligibleForRemoval({ ...OLD, handoffStatus: "metadata_exported" }),
    isEligibleForRemoval({ ...OLD, handoffStatus: "complete_handoff" }),
  ],
  [false, false, true]
);

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
