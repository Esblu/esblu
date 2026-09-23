// =============================================================================
// Testy režimu ceny: sú vyslovené sumy s daňou, alebo bez nej?
//
// SPUSTENIE
//   npm run test:pricemode
//
// PREČO EXISTUJÚ
// --------------
// Z reálneho testu na mobile. Používateľ nadiktoval tri položky, appka sa
// spýtala na DPH a on odpovedal „Uvedené ceny sú už s DPH." Appka zopakovala
// tú istú otázku, slovo za slovom — akoby nič nepovedal.
//
// Otázka pritom bola správna: z vety „ceny sú s DPH" sadzba nevyplýva.
// Chyba bola v tom, že odpoveď nikam neuložila. Sú to dve otázky:
//
//   „Ako sú sumy vyjadrené?"   → s daňou / bez dane
//   „Aká daň sa uplatní?"      → sadzba a kategória
//
// Prvá odpoveď sa zapamätá, druhá sa dopýta. Ani jedna sa neodvodzuje z
// druhej — a sadzba už vôbec nie z krajiny, partnera či sumy.
// =============================================================================

import assert from "node:assert/strict";
import {
  detectPriceModeStatement,
  DEFAULT_PRICE_MODE,
} from "../lib/invoicing/price-mode.ts";
import {
  applyAnswer,
  effectivePriceMode,
  readSlots,
  serializeSlots,
  missingInvoiceFields,
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
// 1. Rozpoznanie vety (G: SK/DE/EN varianty)
// -----------------------------------------------------------------------------
check("presná veta z produkcie", detectPriceModeStatement("Uvedené ceny sú už s DPH."), "gross");
check("SK: ceny sú s DPH", detectPriceModeStatement("Ceny sú s DPH."), "gross");
check("SK: tie ceny sú už s DPH", detectPriceModeStatement("Tie ceny sú už s DPH"), "gross");
check("SK: vrátane dane", detectPriceModeStatement("sumy sú vrátane dane"), "gross");
check("SK: brutto", detectPriceModeStatement("brutto"), "gross");
check("SK: bez DPH", detectPriceModeStatement("Nie, ceny sú bez DPH."), "net");
check("SK: bez dane", detectPriceModeStatement("ceny sú bez dane"), "net");
check("DE: inkl. MwSt", detectPriceModeStatement("Die Preise sind inkl. MwSt."), "gross");
check("DE: inklusive Mehrwertsteuer", detectPriceModeStatement("Preise inklusive Mehrwertsteuer"), "gross");
check("DE: netto", detectPriceModeStatement("Die Preise verstehen sich netto."), "net");
check("DE: zzgl. MwSt", detectPriceModeStatement("Preise zzgl. MwSt"), "net");
check("EN: prices include VAT", detectPriceModeStatement("Prices include VAT."), "gross");
check("EN: VAT included", detectPriceModeStatement("the amounts have VAT included"), "gross");
check("EN: excluding VAT", detectPriceModeStatement("prices are excluding VAT"), "net");

// -----------------------------------------------------------------------------
// 2. Veta SO SADZBOU nie je veta o režime
//
// „s 23 percent DPH" znamená daň navyše. Keby sa čítala ako cena s daňou,
// doklad by vyšiel o celú daň nižší — a nikto by si to nevšimol.
// -----------------------------------------------------------------------------
check("SK: s 23 percent DPH", detectPriceModeStatement("kopanie 300 eur s 23 percent DPH"), null);
check("SK: s 23 % DPH", detectPriceModeStatement("kopanie 300 eur s 23 % DPH"), null);
check("DE: mit 23 Prozent MwSt", detectPriceModeStatement("Erdarbeiten 300 Euro mit 23 Prozent MwSt"), null);
check("EN: with 23 percent VAT", detectPriceModeStatement("excavation 300 euros with 23 percent VAT"), null);
check("EN: including 23% VAT", detectPriceModeStatement("including 23% VAT"), null);
check("holá sadzba nie je režim", detectPriceModeStatement("23 percent"), null);
check("bežná veta o režime nehovorí", detectPriceModeStatement("Vytvor faktúru pre Tester1"), null);

// Veta, ktorá povie OBOJE, nastaví režim — a sadzbu si vezme vrstva vyššie.
check(
  "SK: ceny sú s DPH, sadzba 23",
  detectPriceModeStatement("ceny sú s DPH, sadzba 23 percent"),
  "gross"
);

// -----------------------------------------------------------------------------
// 3. Zmiešané režimy → otázka, nie odhad
// -----------------------------------------------------------------------------
check("SK: prvá cena je s DPH", detectPriceModeStatement("Prvá cena je s DPH."), "mixed");
check("SK: iba prvá je s DPH", detectPriceModeStatement("iba prvá je s DPH, ostatné bez"), "mixed");
check("EN: first price includes VAT", detectPriceModeStatement("the first price includes VAT"), "mixed");
check("obe naraz", detectPriceModeStatement("ceny sú s DPH aj bez DPH"), "mixed");

// „verstehen sich netto" obsahuje „erste" ako PODREŤAZEC. Porovnávanie
// podreťazcom by z jasnej vety spravilo zmiešaný režim — rovnaká chyba, aká
// kedysi urobila z výberu partnera „Tester1" pridávanie položky.
check(
  'podreťazec „erste“ vo „verstehen“ nie je poradie',
  detectPriceModeStatement("Die Preise verstehen sich netto."),
  "net"
);

// -----------------------------------------------------------------------------
// 4. E: oprava po tom, čo sú položky už rozpoznané
//
// Odpoveď o režime NESMIE zhodiť nič, čo už v dialógu je.
// -----------------------------------------------------------------------------
const PO_PRVEJ_VETE: InvoiceDraftSlots = {
  partnerId: "11111111-1111-4111-8111-111111111111",
  items: [
    { description: "Odvoz materiálu", unitPrice: 250 },
    { description: "Kopanie", unitPrice: 1300 },
    { description: "Pracovníci", unitPrice: 750 },
  ],
  currency: "EUR",
  spokenAmounts: [250, 1300, 750],
};

check("pred odpoveďou chýba iba DPH", missingInvoiceFields(PO_PRVEJ_VETE), ["vat"]);

{
  const po = applyAnswer(PO_PRVEJ_VETE, "vat", "Uvedené ceny sú už s DPH.", []);

  check("režim sa uložil", po.priceMode, "gross");
  check("položky zostali", po.items?.length, 3);
  check("sumy zostali", po.items?.map((i) => i.unitPrice), [250, 1300, 750]);
  check("popisy zostali", po.items?.map((i) => i.description), [
    "Odvoz materiálu",
    "Kopanie",
    "Pracovníci",
  ]);
  check("partner zostal", po.partnerId, "11111111-1111-4111-8111-111111111111");
  check("mena zostala", po.currency, "EUR");
  check("sadzba sa NEODVODILA", po.vatRate, undefined);
  check("kategória sa NEODVODILA", po.vatCategoryCode, undefined);
  check("otázka na DPH stále platí", missingInvoiceFields(po), ["vat"]);

  // Až teraz používateľ povie sadzbu — a režim mu zostane.
  const poSadzbe = applyAnswer(po, "vat", "23 percent", []);
  check("sadzba sa doplnila", poSadzbe.vatRate, 23);
  check("kategória S", poSadzbe.vatCategoryCode, "S");
  check("režim prežil druhú odpoveď", poSadzbe.priceMode, "gross");
  check("po sadzbe už nič nechýba", missingInvoiceFields(poSadzbe), []);
  check("sumy stále tie isté", poSadzbe.items?.map((i) => i.unitPrice), [250, 1300, 750]);
}

// Oprava opačným smerom.
{
  const gross = applyAnswer(PO_PRVEJ_VETE, "vat", "ceny sú s DPH", []);
  const opravene = applyAnswer(gross, "vat", "Nie, ceny sú bez DPH.", []);
  check("oprava prepíše režim", opravene.priceMode, "net");
  check("oprava nezhodí položky", opravene.items?.length, 3);
}

// Jedna veta, ktorá povie oboje.
{
  const naraz = applyAnswer(PO_PRVEJ_VETE, "vat", "ceny sú s DPH, sadzba 23 percent", []);
  check("naraz: režim", naraz.priceMode, "gross");
  check("naraz: sadzba", naraz.vatRate, 23);
  check("naraz: už nič nechýba", missingInvoiceFields(naraz), []);
}

// Zmiešaný režim sa do slotov NEULOŽÍ — rozhoduje o ňom otázka vo flow.
{
  const zmiesane = applyAnswer(PO_PRVEJ_VETE, "vat", "Prvá cena je s DPH.", []);
  check("zmiešaný režim sa neuloží", zmiesane.priceMode, undefined);
}

// -----------------------------------------------------------------------------
// 5. Predvolený režim a cesta cez databázu
// -----------------------------------------------------------------------------
check("bez vyjadrenia platí bez dane", DEFAULT_PRICE_MODE, "net");
check("effectivePriceMode dopĺňa predvolený", effectivePriceMode({}), "net");
check(
  "effectivePriceMode rešpektuje uložený",
  effectivePriceMode({ priceMode: "gross" }),
  "gross"
);

{
  const roundTripped = readSlots(serializeSlots({ ...PO_PRVEJ_VETE, priceMode: "gross" }));
  check("režim prežije cestu cez jsonb", roundTripped.priceMode, "gross");
  check("položky prežijú cestu cez jsonb", roundTripped.items?.length, 3);
}

// Podvrhnutá hodnota v uloženom stave sa neprevezme.
check("podvrhnutý režim sa zahodí", readSlots({ priceMode: "s dph" }).priceMode, undefined);
check("podvrhnutý režim číslom sa zahodí", readSlots({ priceMode: 1 }).priceMode, undefined);

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
