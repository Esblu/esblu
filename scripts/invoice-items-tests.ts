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
import { normalizeSpokenAmounts } from "../lib/intents/number-words.ts";

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
function shape(text: string, partnerHint?: string): string {
  const result = extractInvoiceItems(text, partnerHint);
  if (result.problem) return `PROBLEM:${result.problem}`;
  return result.items.map((i) => `${i.description}@${i.unitPrice ?? "?"}`).join(" | ");
}

// -----------------------------------------------------------------------------
// Veta BEZ uvádzacej frázy (reálny mobilný prepis)
//
// Takto ľudia hovoria: príkaz, meno, položky, DPH — všetko oddelené iba
// čiarkami. Skoršia verzia v takejto vete nenašla ANI JEDNU položku
// (chýbala fráza „za"), vrstva nad ňou doplnila jediný riadok z modelu a
// druhá položka zmizla bez stopy. Presne to sa stalo v produkcii:
// nadiktované „kopanie 300 + dovoz 50", vytvorené „kopanie 300".
// -----------------------------------------------------------------------------
const MOBILE_TRANSCRIPT = "Vytvor faktúru, tester 1, kopanie 300 euro, dovoz 50 euro, 23% DPH.";

check(
  "reálny prepis: obe položky prežijú",
  shape(MOBILE_TRANSCRIPT, "tester 1"),
  "kopanie@300 | dovoz@50"
);
check(
  "reálny prepis bez známeho partnera: radšej otázka než 3 riadky",
  shape(MOBILE_TRANSCRIPT),
  "PROBLEM:ambiguous"
);
check(
  "SK bez frázy, s medzerou v mene partnera",
  shape("Vytvor faktúru pre Tester 1, kopanie 300 eur, dovoz 50 eur, s 23 percent DPH.", "Tester 1"),
  "kopanie@300 | dovoz@50"
);
check(
  "DE bez frázy",
  shape("Erstelle Rechnung, Tester1, Erdarbeiten 300 Euro, Transport 50 Euro, 23% MwSt", "Tester1"),
  "Erdarbeiten@300 | Transport@50"
);
check(
  "EN: meno za predložkou „for\" sa nestane položkou",
  shape("Create invoice for Tester1, excavation 300 euros, transport 50 euros, 23% VAT", "Tester1"),
  "excavation@300 | transport@50"
);
check("holá dvojica s čiarkou", shape("kopanie 300, doprava 50"), "kopanie@300 | doprava@50");
check("holá dvojica so spojkou", shape("kopanie 300 a doprava 50"), "kopanie@300 | doprava@50");
check(
  "holá dvojica s menou",
  shape("kopanie 300 eur, doprava 50 eur, 23% DPH"),
  "kopanie@300 | doprava@50"
);
check(
  "holá dvojica, DPH slovom",
  shape("kopanie 300 euro, dovoz 50 euro, 23 percent DPH"),
  "kopanie@300 | dovoz@50"
);
check(
  "druhá položka bez ceny → otázka, nie čiastočný doklad",
  shape("Vytvor faktúru, Tester1, kopanie 300 eur, doprava", "Tester1"),
  "PROBLEM:ambiguous"
);

