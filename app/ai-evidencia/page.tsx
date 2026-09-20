"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { openExternalUrl, downloadBlob } from "@/lib/file-actions";
import PlanLimitNotice from "@/app/components/PlanLimitNotice";
import { usePlanUsage } from "@/hooks/use-plan-usage";
import {
  isPlanLimitReachedError,
} from "@/lib/plan-limits";
import BackLink from "@/app/components/BackLink";
import InboxDocumentIcon from "@/app/components/icons/InboxDocumentIcon";
import { compressImage, normalizeRotation } from "@/lib/image-compress";
import {
  exportAiEvidenceToExcel,
  normalizeMovementType,
  type AiEvidenceExcelRecord,
} from "@/lib/export-ai-evidence-excel";
import {
  exportAiInboxFolderToExcel,
  type AiInboxFolderKind,
} from "@/lib/export-ai-inbox-documents-excel";
import { normalizeSpz } from "@/lib/normalize-spz";
import { formatDate, formatDateTime } from "@/lib/i18n/format";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import {
  getMyActiveMembership,
  hasFinanceManage,
  isOwnerOrAdmin,
  type CompanyMemberRole,
} from "@/lib/company";
import ReceivedInvoiceReview from "@/app/ai-evidencia/ReceivedInvoiceReview";
import {
  receivedCandidateFromScan,
  type ReceivedInvoiceCandidate,
} from "@/lib/invoicing/received-candidate";
import { computeFileSha256 } from "@/lib/invoicing/received-dedupe";
import { invoiceDetailHref } from "@/lib/entity-links";
import { useCompanyDpaLegalHold } from "@/app/components/CompanyDpaGate";
import { normalizeWeightUnit } from "@/lib/normalize-weight-unit";
import {
  convertWeightToTons,
  getEffectiveNetto,
  normalizeAndValidateWeights,
  parseWeightValue,
} from "@/lib/weight-utils";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  listCompanyCustomCategories,
  type CustomDocumentCategory,
} from "@/lib/custom-document-categories";

type ScanDocumentType =
  | "weigh_ticket"
  | "delivery_note"
  | "invoice"
  | "receipt"
  | "insurance"
  | "service_document"
  | "vehicle_registration"
  | "other";

function getDocumentTypeLabels(
  t: (key: string, vars?: Record<string, string | number>) => string
): Record<ScanDocumentType, string> {
  return {
    weigh_ticket: t("inbox.documentTypes.weigh_ticket"),
    delivery_note: t("inbox.documentTypes.delivery_note"),
    invoice: t("inbox.documentTypes.invoice"),
    receipt: t("inbox.documentTypes.receipt"),
    insurance: t("inbox.documentTypes.insurance"),
    service_document: t("inbox.documentTypes.service_document"),
    vehicle_registration: t("inbox.documentTypes.vehicle_registration"),
    other: t("inbox.documentTypes.other"),
  };
}

// Typy dokumentov, ktoré sa ukladajú cez documents/document_links (druhý,
// všeobecný AI Inbox model — pozri saveOtherDocument nižšie), s ručným
// priradením k vozidlu/stroju. Vážny lístok a dodací list majú vlastný,
// nezávislý flow (ai_evidence, automatické priradenie podľa ŠPZ).
type OtherDocumentType = Exclude<
  ScanDocumentType,
  "weigh_ticket" | "delivery_note"
>;

// Riadok public.documents (s embedovaným public.document_links) tak, ako ho
// vracia .select("*, document_links(*)") — pozri loadOtherDocuments nižšie.
type OtherDocumentRow = {
  id: string;
  document_type: string | null;
  status: string | null;
  created_at: string | null;
  extracted_fields: Record<string, unknown> | null;
  storage_bucket: string | null;
  storage_path: string | null;
  original_filename: string | null;
  note: string | null;
  document_links?: { vehicle_id: string | null; machine_id: string | null }[];
  // Voliteľné priradenie k firemnej vlastnej kategórii (Intent Engine
  // ASSIGN_DOCUMENTS_TO_CATEGORY, pozri lib/intents/actions.ts). Stĺpec
  // v DB existuje už od 20260914120000_add_custom_document_categories a
  // `.select("*", ...)` nižšie ho teda vždy vracal — chýbal iba tu v type
  // definícii aj v samotnom UI (pozri custom category sekciu nižšie).
  custom_category_id: string | null;
};

// Riadok public.document_attachments — jednoduché prílohy k dokumentu
// (dnes iba PZP/insurance detail, pozri sekciu "Prílohy" nižšie).
type AttachmentRow = {
  id: string;
  document_id: string;
  storage_bucket: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string | null;
  attachment_type: string;
  created_at: string | null;
};

function getAttachmentTypeLabels(
  t: (key: string, vars?: Record<string, string | number>) => string
): Record<string, string> {
  return {
    white_card: t("inbox.attachmentTypes.white_card"),
    green_card: t("inbox.attachmentTypes.green_card"),
    insurance_event: t("inbox.attachmentTypes.insurance_event"),
    other: t("inbox.attachmentTypes.other"),
  };
}

// Dokumenty typu receipt/invoice bez priradenia k vozidlu/stroju sa v zozname
// zobrazujú zoskupené do zložiek "Bločky"/"Faktúry" (pozri bod 4 zadania),
// nie samostatne v plochom zozname "Ostatné dokumenty" — aby sa rovnaký
// dokument nikdy nezobrazil na dvoch miestach naraz.
function isDocumentAssigned(doc: OtherDocumentRow): boolean {
  const link = Array.isArray(doc?.document_links) ? doc.document_links[0] : null;
  return Boolean(link && (link.vehicle_id || link.machine_id));
}

// Rovnaký princíp ako isDocumentAssigned() vyššie, ale pre priradenie k
// firemnej vlastnej kategórii (custom_document_categories) namiesto
// vozidla/stroja — dokument priradený do vlastnej zložky má odteraz SVOJ
// vlastný "domov" (tú zložku, pozri sekciu "Vlastné zložky" nižšie), takže
// sa už nezobrazuje ani v nepriradených Bločky/Faktúry zložkách, ani v
// plochom zozname "Ostatné dokumenty" — presne rovnaké pravidlo "nikdy
// nezobrazený na dvoch miestach naraz" ako pri vozidle/stroji.
function hasCustomCategoryAssignment(doc: OtherDocumentRow): boolean {
  return Boolean(doc.custom_category_id);
}

// SK popisky polí pre zobrazenie/editáciu v UI aj pre detail uloženého
// dokumentu (documents.extracted_fields má rovnaký tvar ako tieto fields
// objekty z /api/scan-document, takže rovnaká mapa funguje pre obe miesta).
function getReviewOnlyFieldLabels(
  t: (key: string, vars?: Record<string, string | number>) => string
): Record<OtherDocumentType, [string, string][]> {
  return {
    invoice: [
      ["supplier", t("inbox.fields.supplier")],
      ["customer", t("inbox.fields.customer")],
      ["invoiceNumber", t("inbox.fields.invoiceNumber")],
      ["issueDate", t("inbox.fields.issueDate")],
      ["dueDate", t("inbox.fields.dueDate")],
      ["totalAmount", t("inbox.fields.totalAmount")],
      ["vatAmount", t("inbox.fields.vatAmount")],
      ["currency", t("inbox.fields.currency")],
      ["variableSymbol", t("inbox.fields.variableSymbol")],
      ["description", t("inbox.fields.description")],
    ],
    receipt: [
      ["merchant", t("inbox.fields.merchant")],
      ["purchaseDate", t("inbox.fields.purchaseDate")],
      ["totalAmount", t("inbox.fields.totalAmount")],
      ["currency", t("inbox.fields.currency")],
      ["paymentMethod", t("inbox.fields.paymentMethod")],
      ["category", t("inbox.fields.category")],
    ],
    insurance: [
      ["provider", t("inbox.fields.provider")],
      ["policyNumber", t("inbox.fields.policyNumber")],
      ["insuranceType", t("inbox.fields.insuranceType")],
      ["vehicleIdentifier", t("inbox.fields.vehicleIdentifier")],
      ["vin", t("inbox.fields.vin")],
      ["validFrom", t("inbox.fields.validFrom")],
      ["validTo", t("inbox.fields.validTo")],
      ["premiumAmount", t("inbox.fields.premiumAmount")],
      ["currency", t("inbox.fields.currency")],
    ],
    service_document: [
      ["provider", t("inbox.fields.serviceProvider")],
      ["serviceDate", t("inbox.fields.serviceDate")],
      ["vehicleOrMachineIdentifier", t("inbox.fields.vehicleOrMachineIdentifier")],
      ["description", t("inbox.fields.description")],
      ["cost", t("inbox.fields.cost")],
      ["currency", t("inbox.fields.currency")],
      ["nextServiceDate", t("inbox.fields.nextServiceDate")],
    ],
    vehicle_registration: [
      ["spz", t("inbox.fields.spz")],
      ["vin", t("inbox.fields.vin")],
      ["znacka", t("inbox.fields.znacka")],
      ["model", t("inbox.fields.model")],
      ["rokVyroby", t("inbox.fields.rokVyroby")],
      ["farba", t("inbox.fields.farba")],
      ["cisloTechnickehoPreukazu", t("inbox.fields.cisloTechnickehoPreukazu")],
    ],
    other: [["summary", t("inbox.fields.summary")]],
  };
}

function describeScanError(
  t: (key: string, vars?: Record<string, string | number>) => string,
  status: number,
  data: any
): string {
  const serverMessage =
    (data && typeof data.message === "string" && data.message) ||
    (data &&
      typeof data.error === "string" &&
      data.error !== "AI_INCONSISTENT_OUTPUT" &&
      data.error) ||
    null;

  if (serverMessage) return serverMessage;

  switch (status) {
    case 401:
      return t("inbox.errors.sessionExpired");
    case 400:
    case 415:
      return t("inbox.errors.unsupportedFile");
    case 413:
      return t("inbox.errors.fileTooLarge");
    case 422:
      return t("inbox.errors.aiInconsistent");
    case 500:
      return t("inbox.errors.aiFailed");
    default:
      return t("inbox.errors.unknown");
  }
}

// Sploští weighTicketFields/deliveryNoteFields z nového /api/scan-document
// do rovnakého plochého tvaru, aký doteraz vracal /api/scan-vehicle-doc.
// Vďaka tomu saveEvidence() nižšie zostáva úplne nezmenená a naďalej
// zapisuje do ai_evidence presne tak, ako predtým.
function buildFlatWeighTicketResult(
  documentType: "weigh_ticket" | "delivery_note",
  fields: Record<string, any>,
  common: {
    rawText: string | null;
    confidenceScore: number | null;
    reviewStatus: string | null;
    documentLanguage: string | null;
  },
  documentTypeLabel: string
) {
  return {
    documentType: documentTypeLabel,
    movementType: fields.movementType ?? null,
    spz: fields.spz ?? null,
    supplier: fields.supplier ?? null,
    customer: fields.customer ?? null,
    constructionSite: fields.constructionSite ?? null,
    documentNumber: fields.documentNumber ?? null,
    material: fields.material ?? null,
    materialOriginal: fields.materialOriginal ?? null,
    materialCategory: fields.materialCategory ?? null,
    documentLanguage: common.documentLanguage,
    confidenceScore: common.confidenceScore,
    sourceLocation: fields.sourceLocation ?? null,
    destinationLocation: fields.destinationLocation ?? null,
    reviewStatus: common.reviewStatus === "needs_review" ? "needs_review" : "confirmed",
    quantity: fields.quantity ?? null,
    unit: fields.unit ?? null,
    brutto: fields.brutto ?? null,
    tara: fields.tara ?? null,
    netto: fields.netto ?? null,
    documentDate: fields.documentDate ?? null,
    documentTime: fields.documentTime ?? null,
    rawText: common.rawText,
  };
}

// -----------------------------------------------------------------------------
// Priraďovanie k vozidlu/stroju — zdieľané dopyty nad vlastnými záznamami
// prihláseného používateľa (user_id filter drží RLS izoláciu).
//
// resolveVehicleIdBySpz sa používa pre vážny lístok/dodací list: priradenie
// je čisto automatické podľa ŠPZ rozpoznanej AI, nikdy nezlyhá a nikdy
// neblokuje uloženie dokumentu — ak vozidlo s danou ŠPZ v module Vozidlá
// neexistuje (alebo dopyt zlyhá), vráti vehicleId: null a dokument sa aj tak
// uloží, iba bez väzby na konkrétne vozidlo.
//
// resolveMachineIdByLabel je pripravená pre budúce doplnenie ukladania
// ostatných typov dokumentov (faktúra, bloček, servisný doklad, PZP a
// pod.) s ručným priradením k vozidlu/stroju — dnes ju nikde nevoláme,
// keďže ukladanie týchto typov ešte nie je implementované.
// -----------------------------------------------------------------------------

async function resolveVehicleIdBySpz(
  companyId: string,
  spz: unknown
): Promise<{ vehicleId: string | null; canonicalSpz: string | null }> {
  const normalizedSpz = normalizeSpz(spz);

  if (!normalizedSpz) {
    return { vehicleId: null, canonicalSpz: null };
  }

  const { data: vehicles, error: vehiclesError } = await supabase
    .from("vehicles")
    .select("id, spz")
    .eq("company_id", companyId);

  if (vehiclesError) {
    console.error("Chyba pri načítaní vozidiel:", vehiclesError);
    return { vehicleId: null, canonicalSpz: normalizedSpz };
  }

  const matchedVehicle = vehicles?.find(
    (vehicle) => normalizeSpz(vehicle.spz) === normalizedSpz
  );

  return {
    vehicleId: matchedVehicle?.id ?? null,
    canonicalSpz: normalizeSpz(matchedVehicle?.spz) ?? normalizedSpz,
  };
}

// Duplicitná kontrola pre technický preukaz vozidla (bod 2 zadania) — hľadá
// existujúce vozidlo firmy podľa VIN (spoľahlivejší, prakticky unikátny
// identifikátor) a až potom podľa ŠPZ. Nikdy nezlyhá s chybou — pri
// zlyhaní dopytu vráti null, aby AI-preview flow vždy ponúklo aspoň
// vytvorenie nového vozidla namiesto tvrdého zlyhania.
// Deterministické párovanie PZP → existujúce vozidlo firmy (bod 2 zadania).
// Poradie: 1) VIN (spoľahlivejší, prakticky unikátny identifikátor), 2) ŠPZ.
// Pracuje nad už načítaným vehicleOptions (žiadny ďalší DB dotaz) —
// vehicleOptions je vždy filtrovaný na aktívnu firmu volajúceho (RLS +
// company_id filter v loadVehicleAndMachineOptions), takže párovanie nikdy
// neopustí hranicu firmy.
//
// NIKDY nehádaj potichu: ak identifikátor zodpovedá VIACERÝM vozidlám naraz
// (ambiguous), nevracia sa žiadne vozidlo — iba príznak, že treba ručný
// výber. Ak nezodpovedá žiadnemu, tiež sa nič nepredvyberie (no-match) a
// UI nechá používateľa vybrať vozidlo ručne alebo flow zastaví.
function matchInsuranceVehicle(
  vin: unknown,
  vehicleIdentifier: unknown,
  vehicleOptions: { id: string; spz: string | null; vin: string | null }[]
): {
  vehicleId: string | null;
  ambiguous: boolean;
  matchedBy: "vin" | "spz" | null;
} {
  const trimmedVin =
    typeof vin === "string" && vin.trim().length > 0
      ? vin.trim().toUpperCase()
      : "";

  if (trimmedVin) {
    const vinMatches = vehicleOptions.filter(
      (vehicle) =>
        typeof vehicle.vin === "string" &&
        vehicle.vin.trim().toUpperCase() === trimmedVin
    );

    if (vinMatches.length === 1) {
      return { vehicleId: vinMatches[0].id, ambiguous: false, matchedBy: "vin" };
    }

    if (vinMatches.length > 1) {
      return { vehicleId: null, ambiguous: true, matchedBy: null };
    }

    // 0 zhôd na VIN — pokračuj na ŠPZ, VIN v dokumente mohol byť
    // nesprávne prečítaný alebo vozidlo v evidencii nemá VIN vyplnené.
  }

  const normalizedSpz = normalizeSpz(vehicleIdentifier);

  if (!normalizedSpz) {
    return { vehicleId: null, ambiguous: false, matchedBy: null };
  }

  const spzMatches = vehicleOptions.filter(
    (vehicle) => normalizeSpz(vehicle.spz) === normalizedSpz
  );

  if (spzMatches.length === 1) {
    return { vehicleId: spzMatches[0].id, ambiguous: false, matchedBy: "spz" };
  }

  if (spzMatches.length > 1) {
    return { vehicleId: null, ambiguous: true, matchedBy: null };
  }

  return { vehicleId: null, ambiguous: false, matchedBy: null };
}

