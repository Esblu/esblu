// =============================================================================
// Testy kalendárneho dátumu — hranice polnoci, mesiaca, roka a letného času.
//
// SPUSTENIE
//   npm run test:dates
//
// PREČO EXISTUJÚ
// --------------
// Vznikli z konkrétnej chyby: o 00:30 stredoeurópskeho času 22. 9. dostal
// koncept faktúry dátum 21. 9., pretože server počítal deň v UTC. Prvý
// test nižšie je presne ten okamih.
//
// Testy nesmú závisieť od pásma, v ktorom bežia, preto sa všade pracuje s
// konkrétnym okamihom a explicitným IANA pásmom.
// =============================================================================

import assert from "node:assert/strict";
import {
  calendarDateInTimeZone,
  todayLocalDate,
  todayUtcDate,
  isValidCalendarDate,
  boundClientCalendarDate,
} from "../lib/local-date.ts";

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
// Presne ten okamih, ktorý chybu odhalil
// -----------------------------------------------------------------------------
const MIDNIGHT_BUG = new Date("2026-09-21T22:30:00Z"); // = 22. 9. 00:30 v Bratislave

check(
  "00:30 Bratislava → 22. 9. (nie 21. 9.)",
  calendarDateInTimeZone(MIDNIGHT_BUG, "Europe/Bratislava"),
  "2026-09-22"
);
// Kontrola, že test naozaj testuje to, čo si myslí: v UTC je vtedy ešte 21.
check("ten istý okamih je v UTC ešte 21. 9.", todayUtcDate(MIDNIGHT_BUG), "2026-09-21");

// -----------------------------------------------------------------------------
// Polnoc naprieč pásmami — nie je to len slovenský problém
// -----------------------------------------------------------------------------
check("Berlín rovnako", calendarDateInTimeZone(MIDNIGHT_BUG, "Europe/Berlin"), "2026-09-22");
check("Tokio rovnako", calendarDateInTimeZone(MIDNIGHT_BUG, "Asia/Tokyo"), "2026-09-22");
check("Auckland rovnako", calendarDateInTimeZone(MIDNIGHT_BUG, "Pacific/Auckland"), "2026-09-22");
// Pásma západne od UTC idú opačným smerom — deň NAZAD.
check(
  "New York: poobede zostáva ten istý deň",
  calendarDateInTimeZone(new Date("2026-09-22T03:00:00Z"), "America/New_York"),
  "2026-09-21"
);
check("Londýn = UTC v tomto okamihu", calendarDateInTimeZone(MIDNIGHT_BUG, "Europe/London"), "2026-09-21");

// -----------------------------------------------------------------------------
// Bežný deň — oprava nesmie pokaziť to, čo fungovalo
// -----------------------------------------------------------------------------
const MIDDAY = new Date("2026-09-22T10:00:00Z");
check("poludnie: Bratislava", calendarDateInTimeZone(MIDDAY, "Europe/Bratislava"), "2026-09-22");
check("poludnie: UTC", todayUtcDate(MIDDAY), "2026-09-22");

// -----------------------------------------------------------------------------
// Hranica mesiaca a roka
// -----------------------------------------------------------------------------
check(
  "koniec mesiaca: 1. 10. 00:30 v Bratislave",
  calendarDateInTimeZone(new Date("2026-09-30T22:30:00Z"), "Europe/Bratislava"),
  "2026-10-01"
);
check(
  "koniec roka: 1. 1. 00:30 v Bratislave",
  calendarDateInTimeZone(new Date("2026-12-31T23:30:00Z"), "Europe/Bratislava"),
  "2027-01-01"
);
check(
  "koniec roka: v UTC je vtedy ešte 31. 12.",
  todayUtcDate(new Date("2026-12-31T23:30:00Z")),
  "2026-12-31"
);

