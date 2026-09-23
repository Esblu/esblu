// =============================================================================
// Preklady odovzdania účtovníkovi — používateľ nikdy neuvidí názov premennej.
//
// SPUSTENIE
//   npm run test:i18n
//
// PREČO EXISTUJE
// --------------
// Pri jednej úprave skončili chybové kľúče balíka v nesprávnom bloku
// slovníka. Nič nespadlo, nič sa nerozbilo — iba by používateľ pri chybe
// dostal do tváre
//
//     handoff.errors.package.missing_original_document
//
// Chyba, ktorá sa zobrazí ako názov premennej, je horšia než žiadna hláška:
// človek nevie, čo sa stalo, ani čo s tým. A nikto si to nevšimne, lebo
// testy bežia zelené a appka ide.
//
// Tento súbor to robí viditeľným. Nový chybový kód bez prekladu neprejde
// testom, nie až produkciou.
// =============================================================================

import assert from "node:assert/strict";
import sk from "../lib/i18n/dictionaries/sk.ts";
import de from "../lib/i18n/dictionaries/de.ts";
import en from "../lib/i18n/dictionaries/en.ts";
import { translate, hasTranslation, translateWithFallback } from "../lib/i18n/translate.ts";
import {
  HANDOFF_ERROR_CODES,
  HANDOFF_GENERIC_ERROR_KEY,
  handoffErrorCode,
  handoffErrorKey,
  isHandoffErrorCode,
} from "../lib/invoicing/handoff-errors.ts";

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

const DICTS = { sk, de, en } as const;
type Lang = keyof typeof DICTS;
const LANGS = ["sk", "de", "en"] as const;

/** Všetky listové cesty v slovníku. */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key)
  );
}

function get(dict: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    dict
  );
}

// -----------------------------------------------------------------------------
// A. VŠETKY handoff.* KĽÚČE, KTORÉ KÓD POUŽÍVA, EXISTUJÚ V SK/DE/EN
//
// Zoznam je ručný a to je zámer: je to zmluva medzi kódom a slovníkmi.
// Keď niekto pridá `t("handoff.nieco")` a zabudne preklad, test padne až
// vtedy, keď kľúč doplní aj sem — a v tej chvíli ho aj preloží.
// -----------------------------------------------------------------------------
const STATIC_KEYS = [
  "handoff.exportButton",
  "handoff.exporting",
  "handoff.exported",
  "handoff.packageButton",
  "handoff.packageBusy",
  "handoff.packageDone",
  "handoff.packageDrafts",
  "handoff.packageWarningTitle",
  "handoff.packageWarningBody",
  "handoff.packagePreview",
  "handoff.package.readmeTitle",
  "handoff.package.readmeIntro",
  "handoff.package.readmeStructure",
  "handoff.package.readmeIntegrity",
  "handoff.package.readmeDisclaimer",
  "handoff.errors.failed",
  "handoff.errors.hashUnavailable",
  "handoff.errors.genericPackageFailure",
  "handoff.sheet.invoices",
  "handoff.sheet.items",
  "handoff.sheet.vat",
];

// Dynamické kľúče — presne tie hodnoty, ktoré kód do šablóny dosadzuje.
const DYNAMIC_KEYS = [
  ...(["unprocessed", "accounted"] as const).map((v) => `handoff.accountingStatus.${v}`),
  ...(["none", "metadata_exported", "complete_handoff"] as const).map((v) => `handoff.handoffStatus.${v}`),
  ...(["active", "approaching_limit", "retention_exceeded", "eligible_for_removal"] as const).map(
    (v) => `handoff.retention.${v}`
  ),
  ...HANDOFF_ERROR_CODES.map(handoffErrorKey),
  ...([
    "not_finalized", "unknown_direction", "missing_issue_date", "missing_invoice_number",
    "missing_supplier_invoice_number", "missing_original_document", "missing_items",
    "totals_do_not_reconcile",
  ] as const).map((v) => `handoff.errors.eligibility.${v}`),
  ...([
    "number", "direction", "issueDate", "dueDate", "counterparty", "ico", "icDph", "subtotal",
    "vat", "total", "currency", "paymentStatus", "accountingStatus", "variableSymbol",
    "sourceDocument", "description", "quantity", "unit", "unitPrice", "vatCategory", "vatRate",
    "lineNet", "lineVat", "lineGross", "taxableAmount", "vatAmount",
  ] as const).map((v) => `handoff.col.${v}`),
];

