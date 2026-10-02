import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// =============================================================================
// Stiahnutie PRESNE uložených bajtov (odoslané UBL / prijaté XML). SERVER-ONLY.
//
// Prístup rozhoduje RLS volajúceho (user-scoped klient): riadok vidí iba
// aktívna firma s finance.view (owner, accountant, admin s financiami). Bez
// nároku einvoice — história a dokumenty ostávajú dostupné aj po zrušení
// modulu. Bajty sa čítajú z privátneho storage až PO overení riadku pod RLS a
// pred odoslaním sa overí SHA-256.
// =============================================================================

export type StoredDocumentKind = "outbound" | "inbound";

export type DownloadResult =
  | { ok: true; bytes: Uint8Array; sha256: string; fileName: string }
  | { ok: false; status: 404 | 500; code: "NOT_FOUND" | "STORAGE_INTEGRITY" | "QUERY_FAILED" };

export async function downloadStoredDocument(
  deps: { userDb: SupabaseClient; getObject: (path: string) => Promise<Uint8Array | null> },
  kind: StoredDocumentKind,
  id: string
): Promise<DownloadResult> {
  const table = kind === "outbound" ? "einvoice_outbound" : "einvoice_inbound";
  const pathCol = kind === "outbound" ? "ubl_storage_path" : "xml_storage_path";
  const shaCol = kind === "outbound" ? "ubl_sha256" : "xml_sha256";
  const { data, error } = await deps.userDb
    .from(table)
    .select(`id, ${pathCol}, ${shaCol}`)
    .eq("id", id)
    .maybeSingle<Record<string, string | null>>();
  if (error) return { ok: false, status: 500, code: "QUERY_FAILED" };
  const path = data?.[pathCol] ?? null;
  const sha = data?.[shaCol] ?? null;
  if (!data || !path || !sha) return { ok: false, status: 404, code: "NOT_FOUND" };

  const bytes = await deps.getObject(path);
  if (!bytes) return { ok: false, status: 404, code: "NOT_FOUND" };
  if (createHash("sha256").update(bytes).digest("hex") !== sha) return { ok: false, status: 500, code: "STORAGE_INTEGRITY" };
  return { ok: true, bytes, sha256: sha, fileName: `${kind === "outbound" ? "einvoice-sent" : "einvoice-received"}-${id}.xml` };
}
