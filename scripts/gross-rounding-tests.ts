// =============================================================================
// Invariant vyslovenej sumy: čo človek povedal, to na doklade zostane.
//
// SPUSTENIE
//   npm run test:gross
//
// PREČO EXISTUJE
// --------------
// Z produkcie. Používateľ nadiktoval tri položky so sumami S DAŇOU:
//
//     kopanie 750, dovoz materiálu 250, pracovníci 800     (23 %)
//
// Povedal 1800,00 €. Esblu ukázalo 1800,01 €.
//
// Cent navyše vznikol z dvoch nezávislých zaokrúhlení. Základ sa dopočítal
// po riadkoch a každý sa zaokrúhlil zvlášť (609,76 + 203,25 + 650,41 =
// 1463,42), no daň sa podľa EN16931 počíta zo zosčítaného základu:
// round(1463,42 × 23 %) = 336,59. Dokopy 1800,01. Obe čísla „správne", súčet
// nie. A vyslovených 1800,00 nebolo v modeli uložených nikde, takže sa to
// nemalo o čo oprieť.
//
// Tento súbor drží pravidlo, ktoré z toho vzniklo: v režime gross je
// autoritatívna suma S DAŇOU, zaokrúhľuje sa raz na skupinu a dopočítaný
// základ sa rozdeľuje späť na riadky. Súčet potom sedí vždy — a „vždy" sa
// tu meria, netvrdí.
// =============================================================================

import assert from "node:assert/strict";
import { computeInvoiceTotals } from "../lib/invoicing/vat-engine.ts";
import { invoicePriceMode, unitPriceLabelKey } from "../lib/invoicing/price-mode.ts";

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

type Line = { price: number; qty?: number };

function gross(lines: (number | Line)[], rate: number) {
  return computeInvoiceTotals(
    lines.map((line) => {
      const { price, qty = 1 } = typeof line === "number" ? { price: line } : line;
      return {
        quantity: qty,
        unitPrice: price,
        vatCategoryCode: "S" as const,
        vatRate: rate,
        priceMode: "gross" as const,
      };
    })
  );
}

function net(lines: (number | Line)[], rate: number) {
  return computeInvoiceTotals(
    lines.map((line) => {
      const { price, qty = 1 } = typeof line === "number" ? { price: line } : line;
      return { quantity: qty, unitPrice: price, vatCategoryCode: "S" as const, vatRate: rate };
    })
  );
}

/** Čo musí platiť na KAŽDOM doklade, nech obsahuje čokoľvek. */
function assertReconciles(label: string, totals: ReturnType<typeof gross>): void {
  const sumLines = (pick: (l: (typeof totals.lines)[number]) => string) =>
    totals.lines.reduce((acc, line) => acc + Number(pick(line)), 0).toFixed(2);

  check(`${label}: Σ riadkových základov = základ`, sumLines((l) => l.lineNetAmount), totals.subtotalAmount);
  check(`${label}: Σ riadkových daní = daň`, sumLines((l) => l.lineVatAmount), totals.vatTotalAmount);
  check(`${label}: Σ riadkových súm = spolu`, sumLines((l) => l.lineGrossAmount), totals.totalAmount);
  check(
    `${label}: základ + daň = spolu`,
    (Number(totals.subtotalAmount) + Number(totals.vatTotalAmount)).toFixed(2),
    totals.totalAmount
  );
  check(
    `${label}: rozpis = základ`,
    totals.breakdown.reduce((acc, b) => acc + Number(b.taxableAmount), 0).toFixed(2),
    totals.subtotalAmount
  );
  check(
    `${label}: rozpis = daň`,
    totals.breakdown.reduce((acc, b) => acc + Number(b.vatAmount), 0).toFixed(2),
    totals.vatTotalAmount
  );
  // Každý riadok sedí aj sám pre seba.
  totals.lines.forEach((line, index) => {
    check(
      `${label}: riadok ${index + 1} základ + daň = suma`,
      (Number(line.lineNetAmount) + Number(line.lineVatAmount)).toFixed(2),
      line.lineGrossAmount
    );
  });
}

