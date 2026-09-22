// =============================================================================
// Testy rozpoznania riadkových položiek z reči.
//
// SPUSTENIE
//   npm run test:items
//
// ČO SA TU CHRÁNI
// ---------------
// Väčšina testov nižšie overuje, že sa veta NEROZDELILA zle. Chybne
// rozdelená faktúra je horšia než odmietnutý príkaz: „kopanie 300 a
// doprava 50" ako jeden riadok za 50 € je tichá strata 300 € na daňovom
// doklade. Preto tu má „radšej sa spýtaj" prednosť pred „radšej to skús".
// =============================================================================

import assert from "node:assert/strict";
import {
  extractInvoiceItems,
  extractSingleAppendedItem,
  MAX_VOICE_ITEMS,
  MAX_VOICE_UNIT_PRICE,
} from "../lib/intents/invoice-items.ts";

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

/** Kompaktný tvar na porovnávanie: "popis@cena" alebo "popis@?" bez ceny. */
function shape(text: string): string {
  const result = extractInvoiceItems(text);
  if (result.problem) return `PROBLEM:${result.problem}`;
  return result.items.map((i) => `${i.description}@${i.unitPrice ?? "?"}`).join(" | ");
}

// -----------------------------------------------------------------------------
// Dve položky — tri jazyky, presne podľa zadania
// -----------------------------------------------------------------------------
check(
  "SK: dve položky s dvojbodkou",
  shape("Vytvor faktúru pre Tester1: kopanie 300 eur, doprava 50 eur, s 23 percent DPH."),
  "kopanie@300 | doprava@50"
);
check(
  "DE: dve položky",
  shape("Erstelle eine Rechnung für Tester1: Erdarbeiten 300 Euro, Transport 50 Euro, mit 23 Prozent Mehrwertsteuer."),
  "Erdarbeiten@300 | Transport@50"
);
check(
  "EN: dve položky",
  shape("Create an invoice for Tester1: excavation 300 euros, transport 50 euros, with 23 percent VAT."),
  "excavation@300 | transport@50"
);

// Spojka namiesto čiarky — rozdelí sa, lebo cenu má každá strana.
check(
  "SK: spojka „a“ s dvoma cenami",
  shape("Vytvor faktúru pre Tester1 za kopanie 300 eur a dopravu 50 eur s 23 percent DPH."),
  "kopanie@300 | dopravu@50"
);
check("DE: spojka „und“", shape("Rechnung für X für Erdarbeiten 300 Euro und Transport 50 Euro"), "Erdarbeiten@300 | Transport@50");
check("EN: spojka „and“", shape("invoice for X for excavation 300 euros and transport 50 euros"), "excavation@300 | transport@50");

// -----------------------------------------------------------------------------
// Spojka, ktorá je ČASŤOU POPISU — nesmie rozdeliť
//
// Toto je opačná chyba než tichá strata: rozsekať jednu službu na dve.
// -----------------------------------------------------------------------------
check("spojka v popise, jedna cena", shape("faktúru pre X za dovoz a odvoz 300 eur"), "dovoz a odvoz@300");
check("spojka v popise, DE", shape("Rechnung für X für Abfuhr und Anfuhr 300 Euro"), "Abfuhr und Anfuhr@300");

// -----------------------------------------------------------------------------
// Čísla slovom a desatinné
// -----------------------------------------------------------------------------
check("SK: cena slovom", shape("faktúru pre X za kopanie tristo eur"), "kopanie@300");
check("SK: dve položky, slovom aj číslicou", shape("faktúru pre X za kopanie tristo eur, doprava 50 eur"), "kopanie@300 | doprava@50");
check("SK: desatinná čiarka", shape("faktúru pre X za kopanie 50,50 eur"), "kopanie@50.5");
check("EN: desatinná bodka", shape("invoice for X for excavation 50.50 euros"), "excavation@50.5");
check("DE: cena slovom", shape("Rechnung für X für Erdarbeiten dreihundert Euro"), "Erdarbeiten@300");
check("EN: cena slovom", shape("invoice for X for excavation three hundred euros"), "excavation@300");
check("SK: päťdesiat eur", shape("faktúru pre X za dopravu päťdesiat eur"), "dopravu@50");

// -----------------------------------------------------------------------------
// Jedna položka — správanie sa nemení
// -----------------------------------------------------------------------------
check("jedna položka s cenou", shape("Vytvor faktúru pre Tester1 za kopanie 300 eur s 23 percent DPH."), "kopanie@300");
check(
  "jedna položka BEZ ceny → vráti sa s príznakom",
  shape("Vytvor faktúru pre Tester1 za kopanie."),
  "PROBLEM:missing_price"
);

