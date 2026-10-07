// =============================================================================
// § 73 zákona č. 222/2004 Z. z. — lehota na vyhotovenie faktúry. Čistá funkcia (bez DB, bez I/O).
//
// Znenie (rovnaké v znení 1. 1. 2026 – 31. 12. 2026 aj od 1. 1. 2027):
// (1) Faktúra podľa § 72 musí byť vyhotovená do 15 dní
//   a) odo dňa dodania tovaru alebo služby, ak odsek 2 neustanovuje inak,
//   b) odo dňa prijatia platby pred dodaním tovaru alebo služby alebo do konca kalendárneho mesiaca,
//      v ktorom bola platba prijatá, ak odsek 2 neustanovuje inak,
//   c) od konca kalendárneho mesiaca, v ktorom bol dodaný tovar oslobodený od dane podľa § 43,
//   d) od konca kalendárneho mesiaca, v ktorom bola dodaná služba alebo prijatá platba pred dodaním
//      služby s miestom dodania podľa § 15 ods. 1 v inom členskom štáte,
//   e) od konca kalendárneho mesiaca, v ktorom nastala skutočnosť rozhodná pre vykonanie opravy
//      základu dane podľa § 25 ods. 1.
// § 72 ods. 8: faktúra sa nevyhotovuje pri tuzemských plneniach oslobodených podľa § 28 až 42.
// (2) platiteľ, ktorý splnil registračnú povinnosť, ale do uplynutia lehoty podľa ods. 1 a) alebo b)
//     nemá pridelené IČ DPH → do 5 pracovných dní odo dňa doručenia rozhodnutia o registrácii.
//
// Zásady: Esblu NEBLOKUJE vystavenie. Termín vráti iba tam, kde ho vie určiť bez aproximácie; inak
// status 'review' (lehota neurčená — nepodsúvame nesprávny zákonný termín) alebo 'not_applicable'.
// Posun konca lehoty na pracovný deň sa nerieši (termín je konzervatívny).
// FS (podpora.financnasprava.sk 903288): lehota § 73 je hmotnoprávna, § 27 ods. 4 daňového poriadku
// sa neuplatní — lehota sa na pracovný deň NEPOSÚVA (potvrdené, nie aproximácia).
//
// Od 1. 1. 2027 — § 85o ods. 6 (tuzemská e-faktúra): do 15 dní odo dňa dodania alebo odo dňa prijatia
// platby pred dodaním; FS FAQ k eFaktúre (15. 9. 2026): v lehote musí byť e-faktúra aj odoslaná.
// Alternatíva „do konca kalendárneho mesiaca“ (§ 73 ods. 1 b)) sa pri e-faktúre neuvádza → pri faktúre
// k prijatej platbe s dňom prijatia platby od 1. 1. 2027 a tuzemským odberateľom sa zobrazí iba 15-dňový
// termín (konzervatívne aj pre zriedkavé prípady mimo režimu e-faktúr; Esblu nikdy neblokuje).
// =============================================================================

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function parse(d: string | null | undefined): Date | null {
  if (!d || !ISO.test(d)) return null;
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day ? dt : null;
}
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
/** § 85o ods. 6 ZDPH — povinná tuzemská e-faktúra (lehota 15 dní bez alternatívy konca mesiaca). */
export const EINVOICE_REGIME_FROM = "2027-01-01";
const endOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));

export type IssueDeadlineRule = "a_delivery" | "b_payment" | "c_intra_eu_goods" | "e_correction";

export type IssueDeadlineReviewReason =
  | "missing_date" // chýba dátum, od ktorého lehota plynie
  | "seller_vat_status_unknown" // nevieme, či je dodávateľ platiteľ (§ 72 sa vzťahuje na platiteľa)
  | "vat_registration_pending" // platiteľ bez IČ DPH → môže platiť § 73 ods. 2
  | "cross_border_or_mixed" // odberateľ mimo SK alebo zmiešané režimy → c) / d) / § 72 ods. 1 b), c) nevieme spoľahlivo určiť
  | "unclassified_vat_category" // kategória (napr. O) bez spoľahlivého mapovania na písmeno § 73
  | "correction_fact_date_missing" // pri oprave chýba deň skutočnosti rozhodnej pre opravu
  | "non_vat_payer_foreign_service"; // § 72 ods. 2 (neplatiteľ, služba do zahraničia)

export type IssueDeadlineInput = {
  direction: "issued" | "received";
  kind: string;
  deliveryDate?: string | null;
  /** DUZP; pri faktúre k prijatej platbe = deň prijatia platby; pri oprave = deň skutočnosti rozhodnej pre opravu. */
  taxPointDate?: string | null;
  /** Kategórie DPH položiek (S, Z, E, AE, K, G, O …). */
  vatCategories: string[];
  /** Krajina odberateľa (ISO 3166-1 alpha-2); null = neznáma. */
  buyerCountry: string | null;
  /** true = platiteľ DPH, false = neplatiteľ, null = neznáme. */
  sellerVatPayer: boolean | null;
  /** Dodávateľ má IČ DPH. */
  sellerHasIcDph: boolean;
};

