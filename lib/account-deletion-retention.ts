// =============================================================================
// Zrušenie owner účtu vs. zákonná archivácia účtovných dokladov (SERVER ONLY).
//
// Firma s FINALIZOVANÝMI faktúrami sa nedá zrušiť samoobslužne: DB guard
// esblu_block_finalized_invoice_delete (bez service_role výnimky) by zastavil
// kaskádu až PO tom, čo by route zmazala súbory zo Storage → nekonzistentný
// stav. Preto sa blokácia overí VOPRED (preflight aj delete), pred
// akýmkoľvek mazaním. Chyba overenia = fail closed (nič sa nemaže).
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export type OwnerDeletionBlocker = "FINALIZED_ACCOUNTING_DOCUMENTS";

export async function findOwnerDeletionBlocker(admin: SupabaseClient, companyId: string): Promise<OwnerDeletionBlocker | null> {
  const { count, error } = await admin
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("document_status", "finalized");
  if (error) throw new Error(`retention check failed: ${error.code ?? "unknown"}`);
  return (count ?? 0) > 0 ? "FINALIZED_ACCOUNTING_DOCUMENTS" : null;
}
