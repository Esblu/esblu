import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import {
  resolveVehicleByPlate,
  searchVehicles,
  searchMachines,
  searchInventoryItems,
  type SearchedVehicle,
  type SearchedMachine,
  type SearchedInventoryItem,
} from "@/lib/entity-search";
import {
  buildVehicleDeadlines,
  buildMachineDeadlines,
  deadlineTypeLabel,
  deadlineSeverityLabel,
  computeDeadlineStatus,
  DEADLINE_THRESHOLD_DAYS,
  type MinimalServiceRecord,
} from "@/lib/deadlines";
import { buildVehicleReport, buildMachineReport } from "@/lib/vehicle-report";
import {
  fetchVehicleDocuments,
  generalDocumentDetailHref,
  evidenceDetailHref,
  readExtractedDate,
  type VehicleDocumentEntry,
} from "@/lib/vehicle-documents";
import { vehicleDetailHref, machineDetailHref, inventoryItemDetailHref } from "@/lib/entity-links";
import type { VehicleVignette } from "@/lib/vehicle-vignettes";
import { formatDate } from "@/lib/i18n/format";
import {
  DOCUMENT_TYPE_FILTERS,
  type DocumentTypeFilter,
  type EntityRef,
  type IntentResult,
  type ParsedIntent,
} from "@/lib/intents/types";

// =============================================================================
// Esblu — Intent Engine handlery (zadanie, bod 2, 4, 5, 12, 14).
// =============================================================================
// Každý handler:
//   1) dostáva VÝHRADNE user-scoped Supabase klienta (RLS = jediná
//      autorizácia, žiadny company_id parameter od volajúceho — pozri
//      lib/server-supabase-user-client.ts),
//   2) je READ-ONLY (žiadny insert/update/delete),
//   3) nikdy nehádá — ak nájde 0 entít → not_found, ak nájde 2+ →
//      disambiguate, iba pri presne 1 zhode vracia navigate/answer/report.
// =============================================================================

function vehicleRef(vehicle: SearchedVehicle): EntityRef {
  const name = `${vehicle.znacka || ""} ${vehicle.model || ""}`.trim();
  const label = vehicle.spz ? `${vehicle.spz}${name ? ` — ${name}` : ""}` : name || vehicle.id;
  return { type: "vehicle", id: vehicle.id, label, href: vehicleDetailHref(vehicle.id) };
}

function machineRef(machine: SearchedMachine): EntityRef {
  const label = machine.name || machine.id;
  return { type: "machine", id: machine.id, label, href: machineDetailHref(machine.id) };
}

function inventoryRef(item: SearchedInventoryItem): EntityRef {
  const label = item.name || item.id;
  return {
    type: "inventory_item",
    id: item.id,
    label,
    href: inventoryItemDetailHref(item.id),
  };
}

async function resolveOneVehicle(
  supabase: SupabaseClient,
  query: string | undefined
): Promise<{ vehicle: SearchedVehicle | null; candidates: SearchedVehicle[] }> {
  if (!query) return { vehicle: null, candidates: [] };

  const exact = await resolveVehicleByPlate(supabase, query);
  if (exact) return { vehicle: exact, candidates: [exact] };

  const matches = await searchVehicles(supabase, query);
  if (matches.length === 1) return { vehicle: matches[0], candidates: matches };
  return { vehicle: null, candidates: matches };
}

async function resolveOneMachine(
  supabase: SupabaseClient,
  query: string | undefined
): Promise<{ machine: SearchedMachine | null; candidates: SearchedMachine[] }> {
  if (!query) return { machine: null, candidates: [] };
  const matches = await searchMachines(supabase, query);
  if (matches.length === 1) return { machine: matches[0], candidates: matches };
  return { machine: null, candidates: matches };
}

function notFound(locale: Locale, key: string, query?: string): IntentResult {
  return {
    kind: "not_found",
    text: translate(locale, key, query ? { query } : undefined),
  };
}

function disambiguateVehicles(candidates: SearchedVehicle[]): IntentResult {
  return { kind: "disambiguate", candidates: candidates.map(vehicleRef) };
}

function disambiguateMachines(candidates: SearchedMachine[]): IntentResult {
  return { kind: "disambiguate", candidates: candidates.map(machineRef) };
}

