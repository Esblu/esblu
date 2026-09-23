// =============================================================================
// Úplný balík pre účtovníka — pravidlá, ktoré rozhodujú o jeho obsahu.
//
// ČO JE ÚPLNÝ BALÍK
// -----------------
// ZIP, v ktorom je všetko, čo účtovník potrebuje na zaúčtovanie a čo by po
// odstránení prevádzkovej kópie z Esblu inak neexistovalo nikde:
//
//   - originály prijatých dokladov tak, ako ich poslal dodávateľ
//   - PDF vydaných faktúr vygenerované z finalizovaného dokladu
//   - prílohy, ktoré k dokladu naozaj patria
//   - údaje v strojovo čitateľnej podobe (metadata.json) aj v zošite (xlsx)
//   - manifest s odtlačkom každého súboru
//
// ČO TO NIE JE
// ------------
// Nie je to zákonný archív a nie je to splnenie archivačnej povinnosti.
// `complete_handoff` je TECHNICKÝ stav: „balík sa podaril a dá sa overiť".
// Právny záver z neho nevyplýva a Esblu ho nerobí. Pozri
// docs/retention-handoff-compliance-delta-for-clia.md.
//
// PREČO JE TENTO SÚBOR BEZ IMPORTOV
// ---------------------------------
// Rozhodovanie o tom, čo sa do balíka dostane a pod akým menom, musí byť
// odskúšateľné bez servera, bez databázy a bez ZIP knižnice. Samotné
// zbalenie a odtlačky sú inde; sem patria pravidlá.
// =============================================================================

export const MANIFEST_SCHEMA_VERSION = "1.0";

/**
 * Hranice, pri ktorých sa balík radšej nevytvorí.
 *
 * ODKIAĽ SÚ TIE ČÍSLA
 * -------------------
 * Nie sú odhadnuté. Balík sa skladá v pamäti servera a spotreba sa zmerala:
 * 120 dokladov / 240 súborov / 39,7 MB nestlačiteľných dát dalo 39,8 MB ZIP
 * za 3,7 s pri RSS 229 MB. Po odpočítaní základu Node procesu vychádza
 * zhruba 4,5-násobok vloženého objemu — v pamäti totiž naraz žijú zdrojové
 * bajty, výstupný ZIP aj kópia z overovania.
 *
 * Pri 120 MB vloženého objemu to znamená špičku okolo 600 MB, čo sa do
 * bežnej serverless funkcie zmestí s rezervou. Vyšší limit by proces zabil
 * v polovici práce — a zabitý proces je horší než zrozumiteľná veta „skúste
 * kratšie obdobie".
 *
 * 120 MB je pritom okolo 300 bežných naskenovaných faktúr, takže mesačné ani
 * kvartálne odovzdanie sa o limit neobtrie. Kto má viac, exportuje po
 * mesiacoch — a stále dostane úplný balík za každý z nich.
 */
export const PACKAGE_LIMITS = {
  maxInvoices: 500,
  maxFiles: 5_000,
  /** Súčet nezabalených bajtov všetkých vložených súborov. */
  maxTotalBytes: 120 * 1024 * 1024,
  /** Jeden vložený súbor. Najväčší Storage bucket dnes povoľuje 15 MB. */
  maxSingleFileBytes: 32 * 1024 * 1024,
} as const;

// -----------------------------------------------------------------------------
// Bezpečné mená
// -----------------------------------------------------------------------------

/**
 * Jeden segment cesty v ZIP-e. Nikdy nevráti prázdny reťazec, nikdy
 * neobsahuje `/`, `\` ani `..`.
 *
 * ČO SA SEM DOSTÁVA
 * -----------------
 * Čísla faktúr, mená partnerov a názvy nahraných súborov. Všetko tri píše
 * človek alebo dodávateľ, takže sa tu môže objaviť čokoľvek: lomky, `..`,
 * riadiace znaky, pravo-ľavé prepínače, meno dlhé tisíc znakov.
 *
 * Diakritika sa zjednodušuje zámerne. ZIP nemá jedno kódovanie mien a
 * rozbalenie na inom systéme vie z „Odvoz materiálu.pdf" spraviť nečitateľnú
 * zmes. Pôvodný názov sa nestráca — je v manifeste aj v metadata.json.
 */
