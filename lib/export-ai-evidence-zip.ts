"use client";

import { supabase } from "@/lib/supabase";
import { downloadBlob } from "@/lib/file-actions";
import type { Locale } from "@/lib/i18n/locales";
import { exportAiEvidenceToExcel, type AiEvidenceExcelRecord } from "@/lib/export-ai-evidence-excel";
import { safeExtension, safeSegment } from "@/lib/invoicing/handoff-package";
import { bytesToHex } from "@/lib/invoicing/document-package";

// =============================================================================
// Export vážnych lístkov z Inboxu S FOTKAMI.
//
// Predtým export z Inboxu dal iba zošit s riadkami — fotka dokladu, ktorá je
// jediným skutočným dôkazom, v ňom nebola. Tento export zabalí zošit spolu
// s pôvodnými nahranými fotkami a manifestom s odtlačkami.
//
// Vážne lístky nie sú finančné doklady (tabuľka ai_evidence), preto sa
// neevidujú ako „Stiahnuté" a balí ich prehliadač: fotky sa sťahujú cez
// Supabase Storage pod RLS prihláseného používateľa — cudziu fotku Storage
// nevydá. Žiadna verejná URL sa nevytvára.
// =============================================================================

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
}

export async function exportAiEvidenceZip(
  records: readonly (AiEvidenceExcelRecord & { id?: string | null })[],
  locale: Locale,
  t: TranslateFn
): Promise<{ exportedCount: number; photoCount: number; missingPhotos: number; fileName: string }> {
  const workbook = await exportAiEvidenceToExcel(records, locale, t, { deliver: false });
  if (!workbook.blob) throw new Error(t("folders.inbox.evidenceZipFailed"));

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const root = workbook.fileName.replace(/\.xlsx$/i, "");
  const files: { path: string; sha256: string; bytes: number; kind: string; record_id: string | null }[] = [];

  const add = async (path: string, bytes: Uint8Array, kind: string, recordId: string | null) => {
    zip.file(`${root}/${path}`, bytes);
    files.push({ path, sha256: await sha256Hex(bytes), bytes: bytes.byteLength, kind, record_id: recordId });
  };

  await add("prehlad.xlsx", new Uint8Array(await workbook.blob.arrayBuffer()), "overview", null);

  let photoCount = 0;
  let missingPhotos = 0;
  const used = new Set<string>();

  for (const record of records) {
    const path = record.photo_url;
    if (!path) continue;
    const { data, error } = await supabase.storage.from("ai-evidence-documents").download(path);
    if (error || !data) {
      missingPhotos++;
      continue;
    }
    const recordId = typeof record.id === "string" ? record.id : null;
    const base = safeSegment(
      [record.spz, record.document_date, record.document_number].filter(Boolean).join("_") || "doklad",
      "doklad"
    );
    let name = `${base}__${(recordId ?? String(photoCount)).slice(0, 8)}`;
    while (used.has(name)) name = `${name}_`;
    used.add(name);
    const ext = safeExtension(path.split("/").pop() ?? null, data.type || null);
    await add(`fotky/${name}.${ext}`, new Uint8Array(await data.arrayBuffer()), "original_photo", recordId);
    photoCount++;
  }

  zip.file(
    `${root}/manifest.json`,
    JSON.stringify(
      {
        manifest_schema_version: "1.0",
        kind: "inbox_weigh_tickets",
        generated_at: new Date().toISOString(),
        record_count: records.length,
        photo_count: photoCount,
        missing_photo_count: missingPhotos,
        hash_strategy: { algorithm: "sha256", covers: "all_payload_files", excludes: "manifest.json" },
        files: files.sort((a, b) => a.path.localeCompare(b.path)),
      },
      null,
      2
    )
  );

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const fileName = `${root}.zip`;
  await downloadBlob(blob, fileName);
  return { exportedCount: records.length, photoCount, missingPhotos, fileName };
}
