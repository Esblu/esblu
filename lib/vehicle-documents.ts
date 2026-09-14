import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSpz } from "@/lib/normalize-spz";
import { vehicleDetailHref } from "@/lib/entity-links";

// =============================================================================
// Esblu — zdieľané, DETERMINISTICKÉ načítanie VŠETKÝCH dokumentov PRIRADENÝCH
// ku konkrétnemu vozidlu, naprieč OBOMA existujúcimi systémami ukladania
// dokumentov v appke (zadanie, sekcia A — "najprv audit existujúceho
// dátového modelu, potom implementácia, nevymýšľaj nový model").
// =============================================================================
//
// AUDIT (Supabase MCP nad produkčnou DB + čítanie existujúceho kódu)
// potvrdil DVA nezávislé, RLS-scoped systémy ukladania dokumentov:
//
//  1) public.documents + public.document_links — všeobecné dokumenty
//     (faktúra/bloček/PZP/TP/servisný doklad/iné), PRIAMO priradené k
//     vozidlu cez document_links.vehicle_id (FK vyplnený pri uložení —
//     pozri app/ai-evidencia/page.tsx#saveOtherDocument). Rovnaký join
//     vzor ako lib/vehicle-report.ts#buildVehicleReport a
//     app/vozidla/VehicleDetailView.tsx#loadLinkedDocuments — tu iba
//     zovšeobecnený na VŠETKY document_type (vehicle-report.ts zámerne
//     filtruje iba insurance/vehicle_registration pre svoj vlastný, užší
//     účel v rámci Vehicle Reportu).
//
//  2) public.ai_evidence — vážny lístok / dodací list, SAMOSTATNÝ flow so
//     stĺpcom `spz` (surový text rozpoznaný AI pri uložení) a `vehicle_id`
//     (FK). KRITICKÉ zistenie z produkčného auditu: `vehicle_id` je ČASTO
//     null, aj keď `spz` jasne zodpovedá reálnemu vozidlu firmy (potvrdené
//     naživo na produkčných dátach) — appka ho dnes nikdy spätne
//     nedopĺňa. `resolveVehicleIdBySpz()` (app/ai-evidencia/page.tsx) pri
//     UKLADANÍ nového záznamu priraďuje vozidlo cez normalizeSpz()
//     rovnosť, nie cez surový text. Aby vyhľadávanie videlo aj staršie
//     záznamy bez tohto priradenia (alebo záznamy, kde z akéhokoľvek
//     dôvodu vehicle_id chýba), táto funkcia PRI ČÍTANÍ replikuje ROVNAKÚ
//     normalizeSpz() rovnosť — NIKDY plain full-text/ILIKE zhodu na ŠPZ,
//     NIKDY AI odhad väzby.
//
// Vozidlo je považované za "preukázane prepojené" s dokumentom VÝHRADNE ak:
//   a) document_links.vehicle_id === vehicle.id (documents), ALEBO
//   b) ai_evidence.vehicle_id === vehicle.id, ALEBO
//   c) normalizeSpz(ai_evidence.spz) === normalizeSpz(vehicle.spz)
// Žiadna iná cesta (plain text/ILIKE zhoda na dokumente, AI odhad) sa
// nepoužíva — presne podľa explicitných pravidiel zadania (sekcia A).
//
// Číta VÝHRADNE cez `supabase` klienta odovzdaný volajúcim — v praxi vždy
// user-scoped klient (lib/server-supabase-user-client.ts). RLS
// (company_id = esblu_my_active_company_id(), overené priamo v produkčnej
// DB pre obe tabuľky) je jediná autorizácia — žiadny company_id parameter,
// žiadny service_role.
// =============================================================================

export type VehicleDocumentSource = "documents" | "ai_evidence";
export type VehicleDocumentLinkKind = "direct" | "spz_match";

export type VehicleDocumentEntry = {
  id: string;
  source: VehicleDocumentSource;
  // Surový document_type — pre "documents" je to stabilný interný kľúč
  // (napr. "invoice", "insurance" — pozri inbox.documentTypes.* preklady v
  // lib/i18n/dictionaries), pre "ai_evidence" je to UŽ hotový, človekom
  // čitateľný text presne tak, ako ho appka dnes všade priamo zobrazuje
  // (app/ai-evidencia/page.tsx, napr. "vážny lístok" — pozri
  // `record.document_type` v inbox zozname/detaile tam), preto sa NIKDY
  // neprekladá cez i18n kľúč.
  documentType: string;
  // Dátum SAMOTNÉHO dokumentu (nie dátum uploadu) — null, ak appka žiadny
  // takýto dátum pre tento konkrétny dokument neeviduje (nikdy sa
  // nedomýšľa/needhaduje).
  date: string | null;
  // Názov/identifikátor dokumentu, ak ho appka eviduje — prázdny reťazec,
  // ak nie (volajúci s prístupom k prekladom doplní bezpečný fallback,
  // pozri lib/intents/handlers.ts#documentTypeLabel).
  label: string;
  href: string;
  linkKind: VehicleDocumentLinkKind;
};

