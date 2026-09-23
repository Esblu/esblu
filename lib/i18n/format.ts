// Esblu i18n — locale-sensitive formátovanie dátumov/času/čísel.
//
// Dôležité rozlíšenie (viď bod 1 zadania "Celé i18n"): toto NIKDY nesmie
// prekladať obsah nahraný používateľom (napr. text extrahovaný AI z
// dokumentu) — iba systémové UI hodnoty ako "kedy bol záznam vytvorený",
// ktoré appka sama formátuje z ISO timestampu.
import type { Locale } from "./locales";

// Mapovanie na BCP-47 locale pre Intl.* API. sk/de majú prirodzený
// DD.MM.YYYY / DD.MM.YYYY formát; pre EN zámerne používame en-GB
// (DD/MM/YYYY), nie en-US (MM/DD/YYYY) — konzistentnejšie s SK/DE a menej
// mätúce pre používateľov firemnej appky prevádzkovanej v EÚ.
const INTL_LOCALE_MAP: Record<Locale, string> = {
  sk: "sk-SK",
  de: "de-DE",
  en: "en-GB",
};

export function toIntlLocale(locale: Locale): string {
  return INTL_LOCALE_MAP[locale];
}

export function formatDate(
  value: string | number | Date,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(toIntlLocale(locale), options);
}

export function formatDateTime(
  value: string | number | Date,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(toIntlLocale(locale), options);
}

export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions
): string {
  return value.toLocaleString(toIntlLocale(locale), options);
}

// =============================================================================
// PENIAZE
//
// PREČO TO NIE JE JEDEN RIADOK
// ----------------------------
// `Intl.NumberFormat` pri neplatnom kóde meny NEVRÁTI nič náhradné —
// vyhodí `RangeError`. V Reacte to znamená, že padne celý strom komponentov
// a používateľ uvidí prázdnu chybovú stránku namiesto zoznamu faktúr.
//
// Presne to sa stalo v produkcii: v jednom koncepte bolo v mene „EUR "
// s medzerou na konci. Register faktúr, detail dokladu aj PDF používali tri
// samostatné kópie toho istého nechráneného volania, takže spadli všetky tri.
//
//     new Intl.NumberFormat("sk-SK", { currency: "EUR " })
//     → RangeError: Invalid currency code : EUR
//
// Mena je ÚDAJ, nie kód. Prichádza z databázy, z formulára, zo skenu
// dokladu. Zlý údaj má byť vidieť ako zlý údaj — nemá zhasnúť modul.
//
// ČO TÁTO FUNKCIA ROBÍ
// --------------------
// 1. Kód meny orezáva a prevádza na veľké písmená. „eur" aj „EUR " je EUR.
// 2. Keď ani po tom nejde o tri písmená, formátuje sa iba číslo a kód sa
//    pripíše ako text. Používateľ vidí sumu aj to, že mena je divná.
// 3. Keby Intl zlyhal aj na niečom, čo sme nepredvídali, chytí sa to.
//
// Suma sa NIKDY nemení ani nezaokrúhľuje inak — mení sa len to, ako sa
// zobrazí. Peňažná matematika žije v lib/invoicing/vat-engine.ts.
// =============================================================================

/** Kód meny v tvare, v akom ho `Intl` akceptuje. `null` = nepoužiteľný. */
export function normalizeCurrencyCode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export function formatMoney(
  amount: number,
  currency: string | null | undefined,
  locale: Locale
): string {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const code = normalizeCurrencyCode(currency);

  if (code) {
    try {
      return safeAmount.toLocaleString(toIntlLocale(locale), {
        style: "currency",
        currency: code,
      });
    } catch {
      // Trojpísmenový kód, ktorý Intl aj tak nepozná (napr. zrušená mena).
      // Nižšie sa zobrazí ako číslo s kódom vedľa.
    }
  }

  const number = safeAmount.toLocaleString(toIntlLocale(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  // Pôvodný zápis meny sa ukáže tak, ako je uložený — vrátane toho, čím je
  // pokazený. Skryť ho by znamenalo, že chybu nikto neuvidí a neopraví.
  const label = typeof currency === "string" ? currency.trim() : "";
  return label ? `${number} ${label}` : number;
}