function normalizeMachineLabel(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// Zámerne zatiaľ nikde nevolaná — pripravená pre budúce doplnenie ukladania
// ostatných typov dokumentov (pozri komentár vyššie pri
// resolveVehicleIdBySpz). Potlačené lint upozornenie na nepoužitú funkciu,
// kým sa táto funkcia nezapojí do reálneho save flow.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function resolveMachineIdByLabel(
  companyId: string,
  label: string
): Promise<{ machineId: string | null; machineLabel: string | null }> {
  const trimmedLabel = label.trim();

  if (!trimmedLabel) {
    return { machineId: null, machineLabel: null };
  }

  const { data: machines, error: machinesError } = await supabase
    .from("machines")
    .select("id, name")
    .eq("company_id", companyId);

  if (machinesError) {
    console.error("Chyba pri načítaní strojov:", machinesError);
    return { machineId: null, machineLabel: null };
  }

  const normalizedLabel = normalizeMachineLabel(trimmedLabel);
  const matchedMachine = machines?.find(
    (machine) => normalizeMachineLabel(machine.name) === normalizedLabel
  );

  return {
    machineId: matchedMachine?.id ?? null,
    machineLabel: matchedMachine?.name ?? null,
  };
}

function getSpzGroupKey(value: unknown, withoutSpzLabel: string): string {
  if (value === withoutSpzLabel) return withoutSpzLabel;
  return normalizeSpz(value) || withoutSpzLabel;
}

function formatRecordWeight(
  record: Pick<AiEvidenceExcelRecord, "netto" | "quantity" | "unit">,
  t: (key: string, vars?: Record<string, string | number>) => string
): string {
  const hasNetto =
    record.netto !== null &&
    record.netto !== undefined &&
    record.netto !== "";
  const value = hasNetto ? record.netto : record.quantity;

  if (value === null || value === undefined || value === "") {
    return t("inbox.noWeight");
  }

  const unit = normalizeWeightUnit(record.unit);
  return unit ? `${value} ${unit}` : `${value} ${t("inbox.withoutUnit")}`;
}

type EvidenceSummary = {
  // Po\u010det dokladov v tejto \u0160PZ skupine \u2014 NEZ\u00c1VIS\u00cd od toho, \u010di je
  // movement_type ur\u010den\u00fd. Ka\u017ed\u00fd doklad so spr\u00e1vnou \u0160PZ sa po\u010d\u00edta pr\u00e1ve raz
  // (bod 3 zadania: doklady bez Dovoz/V\u00fdvoz sa nesm\u00fa strati\u0165 zo s\u00fahrnu).
  documentsCount: number;
  totalImport: number;
  totalExport: number;
  // S\u00fa\u010det ton dokladov, kde movement_type nie je spo\u013eahlivo ur\u010den\u00fd (null
  // alebo hodnota, ktor\u00fa normalizeMovementType nevie priradi\u0165 k
  // dovozu/v\u00fdvozu) \u2014 nikdy sa nezapo\u010d\u00edta do totalImport/totalExport.
  totalUnknown: number;
  importCount: number;
  exportCount: number;
  unknownCount: number;
  importByMaterial: Record<string, number>;
  exportByMaterial: Record<string, number>;
  unknownByMaterial: Record<string, number>;
};

function createEmptySummary(): EvidenceSummary {
  return {
    documentsCount: 0,
    totalImport: 0,
    totalExport: 0,
    totalUnknown: 0,
    importCount: 0,
    exportCount: 0,
    unknownCount: 0,
    importByMaterial: {},
    exportByMaterial: {},
    unknownByMaterial: {},
  };
}

// Bugfix (Preh\u013ead pod\u013ea \u0160PZ ukazoval "0 dokladov" pre doklady bez ur\u010den\u00e9ho
// Dovoz/V\u00fdvoz): documentsCount sa po\u010d\u00edta pre KA\u017dD\u00dd doklad v tejto \u0160PZ
// skupine, \u00faplne nez\u00e1visle od movement_type \u2014 predt\u00fdm sa v UI zobrazoval
// s\u00fa\u010det importCount + exportCount, tak\u017ee doklad s movement_type = null
// (napr. v\u00e1\u017eny l\u00edstok, kde AI smer pohybu spo\u013eahlivo nezistila) sa
// nezapo\u010d\u00edtal v\u00f4bec nikam a p\u00f4sobil, akoby vo vozidle neexistoval \u017eiadny
// doklad. Smer pohybu (dovoz/v\u00fdvoz/neur\u010den\u00e9) sa na\u010falej rie\u0161i oddelene a
// ovplyv\u0148uje iba Dovoz/V\u00fdvoz/Neur\u010den\u00e9 ton\u00e1\u017e, nikdy documentsCount.
//
// normalizeMovementType (lib/export-ai-evidence-excel.ts) sa reuse-uje
// namiesto vlastnej normaliz\u00e1cie priamo tu \u2014 predt\u00fdm t\u00e1to funkcia
// rozpozn\u00e1vala iba presne "dovoz"/"vyvoz" po odstr\u00e1nen\u00ed diakritiky, zatia\u013e
// \u010do Excel export u\u017e uzn\u00e1val aj synonym\u00e1 (import/export/prijem/odvoz).
// T\u00e1to nekonzistencia by mohla sp\u00f4sobi\u0165 rovnak\u00fd "0 dokladov" jav aj pri
// movement_type, ktor\u00fd JE ur\u010den\u00fd, len in\u00fdm slovom \u2014 teraz maj\u00fa UI aj
// export presne rovnak\u00fa defin\u00edciu "ur\u010den\u00e9ho" smeru.
function addRecordToSummary(
  summary: EvidenceSummary,
  record: AiEvidenceExcelRecord,
  otherMaterialLabel: string
) {
  summary.documentsCount += 1;

  const direction = normalizeMovementType(record.movement_type);
  const category =
    record.material_category ||
    record.material_original ||
    record.material ||
    otherMaterialLabel;
  const weightInTons = convertWeightToTons(
    getEffectiveNetto(record),
    record.unit
  );

  if (direction === "import") {
    summary.importCount += 1;
    if (weightInTons !== null) {
      summary.totalImport += weightInTons;
      summary.importByMaterial[category] =
        (summary.importByMaterial[category] || 0) + weightInTons;
    }
    return;
  }

  if (direction === "export") {
    summary.exportCount += 1;
    if (weightInTons !== null) {
      summary.totalExport += weightInTons;
      summary.exportByMaterial[category] =
        (summary.exportByMaterial[category] || 0) + weightInTons;
    }
    return;
  }

  // movement_type nie je spo\u013eahlivo ur\u010den\u00fd \u2014 doklad sa napriek tomu mus\u00ed
  // zobrazi\u0165 v s\u00fahrne (documentsCount vy\u0161\u0161ie), iba sa nezapo\u010d\u00edta do
  // Dovoz/V\u00fdvoz s\u00fa\u010dtu. Nikdy neh\u00e1dame smer namiesto AI/pou\u017e\u00edvate\u013ea.
  summary.unknownCount += 1;
  if (weightInTons !== null) {
    summary.totalUnknown += weightInTons;
    summary.unknownByMaterial[category] =
      (summary.unknownByMaterial[category] || 0) + weightInTons;
  }
}

