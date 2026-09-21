import { computeDeadlineStatus } from "@/lib/deadlines";

// =============================================================================
// Stroje — typy a ODVODENÉ ukazovatele.
//
// DÔLEŽITÉ: tento súbor NEPRIDÁVA žiadne databázové pole.
//
// Tabuľka `machines` nemá motohodiny, nemá dátum posledného ani ďalšieho
// servisu a nemá inventárne číslo. Všetko, čo tu počítame, je odvodené
// z už existujúcich riadkov `machine_services`, ktoré appka aj tak načítava.
// Bez tejto vrstvy by si rovnakú logiku musel napísať zoznam aj detail —
// a časom by sa rozišli (zoznam by ukazoval iné "ďalší servis" než detail).
//
// Čo v modeli CHÝBA a preto to UI nemôže zobraziť (nahlásené ako gap, nie
// dopĺňané naslepo):
//   • machines.status je voľný text bez CHECK constraintu ani enumerácie —
//     nedá sa z neho spraviť spoľahlivý stavový model, iba ho zobraziť.
//   • aktuálne motohodiny stroja — existuje len machine_services.mileage,
//     teda stav pri poslednom servise, nie dnešný.
//   • inventárne číslo, umiestnenie, priradenie operátora — neexistujú.
// =============================================================================

export type MachineRow = {
  id: string;
  name: string | null;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  year: number | null;
  purchase_date: string | null;
  status: string | null;
  notes: string | null;
  created_at: string;
  company_id: string;
  /** Doplnené klientom z machine_photos, nie stĺpec tabuľky. */
  first_photo_url?: string | null;
};

export type MachineServiceRow = {
  id: string;
  machine_id: string | null;
  service_date: string | null;
  mileage: number | null;
  title: string | null;
  description: string | null;
  cost: number | null;
  technician: string | null;
  next_service_date: string | null;
};

export type MachineServiceSummary = {
  /** Dátum najnovšieho servisu. */
  lastServiceDate: string | null;
  /**
   * Motohodiny zaznamenané pri najnovšom servise, ktorý ich vôbec uvádza.
   * Je to POSLEDNÝ ZNÁMY stav, nie aktuálny — UI to musí označiť.
   */
  lastKnownMileage: number | null;
  /** next_service_date najnovšieho servisu — rovnaká logika ako Deadline Engine. */
  nextServiceDate: string | null;
  serviceCount: number;
  /** Súčet cien; null keď žiadny servis cenu neuvádza (nie 0 — to by klamalo). */
  totalCost: number | null;
};

const EMPTY_SUMMARY: MachineServiceSummary = {
  lastServiceDate: null,
  lastKnownMileage: null,
  nextServiceDate: null,
  serviceCount: 0,
  totalCost: null,
};

/**
 * `services` musí byť zoradené service_date DESC — rovnako, ako ich
 * načítava detail stroja aj Deadline Engine. Poradie tu neprepočítavame,
 * aby sa "najnovší servis" nikdy nelíšil od toho, čo vidí používateľ
 * v časovej osi.
 */
export function summarizeMachineServices(
  services: MachineServiceRow[]
): MachineServiceSummary {
  if (services.length === 0) return EMPTY_SUMMARY;

  const withMileage = services.find(
    (service) => service.mileage !== null && service.mileage !== undefined
  );

  const costs = services
    .map((service) => service.cost)
    .filter((cost): cost is number => typeof cost === "number" && Number.isFinite(cost));

  return {
    lastServiceDate: services[0]?.service_date ?? null,
    lastKnownMileage: withMileage?.mileage ?? null,
    nextServiceDate: services[0]?.next_service_date ?? null,
    serviceCount: services.length,
    totalCost: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
  };
}

export type ServiceAttention = "overdue" | "due_soon" | "ok" | "unknown";

/**
 * Pozor na servis. Prahy NEVYMÝŠĽAME — preberáme presne tie, ktoré už
 * appka používa pre Dashboard, Intent Engine aj upozornenia na vozidlách
 * (lib/deadlines.ts). Jeden termín nesmie byť "po splatnosti" na dashboarde
 * a "v poriadku" na detaile stroja.
 */
export function machineServiceAttention(
  nextServiceDate: string | null | undefined
): ServiceAttention {
  if (!nextServiceDate) return "unknown";
  const status = computeDeadlineStatus(nextServiceDate);
  if (!status) return "ok";
  if (status.severity === "overdue") return "overdue";
  return "due_soon";
}

/** Zoznam odlišných kategórií pre filter. Prázdne a duplicitné vypadávajú. */
export function machineCategories(machines: MachineRow[]): string[] {
  const seen = new Set<string>();
  for (const machine of machines) {
    const category = machine.category?.trim();
    if (category) seen.add(category);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Fulltext cez polia, ktoré má stroj vyplnené — bez dopytu do DB. */
export function matchesMachineQuery(machine: MachineRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [
    machine.name,
    machine.category,
    machine.manufacturer,
    machine.model,
    machine.serial_number,
    machine.status,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(needle));
}
