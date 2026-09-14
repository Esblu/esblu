import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import { vehicleDetailHref, machineDetailHref } from "@/lib/entity-links";
import { vignetteCountryLabel, type VehicleVignette } from "@/lib/vehicle-vignettes";

// =============================================================================
// Esblu — jednotný Deadline Engine (Fáza "Intent Engine + automatické
// upozornenia na lehoty").
// =============================================================================
// Predtým žila táto logika iba INLINE v app/components/Dashboard.tsx
// (createAlerts()/checkDate() — 30-dňový prah, iba STK/EK/diaľničné
// známky). Zadanie výslovne žiada: "Nerob hardcoded čísla roztrúsené po
// UI. Daj ich do spoločnej konfigurácie/helpera." a "Nechcem hardcoded
// separátnu logiku pre STK, EK, známku atď."
//
// Tento modul je teraz JEDINÝ zdroj pravdy pre:
//   - prahové hodnoty (DEADLINE_THRESHOLD_DAYS),
//   - výpočet stavu/závažnosti (computeDeadlineStatus),
//   - zoskupenie do DeadlineItem[] pre vozidlá aj stroje.
//
// Dashboard.tsx aj nové Intent Engine handlery (lib/intents/handlers.ts)
// volajú VÝHRADNE tento modul — žiadna z nich nemá vlastnú kópiu 30/60-
// dňovej logiky.
//
// PZP (havarijné/zákonné poistenie) je ZÁMERNE MIMO tohto enginu: appka
// dnes neeviduje platnosť PZP ako štruktúrovaný dátumový stĺpec na
// vozidle (public.vehicles nemá taký stĺpec) — PZP existuje iba ako
// voľne extrahovaný `extracted_fields.insuranceFields.validTo` na
// jednotlivom AI dokumente (public.documents, document_type='insurance'),
// čo môže byť 0..N dokumentov na vozidlo bez jednoznačného poradia.
// Pridať PZP sem by znamenalo buď hádať, ktorý dokument je "aktuálna"
// zmluva, alebo hromadne query-ovať extracted_fields pre KAŽDÉ vozidlo
// firmy pri každom Dashboard loade (N+1/performance riziko, bod 17
// zadania). Namiesto domýšľania PZP dátumu tu ho lib/vehicle-report.ts
// zobrazuje iba ako best-effort READ (posledný priradený PZP dokument),
// nikdy ako aktívne "upozornenie na lehotu" — pozri komentár tam.
// =============================================================================

export type DeadlineSeverity = "overdue" | "urgent" | "due_soon" | "upcoming";

// Jediné miesto, kde sú tieto čísla definované (zadanie, bod 8):
//   po lehote                → overdue
//   0–7 dní                  → urgent
//   8–30 dní                 → due_soon
//   31–60 dní                → upcoming
//   nad 60 dní                → sa nepovažuje za aktívne upozornenie (null)
export const DEADLINE_THRESHOLD_DAYS = {
  urgent: 7,
  dueSoon: 30,
  upcoming: 60,
} as const;

// Dashboardové "STK/EK/známky" UI (existujúce pred touto úlohou) pracovalo
// vždy s jediným 30-dňovým prahom a dvomi farbami (červená/oranžová).
// Aby prepojenie Dashboardu na tento zdieľaný engine bolo 100% vizuálne
// bezregresné, DEADLINE_LEGACY_DASHBOARD_WINDOW_DAYS = DEADLINE_THRESHOLD_DAYS.dueSoon
// zostáva jediným prahom, ktorý Dashboard naďalej zobrazuje priamo v
// hlavnom paneli (urgent aj due_soon spolu = pôvodné "oranžové" pásmo).
// "upcoming" (31-60) sa v Dashboard paneli dnes nezobrazuje vôbec — presne
// ako to zadanie pripúšťa ("nad 60 dní nemusí byť aktívne upozornenie");
// tu ide o 31-60 pásmo, ktoré je k dispozícii cez Intent Engine (napr.
// "čo mi končí tento mesiac"), ale Dashboard vizuál sa zámerne nemení.
export const DEADLINE_LEGACY_DASHBOARD_WINDOW_DAYS = DEADLINE_THRESHOLD_DAYS.dueSoon;

export type DeadlineEntityType = "vehicle" | "machine";

export type DeadlineType =
  | "vehicle_stk"
  | "vehicle_ek"
  | "vehicle_vignette"
  | "vehicle_service"
  | "machine_service";

export type DeadlineItem = {
  entityType: DeadlineEntityType;
  entityId: string;
  entityLabel: string;
  deadlineType: DeadlineType;
  dueDate: string;
  daysRemaining: number;
  severity: DeadlineSeverity;
  targetRoute: string;
  // Krajina pre vehicle_vignette (na zostavenie čitateľného labelu) —
  // voliteľné, iba pre tento jeden deadlineType.
  vignetteCountryCode?: string;
};

export type MinimalVehicle = {
  id: string;
  spz: string | null;
  znacka: string | null;
  model: string | null;
  stk: string | null;
  ek: string | null;
};

