import { supabase } from "@/lib/supabase";
import type { AccountingStatus } from "@/lib/invoicing/accounting-lifecycle";

// =============================================================================
// Čítanie a zápis účtovného stavu dokladov.
//
// Tenká vrstva nad tabuľkami z 20260923100000. Žiadne rozhodovanie tu nie
// je — o tom, kto smie čo, rozhoduje RLS, a o tom, čo znamená „oprávnený
// na odstránenie", rozhoduje accounting-lifecycle.ts.
//
// `company_id` sa ZÁMERNE nikam neposiela: v databáze má default
// `esblu_my_active_company_id()` a RLS ho overuje. Čo klient neposiela,
// to sa nedá podvrhnúť.
// =============================================================================

export type InvoiceAccountingState = {
  invoice_id: string;
  accounting_status: AccountingStatus;
  accounted_at: string | null;
  accounted_by: string | null;
};

export type HandoffExport = {
  id: string;
  created_at: string;
  created_by: string | null;
  period_from: string | null;
  period_to: string | null;
  direction: "issued" | "received" | null;
  invoice_count: number;
  manifest_sha256: string;
  note: string | null;
};

/** Účtovné stavy pre celú firmu, kľúčované podľa faktúry. */
export async function listAccountingStates(): Promise<Record<string, InvoiceAccountingState>> {
  const { data, error } = await supabase
    .from("invoice_accounting_state")
    .select("invoice_id, accounting_status, accounted_at, accounted_by");

  if (error) throw error;

  const rows = (data as InvoiceAccountingState[]) ?? [];
  return Object.fromEntries(rows.map((row) => [row.invoice_id, row]));
}

/** Identifikátory faktúr, ktoré už boli aspoň raz odovzdané. */
export async function listExportedInvoiceIds(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("accounting_handoff_export_items")
    .select("invoice_id");

  if (error) throw error;
  return new Set(((data as { invoice_id: string }[]) ?? []).map((row) => row.invoice_id));
}

/**
 * Označí doklad ako zaúčtovaný alebo to označenie odvolá.
 *
 * Odvolanie je zámerne možné: „zaúčtované" označuje človek a človek sa
 * pomýli. Riadok sa pritom nemaže — stav sa zmení a to je vidieť.
 */
export async function setAccountingStatus(
  invoiceId: string,
  status: AccountingStatus,
  userId: string
): Promise<void> {
  const accounted = status === "accounted";

  const { error } = await supabase.from("invoice_accounting_state").upsert(
    {
      invoice_id: invoiceId,
      accounting_status: status,
      accounted_at: accounted ? new Date().toISOString() : null,
      accounted_by: accounted ? userId : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "invoice_id" }
  );

  if (error) throw error;
}

/**
 * Zapíše, že sa doklady odovzdali účtovníkovi.
 *
 * Udalosť vzniká AŽ po tom, čo sa súbor naozaj vytvoril — inak by v
 * evidencii bolo odovzdanie, ktoré sa nestalo. Pri čiastočnom zlyhaní
 * (hlavička prejde, položky nie) sa nič nedopočítava: volajúci dostane
 * chybu a export zopakuje.
 */
export async function recordHandoffExport(input: {
  invoiceIds: string[];
  periodFrom: string | null;
  periodTo: string | null;
  direction: "issued" | "received" | null;
  manifestSha256: string;
  note?: string | null;
  userId: string;
}): Promise<string> {
  const { data, error } = await supabase
    .from("accounting_handoff_exports")
    .insert({
      created_by: input.userId,
      period_from: input.periodFrom,
      period_to: input.periodTo,
      direction: input.direction,
      invoice_count: input.invoiceIds.length,
      manifest_sha256: input.manifestSha256,
      note: input.note ?? null,
    })
    .select("id")
    .single();

  if (error) throw error;

  const exportId = (data as { id: string }).id;

  if (input.invoiceIds.length > 0) {
    const { error: itemsError } = await supabase
      .from("accounting_handoff_export_items")
      .insert(input.invoiceIds.map((invoiceId) => ({ export_id: exportId, invoice_id: invoiceId })));

    if (itemsError) throw itemsError;
  }

  return exportId;
}

/** Posledné odovzdania, najnovšie prvé. */
export async function listHandoffExports(limit = 20): Promise<HandoffExport[]> {
  const { data, error } = await supabase
    .from("accounting_handoff_exports")
    .select("id, created_at, created_by, period_from, period_to, direction, invoice_count, manifest_sha256, note")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data as HandoffExport[]) ?? [];
}