// Otázka musí vedieť pomenovať, čomu appka rozumela — inak by používateľ
// musel hádať, ktorý riadok doplniť.
{
  const parsed = extractInvoiceItems("Vytvor faktúru, Tester1, kopanie 300 eur, doprava", "Tester1");
  check("pri odmietnutí sa nevracia žiadna položka", parsed.items.length, 0);
  check("ale rozpoznané sa nesú ďalej", parsed.recognized.length, 2);
  check("prvé rozpoznané má cenu", parsed.recognized[0].unitPrice, 300);
  check("druhé rozpoznané cenu nemá", parsed.recognized[1].unitPrice, undefined);
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
// Množstvo × jednotková cena („10 hodín po 35 eur")
// -----------------------------------------------------------------------------
//
// Parser iba rozpozná množstvo, jednotku a jednotkovú cenu. Sumy riadkov a
// dokladu počíta kanonický model (pozri scripts/voice-conversation-tests.ts,
// cent-sensitive prípady cez previewDraftTotals).

function qp(text: string): unknown {
  const result = extractInvoiceItems(`za ${text}`);
  if (result.problem === "ambiguous" || result.items.length === 0) return result.problem ?? "none";
  return result.items.map((item) => ({ d: item.description, q: item.quantity, u: item.unit, p: item.unitPrice }));
}

check("A: Výkopové práce, 10 hodín po 35 eur", qp("Výkopové práce, 10 hodín po 35 eur."), [{ d: "Výkopové práce", q: 10, u: "hod", p: 35 }]);
check("A2: bez čiarky", qp("Výkopové práce 10 hodín po 35 eur."), [{ d: "Výkopové práce", q: 10, u: "hod", p: 35 }]);
check("A3: množstvo pred popisom", qp("10 hodín výkopových prác po 35 eur."), [{ d: "výkopových prác", q: 10, u: "hod", p: 35 }]);
check("A4: za … za hodinu", qp("Výkopové práce, 10 hodín za 35 eur za hodinu."), [{ d: "Výkopové práce", q: 10, u: "hod", p: 35 }]);
check("B: Betón, 5 kusov po 12 eur", qp("Betón, 5 kusov po 12 eur."), [{ d: "Betón", q: 5, u: "ks", p: 12 }]);
check("B2: Filter, 2 kusy po 25 eur", qp("Filter, 2 kusy po 25 eur."), [{ d: "Filter", q: 2, u: "ks", p: 25 }]);
check("B3: Štrk, 3 tony po 30 eur", qp("Štrk, 3 tony po 30 eur."), [{ d: "Štrk", q: 3, u: "t", p: 30 }]);
check("B4: Doprava, 3 hodiny po 40 eur", qp("Doprava, 3 hodiny po 40 eur."), [{ d: "Doprava", q: 3, u: "hod", p: 40 }]);
check("C: 10 h po 35 €", qp("Výkopové práce, 10 h po 35 €."), [{ d: "Výkopové práce", q: 10, u: "hod", p: 35 }]);
check("D: 2,5 hodiny", qp("Práca, 2,5 hodiny po 40 eur"), [{ d: "Práca", q: 2.5, u: "hod", p: 40 }]);
check("D2: 10.5 hodiny", qp("Práca, 10.5 hodiny po 40 eur"), [{ d: "Práca", q: 10.5, u: "hod", p: 40 }]);
check("E: 10 hodín za 350 eur → nie jednotková cena (otázka)", qp("Výkopové práce 10 hodín za 350 eur"), "ambiguous");
check("E2: nikdy 10 × 350", JSON.stringify(extractInvoiceItems("za Výkopové práce 10 hodín za 350 eur").items).includes('"quantity":10'), false);
check("H: EN at … per hour", qp("Excavation work, 10 hours at 35 euros per hour."), [{ d: "Excavation work", q: 10, u: "hod", p: 35 }]);
check("H2: EN each", qp("10 hours of excavation at 35 euros each."), [{ d: "excavation", q: 10, u: "hod", p: 35 }]);
check("H3: DE zu", qp("Baggerarbeiten, 10 Stunden zu 35 Euro."), [{ d: "Baggerarbeiten", q: 10, u: "hod", p: 35 }]);
check("H4: DE à", qp("10 Stunden Baggerarbeiten à 35 Euro."), [{ d: "Baggerarbeiten", q: 10, u: "hod", p: 35 }]);
check("množstvo × cena bez popisu → otázka, nie riadok s vetou", qp("10 hodín po 35 eur."), "ambiguous");
check("nulové množstvo → otázka", qp("Práca, 0 hodín po 35 eur"), "ambiguous");
check("záporné množstvo → otázka", qp("Práca, -2 hodiny po 35 eur"), "ambiguous");
check("neznáma jednotka → otázka", qp("Práca 10 kopaní po 35 eur"), "ambiguous");
check("dve položky s množstvom", qp("Výkopové práce, 10 hodín po 35 eur, doprava, 2 hodiny po 40 eur"), [
  { d: "Výkopové práce", q: 10, u: "hod", p: 35 },
  { d: "doprava", q: 2, u: "hod", p: 40 },
]);
check("zmiešané: množstvo × cena + paušál", qp("Výkopové práce, 10 hodín po 35 eur, doprava 80 eur"), [
  { d: "Výkopové práce", q: 10, u: "hod", p: 35 },
  { d: "doprava", q: undefined, u: undefined, p: 80 },
]);
check("regresia: kopanie 300 a doprava 50 bez množstva", qp("kopanie 300 eur a doprava 50 eur"), [
  { d: "kopanie", q: undefined, u: undefined, p: 300 },
  { d: "doprava", q: undefined, u: undefined, p: 50 },
]);
check("F: doplnenie — Pridaj ešte dopravu, 2 hodiny po 40 eur", extractSingleAppendedItem("Pridaj ešte dopravu, 2 hodiny po 40 eur."), {
  description: "dopravu", quantity: 2, unit: "hod", unitPrice: 40, currency: "EUR",
});
check("F2: doplnenie bez množstva ostáva", extractSingleAppendedItem("Pridaj ešte dopravu 80 eur."), { description: "dopravu", unitPrice: 80, currency: "EUR" });
check("F3: doplnenie so záporným množstvom → null", extractSingleAppendedItem("Pridaj ešte dopravu, -2 hodiny po 40 eur."), null);
check("prvá veta s partnerom", extractInvoiceItems("Vytvor faktúru pre Tester1 za výkopové práce, 10 hodín po 35 eur.", "Tester1").items, [
  { description: "výkopové práce", quantity: 10, unit: "hod", unitPrice: 35, currency: "EUR" },
]);

// -----------------------------------------------------------------------------
// Produkčné vety z mobilu: výplňové „suma", počet v popise, celková suma,
// čisté popisy bez čísel, mena iba na konci (iba v odpovedi, fail closed inde)
// -----------------------------------------------------------------------------
const brief = (r: { items: { description: string; unitPrice?: number }[] }) => r.items.map((i) => [i.description, i.unitPrice]);
check("A: „suma“ a „za dvoch pracovníkov“ → 3 riadky, počet ostáva v popise",
  brief(extractInvoiceItems("za Za kopanie suma 300 eur, za odvoz materiálu suma 650 eur a za dvoch pracovníkov suma 830 eur.")),
  [["kopanie", 300], ["odvoz materiálu", 650], ["dvoch pracovníkov", 830]]);
{
  const r = extractInvoiceItems("Vytvor faktúru Tester1 za kopanie, za odvoz materiálu, za pracovníkov, suma spolu 1832 eur.", "Tester1");
  check("B: celková suma sa nerozpočíta", r.statedTotal, 1832);
  check("B: 3 popisy bez ceny", brief(r), [["kopanie", undefined], ["odvoz materiálu", undefined], ["pracovníkov", undefined]]);
  check("B: problém = chýbajúce ceny (nie nejasné)", r.problem, "missing_price");
}
check("C: čisté popisy bez čísla", brief(extractInvoiceItems("za Kopanie, odvoz materiálu, pracovníci.")), [["Kopanie", undefined], ["odvoz materiálu", undefined], ["pracovníci", undefined]]);
{
  const r = extractInvoiceItems("za kopanie 300, odvoz 650, pracovníci 882, spolu 1832 eur", undefined, { answerContext: true });
  check("súčet pri cenách sa iba zapamätá", r.statedTotal, 1832);
}
check("mena iba na konci — v odpovedi prenesená", brief(extractInvoiceItems("za Kopanie 300, odvoz 650, pracovníci 830 eur.", undefined, { answerContext: true })),
  [["Kopanie", 300], ["odvoz", 650], ["pracovníci", 830]]);
check("mena iba na konci — v prvej vete bez partnera fail closed", shape("za Kopanie 300, odvoz 650, pracovníci 830 eur."), "PROBLEM:ambiguous");
check("mena iba na konci — nepravidelný tvar aj v odpovedi fail closed",
  extractInvoiceItems("za Kopanie 300, 650 odvoz, pracovníci 830 eur.", undefined, { answerContext: true }).problem, "ambiguous");
check("dva súčty v jednej vete → nejasné", extractInvoiceItems("za kopanie, odvoz, spolu 500 eur, celkom 600 eur").problem, "ambiguous");
check("„kopanie a odvoz spolu 500 eur“ bez ďalších riadkov = jeden riadok",
  brief(extractInvoiceItems("za kopanie a odvoz spolu 500 eur")), [["kopanie a odvoz spolu", 500]]);
check("„Ešte materiál 120 eur“ = doplnenie", extractSingleAppendedItem("Ešte materiál 120 eur."), { description: "materiál", unitPrice: 120, currency: "EUR" });

{
  const r = extractInvoiceItems("Vytvor testér jedna za kopanie materiál, odvoz materiálu, pracovníci za 10 831 eur s DPH.", "testér jedna");
  check("H: „10 831 eur“ je jedna suma = celková suma za zoznamom", r.statedTotal, 10831);
  check("H: 3 popisy bez ceny, nič nerozpočítané", brief(r), [["kopanie materiál", undefined], ["odvoz materiálu", undefined], ["pracovníci", undefined]]);
}
check("tisíce s medzerou (aj nezalomiteľnou) = jedna suma", brief(extractInvoiceItems("za kopanie 10 831 eur")), [["kopanie", 10831]]);
check("tisíce s nezalomiteľnou medzerou", brief(extractInvoiceItems("za kopanie 1\u00a0250 eur")), [["kopanie", 1250]]);
check("čiarka sa pri tisícoch neprekračuje", brief(extractInvoiceItems("za kopanie 300, odvoz 650 eur", undefined, { answerContext: true })), [["kopanie", 300], ["odvoz", 650]]);
check("„10 hodín po 35 eur“ ostáva množstvo × cena", extractInvoiceItems("za práca, 10 hodín po 35 eur").items, [{ description: "práca", quantity: 10, unit: "hod", unitPrice: 35, currency: "EUR" }]);
check("suma uprostred výpočtu nie je celková suma", extractInvoiceItems("za kopanie, odvoz za 300 eur, pracovníci").problem, "ambiguous");

check("„10 831 €“ → 10831, symbol meny nie je v popise", brief(extractInvoiceItems("za kopanie 10 831 €")), [["kopanie", 10831]]);
check("„1 250 €“ → 1250", brief(extractInvoiceItems("za kopanie 1 250 €")), [["kopanie", 1250]]);
check("úzka nezalomiteľná medzera", brief(extractInvoiceItems("za kopanie 1\u202f250 eur")), [["kopanie", 1250]]);
check("tisíce + desatinná čiarka „1 250,50 eur“", brief(extractInvoiceItems("za kopanie 1 250,50 eur")), [["kopanie", 1250.5]]);
check("desatinné formáty bez zmeny", [brief(extractInvoiceItems("za kopanie 50,50 eur")), brief(extractInvoiceItems("za kopanie 50.50 eur")), brief(extractInvoiceItems("za kopanie 1.250,50 eur"))],
  [[["kopanie", 50.5]], [["kopanie", 50.5]], [["kopanie", 1250.5]]]);
check("množstvo × cena s tisícmi „2 hodiny po 1 200 eur“", extractInvoiceItems("za výkopové práce 2 hodiny po 1 200 eur").items,
  [{ description: "výkopové práce", quantity: 2, unit: "hod", unitPrice: 1200, currency: "EUR" }]);
check("čísla bez meny sa nespájajú", normalizeSpokenAmounts("Stroj 10 831 a 5 kusov"), "Stroj 10 831 a 5 kusov");

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
