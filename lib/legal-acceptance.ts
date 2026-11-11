import { supabase } from "@/lib/supabase";
import { LOCALE_STORAGE_KEY, normalizeLocale, type Locale } from "@/lib/i18n/locales";

/**
 * J10.1 (CLIA 11.11.2026): jazyk, v ktorom bol dokument zobrazený. Eviduje
 * sa ako metadata (display_locale + source_version) — EN/DE sú preklady tej
 * istej SK právnej verzie, nie nová verzia (žiadny re-accept kvôli prekladu).
 */
export function currentDisplayLocale(): Locale {
  try {
    return normalizeLocale(typeof window === "undefined" ? null : window.localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return normalizeLocale(null);
  }
}

export type PendingLegalAcceptance = {
  document_type: "terms" | "privacy_policy" | "dpa" | "cookie_policy";
  version: string;
  effective_at: string;
};

/**
 * Zoznam required (terms/privacy_policy) dokumentov, ktorých AKTUÁLNU
 * publikovanú verziu prihlásený používateľ ešte nepotvrdil. Volá
 * public.esblu_get_my_pending_required_acceptances()
 * (supabase/migrations/20260815100000_add_legal_acceptance.sql) — read-only,
 * bezpečné volať opakovane. Vracia prázdne pole aj pre neprihláseného
 * používateľa alebo ak migrácia ešte nie je na danom prostredí aplikovaná
 * (appka sa v tom prípade správa, akoby nič nebolo treba potvrdiť — NEBLOKUJE
 * naslepo, pozri report).
 */
export async function getMyPendingLegalAcceptances(): Promise<
  PendingLegalAcceptance[]
> {
  const { data, error } = await supabase.rpc(
    "esblu_get_my_pending_required_acceptances"
  );

  if (error) {
    console.error("getMyPendingLegalAcceptances zlyhalo:", error.message);
    return [];
  }

  return (data as PendingLegalAcceptance[]) || [];
}

/**
 * Zapíše acceptance jedného dokumentu z REGISTRAČNÉHO formulára
 * (app/login/page.tsx, mode="register"). auth.uid() a accepted_at sa
 * vynucujú na strane DB, acceptance_method je natvrdo "registration"
 * (esblu_accept_legal_document_registration) — klient ho nemôže ovplyvniť.
 * Append-only: opakované volanie tej istej verzie je bezpečné no-op (RPC
 * interne používa ON CONFLICT DO NOTHING).
 */
export async function acceptLegalDocumentAtRegistration(
  documentType: PendingLegalAcceptance["document_type"],
  version: string
): Promise<boolean> {
  const { error } = await supabase.rpc(
    "esblu_accept_legal_document_registration",
    {
      p_document_type: documentType,
      p_version: version,
      p_locale: currentDisplayLocale(),
    }
  );

  if (error) {
    console.error(
      "acceptLegalDocumentAtRegistration zlyhalo:",
      error.message
    );
    return false;
  }

  return true;
}

/**
 * Zapíše acceptance jedného dokumentu z BLOKUJÚCEHO MODALU
 * (app/components/LegalAcceptanceGate.tsx) pre existujúcich používateľov.
 * acceptance_method je natvrdo "legal_gate"
 * (esblu_accept_legal_document_at_gate) — klient ho nemôže ovplyvniť.
 * Append-only rovnako ako acceptLegalDocumentAtRegistration.
 */
export async function acceptLegalDocumentAtGate(
  documentType: PendingLegalAcceptance["document_type"],
  version: string
): Promise<boolean> {
  const { error } = await supabase.rpc("esblu_accept_legal_document_at_gate", {
    p_document_type: documentType,
    p_version: version,
    p_locale: currentDisplayLocale(),
  });

  if (error) {
    console.error("acceptLegalDocumentAtGate zlyhalo:", error.message);
    return false;
  }

  return true;
}

export type MyLegalAcceptanceRow = {
  document_type: string;
  version: string;
  accepted_at: string;
  acceptance_method: string;
};

/**
 * Vlastná história acceptance záznamov prihláseného používateľa (Nastavenia
 * → Súkromie a dáta). Číta priamo z user_legal_acceptances cez RLS
 * (user_legal_acceptances_select_own — vidí iba svoje vlastné riadky).
 */
export async function listMyLegalAcceptances(): Promise<
  MyLegalAcceptanceRow[]
> {
  const { data, error } = await supabase
    .from("user_legal_acceptances")
    .select("document_type, version, accepted_at, acceptance_method")
    .order("accepted_at", { ascending: false });

  if (error) {
    console.error("listMyLegalAcceptances zlyhalo:", error.message);
    return [];
  }

  return (data as MyLegalAcceptanceRow[]) || [];
}
