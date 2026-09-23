// =============================================================================
// Zobrazenie peňazí — zlý údaj nesmie zhasnúť modul.
//
// SPUSTENIE
//   npm run test:format
//
// PREČO EXISTUJE
// --------------
// Z produkcie. Používateľ založil koncept faktúry a do poľa meny sa dostalo
//
//     "EUR "        ← medzera na konci
//
// `Intl.NumberFormat` pri neplatnom kóde meny nevráti nič náhradné — vyhodí
// `RangeError: Invalid currency code : EUR `. V Reacte to znamená, že padne
// celý strom komponentov: modul Faktúry prestal ísť otvoriť a používateľ
// videl prázdnu chybovú stránku.
//
// Register, detail dokladu aj PDF mali každý vlastnú kópiu toho istého
// nechráneného volania, takže spadli všetky tri cesty naraz.
//
// PRAVIDLO, KTORÉ SA TU DRŽÍ
// --------------------------
// Mena je ÚDAJ, nie kód. Prichádza z formulára, z databázy, zo skenu
// dokladu. Zlý údaj má byť VIDIEŤ ako zlý údaj — nemá zhasnúť obrazovku.
//
// Suma sa pritom nikdy nemení. Mení sa iba to, ako sa zobrazí.
// =============================================================================

import assert from "node:assert/strict";
import { formatMoney, normalizeCurrencyCode } from "../lib/i18n/format.ts";
import { normalizeCurrency } from "../lib/invoices-currency.ts";

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

/**
 * Zobrazenie s normalizovanými medzerami.
 *
 * `Intl` oddeľuje sumu od symbolu meny NEZALOMITEĽNOU medzerou (U+00A0) a
 * tisícky úzkou medzerou (U+202F). Je to správne typograficky a nezmyselné
 * na porovnávanie v teste — test by potom overoval, aký druh medzery má
 * práve tento Node, nie či sa suma zobrazila.
 */
function money(value: string): string {
  return value.replace(/[\u00a0\u202f\u2009]/g, " ");
}

/** Zavolá funkciu a povie, či vyhodila výnimku. Nič viac. */
function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
  }
}

// -----------------------------------------------------------------------------
// 1. PRESNÝ RIADOK Z PRODUKCIE
//
// Koncept 9a3ce0a8-a9e2-48e8-b6aa-3e698a9d7036, mena "EUR ", suma 0.00.
// Toto je ten riadok, ktorý zhodil modul Faktúry.
// -----------------------------------------------------------------------------
{
  // Najprv sa dokáže, že surové Intl na tomto vstupe NAOZAJ padá — inak by
  // test nižšie nič nedokazoval.
  const raw = throws(() =>
    new Intl.NumberFormat("sk-SK", { style: "currency", currency: "EUR " }).format(0)
  );
  check("surové Intl na „EUR " + '"' + " padá", raw !== null, true);
  check("a je to RangeError", raw?.startsWith("RangeError") ?? false, true);

  // A potom, že naša cesta nepadá a sumu zobrazí.
  check("formatMoney na „EUR " + '"' + " nepadá", throws(() => formatMoney(0, "EUR ", "sk")), null);
  check("a zobrazí sumu ako menu", money(formatMoney(0, "EUR ", "sk")), "0,00 €");
  check("aj pri nenulovej sume", money(formatMoney(1800, "EUR ", "sk")), "1 800,00 €");
}

// -----------------------------------------------------------------------------
// 2. VARIANTY, KTORÉ ĽUDIA NAOZAJ NAPÍŠU
// -----------------------------------------------------------------------------
check("bežné EUR", money(formatMoney(369, "EUR", "sk")), "369,00 €");
check("medzera na konci", money(formatMoney(369, "EUR ", "sk")), "369,00 €");
check("medzera na začiatku", money(formatMoney(369, " EUR", "sk")), "369,00 €");
check("medzery z oboch strán", money(formatMoney(369, "  EUR  ", "sk")), "369,00 €");
check("malé písmená", money(formatMoney(369, "eur", "sk")), "369,00 €");
check("zmiešané písmená", money(formatMoney(369, "Eur", "sk")), "369,00 €");
check("tabulátor", money(formatMoney(369, "EUR\t", "sk")), "369,00 €");
check("nový riadok", money(formatMoney(369, "EUR\n", "sk")), "369,00 €");

// Iné meny musia ďalej fungovať — normalizácia nesmie nič prepísať na EUR.
check("CZK", formatMoney(100, "czk", "sk").includes("100,00"), true);
check("USD zostáva USD", formatMoney(100, "usd", "en").includes("100.00"), true);

