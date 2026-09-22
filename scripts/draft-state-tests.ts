// =============================================================================
// Testy stavového automatu hlasovej faktúry.
//
// SPUSTENIE
//   npm run test:state
//
// PREČO EXISTUJÚ
// --------------
// Vznikli z reálnej chyby na mobile. Používateľ nadiktoval dvojpoložkovú
// faktúru, appka sa správne spýtala, ktorého z dvoch partnerov myslí, on
// vybral „Tester1" — a dostal odpoveď „Nerozumel som, akú položku a za akú
// sumu pridať."
//
// Príčina bola v poradí vetiev: heuristika „pridaj ešte…" sa vyhodnocovala
// pred smerovaním podľa položenej otázky a porovnávala PODREŤAZCOM. Meno
// „Tester1" po odstránení diakritiky obsahuje „este" z „ešte" — výber
// partnera sa tak tváril ako pridávanie položky a rozpracované položky
// sa nedali dokončiť.
//
// Tieto testy preto strážia dve veci naraz: že o význame odpovede
// rozhoduje POLOŽENÁ OTÁZKA, a že už rozpoznané položky prežijú
// upresňovanie partnera.
// =============================================================================

import assert from "node:assert/strict";
import {
  looksLikeItemAppend,
  missingInvoiceFields,
  applyAnswer,
  readSlots,
  serializeSlots,
  appendItemFromAnswer,
  type InvoiceDraftSlots,
} from "../lib/intents/invoice-slots.ts";

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
// 1. Presne to, čo chybu spôsobilo
// -----------------------------------------------------------------------------
check('„Tester1" NIE JE pridanie položky', looksLikeItemAppend("Tester1"), false);
check(
  '„Tester1 · 4678922778" (popisok tlačidla) NIE JE pridanie',
  looksLikeItemAppend("Tester1 · 4678922778"),
  false
);
check('„Test Supplier Alpha" NIE JE pridanie', looksLikeItemAppend("Test Supplier Alpha"), false);
// Ďalšie mená, v ktorých sa kmene náhodou vyskytujú ako podreťazec.
check('„Adam" NIE JE pridanie (obsahuje „ada")', looksLikeItemAppend("Adam"), false);
check('„Dodavatel" NIE JE pridanie', looksLikeItemAppend("Dodavatel"), false);

// Skutočné pridanie sa musí naďalej rozpoznať.
check('„Pridaj ešte dopravu 50 eur." JE pridanie', looksLikeItemAppend("Pridaj ešte dopravu 50 eur."), true);
check('„doplň dopravu 50" JE pridanie', looksLikeItemAppend("doplň dopravu 50"), true);
check('DE: „Füge Transport hinzu" JE pridanie', looksLikeItemAppend("Füge Transport 50 Euro hinzu"), true);
check('EN: „add transport 50" JE pridanie', looksLikeItemAppend("add transport 50 euros"), true);

// -----------------------------------------------------------------------------
// 2. Sloty z pôvodného príkazu prežijú upresnenie partnera
//
// Stav po prvej vete: dve položky, DPH 23 %, chýba iba partner.
// -----------------------------------------------------------------------------
const AFTER_FIRST_UTTERANCE: InvoiceDraftSlots = {
  partnerCandidateIds: [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ],
  items: [
    { description: "kopanie", unitPrice: 300 },
    { description: "doprava", unitPrice: 50 },
  ],
  currency: "EUR",
  vatCategoryCode: "S",
  vatRate: 23,
};

check(
  "chýba iba výber partnera",
  missingInvoiceFields(AFTER_FIRST_UTTERANCE),
  ["partnerChoice"]
);

// Uloženie a načítanie z databázy nesmie nič stratiť — sloty cestujú
// cez jsonb a späť sa validujú riadok po riadku.
{
  const roundTripped = readSlots(serializeSlots(AFTER_FIRST_UTTERANCE));
  check("cesta cez jsonb zachová 2 položky", roundTripped.items?.length, 2);
  check("cesta cez jsonb zachová sumy", roundTripped.items?.map((i) => i.unitPrice), [300, 50]);
  check("cesta cez jsonb zachová DPH", roundTripped.vatRate, 23);
  check("cesta cez jsonb zachová kategóriu", roundTripped.vatCategoryCode, "S");
  check("cesta cez jsonb zachová menu", roundTripped.currency, "EUR");
}

// Výber partnera (tak, ako ho spracuje server) mení VÝHRADNE partnera.
{
  const resolved: InvoiceDraftSlots = {
    ...AFTER_FIRST_UTTERANCE,
    partnerId: "22222222-2222-4222-8222-222222222222",
    partnerCandidateIds: undefined,
  };

  check("po výbere partnera už nič nechýba", missingInvoiceFields(resolved), []);
  check("položky zostali nedotknuté", resolved.items?.length, 2);
  check("sumy zostali", resolved.items?.map((i) => i.unitPrice), [300, 50]);
  check("DPH zostala", resolved.vatRate, 23);
  check("mena zostala", resolved.currency, "EUR");
}

