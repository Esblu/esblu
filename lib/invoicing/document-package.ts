// =============================================================================
// Balík dokladov s originálmi — priečinok, výber naprieč modulmi, Inbox.
//
// ČO TO JE
// --------
// ZIP, v ktorom sú doklady AJ ich originály: bločky ako fotka/sken, ktorý
// používateľ nahral, prijaté faktúry s originálom od dodávateľa, vydané
// faktúry ako PDF z finalizovaného dokladu. K tomu prehľad (xlsx), údaje
// každého dokladu (metadata.json) a manifest s odtlačkom každého súboru.
//
// Úplný balík pre účtovníka (handoff-package.ts) sa týka iba faktúr a
// zapisuje evidenciu ODOVZDANIA. Tento balík je širší (aj bločky a iné
// účtovné podklady) a neodovzdáva nič — iba sťahuje. Bezpečnostné pravidlá
// mien a ciest sú spoločné a berú sa z handoff-package.ts, nie kopírujú.
//
// ČO ZNAMENÁ „STIAHNUTÉ"
// ----------------------
// Bajty balíka úspešne dorazili k prihlásenému klientovi: prehliadač prijal
// celú odpoveď, spočítal jej SHA-256, ten sa zhodoval s tým, čo zložil
// server, a až potom to potvrdil (esblu_confirm_package_download). Server,
// ktorý iba začal posielať odpoveď, o doručení nevie nič — preto sám nič
// nezapisuje.
//
// NEZNAMENÁ to, že účtovník doklad zákonne archivoval, že ho niekto ďalší
// dostal, ani že súbor na disku ešte existuje. A nie je to zámok: stiahnutý
// doklad sa dá stiahnuť znova, a každé ďalšie stiahnutie je nová udalosť.
//
// ORIGINÁL ZNAMENÁ ORIGINÁL
// -------------------------
//   vydaná faktúra     → PDF vygenerované z kanonického finalizovaného dokladu
//   prijatá faktúra    → VÝHRADNE invoices.source_document_id
//   bloček / sken      → nahraný súbor samotného dokumentu
//
// Sprievodné dokumenty a prílohy idú do vlastných podpriečinkov a nikdy sa
// netvária ako originál. Keď originál chýba, doklad sa VYNECHÁ a povie sa to
// nahlas — žiadna náhrada inou prílohou, žiadne vlastné PDF namiesto
// dokladu od dodávateľa. Vynechaný doklad sa neoznačí ako stiahnutý.
//
// PREČO BEZ IMPORTOV (okrem pravidiel mien)
// -----------------------------------------
// Rozhodnutia o obsahu musia byť odskúšateľné bez servera, databázy a ZIP
// knižnice — rovnako ako pri úplnom balíku.
// =============================================================================

import {
  isSafeZipPath,
  safeSegment,
  PACKAGE_LIMITS,
} from "./handoff-package.ts";

export const FOLDER_MANIFEST_SCHEMA_VERSION = "2.0";

/** Najviac dokladov v jednom balíku. Rovnaká hranica ako pri úplnom balíku. */
export const DOCUMENT_PACKAGE_MAX_ENTRIES = PACKAGE_LIMITS.maxInvoices;

/** Typy záznamov, ktoré smú byť v priečinku. Uzavretý zoznam. */
export const PACKAGE_ENTITY_TYPES = ["invoice", "document"] as const;
export type PackageEntityType = (typeof PACKAGE_ENTITY_TYPES)[number];