// Stabilné interné kľúče document_type z public.documents (pozri
// inbox.documentTypes.* preklady v lib/i18n/dictionaries) — VehicleDocumentEntry
// zo zdroja "ai_evidence" má v documentType už hotový, človekom čitateľný
// text (napr. "vážny lístok"), ktorý sa preto NIKDY neprekladá cez tento
// zoznam (pozri komentár v lib/vehicle-documents.ts).
const KNOWN_DOCUMENT_TYPE_KEYS = new Set<string>(DOCUMENT_TYPE_FILTERS);

// ai_evidence.document_type je pre tieto dva typy hotový, ľudsky čitateľný
// SK text (nie stabilný interný kľúč) — hodnoty overené priamo v produkčnej
// DB (`select distinct document_type from ai_evidence`), nie odhadnuté.
// Použité pri filtrovaní podľa `documentType` (SHOW_VEHICLE_DOCUMENTS/
// SEARCH_DOCUMENTS) nad záznammi z ai_evidence.
const AI_EVIDENCE_DOCUMENT_TYPE_LABEL: Partial<Record<DocumentTypeFilter, string>> = {
  weigh_ticket: "vážny lístok",
  delivery_note: "dodací list",
};

/** Zhoduje sa VehicleDocumentEntry s požadovaným `documentType` filtrom? */
function matchesDocumentTypeFilter(
  doc: VehicleDocumentEntry,
  filter: DocumentTypeFilter
): boolean {
  if (doc.source === "documents") return doc.documentType === filter;
  return doc.documentType === AI_EVIDENCE_DOCUMENT_TYPE_LABEL[filter];
}

/** Zhoduje sa dátum dokumentu (ak je známy) s [dateFrom, dateTo] rozsahom?
 * Dokument bez známeho dátumu sa pri aktívnom dátumovom filtri NIKDY
 * nezahrnie (nehádame, že "asi" patrí do rozsahu). */
function matchesDateRange(
  date: string | null,
  dateFrom: string | undefined,
  dateTo: string | undefined
): boolean {
  if (!dateFrom && !dateTo) return true;
  if (!date) return false;
  if (dateFrom && date < dateFrom) return false;
  if (dateTo && date > dateTo) return false;
  return true;
}

function documentTypeLabel(locale: Locale, doc: VehicleDocumentEntry): string {
  if (doc.source === "documents" && KNOWN_DOCUMENT_TYPE_KEYS.has(doc.documentType)) {
    return translate(locale, `inbox.documentTypes.${doc.documentType}`);
  }
  return doc.documentType || translate(locale, "inbox.documentTypes.other");
}

// -----------------------------------------------------------------------------
// Vozidlá
// -----------------------------------------------------------------------------

export async function handleOpenOrSearchVehicle(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined,
  forceList: boolean
): Promise<IntentResult> {
  if (!query) return notFound(locale, "search.errors.missingQuery");

  const { vehicle, candidates } = await resolveOneVehicle(supabase, query);

  if (vehicle && !forceList) {
    return { kind: "navigate", entity: vehicleRef(vehicle) };
  }
  if (candidates.length === 0) {
    return notFound(locale, "search.errors.vehicleNotFound", query);
  }
  if (candidates.length === 1) {
    return { kind: "navigate", entity: vehicleRef(candidates[0]) };
  }
  return disambiguateVehicles(candidates);
}

export async function handleShowVehicleDocuments(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined,
  documentType?: DocumentTypeFilter,
  dateFrom?: string,
  dateTo?: string
): Promise<IntentResult> {
  const { vehicle, candidates } = await resolveOneVehicle(supabase, query);
  if (!vehicle) {
    return candidates.length > 1
      ? disambiguateVehicles(candidates)
      : notFound(locale, "search.errors.vehicleNotFound", query);
  }

  const entity = vehicleRef(vehicle);
  // Naprieč OBOMA existujúcimi systémami ukladania dokumentov
  // (documents+document_links a ai_evidence) — pozri
  // lib/vehicle-documents.ts pre plný audit a odôvodnenie. Nikdy sa
  // nehádá: ak DB dáta nepotvrdia väzbu na toto vozidlo, dokument sa sem
  // nedostane.
  const allDocuments = await fetchVehicleDocuments(supabase, { id: vehicle.id, spz: vehicle.spz });

  // Nepovinný filter podľa typu dokumentu ("Ukáž vážne lístky pre AB698CT")
  // a/alebo dátumového rozsahu — aplikuje sa NAD už deterministicky
  // priradeným zoznamom vyššie, nikdy nemení, ČO sa považuje za priradené
  // k vozidlu (žiadny nový spôsob priradenia, iba doplnkový filter).
  const documents = allDocuments.filter((doc) => {
    if (documentType && !matchesDocumentTypeFilter(doc, documentType)) return false;
    if (!matchesDateRange(doc.date, dateFrom, dateTo)) return false;
    return true;
  });

  if (documents.length === 0) {
    return {
      kind: "answer",
      text: translate(locale, "search.answers.noVehicleDocuments", { entity: entity.label }),
      entity,
    };
  }

  return {
    kind: "document_list",
    title: translate(locale, "search.results.vehicleDocumentsTitle", { entity: entity.label }),
    entity,
    items: documents.map((doc) => ({
      typeLabel: documentTypeLabel(locale, doc),
      dateLabel: doc.date ? formatDate(doc.date, locale) : null,
      label: doc.label || documentTypeLabel(locale, doc),
      href: doc.href,
      linkLabel: translate(
        locale,
        doc.linkKind === "direct"
          ? "search.results.documentLinkDirect"
          : "search.results.documentLinkBySpz"
      ),
    })),
  };
}

