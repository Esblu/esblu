import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeDeadlineStatus,
  type DeadlineSeverity,
} from "@/lib/deadlines";
import type { VehicleVignette } from "@/lib/vehicle-vignettes";

// =============================================================================
// Esblu — jednotný "Vehicle Report" dátový model (zadanie, bod 5).
// =============================================================================
// DÔLEŽITÉ: toto NIE JE nová AI funkcia — je to čisté, deterministické
// NAČÍTANIE existujúcich tabuliek (vehicles, vehicle_services,
// vehicle_vignettes, documents+document_links) do jedného objektu. Žiadne
// číslo/dátum tu nikdy nepochádza z AI ani sa nedomýšľa — presne podľa
// požiadavky "Report má načítať reálne dáta... čísla/dátumy musia
// pochádzať z DB... Ak údaj nie je → 'Nie je evidované'." Chýbajúce
// hodnoty sa preto vracajú ako `null` a PREKLAD/zobrazenie "Nie je
// evidované" rieši volajúca UI vrstva cez i18n (nikdy natvrdo tu).
//
// Query vzor (RLS-scoped, žiadny nový, žiadny service_role) je zámerne
// zhodný s tým, čo už dnes robí app/vozidla/VehicleDetailView.tsx
// (loadLinkedDocuments) — tento modul iba extrahuje rovnakú logiku do
// zdieľaného miesta, aby ju mohol použiť aj Intent Engine
// (VEHICLE_REPORT), bez toho, aby čo i len jeden riadok VehicleDetailView.tsx
// menil (nulové regresné riziko pre existujúcu obrazovku).
// =============================================================================

export type VehicleServiceRecord = {
  id: string;
  service_date: string;
  mileage: number;
  title: string;
  description: string;
  cost: number;
  technician: string;
  next_service_date: string | null;
};

export type VehicleReportInsurance = {
  documentId: string;
  provider: string | null;
  policyNumber: string | null;
  validFrom: string | null;
  validTo: string | null;
};

export type VehicleReportRegistration = {
  documentId: string;
  present: true;
};

export type VehicleReport = {
  vehicle: {
    id: string;
    spz: string | null;
    vin: string | null;
    znacka: string | null;
    model: string | null;
    rokVyroby: number | null;
    stk: string | null;
    ek: string | null;
  };
  stkStatus: { severity: DeadlineSeverity; daysRemaining: number } | null;
  ekStatus: { severity: DeadlineSeverity; daysRemaining: number } | null;
  vignettes: VehicleVignette[];
  // Najnovší priradený PZP dokument tohto vozidla (podľa created_at), ak
  // existuje — BEST-EFFORT READ, nikdy nie je súčasťou aktívneho deadline
  // enginu (pozri komentár v lib/deadlines.ts). Ak firma nemá k vozidlu
  // priradený žiadny PZP dokument, je null a report to zobrazí ako "Nie je
  // evidované" — nikdy sa nehádá, ktorý dokument "asi" platí.
  latestInsurance: VehicleReportInsurance | null;
  // Existuje aspoň jeden priradený technický preukaz (vehicle_registration)?
  hasRegistrationDocument: boolean;
  serviceHistory: VehicleServiceRecord[];
  lastService: VehicleServiceRecord | null;
  nextServiceDate: string | null;
  nextServiceStatus: { severity: DeadlineSeverity; daysRemaining: number } | null;
  totalServiceCostAllTime: number;
  totalServiceCostThisYear: number;
};