// -----------------------------------------------------------------------------
// 1. PRESNÝ PRÍPAD Z PRODUKCIE
// -----------------------------------------------------------------------------
{
  const t = gross([750, 250, 800], 23);
  check("1800: základ", t.subtotalAmount, "1463.41");
  check("1800: daň", t.vatTotalAmount, "336.59");
  check("1800: spolu", t.totalAmount, "1800.00");
  check("1800: NIE 1800,01", t.totalAmount !== "1800.01", true);
  check("1800: NIE základ 1463,42", t.subtotalAmount !== "1463.42", true);
  check(
    "1800: vyslovené sumy zostali na svojich riadkoch",
    t.lines.map((l) => l.lineGrossAmount),
    ["750.00", "250.00", "800.00"]
  );
  assertReconciles("1800", t);
}

// -----------------------------------------------------------------------------
// 2. MALÉ SUMY — presne tie, kde staré riešenie strácalo cent
//
// „0,99 € s 23 %" predtým dalo riadok 0,98 €. Teraz zostane 0,99 €: základ
// 0,80 a daň 0,19 — daň je zvyšok, nie druhé zaokrúhlenie.
// -----------------------------------------------------------------------------
for (const [price, expectedNet] of [
  [0.99, "0.80"],
  [1.0, "0.81"],
  [1.01, "0.82"],
  [0.01, "0.01"],
  [0.05, "0.04"],
] as [number, string][]) {
  const t = gross([price], 23);
  check(`${price} s daňou zostáva ${price}`, t.totalAmount, price.toFixed(2));
  check(`${price}: základ`, t.subtotalAmount, expectedNet);
  assertReconciles(`${price}`, t);
}

// -----------------------------------------------------------------------------
// 3. VIACPOLOŽKOVÉ REGRESIE ZO ZADANIA
// -----------------------------------------------------------------------------
for (const [prices, expected] of [
  [[250, 1300, 750], "2300.00"],
  [[750, 250, 800], "1800.00"],
  [[300, 45], "345.00"],
  [[300, 50], "350.00"],
  [[123], "123.00"],
  [[369], "369.00"],
] as [number[], string][]) {
  const t = gross(prices, 23);
  check(`${prices.join("+")} s daňou = ${expected}`, t.totalAmount, expected);
  check(
    `${prices.join("+")}: Σ vyslovených = spolu`,
    prices.reduce((a, b) => a + b, 0).toFixed(2),
    t.totalAmount
  );
  assertReconciles(prices.join("+"), t);
}

// -----------------------------------------------------------------------------
// 4. MNOŽSTVO
//
// Cena s daňou je cena ZA JEDNOTKU. Množstvo nesmie zmeniť jej význam.
// -----------------------------------------------------------------------------
{
  const t = gross([{ price: 4.99, qty: 2 }], 23);
  check("2 × 4,99 s daňou: riadok", t.lines[0].lineGrossAmount, "9.98");
  check("2 × 4,99 s daňou: spolu", t.totalAmount, "9.98");
  assertReconciles("2×4.99", t);
}
{
  // Množstvo 1 dá to isté, čo tá istá suma bez množstva.
  const a = gross([{ price: 750, qty: 1 }], 23);
  const b = gross([750], 23);
  check("množstvo 1 nič nemení", a.totalAmount, b.totalAmount);
  check("množstvo 1 nič nemení (základ)", a.subtotalAmount, b.subtotalAmount);
}
{
  // Desatinné množstvo — stĺpec je numeric(18,6), takže hodiny a kilogramy
  // sú legitímne.
  const t = gross([{ price: 100, qty: 2.5 }], 23);
  check("2,5 × 100 s daňou: riadok", t.lines[0].lineGrossAmount, "250.00");
  assertReconciles("2.5×100", t);
}
{
  const t = gross([{ price: 33.33, qty: 3 }, { price: 0.01, qty: 7 }], 20);
  assertReconciles("desatinné kombinácie", t);
}