function Info({ title, value }: { title: string; value: any }) {
  return (
    <div className="rounded-2xl bg-surface-2 p-4">
      <p className="text-xs text-muted-esblu">{title}</p>
      <p className="mt-1 font-bold text-primary">{value || "-"}</p>
    </div>
  );
}
// -----------------------------------------------------------------------------
// Otvorenie KONKRÉTNEHO dokumentu cez ?openDocument=<documents.id> alebo
// ?openEvidence=<ai_evidence.id> (Intent Engine "ukáž dokumenty vozidla..."
// výsledky, lib/vehicle-documents.ts) — automatizuje presne ten istý klik,
// aký by používateľ urobil ručne v existujúcom zozname nižšie (žiadny nový
// viewer, žiadna nová bezpečnostná logika). Next.js vyžaduje, aby
// useSearchParams() bol obalený v <Suspense> (inak mobile static export
// build zlyhá — rovnaký, už zavedený vzor ako
// mobile/app/vozidla/detail/page.tsx) — vyčlenené do malej samostatnej
// komponenty, aby Suspense fallback nezablokoval vykreslenie CELEJ (veľkej)
// Inbox stránky.
// -----------------------------------------------------------------------------
function OpenFromQueryParam({
  onOpenDocument,
  onOpenEvidence,
}: {
  onOpenDocument: (id: string) => void;
  onOpenEvidence: (id: string) => void;
}) {
  const searchParams = useSearchParams();

  useEffect(() => {
    const openDocument = searchParams.get("openDocument");
    const openEvidence = searchParams.get("openEvidence");
    if (openDocument) onOpenDocument(openDocument);
    if (openEvidence) onOpenEvidence(openEvidence);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return null;
}

export default function AiEvidenciaPage() {
  const { locale, t, tCount } = useLocale();
  const documentTypeLabels = getDocumentTypeLabels(t);
  const attachmentTypeLabels = getAttachmentTypeLabels(t);
  const reviewOnlyFieldLabels = getReviewOnlyFieldLabels(t);
  const withoutSpzLabel = t("inbox.withoutSpzGroup");
  const otherMaterialLabel = t("inbox.otherMaterial");
  const [companyId, setCompanyId] = useState("");
  const [role, setRole] = useState<CompanyMemberRole | null>(null);
  // Prijatá faktúra je finance dáta — ponuka "Vytvoriť prijatú faktúru" sa
  // zobrazí iba držiteľovi finance.manage. Skutočné vynútenie je v RLS a v
  // esblu_create_received_invoice_draft(); toto je len UI vrstva.
  const [canManageFinance, setCanManageFinance] = useState(false);
  const [fileName, setFileName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [records, setRecords] = useState<AiEvidenceExcelRecord[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [documentPhotoUrl, setDocumentPhotoUrl] =
  useState<string | null>(null);
  const [otherDocumentPhotoUrl, setOtherDocumentPhotoUrl] =
    useState<string | null>(null);
  const [selectedSpz, setSelectedSpz] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [scanDocumentType, setScanDocumentType] =
    useState<ScanDocumentType | null>(null);
  const [otherResult, setOtherResult] = useState<{
    fields: Record<string, any>;
    reviewStatus: string | null;
    confidenceScore: number | null;
    rawText: string | null;
    documentLanguage: string | null;
    fieldConfidence: { field: string; confidence: number }[];
  } | null>(null);
  const [assignmentTarget, setAssignmentTarget] = useState<
    "vehicle" | "machine" | "none" | null
  >(null);
  // Výber z existujúcich vozidiel/strojov (dropdown, nie voľný text) —
  // používateľ nemusí ručne prepisovať identifikátor entity, ktorá už v
  // databáze existuje.
  const [selectedVehicleId, setSelectedVehicleId] = useState("");
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const [vehicleOptions, setVehicleOptions] = useState<
    { id: string; spz: string | null; vin: string | null }[]
  >([]);
  // PZP auto-matching (bod 2 zadania — VIN → ŠPZ, bez tichého hádania):
  // true, keď identifikátor z PZP zodpovedá VIACERÝM vozidlám firmy naraz.
  // V tom prípade sa NIKDY nepredvyberie žiadne vozidlo — používateľ musí
  // vybrať ručne (rovnaký princíp ako findDuplicateVehicle pri technickom
  // preukaze, len s explicitným rozlíšením "no match" vs. "ambiguous").
  const [insuranceMatchAmbiguous, setInsuranceMatchAmbiguous] =
    useState(false);
  const [machineOptions, setMachineOptions] = useState<
    { id: string; name: string | null }[]
  >([]);
  const [isSavingOtherDocument, setIsSavingOtherDocument] = useState(false);
  // Prijatá faktúra: kandidát otvorený v review obrazovke. Nenulový = modal
  // je otvorený. Dokument je v tom momente už uložený (potrebujeme jeho id
  // ako source_document_id), canonical faktúra ešte nie.
  const [receivedCandidate, setReceivedCandidate] =
    useState<ReceivedInvoiceCandidate | null>(null);
  /** Nastaví sa spolu s kandidátom — review potrebuje autora pre created_by. */
  const [currentUserId, setCurrentUserId] = useState("");
  const [isPreparingReceivedInvoice, setIsPreparingReceivedInvoice] = useState(false);
  const [createdReceivedInvoiceId, setCreatedReceivedInvoiceId] = useState<string | null>(
    null
  );
  const [otherDocuments, setOtherDocuments] = useState<OtherDocumentRow[]>([]);
  const [selectedOtherDocument, setSelectedOtherDocument] =
    useState<OtherDocumentRow | null>(null);
  // ?openDocument=<id> / ?openEvidence=<id> — čaká na to, kým príslušný
  // zoznam dotiahne dáta (asynchrónne, pozri loadOtherDocuments/loadRecords
  // nižšie), potom automaticky otvorí TEN ISTÝ existujúci modal, aký by
  // otvoril ručný klik na riadok v zozname (pozri OpenFromQueryParam
  // vyššie).
  const [pendingOpenDocumentId, setPendingOpenDocumentId] = useState<string | null>(null);
  const [pendingOpenEvidenceId, setPendingOpenEvidenceId] = useState<string | null>(null);
  // Poznámka pri bločku/faktúre — voliteľné pole vyplnené pred uložením
  // (bod 2 zadania). Vážneho lístka/dodacieho listu sa netýka.
  const [documentNote, setDocumentNote] = useState("");
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(
    null
  );
  // Zložky "Bločky"/"Faktúry" pre nepriradené dokumenty (bod 4 zadania).
  const [openFolder, setOpenFolder] = useState<AiInboxFolderKind | null>(null);
  // Firemné vlastné kategórie (Intent Engine Action Engine) — samostatný
  // state od `openFolder`, keďže AiInboxFolderKind je pevný "receipt"|
  // "invoice" enum a vlastných kategórií môže byť ľubovoľne veľa/premenné
  // množstvo. `openCustomCategoryId`/`setOpenCustomCategoryId(null)` sa
  // navzájom vylučujú s `openFolder` (pozri handleOpenFolder/
  // handleOpenCustomCategory nižšie) — appka nikdy nezobrazuje oba naraz.
  const [customCategories, setCustomCategories] = useState<CustomDocumentCategory[]>([]);
  const [openCustomCategoryId, setOpenCustomCategoryId] = useState<string | null>(null);
  const [folderExportLoading, setFolderExportLoading] = useState(false);
  const [folderExportFeedback, setFolderExportFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  // Prílohy PZP dokumentu (bod 3 zadania) — načítané pre aktuálne otvorený
  // detail dokumentu typu insurance.
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [newAttachmentType, setNewAttachmentType] = useState("white_card");
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<
    string | null
  >(null);
  // POZN.: TP (technický preukaz) flow — stav, handlery aj JSX — bol
  // presunutý do app/vozidla/page.tsx (bod 2 zadania "UX reorganizácia
  // Inbox + Vozidlá + Chat"). Inbox od tejto zmeny spracúva výhradne bežné
  // firemné dokumenty (vážne lístky, dodacie listy, faktúry, bločky, PZP,
  // servisné doklady, ostatné) — žiadna "Technické preukazy" sekcia ani
  // CTA "pridať vozidlo z TP" tu už nie je.
  const saveOtherDocumentInProgressRef = useRef(false);
  const saveInProgressRef = useRef(false);
  const previewObjectUrlRef = useRef<string | null>(null);
  const {
    usage: planUsage,
    limit: planLimit,
    isLimited: isPlanLimited,
    loading: planUsageLoading,
    refresh: refreshPlanUsage,
  } = usePlanUsage("ai_evidence");
  const { legalHold } = useCompanyDpaLegalHold();
  // Legal-hold blokuje vytváranie NOVÝCH ai_evidence/documents/
  // document_attachments záznamov — presne tabuľky, ktoré chráni
  // esblu_require_company_dpa_before_insert
  // (20260816090000_add_company_dpa_acceptance.sql). Rovnaký vzor ako
  // plan-limit blokovanie o riadok nižšie.
  const isCreationBlocked = (!planUsageLoading && isPlanLimited) || legalHold;

const groupedRecords = records.reduce((groups: any, record: any) => {
  const spz = getSpzGroupKey(record.spz, withoutSpzLabel);

  if (!groups[spz]) {
    groups[spz] = [];
  }

  groups[spz].push(record);

  return groups;
}, {});
const visibleDocuments = records.filter((record) => {
  if (!selectedSpz) {
    return true;
  }

  const recordSpz = getSpzGroupKey(record.spz, withoutSpzLabel);
  return recordSpz === getSpzGroupKey(selectedSpz, withoutSpzLabel);
});
const summaryBySpz = records.reduce<Record<string, EvidenceSummary>>((groups, record) => {
  const spz = getSpzGroupKey(record.spz, withoutSpzLabel);

  if (!groups[spz]) {
    groups[spz] = createEmptySummary();
  }

  addRecordToSummary(groups[spz], record, otherMaterialLabel);

  return groups;
}, {});

// Zložky "Bločky"/"Faktúry" (bod 4/6 zadania) — iba dokumenty BEZ priradenia
// k vozidlu/stroju ANI k vlastnej kategórii. Priradené bločky/faktúry
// ostávajú v "Ostatné dokumenty" nižšie (so svojou väzbou viditeľnou);
// dokumenty priradené do vlastnej kategórie majú vlastnú zložku (pozri
// "Vlastné zložky" nižšie) — v oboch prípadoch nikdy nie duplicitne.
const unassignedReceipts = otherDocuments.filter(
  (doc) =>
    doc.document_type === "receipt" &&
    !isDocumentAssigned(doc) &&
    !hasCustomCategoryAssignment(doc)
);
const unassignedInvoices = otherDocuments.filter(
  (doc) =>
    doc.document_type === "invoice" &&
    !isDocumentAssigned(doc) &&
    !hasCustomCategoryAssignment(doc)
);
// PZP a technický preukaz potvrdené a priradené k vozidlu už vôbec nie sú
// súčasťou `otherDocuments` (loadOtherDocuments filtruje
// archived_from_inbox_at IS NULL priamo v dopyte — dátovo definovaný stav,
// pozri 20260820090000_add_documents_vehicle_archive.sql), takže tu už nie
// je čo dodatočne skrývať. Zvyšné klientské filtre: nepriradené bločky/
// faktúry sa zobrazujú iba v zložkách vyššie a dokumenty priradené do
// vlastnej kategórie iba v tej kategórii — nie duplicitne aj v plochom
// zozname.
const otherDocumentsFlatList = otherDocuments.filter((doc) => {
  if (hasCustomCategoryAssignment(doc)) {
    return false;
  }

  if (
    (doc.document_type === "receipt" || doc.document_type === "invoice") &&
    !isDocumentAssigned(doc)
  ) {
    return false;
  }

  return true;
});
const openFolderDocuments =
  openFolder === "receipt"
    ? unassignedReceipts
    : openFolder === "invoice"
      ? unassignedInvoices
      : [];

// "Vlastné zložky" (Intent Engine CREATE/RENAME/ASSIGN_DOCUMENTS_TO_CATEGORY,
// pozri lib/intents/actions.ts) — dokumenty zoskupené podľa
// documents.custom_category_id, rovnaký princíp ako openFolderDocuments
// vyššie, len nad `customCategories` namiesto pevného receipt/invoice páru.
const customCategoryDocumentCounts = new Map<string, number>();
for (const doc of otherDocuments) {
  if (doc.custom_category_id) {
    customCategoryDocumentCounts.set(
      doc.custom_category_id,
      (customCategoryDocumentCounts.get(doc.custom_category_id) || 0) + 1
    );
  }
}
const openCustomCategory = openCustomCategoryId
  ? customCategories.find((category) => category.id === openCustomCategoryId) ?? null
  : null;
const openCustomCategoryDocuments = openCustomCategoryId
  ? otherDocuments.filter((doc) => doc.custom_category_id === openCustomCategoryId)
  : [];

  function revokePreviewObjectUrl() {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
  }

  function prepareImagePreview(file: File) {
    revokePreviewObjectUrl();
    const objectUrl = URL.createObjectURL(file);
    previewObjectUrlRef.current = objectUrl;
    setPreviewUrl(objectUrl);
    setPendingImageFile(file);
    setRotation(0);
  }

  function clearImagePreview(clearFileName = true) {
    revokePreviewObjectUrl();
    setPreviewUrl(null);
    setPendingImageFile(null);
    setRotation(0);

    if (clearFileName) {
      setFileName("");
    }
  }

  async function handleExportExcel() {
    if (exportLoading) return;

    if (visibleDocuments.length === 0) {
      setExportFeedback({
        type: "error",
        text: t("inbox.errors.noDocumentsToExport"),
      });
      return;
    }

    setExportLoading(true);
    setExportFeedback(null);

    try {
      const { exportedCount, fileName } = await exportAiEvidenceToExcel(
        visibleDocuments,
        locale,
        t
      );

      setExportFeedback({
        type: "success",
        text: t("inbox.exportedRecordsMessage", { count: exportedCount, fileName }),
      });
    } catch (exportError: unknown) {
      console.error("Chyba pri exporte Excelu:", exportError);
      setExportFeedback({
        type: "error",
        text:
          exportError instanceof Error
            ? exportError.message
            : t("inbox.errors.excelGenerateFailed"),
      });
    } finally {
      setExportLoading(false);
    }
  }
  // openFolder ("receipt"/"invoice") a openCustomCategoryId sa navzájom
  // vylučujú — appka nikdy nezobrazuje oba naraz (pozri render sekciu
  // "Vlastné zložky"/"Zložky" nižšie, obe podmienené `!openFolder &&
  // !openCustomCategoryId`).
  function handleOpenFolder(kind: AiInboxFolderKind) {
    setOpenCustomCategoryId(null);
    setOpenFolder(kind);
  }
  function handleOpenCustomCategory(categoryId: string) {
    setOpenFolder(null);
    setOpenCustomCategoryId(categoryId);
  }
  function handleBackToFolders() {
    setOpenFolder(null);
    setOpenCustomCategoryId(null);
    setFolderExportFeedback(null);
  }
  async function handleExportFolder(kind: AiInboxFolderKind) {
    if (folderExportLoading) return;

    const folderRecords = kind === "receipt" ? unassignedReceipts : unassignedInvoices;

    if (folderRecords.length === 0) {
      setFolderExportFeedback({
        type: "error",
        text: t("inbox.errors.noDocumentsToExport"),
      });
      return;
    }

    setFolderExportLoading(true);
    setFolderExportFeedback(null);

    try {
      const { exportedCount, fileName } = await exportAiInboxFolderToExcel(
        kind,
        folderRecords,
        t
      );

      setFolderExportFeedback({
        type: "success",
        text: t("inbox.exportedRecordsMessage", { count: exportedCount, fileName }),
      });
    } catch (exportError: unknown) {
      console.error("Chyba pri exporte zložky:", exportError);
      setFolderExportFeedback({
        type: "error",
        text:
          exportError instanceof Error
            ? exportError.message
            : t("inbox.errors.exportFailed"),
      });
    } finally {
      setFolderExportLoading(false);
    }
  }

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    if (planUsageLoading || isCreationBlocked) {
      setError(
        planUsageLoading
          ? t("inbox.errors.planLimitChecking")
          : legalHold
            ? t("common.legalHoldMessage")
            : t("common.planLimitMessage")
      );
      return;
    }

    setFileName(file.name);
    setResult(null);
    setSelectedFile(null);
    setError("");
    prepareImagePreview(file);
  }

  async function processPendingDocument() {
    if (!pendingImageFile || isProcessing) return;

    if (planUsageLoading || isCreationBlocked) {
      setError(
        planUsageLoading
          ? t("inbox.errors.planLimitChecking")
          : legalHold
            ? t("common.legalHoldMessage")
            : t("common.planLimitMessage")
      );
      return;
    }

    setError("");
    setIsProcessing(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error(t("inbox.errors.aiProcessingLoginRequired"));
      }

      const compressedFile = await compressImage(pendingImageFile, rotation, t);
      const formData = new FormData();
      formData.append("image", compressedFile);

      const response = await fetch(apiUrl("/api/scan-document"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          [REQUEST_LOCALE_HEADER]: locale,
        },
        body: formData,
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(describeScanError(t, response.status, data));
      }

      const scanned = data.data;
      const documentType = scanned.documentType as ScanDocumentType;

      setSelectedFile(compressedFile);
      setScanDocumentType(documentType);

      if (documentType === "weigh_ticket" || documentType === "delivery_note") {
        const fields =
          (documentType === "weigh_ticket"
            ? scanned.weighTicketFields
            : scanned.deliveryNoteFields) ?? {};

        const flatResult = buildFlatWeighTicketResult(
          documentType,
          fields,
          {
            rawText: scanned.rawText,
            confidenceScore: scanned.confidenceScore,
            reviewStatus: scanned.reviewStatus,
            documentLanguage: scanned.documentLanguage,
          },
          documentTypeLabels[documentType]
        );
        const resolvedMovementType = resolveMovementType(flatResult);
        const normalizedSpz = normalizeSpz(flatResult.spz);

        setOtherResult(null);
        setResult({
          ...flatResult,
          spz: normalizedSpz,
          movementType: resolvedMovementType || "",
        });

        setAssignmentTarget(null);
        setSelectedVehicleId("");
        setSelectedMachineId("");
      } else {
        const fieldsKey =
          documentType === "invoice"
            ? "invoiceFields"
            : documentType === "receipt"
            ? "receiptFields"
            : documentType === "insurance"
            ? "insuranceFields"
            : documentType === "service_document"
            ? "serviceDocumentFields"
            : "otherFields";
        const fields = scanned[fieldsKey] ?? {};

        setResult(null);
        setOtherResult({
          fields,
          reviewStatus: scanned.reviewStatus,
          confidenceScore: scanned.confidenceScore,
          rawText: scanned.rawText,
          documentLanguage: scanned.documentLanguage,
          fieldConfidence: Array.isArray(scanned.fieldConfidence)
            ? scanned.fieldConfidence
            : [],
        });

        setInsuranceMatchAmbiguous(false);

        if (documentType === "insurance") {
          // PZP — deterministické párovanie VIN → ŠPZ (bod 2 zadania),
          // NIKDY tiché hádanie. Presne jedna zhoda sa predvyberie; viac
          // zhôd naraz (ambiguous) alebo žiadna zhoda ostávajú bez
          // predvýberu a používateľ musí vozidlo/stroj vybrať ručne.
          const match = matchInsuranceVehicle(
            fields.vin,
            fields.vehicleIdentifier,
            vehicleOptions
          );

          if (match.vehicleId) {
            setAssignmentTarget("vehicle");
            setSelectedVehicleId(match.vehicleId);
            setSelectedMachineId("");
          } else if (match.ambiguous) {
            setInsuranceMatchAmbiguous(true);
            setAssignmentTarget(null);
            setSelectedVehicleId("");
            setSelectedMachineId("");
          } else {
            // Žiadna zhoda na vozidlo — skús ešte strojový fallback podľa
            // pôvodného vehicleIdentifier (napr. PZP prívesu/stroja), presne
            // ako doteraz. Nič sa nevytvára automaticky, iba sa predvyberie
            // existujúci stroj, ak jednoznačne zodpovedá.
            const normalizedIdentifierLabel =
              typeof fields.vehicleIdentifier === "string" && fields.vehicleIdentifier
                ? normalizeMachineLabel(fields.vehicleIdentifier)
                : "";
            const matchedMachine = normalizedIdentifierLabel
              ? machineOptions.find(
                  (machine) =>
                    normalizeMachineLabel(machine.name) === normalizedIdentifierLabel
                )
              : undefined;

            if (matchedMachine) {
              setAssignmentTarget("machine");
              setSelectedMachineId(matchedMachine.id);
              setSelectedVehicleId("");
            } else {
              setAssignmentTarget(null);
              setSelectedVehicleId("");
              setSelectedMachineId("");
            }
          }
        } else {
          // Ostatné typy (dnes iba service_document) — nezmenené: skús
          // identifikátor spárovať s vozidlom (ŠPZ) alebo strojom podľa už
          // načítaných zoznamov. Pri nejednoznačnosti/chýbajúcom
          // identifikátore ostáva priradenie nezvolené.
          const identifier =
            (documentType === "service_document" &&
              typeof fields.vehicleOrMachineIdentifier === "string" &&
              fields.vehicleOrMachineIdentifier) ||
            "";

          const normalizedIdentifierSpz = identifier ? normalizeSpz(identifier) : null;
          const matchedVehicle = normalizedIdentifierSpz
            ? vehicleOptions.find(
                (vehicle) => normalizeSpz(vehicle.spz) === normalizedIdentifierSpz
              )
            : undefined;

          const normalizedIdentifierLabel = identifier
            ? normalizeMachineLabel(identifier)
            : "";
          const matchedMachine =
            !matchedVehicle && normalizedIdentifierLabel
              ? machineOptions.find(
                  (machine) =>
                    normalizeMachineLabel(machine.name) === normalizedIdentifierLabel
                )
              : undefined;

          if (matchedVehicle) {
            setAssignmentTarget("vehicle");
            setSelectedVehicleId(matchedVehicle.id);
            setSelectedMachineId("");
          } else if (matchedMachine) {
            setAssignmentTarget("machine");
            setSelectedMachineId(matchedMachine.id);
            setSelectedVehicleId("");
          } else {
            setAssignmentTarget(null);
            setSelectedVehicleId("");
            setSelectedMachineId("");
          }
        }
      }

      clearImagePreview(false);
    } catch (processingError: unknown) {
      setError(
        processingError instanceof Error
          ? processingError.message
          : t("inbox.errors.unknownGeneric")
      );
    } finally {
      setIsProcessing(false);
    }
  }

  function cancelPendingDocument() {
    if (isProcessing) return;

    clearImagePreview();
    setSelectedFile(null);
    resetScanReview();
    setError("");
  }

  function resetScanReview() {
    setResult(null);
    setOtherResult(null);
    setScanDocumentType(null);
    setAssignmentTarget(null);
    setSelectedVehicleId("");
    setSelectedMachineId("");
    setDocumentNote("");
    setInsuranceMatchAmbiguous(false);
  }

  function updateResult(field: string, value: string) {
    setResult((prev: any) => ({
      ...prev,
      [field]: value,
    }));
  }

  function updateOtherResult(field: string, value: string) {
    setOtherResult((prev) =>
      prev ? { ...prev, fields: { ...prev.fields, [field]: value } } : prev
    );
  }

function normalizeText(value?: string | null) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function resolveMovementType(result: any): string | null {
  const supplier = normalizeText(result.supplier);
  const material = normalizeText(
    result.materialOriginal || result.material
  );
  const rawText = normalizeText(result.rawText);

  const combinedText = `${supplier} ${material} ${rawText}`;

  // BRZ – odvoz stavebného odpadu zo stavby do recyklačného centra
  if (
    combinedText.includes("brz") ||
    combinedText.includes("recycling-zentrum")
  ) {
    if (
      combinedText.includes("bauschutt") ||
      combinedText.includes("boden") ||
      combinedText.includes("abfall") ||
      combinedText.includes("recyclingmaterial")
    ) {
      return "vývoz";
    }
  }

  // STIX – nový asfalt na stavbu
  if (supplier.includes("stix")) {
    if (
      combinedText.includes("ac8") ||
      combinedText.includes("ac 8") ||
      combinedText.includes("ac32") ||
      combinedText.includes("ac 32") ||
      combinedText.includes("asphaltmischgut")
    ) {
      return "dovoz";
    }

    // Starý vybúraný asfalt odvážaný zo stavby
    if (combinedText.includes("asphaltaufbruch")) {
      return "vývoz";
    }
  }

  // Doris Kaffenberger – piesok, štrk a splitt privážaný na stavbu
  if (
    supplier.includes("kaffenberger") &&
    (
      combinedText.includes("sand") ||
      combinedText.includes("kies") ||
      combinedText.includes("splitt")
    )
  ) {
    return "dovoz";
  }

  return result.movementType || null;
}
  async function saveEvidence() {
    if (!result || saveInProgressRef.current) return;

    if (legalHold) {
      setError(t("common.legalHoldMessage"));
      return;
    }

    saveInProgressRef.current = true;
    setIsSaving(true);
    setError("");
    let uploadedPhotoPath: string | null = null;
    let recordInserted = false;

    try {
      const validatedWeights = normalizeAndValidateWeights({
        quantity: result.quantity,
        brutto: result.brutto,
        tara: result.tara,
        netto: result.netto,
        unit: result.unit,
      });

      if (validatedWeights.invalidFields.length > 0) {
        throw new Error(
          t("inbox.errors.invalidWeightFields", {
            fields: validatedWeights.invalidFields.join(", "),
          })
        );
      }

      const confidenceScore = parseWeightValue(result.confidenceScore);
      if (confidenceScore !== null && confidenceScore > 1) {
        throw new Error(t("inbox.errors.confidenceMustBeNumber"));
      }

      const latestUsage = await refreshPlanUsage();

      if (latestUsage?.isLimited) {
        setError(t("common.planLimitMessage"));
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error(t("inbox.errors.notLoggedIn"));
      }
      // Vážny lístok / dodací list: priradenie k vozidlu je VÝHRADNE
      // automatické podľa ŠPZ, ktorú rozpoznala AI (žiadne ručné
      // "Chcete dokument priradiť?" pre tento typ). Ak vozidlo s danou
      // ŠPZ v module Vozidlá neexistuje, uloženie NESMIE zlyhať — dokument
      // sa uloží so ŠPZ ako textom a vehicle_id zostane null.
      // resolveVehicleIdBySpz nikdy nevyhadzuje chybu.
      const activeMembership = await getMyActiveMembership();

      if (!activeMembership) {
        throw new Error(t("inbox.errors.notLoggedIn"));
      }

      const { vehicleId, canonicalSpz } = await resolveVehicleIdBySpz(
        activeMembership.company_id,
        result.spz
      );
      // Vážny lístok/dodací list nemá ručné priradenie k stroju.
      const machineId: string | null = null;
      const machineLabel: string | null = null;

      let photoPath: string | null = null;

if (selectedFile) {
  const storageSpz = canonicalSpz || "BEZSPZ";

  // eslint-disable-next-line react-hooks/purity -- event handler (saveEvidence), never runs during render
  const uniqueName = `${Date.now()}-${crypto.randomUUID()}.webp`;

  photoPath = `${session.user.id}/${storageSpz}/${uniqueName}`;

  const { error: uploadError } = await supabase.storage
    .from("ai-evidence-documents")
    .upload(photoPath, selectedFile, {
      contentType: selectedFile.type || "image/webp",
      cacheControl: "3600",
      upsert: false,
    });

  if (uploadError) {
    throw new Error(t("inbox.errors.photoSaveFailed", { message: uploadError.message }));
  }

  uploadedPhotoPath = photoPath;
}
const resolvedMovementType = resolveMovementType(result);
      const reviewStatus = validatedWeights.needsReview
        ? "needs_review"
        : result.reviewStatus || "pending";
      const { error } = await supabase.from("ai_evidence").insert({
        user_id: session.user.id,
        vehicle_id: vehicleId,
        machine_id: machineId,
        machine_label: machineLabel,
        spz: canonicalSpz,
        document_type: result.documentType || null,
        movement_type: resolvedMovementType,
        supplier: result.supplier || null,
        document_number: result.documentNumber || null,
        material: result.material || null,
        material_original: result.materialOriginal || null,
material_category: result.materialCategory || null,
document_language: result.documentLanguage || null,
confidence_score: confidenceScore,
source_location: result.sourceLocation || null,
destination_location: result.destinationLocation || null,
review_status: reviewStatus,
        quantity: validatedWeights.quantity,
        unit: validatedWeights.unit,
        brutto: validatedWeights.brutto,
        tara: validatedWeights.tara,
        netto: validatedWeights.netto,
        construction_site: result.constructionSite || null,
        customer: result.customer || null,
        document_date: result.documentDate || null,
        document_time: result.documentTime || null,
        photo_url: photoPath,
        raw_text: result.rawText || null,
      });

      if (error) throw error;

      recordInserted = true;
      resetScanReview();
      setSelectedFile(null);
      setFileName("");
      await Promise.all([loadRecords(), refreshPlanUsage()]);
      alert(t("inbox.documentSavedToInbox"));
    } catch (saveError: unknown) {
      if (uploadedPhotoPath && !recordInserted) {
        const { error: cleanupError } = await supabase.storage
          .from("ai-evidence-documents")
          .remove([uploadedPhotoPath]);

        if (cleanupError) {
          console.error(
            "Insert zlyhal a osirotenú fotografiu sa nepodarilo odstrániť:",
            cleanupError
          );
        }
      }

      if (isPlanLimitReachedError(saveError, "ai_evidence")) {
        setError(t("common.planLimitMessage"));
        await refreshPlanUsage();
      } else {
        setError(
          saveError instanceof Error ? saveError.message : t("inbox.errors.saveFailed")
        );
      }
    } finally {
      saveInProgressRef.current = false;
      setIsSaving(false);
    }
  }
  // Uloženie ostatných typov dokumentov (faktúra, bloček, PZP/poistná
  // zmluva, servisný doklad, iné) — nový, samostatný save flow cez
  // public.documents + public.document_links. Vážneho lístka/dodacieho
  // listu (ai_evidence, saveEvidence vyššie) sa vôbec netýka.
  async function saveOtherDocument() {
    if (
      !otherResult ||
      !scanDocumentType ||
      scanDocumentType === "weigh_ticket" ||
      scanDocumentType === "delivery_note" ||
      saveOtherDocumentInProgressRef.current
    ) {
      return;
    }

    // PZP musí vždy skončiť priradené k existujúcemu vozidlu/stroju (bod 2
    // zadania) — nikdy sa neukladá "bez priradenia". UI nižšie preto pre
    // insurance vôbec neponúka možnosť "none"; táto kontrola je obranná
    // duplicita pre prípad priameho volania mimo bežného UI stavu.
    if (scanDocumentType === "insurance" && assignmentTarget === "none") {
      setError(
        t("inbox.errors.pzpMustBeAssigned")
      );
      return;
    }

    if (!assignmentTarget) {
      setError(
        scanDocumentType === "insurance"
          ? t("inbox.errors.pzpChooseTarget")
          : t("inbox.errors.chooseAssignment")
      );
      return;
    }

    if (assignmentTarget === "vehicle" && !selectedVehicleId) {
      setError(t("inbox.errors.chooseVehicle"));
      return;
    }

    if (assignmentTarget === "machine" && !selectedMachineId) {
      setError(t("inbox.errors.chooseMachine"));
      return;
    }

    if (legalHold) {
      setError(t("common.legalHoldMessage"));
      return;
    }

    saveOtherDocumentInProgressRef.current = true;
    setIsSavingOtherDocument(true);
    setError("");

    let uploadedPath: string | null = null;
    let documentInserted = false;
    let documentId: string | null = null;

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error(t("inbox.errors.notLoggedIn"));
      }

      // Vozidlo/stroj sa vyberá výhradne z už načítaného zoznamu vlastných
      // entít používateľa (dropdown) — čerstvá kontrola členstva tesne
      // pred uložením iba pre prípad, že bola medzičasom zmazaná.
      if (
        assignmentTarget === "vehicle" &&
        !vehicleOptions.some((vehicle) => vehicle.id === selectedVehicleId)
      ) {
        throw new Error(
          t("inbox.errors.vehicleNoLongerAvailable")
        );
      }

      if (
        assignmentTarget === "machine" &&
        !machineOptions.some((machine) => machine.id === selectedMachineId)
      ) {
        throw new Error(
          t("inbox.errors.machineNoLongerAvailable")
        );
      }

      documentId = crypto.randomUUID();
      let storagePath: string | null = null;

      if (selectedFile) {
        // eslint-disable-next-line react-hooks/purity -- event handler (saveOtherDocument), never runs during render
        const uniqueName = `${Date.now()}-${crypto.randomUUID()}.webp`;
        storagePath = `${session.user.id}/${documentId}/${uniqueName}`;

        const { error: uploadError } = await supabase.storage
          .from("ai-inbox-documents")
          .upload(storagePath, selectedFile, {
            contentType: selectedFile.type || "image/webp",
            cacheControl: "3600",
            upsert: false,
          });

        if (uploadError) {
          throw new Error(t("inbox.errors.photoSaveFailed", { message: uploadError.message }));
        }

        uploadedPath = storagePath;
      }

      const status =
        otherResult.reviewStatus === "needs_review" ? "needs_review" : "confirmed";

      const { error: insertError } = await supabase.from("documents").insert({
        id: documentId,
        user_id: session.user.id,
        storage_bucket: "ai-inbox-documents",
        storage_path: storagePath,
        original_filename: fileName || null,
        mime_type: selectedFile?.type || null,
        file_size: selectedFile?.size ?? null,
        document_type: scanDocumentType,
        status,
        ai_raw_output: {
          documentType: scanDocumentType,
          confidenceScore: otherResult.confidenceScore,
          reviewStatus: otherResult.reviewStatus,
          documentLanguage: otherResult.documentLanguage,
          fieldConfidence: otherResult.fieldConfidence,
          fields: otherResult.fields,
        },
        extracted_fields: otherResult.fields,
        field_confidence: otherResult.fieldConfidence,
        note:
          scanDocumentType === "invoice" || scanDocumentType === "receipt"
            ? documentNote.trim() || null
            : null,
      });

      if (insertError) throw insertError;

      documentInserted = true;

      // Priradenie k vozidlu/stroju.
      //
      // PZP priradené k VOZIDLU (scanDocumentType === "insurance" &&
      // assignmentTarget === "vehicle") ide cez
      // esblu_finalize_vehicle_document() — jedno atomické RPC volanie,
      // ktoré zároveň (a) upsertne primary document_links riadok a (b)
      // reklasifikuje dokument mimo Inbox listingu
      // (documents.archived_from_inbox_at), pozri
      // 20260820090000_add_documents_vehicle_archive.sql. Dátovo definovaný
      // výsledný stav, nie iba klientský filter — a jediná cesta, ako
      // reklasifikáciu vôbec dosiahnuť, keďže documents UPDATE je bežne
      // owner/admin only a funkcia beží ako SECURITY DEFINER presne pre
      // tento úzky prípad.
      //
      // PZP priradené k STROJU zostáva nezmenené (plain document_links
      // insert, dokument ostáva bežnou Inbox položkou) — táto oprava sa
      // podľa zadania týka výhradne priradenia k VOZIDLU.
      if (scanDocumentType === "insurance" && assignmentTarget === "vehicle") {
        const { error: finalizeError } = await supabase.rpc(
          "esblu_finalize_vehicle_document",
          {
            p_document_id: documentId,
            p_vehicle_id: selectedVehicleId,
          }
        );

        if (finalizeError) {
          console.error(
            "Priradenie PZP k vozidlu sa nepodarilo uložiť:",
            finalizeError
          );
          resetScanReview();
          setSelectedFile(null);
          setFileName("");
          await loadOtherDocuments();
          setError(
            t("inbox.errors.pzpLinkFailed")
          );
          return;
        }
      } else if (assignmentTarget === "vehicle" || assignmentTarget === "machine") {
        const { error: linkError } = await supabase
          .from("document_links")
          .insert({
            user_id: session.user.id,
            document_id: documentId,
            vehicle_id: assignmentTarget === "vehicle" ? selectedVehicleId : null,
            machine_id: assignmentTarget === "machine" ? selectedMachineId : null,
            link_type: "primary",
            confirmed_by_user: true,
          });

        if (linkError) {
          console.error("Priradenie dokumentu sa nepodarilo uložiť:", linkError);
          resetScanReview();
          setSelectedFile(null);
          setFileName("");
          await loadOtherDocuments();
          setError(
            t("inbox.errors.linkSaveFailed")
          );
          return;
        }
      }

      // Audit záznam — best effort, nikdy neblokuje ani neoznamuje chybu
      // ako zlyhanie hlavného uloženia.
      const { error: logError } = await supabase
        .from("document_review_log")
        .insert({
          document_id: documentId,
          document_ref: documentId,
          user_id: session.user.id,
          action: "created",
        });

      if (logError) {
        console.error(
          "Záznam do document_review_log sa nepodarilo uložiť:",
          logError
        );
      }

      resetScanReview();
      setSelectedFile(null);
      setFileName("");
      await loadOtherDocuments();
      alert(t("inbox.documentSavedToInbox"));
    } catch (saveError: unknown) {
      if (uploadedPath && !documentInserted) {
        const { error: cleanupError } = await supabase.storage
          .from("ai-inbox-documents")
          .remove([uploadedPath]);

        if (cleanupError) {
          console.error(
            "Insert zlyhal a osirotenú fotografiu sa nepodarilo odstrániť:",
            cleanupError
          );
        }
      }

      setError(
        saveError instanceof Error ? saveError.message : t("inbox.errors.saveFailed")
      );
    } finally {
      saveOtherDocumentInProgressRef.current = false;
      setIsSavingOtherDocument(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Prijatá faktúra: dokument → kandidát → review
  //
  // Dokument sa uloží TERAZ, canonical faktúra až po potvrdení review. Poradie
  // je zámerné — faktúra potrebuje source_document_id, a originál dokladu má
  // v Inboxe zostať aj vtedy, keď používateľ review zruší. Nič sa nemaže.
  //
  // Dokument sa ukladá BEZ priradenia k vozidlu/stroju (assignmentTarget je
  // pre túto cestu irelevantný) — prelinkovanie na faktúru spraví až
  // esblu_create_received_invoice_draft() cez document_links.invoice_id.
  // ---------------------------------------------------------------------------
  async function startReceivedInvoiceReview() {
    if (
      !otherResult ||
      scanDocumentType !== "invoice" ||
      isPreparingReceivedInvoice ||
      saveOtherDocumentInProgressRef.current
    ) {
      return;
    }

    if (legalHold) {
      setError(t("common.legalHoldMessage"));
      return;
    }

    setIsPreparingReceivedInvoice(true);
    setError("");

    let uploadedPath: string | null = null;
    let documentInserted = false;

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error(t("inbox.errors.notLoggedIn"));
      }

      const documentId = crypto.randomUUID();
      let storagePath: string | null = null;
      let contentSha256: string | null = null;

      if (selectedFile) {
        // Dedupe vrstva A — hash binárneho obsahu. Počíta sa pred uploadom,
        // aby mal dokument identitu ešte než sa uloží. Ak Web Crypto nie je
        // dostupné, ostane null a dedupe beží len na vrstvách B–D.
        contentSha256 = await computeFileSha256(selectedFile);

        // eslint-disable-next-line react-hooks/purity -- event handler, never runs during render
        const uniqueName = `${Date.now()}-${crypto.randomUUID()}.webp`;
        storagePath = `${session.user.id}/${documentId}/${uniqueName}`;

        const { error: uploadError } = await supabase.storage
          .from("ai-inbox-documents")
          .upload(storagePath, selectedFile, {
            contentType: selectedFile.type || "image/webp",
            cacheControl: "3600",
            upsert: false,
          });

        if (uploadError) {
          throw new Error(t("inbox.errors.photoSaveFailed", { message: uploadError.message }));
        }

        uploadedPath = storagePath;
      }

      const { error: insertError } = await supabase.from("documents").insert({
        id: documentId,
        user_id: session.user.id,
        storage_bucket: "ai-inbox-documents",
        storage_path: storagePath,
        original_filename: fileName || null,
        mime_type: selectedFile?.type || null,
        file_size: selectedFile?.size ?? null,
        document_type: "invoice",
        status: otherResult.reviewStatus === "needs_review" ? "needs_review" : "confirmed",
        content_sha256: contentSha256,
        ai_raw_output: {
          documentType: scanDocumentType,
          confidenceScore: otherResult.confidenceScore,
          reviewStatus: otherResult.reviewStatus,
          documentLanguage: otherResult.documentLanguage,
          fieldConfidence: otherResult.fieldConfidence,
          fields: otherResult.fields,
        },
        extracted_fields: otherResult.fields,
        field_confidence: otherResult.fieldConfidence,
        note: documentNote.trim() || null,
      });

      if (insertError) {
        // Partial unique index documents_company_content_sha256_uniq — presne
        // ten istý súbor už vo firme je. Nič sa nemaže ani neprepisuje,
        // používateľ dostane zrozumiteľnú hlášku.
        if (insertError.code === "23505") {
          throw new Error(t("inbox.receivedInvoice.duplicate.sameFileUploaded"));
        }
        throw insertError;
      }

      documentInserted = true;

      const { error: logError } = await supabase.from("document_review_log").insert({
        document_id: documentId,
        document_ref: documentId,
        user_id: session.user.id,
        action: "created",
      });

      if (logError) {
        console.error("Záznam do document_review_log sa nepodarilo uložiť:", logError);
      }

      await loadOtherDocuments();

      setCurrentUserId(session.user.id);
      setReceivedCandidate(
        receivedCandidateFromScan({
          fields: otherResult.fields,
          sourceDocumentId: documentId,
          confidence: otherResult.confidenceScore,
        })
      );
    } catch (prepareError: unknown) {
      if (uploadedPath && !documentInserted) {
        const { error: cleanupError } = await supabase.storage
          .from("ai-inbox-documents")
          .remove([uploadedPath]);

        if (cleanupError) {
          console.error(
            "Insert zlyhal a osirotenú fotografiu sa nepodarilo odstrániť:",
            cleanupError
          );
        }
      }

      setError(
        prepareError instanceof Error ? prepareError.message : t("inbox.errors.saveFailed")
      );
    } finally {
      setIsPreparingReceivedInvoice(false);
    }
  }

  // Vymazanie dokumentu z public.documents (faktúra, bloček, PZP, servisný
  // doklad, iné) — bod 1 zadania. Poradie je zámerne: najprv Storage
  // (hlavný súbor aj všetky prílohy), až potom DB riadok, aby nikdy
  // nevznikol osirotený súbor v Storage bez zodpovedajúceho DB záznamu (ak
  // by DB delete zlyhal po vymazaní Storage, dokument v zozname ostane a
  // vymazanie sa dá bezpečne zopakovať — remove() na už neexistujúcej ceste
  // nie je chyba). document_links aj document_attachments majú FK ON DELETE
  // CASCADE, takže sa v DB odstránia automaticky spolu s dokumentom.
  async function deleteOtherDocument(doc: OtherDocumentRow) {
    if (deletingDocumentId) return;

    if (
      !confirm(
        t("inbox.errors.confirmDeleteDocument")
      )
    ) {
      return;
    }

    setDeletingDocumentId(doc.id);
    setError("");

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error(t("inbox.errors.notLoggedIn"));
      }

      const membership = await getMyActiveMembership();

      if (!membership) {
        throw new Error(t("inbox.errors.notLoggedIn"));
      }

      const { data: docAttachments, error: attachmentsError } = await supabase
        .from("document_attachments")
        .select("storage_bucket, storage_path")
        .eq("document_id", doc.id)
        .eq("company_id", membership.company_id);

      if (attachmentsError) {
        throw new Error(
          t("inbox.errors.documentAttachmentsLoadFailed", { message: attachmentsError.message })
        );
      }

      const pathsByBucket = new Map<string, string[]>();
      const addPath = (bucket: string | null, path: string | null) => {
        if (!bucket || !path) return;
        const existing = pathsByBucket.get(bucket) ?? [];
        existing.push(path);
        pathsByBucket.set(bucket, existing);
      };

      addPath(doc.storage_bucket, doc.storage_path);
      (docAttachments || []).forEach((attachment) =>
        addPath(attachment.storage_bucket, attachment.storage_path)
      );

      for (const [bucket, paths] of pathsByBucket.entries()) {
        const { error: removeError } = await supabase.storage
          .from(bucket)
          .remove(paths);

        if (removeError) {
          throw new Error(
            t("inbox.errors.documentFilesDeleteFailed", { message: removeError.message })
          );
        }
      }

      const { error: deleteError } = await supabase
        .from("documents")
        .delete()
        .eq("id", doc.id)
        .eq("company_id", membership.company_id);

      if (deleteError) throw deleteError;

      setOtherDocuments((prev) => prev.filter((item) => item.id !== doc.id));
      setSelectedOtherDocument((current) =>
        current?.id === doc.id ? null : current
      );
    } catch (deleteError: unknown) {
      alert(
        deleteError instanceof Error
          ? deleteError.message
          : t("inbox.errors.deleteDocumentFailed")
      );
    } finally {
      setDeletingDocumentId(null);
    }
  }

  // POZN.: handlery TP flow (clearRegistrationResult, handleRegistrationFileChange,
  // handleProcessRegistration, registrationVehiclePayload, saveRegistrationDocument
  // atď.) boli presunuté do app/vozidla/page.tsx — pozri poznámku pri stavových
  // premenných vyššie.

  // Prílohy PZP dokumentu (bod 3 zadania) — jednoduchý model: každá príloha
  // patrí presne jednému dokumentu (public.document_attachments). Volaná aj
  // po nahraní/vymazaní prílohy, aby zoznam ostal v sync bez refreshu.
  async function reloadAttachments(documentId: string) {
    setAttachmentsLoading(true);

    const { data, error } = await supabase
      .from("document_attachments")
      .select("*")
      .eq("document_id", documentId)
      .order("created_at", { ascending: true });

    if (!error && data) {
      setAttachments(data);
    } else if (error) {
      console.error("Chyba pri načítaní príloh dokumentu:", error);
    }

    setAttachmentsLoading(false);
  }

  async function handleAttachmentUpload(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file || !selectedOtherDocument) return;

    if (legalHold) {
      setError(t("common.legalHoldMessage"));
      return;
    }

    setIsUploadingAttachment(true);
    setError("");

    let uploadedPath: string | null = null;

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error(t("inbox.errors.notLoggedIn"));
      }

      const uniqueName = `${Date.now()}-${crypto.randomUUID()}-${file.name}`;
      const storagePath = `${session.user.id}/${selectedOtherDocument.id}/attachments/${uniqueName}`;

      const { error: uploadError } = await supabase.storage
        .from("ai-inbox-documents")
        .upload(storagePath, file, {
          contentType: file.type || "application/octet-stream",
          cacheControl: "3600",
          upsert: false,
        });

      if (uploadError) {
        throw new Error(t("inbox.errors.attachmentUploadFailed", { message: uploadError.message }));
      }

      uploadedPath = storagePath;

      const { data: inserted, error: insertError } = await supabase
        .from("document_attachments")
        .insert({
          user_id: session.user.id,
          document_id: selectedOtherDocument.id,
          storage_bucket: "ai-inbox-documents",
          storage_path: storagePath,
          original_filename: file.name || null,
          mime_type: file.type || null,
          file_size: file.size ?? null,
          attachment_type: newAttachmentType,
        })
        .select()
        .single();

      if (insertError) throw insertError;

      setAttachments((prev) => [...prev, inserted as AttachmentRow]);
    } catch (uploadError: unknown) {
      if (uploadedPath) {
        const { error: cleanupError } = await supabase.storage
          .from("ai-inbox-documents")
          .remove([uploadedPath]);

        if (cleanupError) {
          console.error(
            "Insert prílohy zlyhal a osirotený súbor sa nepodarilo odstrániť:",
            cleanupError
          );
        }
      }

      alert(
        uploadError instanceof Error
          ? uploadError.message
          : t("inbox.errors.attachmentSaveFailed")
      );
    } finally {
      setIsUploadingAttachment(false);
    }
  }

  async function deleteAttachment(attachment: AttachmentRow) {
    if (deletingAttachmentId) return;
    if (!confirm(t("inbox.errors.confirmDeleteAttachment"))) return;

    setDeletingAttachmentId(attachment.id);

    try {
      const { error: removeError } = await supabase.storage
        .from(attachment.storage_bucket)
        .remove([attachment.storage_path]);

      if (removeError) {
        throw new Error(
          t("inbox.errors.attachmentStorageDeleteFailed", { message: removeError.message })
        );
      }

      const { error: deleteError } = await supabase
        .from("document_attachments")
        .delete()
        .eq("id", attachment.id);

      if (deleteError) throw deleteError;

      setAttachments((prev) => prev.filter((item) => item.id !== attachment.id));
    } catch (deleteError: unknown) {
      alert(
        deleteError instanceof Error
          ? deleteError.message
          : t("inbox.errors.attachmentDeleteFailed")
      );
    } finally {
      setDeletingAttachmentId(null);
    }
  }

  async function openAttachment(attachment: AttachmentRow) {
    const { data, error } = await supabase.storage
      .from(attachment.storage_bucket)
      .createSignedUrl(attachment.storage_path, 300);

    if (error || !data) {
      alert(t("inbox.errors.attachmentOpenFailed"));
      return;
    }

    await openExternalUrl(data.signedUrl);
  }

  // Stiahnutie originálneho súboru dokumentu do zariadenia (bod 4/5
  // zadania) — skutočný download (nie iba otvorenie v novej záložke), aby
  // šlo dokument následne vytlačiť štandardným spôsobom zariadenia.
  // downloadBlob() (lib/file-actions.ts) rieši web (nezmenené) aj mobile
  // (Filesystem + Share, keďže blob: URL v Android WebView nie je spoľahlivo
  // sťahovateľná cez <a download>).
  async function downloadOriginal(doc: OtherDocumentRow) {
    if (!doc.storage_bucket || !doc.storage_path) return;

    try {
      const { data, error } = await supabase.storage
        .from(doc.storage_bucket)
        .createSignedUrl(doc.storage_path, 60);

      if (error || !data) {
        throw new Error(t("inbox.errors.originalPrepareFailed"));
      }

      const response = await fetch(data.signedUrl);
      if (!response.ok) {
        throw new Error(t("inbox.errors.originalDownloadFailed"));
      }

      const blob = await response.blob();
      await downloadBlob(blob, doc.original_filename || `dokument-${doc.id}`);
    } catch (downloadError: unknown) {
      alert(
        downloadError instanceof Error
          ? downloadError.message
          : t("inbox.errors.originalDownloadFailed")
      );
    }
  }

  // Tlač — otvorí originál v novej záložke, používateľ ho vytlačí bežným
  // spôsobom prehliadača/zariadenia (Ctrl+P / zdieľať > tlačiť na mobile).
  // Zámerne bez vlastnej print-CSS logiky — jednoduchšie a spoľahlivejšie.
  async function printOriginal(doc: OtherDocumentRow) {
    if (!doc.storage_bucket || !doc.storage_path) return;

    const { data, error } = await supabase.storage
      .from(doc.storage_bucket)
      .createSignedUrl(doc.storage_path, 300);

    if (error || !data) {
      alert(t("inbox.errors.originalPrintPrepareFailed"));
      return;
    }

    await openExternalUrl(data.signedUrl);
  }

  // Bezpečný delete flow (opravené po security audite): najprv overíme
  // vlastníctvo a existenciu záznamu, potom vymažeme Storage objekt, a AŽ PO
  // jeho úspešnom (alebo bezpečne no-op, ak súbor už neexistuje) odstránení
  // vymažeme DB riadok. Predtým sa mazal DB riadok skôr než Storage súbor —
  // pri zlyhaní Storage delete tak mohol vzniknúť osirotený súbor bez
  // akejkoľvek DB stopy, ktorý sa už nedal dohľadať. Storage-first poradie je
  // bezpečnejšie: ak zlyhá Storage delete, DB riadok ostáva a operáciu možno
  // bezpečne zopakovať; `remove()` na už neexistujúcej ceste nie je chyba
  // (Supabase Storage to považuje za úspešný no-op), takže opakovaný pokus
  // po čiastočnom zlyhaní je vždy bezpečný.
  async function deleteRecord(id: string) {
    if (!confirm(t("inbox.errors.confirmDeleteRecord"))) return;

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      alert(t("inbox.errors.notLoggedIn"));
      return;
    }

    const membership = await getMyActiveMembership();

    if (!membership) {
      alert(t("inbox.errors.notLoggedIn"));
      return;
    }

    // Vlastníctvo overujeme explicitne (nielen cez RLS) — select je
    // obmedzený na id AJ company_id aktívnej firmy, takže cudzí
    // záznam sa sem nikdy nenačíta.
    const { data: record, error: recordError } = await supabase
      .from("ai_evidence")
      .select("photo_url")
      .eq("id", id)
      .eq("company_id", membership.company_id)
      .single();

    if (recordError) {
      console.error("Chyba pri načítaní záznamu:", recordError);
      alert(t("inbox.errors.recordLoadFailed"));
      return;
    }

    // Ak existuje fotografia, vymažeme ju zo Storage skôr než DB riadok.
    if (record?.photo_url) {
      const { error: photoDeleteError } = await supabase.storage
        .from("ai-evidence-documents")
        .remove([record.photo_url]);

      if (photoDeleteError) {
        console.error(
          "Fotografiu sa nepodarilo odstrániť zo Storage, záznam nebol vymazaný:",
          photoDeleteError
        );
        alert(t("inbox.errors.recordDeletePhotoFailed"));
        return;
      }
    }

    // Vymažeme databázový záznam — opäť obmedzené na id AJ company_id (defense
    // in depth, nespoliehame sa iba na RLS).
    const { error: deleteError } = await supabase
      .from("ai_evidence")
      .delete()
      .eq("id", id)
      .eq("company_id", membership.company_id);

    if (deleteError) {
      console.error("Chyba pri mazaní záznamu:", deleteError);
      alert(t("inbox.errors.recordDeleteDbFailed"));
      return;
    }

    setSelectedRecord(null);
    setDocumentPhotoUrl(null);
    await Promise.all([loadRecords(), refreshPlanUsage()]);
  }

  async function loadMembership(): Promise<string | null> {
  const membership = await getMyActiveMembership();

  if (!membership) {
    setCompanyId("");
    setRole(null);
    setCanManageFinance(false);
    return null;
  }

  setCompanyId(membership.company_id);
  setRole(membership.role);
  setCanManageFinance(hasFinanceManage(membership));
  return membership.company_id;
}

