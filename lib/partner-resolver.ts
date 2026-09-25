import type { SupabaseClient } from "@supabase/supabase-js";
import { matchPartnersByName, type PartnerMatchTier } from "./partner-matching.ts";

// =============================================================================
// JEDEN resolver obchodného partnera pre celý asistent.
//
// Používajú ho: výber odberateľa pri faktúre (priamy príkaz aj odpoveď na
// otázku „Pre ktorého odberateľa?"), zmena odberateľa, hľadanie/otvorenie
// partnera a kontrola duplicít pri zakladaní partnera. Nikde inde sa
// partner podľa mena nehľadá.
//
// ROZSAH: iba partneri AKTÍVNEJ firmy — RLS volajúceho a navyše explicitný
// filter company_id. Volá sa až PO bráne oprávnení (finance view/manage);
// oprávnenie tento modul zámerne nekontroluje, aby nevznikla druhá definícia.
//
// POLITIKA
//   IČO presne               → výber (jediný), inak otázka
//   názov exact/strong       → výber (jediný), inak otázka
//   suggestion               → VŽDY otázka („Myslíte …?" / výber zo zoznamu)
//   nič                      → „nenašiel som" — nikdy sa nezakladá nový
// =============================================================================

export type PartnerRow = { id: string; legal_name: string | null; ico: string | null };

export type PartnerResolution = {
  tier: PartnerMatchTier;
  /** Smie sa použiť bez pýtania? Nikdy pri `suggestion`. */
  autoResolvable: boolean;
  matches: PartnerRow[];
};

const NONE: PartnerResolution = { tier: "none", autoResolvable: false, matches: [] };

/** Partneri aktívnej firmy. `null` = chyba čítania (volajúci fail closed). */
export async function loadCompanyPartners(db: SupabaseClient, companyId: string | null): Promise<PartnerRow[] | null> {
  let query = db.from("business_partners").select("id, legal_name, ico");
  if (companyId) query = query.eq("company_id", companyId);
  const { data, error } = await query.order("legal_name", { ascending: true }).limit(1000);
  if (error) return null;
  return (data as PartnerRow[] | null) ?? [];
}

function icoKey(value: string | null | undefined): string {
  return (value ?? "").replace(/[\s.\-/]/g, "");
}

/** Čistá funkcia nad už načítanými partnermi (testovateľná bez DB). */
export function resolvePartnerAmong(query: string, rows: readonly PartnerRow[]): PartnerResolution {
  const trimmed = query.trim().replace(/[.!?]+$/, "").trim();
  if (!trimmed) return NONE;

  // IČO je identifikátor, nie názov — presná zhoda rozhoduje pred menom.
  const identifier = icoKey(trimmed);
  if (/^\d{6,}$/.test(identifier)) {
    const icoHits = rows.filter((row) => icoKey(row.ico) === identifier);
    if (icoHits.length > 0) return { tier: "exact", autoResolvable: icoHits.length === 1, matches: icoHits };
  }

  const match = matchPartnersByName(trimmed, rows, (row) => row.legal_name);
  return { tier: match.tier, autoResolvable: match.autoResolvable, matches: match.matches };
}

export async function resolvePartner(db: SupabaseClient, companyId: string | null, query: string): Promise<PartnerResolution | null> {
  const rows = await loadCompanyPartners(db, companyId);
  if (rows === null) return null;
  return resolvePartnerAmong(query, rows);
}