// -----------------------------------------------------------------------------
// 5. REŽIM BEZ DANE SA NEZMENIL
//
// Toto je poistka proti „opravil som gross a rozbil net". Súčty v režime bez
// dane musia zostať presne také, aké boli — 300 + 23 % je 369, koniec.
// -----------------------------------------------------------------------------
{
  const t = net([300], 23);
  check("net 300: základ", t.subtotalAmount, "300.00");
  check("net 300: daň", t.vatTotalAmount, "69.00");
  check("net 300: spolu", t.totalAmount, "369.00");
  assertReconciles("net 300", t);
}
{
  const t = net([250, 1300, 750], 23);
  check("net 2300: základ", t.subtotalAmount, "2300.00");
  check("net 2300: daň", t.vatTotalAmount, "529.00");
  check("net 2300: spolu", t.totalAmount, "2829.00");
  assertReconciles("net 2300", t);
}
{
  // EN16931 BR-CO-17: daň zo ZOSČÍTANÉHO základu, nie zo súčtu riadkových
  // daní. 0,05 × 23 % = 0,0115 → po riadkoch by to dalo 3 × 0,01 = 0,03,
  // zo súčtu 0,15 × 23 % = 0,0345 → 0,03. Tu zhodou okolností to isté;
  // dôležité je, že sa počíta zo skupiny.
  const t = net([0.05, 0.05, 0.05], 23);
  check("net: daň zo skupiny", t.vatTotalAmount, "0.03");
  assertReconciles("net drobné", t);
}

// -----------------------------------------------------------------------------
// 6. VYČERPÁVAJÚCI TEST PO CENTOCH
//
// Pre každú sumu od 0,01 € po 200,00 € a pre osem sadzieb: vyslovená suma sa
// musí na doklade objaviť presne. Žiadna odchýlka, ani jeden cent.
//
// Predchádzajúca verzia tu odchýlku MALA — priznanú a odmeranú (~15 %
// prípadov, najviac cent). Po zmene kanonického modelu je nula, a nie preto,
// že sa test zmiernil.
// -----------------------------------------------------------------------------
{
  const SADZBY = [5, 10, 19, 20, 21, 23, 25, 27];
  let maxDeviation = 0;
  let mismatches = 0;
  let tested = 0;
  let firstFailure = "";

  for (const rate of SADZBY) {
    for (let cents = 1; cents <= 20000; cents++) {
      const price = cents / 100;
      tested++;
      const t = gross([price], rate);
      const deviation = Math.abs(Number(t.totalAmount) - price);
      if (deviation > 1e-9) {
        mismatches++;
        if (deviation > maxDeviation) maxDeviation = deviation;
        if (!firstFailure) firstFailure = `${price} @ ${rate}% → ${t.totalAmount}`;
      }
      // Základ + daň musí sedieť na cent aj tu.
      if (
        (Number(t.subtotalAmount) + Number(t.vatTotalAmount)).toFixed(2) !== t.totalAmount
      ) {
        mismatches++;
        if (!firstFailure) firstFailure = `nerekonciluje: ${price} @ ${rate}%`;
      }
    }
  }

  console.log(
    `\n  vyčerpávajúci test: ${tested.toLocaleString("sk-SK")} súm × ${SADZBY.length} sadzieb, ` +
      `nezhôd ${mismatches}, najväčšia odchýlka ${maxDeviation.toFixed(4)} €` +
      (firstFailure ? `\n  prvá nezhoda: ${firstFailure}` : "")
  );

  check("vyčerpávajúci test naozaj prebehol", tested, 160000);
  check("žiadna vyslovená suma sa nezmenila", mismatches, 0);
  check("najväčšia odchýlka je nula", maxDeviation, 0);
}