async function loadRecords(currentCompanyId: string = companyId) {
  if (!currentCompanyId) {
    setRecords([]);
    return;
  }

  const { data, error } = await supabase
    .from("ai_evidence")
    .select("*")
    .eq("company_id", currentCompanyId)
    .order("created_at", { ascending: false });

  if (!error && data) {
    setRecords(data);
  }
}

// Vlastné vozidlá a stroje firmy — zdroj pre výberové polia priradenia
// (dropdown), aby nikto nemusel ručne prepisovať identifikátor entity,
// ktorá už v databáze existuje.
async function loadVehicleAndMachineOptions(
  currentCompanyId: string = companyId
) {
  if (!currentCompanyId) {
    setVehicleOptions([]);
    setMachineOptions([]);
    return;
  }

  const [vehiclesResult, machinesResult] = await Promise.all([
    supabase
      .from("vehicles")
      .select("id, spz, vin")
      .eq("company_id", currentCompanyId)
      .order("spz", { ascending: true }),
    supabase
      .from("machines")
      .select("id, name")
      .eq("company_id", currentCompanyId)
      .order("name", { ascending: true }),
  ]);

  if (!vehiclesResult.error && vehiclesResult.data) {
    setVehicleOptions(vehiclesResult.data);
  }

  if (!machinesResult.error && machinesResult.data) {
    setMachineOptions(machinesResult.data);
  }
}

