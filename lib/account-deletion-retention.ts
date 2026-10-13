// =============================================================================
// Zrušenie owner účtu vs. zákonná archivácia účtovných dokladov (SERVER ONLY).
//
// Firma s FINALIZOVANÝMI faktúrami sa nedá zrušiť samoobslužne: DB guard
// esblu_block_finalized_invoice_delete (bez service_role výnimky) by zastavil
// kaskádu až PO tom, čo by route zmazala súbory zo Storage → nekonzistentný
// stav. Preto sa blokácia overí VOPRED (preflight aj delete), pred
// akýmkoľvek mazaním. Chyba overenia = fail closed (nič sa nemaže).
//
// eInvoice ↔ RC integrácia (2026-10-13, audit §5): rovnako fail closed, kým
// nie je rozhodnutá retencia (CLIA) a deaktivácia u providera:
//   - firma má e-faktúry (einvoice_inbound / einvoice_outbound) → XML a
//     evidencia sa nemažú (nemenný archív v bucket einvoice-documents),
//   - firma je zaregistrovaná u providera (einvoice_organizations s
//     provider_org_id) → zmazanie by osirotilo identitu u providera.
// Rovnaké pravidlo vynucuje DB (20261013100000, ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION).
// Retenčná doba sa NEVYMÝŠĽA.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { OwnerDeletionBlockerCode } from "@/lib/account-deletion-blockers";

export type OwnerDeletionBlocker = OwnerDeletionBlockerCode;

/** Tabuľka ešte neexistuje (prostredie pred eInvoice migráciou) — Postgres / PostgREST. */
function isMissingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

async function countRows(
  admin: SupabaseClient,
  table: string,
  companyId: string,
  extra?: "finalized" | "provider_enrolled"
): Promise<number> {
  let query = admin.from(table).select("id", { count: "exact", head: true }).eq("company_id", companyId);
  if (extra === "finalized") query = query.eq("document_status", "finalized");
  if (extra === "provider_enrolled") query = query.not("provider_org_id", "is", null);
  const { count, error } = await query;
  if (error) {
    if (table !== "invoices" && isMissingTable(error)) return 0;
    throw new Error(`retention check failed: ${error.code ?? "unknown"}`);
  }
  return count ?? 0;
}

export async function findOwnerDeletionBlocker(admin: SupabaseClient, companyId: string): Promise<OwnerDeletionBlocker | null> {
  if ((await countRows(admin, "invoices", companyId, "finalized")) > 0) return "FINALIZED_ACCOUNTING_DOCUMENTS";
  if ((await countRows(admin, "einvoice_inbound", companyId)) > 0) return "EINVOICE_RECORDS";
  if ((await countRows(admin, "einvoice_outbound", companyId)) > 0) return "EINVOICE_RECORDS";
  if ((await countRows(admin, "einvoice_organizations", companyId, "provider_enrolled")) > 0) return "EINVOICE_PROVIDER_ENROLLED";
  return null;
}