// -----------------------------------------------------------------------------
// 7. VIACRIADKOVÝ PROPERTY TEST
//
// Náhodné (ale reprodukovateľné) doklady: 2–8 riadkov, náhodné sumy a
// množstvá. Súčet vyslovených súm sa musí rovnať celkovej sume dokladu a
// základ + daň takisto. Kumulatívny posun cez viac riadkov je presne to, čo
// jednoriadkový test nezachytí.
// -----------------------------------------------------------------------------
{
  // Deterministický generátor — test, ktorý raz za čas zlyhá inak, je horší
  // než žiadny.
  let seed = 20260923;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const SADZBY = [0, 5, 10, 19, 20, 23, 27];
  let cases = 0;
  let mismatches = 0;
  let firstFailure = "";

  for (let i = 0; i < 4000; i++) {
    const rate = SADZBY[Math.floor(rnd() * SADZBY.length)];
    const count = 2 + Math.floor(rnd() * 7);
    const lines: Line[] = [];
    for (let j = 0; j < count; j++) {
      lines.push({
        price: Math.max(1, Math.round(rnd() * 500000)) / 100,
        qty: rnd() < 0.7 ? 1 : 1 + Math.floor(rnd() * 12),
      });
    }
    cases++;

    const t = gross(lines, rate);
    const spokenSum = lines
      .reduce((acc, l) => acc + Number((l.price * (l.qty ?? 1)).toFixed(2)), 0)
      .toFixed(2);

    const sumLineGross = t.lines
      .reduce((acc, l) => acc + Number(l.lineGrossAmount), 0)
      .toFixed(2);
    const sumLineNet = t.lines.reduce((acc, l) => acc + Number(l.lineNetAmount), 0).toFixed(2);
    const sumLineVat = t.lines.reduce((acc, l) => acc + Number(l.lineVatAmount), 0).toFixed(2);

    const ok =
      sumLineGross === t.totalAmount &&
      spokenSum === t.totalAmount &&
      sumLineNet === t.subtotalAmount &&
      sumLineVat === t.vatTotalAmount &&
      (Number(t.subtotalAmount) + Number(t.vatTotalAmount)).toFixed(2) === t.totalAmount;

    if (!ok) {
      mismatches++;
      if (!firstFailure) {
        firstFailure = `${rate}% ${JSON.stringify(lines)} → spolu ${t.totalAmount}, vyslovené ${spokenSum}`;
      }
    }
  }

  console.log(
    `  viacriadkový property test: ${cases} dokladov, nezhôd ${mismatches}` +
      (firstFailure ? `\n  prvá nezhoda: ${firstFailure}` : "")
  );
  check("property test naozaj prebehol", cases, 4000);
  check("žiadny doklad sa nerozišiel so súčtom riadkov", mismatches, 0);
}

// -----------------------------------------------------------------------------
// 8. ZMIEŠANÉ REŽIMY NA JEDNOM DOKLADE
//
// Esblu ich neponúka — hlas sa radšej spýta. Ale aritmetika ich nesmie
// skaziť, keby raz vznikli inou cestou: riadky s daňou a bez dane sa počítajú
// oddelene a v rozpise sa spoja pod jednu sadzbu.
// -----------------------------------------------------------------------------
{
  const t = computeInvoiceTotals([
    { quantity: 1, unitPrice: 123, vatCategoryCode: "S", vatRate: 23, priceMode: "gross" },
    { quantity: 1, unitPrice: 100, vatCategoryCode: "S", vatRate: 23, priceMode: "net" },
  ]);
  check("zmiešané: riadok s daňou si drží sumu", t.lines[0].lineGrossAmount, "123.00");
  check("zmiešané: riadok bez dane si drží základ", t.lines[1].lineNetAmount, "100.00");
  check("zmiešané: základ", t.subtotalAmount, "200.00");
  check("zmiešané: daň", t.vatTotalAmount, "46.00");
  check("zmiešané: spolu", t.totalAmount, "246.00");
  check("zmiešané: rozpis má JEDNU sadzbu", t.breakdown.length, 1);
  assertReconciles("zmiešané", t);
}