// Ostatné typy dokumentov (faktúra, bloček, PZP/poistná zmluva, servisný
// doklad, iné) — uložené v public.documents, priradenie v
// public.document_links (real FK na documents.id, PostgREST ho preto vie
// vnoriť priamo do selectu).
async function loadOtherDocuments(currentCompanyId: string = companyId) {
  if (!currentCompanyId) {
    setOtherDocuments([]);
    return;
  }

  // archived_from_inbox_at IS NULL — dátovo definovaný filter (nie iba
  // klientský), pozri 20260820090000_add_documents_vehicle_archive.sql.
  // PZP/TP potvrdené a priradené k vozidlu (esblu_finalize_vehicle_document)
  // majú tento stĺpec nastavený, a preto sa sem už vôbec nenačítajú — ich
  // "domovom" je odteraz detail príslušného vozidla (document_links, pozri
  // app/vozidla/[id]).
  const { data, error } = await supabase
    .from("documents")
    .select("*, document_links(*)")
    .eq("company_id", currentCompanyId)
    .is("deleted_at", null)
    .is("archived_from_inbox_at", null)
    .order("created_at", { ascending: false });

  if (!error && data) {
    setOtherDocuments(data);
  } else if (error) {
    console.error("Chyba pri načítaní ostatných dokumentov:", error);
  }
}

// Firemné vlastné kategórie (Intent Engine, pozri lib/custom-document-
// categories.ts) — RLS company-scoped (esblu_my_active_company_id()), teda
// bez potreby p_company_id parametra, rovnaký vzor ako listCompanyCustomCategories()
// dokumentuje pre review UI. `currentCompanyId` je tu iba lacný guard proti
// zbytočnému volaniu skôr, než appka vie, či vôbec existuje aktívna firma
// (rovnaký vzor ako loadRecords/loadOtherDocuments vyššie) — samotný dopyt
// filter nepotrebuje, RLS ho aj tak vynúti nezávisle.
async function loadCustomCategories(currentCompanyId: string = companyId) {
  if (!currentCompanyId) {
    setCustomCategories([]);
    return;
  }

  const categories = await listCompanyCustomCategories(supabase);
  setCustomCategories(categories);
}

useEffect(() => {
  async function loadDocumentPhoto() {
    setDocumentPhotoUrl(null);

    if (!selectedRecord?.photo_url) {
      return;
    }

    const { data, error } = await supabase.storage
      .from("ai-evidence-documents")
      .createSignedUrl(selectedRecord.photo_url, 3600);

    if (error) {
      console.error("Chyba pri načítaní fotografie:", error);
      return;
    }

    setDocumentPhotoUrl(data.signedUrl);
  }

  loadDocumentPhoto();
}, [selectedRecord]);

useEffect(() => {
  async function loadOtherDocumentPhoto() {
    setOtherDocumentPhotoUrl(null);

    if (!selectedOtherDocument?.storage_bucket || !selectedOtherDocument?.storage_path) {
      return;
    }

    const { data, error } = await supabase.storage
      .from(selectedOtherDocument.storage_bucket)
      .createSignedUrl(selectedOtherDocument.storage_path, 3600);

    if (error) {
      console.error("Chyba pri načítaní fotografie dokumentu:", error);
      return;
    }

    setOtherDocumentPhotoUrl(data.signedUrl);
  }

  loadOtherDocumentPhoto();
}, [selectedOtherDocument]);

useEffect(() => {
  async function syncAttachmentsForSelectedDocument() {
    if (selectedOtherDocument?.document_type !== "insurance") {
      setAttachments([]);
      return;
    }

    await reloadAttachments(selectedOtherDocument.id);
  }

  syncAttachmentsForSelectedDocument();
}, [selectedOtherDocument?.id, selectedOtherDocument?.document_type]);

