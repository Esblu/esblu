import { computeDeadlineStatus, type DeadlineSeverity } from "@/lib/deadlines";

// =============================================================================
// Vozidlá — typy a ODVODENÉ ukazovatele pre register.
//
// ŽIADNA NOVÁ DB ZMENA. Všetko nižšie počíta z už existujúcich stĺpcov.
//
// Čo tabuľka `vehicles` má: spz, vin, znacka, model, rok_vyroby, palivo,
// objem, vykon, farba, hmotnost, pocet_miest, datum_prvej_evidencie,
// stk, ek.
//
// Čo NEMÁ a preto to register nesmie predstierať (nahlásené ako gap):
//   • status vozidla — na rozdiel od `machines` tu žiadny stĺpec nie je
//   • najazdené km — existuje len vehicle_services.mileage, teda stav pri
//     poslednom servise
//   • poistenie/PZP — žije výhradne ako documents.extracted_fields na
//     doklade typu 'insurance' a lib/deadlines.ts ho zámerne do termínov
//     nezaraďuje; register ho preto tiež neukazuje ako stav vozidla
//
// Prahy termínov sa NEDEFINUJÚ tu — preberajú sa z lib/deadlines.ts, aby
// jedno STK nebolo "po termíne" na dashboarde a "v poriadku" v registri.
// =============================================================================

export type VehicleRow = {
  id: string;
  spz: string;
  vin: string | null;
  znacka: string | null;
  model: string | null;
  rok_vyroby: number | null;
  palivo: string | null;
  objem: number | null;
  vykon: string | null;
  farba: string | null;
  hmotnost: number | null;
  pocet_miest: number | null;
  datum_prvej_evidencie: string | null;
  stk: string | null;
  ek: string | null;
  company_id: string;
  /** Doplnené klientom z vehicle_photos, nie stĺpec tabuľky. */
  first_photo_url?: string | null;
};

export type InspectionState = {
  /** null = dátum nie je vyplnený, nevieme nič tvrdiť. */
  severity: DeadlineSeverity | null;
  /** true iba keď dátum EXISTUJE a je v poriadku (mimo varovného okna). */
  ok: boolean;
};

/**
 * Stav jednej kontroly (STK alebo EK).
 *
 * Rozlišujeme tri veci, ktoré sa ľahko zamieňajú:
 *   • dátum nevyplnený  -> severity null, ok false  ("nevieme")
 *   • dátum po termíne  -> severity "overdue"       ("problém")
 *   • dátum v poriadku  -> severity null, ok true   ("v poriadku")
 * Prázdne STK nesmie vyzerať ako platné STK.
 */
export function inspectionState(date: string | null | undefined): InspectionState {
  if (!date) return { severity: null, ok: false };
  const status = computeDeadlineStatus(date);
  if (!status) return { severity: null, ok: true };
  return { severity: status.severity, ok: false };
}

/** Najhorší zo stavov STK a EK — to, čo má register ukázať na riadku. */
export function vehicleAttention(vehicle: VehicleRow): DeadlineSeverity | null {
  const order: DeadlineSeverity[] = ["overdue", "urgent", "due_soon", "upcoming"];
  const states = [inspectionState(vehicle.stk).severity, inspectionState(vehicle.ek).severity];
  for (const severity of order) {
    if (states.includes(severity)) return severity;
  }
  return null;
}

export function vehicleFuels(vehicles: VehicleRow[]): string[] {
  const seen = new Set<string>();
  for (const vehicle of vehicles) {
    const fuel = vehicle.palivo?.trim();
    if (fuel) seen.add(fuel);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Fulltext nad poliami, ktoré má vozidlo vyplnené. ŠPZ sa porovnáva aj v
 * tvare bez medzier a pomlčiek, aby "BA123AB" našlo "BA-123AB".
 */
export function matchesVehicleQuery(vehicle: VehicleRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;

  const compact = (value: string) => value.toLowerCase().replace(/[\s-]/g, "");
  const needleCompact = compact(needle);

  if (vehicle.spz && compact(vehicle.spz).includes(needleCompact)) return true;

  return [vehicle.vin, vehicle.znacka, vehicle.model, vehicle.palivo, vehicle.farba]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(needle));
}

/** Označenie vozidla pre nadpisy a aria-label. Nikdy nevráti prázdny reťazec. */
export function vehicleTitle(vehicle: VehicleRow, fallback: string): string {
  const name = [vehicle.znacka, vehicle.model].filter(Boolean).join(" ").trim();
  return name || vehicle.spz || fallback;
}
