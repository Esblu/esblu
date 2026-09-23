import { DEFAULT_LOCALE, type Locale } from "./locales.ts";
import { dictionaries } from "./dictionaries/index.ts";
import type { DictionaryValue } from "./dictionary-types";

// Jadro i18n — čistá funkcia bez závislosti na Reacte, takže ju možno volať
// rovnako zo Server aj Client Componentov (Server Component si locale
// zistí zo server-side cookie, Client Component z LocaleProvider Contextu
// — pozri lib/i18n/server-locale.ts a lib/i18n/LocaleProvider.tsx).
//
// key je bodkovaná cesta v rámci slovníka, napr. "auth.login.title" alebo
// "common.buttons.save". Chýbajúci preklad v DE/EN sa nikdy nezobrazí ako
// prázdny text ani surový kľúč bežnému používateľovi — automaticky spadne
// na SK (zdrojový jazyk). Ak kľúč chýba aj v SK, vráti samotný kľúč (viditeľné
// v deve, aby sa chýbajúci preklad dal ľahko nájsť).
function lookup(locale: Locale, key: string): string | undefined {
  const segments = key.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: DictionaryValue | undefined = dictionaries[locale] as any;

  for (const segment of segments) {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    node = (node as Record<string, DictionaryValue>)[segment];
  }

  return typeof node === "string" ? node : undefined;
}

export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>
): string {
  const resolved =
    lookup(locale, key) ??
    (locale !== DEFAULT_LOCALE ? lookup(DEFAULT_LOCALE, key) : undefined) ??
    key;

  if (!vars) return resolved;

  return Object.entries(vars).reduce(
    (text, [varName, value]) => text.split(`{{${varName}}}`).join(String(value)),
    resolved
  );
}

/**
 * Existuje pre tento kľúč naozaj preklad?
 *
 * `translate()` pri chýbajúcom kľúči vráti samotný kľúč. V deve je to
 * užitočné — chýbajúci preklad je hneď vidieť. V produkcii je to horšie než
 * nič: používateľ dostane do tváre „handoff.errors.package.foo" a nevie,
 * čo sa stalo ani čo s tým.
 *
 * Pozerá sa aj na zdrojový jazyk, lebo presne tak sa správa `translate()`.
 */
export function hasTranslation(locale: Locale, key: string): boolean {
  return (
    lookup(locale, key) !== undefined ||
    (locale !== DEFAULT_LOCALE && lookup(DEFAULT_LOCALE, key) !== undefined)
  );
}

/**
 * Preklad s poistkou: keď kľúč neexistuje, použije sa náhradný.
 *
 * Nie je to spôsob, ako zakryť chýbajúce preklady — konkrétna hláška má
 * prednosť vždy, keď existuje. Je to posledná zábrana pred tým, aby sa
 * používateľovi zobrazil názov premennej namiesto vety.
 *
 * Keby chýbal aj náhradný kľúč (čo by znamenalo, že je rozbitý celý slovník),
 * vráti sa prázdny reťazec. Prázdne miesto je menej mätúce než „handoff.
 * errors.genericPackageFailure" uprostred obrazovky.
 */
export function translateWithFallback(
  locale: Locale,
  key: string,
  fallbackKey: string,
  vars?: Record<string, string | number>
): string {
  if (hasTranslation(locale, key)) return translate(locale, key, vars);
  if (hasTranslation(locale, fallbackKey)) return translate(locale, fallbackKey, vars);
  return "";
}

// Jednoduchý plurál bez závislosti na knižnici Intl.PluralRules — slovenčina
// má 3 tvary (1 / 2-4 / 5+ a 0), nemčina a angličtina majú reálne len 2
// (1 / ostatné), preto dictionary kľúče vždy definujú _one/_few/_many a
// pre DE/EN sú _few a _many jednoducho identické. baseKey je kľúč BEZ
// prípony, napr. "inbox.documentsCountSuffix" → vyhľadá
// "inbox.documentsCountSuffix_one" / "_few" / "_many".
export function pluralSuffix(locale: Locale, count: number): "_one" | "_few" | "_many" {
  const n = Math.abs(count);
  if (locale === "sk") {
    if (n === 1) return "_one";
    if (n >= 2 && n <= 4) return "_few";
    return "_many";
  }
  // DE/EN: len jednotné/množné číslo, _few aj _many nesú rovnaký text.
  return n === 1 ? "_one" : "_many";
}

export function translateCount(
  locale: Locale,
  baseKey: string,
  count: number,
  vars?: Record<string, string | number>
): string {
  return translate(locale, `${baseKey}${pluralSuffix(locale, count)}`, { count, ...vars });
}
