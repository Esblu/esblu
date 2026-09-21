// =============================================================================
// Testy deterministického parsovania pre hlasové príkazy.
//
// SPUSTENIE
//   npm run test:voice
//
// PREČO BEZ TESTOVACIEHO FRAMEWORKU
// ---------------------------------
// Repo dnes žiadny nemá a pridať ho kvôli dvom čistým funkciám by znamenalo
// novú závislosť, konfiguráciu a ďalšiu vec, ktorú treba udržiavať. Node od
// verzie 22 vie spustiť TypeScript priamo (`--experimental-strip-types`) a
// `node:assert` stačí. Keď raz v repe framework vznikne, tieto prípady sa
// doňho prenesú bez zmeny — sú to obyčajné dvojice vstup/očakávanie.
//
// ČO SA TU TESTUJE
// ----------------
// Výhradne vrstvy, ktoré MUSIA byť deterministické: prevod čísla, meny a
// sadzby DPH z reči. Klasifikáciu zámeru testovať takto nemá zmysel (je
// modelová a jej allowlist je vynútený inde), ale číslo má jednu správnu
// hodnotu a nesmie sa rozísť naprieč jazykmi.
// =============================================================================

import assert from "node:assert/strict";
import {
  findNumber,
  findCurrency,
  findVatRate,
  mentionsVat,
} from "../lib/intents/number-words.ts";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    passed++;
  } catch {
    failed++;
    console.error(`FAIL  ${label}\n      dostal: ${JSON.stringify(actual)}\n      čakal:  ${JSON.stringify(expected)}`);
  }
}

function num(text: string): number | null {
  return findNumber(text)?.value ?? null;
}

// -----------------------------------------------------------------------------
// Čísla — slovenčina
// -----------------------------------------------------------------------------
check("sk: 300 eur", num("300 eur"), 300);
check("sk: tristo eur", num("tristo eur"), 300);
check("sk: tristo päťdesiat", num("tristo päťdesiat"), 350);
check("sk: dvetisíctristopäťdesiat", num("dvetisíctristopäťdesiat"), 2350);
check("sk: päťdesiat", num("päťdesiat"), 50);
check("sk: dvadsaťtri", num("dvadsaťtri"), 23);
check("sk: tisíc", num("tisíc"), 1000);
// Bez diakritiky — prepis reči ju nemusí doplniť.
check("sk: patdesiat bez diakritiky", num("patdesiat"), 50);

// -----------------------------------------------------------------------------
// Čísla — nemčina (zlepené a obrátené číslovky)
// -----------------------------------------------------------------------------
check("de: dreihundert Euro", num("dreihundert Euro"), 300);
check("de: dreihundertfünfzig", num("dreihundertfünfzig"), 350);
check("de: einundzwanzig", num("einundzwanzig"), 21);
check("de: zweitausenddreihundert", num("zweitausenddreihundert"), 2300);
check("de: 300 Euro", num("300 Euro"), 300);

// -----------------------------------------------------------------------------
// Čísla — angličtina
// -----------------------------------------------------------------------------
check("en: three hundred euros", num("three hundred euros"), 300);
check("en: three hundred fifty", num("three hundred fifty"), 350);
check("en: two thousand three hundred", num("two thousand three hundred"), 2300);
check("en: 300 euros", num("300 euros"), 300);

// -----------------------------------------------------------------------------
// Desatinné oddeľovače
//
// Toto je miesto, kde sa dá najľahšie pomýliť o rád — preto sú pravidlá
// otestované z oboch strán, nielen v tvare, ktorý sa nám hodí.
// -----------------------------------------------------------------------------
check("desatinná čiarka", num("300,50"), 300.5);
check("desatinná bodka", num("300.50 eur"), 300.5);
check("tisícky bodkou + čiarka desatinná", num("1.234,50 eur"), 1234.5);
check("tisícky čiarkou + bodka desatinná", num("1,234.50 eur"), 1234.5);
check("jeden oddeľovač, tri číslice = tisícky", num("1.234 eur"), 1234);
check("jeden oddeľovač, dve číslice = desatiny", num("1,23 eur"), 1.23);

// -----------------------------------------------------------------------------
// Keď číslo nie je — musí vyjsť null, nie nula.
//
// Nula by znamenala faktúru na 0 €, ktorá by ticho prešla. null znamená
// otázku.
// -----------------------------------------------------------------------------
check("bez čísla", num("za kopanie"), null);
check("prázdny text", num(""), null);

// -----------------------------------------------------------------------------
// Sadzba DPH — iba keď je vyslovená
// -----------------------------------------------------------------------------
check("sk: 23 percent DPH", findVatRate("s 23 percent DPH"), 23);
check("sk: slovom", findVatRate("s dvadsaťtri percent DPH"), 23);
check("de: 23 Prozent Mehrwertsteuer", findVatRate("mit 23 Prozent Mehrwertsteuer"), 23);
check("de: 19% MwSt", findVatRate("mit 19% MwSt"), 19);
check("en: 23 percent VAT", findVatRate("plus 23 percent VAT"), 23);
// "s DPH" sadzbu neurčuje — o sadzbe nerozhoduje asistent.
check("samotné 's DPH' nedáva sadzbu", findVatRate("s DPH"), null);
check("suma nie je sadzba", findVatRate("za 300 eur"), null);
check("DPH spomenuté", mentionsVat("s DPH"), true);
check("DPH nespomenuté", mentionsVat("za kopanie 300 eur"), false);

// -----------------------------------------------------------------------------
// Mena
// -----------------------------------------------------------------------------
check("mena eur", findCurrency("300 eur"), "EUR");
check("mena Euro", findCurrency("300 Euro"), "EUR");
check("mena dollars", findCurrency("300 dollars"), "USD");
check("mena nespomenutá", findCurrency("kopanie"), null);

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
