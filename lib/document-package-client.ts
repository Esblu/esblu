"use client";

import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { downloadBlob } from "@/lib/file-actions";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import type { Locale } from "@/lib/i18n/locales";
import {
  buildDownloadStateMap,
  decodeExcludedHeader,
  verifyPackageBytes,
  type DownloadState,
  type FolderManifestExcluded,
  type PackageEntityType,
} from "@/lib/invoicing/document-package";

// =============================================================================
// Stiahnutie balíka dokladov v prehliadači — a KEDY sa smie povedať
// „Stiahnuté".
//
//   1. server zloží a overí balík            (nič o stiahnutí nezapíše)
//   2. prehliadač prijme CELÚ odpoveď        (arrayBuffer sa vyrieši až na konci)
//   3. SHA-256 prijatých bajtov == server    (neúplné/iné bajty = žiadne potvrdenie)
//   4. spustí sa lokálne uloženie súboru
//   5. až potom esblu_confirm_package_download → udalosť „Stiahnuté"
//
// Keď čokoľvek z 2–3 zlyhá, súbor sa neuloží a nič sa neoznačí. Keď zlyhá
// iba krok 5, súbor používateľ má, ale stav sa nezapísal — a UI to povie.
// =============================================================================

export type PackageRefInput = { type: PackageEntityType; id: string };

export type PackageDownloadRequest =
  | { kind: "folder"; folderId: string }
  | { kind: "selection" | "inbox_selection"; items: PackageRefInput[] };

export type PackageDownloadOutcome = {
  fileName: string;
  itemCount: number;
  fileCount: number;
  bytes: number;
  excluded: FolderManifestExcluded[];
  /** Koľko dokladov sa označilo ako stiahnuté; `null` = zápis stavu zlyhal. */
  recorded: number | null;
};

export class PackageDownloadError extends Error {
  readonly code: string;
  readonly serverMessage: string | null;
  readonly excluded: FolderManifestExcluded[];
  constructor(code: string, serverMessage: string | null, excluded: FolderManifestExcluded[] = []) {
    super(code);
    this.name = "PackageDownloadError";
    this.code = code;
    this.serverMessage = serverMessage;
    this.excluded = excluded;
  }
}

/**
 * Prijme CELÚ odpoveď a overí ju. Vráti bajty a ich odtlačok, alebo vyhodí
 * chybu — nikdy nevráti čiastočný výsledok.
 */
export async function receiveVerifiedPackage(
  response: Response
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Content-Length sa zámerne neporovnáva: pri kompresii prenosu hovorí o
  // zakódovanej dĺžke, nie o bajtoch súboru. Úplnosť dokazuje odtlačok —
  // chýbajúci alebo zmenený bajt ho zmení vždy.
  const verified = await verifyPackageBytes(bytes, response.headers.get("x-esblu-package-sha256"));
  if (!verified.ok) throw new PackageDownloadError("INCOMPLETE_TRANSFER", null);
  return { bytes, sha256: verified.sha256 };
}

/**
 * Zapíše „Stiahnuté" pre doklady, ktoré v balíku naozaj boli. Vráti počet
 * zapísaných udalostí alebo `null`, keď sa to nepodarilo.
 */
export async function confirmPackageDownload(packageId: string | null, sha256: string): Promise<number | null> {
  if (!packageId) return null;
  const { data, error } = await supabase.rpc("esblu_confirm_package_download", {
    p_package_id: packageId,
    p_package_sha256: sha256,
  });
  if (error) {
    console.error("esblu_confirm_package_download zlyhalo:", error.message);
    return null;
  }
  return typeof data === "number" ? data : Number(data ?? 0);
}

export async function downloadDocumentPackage(
  request: PackageDownloadRequest,
  locale: Locale
): Promise<PackageDownloadOutcome> {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) throw new PackageDownloadError("UNAUTHORIZED", null);

  const response = await fetch(apiUrl("/api/document-packages"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      [REQUEST_LOCALE_HEADER]: locale,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { code?: string; error?: string; excluded?: FolderManifestExcluded[] }
      | null;
    throw new PackageDownloadError(
      typeof payload?.code === "string" ? payload.code : "INTERNAL_ERROR",
      typeof payload?.error === "string" ? payload.error : null,
      Array.isArray(payload?.excluded) ? payload.excluded : []
    );
  }

  const { bytes, sha256 } = await receiveVerifiedPackage(response);
  const fileName =
    response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "esblu-doklady.zip";

  await downloadBlob(new Blob([bytes as unknown as BlobPart], { type: "application/zip" }), fileName);

  const recorded = await confirmPackageDownload(response.headers.get("x-esblu-package-id"), sha256);

  return {
    fileName,
    itemCount: Number(response.headers.get("x-esblu-item-count") ?? 0),
    fileCount: Number(response.headers.get("x-esblu-file-count") ?? 0),
    bytes: bytes.byteLength,
    excluded: decodeExcludedHeader(response.headers.get("x-esblu-excluded")),
    recorded,
  };
}

/** Stav stiahnutia všetkých dokladov, ktoré volajúci smie vidieť. */
export async function loadDownloadStates(): Promise<Map<string, DownloadState>> {
  const { data, error } = await supabase.rpc("esblu_document_download_summary");
  if (error) {
    console.error("esblu_document_download_summary zlyhalo:", error.message);
    return new Map();
  }
  return buildDownloadStateMap((data as unknown[]) ?? []);
}
