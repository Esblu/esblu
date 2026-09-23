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

/**
 * Ako ďaleko je doklad na ceste von z Esblu.
 *
 * STIAHNUTÝ ZOŠIT NIE JE ODOVZDANIE.
 * ---------------------------------
 * `metadata_exported` znamená, že si niekto stiahol súbor s ÚDAJMI o
 * dokladoch. Nie je to dôkaz, že účtovník čokoľvek dostal, a už vôbec nie,
 * že má originály — tie v takom súbore nie sú. Preto je to samostatný
 * stav a preto z neho NIKDY nevyplýva, že doklad môže z Esblu zmiznúť.
 *
 * `complete_handoff` znamená odovzdaný úplný balík vrátane originálov
 * prijatých dokladov, PDF vydaných faktúr, príloh a manifestu. Dnes ho
 * nič nevytvára; hodnota existuje preto, aby sa oprávnenosť na
 * odstránenie dala naviazať na niečo konkrétne namiesto na „veď sa niečo
 * exportovalo".
 */
export type HandoffStatus = "none" | "metadata_exported" | "complete_handoff";

/**
 * Prevádzkové uchovávanie v Esblu.
 *
 *   "active"                          bežný stav
 *   "approaching_limit"               do konca prevádzkovej lehoty ≤ 30 dní
 *   "retention_exceeded"              lehota uplynula; úplné odovzdanie NIE JE
 *   "eligible_for_removal"            lehota uplynula A doklad bol úplne odovzdaný
 *
 * `retention_exceeded` je upozornenie pre človeka, NIE povolenie na
 * čokoľvek. Platí aj vtedy, keď sa z dokladu exportovali údaje — zošit s
 * údajmi nie je odovzdanie dokladov.
 *
 * `eligible_for_removal` je dnes nedosiahnuteľný, lebo úplný balík zatiaľ
 * nič nevytvára. Je to zámer, nie nedostatok: podmienka existuje skôr než
 * mazanie, aby sa mazanie nedalo zapnúť bez nej.
 */
export type RetentionState =
  | "active"
  | "approaching_limit"
  | "retention_exceeded"
  | "eligible_for_removal";

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

  // Lehota uplynula. O tom, či sa doklad smie stať odstrániteľným,
  // rozhoduje VÝHRADNE úplné odovzdanie. Export údajov sem nesiaha —
  // originál dokladu v zošite nie je, takže po odstránení by neexistoval
  // nikde.
  return {
    state: input.handoffStatus === "complete_handoff" ? "eligible_for_removal" : "retention_exceeded",
    deadline,
    daysRemaining,
  };
}

/**
 * Smie sa prevádzková kópia dokladu ponúknuť na odstránenie?
 *
 * Nie je to príkaz na zmazanie a nikdy ním nebude — je to podmienka, bez
 * ktorej sa o odstránení nesmie ani uvažovať. Samotné odstránenie ostáva
 * vedomým krokom oprávneného človeka a dnes ho nič nevykonáva.
 *
 * Dnes vracia vždy `false`, pretože `complete_handoff` nemá kto nastaviť.
 * Tak to má byť: podmienka je na mieste skôr, než existuje čokoľvek, čo
 * by podľa nej mazalo.
 */
export function isEligibleForRemoval(input: RetentionInput): boolean {
  return retentionStatus(input).state === "eligible_for_removal";
}

/**
 * Čo ešte chýba, aby sa doklad mohol z Esblu odstrániť?
 *
 * Zoznam je zámerne konkrétny. „Nie je odovzdané" nikomu nepovie, čo s
 * tým — a pri dokladoch, ktoré inde neexistujú, je vágna odpoveď horšia
 * než žiadna.
 */
export type RemovalBlocker =
  | "retention_not_reached"
  | "complete_handoff_missing"
  | "only_metadata_exported";

export function removalBlockers(input: RetentionInput): RemovalBlocker[] {
  const blockers: RemovalBlocker[] = [];
  const status = retentionStatus(input);

  if (status.state === "active" || status.state === "approaching_limit") {
    blockers.push("retention_not_reached");
  }

  if (input.handoffStatus !== "complete_handoff") {
    blockers.push(
      input.handoffStatus === "metadata_exported"
        ? "only_metadata_exported"
        : "complete_handoff_missing"
    );
  }

  return blockers;
}

/**
 * Čo musí úplný balík obsahovať, aby sa dal považovať za odovzdanie.
 *
 * Zoznam je tu preto, že sa naň odvoláva compliance poznámka aj budúci
 * export, a dve kópie toho istého zoznamu by sa o pár mesiacov rozišli.
 * NIE JE to výmenný formát — Esblu si žiadny nevymýšľa a netvrdí, že
 * niektorý spĺňa.
 */
export const COMPLETE_HANDOFF_CONTENTS = {
  received: [
    "original_document",
    "invoice_metadata",
    "line_items",
    "vat_breakdown",
    "partner_snapshot",
    "attachments",
  ],
  issued: [
    "invoice_pdf",
    "invoice_metadata",
    "line_items",
    "vat_breakdown",
    "partner_snapshot",
    "attachments",
  ],
  manifest: [
    "company",
    "invoice_identifiers",
    "export_timestamp",
    "integrity_hashes",
  ],
} as const;

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