export function safeSegment(raw: string, fallback = "polozka"): string {
  if (typeof raw !== "string") return fallback;

  const folded = raw
    .normalize("NFD")
    // Diakritika.
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    // Riadiace znaky, oddeľovače riadkov, zero-width a smerové prepínače.
    .replace(
      new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]", "g"),
      ""
    )
    // Čokoľvek, čo nie je bezpečný znak mena.
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    // `..` by aj po predchádzajúcom kroku prežilo — bodka je povolený znak.
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "")
    .slice(0, 80);

  return folded.length > 0 ? folded : fallback;
}

/**
 * Prípona odvodená z pôvodného názvu, inak z MIME typu.
 *
 * Nehádame: keď sa ani jedno nedá určiť, súbor dostane `.bin`. Vymyslené
 * `.pdf` na súbore, ktorý PDF nie je, by účtovníka zmiatlo viac než `.bin`.
 */
const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/tiff": "tif",
  "text/plain": "txt",
  "application/xml": "xml",
  "text/xml": "xml",
};

export function safeExtension(originalFilename: string | null, mimeType: string | null): string {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(originalFilename ?? "");
  if (fromName) return fromName[1].toLowerCase();

  const fromMime = MIME_EXTENSIONS[(mimeType ?? "").toLowerCase().split(";")[0].trim()];
  return fromMime ?? "bin";
}

// -----------------------------------------------------------------------------
// Priečinok dokladu
// -----------------------------------------------------------------------------

export type PackageInvoice = {
  id: string;
  direction: "issued" | "received" | string;
  kind: string;
  document_status: string;
  invoice_number: string | null;
  supplier_invoice_number: string | null;
  issue_date: string;
  currency: string;
  subtotal_amount: number;
  vat_total_amount: number;
  total_amount: number;
};

/**
 * Meno priečinka dokladu v ZIP-e.
 *
 * Číslo dokladu ako prvé, lebo podľa neho účtovník hľadá. Krátke id na
 * konci, lebo dva doklady môžu mať rovnaké číslo dodávateľa a v jednom
 * priečinku by sa prepísali. Dátum ako záloha pre doklad bez čísla.
 */
export function invoiceFolderName(invoice: PackageInvoice): string {
  const label =
    invoice.direction === "received"
      ? invoice.supplier_invoice_number ?? invoice.issue_date
      : invoice.invoice_number ?? invoice.issue_date;

  return `${safeSegment(label, "doklad")}__${invoice.id.slice(0, 8)}`;
}

/** `issued/` alebo `received/` — iné smery sa do balíka nedostanú. */
export function directionFolder(direction: string): "issued" | "received" | null {
  if (direction === "issued") return "issued";
  if (direction === "received") return "received";
  return null;
}

// -----------------------------------------------------------------------------
// Kto sa do úplného balíka smie dostať
// -----------------------------------------------------------------------------

export type EligibilityProblem =
  | "not_finalized"
  | "unknown_direction"
  | "missing_issue_date"
  | "missing_invoice_number"
  | "missing_supplier_invoice_number"
  | "missing_original_document"
  | "missing_items"
  | "totals_do_not_reconcile";

export type EligibilityInput = {
  invoice: PackageInvoice;
  itemCount: number;
  /** Má prijatý doklad dohľadateľný originál v úložisku? */
  hasOriginalDocument: boolean;
};

/**
 * Čo bráni tomu, aby sa doklad považoval za úplne odovzdaný.
 *
 * Prázdny zoznam = doklad sa smie zabaliť ako účtovný artefakt.
 *
 * KONCEPTY SEM NEPATRIA
 * ---------------------
 * Koncept nemá číslo ani dátum finalizácie a môže sa ešte zmeniť. Odovzdať
 * ho ako účtovný doklad by znamenalo tvrdiť o ňom niečo, čo neplatí. Doterajší
 * export údajov koncepty zahŕňa a zostáva tak — je to prehľad, nie odovzdanie.
 *
 * PRIJATÝ DOKLAD BEZ ORIGINÁLU
 * ----------------------------
 * Originál od dodávateľa je pri prijatej faktúre to jediné, čo je naozaj
 * dôkazom. Keď sa nenájde, doklad NESMIE prejsť ako úplne odovzdaný — a
 * Esblu naň nevygeneruje vlastné PDF, ktoré by sa za originál vydávalo.
 */