// ?openDocument=<id> (pozri OpenFromQueryParam) — akonáhle otherDocuments
// dotiahne dáta, nájde zodpovedajúci riadok a otvorí ho PRESNE tak, ako by
// to urobil ručný klik (onClick={() => setSelectedOtherDocument(doc)}
// nižšie). Ak sa zhoda nenájde (zmazaný/archivovaný dokument), appka
// jednoducho nič neurobí — bezpečný no-op, žiadna chyba.
useEffect(() => {
  if (!pendingOpenDocumentId) return;
  const match = otherDocuments.find((doc) => doc.id === pendingOpenDocumentId);
  if (!match) return;
  // setState je zámerne v setTimeout callbacku, nie synchrónne v tele
  // efektu — react-hooks/set-state-in-effect (rovnaký vzor ako debounced
  // Intent Engine efekt v app/components/Dashboard.tsx).
  const timer = setTimeout(() => {
    setSelectedOtherDocument(match);
    setPendingOpenDocumentId(null);
  }, 0);
  return () => clearTimeout(timer);
}, [pendingOpenDocumentId, otherDocuments]);

// ?openEvidence=<id> — rovnaký princíp pre vážny lístok/dodací list
// (public.ai_evidence, `records` zoznam).
useEffect(() => {
  if (!pendingOpenEvidenceId) return;
  const match = records.find((record) => record.id === pendingOpenEvidenceId);
  if (!match) return;
  const timer = setTimeout(() => {
    setSelectedRecord(match);
    setPendingOpenEvidenceId(null);
  }, 0);
  return () => clearTimeout(timer);
}, [pendingOpenEvidenceId, records]);

useEffect(() => {
  async function initialize() {
    const activeCompanyId = await loadMembership();

    await Promise.all([
      loadRecords(activeCompanyId || ""),
      loadVehicleAndMachineOptions(activeCompanyId || ""),
      loadOtherDocuments(activeCompanyId || ""),
      loadCustomCategories(activeCompanyId || ""),
    ]);
  }

  initialize();
}, []);

useEffect(() => {
  return () => {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
  };
}, []);

const currentWeightValidation = result
  ? normalizeAndValidateWeights({
      quantity: result.quantity,
      brutto: result.brutto,
      tara: result.tara,
      netto: result.netto,
      unit: result.unit,
    })
  : null;

// Priradenie uloženého dokumentu (documents + document_links) na
// zobraziteľný text — "Vozidlo — [ŠPZ]", "Stroj — [názov]" alebo
// "Bez priradenia". Vychádza z už načítaných vehicleOptions/machineOptions,
// takže nevyžaduje ďalší dotaz do DB.
function describeDocumentAssignment(doc: OtherDocumentRow): string {
  const link = Array.isArray(doc?.document_links) ? doc.document_links[0] : null;
  if (!link) return t("inbox.noAssignment");

  if (link.vehicle_id) {
    const vehicle = vehicleOptions.find((v) => v.id === link.vehicle_id);
    return t("inbox.vehicleAssignment", {
      value: vehicle ? vehicle.spz ?? "" : t("inbox.unknownVehicle"),
    });
  }

  if (link.machine_id) {
    const machine = machineOptions.find((m) => m.id === link.machine_id);
    return t("inbox.machineAssignment", {
      value: machine ? machine.name ?? "" : t("inbox.unknownMachine"),
    });
  }

  return t("inbox.noAssignment");
}

// Krátke zhrnutie dokumentu pre kartu v zozname "Ostatné dokumenty" —
// zloží najvýstižnejšie z už uložených extracted_fields podľa typu
// dokumentu, nič nevymýšľa nad rámec toho, čo AI endpoint vrátil.
function summarizeDocument(doc: OtherDocumentRow): string {
  const fields = doc?.extracted_fields || {};
  const type = doc?.document_type as OtherDocumentType | undefined;

  const primary =
    (fields.supplier as string) ||
    (fields.merchant as string) ||
    (fields.provider as string) ||
    (fields.customer as string) ||
    "";

  const amount =
    (fields.totalAmount as string | number) ||
    (fields.premiumAmount as string | number) ||
    (fields.cost as string | number) ||
    "";
  const currency = (fields.currency as string) || "";

  const parts = [primary, amount ? `${amount} ${currency}`.trim() : ""].filter(
    Boolean
  );

  if (parts.length > 0) return parts.join(" • ");

  return type ? documentTypeLabels[type] : t("inbox.documentGenericFallback");
}

function formatAmount(value: unknown, currency: unknown): string {
  if (value === null || value === undefined || value === "") {
    return t("inbox.noAmount");
  }
  const currencyLabel = typeof currency === "string" && currency ? ` ${currency}` : "";
  return `${value}${currencyLabel}`;
}