function readExtractedDate(fields: Record<string, unknown> | null): string | null {
  if (!fields) return null;
  for (const key of [
    "issueDate",
    "documentDate",
    "validFrom",
    "serviceDate",
    "purchaseDate",
    "dueDate",
  ]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

async function fetchLinkedGeneralDocuments(
  supabase: SupabaseClient,
  vehicleId: string
): Promise<VehicleDocumentEntry[]> {
  const { data, error } = await supabase
    .from("documents")
    .select(
      "id, document_type, original_filename, extracted_fields, created_at, document_links!inner(vehicle_id)"
    )
    .eq("document_links.vehicle_id", vehicleId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("fetchLinkedGeneralDocuments zlyhalo:", error.message);
    return [];
  }

  const rows =
    (data as {
      id: string;
      document_type: string;
      original_filename: string | null;
      extracted_fields: Record<string, unknown> | null;
      created_at: string;
    }[]) || [];

  return rows.map((doc) => ({
    id: doc.id,
    source: "documents" as const,
    documentType: doc.document_type,
    date: readExtractedDate(doc.extracted_fields),
    label: doc.original_filename || "",
    href: vehicleDetailHref(vehicleId),
    linkKind: "direct" as const,
  }));
}

async function fetchSpzMatchedEvidence(
  supabase: SupabaseClient,
  vehicle: { id: string; spz: string | null }
): Promise<VehicleDocumentEntry[]> {
  const normalizedVehicleSpz = normalizeSpz(vehicle.spz);

  // Fetch-all-(firmu)-then-filter cez normalizeSpz() rovnosť — rovnaký
  // vzor ako resolveVehicleIdBySpz() v app/ai-evidencia/page.tsx a
  // searchVehicles() v lib/entity-search.ts. Postgrest nevie spustiť
  // normalizeSpz() na strane DB, preto sa filtruje v appke nad malou,
  // RLS/company_id ohraničenou množinou riadkov (rovnaká škála ako
  // existujúci fetchCompanyVehicles()).
  const { data, error } = await supabase
    .from("ai_evidence")
    .select("id, vehicle_id, spz, document_type, document_date, document_number, created_at");

  if (error) {
    console.error("fetchSpzMatchedEvidence zlyhalo:", error.message);
    return [];
  }

  const rows =
    (data as {
      id: string;
      vehicle_id: string | null;
      spz: string | null;
      document_type: string | null;
      document_date: string | null;
      document_number: string | null;
      created_at: string;
    }[]) || [];

  return rows
    .filter((row) => {
      if (row.vehicle_id === vehicle.id) return true;
      if (!normalizedVehicleSpz) return false;
      return normalizeSpz(row.spz) === normalizedVehicleSpz;
    })
    .map((row) => ({
      id: row.id,
      source: "ai_evidence" as const,
      documentType: row.document_type || "",
      date: row.document_date,
      label: row.document_number || "",
      href: "/ai-evidencia",
      linkKind: (row.vehicle_id === vehicle.id ? "direct" : "spz_match") as VehicleDocumentLinkKind,
    }));
}

/**
 * Vráti VŠETKY dokumenty preukázane priradené k danému vozidlu, naprieč
 * OBOMA existujúcimi systémami (documents+document_links a ai_evidence) —
 * pozri komentár na začiatku súboru. Zoradené od najnovšieho dátumu
 * dokumentu (dokumenty bez známeho dátumu idú na koniec).
 */
export async function fetchVehicleDocuments(
  supabase: SupabaseClient,
  vehicle: { id: string; spz: string | null }
): Promise<VehicleDocumentEntry[]> {
  const [general, evidence] = await Promise.all([
    fetchLinkedGeneralDocuments(supabase, vehicle.id),
    fetchSpzMatchedEvidence(supabase, vehicle),
  ]);

  const all = [...general, ...evidence];
  all.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
  return all;
}
