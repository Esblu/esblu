// =============================================================================
// Testy zhody obchodného partnera podľa názvu.
//
// SPUSTENIE
//   npm run test:partners
//
// PREČO EXISTUJÚ
// --------------
// Vznikli z reálnej chyby: partner „Tester1", prepis reči „Tester 1",
// odpoveď „takého odberateľa nepoznám". Väčšina prípadov tu preto nie je
// vymyslená — sú to tvary, ktoré rozpoznávač reči naozaj produkuje.
//
// Polovica testov overuje, že sa zhoda NÁJDE. Druhá polovica overuje, že sa
// NENÁJDE tam, kde nemá. Tá druhá je dôležitejšia: chybne nenájdený partner
// znamená otázku navyše, chybne nájdený znamená faktúru na nesprávnu firmu.
// =============================================================================

import assert from "node:assert/strict";
import {
  partnerNameExactKey,
  partnerNameLooseKey,
  matchPartnersByName,
} from "../lib/partner-matching.ts";

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

type Row = { id: string; legal_name: string };
const nameOf = (row: Row) => row.legal_name;

/** Vráti id vyriešeného partnera, alebo popis toho, prečo sa nevyriešil. */
function resolve(query: string, partners: Row[]): string {
  const result = matchPartnersByName(query, partners, nameOf);
  if (result.autoResolvable) return result.matches[0].id;
  if (result.matches.length === 0) return "NENASIEL";
  return `PYTA_SA(${result.tier}:${result.matches.map((p) => p.id).join("|")})`;
}

// -----------------------------------------------------------------------------
// Kanonické kľúče
// -----------------------------------------------------------------------------
check("exact: Tester1", partnerNameExactKey("Tester1"), "TESTER1");
check("loose: Tester 1 → TESTER1", partnerNameLooseKey("Tester 1"), "TESTER1");
check("loose: Tester-1 → TESTER1", partnerNameLooseKey("Tester-1"), "TESTER1");
check("loose: Tester_1 → TESTER1", partnerNameLooseKey("Tester_1"), "TESTER1");
check("loose: TESTER 1 → TESTER1", partnerNameLooseKey("TESTER 1"), "TESTER1");
check("loose: tester 1 → TESTER1", partnerNameLooseKey("tester 1"), "TESTER1");
check("loose: ABC 123 → ABC123", partnerNameLooseKey("ABC 123"), "ABC123");
check("loose: ABC-123 → ABC123", partnerNameLooseKey("ABC-123"), "ABC123");
check("loose: Firma-24 → FIRMA24", partnerNameLooseKey("Firma-24"), "FIRMA24");
// Diakritika je vyriešená už v kanonickom kľúči.
check("diakritika: Žilina 1", partnerNameLooseKey("Žilina 1"), "ZILINA1");

// Medzery MEDZI SLOVAMI sa nezlučujú — to je hranica medzi toleranciou a
// hádaním. Keby sa zlúčili, „Test Supplier Alpha" by splynulo s hocičím
// podobným bez medzier.
check(
  "medzery medzi slovami zostavaju",
  partnerNameLooseKey("Test Supplier Alpha"),
  "TEST SUPPLIER ALPHA"
);

// Právnu formu odstraňuje už existujúci kanonický kľúč.
check("pravna forma: s.r.o.", partnerNameExactKey("Test Firma s.r.o."), "TEST FIRMA");
check("pravna forma: s. r. o.", partnerNameExactKey("Test Firma s. r. o."), "TEST FIRMA");
check("pravna forma: GmbH", partnerNameExactKey("Test Firma GmbH"), "TEST FIRMA");
check(
  "s.r.o. a s. r. o. su zhodne",
  partnerNameExactKey("Test Firma s.r.o.") === partnerNameExactKey("Test Firma s. r. o."),
  true
);

// -----------------------------------------------------------------------------
// Reálny produkčný prípad: partner „Tester1"
// -----------------------------------------------------------------------------
const PROD: Row[] = [
  { id: "tester1", legal_name: "Tester1" },
  { id: "alpha", legal_name: "Test Supplier Alpha s.r.o." },
];

check("PROD: „Tester1“", resolve("Tester1", PROD), "tester1");
check("PROD: „Tester 1“ (chyba z mobilu)", resolve("Tester 1", PROD), "tester1");
check("PROD: „tester 1“", resolve("tester 1", PROD), "tester1");
check("PROD: „TESTER 1“", resolve("TESTER 1", PROD), "tester1");
check("PROD: „Tester-1“", resolve("Tester-1", PROD), "tester1");
check("PROD: „tester1“", resolve("tester1", PROD), "tester1");