function formatDocDate(value: unknown): string {
  return typeof value === "string" && value ? value : t("inbox.noDate");
}

  return (
    <main className="app-shell-bg min-h-screen p-4 sm:p-6 lg:p-10">
      <Suspense fallback={null}>
        <OpenFromQueryParam
          onOpenDocument={setPendingOpenDocumentId}
          onOpenEvidence={setPendingOpenEvidenceId}
        />
      </Suspense>
      <div className="mx-auto max-w-3xl">
        <BackLink href="/" label={t("inbox.backToMenu")} className="mb-4" />

        <div className="flex items-center gap-4">
  <div
    aria-hidden="true"
    className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-accent-cyan/14 text-accent-cyan"
  >
    <InboxDocumentIcon size={40} />
  </div>
  <h1 className="text-4xl font-bold text-primary">
    {t("inbox.title")}
  </h1>
</div>

        {!planUsageLoading && isPlanLimited && (
          <PlanLimitNotice
            resource="ai_evidence"
            usage={planUsage}
            limit={planLimit}
            className="mt-6"
          />
        )}

        {legalHold && (
          <p className="mt-6 rounded-2xl border border-amber-200/30 bg-warning-soft p-4 text-sm font-semibold text-amber-400">
            {t("common.legalHoldMessage")}
          </p>
        )}

        {/* Technické preukazy — presunuté do app/vozidla/page.tsx (bod 2
            zadania). Inbox od tejto zmeny nemá žiadnu "Technické preukazy"
            sekciu ani CTA "pridať vozidlo z TP". */}

        <div className="mt-10 rounded-3xl border-2 border-dashed border-blue-300 bg-info-soft p-6 text-center">
  <span className="text-5xl">📄</span>

  <h2 className="mt-4 text-2xl font-bold text-primary">
    {t("inbox.addDocument.title")}
  </h2>

  <p className="mt-2 text-secondary">
    {t("inbox.addDocument.description")}
  </p>

  <div className="mt-6 grid grid-cols-2 gap-3">
    <label
      className={`rounded-2xl bg-blue-600 px-4 py-4 font-bold text-white ${
        planUsageLoading || isCreationBlocked || isProcessing || isSaving
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer"
      }`}
    >
      {t("inbox.addDocument.takePhoto")}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        disabled={planUsageLoading || isCreationBlocked || isProcessing || isSaving}
        onChange={handleFile}
      />
    </label>

    <label
      className={`rounded-2xl bg-surface-1 px-4 py-4 font-bold text-blue-700 shadow ${
        planUsageLoading || isCreationBlocked || isProcessing || isSaving
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer"
      }`}
    >
      {t("inbox.addDocument.gallery")}
      <input
        type="file"
        accept="image/*"
        className="hidden"
        disabled={planUsageLoading || isCreationBlocked || isProcessing || isSaving}
        onChange={handleFile}
      />
    </label>
  </div>
</div>

        {previewUrl && pendingImageFile && (
          <section className="mt-8 rounded-3xl bg-surface-2 p-5 sm:p-6">
            <div className="text-center">
              <h2 className="text-xl font-black text-primary">
                {t("inbox.reviewOrientation.title")}
              </h2>
              <p className="mt-2 text-sm text-secondary">
                {t("inbox.reviewOrientation.description")}
              </p>
              <p className="mt-2 text-sm font-bold text-blue-700">
                {t("inbox.reviewOrientation.rotation", { degrees: rotation })}
              </p>
            </div>

            <div className="mx-auto mt-5 flex aspect-square w-full max-w-xl items-center justify-center overflow-hidden rounded-2xl bg-surface-2 p-3">
              <img
                src={previewUrl}
                alt={t("inbox.reviewOrientation.previewAlt")}
                className="max-h-full max-w-full object-contain transition-transform duration-200"
                style={{ transform: `rotate(${rotation}deg)` }}
              />
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() =>
                  setRotation((current) => normalizeRotation(current - 90))
                }
                disabled={isProcessing}
                className="rounded-2xl bg-surface-1 px-4 py-3 font-bold text-primary shadow disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("inbox.reviewOrientation.rotateLeft")}
              </button>
              <button
                type="button"
                onClick={() =>
                  setRotation((current) => normalizeRotation(current + 90))
                }
                disabled={isProcessing}
                className="rounded-2xl bg-surface-1 px-4 py-3 font-bold text-primary shadow disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("inbox.reviewOrientation.rotateRight")}
              </button>
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={processPendingDocument}
                disabled={isProcessing || planUsageLoading || isCreationBlocked}
                className="flex-1 rounded-2xl bg-blue-600 px-5 py-4 font-black text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isProcessing
                  ? t("inbox.reviewOrientation.processing")
                  : t("inbox.reviewOrientation.processDocument")}
              </button>
              <button
                type="button"
                onClick={cancelPendingDocument}
                disabled={isProcessing}
                className="rounded-2xl bg-surface-2 px-5 py-4 font-bold text-primary disabled:cursor-not-allowed disabled:opacity-60 sm:min-w-32"
              >
                {t("inbox.reviewOrientation.cancel")}
              </button>
            </div>
          </section>
        )}

        {fileName && (
          <div className="mt-8 rounded-2xl bg-surface-2 p-5">
            <p className="font-bold text-primary">{t("inbox.selectedDocument")}</p>
            <p className="mt-1 text-secondary">{fileName}</p>

            {isProcessing && (
              <p className="mt-4 font-semibold text-blue-600">
                {t("inbox.aiProcessing")}
              </p>
            )}

            {error && (
              <p className="mt-4 font-semibold text-red-400">{t("inbox.errorPrefix", { message: error })}</p>
            )}
          </div>
        )}

        {result && (
          <div className="mt-8 space-y-4 rounded-3xl bg-surface-2 p-6">
            <h2 className="text-2xl font-black text-primary">
              {t("inbox.loadedData", { type: documentTypeLabels[scanDocumentType ?? "weigh_ticket"] })}
            </h2>

            {result.reviewStatus === "needs_review" && (
              <p className="rounded-xl bg-amber-100 px-4 py-3 text-sm font-bold text-amber-900">
                {t("inbox.aiUnsureWarning")}
              </p>
            )}

            {[
              ["documentType", t("inbox.fields.documentType")],
              ["movementType", t("inbox.fields.movementType")],
              ["spz", t("inbox.fields.spz")],
              ["supplier", t("inbox.fields.supplier")],
              ["customer", t("inbox.fields.customer")],
              ["constructionSite", t("inbox.fields.constructionSite")],
              ["documentNumber", t("inbox.fields.documentNumber")],
              ["material", t("inbox.fields.material")],
              ["quantity", t("inbox.fields.quantity")],
              ["unit", t("inbox.fields.unit")],
              ["brutto", t("inbox.fields.brutto")],
              ["tara", t("inbox.fields.tara")],
              ["netto", t("inbox.fields.netto")],
              ["documentDate", t("inbox.fields.documentDate")],
              ["documentTime", t("inbox.fields.documentTime")],
            ].map(([field, label]) => (
              <div key={field}>
                <label className="text-sm font-bold text-secondary">
                  {label}
                </label>
                <input
                  value={result[field] ?? ""}
                  onChange={(e) => updateResult(field, e.target.value)}
                  className="mt-1 w-full rounded-xl border border-subtle bg-surface-1 px-4 py-3 outline-none"
                />
              </div>
            ))}

            {currentWeightValidation?.invalidFields.length ? (
              <p className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-semibold text-red-700">
                {t("inbox.invalidNumberFields", {
                  fields: currentWeightValidation.invalidFields.join(", "),
                })}
              </p>
            ) : currentWeightValidation?.hasMathMismatch ? (
              <p className="rounded-xl bg-warning-soft px-4 py-3 text-sm font-semibold text-amber-400">
                {t("inbox.weightMismatchWarning")}
              </p>
            ) : currentWeightValidation?.isUnitMissing ? (
              <p className="rounded-xl bg-warning-soft px-4 py-3 text-sm font-semibold text-amber-400">
                {t("inbox.weightUnitMissingWarning")}
              </p>
            ) : null}

            {/* Vážny lístok/dodací list nemá ručné priradenie — vozidlo sa
                dohľadáva automaticky podľa ŠPZ priamo v saveEvidence(). */}
            <button
              onClick={saveEvidence}
              disabled={
                isSaving ||
                planUsageLoading ||
                isCreationBlocked ||
                Boolean(currentWeightValidation?.invalidFields.length)
              }
              className="mt-4 w-full rounded-2xl bg-blue-600 px-5 py-4 text-lg font-black text-white disabled:opacity-60"
            >
              {isSaving ? t("common.buttons.saving") : t("inbox.saveToEvidence")}
            </button>
          </div>
          )}

        {otherResult &&
          scanDocumentType &&
          scanDocumentType !== "weigh_ticket" &&
          scanDocumentType !== "delivery_note" && (
          <div className="mt-8 space-y-4 rounded-3xl bg-surface-2 p-6">
            <h2 className="text-2xl font-black text-primary">
              {t("inbox.loadedData", { type: documentTypeLabels[scanDocumentType] })}
            </h2>

            {otherResult.reviewStatus === "needs_review" && (
              <p className="rounded-xl bg-amber-100 px-4 py-3 text-sm font-bold text-amber-900">
                {t("inbox.aiUnsureWarningGeneric")}
              </p>
            )}

            {reviewOnlyFieldLabels[scanDocumentType].map(
              ([field, label]) => (
                <div key={field}>
                  <label className="text-sm font-bold text-secondary">
                    {label}
                  </label>
                  <input
                    value={otherResult.fields[field] ?? ""}
                    onChange={(e) => updateOtherResult(field, e.target.value)}
                    className="mt-1 w-full rounded-xl border border-subtle bg-surface-1 px-4 py-3 outline-none"
                  />
                </div>
              )
            )}

            {/* Poznámka — nepovinná, iba pri bločku/faktúre (bod 2 zadania). */}
            {(scanDocumentType === "invoice" ||
              scanDocumentType === "receipt") && (
              <div>
                <label className="text-sm font-bold text-secondary">
                  {t("inbox.noteOptionalLabel")}
                </label>
                <textarea
                  value={documentNote}
                  onChange={(e) => setDocumentNote(e.target.value)}
                  rows={3}
                  placeholder={t("inbox.notePlaceholder")}
                  className="mt-1 w-full rounded-xl border border-subtle bg-surface-1 px-4 py-3 outline-none"
                />
              </div>
            )}

            {/* Prijatá faktúra — canonical cesta.
                Ponúka sa iba pri type 'invoice' a iba držiteľovi
                finance.manage. Je to alternatíva k archivácii dokumentu, nie
                jej náhrada: kto chce doklad iba odložiť k vozidlu/stroju,
                pokračuje priradením nižšie. */}
            {scanDocumentType === "invoice" && canManageFinance && (
              <div className="space-y-3 rounded-2xl border border-subtle bg-surface-1 p-5">
                <h3 className="text-lg font-black text-primary">
                  {t("inbox.receivedInvoice.cta.title")}
                </h3>
                <p className="text-sm text-muted-esblu">
                  {t("inbox.receivedInvoice.cta.description")}
                </p>
                <button
                  onClick={startReceivedInvoiceReview}
                  disabled={isPreparingReceivedInvoice || isSavingOtherDocument || legalHold}
                  className="w-full rounded-2xl bg-accent-esblu px-6 py-4 text-base font-black text-on-accent disabled:opacity-50"
                >
                  {isPreparingReceivedInvoice
                    ? t("inbox.receivedInvoice.cta.preparing")
                    : t("inbox.receivedInvoice.cta.button")}
                </button>
              </div>
            )}

            {/* Priradenie MUSÍ byť pred tlačidlom Uložiť — rovnaká zásada
                ako pri vážnom lístku, aby sa nedalo uložiť skôr, než sa
                používateľ k priradeniu vôbec dostane. */}
            <div className="space-y-4 rounded-2xl border border-subtle bg-surface-1 p-5">
              <h3 className="text-lg font-black text-primary">
                {scanDocumentType === "insurance"
                  ? t("inbox.assignmentQuestionPzp")
                  : t("inbox.assignmentQuestionGeneric")}
              </h3>

              {scanDocumentType === "insurance" && insuranceMatchAmbiguous && (
                <p className="rounded-xl bg-amber-500/10 p-3 text-sm font-semibold text-amber-400">
                  {t("inbox.pzpAmbiguousWarning")}
                </p>
              )}

              {scanDocumentType === "insurance" &&
                !insuranceMatchAmbiguous &&
                assignmentTarget === null && (
                  <p className="rounded-xl bg-surface-2 p-3 text-sm text-muted-esblu">
                    {t("inbox.pzpNoMatchHint")}
                  </p>
                )}

              <div
                className={`grid gap-2 ${
                  scanDocumentType === "insurance"
                    ? "grid-cols-2"
                    : "grid-cols-3"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setAssignmentTarget("vehicle")}
                  className={`rounded-2xl px-3 py-4 text-sm font-bold ${
                    assignmentTarget === "vehicle"
                      ? "bg-blue-600 text-white"
                      : "bg-surface-2 text-secondary"
                  }`}
                >
                  {t("inbox.assignVehicle")}
                </button>
                <button
                  type="button"
                  onClick={() => setAssignmentTarget("machine")}
                  className={`rounded-2xl px-3 py-4 text-sm font-bold ${
                    assignmentTarget === "machine"
                      ? "bg-blue-600 text-white"
                      : "bg-surface-2 text-secondary"
                  }`}
                >
                  {t("inbox.assignMachine")}
                </button>
                {scanDocumentType !== "insurance" && (
                  <button
                    type="button"
                    onClick={() => setAssignmentTarget("none")}
                    className={`rounded-2xl px-3 py-4 text-sm font-bold ${
                      assignmentTarget === "none"
                        ? "bg-blue-600 text-white"
                        : "bg-surface-2 text-secondary"
                    }`}
                  >
                    {t("inbox.assignNone")}
                  </button>
                )}
              </div>

              {assignmentTarget === "vehicle" && (
                <div>
                  <label className="text-sm font-bold text-secondary">
                    {t("inbox.vehicleLabel")}
                  </label>
                  <select
                    value={selectedVehicleId}
                    onChange={(e) => setSelectedVehicleId(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-subtle bg-surface-1 px-4 py-3 outline-none"
                  >
                    <option value="">{t("inbox.chooseVehiclePlaceholder")}</option>
                    {vehicleOptions.map((vehicle) => (
                      <option key={vehicle.id} value={vehicle.id}>
                        {vehicle.spz || t("inbox.noPlateCapitalized")}
                      </option>
                    ))}
                  </select>
                  {vehicleOptions.length === 0 && (
                    <p className="mt-1 text-xs text-muted-esblu">
                      {t("inbox.noVehiclesYet")}
                    </p>
                  )}
                </div>
              )}

              {assignmentTarget === "machine" && (
                <div>
                  <label className="text-sm font-bold text-secondary">
                    {t("inbox.machineLabel")}
                  </label>
                  <select
                    value={selectedMachineId}
                    onChange={(e) => setSelectedMachineId(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-subtle bg-surface-1 px-4 py-3 outline-none"
                  >
                    <option value="">{t("inbox.chooseMachinePlaceholder")}</option>
                    {machineOptions.map((machine) => (
                      <option key={machine.id} value={machine.id}>
                        {machine.name || t("inbox.noName")}
                      </option>
                    ))}
                  </select>
                  {machineOptions.length === 0 && (
                    <p className="mt-1 text-xs text-muted-esblu">
                      {t("inbox.noMachinesYet")}
                    </p>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={saveOtherDocument}
              disabled={
                isSavingOtherDocument ||
                planUsageLoading ||
                legalHold ||
                !assignmentTarget ||
                (assignmentTarget === "vehicle" && !selectedVehicleId) ||
                (assignmentTarget === "machine" && !selectedMachineId)
              }
              className="mt-4 w-full rounded-2xl bg-blue-600 px-5 py-4 text-lg font-black text-white disabled:opacity-60"
            >
              {isSavingOtherDocument
                ? t("common.buttons.saving")
                : assignmentTarget === "vehicle"
                  ? t("inbox.saveToVehicle", {
                      suffix: selectedVehicleId
                        ? ` (${
                            vehicleOptions.find((v) => v.id === selectedVehicleId)
                              ?.spz || ""
                          })`
                        : "",
                    })
                  : assignmentTarget === "machine"
                    ? t("inbox.saveToMachine", {
                        suffix: selectedMachineId
                          ? ` (${
                              machineOptions.find((m) => m.id === selectedMachineId)
                                ?.name || ""
                            })`
                          : "",
                      })
                    : assignmentTarget === "none"
                      ? t("inbox.saveWithoutAssignment")
                      : t("inbox.chooseAssignmentFirst")}
            </button>

            <button
              type="button"
              onClick={cancelPendingDocument}
              disabled={isSavingOtherDocument}
              className="mt-2 w-full rounded-2xl bg-surface-2 px-5 py-4 font-bold text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("inbox.uploadDifferentDocument")}
            </button>
          </div>
        )}

  {/* "Prehľad materiálu" (agregát cez všetky ŠPZ) bol odstránený z Inboxu —
      "Prehľad podľa ŠPZ" nižšie ostáva jediný, kompletný pohľad na rovnaké
      dáta (bod 3 zadania). */}
  {records.length > 0 && (
  <div className="mt-10">
    <h2 className="mb-4 text-2xl font-bold text-primary">
      {t("inbox.spzOverviewTitle")}
    </h2>

    <div className="space-y-5">
      {Object.entries(summaryBySpz).map(
        ([spz, vehicleSummary]: any) => (
          <div
            key={spz}
            className="rounded-3xl border border-subtle bg-surface-1 p-6 shadow-sm"
          >
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-blue-600">
                  {t("inbox.vehicleGroupLabel")}
                </p>

                <h3 className="text-2xl font-black text-primary">
                  {spz}
                </h3>
              </div>

              <p className="text-sm text-muted-esblu">
                {vehicleSummary.documentsCount}{" "}
                {tCount(
                  "inbox.documentsCountSuffix",
                  vehicleSummary.documentsCount
                )}
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl bg-success-soft p-5">
                <p className="text-sm font-bold uppercase text-green-400">
                  {t("inbox.importLabel")}
                </p>

                <p className="mt-2 text-3xl font-black text-primary">
                  {vehicleSummary.totalImport.toFixed(2)} t
                </p>

                <div className="mt-4 space-y-2">
                  {Object.entries(
                    vehicleSummary.importByMaterial
                  ).map(([material, weight]: any) => (
                    <div
                      key={material}
                      className="flex justify-between rounded-xl bg-surface-1 px-3 py-2"
                    >
                      <span className="font-semibold text-secondary">
                        {material}
                      </span>

                      <span className="font-black text-green-400">
                        {Number(weight).toFixed(2)} t
                      </span>
                    </div>
                  ))}

                  {Object.keys(
                    vehicleSummary.importByMaterial
                  ).length === 0 && (
                    <p className="text-sm text-muted-esblu">
                      {t("inbox.noImportShort")}
                    </p>
                  )}
                </div>
              </div>

              <div className="rounded-2xl bg-warning-soft p-5">
                <p className="text-sm font-bold uppercase text-orange-400">
                  {t("inbox.exportLabel")}
                </p>

                <p className="mt-2 text-3xl font-black text-primary">
                  {vehicleSummary.totalExport.toFixed(2)} t
                </p>

                <div className="mt-4 space-y-2">
                  {Object.entries(
                    vehicleSummary.exportByMaterial
                  ).map(([material, weight]: any) => (
                    <div
                      key={material}
                      className="flex justify-between rounded-xl bg-surface-1 px-3 py-2"
                    >
                      <span className="font-semibold text-secondary">
                        {material}
                      </span>

                      <span className="font-black text-orange-400">
                        {Number(weight).toFixed(2)} t
                      </span>
                    </div>
                  ))}

                  {Object.keys(
                    vehicleSummary.exportByMaterial
                  ).length === 0 && (
                    <p className="text-sm text-muted-esblu">
                      {t("inbox.noExportShort")}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {vehicleSummary.unknownCount > 0 && (
              <div className="mt-4 rounded-2xl bg-surface-2 p-5">
                <p className="text-sm font-bold uppercase text-secondary">
                  {t("inbox.unknownLabel")}
                </p>

                <p className="mt-2 text-3xl font-black text-primary">
                  {vehicleSummary.totalUnknown.toFixed(2)} t
                </p>

                <p className="mt-1 text-sm text-muted-esblu">
                  {vehicleSummary.unknownCount}{" "}
                  {tCount(
                    "inbox.documentsCountSuffix",
                    vehicleSummary.unknownCount
                  )}{" "}
                  — {t("inbox.unknownMovementHint")}
                </p>

                <div className="mt-4 space-y-2">
                  {Object.entries(
                    vehicleSummary.unknownByMaterial
                  ).map(([material, weight]) => (
                    <div
                      key={material}
                      className="flex justify-between rounded-xl bg-surface-1 px-3 py-2"
                    >
                      <span className="font-semibold text-secondary">
                        {material}
                      </span>

                      <span className="font-black text-secondary">
                        {Number(weight).toFixed(2)} t
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      )}
    </div>
  </div>
)}
    {records.length > 0 && (
      <div className="mt-10">
    <h2 className="mb-4 text-2xl font-bold text-primary">
      {t("inbox.savedDocumentsTitle")}
    </h2>

    <div className="mt-5 space-y-3">
      {!selectedSpz &&
  Object.entries(groupedRecords).map(([spz, items]: any) => (
    <div
      key={spz}
      className="rounded-3xl border border-subtle bg-surface-1 p-5 shadow-sm"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-wide text-blue-600">
            {t("inbox.assignVehicle")}
          </p>

          <h3 className="mt-2 text-2xl font-black text-primary">
            {spz}
          </h3>

          <p className="mt-1 text-sm text-secondary">
            {items.length} {tCount("inbox.documentsCountSuffix", items.length)}
          </p>
        </div>

        <button
          onClick={() => setSelectedSpz(spz)}
          className="rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white"
        >
          {t("inbox.open")}
        </button>
      </div>
    </div>
  ))}

{selectedSpz && (
  <>
    <button
      onClick={() => setSelectedSpz(null)}
      className="mb-4 rounded-2xl bg-surface-2 px-4 py-3 font-bold text-secondary"
    >
      {t("inbox.backToAllPlates")}
    </button>

    <h3 className="mb-4 text-2xl font-bold text-primary">
      🚛 {selectedSpz}
    </h3>

    <div className="space-y-3">
      {groupedRecords[selectedSpz]?.map((record: any) => (
        <div
          key={record.id}
          className="rounded-3xl border border-subtle bg-surface-1 p-5 shadow-sm"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-wide text-blue-600">
                📄 {record.document_type || t("inbox.documentFallback")}
              </p>

              <h3 className="mt-2 text-xl font-black text-primary">
                {record.spz || t("inbox.noPlateCapitalized")}
              </h3>
            </div>

            <span className="rounded-full bg-info-soft px-3 py-1 text-xs font-bold text-blue-700">
              {record.movement_type || t("inbox.unclassified")}
            </span>
          </div>

          <div className="mt-4 space-y-2 text-sm text-secondary">
            <p>🏗️ {record.construction_site || t("inbox.noConstructionSite")}</p>
            <p>🏢 {record.supplier || t("inbox.noSupplier")}</p>
            <p>👤 {record.customer || t("inbox.noCustomer")}</p>
            <p>📦 {record.material || t("inbox.noMaterial")}</p>
            <p>
              ⚖️{" "}
              {formatRecordWeight(record, t)}
            </p>
            <p>
              📅 {record.document_date || t("inbox.noDate")}{" "}
              {record.document_time || ""}
            </p>
          </div>

          <button
            onClick={() => setSelectedRecord(record)}
            className="mt-5 w-full rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white hover:bg-blue-700"
          >
            {t("inbox.openDetail")}
          </button>
        </div>
      ))}
    </div>
  </>
)}
    </div>
  </div>
)}
    {isOwnerOrAdmin(role) && (
    <div className="mt-10 rounded-3xl border border-subtle bg-surface-1 p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-black text-primary">
            {t("inbox.exportDocumentsTitle")}
          </h2>
          <p className="mt-1 text-sm text-secondary">
            {t("inbox.exportDocumentsDescription")}
          </p>
        </div>

        <button
          type="button"
          onClick={handleExportExcel}
          disabled={exportLoading || visibleDocuments.length === 0}
          aria-busy={exportLoading}
          className="rounded-2xl bg-emerald-600 px-5 py-4 font-black text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exportLoading ? t("inbox.generatingExcel") : t("inbox.exportDocuments")}
        </button>
      </div>

      {visibleDocuments.length === 0 && (
        <p className="mt-4 rounded-xl bg-warning-soft px-4 py-3 text-sm font-semibold text-amber-400">
          {t("inbox.errors.noDocumentsToExport")}
        </p>
      )}

      {exportFeedback && (
        <p
          className={`mt-4 rounded-xl px-4 py-3 text-sm font-semibold ${
            exportFeedback.type === "success"
              ? "badge-success"
              : "badge-danger"
          }`}
        >
          {exportFeedback.text}
        </p>
      )}
    </div>
    )}

    {/* Zložky "Bločky"/"Faktúry" — nepriradené dokumenty (bod 4 zadania). */}
    {!openFolder && !openCustomCategoryId && (
      <div className="mt-10">
        <h2 className="text-2xl font-black text-primary">
          {t("inbox.foldersTitle")}
        </h2>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => handleOpenFolder("receipt")}
            className="rounded-3xl border border-subtle bg-surface-1 p-5 text-left shadow-sm transition hover:border-blue-300"
          >
            <p className="text-3xl">🧾</p>
            <h3 className="mt-2 text-xl font-black text-primary">{t("inbox.receiptsFolderTitle")}</h3>
            <p className="mt-1 text-sm text-secondary">
              {unassignedReceipts.length}{" "}
              {tCount("inbox.unassignedReceiptsCount", unassignedReceipts.length)}
            </p>
          </button>

          <button
            type="button"
            onClick={() => handleOpenFolder("invoice")}
            className="rounded-3xl border border-subtle bg-surface-1 p-5 text-left shadow-sm transition hover:border-blue-300"
          >
            <p className="text-3xl">📃</p>
            <h3 className="mt-2 text-xl font-black text-primary">{t("inbox.invoicesFolderTitle")}</h3>
            <p className="mt-1 text-sm text-secondary">
              {unassignedInvoices.length}{" "}
              {tCount("inbox.unassignedInvoicesCount", unassignedInvoices.length)}
            </p>
          </button>
        </div>
      </div>
    )}

    {/* "Vlastné zložky" — firemné vlastné kategórie (Intent Engine Action
        Engine CREATE/RENAME/ASSIGN_DOCUMENTS_TO_CATEGORY). Rovnaký tile
        layout ako Bločky/Faktúry vyššie (bod 4 zadania: "Reuse existujúci
        Inbox/category layout. Nevytváraj paralelný modul."). Sekcia sa
        zámerne vôbec nezobrazí, kým firma nemá žiadnu vlastnú kategóriu —
        žiadny prázdny "0 zložiek" blok. */}
    {!openFolder && !openCustomCategoryId && customCategories.length > 0 && (
      <div className="mt-10">
        <h2 className="text-2xl font-black text-primary">
          {t("inbox.customCategoriesTitle")}
        </h2>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {customCategories.map((category) => {
            const count = customCategoryDocumentCounts.get(category.id) || 0;
            return (
              <button
                key={category.id}
                type="button"
                onClick={() => handleOpenCustomCategory(category.id)}
                className="rounded-3xl border border-subtle bg-surface-1 p-5 text-left shadow-sm transition hover:border-blue-300"
              >
                <p className="text-3xl">🗂️</p>
                <h3 className="mt-2 text-xl font-black text-primary">{category.name}</h3>
                <p className="mt-1 text-sm text-secondary">
                  {count} {tCount("inbox.customCategoryDocumentsCount", count)}
                </p>
              </button>
            );
          })}
        </div>
      </div>
    )}

    {openCustomCategory && (
      <div className="mt-10">
        <button
          onClick={handleBackToFolders}
          className="mb-4 rounded-2xl bg-surface-2 px-4 py-3 font-bold text-secondary"
        >
          {t("inbox.backToFolders")}
        </button>

        <div className="flex flex-col gap-4 rounded-3xl border border-subtle bg-surface-1 p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <h2 className="text-2xl font-black text-primary">
              {`🗂️ ${openCustomCategory.name}`}
            </h2>
            <p className="mt-1 text-sm text-secondary">
              {openCustomCategoryDocuments.length}{" "}
              {tCount("inbox.customCategoryDocumentsCount", openCustomCategoryDocuments.length)}
            </p>
          </div>
        </div>

        {openCustomCategoryDocuments.length === 0 ? (
          <p className="mt-4 rounded-xl bg-surface-2 px-4 py-3 text-sm text-secondary">
            {t("inbox.noCustomCategoryDocuments")}
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Rovnaká karta ako "Ostatné dokumenty" nižšie (summarizeDocument/
                describeDocumentAssignment) — vlastná kategória môže obsahovať
                ľubovoľný document_type (bločky, faktúry, "other", ...), takže
                sa reuseuje typovo-neutrálna karta, nie receipt/invoice-
                špecifická z openFolder sekcie vyššie. */}
            {openCustomCategoryDocuments.map((doc) => (
              <div
                key={doc.id}
                className="rounded-3xl border border-subtle bg-surface-1 p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-black uppercase tracking-wide text-blue-600">
                      📄{" "}
                      {documentTypeLabels[doc.document_type as ScanDocumentType] ||
                        doc.document_type ||
                        t("inbox.documentFallback")}
                    </p>

                    <h3 className="mt-2 text-lg font-black text-primary">
                      {summarizeDocument(doc)}
                    </h3>
                  </div>

                  {doc.status === "needs_review" && (
                    <span className="rounded-full bg-warning-soft px-3 py-1 text-xs font-bold text-amber-400">
                      {t("inbox.needsReview")}
                    </span>
                  )}
                </div>

                <div className="mt-4 space-y-2 text-sm text-secondary">
                  <p>🔗 {describeDocumentAssignment(doc)}</p>
                  <p>
                    📅{" "}
                    {doc.created_at
                      ? formatDate(doc.created_at, locale)
                      : t("inbox.noDate")}
                  </p>
                </div>

                <button
                  onClick={() => setSelectedOtherDocument(doc)}
                  className="mt-5 w-full rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white hover:bg-blue-700"
                >
                  {t("inbox.openDetail")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    )}

    {openFolder && (
      <div className="mt-10">
        <button
          onClick={handleBackToFolders}
          className="mb-4 rounded-2xl bg-surface-2 px-4 py-3 font-bold text-secondary"
        >
          {t("inbox.backToFolders")}
        </button>

        <div className="flex flex-col gap-4 rounded-3xl border border-subtle bg-surface-1 p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <h2 className="text-2xl font-black text-primary">
              {openFolder === "receipt"
                ? `🧾 ${t("inbox.receiptsFolderTitle")}`
                : `📃 ${t("inbox.invoicesFolderTitle")}`}
            </h2>
            <p className="mt-1 text-sm text-secondary">
              {openFolderDocuments.length}{" "}
              {tCount("inbox.unassignedDocumentsCount", openFolderDocuments.length)}
            </p>
          </div>

          {isOwnerOrAdmin(role) && (
          <button
            type="button"
            onClick={() => handleExportFolder(openFolder)}
            disabled={folderExportLoading || openFolderDocuments.length === 0}
            aria-busy={folderExportLoading}
            className="rounded-2xl bg-emerald-600 px-5 py-4 font-black text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {folderExportLoading ? t("inbox.generatingExcel") : t("inbox.exportFolder")}
          </button>
          )}
        </div>

        {folderExportFeedback && (
          <p
            className={`mt-4 rounded-xl px-4 py-3 text-sm font-semibold ${
              folderExportFeedback.type === "success"
                ? "badge-success"
                : "badge-danger"
            }`}
          >
            {folderExportFeedback.text}
          </p>
        )}

        {openFolderDocuments.length === 0 ? (
          <p className="mt-4 rounded-xl bg-surface-2 px-4 py-3 text-sm text-secondary">
            {t("inbox.noUnassignedDocuments")}
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {openFolderDocuments.map((doc) => {
              const fields = doc.extracted_fields || {};
              return (
                <div
                  key={doc.id}
                  className="rounded-3xl border border-subtle bg-surface-1 p-5 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      {openFolder === "receipt" ? (
                        <h3 className="text-lg font-black text-primary">
                          {(fields.merchant as string) || t("inbox.noMerchant")}
                        </h3>
                      ) : (
                        <h3 className="text-lg font-black text-primary">
                          {(fields.supplier as string) || t("inbox.noSupplier")}
                        </h3>
                      )}
                      <p className="mt-1 text-sm text-secondary">
                        📅{" "}
                        {formatDocDate(
                          openFolder === "receipt"
                            ? fields.purchaseDate
                            : fields.issueDate
                        )}
                      </p>
                    </div>

                    {doc.status === "needs_review" && (
                      <span className="rounded-full bg-warning-soft px-3 py-1 text-xs font-bold text-amber-400">
                        {t("inbox.needsReview")}
                      </span>
                    )}
                  </div>

                  <div className="mt-4 space-y-1 text-sm text-secondary">
                    <p>💶 {formatAmount(fields.totalAmount, fields.currency)}</p>
                    {openFolder === "invoice" && (
                      <p>
                        🔢{" "}
                        {(fields.invoiceNumber as string) || t("inbox.noInvoiceNumber")}
                      </p>
                    )}
                    {doc.note && <p>📝 {doc.note}</p>}
                  </div>

                  <button
                    onClick={() => setSelectedOtherDocument(doc)}
                    className="mt-5 w-full rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white hover:bg-blue-700"
                  >
                    {t("inbox.openDetail")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    )}

    <div className="mt-10">
      <h2 className="text-2xl font-black text-primary">
        {t("inbox.otherDocumentsTitle")}
      </h2>
      <p className="mt-1 text-sm text-secondary">
        {t("inbox.otherDocumentsDescription")}
      </p>

      {otherDocumentsFlatList.length === 0 ? (
        <p className="mt-4 rounded-xl bg-surface-2 px-4 py-3 text-sm text-secondary">
          {t("inbox.noSavedDocuments")}
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {otherDocumentsFlatList.map((doc) => (
            <div
              key={doc.id}
              className="rounded-3xl border border-subtle bg-surface-1 p-5 shadow-sm"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-wide text-blue-600">
                    📄{" "}
                    {documentTypeLabels[doc.document_type as ScanDocumentType] ||
                      doc.document_type ||
                      t("inbox.documentFallback")}
                  </p>

                  <h3 className="mt-2 text-lg font-black text-primary">
                    {summarizeDocument(doc)}
                  </h3>
                </div>

                {doc.status === "needs_review" && (
                  <span className="rounded-full bg-warning-soft px-3 py-1 text-xs font-bold text-amber-400">
                    {t("inbox.needsReview")}
                  </span>
                )}
              </div>

              <div className="mt-4 space-y-2 text-sm text-secondary">
                <p>🔗 {describeDocumentAssignment(doc)}</p>
                <p>
                  📅{" "}
                  {doc.created_at
                    ? formatDate(doc.created_at, locale)
                    : t("inbox.noDate")}
                </p>
              </div>

              <button
                onClick={() => setSelectedOtherDocument(doc)}
                className="mt-5 w-full rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white hover:bg-blue-700"
              >
                {t("inbox.openDetail")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>

{selectedRecord && (
  <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-3 sm:items-center sm:p-4">
    <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-surface-1 p-5 shadow-2xl sm:p-8">

      <div className="flex items-center justify-between">
        <h2 className="text-3xl font-black">
          {t("inbox.documentDetailTitle")}
        </h2>

        <button
          onClick={() => setSelectedRecord(null)}
          className="rounded-xl bg-surface-2 px-4 py-2"
        >
          ✕
        </button>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-4">

        <Info title={t("inbox.typeLabel")} value={selectedRecord.document_type} />
        <Info title={t("inbox.movementLabel")} value={selectedRecord.movement_type} />
        <Info
          title={t("inbox.assignmentLabel")}
          value={
            selectedRecord.vehicle_id
              ? selectedRecord.spz
                ? t("inbox.vehicleAssignment", { value: selectedRecord.spz })
                : t("inbox.vehicleGroupLabel")
              : selectedRecord.machine_id
                ? selectedRecord.machine_label
                  ? t("inbox.machineAssignment", { value: selectedRecord.machine_label })
                  : t("inbox.machineLabel")
                : t("inbox.noAssignment")
          }
        />
        <Info title={t("inbox.plateLabel")} value={selectedRecord.spz} />
        <Info title={t("inbox.supplierLabel")} value={selectedRecord.supplier} />
        <Info title={t("inbox.customerLabel")} value={selectedRecord.customer} />
        <Info title={t("inbox.constructionSiteLabel")} value={selectedRecord.construction_site} />
        <Info title={t("inbox.materialLabel")} value={selectedRecord.material} />
        <Info title={t("inbox.quantityLabel")} value={selectedRecord.quantity} />
        <Info title={t("inbox.bruttoLabel")} value={selectedRecord.brutto} />
        <Info title={t("inbox.taraLabel")} value={selectedRecord.tara} />
        <Info title={t("inbox.nettoLabel")} value={selectedRecord.netto} />
        <Info
          title={t("inbox.unitLabel")}
          value={normalizeWeightUnit(selectedRecord.unit) || t("inbox.withoutUnit")}
        />
        <Info title={t("inbox.dateLabel")} value={selectedRecord.document_date} />
        <Info title={t("inbox.timeLabel")} value={selectedRecord.document_time} />

      </div>
      {selectedRecord.photo_url && (
  <div className="mt-5">
    <p className="mb-2 text-sm font-bold text-secondary">
      {t("inbox.originalDocument")}
    </p>

    {documentPhotoUrl ? (
      <a
        href={documentPhotoUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        <img
          src={documentPhotoUrl}
          alt={t("inbox.originalDocument")}
          className="max-h-[500px] w-full rounded-2xl border border-subtle object-contain"
        />
      </a>
    ) : (
      <p className="text-sm text-muted-esblu">
        {t("inbox.loadingPhoto")}
      </p>
    )}
  </div>
)}
      <button
        onClick={() => setSelectedRecord(null)}
        className="mt-8 w-full rounded-2xl bg-blue-600 py-4 font-bold text-white"
      > 
        {t("inbox.close")}
      </button>
{isOwnerOrAdmin(role) && (
<button
  onClick={() => deleteRecord(selectedRecord.id)}
  className="mt-3 w-full rounded-2xl bg-red-600 py-4 font-bold text-white"
>
  {t("inbox.deleteRecord")}
</button>
)}
    </div>
  </div>
)}
{selectedOtherDocument && (
  <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-3 sm:items-center sm:p-4">
    <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-surface-1 p-5 shadow-2xl sm:p-8">

      <div className="flex items-center justify-between">
        <h2 className="text-3xl font-black">
          {t("inbox.documentDetailTitle")}
        </h2>

        <button
          onClick={() => setSelectedOtherDocument(null)}
          className="rounded-xl bg-surface-2 px-4 py-2"
        >
          ✕
        </button>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-4">

        <Info
          title={t("inbox.typeLabel")}
          value={
            documentTypeLabels[
              selectedOtherDocument.document_type as ScanDocumentType
            ] || selectedOtherDocument.document_type
          }
        />
        <Info
          title={t("inbox.assignmentLabel")}
          value={describeDocumentAssignment(selectedOtherDocument)}
        />

        {(
          reviewOnlyFieldLabels[
            selectedOtherDocument.document_type as OtherDocumentType
          ] || []
        ).map(([field, label]) => (
          <Info
            key={field}
            title={label}
            value={selectedOtherDocument.extracted_fields?.[field]}
          />
        ))}

        <Info
          title={t("inbox.createdLabel")}
          value={
            selectedOtherDocument.created_at
              ? formatDateTime(selectedOtherDocument.created_at, locale)
              : null
          }
        />

      </div>

      {selectedOtherDocument.note && (
        <div className="mt-5 rounded-2xl bg-warning-soft p-4">
          <p className="text-sm font-bold text-amber-400">{t("inbox.noteLabel")}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-amber-400">
            {selectedOtherDocument.note}
          </p>
        </div>
      )}

      {selectedOtherDocument.storage_path && (
        <div className="mt-5">
          <p className="mb-2 text-sm font-bold text-secondary">
            {t("inbox.originalDocument")}
          </p>

          {otherDocumentPhotoUrl ? (
            <a
              href={otherDocumentPhotoUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                src={otherDocumentPhotoUrl}
                alt={t("inbox.originalDocument")}
                className="max-h-[500px] w-full rounded-2xl border border-subtle object-contain"
              />
            </a>
          ) : (
            <p className="text-sm text-muted-esblu">
              {t("inbox.loadingPhoto")}
            </p>
          )}

          <div className="mt-3 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => downloadOriginal(selectedOtherDocument)}
              className="rounded-2xl bg-surface-2 px-4 py-3 font-bold text-primary"
            >
              {t("inbox.download")}
            </button>
            <button
              type="button"
              onClick={() => printOriginal(selectedOtherDocument)}
              className="rounded-2xl bg-surface-2 px-4 py-3 font-bold text-primary"
            >
              {t("inbox.print")}
            </button>
          </div>
        </div>
      )}

      {selectedOtherDocument.document_type === "insurance" && (
        <div className="mt-6 rounded-2xl border border-subtle p-4">
          <p className="text-sm font-black text-primary">{t("inbox.attachmentsTitle")}</p>
          <p className="mt-1 text-xs text-muted-esblu">
            {t("inbox.attachmentsDescription")}
          </p>

          {attachmentsLoading ? (
            <p className="mt-3 text-sm text-muted-esblu">{t("inbox.loadingAttachments")}</p>
          ) : attachments.length === 0 ? (
            <p className="mt-3 text-sm text-muted-esblu">
              {t("inbox.noAttachmentsYet")}
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-primary">
                      {attachmentTypeLabels[attachment.attachment_type] ||
                        t("inbox.attachmentTypes.other")}
                    </p>
                    <p className="truncate text-xs text-muted-esblu">
                      {attachment.original_filename || t("inbox.noAttachmentName")}
                    </p>
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => openAttachment(attachment)}
                      className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white"
                    >
                      {t("inbox.open")}
                    </button>
                    {isOwnerOrAdmin(role) && (
                      <button
                        type="button"
                        onClick={() => deleteAttachment(attachment)}
                        disabled={deletingAttachmentId === attachment.id}
                        className="rounded-xl bg-danger-soft px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-50"
                      >
                        {deletingAttachmentId === attachment.id
                          ? t("inbox.deleting")
                          : t("inbox.delete")}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <select
              value={newAttachmentType}
              onChange={(e) => setNewAttachmentType(e.target.value)}
              className="rounded-xl border border-subtle bg-surface-1 px-3 py-3 text-sm outline-none sm:flex-1"
            >
              {Object.entries(attachmentTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <label
              className={`rounded-xl px-4 py-3 text-center text-sm font-bold ${
                isUploadingAttachment
                  ? "cursor-not-allowed bg-surface-2 text-muted-esblu"
                  : "cursor-pointer bg-blue-600 text-white"
              }`}
            >
              {isUploadingAttachment ? t("inbox.uploading") : t("inbox.addAttachment")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="hidden"
                disabled={isUploadingAttachment || legalHold}
                onChange={handleAttachmentUpload}
              />
            </label>
          </div>
        </div>
      )}

      <button
        onClick={() => setSelectedOtherDocument(null)}
        className="mt-8 w-full rounded-2xl bg-blue-600 py-4 font-bold text-white"
      >
        {t("inbox.close")}
      </button>

      {isOwnerOrAdmin(role) && (
      <button
        onClick={() => deleteOtherDocument(selectedOtherDocument)}
        disabled={deletingDocumentId === selectedOtherDocument.id}
        className="mt-3 w-full rounded-2xl bg-red-600 py-4 font-bold text-white disabled:opacity-60"
      >
        {deletingDocumentId === selectedOtherDocument.id
          ? t("inbox.deleting")
          : t("inbox.deleteDocument")}
      </button>
      )}
    </div>
  </div>
)}

{/* Review prijatej faktúry. Otvára sa až keď je zdrojový dokument uložený
    (potrebuje jeho id). Zrušenie review dokument NEMAŽE — ostáva v Inboxe. */}
{receivedCandidate && companyId && (
  <ReceivedInvoiceReview
    candidate={receivedCandidate}
    companyId={companyId}
    userId={currentUserId}
    onCancel={() => setReceivedCandidate(null)}
    onCreated={(invoiceId) => {
      setReceivedCandidate(null);
      setCreatedReceivedInvoiceId(invoiceId);
      resetScanReview();
      setSelectedFile(null);
      setFileName("");
      void loadOtherDocuments();
    }}
  />
)}

{/* Potvrdenie po vytvorení draftu. Zámerne NEPRESMEROVÁVA automaticky —
    používateľ môže chcieť rovno spracovať ďalší doklad z Inboxu. */}
{createdReceivedInvoiceId && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <div className="w-full max-w-md rounded-3xl bg-surface-1 p-6 text-center">
      <h3 className="text-xl font-black text-primary">
        {t("inbox.receivedInvoice.created.title")}
      </h3>
      <p className="mt-2 text-sm text-muted-esblu">
        {t("inbox.receivedInvoice.created.body")}
      </p>
      <a
        href={invoiceDetailHref(createdReceivedInvoiceId)}
        className="mt-5 block w-full rounded-2xl bg-accent-esblu px-6 py-4 font-black text-on-accent"
      >
        {t("inbox.receivedInvoice.created.openInvoice")}
      </a>
      <button
        onClick={() => setCreatedReceivedInvoiceId(null)}
        className="mt-3 w-full rounded-2xl border border-subtle px-6 py-4 font-bold text-primary"
      >
        {t("inbox.receivedInvoice.created.stayInInbox")}
      </button>
    </div>
  </div>
)}
      </div>
    </main>
  );
}