// -----------------------------------------------------------------------------
// 9. VIAC SADZIEB A KATEGÓRIÍ NARAZ
// -----------------------------------------------------------------------------
{
  const t = computeInvoiceTotals([
    { quantity: 1, unitPrice: 123, vatCategoryCode: "S", vatRate: 23, priceMode: "gross" },
    { quantity: 1, unitPrice: 105, vatCategoryCode: "S", vatRate: 5, priceMode: "gross" },
    { quantity: 1, unitPrice: 50, vatCategoryCode: "Z", vatRate: 0, priceMode: "gross" },
    { quantity: 1, unitPrice: 70, vatCategoryCode: "AE", vatRate: 23, priceMode: "gross" },
  ]);
  check("viac sadzieb: spolu = súčet vyslovených", t.totalAmount, "348.00");
  check("viac sadzieb: rozpis má štyri skupiny", t.breakdown.length, 4);
  check("viac sadzieb: AE nemá daň", t.lines[3].lineVatAmount, "0.00");
  check("viac sadzieb: Z nemá daň", t.lines[2].lineVatAmount, "0.00");
  assertReconciles("viac sadzieb", t);
}

// -----------------------------------------------------------------------------
// 10. ODVODENÝ REŽIM DOKLADU A POPIS STĹPCA
// -----------------------------------------------------------------------------
check("prázdny doklad: predvolený režim", invoicePriceMode([]), "net");
check(
  "všetky riadky s daňou",
  invoicePriceMode([{ price_mode: "gross" }, { price_mode: "gross" }]),
  "gross"
);
check("chýbajúci režim znamená bez dane", invoicePriceMode([{}, { price_mode: "net" }]), "net");
check(
  "nezhodné riadky: režim sa netvrdí",
  invoicePriceMode([{ price_mode: "gross" }, { price_mode: "net" }]),
  null
);
check(
  "popis stĺpca: s daňou",
  unitPriceLabelKey("gross"),
  "invoices.newInvoice.itemUnitPriceGrossLabel"
);
check(
  "popis stĺpca: bez dane",
  unitPriceLabelKey("net"),
  "invoices.newInvoice.itemUnitPriceNetLabel"
);
check(
  "popis stĺpca pri nezhode zostáva neutrálny",
  unitPriceLabelKey(null),
  "invoices.newInvoice.itemUnitPriceLabel"
);

// -----------------------------------------------------------------------------
// 11. ROZDELENIE CENTOV JE DETERMINISTICKÉ
//
// Ten istý doklad musí dať to isté vždy — inak sa koncept a finalizácia
// rozídu a nikto nezistí prečo.
// -----------------------------------------------------------------------------
{
  const once = JSON.stringify(gross([750, 250, 800], 23));
  for (let i = 0; i < 50; i++) {
    if (JSON.stringify(gross([750, 250, 800], 23)) !== once) {
      check("rozdelenie centov je deterministické", false, true);
      break;
    }
  }
  check("rozdelenie centov je deterministické", true, true);

  // Pri rovnakom zvyšku rozhoduje poradie riadku, nie náhoda: 100 + 100 pri
  // 23 % má základ 162,60 a obidva riadky majú rovnaký nárok na zvyšok.
  const t = gross([100, 100], 23);
  check("zhodné riadky: základ", t.subtotalAmount, "162.60");
  check("zhodné riadky: rozdelenie", t.lines.map((l) => l.lineNetAmount), ["81.30", "81.30"]);
  assertReconciles("zhodné riadky", t);
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