// -----------------------------------------------------------------------------
// 3. ÚDAJ, KTORÝ MENOU NIE JE
//
// Nehádame. Suma sa zobrazí a pokazený kód sa ukáže tak, ako je uložený —
// aby ho bolo vidieť a dalo sa opraviť. Prepísať ho ticho na „EUR" by
// znamenalo tvrdiť o cudzej faktúre menu, ktorú nikto nezadal.
// -----------------------------------------------------------------------------
check("dvojpísmenový kód", money(formatMoney(369, "EU", "sk")), "369,00 EU");
check("štyri písmená", money(formatMoney(369, "EURO", "sk")), "369,00 EURO");
check("číslo", money(formatMoney(369, "123", "sk")), "369,00 123");
check("úplný nezmysel", money(formatMoney(369, "???", "sk")), "369,00 ???");
check("prázdny reťazec", money(formatMoney(369, "", "sk")), "369,00");
check("samé medzery", money(formatMoney(369, "   ", "sk")), "369,00");
check("null", money(formatMoney(369, null, "sk")), "369,00");
check("undefined", money(formatMoney(369, undefined, "sk")), "369,00");

// Žiadny z týchto vstupov nesmie vyhodiť výnimku.
{
  const zlyVstupy: (string | null | undefined)[] = [
    "EUR ", " EUR", "eur", "EU", "EURO", "", "   ", null, undefined, "123",
    "€", "E U R", "EUR;", "\u0000EUR", "EUR​", "XXX", "ZZZ", "AAA",
  ];
  const padli = zlyVstupy.filter((c) => throws(() => formatMoney(1, c, "sk")) !== null);
  check("žiadny vstup meny nezhodí zobrazenie", padli, []);
}

// -----------------------------------------------------------------------------
// 4. SUMA SA NEMENÍ
//
// Zobrazenie smie zmeniť tvar, nikdy nie hodnotu.
// -----------------------------------------------------------------------------
{
  const cislo = (s: string) => Number(s.replace(/[^\d,.-]/g, "").replace(/\s/g, "").replace(",", "."));
  for (const suma of [0, 0.01, 1, 123, 369, 1800, 1463.41, 999999.99]) {
    check(`suma ${suma} sa nezmení ani pri pokazenej mene`, cislo(formatMoney(suma, "EUR ", "sk")), suma);
  }
}
check("nekonečno sa nevykreslí ako nezmysel", money(formatMoney(Infinity, "EUR", "sk")), "0,00 €");
check("NaN takisto", money(formatMoney(NaN, "EUR", "sk")), "0,00 €");

// -----------------------------------------------------------------------------
// 5. NORMALIZÁCIA KÓDU
// -----------------------------------------------------------------------------
check("normalizeCurrencyCode: EUR ", normalizeCurrencyCode("EUR "), "EUR");
check("normalizeCurrencyCode: eur", normalizeCurrencyCode("eur"), "EUR");
check("normalizeCurrencyCode: EU", normalizeCurrencyCode("EU"), null);
check("normalizeCurrencyCode: null", normalizeCurrencyCode(null), null);

// Pri ZÁPISE sa mena orezáva, ale nevymýšľa.
check("zápis: EUR ", normalizeCurrency("EUR "), "EUR");
check("zápis: eur", normalizeCurrency("eur"), "EUR");
check("zápis: ' czk '", normalizeCurrency(" czk "), "CZK");
check("zápis nevymýšľa menu za používateľa", normalizeCurrency("EU"), "EU");
check("zápis aspoň oreže medzery", normalizeCurrency("  EU  "), "EU");
check("zápis: prázdne zostane prázdne", normalizeCurrency("   "), "");

// -----------------------------------------------------------------------------
// 6. VŠETKY JAZYKY
// -----------------------------------------------------------------------------
for (const locale of ["sk", "de", "en"] as const) {
  check(`${locale}: pokazená mena nepadá`, throws(() => formatMoney(369, "EUR ", locale)), null);
  check(`${locale}: platná mena nepadá`, throws(() => formatMoney(369, "EUR", locale)), null);
  check(`${locale}: prázdna mena nepadá`, throws(() => formatMoney(369, "", locale)), null);
}

// -----------------------------------------------------------------------------
// 7. TVARY DOKLADOV Z REGISTRA  (A–H zo zadania)
//
// Register vykresľuje sumu pre KAŽDÝ doklad. Keby ktorýkoľvek z týchto
// tvarov zhodil formátovanie, padne celý zoznam — aj doklady, ktoré sú
// v poriadku.
// -----------------------------------------------------------------------------
{
  type Riadok = { popis: string; total: number; currency: string | null };
  const riadky: Riadok[] = [
    { popis: "A bez odovzdania", total: 369, currency: "EUR" },
    { popis: "B iba export údajov", total: 123, currency: "EUR" },
    { popis: "C úplný balík", total: 1800, currency: "EUR" },
    { popis: "D neúspešný export", total: 0, currency: "EUR" },
    { popis: "E starý riadok, nové stĺpce NULL", total: 369, currency: "EUR" },
    { popis: "F doklad bez položky exportu", total: 0, currency: "EUR" },
    { popis: "G koncept s pokazenou menou", total: 0, currency: "EUR " },
    { popis: "H prijatý doklad", total: 123, currency: "EUR" },
    { popis: "mena chýba úplne", total: 50, currency: null },
  ];

  const padli = riadky.filter((r) => throws(() => formatMoney(r.total, r.currency, "sk")) !== null);
  check("žiadny tvar dokladu nezhodí register", padli.map((r) => r.popis), []);
  check("a všetky vrátia neprázdny text", riadky.every((r) => formatMoney(r.total, r.currency, "sk").length > 0), true);
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
