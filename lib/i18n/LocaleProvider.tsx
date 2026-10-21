"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { supabase } from "@/lib/supabase";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  type Locale,
} from "./locales";
import { translate, translateCount } from "./translate";

// Esblu i18n — client-side Context. Drží AKTUÁLNY jazyk a vystavuje
// t()/setLocale() zvyšku appky.
//
// Perzistencia (revidované — pozri lib/i18n/locales.ts pre plné
// zdôvodnenie): appka zámerne NEPOUŽÍVA cookie na uloženie jazyka, aby
// nemenila právny obsah Cookie Policy. Namiesto toho:
//   - VŽDY: localStorage (rovnaký mechanizmus ako existujúci Supabase Auth
//     session token — appka tu nezavádza žiadnu novú technológiu),
//   - NAVYŠE ak je používateľ prihlásený: best-effort zápis do
//     public.settings.locale (20260819090000_add_settings_locale.sql),
//     aby sa jazyk obnovil aj po prihlásení z iného zariadenia/prehliadača.
//     Zlyhanie tohto zápisu (napr. dočasný výpadok siete) NIKDY neblokuje
//     samotnú zmenu jazyka v UI.
// Keďže localStorage nie je na serveri dostupné, prvé SSR vykreslenie je
// vždy v DEFAULT_LOCALE (sk) — čítanie aktuálnej hodnoty je implementované
// cez useSyncExternalStore (React-odporúčaný spôsob synchronizácie s
// externým úložiskom mimo Reactu, namiesto setState() vo vnútri effectu,
// ktoré by spôsobovalo kaskádové rendery). Vedľajší bonus:
// useSyncExternalStore automaticky reaguje aj na zmenu jazyka v inej karte
// (storage event), takže viacero otvorených kariet Esblu zostáva
// zosynchronizovaných.
type LocaleContextValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  // Plurálová varianta t() — baseKey BEZ prípony (_one/_few/_many), napr.
  // tCount("inbox.documentsCountSuffix", 3) vyhľadá "..._few". Pozri
  // lib/i18n/translate.ts (pluralSuffix) pre pravidlá SK vs. DE/EN.
  tCount: (
    baseKey: string,
    count: number,
    vars?: Record<string, string | number>
  ) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

const localeChangeListeners = new Set<() => void>();

function readStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;

  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return stored ? normalizeLocale(stored) : DEFAULT_LOCALE;
  } catch {
    // Súkromné prehliadanie / zakázaný localStorage — appka jednoducho
    // pokračuje s DEFAULT_LOCALE, nikdy nepadne.
    return DEFAULT_LOCALE;
  }
}

function getServerLocaleSnapshot(): Locale {
  return DEFAULT_LOCALE;
}

function subscribeToLocaleChanges(callback: () => void): () => void {
  localeChangeListeners.add(callback);

  const onStorageEvent = (event: StorageEvent) => {
    if (event.key === LOCALE_STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorageEvent);

  return () => {
    localeChangeListeners.delete(callback);
    window.removeEventListener("storage", onStorageEvent);
  };
}

function writeStoredLocale(locale: Locale) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Rovnako best-effort ako čítanie vyššie.
  }

  // Zmena z aktuálnej karty storage event NEVYVOLÁ (ten dostanú iba OSTATNÉ
  // karty) — vlastných poslucháčov preto notifikujeme priamo, aby sa aj
  // táto karta prekreslila cez useSyncExternalStore ihneď po kliku.
  localeChangeListeners.forEach((callback) => callback());
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore(
    subscribeToLocaleChanges,
    readStoredLocale,
    getServerLocaleSnapshot
  );

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    const normalized = normalizeLocale(next);
    writeStoredLocale(normalized);

    // Best-effort — ak nie je prihlásený, getSession() vráti null a appka
    // jednoducho pokračuje s localStorage perzistenciou (bod "neprihlásený
    // používateľ" zo zadania). Nikdy nič nevyhadzuje/neblokuje UI.
    // supabase-js chybu NEVYHADZUJE — vracia ju v `error`. Bez kontroly by
    // odmietnutý zápis (napr. chýbajúci grant, 42501) zlyhal potichu.
    supabase.auth
      .getSession()
      .then(async ({ data: { session } }) => {
        if (!session) return;

        const { error } = await supabase
          .from("settings")
          .update({ locale: normalized })
          .eq("user_id", session.user.id);
        if (error) {
          console.error("Uloženie jazykovej preferencie zlyhalo:", error.code ?? "", error.message);
        }
      })
      .catch((error) => {
        console.error("Uloženie jazykovej preferencie zlyhalo:", error);
      });
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) =>
      translate(locale, key, vars),
    [locale]
  );

  const tCount = useCallback(
    (baseKey: string, count: number, vars?: Record<string, string | number>) =>
      translateCount(locale, baseKey, count, vars),
    [locale]
  );

  const value = useMemo(
    () => ({ locale, setLocale, t, tCount }),
    [locale, setLocale, t, tCount]
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);

  if (!ctx) {
    throw new Error("useLocale() musí byť volané vnútri <LocaleProvider>.");
  }

  return ctx;
}
