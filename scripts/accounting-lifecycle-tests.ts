// =============================================================================
// Testy prevádzkového životného cyklu dokladu.
//
// SPUSTENIE
//   npm run test:lifecycle
//
// ČO SA TU CHRÁNI
// ---------------
// Štyri vety, na ktorých stojí celý model:
//   1. uhradené NIE JE zaúčtované,
//   2. zaúčtované NIE JE odovzdané,
//   3. stiahnutý zošit s ÚDAJMI nie je odovzdanie DOKLADOV,
//   4. starý doklad, ktorý nikto úplne neodovzdal, sa odstrániť NESMIE.
//
// Prvé tri sú o tom, že rôzne otázky majú rôzne odpovede. Štvrtá je
// poistka proti najhoršiemu možnému zlyhaniu tohto modulu: zmazať doklad,
// ktorý nikde inde neexistuje.
// =============================================================================

import assert from "node:assert/strict";
import {
  retentionDeadline,
  retentionStatus,
  isEligibleForRemoval,
  removalBlockers,
  COMPLETE_HANDOFF_CONTENTS,
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
  retentionStatus({ ...NOVY, handoffStatus: "none" }).state,
  "active"
);

// Presne 30 dní pred koncom — hranica patrí do varovania.
check(
  "30 dní pred koncom už varuje",
  retentionStatus({
    issueDate: "2026-09-23",
    today: "2028-08-24",
    handoffStatus: "none",
  }).state,
  "approaching_limit"
);
check(
  "31 dní pred koncom ešte nevaruje",
  retentionStatus({
    issueDate: "2026-09-23",
    today: "2028-08-23",
    handoffStatus: "none",
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
    handoffStatus: "complete_handoff",
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
  "po lehote a ÚPLNE ODOVZDANÝ → oprávnený na odstránenie",
  retentionStatus({ ...PO_LEHOTE, handoffStatus: "complete_handoff" }).state,
  "eligible_for_removal"
);
check(
  "po lehote a NEODOVZDANÝ → iba upozornenie, nie oprávnenie",
  retentionStatus({ ...PO_LEHOTE, handoffStatus: "none" }).state,
  "retention_exceeded"
);

// NAJDÔLEŽITEJŠÍ TEST V SÚBORE.
//
// Stiahnutý zošit s údajmi NIE JE odovzdanie dokladov — originál faktúry v
// ňom nie je. Keby z neho vyplynula oprávnenosť na odstránenie, zmazal by
// sa doklad, ktorý potom neexistuje nikde.
check(
  "po lehote a IBA EXPORTOVANÉ ÚDAJE → stále NIE oprávnený",
  retentionStatus({ ...PO_LEHOTE, handoffStatus: "metadata_exported" }).state,
  "retention_exceeded"
);
check(
  "export údajov nikdy nestačí na odstránenie",
  isEligibleForRemoval({ issueDate: "2010-01-01", today: "2026-09-23", handoffStatus: "metadata_exported" }),
  false
);
check(
  "neodovzdaný doklad NIE JE oprávnený na odstránenie, nech je akokoľvek starý",
  isEligibleForRemoval({ issueDate: "2010-01-01", today: "2026-09-23", handoffStatus: "none" }),
  false
);
check(
  "úplne odovzdaný a dávno po lehote JE oprávnený",
  isEligibleForRemoval({ issueDate: "2010-01-01", today: "2026-09-23", handoffStatus: "complete_handoff" }),
  true
);

// -----------------------------------------------------------------------------
// 3b. Čo presne bráni odstráneniu
// -----------------------------------------------------------------------------
check(
  "nový doklad: bráni lehota aj chýbajúce odovzdanie",
  removalBlockers({ ...NOVY, handoffStatus: "none" }),
  ["retention_not_reached", "complete_handoff_missing"]
);
check(
  "po lehote s exportom údajov: bráni už len odovzdanie a vie sa to pomenovať",
  removalBlockers({ ...PO_LEHOTE, handoffStatus: "metadata_exported" }),
  ["only_metadata_exported"]
);
check(
  "po lehote a úplne odovzdaný: nič nebráni",
  removalBlockers({ ...PO_LEHOTE, handoffStatus: "complete_handoff" }),
  []
);

// Obsah úplného balíka je definovaný na JEDNOM mieste, aby sa
// compliance poznámka a budúci export nerozišli.
check("prijatý doklad nesie originál", COMPLETE_HANDOFF_CONTENTS.received.includes("original_document"), true);
check("vydaná faktúra nesie PDF", COMPLETE_HANDOFF_CONTENTS.issued.includes("invoice_pdf"), true);
check("manifest nesie odtlačky", COMPLETE_HANDOFF_CONTENTS.manifest.includes("integrity_hashes"), true);

// -----------------------------------------------------------------------------
// 4. Zostávajúce dni
// -----------------------------------------------------------------------------
check(
  "deň po uplynutí je −1",
  retentionStatus({ ...PO_LEHOTE, handoffStatus: "complete_handoff" }).daysRemaining,
  -1
);
check(
  "koniec lehoty sa vracia spolu so stavom",
  retentionStatus({ ...PO_LEHOTE, handoffStatus: "complete_handoff" }).deadline,
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
  const handedOff = retentionStatus({ ...PO_LEHOTE, handoffStatus: "complete_handoff" });
  const onlyData = retentionStatus({ ...PO_LEHOTE, handoffStatus: "metadata_exported" });
  const nothing = retentionStatus({ ...PO_LEHOTE, handoffStatus: "none" });

  check("lehota je rovnaká bez ohľadu na odovzdanie", handedOff.deadline, onlyData.deadline);
  check("líši sa iba stav", handedOff.state !== onlyData.state, true);
  // Export údajov a žiadny export vedú k TOMU ISTÉMU stavu — lebo z
  // pohľadu odstránenia znamenajú to isté: originál je stále iba tu.
  check("export údajov = žiadny export, pokiaľ ide o odstránenie", onlyData.state, nothing.state);
}

// Zaúčtovanie do výpočtu lehoty NEVSTUPUJE — funkcia ho ani neprijíma.
// Keby ho niekto pridal, padne typová kontrola, nie účtovná závierka.
check(
  "zaúčtovanie neovplyvňuje oprávnenosť na odstránenie",
  isEligibleForRemoval({ ...PO_LEHOTE, handoffStatus: "none" }),
  false
);

// -----------------------------------------------------------------------------
// 6. Dnes sa odstrániť nedá NIČ
//
// `complete_handoff` zatiaľ nemá kto nastaviť — úplný balík nič nevytvára.
// Test to drží ako vedomý stav, nie ako nedopatrenie: podmienka existuje
// skôr než mazanie, aby sa mazanie nedalo zapnúť bez nej.
// -----------------------------------------------------------------------------
{
  const dosiahnutelneDnes = ["none", "metadata_exported"] as const;
  const opravnene = dosiahnutelneDnes.filter((status) =>
    isEligibleForRemoval({ issueDate: "2000-01-01", today: "2026-09-23", handoffStatus: status })
  );
  check("žiadny dnes dosiahnuteľný stav nevedie k odstráneniu", opravnene.length, 0);
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