const ALL_KEYS = [...STATIC_KEYS, ...DYNAMIC_KEYS];

for (const lang of LANGS) {
  const missing = ALL_KEYS.filter((key) => typeof get(DICTS[lang], key) !== "string");
  check(`A ${lang}: žiadny použitý kľúč nechýba`, missing, []);
}
check("A zoznam nie je prázdny", ALL_KEYS.length > 60, true);

// Žiadny preklad nesmie byť prázdny — prázdna hláška je to isté ako žiadna.
for (const lang of LANGS) {
  const empty = ALL_KEYS.filter((key) => String(get(DICTS[lang], key) ?? "").trim() === "");
  check(`A ${lang}: žiadny preklad nie je prázdny`, empty, []);
}

// -----------------------------------------------------------------------------
// B. ŠTRUKTÚRA SLOVNÍKOV SA ZHODUJE
//
// Nie iba v handoff bloku — v celom slovníku. Keby DE chýbal kľúč, ktorý SK
// má, používateľ s nemčinou uvidí slovenský text (fallback) alebo kľúč.
// -----------------------------------------------------------------------------
{
  const skPaths = new Set(leafPaths(sk));
  for (const lang of ["de", "en"] as const) {
    const cur = new Set(leafPaths(DICTS[lang]));
    check(`B ${lang}: nechýba nič oproti SK`, [...skPaths].filter((p) => !cur.has(p)), []);
    check(`B ${lang}: nemá nič navyše`, [...cur].filter((p) => !skPaths.has(p)), []);
  }
  check("B slovník nie je prázdny", skPaths.size > 500, true);
}

// Osobitne handoff blok — aby bolo v prípade pádu hneď vidieť, čoho sa týka.
{
  const handoffPaths = (lang: Lang) => leafPaths(get(DICTS[lang], "handoff"), "handoff").sort();
  check("B handoff SK = DE", handoffPaths("de"), handoffPaths("sk"));
  check("B handoff SK = EN", handoffPaths("en"), handoffPaths("sk"));
}

// -----------------------------------------------------------------------------
// C. ZNÁME KÓDY DÁVAJÚ ČITATEĽNÚ VETU
// -----------------------------------------------------------------------------
for (const lang of LANGS) {
  for (const code of HANDOFF_ERROR_CODES) {
    const text = translateWithFallback(lang, handoffErrorKey(code), HANDOFF_GENERIC_ERROR_KEY);
    // Nie je to kľúč, nie je to prázdne a je to dlhšie než názov kódu.
    const ok = text.length > 10 && !text.includes("handoff.") && text !== code;
    if (!ok) check(`C ${lang}/${code}: čitateľná veta`, text, "(veta pre človeka)");
    else passed++;
  }
}
check("C pokrytých kódov", HANDOFF_ERROR_CODES.length, 25);

// Každý vnútorný dôvod, ktorý route vie vyhodiť, sa mapuje na známy kód.
{
  const REASONS = [
    "missing_original_document", "missing_supporting_document", "missing_attachment",
    "missing_seller_snapshot", "original_hash_mismatch", "unknown_direction",
    "pdf_generation_failed", "duplicate_path", "unsafe_path", "empty_package",
    "too_many_invoices", "too_many_files", "package_too_large", "file_too_large",
    "verification_missing_file", "verification_hash_mismatch", "verification_missing_manifest",
    "unexpected_error",
  ];
  const nezname = REASONS.filter((r) => !isHandoffErrorCode(handoffErrorCode(r)));
  check("C každý vnútorný dôvod má kód", nezname, []);
  // Tri rôzne príčiny overenia dávajú pre používateľa jednu vetu.
  check(
    "C overenie balíka má jeden kód",
    [
      handoffErrorCode("verification_missing_file"),
      handoffErrorCode("verification_hash_mismatch"),
      handoffErrorCode("verification_missing_manifest"),
    ],
    ["PACKAGE_VERIFICATION_FAILED", "PACKAGE_VERIFICATION_FAILED", "PACKAGE_VERIFICATION_FAILED"]
  );
}