export async function handleShowVehicleService(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined
): Promise<IntentResult> {
  const { vehicle, candidates } = await resolveOneVehicle(supabase, query);
  if (!vehicle) {
    return candidates.length > 1
      ? disambiguateVehicles(candidates)
      : notFound(locale, "search.errors.vehicleNotFound", query);
  }
  return { kind: "navigate", entity: vehicleRef(vehicle) };
}

export async function handleVehicleStkStatus(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined
): Promise<IntentResult> {
  const { vehicle, candidates } = await resolveOneVehicle(supabase, query);
  if (!vehicle) {
    return candidates.length > 1
      ? disambiguateVehicles(candidates)
      : notFound(locale, "search.errors.vehicleNotFound", query);
  }
  return dateStatusAnswer(locale, vehicle, vehicle.stk, "dashboard.stkLabel");
}

export async function handleVehicleEkStatus(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined
): Promise<IntentResult> {
  const { vehicle, candidates } = await resolveOneVehicle(supabase, query);
  if (!vehicle) {
    return candidates.length > 1
      ? disambiguateVehicles(candidates)
      : notFound(locale, "search.errors.vehicleNotFound", query);
  }
  return dateStatusAnswer(locale, vehicle, vehicle.ek, "dashboard.ekLabel");
}

function dateStatusAnswer(
  locale: Locale,
  vehicle: SearchedVehicle,
  dateValue: string | null,
  typeLabelKey: string
): IntentResult {
  const typeLabel = translate(locale, typeLabelKey);
  const entity = vehicleRef(vehicle);

  if (!dateValue) {
    return {
      kind: "answer",
      text: translate(locale, "search.answers.dateNotTracked", { type: typeLabel, entity: entity.label }),
      entity,
    };
  }

  const status = computeDeadlineStatus(dateValue);
  const dateLabel = formatDate(dateValue, locale);

  if (!status) {
    // Ďaleko v budúcnosti (>60 dní) — stále platná, reálna odpoveď, iba
    // mimo "aktívneho upozornenia" pásma (pozri lib/deadlines.ts).
    return {
      kind: "answer",
      text: translate(locale, "search.answers.dateFuture", {
        type: typeLabel,
        entity: entity.label,
        date: dateLabel,
      }),
      entity,
    };
  }

  const text =
    status.severity === "overdue"
      ? translate(locale, "search.answers.dateOverdue", {
          type: typeLabel,
          entity: entity.label,
          date: dateLabel,
          days: Math.abs(status.daysRemaining),
        })
      : translate(locale, "search.answers.dateDueSoon", {
          type: typeLabel,
          entity: entity.label,
          date: dateLabel,
          days: status.daysRemaining,
        });

  return { kind: "answer", text, entity };
}