export async function buildVehicleReport(
  supabase: SupabaseClient,
  vehicleId: string
): Promise<VehicleReport | null> {
  const { data: vehicle, error: vehicleError } = await supabase
    .from("vehicles")
    .select("id, spz, vin, znacka, model, rok_vyroby, stk, ek")
    .eq("id", vehicleId)
    .maybeSingle();

  if (vehicleError || !vehicle) {
    if (vehicleError) {
      console.error("buildVehicleReport: načítanie vozidla zlyhalo:", vehicleError.message);
    }
    return null;
  }

  const [servicesResult, vignettesResult, documentsResult] = await Promise.all([
    supabase
      .from("vehicle_services")
      .select(
        "id, service_date, mileage, title, description, cost, technician, next_service_date"
      )
      .eq("vehicle_id", vehicleId)
      .order("service_date", { ascending: false }),
    supabase
      .from("vehicle_vignettes")
      .select("*")
      .eq("vehicle_id", vehicleId),
    // Rovnaký join-cez-document_links vzor ako
    // VehicleDetailView.tsx#loadLinkedDocuments — iba PZP a TP typy, iba
    // dokumenty priradené k TOMUTO vozidlu.
    supabase
      .from("documents")
      .select(
        "id, document_type, extracted_fields, created_at, document_links!inner(vehicle_id)"
      )
      .eq("document_links.vehicle_id", vehicleId)
      .in("document_type", ["insurance", "vehicle_registration"])
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
  ]);

  const serviceHistory = (servicesResult.data as VehicleServiceRecord[]) || [];
  const vignettes = (vignettesResult.data as VehicleVignette[]) || [];
  const documents =
    (documentsResult.data as {
      id: string;
      document_type: string;
      extracted_fields: Record<string, unknown> | null;
      created_at: string;
    }[]) || [];

  if (servicesResult.error) {
    console.error(
      "buildVehicleReport: načítanie servisnej histórie zlyhalo:",
      servicesResult.error.message
    );
  }
  if (vignettesResult.error) {
    console.error(
      "buildVehicleReport: načítanie diaľničných známok zlyhalo:",
      vignettesResult.error.message
    );
  }
  if (documentsResult.error) {
    console.error(
      "buildVehicleReport: načítanie priradených dokumentov zlyhalo:",
      documentsResult.error.message
    );
  }

  const latestInsuranceDoc = documents.find((d) => d.document_type === "insurance");
  const latestInsurance: VehicleReportInsurance | null = latestInsuranceDoc
    ? {
        documentId: latestInsuranceDoc.id,
        provider: readStringField(latestInsuranceDoc.extracted_fields, "provider"),
        policyNumber: readStringField(
          latestInsuranceDoc.extracted_fields,
          "policyNumber"
        ),
        validFrom: readStringField(latestInsuranceDoc.extracted_fields, "validFrom"),
        validTo: readStringField(latestInsuranceDoc.extracted_fields, "validTo"),
      }
    : null;

  const hasRegistrationDocument = documents.some(
    (d) => d.document_type === "vehicle_registration"
  );

  const lastService = serviceHistory[0] ?? null;
  const nextServiceDate = lastService?.next_service_date ?? null;

  const now = new Date();
  const currentYear = now.getFullYear();
  const totalServiceCostAllTime = serviceHistory.reduce(
    (sum, s) => sum + (Number.isFinite(s.cost) ? s.cost : 0),
    0
  );
  const totalServiceCostThisYear = serviceHistory
    .filter((s) => s.service_date && new Date(s.service_date).getFullYear() === currentYear)
    .reduce((sum, s) => sum + (Number.isFinite(s.cost) ? s.cost : 0), 0);

  return {
    vehicle: {
      id: vehicle.id,
      spz: vehicle.spz,
      vin: vehicle.vin,
      znacka: vehicle.znacka,
      model: vehicle.model,
      rokVyroby: vehicle.rok_vyroby,
      stk: vehicle.stk,
      ek: vehicle.ek,
    },
    stkStatus: computeDeadlineStatus(vehicle.stk, now),
    ekStatus: computeDeadlineStatus(vehicle.ek, now),
    vignettes,
    latestInsurance,
    hasRegistrationDocument,
    serviceHistory,
    lastService,
    nextServiceDate,
    nextServiceStatus: computeDeadlineStatus(nextServiceDate, now),
    totalServiceCostAllTime,
    totalServiceCostThisYear,
  };
}

function readStringField(
  fields: Record<string, unknown> | null,
  key: string
): string | null {
  if (!fields) return null;
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value : null;
}

// -----------------------------------------------------------------------------
// Machine report — analogický, ale výrazne užší model: stroje nemajú
// STK/EK/PZP/TP ani diaľničné známky v dnešnej schéme (public.machines),
// iba servisnú históriu (public.machine_services). Report preto obsahuje
// iba to, čo appka SKUTOČNE eviduje — žiadne "Nie je evidované" riadky pre
// polia, ktoré pri strojoch v schéme vôbec neexistujú (na rozdiel od
// vozidla, kde "Nie je evidované" znamená konkrétne PZP/TP/STK/EK).
// -----------------------------------------------------------------------------

export type MachineServiceRecord = VehicleServiceRecord;

export type MachineReport = {
  machine: {
    id: string;
    name: string | null;
    category: string | null;
    manufacturer: string | null;
    model: string | null;
    serialNumber: string | null;
    status: string | null;
  };
  serviceHistory: MachineServiceRecord[];
  lastService: MachineServiceRecord | null;
  nextServiceDate: string | null;
  nextServiceStatus: { severity: DeadlineSeverity; daysRemaining: number } | null;
  totalServiceCostAllTime: number;
  totalServiceCostThisYear: number;
};

export async function buildMachineReport(
  supabase: SupabaseClient,
  machineId: string
): Promise<MachineReport | null> {
  const { data: machine, error: machineError } = await supabase
    .from("machines")
    .select("id, name, category, manufacturer, model, serial_number, status")
    .eq("id", machineId)
    .maybeSingle();

  if (machineError || !machine) {
    if (machineError) {
      console.error("buildMachineReport: načítanie stroja zlyhalo:", machineError.message);
    }
    return null;
  }

  const { data: services, error: servicesError } = await supabase
    .from("machine_services")
    .select(
      "id, service_date, mileage, title, description, cost, technician, next_service_date"
    )
    .eq("machine_id", machineId)
    .order("service_date", { ascending: false });

  if (servicesError) {
    console.error(
      "buildMachineReport: načítanie servisnej histórie zlyhalo:",
      servicesError.message
    );
  }

  const serviceHistory = (services as MachineServiceRecord[]) || [];
  const lastService = serviceHistory[0] ?? null;
  const nextServiceDate = lastService?.next_service_date ?? null;
  const now = new Date();
  const currentYear = now.getFullYear();

  const totalServiceCostAllTime = serviceHistory.reduce(
    (sum, s) => sum + (Number.isFinite(s.cost) ? s.cost : 0),
    0
  );
  const totalServiceCostThisYear = serviceHistory
    .filter((s) => s.service_date && new Date(s.service_date).getFullYear() === currentYear)
    .reduce((sum, s) => sum + (Number.isFinite(s.cost) ? s.cost : 0), 0);

  return {
    machine: {
      id: machine.id,
      name: machine.name,
      category: machine.category,
      manufacturer: machine.manufacturer,
      model: machine.model,
      serialNumber: machine.serial_number,
      status: machine.status,
    },
    serviceHistory,
    lastService,
    nextServiceDate,
    nextServiceStatus: computeDeadlineStatus(nextServiceDate, now),
    totalServiceCostAllTime,
    totalServiceCostThisYear,
  };
}
