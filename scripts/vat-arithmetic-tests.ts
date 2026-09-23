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
// =============================================================================

import assert from "node:assert/strict";
import {
  computeInvoiceTotals,
  netUnitPriceFromGross,
} from "../lib/invoicing/vat-engine.ts";

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
      unitPrice: netUnitPriceFromGross(price, "S" as const, rate),
      vatCategoryCode: "S" as const,
      vatRate: rate,
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
// Hranica presnosti: najviac JEDEN cent, a povedzme to nahlas
//
// Nie každá suma s daňou sa dá zložiť z ceny v centoch: „0,99 € s 23 % DPH"
// nemá základ, ktorý by po pripočítaní dane dal presne 0,99. Odchýlka je
// vždy najviac cent — a to sa dá zmerať, nie iba tvrdiť.
//
// Väčšia presnosť základu to nerieši: riadkový základ sa aj tak počíta na
// centy — šesť desatinných miest dalo pri meraní presne tie isté výsledky.
// -----------------------------------------------------------------------------
{
  const SADZBY = [5, 10, 19, 20, 21, 23, 25, 27];
  let najvacsiRozdiel = 0;
  let nesedi = 0;
  let spolu = 0;

  for (const rate of SADZBY) {
    for (let cents = 1; cents <= 20000; cents += 7) {
      const price = cents / 100;
      spolu++;
      const total = Number(fromGross([price], rate).totalAmount);
      const rozdiel = Math.abs(total - price);
      if (rozdiel > 0.0001) {
        nesedi++;
        if (rozdiel > najvacsiRozdiel) najvacsiRozdiel = rozdiel;
      }
    }
  }

  check("odchýlka nikdy nepresiahne jeden cent", najvacsiRozdiel <= 0.01 + 1e-9, true);
  check("a väčšina súm sedí presne", nesedi / spolu < 0.2, true);
  check("meranie naozaj prebehlo", spolu > 20000, true);
}

// Konkrétny prípad, ktorý presne nevyjde — nech je v teste vidieť, nie
// schovaný za priemerom.
{
  const t = fromGross([0.99], 23);
  check("0,99 € s 23 %: základ v centoch", t.subtotalAmount, "0.80");
  check("0,99 € s 23 %: riadok vyjde 0,98", t.totalAmount, "0.98");
}

// Sumy z reálneho testu vychádzajú na cent presne.
{
  const presne = [250, 1300, 750, 369, 123, 100, 1234.56];
  const zle = presne.filter(
    (price) => fromGross([price], 23).totalAmount !== price.toFixed(2)
  );
  check("reálne sumy sedia presne", zle, []);
}

// -----------------------------------------------------------------------------
// Nulová daň: cena s daňou sa rovná cene bez dane
// -----------------------------------------------------------------------------
check("0 % — nič sa nedelí", netUnitPriceFromGross(250, "S", 0), "250.00");
check("kategória Z — nič sa nedelí", netUnitPriceFromGross(250, "Z", 23), "250.00");
check("kategória E — nič sa nedelí", netUnitPriceFromGross(250, "E", 23), "250.00");
check("kategória AE — nič sa nedelí", netUnitPriceFromGross(250, "AE", 23), "250.00");

{
  const t = fromGross([250], 0);
  check("0 %: základ = vyslovená suma", t.subtotalAmount, "250.00");
  check("0 %: daň je nula", t.vatTotalAmount, "0.00");
  check("0 %: spolu = vyslovená suma", t.totalAmount, "250.00");
}

// -----------------------------------------------------------------------------
// Základ je v centoch — a je to tak správne
//
// 250 / 1,23 = 203,252032…, uloží sa 203,25. Vyššia presnosť by nepomohla
// (riadkový základ sa počíta na centy) a v koncepte by človek videl cenu
// s desiatimi číslicami namiesto sumy, akú by sám napísal.
// -----------------------------------------------------------------------------
check("základ je zaokrúhlený na centy", netUnitPriceFromGross(250, "S", 23), "203.25");
check("a z neho vyjde presne vyslovená suma", fromGross([250], 23).totalAmount, "250.00");

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
