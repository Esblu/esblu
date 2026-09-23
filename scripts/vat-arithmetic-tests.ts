// =============================================================================
// Testy peňažnej matematiky okolo režimu ceny.
//
// SPUSTENIE
//   npm run test:vat
//
// ČO SA TU CHRÁNI
// ---------------
// Jediná veta: keď používateľ povie sumu S DAŇOU, na doklade musí zostať
// presne tá suma. Nie o cent inde a už vôbec nie o celú daň vyššia.
//
// Počíta to VAT engine (decimal.js), nie model a nie parser. Tento súbor
// overuje jeho výsledky priamo, bez bundlera — preto má `vat-engine.ts`
// relatívne importy.
//
// Zaokrúhľovacia časť sa presunula do scripts/gross-rounding-tests.ts, kde je
// aj vyčerpávajúci test po centoch.
// =============================================================================

import assert from "node:assert/strict";
import { computeInvoiceTotals, taxableFromGross } from "../lib/invoicing/vat-engine.ts";

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

/** Doklad zo súm BEZ dane. */
function fromNet(prices: number[], rate: number) {
  return computeInvoiceTotals(
    prices.map((price) => ({
      quantity: 1,
      unitPrice: price,
      vatCategoryCode: "S" as const,
      vatRate: rate,
    }))
  );
}

/** Doklad zo súm S DAŇOU — tak, ako ho zostaví hlasová cesta. */
function fromGross(prices: number[], rate: number) {
  return computeInvoiceTotals(
    prices.map((price) => ({
      quantity: 1,
      unitPrice: price,
      vatCategoryCode: "S" as const,
      vatRate: rate,
      priceMode: "gross" as const,
    }))
  );
}

// -----------------------------------------------------------------------------
// A. 300 bez dane + 23 % → 369
// -----------------------------------------------------------------------------
{
  const t = fromNet([300], 23);
  check("A základ", t.subtotalAmount, "300.00");
  check("A DPH", t.vatTotalAmount, "69.00");
  check("A spolu", t.totalAmount, "369.00");
}

// -----------------------------------------------------------------------------
// B. 369 S DAŇOU + 23 % → spolu zostáva 369
//
// Nie 453,87. To by vyšlo, keby sa daň pripočítala k sume, ktorá ju už má.
// -----------------------------------------------------------------------------
{
  const t = fromGross([369], 23);
  check("B spolu zostáva vyslovená suma", t.totalAmount, "369.00");
  check("B základ sa dopočítal", t.subtotalAmount, "300.00");
  check("B DPH", t.vatTotalAmount, "69.00");
}

// Zo zadania: 123 € s daňou pri 23 % zostáva 123, nie 151,29.
{
  const t = fromGross([123], 23);
  check("123 s daňou zostáva 123", t.totalAmount, "123.00");
  check("123 s daňou → základ 100", t.subtotalAmount, "100.00");
  check("NIE 151,29", t.totalAmount !== "151.29", true);
}

// -----------------------------------------------------------------------------
// F. Viac položiek so sumami S DAŇOU — reálne čísla z mobilu
//
// Odvoz materiálu 250, Kopanie 1300, Pracovníci 750.
// Každá vyslovená suma musí zostať na svojom riadku nedotknutá.
// -----------------------------------------------------------------------------
{
  const SUMY = [250, 1300, 750];
  const t = fromGross(SUMY, 23);

  check(
    "F každý riadok si drží vyslovenú sumu",
    t.lines.map((line) => line.lineGrossAmount),
    ["250.00", "1300.00", "750.00"]
  );
  check("F spolu = súčet vyslovených súm", t.totalAmount, "2300.00");
  check("F základ", t.subtotalAmount, "1869.92");
  check("F DPH", t.vatTotalAmount, "430.08");
  check(
    "F základ + DPH = spolu",
    (Number(t.subtotalAmount) + Number(t.vatTotalAmount)).toFixed(2),
    t.totalAmount
  );

  // Tie isté sumy BEZ dane dajú celkom iný doklad — presne o tú daň.
  const netto = fromNet(SUMY, 23);
  check("tie isté sumy bez dane: základ", netto.subtotalAmount, "2300.00");
  check("tie isté sumy bez dane: spolu", netto.totalAmount, "2829.00");
  check("rozdiel medzi režimami je celá daň", netto.totalAmount !== t.totalAmount, true);
}

// -----------------------------------------------------------------------------
// Nulová daň: cena s daňou sa rovná cene bez dane
// -----------------------------------------------------------------------------
check("0 % — nič sa nedelí", taxableFromGross(250, "S", 0), "250.00");
check("kategória Z — nič sa nedelí", taxableFromGross(250, "Z", 23), "250.00");
check("kategória E — nič sa nedelí", taxableFromGross(250, "E", 23), "250.00");
check("kategória AE — nič sa nedelí", taxableFromGross(250, "AE", 23), "250.00");

{
  const t = fromGross([250], 0);
  check("0 %: základ = vyslovená suma", t.subtotalAmount, "250.00");
  check("0 %: daň je nula", t.vatTotalAmount, "0.00");
  check("0 %: spolu = vyslovená suma", t.totalAmount, "250.00");
}

// -----------------------------------------------------------------------------
// Rozpis dane sedí na riadky — obe strany dokladu hovoria to isté
// -----------------------------------------------------------------------------
{
  const t = fromGross([750, 250, 800], 23);
  check("rozpis má jednu sadzbu", t.breakdown.length, 1);
  check("rozpis: základ", t.breakdown[0].taxableAmount, "1463.41");
  check("rozpis: daň", t.breakdown[0].vatAmount, "336.59");
  check("rozpis = súčet riadkových základov", t.breakdown[0].taxableAmount, t.subtotalAmount);
  check(
    "rozpis = súčet riadkových daní",
    t.lines
      .reduce((acc, line) => acc + Number(line.lineVatAmount), 0)
      .toFixed(2),
    t.breakdown[0].vatAmount
  );
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
