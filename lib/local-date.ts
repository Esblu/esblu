// =============================================================================
// Kalendárny dátum — bez časového pásma serveru.
//
// PREČO TENTO SÚBOR VZNIKOL
// -------------------------
// Reálny test: o 00:30 stredoeurópskeho času 22. 9. vznikol hlasom koncept
// faktúry s dátumom vystavenia 21. 9. Server beží v UTC, kde bolo ešte
// 22:30 predchádzajúceho dňa, a `new Date().toISOString().slice(0, 10)`
// vráti UTC deň, nie deň používateľa.
//
// Nie je to drobnosť v zobrazení. `issue_date` je daňovo relevantný údaj;
// posunutý o deň môže spadnúť do iného zdaňovacieho obdobia. A netýkalo sa
// to len hlasu — presne ten istý výraz mal aj formulár novej faktúry,
// detail konceptu, dátum úhrady a prijatie dokladu. Oprava iba hlasovej
// vetvy by nechala chybu na štyroch ďalších miestach.
//
// ČO JE ZDROJOM PRAVDY
// --------------------
// Kalendárny deň používateľa. Esblu dnes nemá nastavenie časového pásma
// firmy ani používateľa (overené: `settings.locale` je jazyk rozhrania a
// `country_code` na fakturačnom profile je poštová adresa — firma
// registrovaná v jednej krajine môže pôsobiť v inej, takže ani jedno
// časové pásmo neurčuje). Zavádzať nové nastavenie kvôli predvyplneniu
// jedného poľa by znamenalo konfiguráciu, ktorú musí niekto vyplniť a
// udržiavať — a kým ju nevyplní, chyba trvá.
//
// Preto sa berie odtiaľ, kde je odpoveď bez konfigurácie k dispozícii: z
// prehliadača používateľa. V prehliadači je „dnes" jednoducho dnes. Na
// serveri, kde sa doklad zakladá pri hlasovom príkaze, klient svoj
// kalendárny deň pošle a server ho overí — pozri `resolveClientCalendarDate`.
//
// ZÁMERNE SA NEHARDCODUJE SLOVENSKO
// ---------------------------------
// Pevné „Europe/Bratislava" by opravilo tento prípad a rozbilo ho pre
// zákazníka v Berlíne rovnako ticho, ako je rozbitý teraz.
//
// SÉMANTIKA ZOSTÁVA KALENDÁRNA
// ----------------------------
// Všetko tu sú reťazce „RRRR-MM-DD" pre stĺpce typu `date`. Nikde sa
// namiesto dátumu neukladá časová pečiatka.
// =============================================================================

/**
 * Dnešný kalendárny dátum v časovom pásme prostredia, kde kód beží.
 *
 * V prehliadači je to pásmo používateľa — teda to, čo chceme. Na serveri
 * je to UTC, preto sa serverové cesty nesmú spoliehať iba na toto (pozri
 * `resolveClientCalendarDate`).
 *
 * Používa sa lokálny `Date`, nie `toISOString()`. Práve zámena týchto dvoch
 * bola pôvodná chyba.
 */
export function todayLocalDate(now: Date = new Date()): string {
  return formatCalendarDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/**
 * Kalendárny dátum v konkrétnom IANA pásme.
 *
 * Slúži hlavne testom hraníc polnoci — beh testov nemá vlastné pásmo, a
 * aj keby mal, nesmú od neho závisieť. `en-CA` dáva `RRRR-MM-DD`;
 * `Intl` rieši aj letný čas, takže tu nie je žiadna vlastná aritmetika
 * posunov.
 */
export function calendarDateInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Dnešok v UTC. Fallback pre server, keď klient nič nepošle. */
export function todayUtcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Validácia
// -----------------------------------------------------------------------------

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Je to naozaj kalendárny dátum?
 *
 * Kontroluje sa tvar AJ existencia dňa — samotný regulárny výraz pustí
 * „2026-02-31" aj „2026-13-01". Overenie spätnou konverziou cez UTC je
 * bezpečné: porovnávajú sa iba čísla roka, mesiaca a dňa, žiadny posun.
 */
export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !CALENDAR_DATE_PATTERN.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

// -----------------------------------------------------------------------------
// Serverové prijatie dátumu od klienta
// -----------------------------------------------------------------------------

/**
 * Overí kalendárny deň, ktorý poslal klient. Vráti `null`, keď sa naň
 * nedá spoľahnúť.
 *
 * ZÁMERNE NEMÁ NÁHRADNÚ HODNOTU
 * -----------------------------
 * Skoršia verzia pri chýbajúcom alebo neplatnom vstupe vracala UTC
 * dnešok. Znelo to zhovievavo, ale znamenalo to presne tú chybu, kvôli
 * ktorej celý tento súbor vznikol: o 00:30 stredoeurópskeho času by
 * doklad ticho dostal včerajší dátum. Tichý nesprávny dátum na daňovom
 * doklade je horší než odmietnutý príkaz — odmietnutie používateľ vidí
 * a zopakuje, nesprávny dátum sa nájde až pri kontrole.
 *
 * Volajúci sa preto musí rozhodnúť sám. Kde dátum rozhoduje (zakladanie
 * dokladu), sa má príkaz zastaviť; kde nerozhoduje (čítanie, navigácia),
 * sa `null` jednoducho ignoruje.
 *
 * OHRANIČENIE
 * -----------
 * Rozsah je daný fyzikou, nie odhadom: reálne časové pásma sú UTC−12 až
 * UTC+14, takže lokálny kalendárny deň môže byť oproti UTC dňu nanajvýš
 * o jeden deň vzad alebo vpred. Čokoľvek mimo tohto okna nie je časové
 * pásmo, ale pokus o iný dátum — napríklad spätné datovanie do už
 * uzavretého obdobia.
 *
 * ČO TÁTO FUNKCIA NIE JE
 * ----------------------
 * Nie je autorizácia. Neurčuje firmu ani používateľa a nemá vplyv na to,
 * kto smie doklad vytvoriť — to drží rola a RLS úplne nezávisle. Rozhoduje
 * výhradne o hodnote jedného poľa, ktoré používateľ v koncepte aj tak vidí
 * a môže zmeniť.
 */
export function resolveClientCalendarDate(
  clientDate: unknown,
  now: Date = new Date()
): string | null {
  if (!isValidCalendarDate(clientDate)) return null;

  const utcMs = Date.parse(`${todayUtcDate(now)}T00:00:00Z`);
  const clientMs = Date.parse(`${clientDate}T00:00:00Z`);
  if (!Number.isFinite(clientMs) || !Number.isFinite(utcMs)) return null;

  const dayOffset = Math.round((clientMs - utcMs) / 86_400_000);
  return dayOffset >= -1 && dayOffset <= 1 ? clientDate : null;
}

// -----------------------------------------------------------------------------

function formatCalendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