export type MinimalMachine = {
  id: string;
  name: string | null;
  category: string | null;
};

export type MinimalServiceRecord = {
  vehicle_id?: string | null;
  machine_id?: string | null;
  service_date: string | null;
  next_service_date: string | null;
};

/**
 * Vypočíta stav jedného dátumu voči "dnes". Vracia null pre chýbajúci/
 * neplatný dátum ALEBO pre dátum viac než DEADLINE_THRESHOLD_DAYS.upcoming
 * dní v budúcnosti (zadanie: "nad 60 dní nemusí byť aktívne upozornenie" —
 * tento engine ich preto vôbec negeneruje ako DeadlineItem, aby sa
 * "neaktívne" položky netreba filtrovať opakovane na každom mieste, kde sa
 * tento modul používa).
 */
export function computeDeadlineStatus(
  dueDateIso: string | null | undefined,
  today: Date = new Date()
): { severity: DeadlineSeverity; daysRemaining: number } | null {
  if (!dueDateIso) return null;

  const due = new Date(dueDateIso);
  if (Number.isNaN(due.getTime())) return null;

  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );
  const daysRemaining = Math.ceil(
    (due.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysRemaining < 0) return { severity: "overdue", daysRemaining };
  if (daysRemaining <= DEADLINE_THRESHOLD_DAYS.urgent)
    return { severity: "urgent", daysRemaining };
  if (daysRemaining <= DEADLINE_THRESHOLD_DAYS.dueSoon)
    return { severity: "due_soon", daysRemaining };
  if (daysRemaining <= DEADLINE_THRESHOLD_DAYS.upcoming)
    return { severity: "upcoming", daysRemaining };

  return null;
}

function vehicleLabel(vehicle: MinimalVehicle): string {
  const name = `${vehicle.znacka || ""} ${vehicle.model || ""}`.trim();
  return vehicle.spz ? `${vehicle.spz}${name ? ` (${name})` : ""}` : name || vehicle.id;
}

/**
 * Pre danú entitu (vehicle_id ALEBO machine_id) nájde servisný záznam s
 * najnovším service_date (t.j. posledný reálne vykonaný servis) a vráti
 * jeho next_service_date — presne to je "ďalší servis, ak je evidovaný" zo
 * zadania. Viacero servisných záznamov na entitu je bežné (história), preto
 * sa nikdy nepoužije "ktorýkoľvek" next_service_date, iba ten z
 * najaktuálnejšieho záznamu.
 */
function latestNextServiceByEntity(
  services: MinimalServiceRecord[],
  key: "vehicle_id" | "machine_id"
): Map<string, string | null> {
  const latestServiceDateByEntity = new Map<string, string>();
  const nextServiceByEntity = new Map<string, string | null>();

  for (const service of services) {
    const entityId = service[key];
    if (!entityId || !service.service_date) continue;

    const currentLatest = latestServiceDateByEntity.get(entityId);
    if (!currentLatest || service.service_date > currentLatest) {
      latestServiceDateByEntity.set(entityId, service.service_date);
      nextServiceByEntity.set(entityId, service.next_service_date || null);
    }
  }

  return nextServiceByEntity;
}

export function buildVehicleDeadlines(
  vehicles: MinimalVehicle[],
  vignettes: VehicleVignette[],
  vehicleServices: MinimalServiceRecord[],
  locale: Locale,
  today: Date = new Date()
): DeadlineItem[] {
  const items: DeadlineItem[] = [];
  const nextServiceByVehicle = latestNextServiceByEntity(
    vehicleServices,
    "vehicle_id"
  );

  for (const vehicle of vehicles) {
    const label = vehicleLabel(vehicle);
    const route = vehicleDetailHref(vehicle.id);

    const stkStatus = computeDeadlineStatus(vehicle.stk, today);
    if (stkStatus) {
      items.push({
        entityType: "vehicle",
        entityId: vehicle.id,
        entityLabel: label,
        deadlineType: "vehicle_stk",
        dueDate: vehicle.stk as string,
        ...stkStatus,
        targetRoute: route,
      });
    }

    const ekStatus = computeDeadlineStatus(vehicle.ek, today);
    if (ekStatus) {
      items.push({
        entityType: "vehicle",
        entityId: vehicle.id,
        entityLabel: label,
        deadlineType: "vehicle_ek",
        dueDate: vehicle.ek as string,
        ...ekStatus,
        targetRoute: route,
      });
    }

    for (const vignette of vignettes) {
      if (vignette.vehicle_id !== vehicle.id) continue;
      const vignetteStatus = computeDeadlineStatus(vignette.valid_until, today);
      if (!vignetteStatus) continue;
      items.push({
        entityType: "vehicle",
        entityId: vehicle.id,
        entityLabel: label,
        deadlineType: "vehicle_vignette",
        dueDate: vignette.valid_until,
        ...vignetteStatus,
        targetRoute: route,
        vignetteCountryCode: vignette.country_code,
      });
    }

    const nextService = nextServiceByVehicle.get(vehicle.id);
    const serviceStatus = computeDeadlineStatus(nextService, today);
    if (serviceStatus) {
      items.push({
        entityType: "vehicle",
        entityId: vehicle.id,
        entityLabel: label,
        deadlineType: "vehicle_service",
        dueDate: nextService as string,
        ...serviceStatus,
        targetRoute: route,
      });
    }
  }

  return items;
}