// -----------------------------------------------------------------------------
// NEJEDNOZNAČNOSŤ — druhej položke chýba cena
//
// Najnebezpečnejší prípad: „kopanie 300 a doprava" by sa dalo prečítať aj
// ako jeden popis. Nič sa nevracia, asistent sa spýta.
// -----------------------------------------------------------------------------
check("dve položky, druhej chýba cena", shape("faktúru pre X za kopanie 300 eur, doprava"), "PROBLEM:ambiguous");
check("dve položky, prvej chýba cena", shape("faktúru pre X za kopanie, doprava 50 eur"), "PROBLEM:ambiguous");

// -----------------------------------------------------------------------------
// Bez uvádzacej frázy nie sú položky
// -----------------------------------------------------------------------------
check("žiadna uvádzacia fráza", shape("Vytvor faktúru pre Tester1"), "");
check("prázdny text", shape(""), "");

// -----------------------------------------------------------------------------
// Chvost o DPH nesmie byť položkou
// -----------------------------------------------------------------------------
check("DPH sa nestane položkou", shape("faktúru pre X za kopanie 300 eur s 23 percent DPH"), "kopanie@300");
check("DPH v percentách so znakom", shape("faktúru pre X za kopanie 300 eur s 19% MwSt"), "kopanie@300");
check("DE: mit ... Mehrwertsteuer", shape("Rechnung für X für Erdarbeiten 300 Euro mit 23 Prozent Mehrwertsteuer"), "Erdarbeiten@300");
check("EN: with ... VAT", shape("invoice for X for excavation 300 euros with 23 percent VAT"), "excavation@300");

// -----------------------------------------------------------------------------
// Limity
// -----------------------------------------------------------------------------
{
  const many = Array.from({ length: MAX_VOICE_ITEMS + 1 }, (_, i) => `polozka${i} ${i + 1} eur`).join(", ");
  check("viac než maximum položiek", shape(`faktúru pre X za ${many}`), "PROBLEM:too_many_items");
}
{
  const atLimit = Array.from({ length: MAX_VOICE_ITEMS }, (_, i) => `polozka${i} ${i + 1} eur`).join(", ");
  const result = extractInvoiceItems(`faktúru pre X za ${atLimit}`);
  check("presne maximum položiek prejde", result.items.length, MAX_VOICE_ITEMS);
  check("presne maximum bez problému", result.problem, null);
}
check(
  "extrémna suma sa odmietne",
  shape(`faktúru pre X za kopanie ${MAX_VOICE_UNIT_PRICE + 1} eur`),
  "PROBLEM:ambiguous"
);
{
  const long = "x".repeat(400);
  const result = extractInvoiceItems(`faktúru pre X za ${long} 300 eur`);
  check("popis sa oreže na maximum", result.items[0]?.description.length, 200);
}

// -----------------------------------------------------------------------------
// Doplnenie ďalšej položky počas dialógu
// -----------------------------------------------------------------------------
check("append: pridaj ešte dopravu 50 eur", extractSingleAppendedItem("Pridaj ešte dopravu 50 eur.")?.description, "dopravu");
check("append: cena", extractSingleAppendedItem("Pridaj ešte dopravu 50 eur.")?.unitPrice, 50);
check("append: bez uvádzacieho slovesa", extractSingleAppendedItem("doprava 50 eur")?.unitPrice, 50);
check("append: slovom", extractSingleAppendedItem("doprava päťdesiat eur")?.unitPrice, 50);
check("append: DE", extractSingleAppendedItem("Füge hinzu Transport 50 Euro")?.unitPrice, 50);
check("append: EN", extractSingleAppendedItem("add transport 50 euros")?.unitPrice, 50);

// Bez ceny sa nepridá nič — inak by vznikol riadok za 0 €.
check("append bez ceny → null", extractSingleAppendedItem("pridaj ešte dopravu"), null);
// Dve položky naraz sa nepridávajú — je to presne miesto na tichú chybu.
check("append dvoch naraz → null", extractSingleAppendedItem("doprava 50 eur, montáž 20 eur"), null);
check("append: extrémna suma → null", extractSingleAppendedItem(`doprava ${MAX_VOICE_UNIT_PRICE + 1} eur`), null);
check("append: prázdny → null", extractSingleAppendedItem(""), null);

// -----------------------------------------------------------------------------
// Cena sa NIKDY neprevedie na nulu
//
// Poistka proti najhoršiemu tichému zlyhaniu: doklad za 0 €.
// -----------------------------------------------------------------------------
{
  const inputs = [
    "faktúru pre X za kopanie",
    "faktúru pre X za kopanie 300 eur, doprava",
    "faktúru pre X za nezmysel bez cifry",
  ];
  const zeroLeak = inputs.filter((text) =>
    extractInvoiceItems(text).items.some((item) => item.unitPrice === 0)
  );
  check("žiadny vstup nevyrobí položku za 0", zeroLeak.length, 0);
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