// -----------------------------------------------------------------------------
// D. NEZNÁMY KÓD → VŠEOBECNÁ VETA, NIE KĽÚČ
// -----------------------------------------------------------------------------
for (const lang of LANGS) {
  const text = translateWithFallback(lang, handoffErrorKey("VYMYSLENY_KOD"), HANDOFF_GENERIC_ERROR_KEY);
  check(`D ${lang}: neznámy kód nevráti kľúč`, text.includes("handoff."), false);
  check(`D ${lang}: neznámy kód vráti vetu`, text.length > 10, true);
  check(
    `D ${lang}: je to práve všeobecná veta`,
    text,
    translate(lang, HANDOFF_GENERIC_ERROR_KEY)
  );
}

// Neznámy dôvod z budúcnosti sa mapuje na INTERNAL_ERROR, nie na pád.
check("D neznámy dôvod → INTERNAL_ERROR", handoffErrorCode("nieco_co_este_neexistuje"), "INTERNAL_ERROR");
check("D nie je to platný kód", isHandoffErrorCode("nieco_co_este_neexistuje"), false);
check("D platný kód sa rozpozná", isHandoffErrorCode("FORBIDDEN"), true);
check("D kód nesmie prísť ako objekt", isHandoffErrorCode({ toString: () => "FORBIDDEN" }), false);

// Konkrétna hláška má prednosť pred všeobecnou — poistka nesmie prekryť to,
// čo vieme povedať presne.
for (const lang of LANGS) {
  check(
    `D ${lang}: konkrétna veta má prednosť`,
    translateWithFallback(lang, handoffErrorKey("FORBIDDEN"), HANDOFF_GENERIC_ERROR_KEY) !==
      translate(lang, HANDOFF_GENERIC_ERROR_KEY),
    true
  );
}

// -----------------------------------------------------------------------------
// E. SUROVÝ KĽÚČ SA POUŽÍVATEĽOVI NEZOBRAZÍ
//
// `translate()` pri chýbajúcom kľúči vráti kľúč — to je pre dev v poriadku.
// Chybová cesta balíka ale musí ísť cez poistku.
// -----------------------------------------------------------------------------
{
  check("E translate() surový kľúč vráti", translate("sk", "handoff.errors.code.NEEXISTUJE"),
        "handoff.errors.code.NEEXISTUJE");
  check("E hasTranslation to vie", hasTranslation("sk", "handoff.errors.code.NEEXISTUJE"), false);
  check("E ale poistka ho nevráti",
        translateWithFallback("sk", "handoff.errors.code.NEEXISTUJE", HANDOFF_GENERIC_ERROR_KEY)
          .includes("handoff."), false);

  // Keby bol rozbitý aj náhradný kľúč, radšej prázdno než názov premennej.
  check("E rozbitá poistka vráti prázdno",
        translateWithFallback("sk", "a.b.c", "d.e.f"), "");
}

// -----------------------------------------------------------------------------
// F. HLÁŠKY NEPREZRÁDZAJÚ VNÚTRO
//
// Do prehliadača nesmie ísť cesta v úložisku, názov bucketu, SQL, id ani
// stack trace. Hláška je pre človeka, nie mapa systému.
// -----------------------------------------------------------------------------
{
  const ZAKAZANE = [
    "supabase", "storage", "bucket", "postgres", "sql", "select ", "insert ",
    "ai-inbox-documents", "ai-evidence-documents", "service_role", "stack",
    "at Object.", ".ts:", "undefined", "null", "Error:",
  ];
  const problemy: string[] = [];
  for (const lang of LANGS) {
    for (const code of HANDOFF_ERROR_CODES) {
      const text = translate(lang, handoffErrorKey(code)).toLowerCase();
      for (const zakazane of ZAKAZANE) {
        if (text.includes(zakazane.toLowerCase())) problemy.push(`${lang}/${code}: ${zakazane}`);
      }
    }
  }
  check("F žiadna hláška neprezrádza vnútro", problemy, []);

  // Kódy samotné sú neutrálne — nesmú obsahovať id ani cesty.
  const zleKody = HANDOFF_ERROR_CODES.filter((c) => !/^[A-Z][A-Z0-9_]*$/.test(c));
  check("F kódy sú iba veľké písmená a podčiarkovníky", zleKody, []);
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
