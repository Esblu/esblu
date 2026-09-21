import type { SupabaseClient } from "@supabase/supabase-js";
import { evidenceDetailHref, generalDocumentDetailHref } from "@/lib/vehicle-documents";

// =============================================================================
// Dokumenty priradené ku konkrétnemu STROJU.
//
// ŽIADNA NOVÁ DB ZMENA
// --------------------
// Väzby už v databáze existujú a appka ich už dnes ZAPISUJE — chýbalo iba
// miesto, kde ich prečítať:
//   • public.document_links.machine_id        (20260812150000_add_ai_inbox_core_tables)
//   • public.ai_evidence.machine_id           (20260813120000_add_machine_assignment_to_ai_evidence)
// V Inboxe sa dá dokument priradiť k stroju ("Uložiť k stroju"), ale detail
// stroja tieto dokumenty doteraz nikdy nezobrazil. Používateľ ich videl len
// v Inboxe, kde sa medzi ostatnými strácali.
//
// ROZDIEL OPROTI VOZIDLÁM
// -----------------------
// lib/vehicle-documents.ts okrem priamej FK väzby dopĺňa aj zhodu cez
// normalizovanú ŠPZ, pretože ai_evidence.vehicle_id býva historicky NULL.
// Stroj ŽIADNY taký sekundárny identifikátor nemá — `machine_label` je
// voľný text, ktorý AI prepísala z dokumentu, a párovať podľa neho by
// znamenalo hádať. Preto sa tu používa VÝHRADNE priama FK väzba.
//
// Autorizácia: výhradne RLS nad odovzdaným klientom. Žiadny company_id
// parameter, žiadny service_role, žiadna zmena oprávnení.
// =============================================================================

export type MachineDocumentEntry = {
  id: string;
  source: "documents" | "ai_evidence";
  /** Surový document_type — volajúci si ho preloží cez inbox.documentTypes.*. */
  documentType: string;
  date: string | null;
  label: string;
  href: string;
};

function readExtractedDate(fields: Record<string, unknown> | null): string | null {
  if (!fields) return null;
  for (const key of ["issueDate", "purchaseDate", "serviceDate", "documentDate", "validFrom"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

export async function fetchMachineDocuments(
  supabase: SupabaseClient,
  machineId: string
): Promise<MachineDocumentEntry[]> {
  const [general, evidence] = await Promise.all([
    supabase
      .from("documents")
      .select(
        "id, document_type, original_filename, extracted_fields, created_at, archived_from_inbox_at, document_links!inner(machine_id)"
      )
      .eq("document_links.machine_id", machineId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("ai_evidence")
      .select("id, document_type, document_date, material, supplier, created_at")
      .eq("machine_id", machineId)
      .order("created_at", { ascending: false }),
  ]);

  const entries: MachineDocumentEntry[] = [];

  if (general.error) {
    console.error("fetchMachineDocuments (documents) zlyhalo:", general.error.message);
  } else {
    for (const row of (general.data ?? []) as {
      id: string;
      document_type: string;
      original_filename: string | null;
      extracted_fields: Record<string, unknown> | null;
      created_at: string;
      archived_from_inbox_at: string | null;
    }[]) {
      entries.push({
        id: row.id,
        source: "documents",
        documentType: row.document_type,
        date: readExtractedDate(row.extracted_fields) ?? row.created_at.slice(0, 10),
        label: row.original_filename || "",
        // Prvý argument je ZÁMERNE null. generalDocumentDetailHref stavia
        // pri archivovanom dokumente odkaz na detail VOZIDLA — poslať doň
        // machineId by vyrobilo odkaz na neexistujúce vozidlo. Archiváciu
        // (archived_from_inbox_at) navyše nastavuje výhradne
        // esblu_finalize_vehicle_document, takže dokument stroja ju nikdy
        // nemá a odkaz vždy správne mieri na Inbox modal.
        href: generalDocumentDetailHref(null, row.id, Boolean(row.archived_from_inbox_at)),
      });
    }
  }

  if (evidence.error) {
    console.error("fetchMachineDocuments (ai_evidence) zlyhalo:", evidence.error.message);
  } else {
    for (const row of (evidence.data ?? []) as {
      id: string;
      document_type: string | null;
      document_date: string | null;
      material: string | null;
      supplier: string | null;
      created_at: string;
    }[]) {
      entries.push({
        id: row.id,
        source: "ai_evidence",
        documentType: row.document_type ?? "",
        date: row.document_date ?? row.created_at.slice(0, 10),
        label: [row.supplier, row.material].filter(Boolean).join(" · "),
        href: evidenceDetailHref(row.id),
      });
    }
  }

  entries.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  return entries;
}
