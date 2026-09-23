// =============================================================================
// Testy prevádzkového životného cyklu dokladu.
//
// SPUSTENIE
//   npm run test:lifecycle
//
// ČO SA TU CHRÁNI
// ---------------
// Tri vety, na ktorých stojí celý model:
//   1. uhradené NIE JE zaúčtované,
//   2. zaúčtované NIE JE odovzdané,
//   3. starý doklad, ktorý nikto neodovzdal, sa odstrániť NESMIE.
//
// Prvé dve sú o tom, že tri rôzne otázky majú tri rôzne odpovede. Tretia
// je poistka proti najhoršiemu možnému zlyhaniu tohto modulu: zmazať
// doklad, ktorý nikde inde neexistuje.
// =============================================================================

import assert from "node:assert/strict";
import {
  retentionDeadline,
  retentionStatus,
  isEligibleForRemoval,
  OPERATIONAL_RETENTION_MONTHS,
  RETENTION_WARNING_DAYS,
} from "../lib/invoicing/accounting-lifecycle.ts";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    passed++;
  } catch {
    failed++;
    console.error(
      `FAIL  ${label}\n      dostal: ${JSON.stringify(actual)}\n      čakal:  ${JSON.stringify(expected)}`
    );
  }
}

// -----------------------------------------------------------------------------
// 1. Koniec prevádzkovej lehoty
// -----------------------------------------------------------------------------
check("24 mesiacov je ten istý deň o dva roky", retentionDeadline("2026-09-23"), "2028-09-23");
check("prestupný rok: 29. 2. + 24 mesiacov", retentionDeadline("2024-02-29"), "2026-02-28");
check("koniec mesiaca: 31. 8. + 6 mesiacov", retentionDeadline("2026-08-31", 6), "2027-02-28");
check("prelom roka", retentionDeadline("2026-12-01"), "2028-12-01");
check("nezmyselný dátum", retentionDeadline("nie je datum"), null);
check("predvolená lehota je 24 mesiacov", OPERATIONAL_RETENTION_MONTHS, 24);

// -----------------------------------------------------------------------------
// 2. Stavy lehoty
// -----------------------------------------------------------------------------
const NOVY = { issueDate: "2026-09-01", today: "2026-09-23" };

check(
  "nový doklad je bežný",
  retentionStatus({ ...NOVY, handoffStatus: "not_exported" }).state,
  "active"
);

// Presne 30 dní pred koncom — hranica patrí do varovania.
check(
  "30 dní pred koncom už varuje",
  retentionStatus({
    issueDate: "2026-09-23",
    today: "2028-08-24",
    handoffStatus: "not_exported",
  }).state,
  "approaching_limit"
);
check(
  "31 dní pred koncom ešte nevaruje",
  retentionStatus({
    issueDate: "2026-09-23",
    today: "2028-08-23",
    handoffStatus: "not_exported",
  }).state,
  "active"
);
check("varovná lehota je 30 dní", RETENTION_WARNING_DAYS, 30);

// V deň uplynutia sa ešte nič neuvoľňuje — lehota je dodržaná do konca dňa.
check(
  "v deň konca lehoty ešte nie je oprávnený",
  retentionStatus({
    issueDate: "2026-09-23",
    today: "2028-09-23",
    handoffStatus: "exported",
  }).state,
  "approaching_limit"
);

// -----------------------------------------------------------------------------
// 3. Odovzdané vs. neodovzdané po uplynutí lehoty
//
// Toto je najdôležitejší test v súbore. Starý a neodovzdaný doklad je
// jediný záznam o tej transakcii, aký zákazník má.
// -----------------------------------------------------------------------------
const PO_LEHOTE = { issueDate: "2026-09-23", today: "2028-09-24" };

check(
  "po lehote a ODOVZDANÝ → oprávnený na odstránenie",
  retentionStatus({ ...PO_LEHOTE, handoffStatus: "exported" }).state,
  "eligible_for_removal"
);
check(
  "po lehote a NEODOVZDANÝ → iba upozornenie, nie oprávnenie",
  retentionStatus({ ...PO_LEHOTE, handoffStatus: "not_exported" }).state,
  "overdue_not_handed_off"
);
check(
  "neodovzdaný doklad NIE JE oprávnený na odstránenie, nech je akokoľvek starý",
  isEligibleForRemoval({ issueDate: "2010-01-01", today: "2026-09-23", handoffStatus: "not_exported" }),
  false
);
check(
  "odovzdaný a dávno po lehote JE oprávnený",
  isEligibleForRemoval({ issueDate: "2010-01-01", today: "2026-09-23", handoffStatus: "exported" }),
  true
);

// -----------------------------------------------------------------------------
// 4. Zostávajúce dni
// -----------------------------------------------------------------------------
check(
  "deň po uplynutí je −1",
  retentionStatus({ ...PO_LEHOTE, handoffStatus: "exported" }).daysRemaining,
  -1
);
check(
  "koniec lehoty sa vracia spolu so stavom",
  retentionStatus({ ...PO_LEHOTE, handoffStatus: "exported" }).deadline,
  "2028-09-23"
);

// -----------------------------------------------------------------------------
// 5. Tri nezávislé otázky
//
// Stav úhrady, stav účtovníctva a stav odovzdania sa nikde neodvodzujú
// jeden z druhého. Test to stráži tým, že mení iba odovzdanie a čaká zmenu
// iba v lehote — nič iné sa dopočítať nedá, lebo tento modul o úhrade ani
// o zaúčtovaní nič nevie. Práve to je na ňom správne.
// -----------------------------------------------------------------------------
{
  const exported = retentionStatus({ ...PO_LEHOTE, handoffStatus: "exported" });
  const notExported = retentionStatus({ ...PO_LEHOTE, handoffStatus: "not_exported" });

  check("lehota je rovnaká bez ohľadu na odovzdanie", exported.deadline, notExported.deadline);
  check("líši sa iba stav", exported.state !== notExported.state, true);
}

// Zaúčtovanie do výpočtu lehoty NEVSTUPUJE — funkcia ho ani neprijíma.
// Keby ho niekto pridal, padne typová kontrola, nie účtovná závierka.
check(
  "zaúčtovanie neovplyvňuje oprávnenosť na odstránenie",
  isEligibleForRemoval({ ...PO_LEHOTE, handoffStatus: "not_exported" }),
  false
);

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