export type IssueDeadline =
  | { status: "determined"; rule: IssueDeadlineRule; from: string; deadline: string; alternativeDeadline?: string }
  | { status: "review"; reason: IssueDeadlineReviewReason }
  | { status: "not_applicable" };

// S = tuzemská sadzba, AE = tuzemské prenesenie (§ 69 ods. 12), E = oslobodené (§ 28–42). Z (0 %) SK sadzbu nemá → REVIEW.
const DOMESTIC_CATEGORIES = new Set(["S", "E", "AE"]);

export function issueDeadline(input: IssueDeadlineInput): IssueDeadline {
  if (input.direction !== "issued" || input.kind === "proforma") return { status: "not_applicable" };
  const cats = [...new Set(input.vatCategories.map((c) => c.toUpperCase()))];
  const buyerSk = (input.buyerCountry ?? "SK").toUpperCase() === "SK";
  if (input.sellerVatPayer === null) return { status: "review", reason: "seller_vat_status_unknown" };
  if (input.sellerVatPayer === false) {
    // § 72 ods. 1 ukladá povinnosť platiteľovi; neplatiteľ iba pri službe do zahraničia (§ 72 ods. 2).
    return buyerSk ? { status: "not_applicable" } : { status: "review", reason: "non_vat_payer_foreign_service" };
  }
  if (!input.sellerHasIcDph) return { status: "review", reason: "vat_registration_pending" };

  const tax = parse(input.taxPointDate ?? null);
  const delivery = parse(input.deliveryDate ?? null);

  if (input.kind === "credit_note" || input.kind === "debit_note") {
    // e) — iba ak je zadaný deň skutočnosti rozhodnej pre opravu; dátum dodania pôvodného plnenia to nie je.
    if (!tax) return { status: "review", reason: "correction_fact_date_missing" };
    return { status: "determined", rule: "e_correction", from: fmt(tax), deadline: fmt(addDays(endOfMonth(tax), 15)) };
  }

  // c) — výlučne tovar oslobodený podľa § 43 (kategória K; Esblu pri K uvádza § 43).
  if (cats.length > 0 && cats.every((c) => c === "K")) {
    if (buyerSk) return { status: "review", reason: "cross_border_or_mixed" };
    if (input.kind === "payment_received_invoice") return { status: "review", reason: "cross_border_or_mixed" };
    if (!delivery) return { status: "review", reason: "missing_date" };
    return { status: "determined", rule: "c_intra_eu_goods", from: fmt(delivery), deadline: fmt(addDays(endOfMonth(delivery), 15)) };
  }

  // a) / b) — iba tuzemský odberateľ a tuzemské režimy; inak d) alebo § 72 ods. 1 b), c) → REVIEW.
  if (!buyerSk || cats.some((c) => c === "K")) return { status: "review", reason: "cross_border_or_mixed" };
  if (cats.length === 0 || cats.some((c) => !DOMESTIC_CATEGORIES.has(c))) return { status: "review", reason: "unclassified_vat_category" };
  // § 72 ods. 8: povinnosť vyhotoviť faktúru sa nevzťahuje na tuzemské plnenia oslobodené podľa § 28 až 42.
  if (cats.every((c) => c === "E")) return { status: "not_applicable" };

  if (input.kind === "payment_received_invoice") {
    if (!tax) return { status: "review", reason: "missing_date" };
    if (fmt(tax) >= EINVOICE_REGIME_FROM) {
      return { status: "determined", rule: "b_payment", from: fmt(tax), deadline: fmt(addDays(tax, 15)) };
    }
    // Zákon uvádza dva termíny spojené „alebo“ — zobrazia sa oba, za oneskorenú sa považuje až po neskoršom.
    const a = addDays(tax, 15), b = endOfMonth(tax);
    const [early, late] = a <= b ? [a, b] : [b, a];
    return { status: "determined", rule: "b_payment", from: fmt(tax), deadline: fmt(late), alternativeDeadline: fmt(early) };
  }
  // § 74 ods. 1 d): dátum dodania; ak chýba, DUZP (pri bežnej faktúre totožný deň).
  const event = delivery ?? tax;
  if (!event) return { status: "review", reason: "missing_date" };
  return { status: "determined", rule: "a_delivery", from: fmt(event), deadline: fmt(addDays(event, 15)) };
}

/** true = dátum vyhotovenia je po lehote § 73 (iba upozornenie, nikdy blokovanie). */
export function isIssuedAfterDeadline(issueDate: string | null | undefined, deadline: IssueDeadline): boolean {
  return deadline.status === "determined" && Boolean(issueDate && ISO.test(issueDate) && issueDate > deadline.deadline);
}