// Voľný text pri výbere partnera nesmie prepísať položky.
{
  const after = applyAnswer(AFTER_FIRST_UTTERANCE, "partnerChoice", "Tester1", [
    { id: "22222222-2222-4222-8222-222222222222", label: "Tester1 · 4678922778" },
  ]);
  check("textový výber nastaví partnera", after.partnerId, "22222222-2222-4222-8222-222222222222");
  check("textový výber nechá položky", after.items?.length, 2);
  check("textový výber nechá DPH", after.vatRate, 23);
}

// -----------------------------------------------------------------------------
// 3. Ďalšie poradia (zadanie, bod 8)
// -----------------------------------------------------------------------------

// A) partner nejednoznačný + chýba DPH → po výbere partnera sa pýta IBA DPH.
{
  const slots: InvoiceDraftSlots = {
    partnerCandidateIds: ["11111111-1111-4111-8111-111111111111"],
    items: [{ description: "kopanie", unitPrice: 300 }],
  };
  check("A: najprv partner", missingInvoiceFields(slots)[0], "partnerChoice");

  const resolved = { ...slots, partnerId: "11111111-1111-4111-8111-111111111111", partnerCandidateIds: undefined };
  check("A: potom už len DPH", missingInvoiceFields(resolved), ["vat"]);
}

// B) partner presný + chýba suma → pýta sa IBA suma.
{
  const slots: InvoiceDraftSlots = {
    partnerId: "11111111-1111-4111-8111-111111111111",
    items: [{ description: "kopanie" }],
    vatCategoryCode: "S",
    vatRate: 23,
  };
  check("B: chýba iba cena položky", missingInvoiceFields(slots), ["itemPrice"]);

  const after = applyAnswer(slots, "itemPrice", "300 eur", []);
  check("B: cena sa doplní do prvej položky bez ceny", after.items?.[0].unitPrice, 300);
  check("B: potom už nič nechýba", missingInvoiceFields(after), []);
}

// C) dve položky, druhej chýba cena → otázka smeruje na DRUHÚ.
{
  const slots: InvoiceDraftSlots = {
    partnerId: "11111111-1111-4111-8111-111111111111",
    items: [{ description: "kopanie", unitPrice: 300 }, { description: "doprava" }],
    vatCategoryCode: "S",
    vatRate: 23,
  };
  const after = applyAnswer(slots, "itemPrice", "50 eur", []);
  check("C: prvá položka nedotknutá", after.items?.[0].unitPrice, 300);
  check("C: druhá dostala cenu", after.items?.[1].unitPrice, 50);
}

// -----------------------------------------------------------------------------
// 4. Pridanie položky naozaj pripája
// -----------------------------------------------------------------------------
{
  const slots: InvoiceDraftSlots = {
    partnerId: "11111111-1111-4111-8111-111111111111",
    items: [{ description: "kopanie", unitPrice: 300 }],
    vatCategoryCode: "S",
    vatRate: 23,
  };
  const after = appendItemFromAnswer(slots, "Pridaj ešte dopravu 50 eur.");
  check("append: dva riadky", after?.items?.length, 2);
  check("append: pôvodný zostal", after?.items?.[0].description, "kopanie");
  check("append: nový pribudol", after?.items?.[1].unitPrice, 50);
  check("append: DPH nedotknutá", after?.vatRate, 23);
}

// -----------------------------------------------------------------------------
// 5. Podvrhnuté hodnoty v uloženom stave sa neprevezmú
//
// Uložený jsonb je pre server VSTUP, nie pamäť procesu.
// -----------------------------------------------------------------------------
{
  const hostile = readSlots({
    items: [
      { description: "ok", unitPrice: 100 },
      { description: "zaporna", unitPrice: -5 },
      { description: "nekonecna", unitPrice: Number.POSITIVE_INFINITY },
      { description: "extremna", unitPrice: 999_999_999 },
      { description: "" },
    ],
    vatRate: 250,
    currency: "eur; drop table invoices",
    partnerId: "nie-uuid",
  });

  // Riadok bez popisu zanikne celý; riadok s popisom prežije, ale nedôveryhodná
  // cena sa NEPREVEZME a NEZMENÍ sa na nulu — pole zostane prázdne a asistent
  // sa dopýta. Nula by sa totiž na faktúre tvárila ako legitímna cena.
  check("podvrh: riadok bez popisu zanikne", hostile.items?.length, 4);
  check("podvrh: platná cena prejde", hostile.items?.[0].unitPrice, 100);
  check("podvrh: záporná cena sa zahodí (nie nula)", hostile.items?.[1].unitPrice, undefined);
  check("podvrh: Infinity sa zahodí (nie nula)", hostile.items?.[2].unitPrice, undefined);
  check("podvrh: cena nad limitom sa zahodí (nie nula)", hostile.items?.[3].unitPrice, undefined);
  check(
    "podvrh: chýbajúce ceny sa vypýtajú",
    missingInvoiceFields({ ...hostile, partnerId: "11111111-1111-4111-8111-111111111111", vatCategoryCode: "S", vatRate: 23 }),
    ["itemPrice"]
  );
  check("podvrh: sadzba mimo rozsahu sa zahodí", hostile.vatRate, undefined);
  check("podvrh: neplatná mena sa zahodí", hostile.currency, undefined);
  check("podvrh: neplatné UUID partnera sa zahodí", hostile.partnerId, undefined);
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