export function buildMachineDeadlines(
  machines: MinimalMachine[],
  machineServices: MinimalServiceRecord[],
  today: Date = new Date()
): DeadlineItem[] {
  const items: DeadlineItem[] = [];
  const nextServiceByMachine = latestNextServiceByEntity(
    machineServices,
    "machine_id"
  );

  for (const machine of machines) {
    const label = machine.name || machine.id;
    const route = machineDetailHref(machine.id);
    const nextService = nextServiceByMachine.get(machine.id);
    const serviceStatus = computeDeadlineStatus(nextService, today);

    if (serviceStatus) {
      items.push({
        entityType: "machine",
        entityId: machine.id,
        entityLabel: label,
        deadlineType: "machine_service",
        dueDate: nextService as string,
        ...serviceStatus,
        targetRoute: route,
      });
    }
  }

  return items;
}

/**
 * Preložený, človekom čitateľný typ termínu (napr. pre Intent Engine
 * odpovede a pre nové "upcoming" zoznamy) — jediné miesto, kde sa
 * deadlineType mapuje na i18n kľúč.
 */
export function deadlineTypeLabel(
  deadlineType: DeadlineType,
  locale: Locale,
  vignetteCountryCode?: string
): string {
  if (deadlineType === "vehicle_vignette") {
    const country = vignetteCountryCode
      ? vignetteCountryLabel(vignetteCountryCode, locale)
      : "";
    return country
      ? translate(locale, "dashboard.vignetteLabel") + ` (${country})`
      : translate(locale, "dashboard.vignetteLabel");
  }

  const key: Record<Exclude<DeadlineType, "vehicle_vignette">, string> = {
    vehicle_stk: "dashboard.stkLabel",
    vehicle_ek: "dashboard.ekLabel",
    vehicle_service: "search.deadlineTypeLabels.vehicleService",
    machine_service: "search.deadlineTypeLabels.machineService",
  };

  return translate(locale, key[deadlineType as keyof typeof key]);
}

export function deadlineSeverityLabel(
  severity: DeadlineSeverity,
  locale: Locale
): string {
  return translate(locale, `search.deadlineSeverity.${severity}`);
}

// -----------------------------------------------------------------------------
// Spätná kompatibilita s pôvodným Dashboard.tsx UI (level "red"/"orange",
// presne rovnaký text cez existujúce i18n kľúče dashboard.alertOverdue /
// dashboard.alertDueSoon). "upcoming" (31-60 dní) sa do tohto zoznamu
// ZÁMERNE nedostane — zachováva to presne pôvodné 30-dňové okno a farby,
// nulová vizuálna regresia Dashboardu. Volajúci (Dashboard.tsx) dostáva iba
// tenký prekladový wrapper nad buildVehicleDeadlines(); počíta sa to isté,
// iba raz, na jednom mieste.
// -----------------------------------------------------------------------------
export type LegacyDashboardAlert = {
  level: "red" | "orange";
  type: string;
  message: string;
  vehicleId: string;
};

export function buildLegacyDashboardAlerts(
  vehicles: MinimalVehicle[],
  vignettes: VehicleVignette[],
  locale: Locale,
  today: Date = new Date()
): LegacyDashboardAlert[] {
  // next_service_date sa do PÔVODNÉHO Dashboard panelu zámerne nepridáva —
  // pred touto úlohou Dashboard servisné termíny vôbec nesledoval a jeho
  // vizuál/rozsah meniť nemáme (bod zadania "Regression: Dashboard musí
  // zostať funkčný"). Servisné termíny sú novo dostupné cez Intent Engine
  // ("aké termíny treba riešiť") a cez detail vozidla/stroja (pozri
  // VehicleDetailView.tsx / MachineDetailView.tsx), nie cez tento legacy
  // panel.
  const deadlines = buildVehicleDeadlines(vehicles, vignettes, [], locale, today);

  return deadlines
    .filter((item) => item.severity === "overdue" || item.severity === "urgent" || item.severity === "due_soon")
    .map((item) => {
      const type = deadlineTypeLabel(item.deadlineType, locale, item.vignetteCountryCode);
      const vehicle = vehicles.find((v) => v.id === item.entityId);
      const name =
        `${vehicle?.znacka || ""} ${vehicle?.model || ""}`.trim() ||
        translate(locale, "dashboard.vehicleFallbackName");
      const spz = vehicle?.spz || translate(locale, "dashboard.noPlate");

      const message =
        item.severity === "overdue"
          ? translate(locale, "dashboard.alertOverdue", { type, name, spz })
          : translate(locale, "dashboard.alertDueSoon", {
              type,
              name,
              spz,
              days: item.daysRemaining,
            });

      return {
        level: item.severity === "overdue" ? "red" : "orange",
        type,
        message,
        vehicleId: item.entityId,
      } as LegacyDashboardAlert;
    });
}