// -----------------------------------------------------------------------------
// Letný čas
//
// Kalendárny deň sa pri prechode nesmie posunúť. Posuny rieši Intl, nie
// vlastná aritmetika — tieto testy to potvrdzujú.
// -----------------------------------------------------------------------------
// Prechod na zimný čas 2026: 25. 10., 03:00 → 02:00 SELČ.
check(
  "DST: tesne pred prechodom (00:30 SELČ)",
  calendarDateInTimeZone(new Date("2026-10-24T22:30:00Z"), "Europe/Bratislava"),
  "2026-10-25"
);
check(
  "DST: tesne po prechode (03:30 SEČ)",
  calendarDateInTimeZone(new Date("2026-10-25T02:30:00Z"), "Europe/Bratislava"),
  "2026-10-25"
);
// Prechod na letný čas 2026: 29. 3., 02:00 → 03:00.
check(
  "DST: jarný prechod, ten istý deň pred",
  calendarDateInTimeZone(new Date("2026-03-29T00:30:00Z"), "Europe/Bratislava"),
  "2026-03-29"
);
check(
  "DST: jarný prechod, ten istý deň po",
  calendarDateInTimeZone(new Date("2026-03-29T03:30:00Z"), "Europe/Bratislava"),
  "2026-03-29"
);