export function eligibilityProblems(input: EligibilityInput): EligibilityProblem[] {
  const { invoice } = input;
  const problems: EligibilityProblem[] = [];

  if (invoice.document_status !== "finalized") problems.push("not_finalized");
  if (directionFolder(invoice.direction) === null) problems.push("unknown_direction");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.issue_date ?? "")) problems.push("missing_issue_date");
  if (input.itemCount <= 0) problems.push("missing_items");

  if (invoice.direction === "issued" && !invoice.invoice_number) {
    problems.push("missing_invoice_number");
  }

  if (invoice.direction === "received") {
    if (!invoice.supplier_invoice_number) problems.push("missing_supplier_invoice_number");
    if (!input.hasOriginalDocument) problems.push("missing_original_document");
  }

  // Kanonický peňažný model (lib/invoicing/vat-engine.ts): základ + daň sa
  // rovná celkovej sume. Tu sa NIČ neprepočítava — iba sa overuje, že to, čo
  // ide do balíka, sedí samo so sebou. Keby nesedelo, účtovník by dostal
  // doklad, ktorý si protirečí, a nevšimol by si to.
  const reconciles =
    Math.round((invoice.subtotal_amount + invoice.vat_total_amount) * 100) ===
    Math.round(invoice.total_amount * 100);
  if (!reconciles) problems.push("totals_do_not_reconcile");

  return problems;
}

// -----------------------------------------------------------------------------
// Manifest
// -----------------------------------------------------------------------------

export type ManifestFileKind =
  | "invoice_pdf"
  | "received_original"
  | "attachment"
  | "invoice_metadata"
  | "workbook"
  | "readme";

export type ManifestFile = {
  /** Cesta vnútri ZIP-u, relatívna ku koreňovému priečinku balíka. */
  path: string;
  kind: ManifestFileKind;
  /** Doklad, ku ktorému súbor patrí; `null` pri súboroch celého balíka. */
  invoice_id: string | null;
  /** Zdrojový dokument v Esblu, ak ide o nahraný súbor. */
  source_document_id: string | null;
  /** `original` = tak, ako to prišlo; `generated` = vyrobilo Esblu. */
  provenance: "original" | "generated";
  mime_type: string | null;
  /** Názov, pod akým súbor prišiel. Nesanitizovaný — pre dohľadanie. */
  original_filename: string | null;
  bytes: number;
  sha256: string;
};

export type ManifestInvoice = {
  invoice_id: string;
  direction: string;
  kind: string;
  invoice_number: string | null;
  supplier_invoice_number: string | null;
  issue_date: string;
  currency: string;
  subtotal_amount: string;
  vat_total_amount: string;
  total_amount: string;
  folder: string;
  artifact_count: number;
};

export type Manifest = {
  manifest_schema_version: string;
  /**
   * Ako sa overuje integrita — napísané priamo v manifeste, aby to vedel aj
   * ten, kto ZIP dostane bez prístupu k Esblu.
   */
  hash_strategy: {
    algorithm: "sha256";
    /** Manifest obsahuje odtlačky VŠETKÝCH ostatných súborov. */
    covers: "all_payload_files";
    /** Sám seba neobsahuje — inak by sa odtlačok nedal spočítať. */
    excludes: "manifest.json";
    /** Odtlačok manifestu a celého ZIP-u drží Esblu v zázname o odovzdaní. */
    manifest_hash_location: "accounting_handoff_exports.manifest_sha256";
    package_hash_location: "accounting_handoff_exports.package_sha256";
  };
  export_id: string;
  company_id: string;
  generated_at: string;
  generated_by: string;
  app_commit: string | null;
  invoice_count: number;
  issued_count: number;
  received_count: number;
  file_count: number;
  total_bytes: number;
  invoices: ManifestInvoice[];
  files: ManifestFile[];
  disclaimer: string;
};

export const MANIFEST_DISCLAIMER =
  "Tento balik je technicky export dokladov z Esblu pre ucely odovzdania uctovnikovi. " +
  "Nie je to zakonny archiv a jeho vytvorenie nie je splnenim archivacnej povinnosti. " +
  "Za dlhodobe uchovavanie zodpoveda prijimatel podla vlastneho pravneho nastavenia.";

export type BuildManifestInput = {
  exportId: string;
  companyId: string;
  generatedAt: string;
  generatedBy: string;
  appCommit: string | null;
  invoices: ManifestInvoice[];
  files: ManifestFile[];
};

/**
 * Manifest zo zozbieraných súborov.
 *
 * ODTLAČKY BEZ KRUHU
 * ------------------
 * Manifest obsahuje odtlačok každého iného súboru v balíku, ale nie svoj
 * vlastný — ten sa spočítať nedá, lebo zapísaním by sa manifest zmenil.
 * Odtlačok manifestu a odtlačok celého ZIP-u sa preto ukladajú do databázy
 * (`manifest_sha256`, `package_sha256`). Reťaz je úplná a nikde sa nezacyklí:
 *
 *     súbory → manifest.json → záznam v Esblu
 *     celý ZIP ──────────────→ záznam v Esblu
 */
