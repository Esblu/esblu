import { supabase } from "@/lib/supabase";
import type { AccountingStatus, HandoffStatus } from "@/lib/invoicing/accounting-lifecycle";

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
  /** Čo sa naozaj exportovalo. Pozri accounting-lifecycle.ts. */
  export_kind: "metadata_xlsx" | "complete_package";
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

/**
 * Stav odovzdania pre každú faktúru, ktorej sa už nejaký export dotkol.
 *
 * Rozlišuje sa DRUH exportu, nie jeho existencia. Stiahnutý zošit s
 * údajmi nie je odovzdanie dokladov — originály v ňom nie sú — a preto z
 * neho nikdy nesmie vyplynúť, že doklad môže z Esblu zmiznúť.
 */
export async function listHandoffStatuses(): Promise<Record<string, HandoffStatus>> {
  const { data, error } = await supabase
    .from("accounting_handoff_export_items")
    .select("invoice_id, accounting_handoff_exports!inner(export_kind)");

  if (error) throw error;

  // PostgREST vracia vnorený vzťah ako pole aj pri väzbe many-to-one;
  // normalizuje sa tu, aby sa volajúci nemusel starať o tvar odpovede.
  const rows =
    (data as unknown as {
      invoice_id: string;
      accounting_handoff_exports: { export_kind: string } | { export_kind: string }[] | null;
    }[]) ?? [];

  const out: Record<string, HandoffStatus> = {};
  for (const row of rows) {
    const related = row.accounting_handoff_exports;
    const kind = Array.isArray(related) ? related[0]?.export_kind : related?.export_kind;
    // Úplné odovzdanie prebíja export údajov; opačne nikdy.
    if (kind === "complete_package") {
      out[row.invoice_id] = "complete_handoff";
    } else if (out[row.invoice_id] !== "complete_handoff") {
      out[row.invoice_id] = "metadata_exported";
    }
  }

  return out;
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
 * Zapíše, že sa z dokladov exportovali ÚDAJE.
 *
 * Nie je to záznam o odovzdaní účtovníkovi — ten by tvrdil niečo, čo
 * Esblu nevie overiť. Udalosť vzniká AŽ po tom, čo sa súbor naozaj
 * vytvoril; pri čiastočnom zlyhaní (hlavička prejde, položky nie) sa nič
 * nedopočítava a volajúci export zopakuje.
 */
export async function recordMetadataExport(input: {
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
      export_kind: "metadata_xlsx",
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

export type AccountingStateLogEntry = {
  id: string;
  accounting_status: AccountingStatus;
  changed_at: string;
  changed_by: string | null;
};

/**
 * História označení „zaúčtované" pre jeden doklad, najnovšia prvá.
 *
 * Označenie sa dá odvolať, ale odvolanie nesmie zmazať stopu. Riadky píše
 * výhradne trigger v databáze; appka do denníka nemá zápis, takže dôkaz o
 * zmene nevyrába ten, koho sa týka.
 */
export async function listAccountingStateLog(
  invoiceId: string
): Promise<AccountingStateLogEntry[]> {
  const { data, error } = await supabase
    .from("invoice_accounting_state_log")
    .select("id, accounting_status, changed_at, changed_by")
    .eq("invoice_id", invoiceId)
    .order("changed_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data as AccountingStateLogEntry[]) ?? [];
}

/** Posledné exporty, najnovšie prvé. */
export async function listHandoffExports(limit = 20): Promise<HandoffExport[]> {
  const { data, error } = await supabase
    .from("accounting_handoff_exports")
    .select("id, export_kind, created_at, created_by, period_from, period_to, direction, invoice_count, manifest_sha256, note")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data as HandoffExport[]) ?? [];
}