export async function handleVehicleVignetteStatus(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined
): Promise<IntentResult> {
  const { vehicle, candidates } = await resolveOneVehicle(supabase, query);
  if (!vehicle) {
    return candidates.length > 1
      ? disambiguateVehicles(candidates)
      : notFound(locale, "search.errors.vehicleNotFound", query);
  }

  const { data, error } = await supabase
    .from("vehicle_vignettes")
    .select("*")
    .eq("vehicle_id", vehicle.id);

  if (error) {
    console.error("handleVehicleVignetteStatus zlyhalo:", error.message);
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  const vignettes = (data as VehicleVignette[]) || [];
  const entity = vehicleRef(vehicle);

  if (vignettes.length === 0) {
    return {
      kind: "answer",
      text: translate(locale, "search.answers.vignetteNotTracked", { entity: entity.label }),
      entity,
    };
  }

  const lines = vignettes.map((v) => {
    const dateLabel = formatDate(v.valid_until, locale);
    const status = computeDeadlineStatus(v.valid_until);
    const suffix =
      status?.severity === "overdue"
        ? translate(locale, "search.answers.vignetteExpiredSuffix")
        : "";
    return `${v.country_code}: ${dateLabel}${suffix}`;
  });

  return {
    kind: "answer",
    text: translate(locale, "search.answers.vignetteSummary", {
      entity: entity.label,
      list: lines.join(", "),
    }),
    entity,
  };
}

export async function handleVehicleCostSummary(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined,
  year: number | undefined
): Promise<IntentResult> {
  const { vehicle, candidates } = await resolveOneVehicle(supabase, query);
  if (!vehicle) {
    return candidates.length > 1
      ? disambiguateVehicles(candidates)
      : notFound(locale, "search.errors.vehicleNotFound", query);
  }

  const report = await buildVehicleReport(supabase, vehicle.id);
  if (!report) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  const entity = vehicleRef(vehicle);
  const targetYear = year ?? new Date().getFullYear();
  const isCurrentYear = targetYear === new Date().getFullYear();
  const amount = isCurrentYear
    ? report.totalServiceCostThisYear
    : report.serviceHistory
        .filter((s) => s.service_date && new Date(s.service_date).getFullYear() === targetYear)
        .reduce((sum, s) => sum + (Number.isFinite(s.cost) ? s.cost : 0), 0);

  return {
    kind: "answer",
    text: translate(locale, "search.answers.costSummary", {
      entity: entity.label,
      year: targetYear,
      amount: amount.toFixed(2),
    }),
    entity,
  };
}

export async function handleVehicleReport(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined
): Promise<IntentResult> {
  const { vehicle, candidates } = await resolveOneVehicle(supabase, query);
  if (!vehicle) {
    return candidates.length > 1
      ? disambiguateVehicles(candidates)
      : notFound(locale, "search.errors.vehicleNotFound", query);
  }

  const report = await buildVehicleReport(supabase, vehicle.id);
  if (!report) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  const notTracked = translate(locale, "search.report.notTracked");
  const entity = vehicleRef(vehicle);

  const basicRows = [
    { label: translate(locale, "search.report.plate"), value: report.vehicle.spz || notTracked },
    { label: translate(locale, "search.report.vin"), value: report.vehicle.vin || notTracked },
    {
      label: translate(locale, "search.report.brandModel"),
      value: `${report.vehicle.znacka || ""} ${report.vehicle.model || ""}`.trim() || notTracked,
    },
  ];

  const complianceRows = [
    {
      label: translate(locale, "dashboard.stkLabel"),
      value: report.vehicle.stk ? formatDate(report.vehicle.stk, locale) : notTracked,
    },
    {
      label: translate(locale, "dashboard.ekLabel"),
      value: report.vehicle.ek ? formatDate(report.vehicle.ek, locale) : notTracked,
    },
    {
      label: translate(locale, "search.report.insurance"),
      value: report.latestInsurance?.validTo
        ? formatDate(report.latestInsurance.validTo, locale)
        : notTracked,
    },
    {
      label: translate(locale, "search.report.registrationDocument"),
      value: report.hasRegistrationDocument
        ? translate(locale, "search.report.present")
        : notTracked,
    },
    {
      label: translate(locale, "dashboard.vignetteLabel"),
      value:
        report.vignettes.length > 0
          ? report.vignettes
              .map((v) => `${v.country_code}: ${formatDate(v.valid_until, locale)}`)
              .join(", ")
          : notTracked,
    },
  ];

  const serviceRows = [
    {
      label: translate(locale, "search.report.lastService"),
      value: report.lastService
        ? `${formatDate(report.lastService.service_date, locale)} — ${report.lastService.title}`
        : notTracked,
    },
    {
      label: translate(locale, "search.report.nextService"),
      value: report.nextServiceDate ? formatDate(report.nextServiceDate, locale) : notTracked,
    },
    {
      label: translate(locale, "search.report.totalCostThisYear"),
      value: `${report.totalServiceCostThisYear.toFixed(2)} €`,
    },
    {
      label: translate(locale, "search.report.totalCostAllTime"),
      value: `${report.totalServiceCostAllTime.toFixed(2)} €`,
    },
  ];

  return {
    kind: "report",
    reportType: "vehicle",
    entity,
    sections: [
      { title: translate(locale, "search.report.sectionBasic"), rows: basicRows },
      { title: translate(locale, "search.report.sectionCompliance"), rows: complianceRows },
      { title: translate(locale, "search.report.sectionService"), rows: serviceRows },
    ],
  };
}

// -----------------------------------------------------------------------------
// Stroje
// -----------------------------------------------------------------------------

export async function handleOpenOrSearchMachine(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined,
  forceList: boolean
): Promise<IntentResult> {
  if (!query) return notFound(locale, "search.errors.missingQuery");

  const { machine, candidates } = await resolveOneMachine(supabase, query);
  if (machine && !forceList) {
    return { kind: "navigate", entity: machineRef(machine) };
  }
  if (candidates.length === 0) {
    return notFound(locale, "search.errors.machineNotFound", query);
  }
  if (candidates.length === 1) {
    return { kind: "navigate", entity: machineRef(candidates[0]) };
  }
  return disambiguateMachines(candidates);
}

export async function handleShowMachineService(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined
): Promise<IntentResult> {
  const { machine, candidates } = await resolveOneMachine(supabase, query);
  if (!machine) {
    return candidates.length > 1
      ? disambiguateMachines(candidates)
      : notFound(locale, "search.errors.machineNotFound", query);
  }
  return { kind: "navigate", entity: machineRef(machine) };
}

export async function handleMachineReport(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined
): Promise<IntentResult> {
  const { machine, candidates } = await resolveOneMachine(supabase, query);
  if (!machine) {
    return candidates.length > 1
      ? disambiguateMachines(candidates)
      : notFound(locale, "search.errors.machineNotFound", query);
  }

  const report = await buildMachineReport(supabase, machine.id);
  if (!report) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  const notTracked = translate(locale, "search.report.notTracked");
  const entity = machineRef(machine);

  const basicRows = [
    {
      label: translate(locale, "search.report.brandModel"),
      value: `${report.machine.manufacturer || ""} ${report.machine.model || ""}`.trim() || notTracked,
    },
    {
      label: translate(locale, "search.report.serialNumber"),
      value: report.machine.serialNumber || notTracked,
    },
  ];

  const serviceRows = [
    {
      label: translate(locale, "search.report.lastService"),
      value: report.lastService
        ? `${formatDate(report.lastService.service_date, locale)} — ${report.lastService.title}`
        : notTracked,
    },
    {
      label: translate(locale, "search.report.nextService"),
      value: report.nextServiceDate ? formatDate(report.nextServiceDate, locale) : notTracked,
    },
    {
      label: translate(locale, "search.report.totalCostThisYear"),
      value: `${report.totalServiceCostThisYear.toFixed(2)} €`,
    },
    {
      label: translate(locale, "search.report.totalCostAllTime"),
      value: `${report.totalServiceCostAllTime.toFixed(2)} €`,
    },
  ];

  return {
    kind: "report",
    reportType: "machine",
    entity,
    sections: [
      { title: translate(locale, "search.report.sectionBasic"), rows: basicRows },
      { title: translate(locale, "search.report.sectionService"), rows: serviceRows },
    ],
  };
}

// -----------------------------------------------------------------------------
// Sklad
// -----------------------------------------------------------------------------

export async function handleOpenOrSearchInventoryItem(
  supabase: SupabaseClient,
  locale: Locale,
  query: string | undefined,
  // Ponechané kvôli symetrickému API s handleOpenOrSearchVehicle/Machine
  // (OPEN_* vs. SEARCH_* volajú s rôznou hodnotou), pozri komentár nižšie.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _forceList: boolean
): Promise<IntentResult> {
  if (!query) return notFound(locale, "search.errors.missingQuery");

  const matches = await searchInventoryItems(supabase, query);
  if (matches.length === 0) return notFound(locale, "search.errors.inventoryNotFound", query);
  if (matches.length === 1) return { kind: "navigate", entity: inventoryRef(matches[0]) };
  // forceList sa tu (na rozdiel od vozidiel/strojov) nevyužíva na
  // rozlíšenie OPEN vs. SEARCH správania, keďže pri 2+ zhodách je jediná
  // bezpečná odpoveď vždy výber — ponechané ako parameter kvôli
  // symetrickému API s handleOpenOrSearchVehicle/Machine.
  return { kind: "disambiguate", candidates: matches.map(inventoryRef) };
}

// -----------------------------------------------------------------------------
// Dokumenty (SEARCH_DOCUMENTS) — jednoduché textové vyhľadávanie nad OBOMA
// existujúcimi systémami dokumentov (pozri lib/vehicle-documents.ts pre
// plný audit). Odkaz na KAŽDÝ výsledok vedie na KONKRÉTNY dokument (nie iba
// na Inbox/vozidlo vo všeobecnosti) — rovnaké `generalDocumentDetailHref`/
// `evidenceDetailHref` helpery, aké používa SHOW_VEHICLE_DOCUMENTS nižšie,
// vrátane vetvenia podľa `archived_from_inbox_at` (finalizované PZP/TP majú
// domov na detaile vozidla, všetko ostatné v Inboxe).
// -----------------------------------------------------------------------------

export type SearchDocumentsFilters = {
  query?: string;
  documentType?: DocumentTypeFilter;
  dateFrom?: string;
  dateTo?: string;
  amount?: number;
};

function extractedTotalAmount(fields: Record<string, unknown> | null): number | null {
  if (!fields) return null;
  const raw = (fields as Record<string, unknown>).totalAmount;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function amountMatches(fields: Record<string, unknown> | null, target: number): boolean {
  const value = extractedTotalAmount(fields);
  return value !== null && Math.abs(value - target) < 0.01;
}

/** Text pre "žiadne dokumenty nenájdené" hlásenie, aj keď príkaz bol iba
 * typ/dátum/suma filter bez voľného textu (nikdy nenechá v hláške
 * nedosadenú "{{query}}" šablónu). */
function describeSearchForNotFound(locale: Locale, filters: SearchDocumentsFilters): string {
  if (filters.query) return filters.query;
  const parts: string[] = [];
  if (filters.documentType) {
    parts.push(translate(locale, `inbox.documentTypes.${filters.documentType}`));
  }
  if (filters.dateFrom || filters.dateTo) {
    parts.push(`${filters.dateFrom ?? "…"} – ${filters.dateTo ?? "…"}`);
  }
  if (filters.amount !== undefined) parts.push(`${filters.amount} €`);
  return parts.join(", ") || translate(locale, "search.results.documentsTitle");
}

export async function handleSearchDocuments(
  supabase: SupabaseClient,
  locale: Locale,
  filters: SearchDocumentsFilters
): Promise<IntentResult> {
  const { query, documentType, dateFrom, dateTo, amount } = filters;

  if (!query && !documentType && !dateFrom && !dateTo && amount === undefined) {
    return notFound(locale, "search.errors.missingQuery");
  }

  // ai_evidence pozná VÝHRADNE weigh_ticket/delivery_note (overené v
  // produkčnej DB) a nemá koncept peňažnej sumy — ak je aktívny amount
  // filter, alebo je documentType iný typ, ai_evidence sa vôbec
  // nedotazuje (nemohla by tam nič zodpovedať, netreba zbytočný dopyt).
  const aiEvidenceTypeLabel = documentType
    ? AI_EVIDENCE_DOCUMENT_TYPE_LABEL[documentType]
    : undefined;
  const shouldQueryEvidence = amount === undefined && (!documentType || Boolean(aiEvidenceTypeLabel));

  // Voľné textové vyhľadávanie prehľadáva OBA existujúce systémy
  // ukladania dokumentov — toto je všeobecný, nie vozidlo-špecifický
  // príkaz (na rozdiel od SHOW_VEHICLE_DOCUMENTS vyššie). `documentType`/
  // `dateFrom`/`dateTo`/`amount` sú VŽDY iba doplnkový, presne definovaný
  // filter nad existujúcimi stĺpcami — nikdy surový SQL/text fragment od
  // AI (bod 2 zadania).
  let documentsQuery = supabase
    .from("documents")
    .select(
      "id, document_type, original_filename, note, extracted_fields, created_at, archived_from_inbox_at, document_links(vehicle_id)"
    )
    .is("deleted_at", null);

  if (documentType) {
    documentsQuery = documentsQuery.eq("document_type", documentType);
  }
  if (query) {
    documentsQuery = documentsQuery.or(
      `original_filename.ilike.%${query}%,note.ilike.%${query}%,extracted_fields->>supplier.ilike.%${query}%,extracted_fields->>customer.ilike.%${query}%,extracted_fields->>merchant.ilike.%${query}%`
    );
  }
  documentsQuery = documentsQuery.order("created_at", { ascending: false }).limit(50);

  const evidenceQueryBuilder = shouldQueryEvidence
    ? (() => {
        let evidenceQuery = supabase
          .from("ai_evidence")
          .select(
            "id, document_type, document_number, supplier, customer, material, spz, document_date, created_at"
          );
        if (aiEvidenceTypeLabel) {
          evidenceQuery = evidenceQuery.eq("document_type", aiEvidenceTypeLabel);
        }
        if (query) {
          evidenceQuery = evidenceQuery.or(
            `document_number.ilike.%${query}%,supplier.ilike.%${query}%,customer.ilike.%${query}%,material.ilike.%${query}%,spz.ilike.%${query}%`
          );
        }
        if (dateFrom) evidenceQuery = evidenceQuery.gte("document_date", dateFrom);
        if (dateTo) evidenceQuery = evidenceQuery.lte("document_date", dateTo);
        return evidenceQuery.order("created_at", { ascending: false }).limit(50);
      })()
    : null;

  const [documentsResult, evidenceResult] = await Promise.all([
    documentsQuery,
    evidenceQueryBuilder ?? Promise.resolve({ data: [], error: null }),
  ]);

  if (documentsResult.error) {
    console.error("handleSearchDocuments (documents) zlyhalo:", documentsResult.error.message);
  }
  if (evidenceResult.error) {
    console.error("handleSearchDocuments (ai_evidence) zlyhalo:", evidenceResult.error.message);
  }

  const documentsRaw =
    (documentsResult.data as
      | {
          id: string;
          document_type: string;
          original_filename: string | null;
          note: string | null;
          extracted_fields: Record<string, unknown> | null;
          created_at: string;
          archived_from_inbox_at: string | null;
          document_links: { vehicle_id: string | null }[] | null;
        }[]
      | null) || [];
  const evidence = evidenceResult.data || [];

  // Dátum/suma nemajú vlastný DB stĺpec pre `documents` (sú v
  // extracted_fields, ktorého tvar sa líši podľa typu) — filtrujú sa preto
  // rovnakým "fetch small scoped set → filter v appke" vzorom, aký už
  // appka používa pre ŠPZ (lib/entity-search.ts) aj dátum priradeného
  // dokumentu (lib/vehicle-documents.ts#readExtractedDate).
  const documents = documentsRaw.filter((doc) => {
    if (!matchesDateRange(readExtractedDate(doc.extracted_fields), dateFrom, dateTo)) return false;
    if (amount !== undefined && !amountMatches(doc.extracted_fields, amount)) return false;
    return true;
  });

  if (documents.length === 0 && evidence.length === 0) {
    return notFound(locale, "search.errors.documentsNotFound", describeSearchForNotFound(locale, filters));
  }

  const items: EntityRef[] = [
    ...documents.map((doc) => {
      const linkedVehicleId = doc.document_links?.[0]?.vehicle_id ?? null;
      return {
        type: "document" as const,
        id: doc.id,
        label: doc.original_filename || doc.document_type,
        href: generalDocumentDetailHref(
          linkedVehicleId,
          doc.id,
          Boolean(doc.archived_from_inbox_at)
        ),
      };
    }),
    ...evidence.map((row) => ({
      type: "document" as const,
      id: row.id,
      label: row.document_number || row.document_type || row.id,
      href: evidenceDetailHref(row.id),
    })),
  ];

  return { kind: "list", title: translate(locale, "search.results.documentsTitle"), items };
}

// -----------------------------------------------------------------------------
// Deadline dotazy ("čo mi končí tento mesiac", "aké termíny treba riešiť")
// -----------------------------------------------------------------------------

export async function handleUpcomingDeadlines(
  supabase: SupabaseClient,
  locale: Locale,
  withinDays: number | undefined,
  onlyOverdue: boolean | undefined
): Promise<IntentResult> {
  const [vehiclesResult, machinesResult, vignettesResult, vehicleServicesResult, machineServicesResult] =
    await Promise.all([
      supabase.from("vehicles").select("id, spz, vin, znacka, model, stk, ek"),
      supabase.from("machines").select("id, name, category"),
      supabase.from("vehicle_vignettes").select("*"),
      supabase
        .from("vehicle_services")
        .select("vehicle_id, service_date, next_service_date"),
      supabase
        .from("machine_services")
        .select("machine_id, service_date, next_service_date"),
    ]);

  for (const [label, result] of [
    ["vehicles", vehiclesResult],
    ["machines", machinesResult],
    ["vignettes", vignettesResult],
    ["vehicle_services", vehicleServicesResult],
    ["machine_services", machineServicesResult],
  ] as const) {
    if (result.error) {
      console.error(`handleUpcomingDeadlines: ${label} zlyhalo:`, result.error.message);
    }
  }

  const vehicleDeadlines = buildVehicleDeadlines(
    vehiclesResult.data || [],
    (vignettesResult.data as VehicleVignette[]) || [],
    (vehicleServicesResult.data as MinimalServiceRecord[]) || [],
    locale
  );
  const machineDeadlines = buildMachineDeadlines(
    machinesResult.data || [],
    (machineServicesResult.data as MinimalServiceRecord[]) || []
  );

  const window = withinDays ?? DEADLINE_THRESHOLD_DAYS.dueSoon;
  const all = [...vehicleDeadlines, ...machineDeadlines].filter((item) => {
    if (onlyOverdue) return item.severity === "overdue";
    return item.severity === "overdue" || item.daysRemaining <= window;
  });

  all.sort((a, b) => a.daysRemaining - b.daysRemaining);

  return {
    kind: "deadline_list",
    title: translate(locale, "search.results.deadlinesTitle"),
    items: all.map((item) => ({
      entity: {
        type: item.entityType,
        id: item.entityId,
        label: item.entityLabel,
        href: item.targetRoute,
      },
      typeLabel: deadlineTypeLabel(item.deadlineType, locale, item.vignetteCountryCode),
      severityLabel: deadlineSeverityLabel(item.severity, locale),
      dueDateLabel: formatDate(item.dueDate, locale),
    })),
  };
}

// -----------------------------------------------------------------------------
// Centrálny dispatcher — VOLA sa VÝHRADNE z app/api/assistant/intent/route.ts
// po overení, že `intent.name` je registrovaný a readOnly (registry.ts).
// -----------------------------------------------------------------------------

export async function executeIntent(
  supabase: SupabaseClient,
  locale: Locale,
  intent: ParsedIntent
): Promise<IntentResult> {
  switch (intent.name) {
    case "OPEN_VEHICLE":
      return handleOpenOrSearchVehicle(supabase, locale, intent.args.query, false);
    case "SEARCH_VEHICLE":
      return handleOpenOrSearchVehicle(supabase, locale, intent.args.query, true);
    case "SHOW_VEHICLE_DOCUMENTS":
      return handleShowVehicleDocuments(
        supabase,
        locale,
        intent.args.query,
        intent.args.documentType,
        intent.args.dateFrom,
        intent.args.dateTo
      );
    case "SHOW_VEHICLE_SERVICE":
      return handleShowVehicleService(supabase, locale, intent.args.query);
    case "VEHICLE_STK_STATUS":
      return handleVehicleStkStatus(supabase, locale, intent.args.query);
    case "VEHICLE_EK_STATUS":
      return handleVehicleEkStatus(supabase, locale, intent.args.query);
    case "VEHICLE_VIGNETTE_STATUS":
      return handleVehicleVignetteStatus(supabase, locale, intent.args.query);
    case "VEHICLE_COST_SUMMARY":
      return handleVehicleCostSummary(supabase, locale, intent.args.query, intent.args.year);
    case "VEHICLE_REPORT":
      return handleVehicleReport(supabase, locale, intent.args.query);
    case "OPEN_MACHINE":
      return handleOpenOrSearchMachine(supabase, locale, intent.args.query, false);
    case "SEARCH_MACHINE":
      return handleOpenOrSearchMachine(supabase, locale, intent.args.query, true);
    case "SHOW_MACHINE_SERVICE":
      return handleShowMachineService(supabase, locale, intent.args.query);
    case "MACHINE_REPORT":
      return handleMachineReport(supabase, locale, intent.args.query);
    case "OPEN_INVENTORY_ITEM":
      return handleOpenOrSearchInventoryItem(supabase, locale, intent.args.query, false);
    case "SEARCH_INVENTORY_ITEM":
      return handleOpenOrSearchInventoryItem(supabase, locale, intent.args.query, true);
    case "SEARCH_DOCUMENTS":
      return handleSearchDocuments(supabase, locale, {
        query: intent.args.query,
        documentType: intent.args.documentType,
        dateFrom: intent.args.dateFrom,
        dateTo: intent.args.dateTo,
        amount: intent.args.amount,
      });
    case "UPCOMING_DEADLINES":
      return handleUpcomingDeadlines(
        supabase,
        locale,
        intent.args.withinDays,
        intent.args.onlyOverdue
      );
    default:
      // Nedosiahnuteľné, ak registry.ts a types.ts zostanú v súlade — pozri
      // isRegisteredReadOnlyIntent() kontrolu v route.ts, ktorá beží PRED
      // touto funkciou. Ponechané ako defenzívny fail-closed fallback.
      return { kind: "error", text: translate(locale, "search.errors.generic") };
  }
}