export function buildManifest(input: BuildManifestInput): Manifest {
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path));

  return {
    manifest_schema_version: MANIFEST_SCHEMA_VERSION,
    hash_strategy: {
      algorithm: "sha256",
      covers: "all_payload_files",
      excludes: "manifest.json",
      manifest_hash_location: "accounting_handoff_exports.manifest_sha256",
      package_hash_location: "accounting_handoff_exports.package_sha256",
    },
    export_id: input.exportId,
    company_id: input.companyId,
    generated_at: input.generatedAt,
    generated_by: input.generatedBy,
    app_commit: input.appCommit,
    invoice_count: input.invoices.length,
    issued_count: input.invoices.filter((i) => i.direction === "issued").length,
    received_count: input.invoices.filter((i) => i.direction === "received").length,
    file_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    invoices: [...input.invoices].sort((a, b) => a.folder.localeCompare(b.folder)),
    files,
    disclaimer: MANIFEST_DISCLAIMER,
  };
}

// -----------------------------------------------------------------------------
// Kontrola hotového balíka
// -----------------------------------------------------------------------------

export type PackageProblem =
  | { code: "duplicate_path"; path: string }
  | { code: "unsafe_path"; path: string }
  | { code: "empty_package" }
  | { code: "too_many_invoices"; count: number }
  | { code: "too_many_files"; count: number }
  | { code: "package_too_large"; bytes: number }
  | { code: "file_too_large"; path: string; bytes: number };

/**
 * Posledná kontrola pred zbalením.
 *
 * Beží nad zoznamom, ktorý sa naozaj chystá do ZIP-u — nie nad zámerom.
 * Cesta sa kontroluje ešte raz, aj keď každý segment prešiel cez
 * `safeSegment`: chyba v skladaní cesty je rovnako možná ako chyba vo
 * vstupe a stojí rovnako veľa.
 */
export function packageProblems(
  files: readonly ManifestFile[],
  invoiceCount: number
): PackageProblem[] {
  const problems: PackageProblem[] = [];

  if (files.length === 0) problems.push({ code: "empty_package" });
  if (invoiceCount > PACKAGE_LIMITS.maxInvoices) {
    problems.push({ code: "too_many_invoices", count: invoiceCount });
  }
  if (files.length > PACKAGE_LIMITS.maxFiles) {
    problems.push({ code: "too_many_files", count: files.length });
  }

  const seen = new Set<string>();
  let totalBytes = 0;

  for (const file of files) {
    if (seen.has(file.path)) problems.push({ code: "duplicate_path", path: file.path });
    seen.add(file.path);

    if (!isSafeZipPath(file.path)) problems.push({ code: "unsafe_path", path: file.path });

    if (file.bytes > PACKAGE_LIMITS.maxSingleFileBytes) {
      problems.push({ code: "file_too_large", path: file.path, bytes: file.bytes });
    }
    totalBytes += file.bytes;
  }

  if (totalBytes > PACKAGE_LIMITS.maxTotalBytes) {
    problems.push({ code: "package_too_large", bytes: totalBytes });
  }

  return problems;
}

/**
 * Cesta, ktorá sa pri rozbalení nedostane mimo cieľového priečinka.
 *
 * Toto je obrana proti zip-slip. Nestačí zakázať `..` — absolútna cesta,
 * spätná lomka (Windows ju berie ako oddeľovač), dvojbodka disku aj prázdny
 * segment dokážu to isté.
 */
export function isSafeZipPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 400) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;

  if (new RegExp("[\\u0000-\\u001f\\u007f]").test(path)) return false;

  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Názov ZIP súboru. Deterministický, bez údajov o firme v názve. */
export function packageFileName(generatedAt: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${generatedAt.getFullYear()}-${pad(generatedAt.getMonth() + 1)}-${pad(generatedAt.getDate())}` +
    `-${pad(generatedAt.getHours())}${pad(generatedAt.getMinutes())}`;
  return `esblu-accounting-handoff-${stamp}.zip`;
}

/** Koreňový priečinok vnútri ZIP-u — bez neho sa rozbalením zaprace plocha. */
export function packageRootFolder(fileName: string): string {
  return fileName.replace(/\.zip$/i, "");
}