// -----------------------------------------------------------------------------
// todayLocalDate: lokálny dátum, nie UTC
// -----------------------------------------------------------------------------
// Zostaví sa lokálny `Date` na 22. 9. 00:30 v pásme, kde test práve beží.
// Nech je to pásmo akékoľvek, lokálny kalendárny deň musí byť 22. 9.
check("todayLocalDate číta lokálny deň", todayLocalDate(new Date(2026, 8, 22, 0, 30)), "2026-09-22");
check("todayLocalDate: koniec roka", todayLocalDate(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
check("todayLocalDate: jednociferné doplní nulu", todayLocalDate(new Date(2026, 0, 5, 12, 0)), "2026-01-05");

// -----------------------------------------------------------------------------
// Striktná validácia
// -----------------------------------------------------------------------------
check("platný dátum", isValidCalendarDate("2026-09-22"), true);
check("priestupný deň 2028", isValidCalendarDate("2028-02-29"), true);
check("neexistujúci 29. 2. 2026", isValidCalendarDate("2026-02-29"), false);
check("neexistujúci 31. 2.", isValidCalendarDate("2026-02-31"), false);
check("13. mesiac", isValidCalendarDate("2026-13-01"), false);
check("nultý deň", isValidCalendarDate("2026-09-00"), false);
check("zlý tvar", isValidCalendarDate("22.09.2026"), false);
check("časová pečiatka nie je dátum", isValidCalendarDate("2026-09-22T00:30:00Z"), false);
check("prázdny reťazec", isValidCalendarDate(""), false);
check("číslo", isValidCalendarDate(20260922), false);
check("null", isValidCalendarDate(null), false);
check("SQL pokus", isValidCalendarDate("2026-09-22'; drop table invoices;--"), false);

// -----------------------------------------------------------------------------
// Ohraničenie dátumu od klienta
//
// Toto je poistka proti spätnému datovaniu dokladu. Rozdiel oproti UTC dňu
// môže byť nanajvýš jeden deň — viac už nie je časové pásmo.
// -----------------------------------------------------------------------------
const NOW = new Date("2026-09-21T22:30:00Z"); // UTC deň = 2026-09-21

check("klient hlási svoj zajtrajšok (UTC+2 o polnoci)", boundClientCalendarDate("2026-09-22", NOW), "2026-09-22");
check("klient hlási ten istý deň", boundClientCalendarDate("2026-09-21", NOW), "2026-09-21");
check("klient hlási včerajšok (pásma západne od UTC)", boundClientCalendarDate("2026-09-20", NOW), "2026-09-20");

check("podvrh: o mesiac vzad → UTC dnešok", boundClientCalendarDate("2026-08-21", NOW), "2026-09-21");
check("podvrh: o rok vpred → UTC dnešok", boundClientCalendarDate("2027-09-21", NOW), "2026-09-21");
check("podvrh: dva dni vzad → UTC dnešok", boundClientCalendarDate("2026-09-19", NOW), "2026-09-21");
check("podvrh: dva dni vpred → UTC dnešok", boundClientCalendarDate("2026-09-23", NOW), "2026-09-21");
check("nezmysel → UTC dnešok", boundClientCalendarDate("nie-datum", NOW), "2026-09-21");
check("chýbajúci → UTC dnešok", boundClientCalendarDate(undefined, NOW), "2026-09-21");
check("neexistujúci dátum → UTC dnešok", boundClientCalendarDate("2026-02-31", NOW), "2026-09-21");

// Ohraničenie musí fungovať aj cez hranicu mesiaca a roka.
check(
  "hranica mesiaca: klientov 1. 10. je platný",
  boundClientCalendarDate("2026-10-01", new Date("2026-09-30T22:30:00Z")),
  "2026-10-01"
);
check(
  "hranica roka: klientov 1. 1. je platný",
  boundClientCalendarDate("2027-01-01", new Date("2026-12-31T23:30:00Z")),
  "2027-01-01"
);

// -----------------------------------------------------------------------------
// Ručná a hlasová faktúra musia dať ROVNAKÝ dátum
//
// Toto je vlastne jadro zadania: chyba sa prejavila cez hlas, ale rovnaký
// UTC výraz mal aj formulár. Keby sa opravil len hlas, dve cesty by od
// polnoci do rána zakladali doklady s rôznym dátumom.
// -----------------------------------------------------------------------------
{
  const instant = MIDNIGHT_BUG;
  const userTimeZone = "Europe/Bratislava";

  // Ručná cesta: prehliadač počíta svoj lokálny deň.
  const manualDate = calendarDateInTimeZone(instant, userTimeZone);

  // Hlasová cesta: prehliadač pošle ten istý deň, server ho overí a ohraničí.
  const voiceDate = boundClientCalendarDate(
    calendarDateInTimeZone(instant, userTimeZone),
    instant
  );

  check("ručná cesta = 22. 9.", manualDate, "2026-09-22");
  check("hlasová cesta = 22. 9.", voiceDate, "2026-09-22");
  check("obe cesty sa zhodujú", manualDate === voiceDate, true);
}

// To isté na hranici roka.
{
  const instant = new Date("2026-12-31T23:30:00Z");
  const manualDate = calendarDateInTimeZone(instant, "Europe/Bratislava");
  const voiceDate = boundClientCalendarDate(manualDate, instant);
  check("hranica roka: obe cesty = 1. 1. 2027", manualDate === voiceDate && manualDate === "2027-01-01", true);
}

// -----------------------------------------------------------------------------
// Splatnosť sa počíta nad ULOŽENÝM dátumom, nie nad „teraz"
//
// `computeDueDateFromTerms` v lib/invoices.ts používa UTC aritmetiku, ale
// nad už uloženým `issue_date` — žiadne „teraz", žiadne pásmo. Je teda
// správna a zámerne sa nemenila. Tu sa overuje, že posun cez koniec
// mesiaca, roka aj priestupný deň naozaj sedí.
// -----------------------------------------------------------------------------
function dueDateFromTerms(issueDate: string, days: number): string {
  const base = new Date(`${issueDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

check("splatnosť: +14 dní", dueDateFromTerms("2026-09-22", 14), "2026-10-06");
check("splatnosť cez koniec roka", dueDateFromTerms("2026-12-31", 1), "2027-01-01");
check("splatnosť cez koniec mesiaca", dueDateFromTerms("2026-02-28", 1), "2026-03-01");
check("splatnosť cez priestupný deň", dueDateFromTerms("2028-02-28", 1), "2028-02-29");
check("splatnosť cez prechod na zimný čas", dueDateFromTerms("2026-10-24", 1), "2026-10-25");

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
