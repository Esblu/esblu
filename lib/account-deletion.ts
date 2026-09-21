import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import type { Locale } from "@/lib/i18n/locales";

// -----------------------------------------------------------------------------
// Klientske helpery pre samoobslužné "Zrušiť účet" v app/nastavenia.
// Volajú výhradne server-side API routes (app/api/account/preflight,
// app/api/account/delete) — service_role kľúč sa nikdy nedostane do
// klientskeho kódu. Autorizácia sa v skutočnosti overuje na serveri
// (Bearer token + znovu-načítaná rola/company_id); confirmPhrase je iba
// UX poistka proti omylom, nie bezpečnostný mechanizmus.
// -----------------------------------------------------------------------------

const CONFIRM_PHRASE = "ZRUŠIŤ FIRMU";

// Marker prefix pre chyby, kde server vrátil `partial: true` — DB/membership
// časť je NEVRATNE zmazaná, ale auth.users účet ostal existovať (pozri
// app/api/account/delete/route.ts). Volajúci (app/nastavenia) MUSÍ v tomto
// prípade vynútiť odhlásenie + presmerovanie namiesto ponechania session
// aktívnej — session by inak zostala platná pre už zrušené/nekonzistentné
// členstvo. Rovnaký vzor message-prefix routovania ako inde v appke (napr.
// isBetaAccessRequiredError v lib/company.ts).
export const ACCOUNT_DELETION_PARTIAL_MARKER =
  "ESBLU_ACCOUNT_DELETION_PARTIAL:";

export function isPartialAccountDeletionError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return text.startsWith(ACCOUNT_DELETION_PARTIAL_MARKER);
}

export function stripPartialAccountDeletionMarker(message: string): string {
  return message.startsWith(ACCOUNT_DELETION_PARTIAL_MARKER)
    ? message.slice(ACCOUNT_DELETION_PARTIAL_MARKER.length)
    : message;
}

export type AccountDeletionPreflight = {
  // null = žiadny aktívny company_members riadok. Ak zároveň orphan=true,
  // ide o bezpečne rozpoznaného "orphan" účet (auth.users existuje, žiadne
  // členstvo, NIE je owner_id žiadnej firmy) — appka mu smie ponúknuť
  // rovnaké samoobslužné zrušenie účtu ako admin/employee (pozri
  // app/api/account/preflight/route.ts, app/api/account/delete/route.ts).
  role: "owner" | "admin" | "accountant" | "employee" | null;
  otherActiveMembersCount: number;
  orphan: boolean;
};

async function getAccessToken(locale: Locale): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error(translate(locale, "settings.errors.notLoggedIn"));
  }

  return session.access_token;
}

export async function fetchAccountDeletionPreflight(
  locale: Locale
): Promise<AccountDeletionPreflight> {
  const accessToken = await getAccessToken(locale);

  const response = await fetch(apiUrl("/api/account/preflight"), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      [REQUEST_LOCALE_HEADER]: locale,
    },
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      body.error ||
        translate(locale, "settings.errors.deletionPreflightLoadFailedGeneric")
    );
  }

  return body as AccountDeletionPreflight;
}

export async function deleteMyAccount(
  locale: Locale,
  confirmPhrase?: string
): Promise<void> {
  const accessToken = await getAccessToken(locale);

  const response = await fetch(apiUrl("/api/account/delete"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      [REQUEST_LOCALE_HEADER]: locale,
    },
    body: JSON.stringify(
      confirmPhrase !== undefined ? { confirmPhrase } : {}
    ),
  });

  const body = await response.json();

  if (!response.ok || !body.success) {
    const message =
      body.error || translate(locale, "settings.errors.deletionFailedGeneric");

    // Server signalizuje čiastočne dokončené (nekonzistentné) zrušenie
    // účtu cez `partial: true` — pridaj rozpoznateľný prefix, aby ho
    // volajúci (app/nastavenia) vedel odlíšiť od bežnej (bezpečne
    // opakovateľnej) chyby a zareagovať vynúteným odhlásením.
    throw new Error(
      body.partial === true
        ? `${ACCOUNT_DELETION_PARTIAL_MARKER}${message}`
        : message
    );
  }
}

export { CONFIRM_PHRASE as ACCOUNT_DELETION_CONFIRM_PHRASE };