// -----------------------------------------------------------------------------
// ŽIADNE FALOŠNÉ ZHODY
//
// Toto je tá polovica, ktorá chráni pred faktúrou na nesprávnu firmu.
// -----------------------------------------------------------------------------
const FALSE_POSITIVE: Row[] = [
  { id: "t11", legal_name: "Tester11" },
  { id: "t2", legal_name: "Tester2" },
  { id: "tsk", legal_name: "Tester SK" },
  { id: "alpha", legal_name: "Test Supplier Alpha" },
];

check("Tester1 sa NEVYBERIE ako Tester11/Tester2/...", resolve("Tester1", FALSE_POSITIVE), "NENASIEL");
check("Tester 1 sa NEVYBERIE ako Tester11/...", resolve("Tester 1", FALSE_POSITIVE), "NENASIEL");
check("Tester11 != Tester1", partnerNameLooseKey("Tester11") === partnerNameLooseKey("Tester1"), false);
check("Tester2 != Tester1", partnerNameLooseKey("Tester2") === partnerNameLooseKey("Tester1"), false);
check("Tester SK != Tester1", partnerNameLooseKey("Tester SK") === partnerNameLooseKey("Tester1"), false);
check(
  "Test Supplier Alpha != Tester1",
  partnerNameLooseKey("Test Supplier Alpha") === partnerNameLooseKey("Tester1"),
  false
);
// Cislice sa nezlucuju navzajom.
check("Tester 1 1 != Tester 11", partnerNameLooseKey("Tester 1 1") === partnerNameLooseKey("Tester 11"), false);

// -----------------------------------------------------------------------------
// NEJEDNOZNAČNOSŤ — appka sa musí spýtať, nie vybrať
// -----------------------------------------------------------------------------
const AMBIGUOUS: Row[] = [
  { id: "a", legal_name: "Tester1" },
  { id: "b", legal_name: "Tester 1 s.r.o." },
];

// Po odstránení právnej formy a zlúčení oddeľovača sú oba TESTER1 —
// rovnako silné. Vybrať jeden by znamenalo tipovať.
check("dvaja rovnako silni kandidati -> otazka", resolve("Tester 1", AMBIGUOUS), "PYTA_SA(exact:a|b)");
check("to iste pri zapise bez medzery", resolve("Tester1", AMBIGUOUS), "PYTA_SA(exact:a|b)");

// -----------------------------------------------------------------------------
// ČIASTOČNÁ ZHODA JE NÁVRH, NIE VÝBER
// -----------------------------------------------------------------------------
const PARTIAL: Row[] = [{ id: "only", legal_name: "Tester1" }];

// „Tester" je obsiahnuté v „Tester1", ale nie je to ekvivalencia — je
// obsiahnuté aj v „Tester2", ktorý tu len náhodou nie je. Preto otázka
// aj pri jedinom kandidátovi.
check("ciastocna zhoda sa NEVYBERIE sama", resolve("Tester", PARTIAL), "PYTA_SA(suggestion:only)");

const PARTIAL_TWO: Row[] = [
  { id: "a", legal_name: "Tester1" },
  { id: "b", legal_name: "Tester2" },
];
check("ciastocna zhoda s dvoma -> otazka", resolve("Tester", PARTIAL_TWO), "PYTA_SA(suggestion:a|b)");

// -----------------------------------------------------------------------------
// Presná zhoda má prednosť pred čiastočnou
// -----------------------------------------------------------------------------
const PRECEDENCE: Row[] = [
  { id: "presny", legal_name: "Tester1" },
  { id: "dlhsi", legal_name: "Tester1 Bau" },
];
check("presna zhoda vyhrava nad ciastocnou", resolve("Tester1", PRECEDENCE), "presny");
check("presna zhoda vyhrava aj pri medzere", resolve("Tester 1", PRECEDENCE), "presny");

// -----------------------------------------------------------------------------
// Jazyková nezávislosť — normalizácia nesmie byť viazaná na slovenčinu
// -----------------------------------------------------------------------------
const INTL: Row[] = [
  { id: "de", legal_name: "Baufirma24 GmbH" },
  { id: "en", legal_name: "Alpha Works Ltd" },
];
check("DE: Baufirma 24 GmbH", resolve("Baufirma 24 GmbH", INTL), "de");
check("DE: bez pravnej formy", resolve("Baufirma 24", INTL), "de");
check("EN: Alpha Works", resolve("Alpha Works", INTL), "en");
check("EN: s pravnou formou", resolve("Alpha Works Ltd", INTL), "en");

// Prázdny/neplatný vstup nesmie vyriešiť nič.
check("prazdny dopyt", resolve("", PROD), "NENASIEL");
check("iba medzery", resolve("   ", PROD), "NENASIEL");
check("iba interpunkcia", resolve("...", PROD), "NENASIEL");

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
