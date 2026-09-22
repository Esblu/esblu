// =============================================================================
// Členenie registra faktúr — JEDNA definícia pre počty aj pre zoznam.
//
// PREČO SAMOSTATNÝ MODUL
// ----------------------
// Register mal dve osi (smer a stav) a počty sa počítali inou množinou než
// tou, z ktorej vznikal zoznam. Výsledok videl používateľ v produkcii:
// záložka hlásila „Všetky 3", zoznam vykreslil dva doklady a tretí — koncept
// — sa nedal otvoriť odnikiaľ. Číslo pri záložke je sľub, že po kliknutí
// uvidíš práve toľko riadkov; sľub sa dá dodržať iba vtedy, keď ho plní tá
// istá funkcia, ktorá zoznam filtruje.
//
// Modul nemá žiadne importy, takže rovnaké pravidlá bežia v appke aj v
// teste bez bundlera. „Po splatnosti" je odvodený stav a počíta sa inde
// (vat-engine); sem prichádza ako funkcia, aby tento modul nemusel ťahať
// peňažnú matematiku.
// =============================================================================

export type DirectionFilter = "all" | "issued" | "received";

export const DIRECTION_ORDER: DirectionFilter[] = ["all", "issued", "received"];

/**
 * Sekcia = stav dokladu. „issued" NIE JE smer — znamená „finalizovaný
 * riadny doklad". To rozlíšenie tu bolo vždy a zámerne sa nemení.
 */
export type SectionKey =
  | "all"
  | "issued"
  | "drafts"
  | "unpaid"
  | "overdue"
  | "paid"
  | "corrections";

export const SECTION_ORDER: SectionKey[] = [
  "all",
  "issued",
  "drafts",
  "unpaid",
  "overdue",
  "paid",
  "corrections",
];

/** Minimum, ktoré na rozhodnutie o zaradení treba. */
export type RegisterInvoice = {
  direction: string;
  kind: string;
  document_status: string;
  payment_status: string;
};

export function matchesDirection(invoice: RegisterInvoice, filter: DirectionFilter): boolean {
  if (filter === "all") return true;
  return invoice.direction === filter;
}

export function matchesSection<T extends RegisterInvoice>(
  invoice: T,
  section: SectionKey,
  /** Odvodené „po splatnosti" — počíta ho volajúci, pozri hlavičku modulu. */
  isOverdue: (invoice: T) => boolean
): boolean {
  switch (section) {
    // Východiskový pohľad registra. Koncept je jediný doklad, ku ktorému sa
    // používateľ MUSÍ vedieť vrátiť — nemá číslo, nič neúčtuje a existuje
    // len preto, aby sa dokončil. Skrytý koncept je stratená práca.
    case "all":
      return true;
    case "issued":
      return (
        invoice.document_status === "finalized" &&
        (invoice.kind === "regular_invoice" || invoice.kind === "payment_received_invoice")
      );
    case "drafts":
      return invoice.document_status === "draft";
    case "unpaid":
      return invoice.document_status === "finalized" && invoice.payment_status === "unpaid";
    case "overdue":
      return invoice.document_status === "finalized" && isOverdue(invoice);
    case "paid":
      return invoice.document_status === "finalized" && invoice.payment_status === "paid";
    case "corrections":
      return invoice.kind === "credit_note" || invoice.kind === "debit_note";
    default:
      return false;
  }
}

/**
 * Riadky, ktoré register po danej voľbe naozaj vykreslí.
 *
 * Počty aj zoznam vychádzajú z tejto funkcie — iné poradie filtrov by
 * znamenalo iné číslo než počet riadkov.
 */
export function visibleInvoices<T extends RegisterInvoice>(
  invoices: T[],
  section: SectionKey,
  direction: DirectionFilter,
  isOverdue: (invoice: T) => boolean
): T[] {
  return invoices.filter(
    (invoice) =>
      matchesSection(invoice, section, isOverdue) && matchesDirection(invoice, direction)
  );
}
