// =============================================================================
// SK lehoty a dátumy pre fakturáciu — čisté funkcie (bez DB, bez I/O).
//
// 1) § 26 ods. 1 zákona č. 222/2004 Z. z.: referenčný kurz ECB/NBS „vyhlásený v deň predchádzajúci
//    dňu vzniku daňovej povinnosti“. fxReferenceRateDate() vráti posledný deň vyhlásenia kurzu
//    pred dňom vzniku (kalendár TARGET). Zrkadlo SQL public.esblu_fx_reference_rate_date — DB je
//    autoritatívna (pozná aj mimoriadne výnimky); tu je iba nápoveda pre UI.
// 2) § 73 ods. 1 zákona o DPH: lehota 15 dní na vyhotovenie faktúry. issueDeadline() iba
//    UPOZORŇUJE — Esblu vystavenie po lehote neblokuje (doklad je potrebný aj po lehote) a skutočný
//    dátum vyhotovenia aj čas finalizácie (finalized_at) zostávajú v audite.
//    Neriešené: § 73 ods. 2 (registrácia pre daň) a posun konca lehoty na pracovný deň podľa
//    daňového poriadku — upozornenie je preto konzervatívne (skôr než neskôr). LEGAL REVIEW.
// =============================================================================

export type FxRateSource = "ECB" | "NBS" | "CUSTOMS";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function parse(d: string | null | undefined): Date | null {
  if (!d || !ISO.test(d)) return null;
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day ? dt : null;
}
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
const endOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));

/** Veľkonočná nedeľa (gregoriánsky kalendár, anonymný algoritmus) — rovnaký ako esblu_easter_sunday. */
export function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return fmt(new Date(Date.UTC(year, month - 1, day)));
}

/** Deň, v ktorý ECB vyhlasuje referenčné kurzy (pracovný deň TARGET). */
export function isTargetPublicationDay(date: string): boolean {
  const d = parse(date);
  if (!d) return false;
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const md = date.slice(5);
  if (md === "01-01" || md === "05-01" || md === "12-25" || md === "12-26") return false;
  const easter = parse(easterSunday(d.getUTCFullYear()))!;
  return date !== fmt(addDays(easter, -2)) && date !== fmt(addDays(easter, 1));
}

/**
 * Jediný prípustný dátum kurzu pre daný deň vzniku daňovej povinnosti.
 * ECB/NBS: posledný deň vyhlásenia ≤ (deň vzniku − 1). CUSTOMS: deň vzniku. Neplatný vstup → null.
 */
export function fxReferenceRateDate(taxPointDate: string | null | undefined, source: FxRateSource | "" | null | undefined): string | null {
  const t = parse(taxPointDate ?? null);
  if (!t || !source) return null;
  if (source === "CUSTOMS") return fmt(t);
  let d = addDays(t, -1);
  for (let n = 0; n < 30 && !isTargetPublicationDay(fmt(d)); n++) d = addDays(d, -1);
  return fmt(d);
}

export type IssueDeadlineRule = "a_delivery" | "b_payment" | "c_intra_eu_goods" | "d_eu_service" | "e_correction";

export type IssueDeadlineInput = {
  direction: "issued" | "received";
  kind: string;
  deliveryDate?: string | null;
  /** DUZP; pri faktúre k prijatej platbe = deň prijatia platby; pri oprave = deň skutočnosti rozhodnej pre opravu. */
  taxPointDate?: string | null;
  /** Aspoň jedna položka v kategórii K (dodanie tovaru do iného členského štátu, § 43). */
  hasIntraEuGoods?: boolean;
  /** Služba s miestom dodania v inom členskom štáte (§ 15 ods. 1) — napr. AE s odberateľom mimo SK. */
  hasEuServiceReverseCharge?: boolean;
};

export type IssueDeadline = { deadline: string; rule: IssueDeadlineRule; from: string };

/** § 73 ods. 1 — posledný deň lehoty na vyhotovenie faktúry. null = pravidlo sa neuplatní alebo chýba dátum. */
export function issueDeadline(input: IssueDeadlineInput): IssueDeadline | null {
  if (input.direction !== "issued" || input.kind === "proforma") return null;
  const tax = parse(input.taxPointDate ?? null);
  const delivery = parse(input.deliveryDate ?? null);
  if (input.kind === "credit_note" || input.kind === "debit_note") {
    const fact = tax ?? delivery;
    return fact ? { deadline: fmt(addDays(endOfMonth(fact), 15)), rule: "e_correction", from: fmt(fact) } : null;
  }
  if (input.kind === "payment_received_invoice") {
    if (!tax) return null;
    if (input.hasEuServiceReverseCharge) return { deadline: fmt(addDays(endOfMonth(tax), 15)), rule: "d_eu_service", from: fmt(tax) };
    // „do 15 dní odo dňa prijatia platby … alebo do konca kalendárneho mesiaca, v ktorom bola platba prijatá“ → neskorší z oboch.
    const a = addDays(tax, 15), b = endOfMonth(tax);
    return { deadline: fmt(a > b ? a : b), rule: "b_payment", from: fmt(tax) };
  }
  const event = delivery ?? tax;
  if (!event) return null;
  if (input.hasIntraEuGoods) return { deadline: fmt(addDays(endOfMonth(event), 15)), rule: "c_intra_eu_goods", from: fmt(event) };
  if (input.hasEuServiceReverseCharge) return { deadline: fmt(addDays(endOfMonth(event), 15)), rule: "d_eu_service", from: fmt(event) };
  return { deadline: fmt(addDays(event, 15)), rule: "a_delivery", from: fmt(event) };
}

/** true = dátum vyhotovenia je po lehote § 73 (iba upozornenie, nikdy blokovanie). */
export function isIssuedAfterDeadline(issueDate: string | null | undefined, deadline: IssueDeadline | null): boolean {
  return Boolean(deadline && issueDate && ISO.test(issueDate) && issueDate > deadline.deadline);
}