export function isPackageEntityType(value: unknown): value is PackageEntityType {
  return typeof value === "string" && (PACKAGE_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Typy dokumentov, ktoré patria medzi účtovné podklady. Zrkadlí politiku
 * document_folder_items_insert — PZP, technický preukaz ani iné prevádzkové
 * doklady sem nepatria.
 */
export const FOLDER_DOCUMENT_TYPES = [
  "receipt",
  "invoice",
  "delivery_note",
  "service_document",
  "other",
] as const;

export function isFolderDocumentType(value: unknown): boolean {
  return typeof value === "string" && (FOLDER_DOCUMENT_TYPES as readonly string[]).includes(value);
}

export const DOCUMENT_PACKAGE_KINDS = ["folder", "selection", "inbox_selection"] as const;
export type DocumentPackageKind = (typeof DOCUMENT_PACKAGE_KINDS)[number];

export function isDocumentPackageKind(value: unknown): value is DocumentPackageKind {
  return typeof value === "string" && (DOCUMENT_PACKAGE_KINDS as readonly string[]).includes(value);
}

// -----------------------------------------------------------------------------
// Kategória a meno priečinka v ZIP-e
// -----------------------------------------------------------------------------

export type PackageCategory = "receipts" | "received_invoices" | "issued_invoices" | "other";

/** Mená podpriečinkov sú pevné a nezávislé od jazyka rozhrania. */
export const CATEGORY_FOLDERS: Record<PackageCategory, string> = {
  receipts: "blocky",
  received_invoices: "prijate-faktury",
  issued_invoices: "vystavene-faktury",
  other: "ostatne",
};

export type PackageInvoiceInput = {
  entityType: "invoice";
  id: string;
  direction: string;
  document_status: string;
  invoice_number: string | null;
  supplier_invoice_number: string | null;
  issue_date: string | null;
  source_document_id: string | null;
};

export type PackageDocumentInput = {
  entityType: "document";
  id: string;
  document_type: string | null;
  storage_path: string | null;
  deleted_at: string | null;
  original_filename: string | null;
  extracted_fields: Record<string, unknown> | null;
  created_at: string | null;
};

export type PackageEntryInput = PackageInvoiceInput | PackageDocumentInput;

export function categoryOf(entry: PackageEntryInput): PackageCategory {
  if (entry.entityType === "invoice") {
    if (entry.direction === "issued") return "issued_invoices";
    if (entry.direction === "received") return "received_invoices";
    return "other";
  }
  return entry.document_type === "receipt" ? "receipts" : "other";
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Dátum dokumentu z vyťažených polí; `null`, keď ho nepoznáme. */
export function documentDate(fields: Record<string, unknown> | null): string | null {
  if (!fields) return null;
  for (const key of ["purchaseDate", "issueDate", "documentDate", "serviceDate", "validFrom", "dueDate"]) {
    const value = asText(fields[key]);
    if (value) return value;
  }
  return null;
}

/** Ľudský popis dokladu — číslo, obchodník, dodávateľ. Nikdy prázdny. */
export function entryLabel(entry: PackageEntryInput): string {
  if (entry.entityType === "invoice") {
    const number =
      entry.direction === "received" ? entry.supplier_invoice_number : entry.invoice_number;
    return number || entry.issue_date || entry.id.slice(0, 8);
  }
  const fields = entry.extracted_fields ?? {};
  const name =
    asText(fields.merchant) ||
    asText(fields.supplier) ||
    asText(fields.invoiceNumber) ||
    asText(entry.original_filename).replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const date = documentDate(entry.extracted_fields);
  return [date, name].filter(Boolean).join(" ") || entry.id.slice(0, 8);
}

/**
 * Meno priečinka dokladu v ZIP-e. Popis ako prvý (podľa neho sa hľadá),
 * krátke id na konci (dva bločky z toho istého obchodu v ten istý deň sa
 * nesmú prepísať).
 */
export function entryFolderName(entry: PackageEntryInput): string {
  return `${safeSegment(entryLabel(entry), "doklad")}__${entry.id.slice(0, 8)}`;
}

export function entryDirectory(entry: PackageEntryInput): string {
  return `${CATEGORY_FOLDERS[categoryOf(entry)]}/${entryFolderName(entry)}`;
}

// -----------------------------------------------------------------------------
// Originál a vynechanie
// -----------------------------------------------------------------------------

export type OriginalPlan =
  | { kind: "generated_pdf" }
  | { kind: "source_document"; documentId: string }
  | { kind: "own_object" };

export type ExclusionReason =
  | "draft_not_finalized"
  | "missing_original"
  | "unknown_direction"
  | "deleted"
  | "not_accessible";

export type EntryPlan =
  | { included: true; original: OriginalPlan }
  | { included: false; reason: ExclusionReason };

/**
 * Čo sa s dokladom stane — BEZ sťahovania. `sourceDocumentAvailable` hovorí,
 * či zdrojový dokument prijatej faktúry existuje, nie je zmazaný a volajúci
 * ho smie čítať (to zistí server pod RLS).
 *
 * Koncept vydanej faktúry sa vynechá: nemá číslo a PDF z neho by tvrdilo
 * doklad, ktorý ešte neexistuje. Koncept prijatej faktúry tiež — ešte to
 * nie je účtovný doklad, iba rozpracovaný prepis.
 */
export function planEntry(
  entry: PackageEntryInput,
  options: { sourceDocumentAvailable?: boolean } = {}
): EntryPlan {
  if (entry.entityType === "invoice") {
    if (entry.direction !== "issued" && entry.direction !== "received") {
      return { included: false, reason: "unknown_direction" };
    }
    if (entry.document_status !== "finalized") {
      return { included: false, reason: "draft_not_finalized" };
    }
    if (entry.direction === "issued") return { included: true, original: { kind: "generated_pdf" } };

    // Prijatá: originál je VÝHRADNE source_document_id. Žiadna náhrada.
    if (!entry.source_document_id || options.sourceDocumentAvailable !== true) {
      return { included: false, reason: "missing_original" };
    }
    return {
      included: true,
      original: { kind: "source_document", documentId: entry.source_document_id },
    };
  }

  if (entry.deleted_at) return { included: false, reason: "deleted" };
  if (!isFolderDocumentType(entry.document_type)) return { included: false, reason: "not_accessible" };
  if (!entry.storage_path) return { included: false, reason: "missing_original" };
  return { included: true, original: { kind: "own_object" } };
}

// -----------------------------------------------------------------------------
// Stav stiahnutia
// -----------------------------------------------------------------------------

export type DownloadSummaryRow = {
  entity_type: string;
  entity_ref: string;
  download_count: number | string;
  accountant_download_count: number | string;
  last_downloaded_at: string | null;
  last_downloaded_by: string | null;
};

export type DownloadState = {
  downloaded: boolean;
  count: number;
  accountantCount: number;
  lastDownloadedAt: string | null;
  lastDownloadedBy: string | null;
};

export const NEVER_DOWNLOADED: DownloadState = {
  downloaded: false,
  count: 0,
  accountantCount: 0,
  lastDownloadedAt: null,
  lastDownloadedBy: null,
};

export function downloadKey(entityType: string, id: string): string {
  return `${entityType}:${id}`;
}

/**
 * Mapa „typ:id" → stav. Riadky z RPC sa berú opatrne: počet môže prísť ako
 * reťazec (bigint), neplatný riadok sa preskočí a nič nezhodí.
 */
export function buildDownloadStateMap(rows: readonly unknown[] | null | undefined): Map<string, DownloadState> {
  const map = new Map<string, DownloadState>();
  for (const raw of rows ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Partial<DownloadSummaryRow>;
    if (typeof row.entity_type !== "string" || typeof row.entity_ref !== "string") continue;
    const count = Number(row.download_count ?? 0);
    if (!Number.isFinite(count) || count <= 0) continue;
    const accountantCount = Number(row.accountant_download_count ?? 0);
    map.set(downloadKey(row.entity_type, row.entity_ref), {
      downloaded: true,
      count,
      accountantCount: Number.isFinite(accountantCount) ? accountantCount : 0,
      lastDownloadedAt: typeof row.last_downloaded_at === "string" ? row.last_downloaded_at : null,
      lastDownloadedBy: typeof row.last_downloaded_by === "string" ? row.last_downloaded_by : null,
    });
  }
  return map;
}

export function downloadStateOf(
  map: Map<string, DownloadState>,
  entityType: string,
  id: string
): DownloadState {
  return map.get(downloadKey(entityType, id)) ?? NEVER_DOWNLOADED;
}

export const DOWNLOAD_FILTERS = ["all", "not_downloaded", "downloaded"] as const;
export type DownloadFilter = (typeof DOWNLOAD_FILTERS)[number];

export function matchesDownloadFilter(state: DownloadState, filter: DownloadFilter): boolean {
  if (filter === "downloaded") return state.downloaded;
  if (filter === "not_downloaded") return !state.downloaded;
  return true;
}

// -----------------------------------------------------------------------------
// Manifest
// -----------------------------------------------------------------------------

export type FolderManifestFileKind =
  | "original"
  | "generated_pdf"
  | "supporting"
  | "attachment"
  | "metadata"
  | "overview"
  | "readme";

export type FolderManifestFile = {
  path: string;
  kind: FolderManifestFileKind;
  entity_type: PackageEntityType | null;
  entity_id: string | null;
  source_document_id: string | null;
  provenance: "original" | "generated";
  mime_type: string | null;
  original_filename: string | null;
  bytes: number;
  sha256: string;
};

export type FolderManifestEntry = {
  entity_type: PackageEntityType;
  entity_id: string;
  category: PackageCategory;
  label: string;
  folder: string;
  original: "uploaded_original" | "supplier_original" | "generated_pdf";
  artifact_count: number;
  missing_supporting_count: number;
};

export type FolderManifestExcluded = {
  entity_type: PackageEntityType;
  entity_id: string;
  label: string;
  reason: ExclusionReason;
};

export type FolderManifest = {
  manifest_schema_version: string;
  hash_strategy: {
    algorithm: "sha256";
    covers: "all_payload_files";
    excludes: "manifest.json";
    manifest_hash_location: "document_export_packages.manifest_sha256";
    package_hash_location: "document_export_packages.package_sha256";
  };
  package_id: string;
  package_kind: DocumentPackageKind;
  folder_id: string | null;
  folder_name: string | null;
  company_id: string;
  generated_at: string;
  generated_by: string;
  app_commit: string | null;
  entry_count: number;
  excluded_count: number;
  file_count: number;
  total_bytes: number;
  download_semantics: string;
  entries: FolderManifestEntry[];
  excluded: FolderManifestExcluded[];
  files: FolderManifestFile[];
};

export const DOWNLOAD_SEMANTICS =
  "Stiahnute = bajty tohto balika uspesne dorazili k prihlasenemu pouzivatelovi Esblu a ich SHA-256 sa zhodoval so serverom. " +
  "Neznamena to zakonnu archivaciu, prevzatie uctovnikom ani dorucenie tretej osobe. Doklady zostavaju v Esblu a daju sa stiahnut znova.";

export function buildFolderManifest(input: Omit<FolderManifest,
  "manifest_schema_version" | "hash_strategy" | "entry_count" | "excluded_count" | "file_count" | "total_bytes" | "download_semantics"
>): FolderManifest {
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  return {
    manifest_schema_version: FOLDER_MANIFEST_SCHEMA_VERSION,
    hash_strategy: {
      algorithm: "sha256",
      covers: "all_payload_files",
      excludes: "manifest.json",
      manifest_hash_location: "document_export_packages.manifest_sha256",
      package_hash_location: "document_export_packages.package_sha256",
    },
    package_id: input.package_id,
    package_kind: input.package_kind,
    folder_id: input.folder_id,
    folder_name: input.folder_name,
    company_id: input.company_id,
    generated_at: input.generated_at,
    generated_by: input.generated_by,
    app_commit: input.app_commit,
    entry_count: input.entries.length,
    excluded_count: input.excluded.length,
    file_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    download_semantics: DOWNLOAD_SEMANTICS,
    entries: [...input.entries].sort((a, b) => a.folder.localeCompare(b.folder)),
    excluded: [...input.excluded].sort((a, b) => a.entity_id.localeCompare(b.entity_id)),
    files,
  };
}

export type FolderPackageProblem =
  | { code: "duplicate_path"; path: string }
  | { code: "unsafe_path"; path: string }
  | { code: "empty_package" }
  | { code: "too_many_files"; count: number }
  | { code: "package_too_large"; bytes: number }
  | { code: "file_too_large"; path: string; bytes: number };

/** Posledná kontrola nad tým, čo sa naozaj chystá do ZIP-u. */
export function folderPackageProblems(
  files: readonly Pick<FolderManifestFile, "path" | "bytes">[],
  entryCount: number
): FolderPackageProblem[] {
  const problems: FolderPackageProblem[] = [];
  if (entryCount === 0 || files.length === 0) problems.push({ code: "empty_package" });
  if (files.length > PACKAGE_LIMITS.maxFiles) problems.push({ code: "too_many_files", count: files.length });

  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (seen.has(file.path)) problems.push({ code: "duplicate_path", path: file.path });
    seen.add(file.path);
    if (!isSafeZipPath(file.path)) problems.push({ code: "unsafe_path", path: file.path });
    if (file.bytes > PACKAGE_LIMITS.maxSingleFileBytes) {
      problems.push({ code: "file_too_large", path: file.path, bytes: file.bytes });
    }
    total += file.bytes;
  }
  if (total > PACKAGE_LIMITS.maxTotalBytes) problems.push({ code: "package_too_large", bytes: total });
  return problems;
}

// -----------------------------------------------------------------------------
// Názov balíka
// -----------------------------------------------------------------------------

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/**
 * Koreňový priečinok ZIP-u. Pri priečinku jeho bezpečné meno („August-2026"),
 * inak neutrálne meno s časom. Meno firmy sa do názvu nedáva.
 */
export function documentPackageRoot(folderName: string | null, generatedAt: Date): string {
  if (folderName && folderName.trim()) {
    return safeSegment(folderName.trim().replace(/\s+/g, "-"), "priecinok");
  }
  return `esblu-doklady-${stamp(generatedAt)}`;
}

export function documentPackageFileName(root: string): string {
  return `${root}.zip`;
}

/**
 * Hodnota hlavičky so zoznamom vynechaných dokladov. Server ju posiela
 * vedľa ZIP-u, aby UI vedelo povedať, čo v balíku nie je — skôr než by
 * ho musel používateľ rozbaliť. Kódovaná, ohraničená a bez čohokoľvek, čo
 * by sa dalo vykonať.
 */
export function encodeExcludedHeader(excluded: readonly FolderManifestExcluded[]): string {
  const compact = excluded.slice(0, 50).map((item) => ({
    t: item.entity_type,
    i: item.entity_id,
    l: item.label.slice(0, 80),
    r: item.reason,
  }));
  return encodeURIComponent(JSON.stringify(compact));
}

const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "draft_not_finalized",
  "missing_original",
  "unknown_direction",
  "deleted",
  "not_accessible",
];

export function decodeExcludedHeader(raw: string | null): FolderManifestExcluded[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as unknown;
    if (!Array.isArray(parsed)) return [];
    const result: FolderManifestExcluded[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const { t, i, l, r } = item as Record<string, unknown>;
      if (!isPackageEntityType(t) || typeof i !== "string" || typeof l !== "string") continue;
      if (!EXCLUSION_REASONS.includes(r as ExclusionReason)) continue;
      result.push({ entity_type: t, entity_id: i, label: l, reason: r as ExclusionReason });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Overenie prijatého balíka v prehliadači: sú to presne tie bajty, ktoré
 * server zložil? Neúplný prenos, iný súbor alebo chýbajúca hlavička =
 * `ok: false` a „Stiahnuté" sa NEZAPÍŠE. Content-Length sa zámerne
 * nepoužíva — pri kompresii prenosu hovorí o inej dĺžke.
 */
export async function verifyPackageBytes(
  bytes: Uint8Array,
  expectedSha256Header: string | null
): Promise<{ ok: boolean; sha256: string }> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const sha256 = bytesToHex(digest);
  const expected = (expectedSha256Header ?? "").trim().toLowerCase();
  return { ok: /^[0-9a-f]{64}$/.test(expected) && expected === sha256, sha256 };
}

/** Hex SHA-256 z ArrayBuffer — spoločné pre prehliadač aj test. */
export function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
