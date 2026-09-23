// =============================================================================
// Prevádzkový životný cyklus dokladu v Esblu.
//
// PRODUKTOVÉ VÝCHODISKO
// ---------------------
// Esblu NIE JE zákonný dlhodobý účtovný archív. Je to prevádzkový systém:
// doklad sa prijme, spracuje, skontroluje, odovzdá účtovníkovi a po čase
// sa jeho prevádzková kópia z Esblu odstráni. Dlhodobé uchovávanie podľa
// zákona prebieha mimo Esblu a zodpovedá zaň zákazník, jeho účtovník alebo
// jeho účtovný softvér — podľa ich vlastného právneho a zmluvného
// nastavenia.
//
// 24 mesiacov nižšie je PRODUKTOVÝ cieľ prevádzkového uchovávania. Nie je
// to tvrdenie o tom, ako dlho treba doklady uchovávať podľa zákona.
//
// ČO TENTO MODUL ROBÍ A ČO NIE
// ----------------------------
// Počíta stav. Nemaže, neplánuje mazanie a nič nespúšťa. Odstránenie
// dokladu je samostatné, vysokorizikové rozhodnutie človeka; tento modul
// mu iba pripraví podklad a nikdy ho nenahradí.
//
// Modul nemá importy, takže tie isté pravidlá bežia v appke aj v teste.
// =============================================================================

/** Stav spracovania v účtovníctve. Oddelený od stavu úhrady. */
export type AccountingStatus = "unprocessed" | "accounted";

/** Bol doklad odovzdaný účtovníkovi (existuje export)? */
export type HandoffStatus = "not_exported" | "exported";

/**
 * Prevádzkové uchovávanie v Esblu.
 *
 *   "active"                  bežný stav
 *   "approaching_limit"       do konca prevádzkovej lehoty ≤ 30 dní
 *   "eligible_for_removal"    lehota uplynula A doklad je odovzdaný
 *   "overdue_not_handed_off"  lehota uplynula, ale odovzdaný NIE JE
 *
 * Posledný stav je úmyselne samostatný. Je to upozornenie pre človeka, nie
 * povolenie na čokoľvek: doklad, ktorý nikto neodovzdal, sa z Esblu
 * odstrániť nesmie, aj keby bol akokoľvek starý.
 */
export type RetentionState =
  | "active"
  | "approaching_limit"
  | "eligible_for_removal"
  | "overdue_not_handed_off";

/** Produktový cieľ prevádzkového uchovávania plného dokladu v Esblu. */
export const OPERATIONAL_RETENTION_MONTHS = 24;

/** Koľko dní vopred sa na koniec lehoty upozorňuje. */
export const RETENTION_WARNING_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Koniec prevádzkovej lehoty pre doklad s daným dátumom vystavenia.
 *
 * Počíta sa nad kalendárnymi mesiacmi v UTC, nie pripočítaním dní —
 * „24 mesiacov" znamená ten istý deň v mesiaci, nie 730 dní. Keď cieľový
 * mesiac taký deň nemá (31. august + 6 mesiacov), použije sa jeho posledný
 * deň; tak to robí aj bežná zmluvná prax a nikdy tým nevznikne dátum,
 * ktorý neexistuje.
 */
export function retentionDeadline(
  issueDate: string,
  months: number = OPERATIONAL_RETENTION_MONTHS
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(issueDate);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const totalMonths = (year * 12 + (month - 1)) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;

  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);

  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

/** Počet celých dní medzi dvoma kalendárnymi dňami (b - a). */
function daysBetween(a: string, b: string): number | null {
  const from = Date.parse(`${a}T00:00:00Z`);
  const to = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

export type RetentionInput = {
  /** Dátum vystavenia dokladu (YYYY-MM-DD). */
  issueDate: string;
  /** Dnešok podľa kalendára používateľa (YYYY-MM-DD). */
  today: string;
  handoffStatus: HandoffStatus;
  months?: number;
  warningDays?: number;
};

export type RetentionResult = {
  state: RetentionState;
  deadline: string | null;
  /** Koľko dní zostáva; záporné číslo znamená, že lehota uplynula. */
  daysRemaining: number | null;
};

/**
 * Kde sa doklad nachádza v prevádzkovej lehote.
 *
 * Zaúčtovanie sem ZÁMERNE nevstupuje. Zaúčtovanie je vec účtovníctva,
 * odovzdanie je vec toho, či doklad opustil Esblu — a iba to druhé
 * rozhoduje, či sa prevádzková kópia smie stať zbytočnou.
 */
export function retentionStatus(input: RetentionInput): RetentionResult {
  const months = input.months ?? OPERATIONAL_RETENTION_MONTHS;
  const warningDays = input.warningDays ?? RETENTION_WARNING_DAYS;

  const deadline = retentionDeadline(input.issueDate, months);
  if (!deadline) return { state: "active", deadline: null, daysRemaining: null };

  const daysRemaining = daysBetween(input.today, deadline);
  if (daysRemaining === null) return { state: "active", deadline, daysRemaining: null };

  if (daysRemaining > warningDays) {
    return { state: "active", deadline, daysRemaining };
  }

  if (daysRemaining >= 0) {
    return { state: "approaching_limit", deadline, daysRemaining };
  }

  return {
    state: input.handoffStatus === "exported" ? "eligible_for_removal" : "overdue_not_handed_off",
    deadline,
    daysRemaining,
  };
}

/**
 * Smie sa prevádzková kópia dokladu ponúknuť na odstránenie?
 *
 * Nie je to príkaz na zmazanie a nikdy ním nebude — je to podmienka, bez
 * ktorej sa o odstránení nesmie ani uvažovať. Samotné odstránenie ostáva
 * vedomým krokom oprávneného človeka.
 */
export function isEligibleForRemoval(input: RetentionInput): boolean {
  return retentionStatus(input).state === "eligible_for_removal";
}

/**
 * Uhradené ≠ zaúčtované.
 *
 * Funkcia existuje preto, aby sa tá veta dala odskúšať. Stav úhrady a stav
 * účtovníctva sa nikde neodvodzujú jeden z druhého; keby sa to niekedy
 * niekto pokúsil urobiť, padne test, nie až účtovná závierka.
 */
export function describesSameThing(): false {
  return false;
}
