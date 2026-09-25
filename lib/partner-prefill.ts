// =============================================================================
// Odovzdanie vyslovených údajov nového obchodného partnera z asistenta do
// formulára partnera (app/obchodni-partneri).
//
// sessionStorage, NIE URL: názov firmy a IČO nepatria do adresy (história,
// logy servera). Hodnota je jednorazová — formulár ju po prečítaní zmaže.
// Nie je to autorizačný vstup: formulár ju iba predvyplní a ukladá sa
// existujúcou cestou (validácia + RLS). Prehliadač bez úložiska = prázdny
// formulár, nič sa nerozbije.
// =============================================================================

export type PartnerPrefill = {
  legal_name: string;
  ico?: string;
  dic?: string;
  ic_dph?: string;
  kind?: "customer" | "supplier";
};

const KEY = "esblu.partnerPrefill.v1";

export function storePartnerPrefill(prefill: PartnerPrefill): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ ...prefill, at: Date.now() }));
  } catch {
    // Bez úložiska sa formulár otvorí prázdny.
  }
}

/** Prečíta a ZMAŽE predvyplnenie. Staršie než 10 minút sa ignoruje. */
export function takePartnerPrefill(): PartnerPrefill | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.at !== "number" || Date.now() - value.at > 10 * 60 * 1000) return null;
    const text = (field: string, max: number) =>
      typeof value[field] === "string" && (value[field] as string).trim() ? (value[field] as string).trim().slice(0, max) : undefined;
    const legalName = text("legal_name", 200);
    if (!legalName) return null;
    return {
      legal_name: legalName,
      ico: text("ico", 20),
      dic: text("dic", 20),
      ic_dph: text("ic_dph", 20),
      kind: value.kind === "customer" || value.kind === "supplier" ? value.kind : undefined,
    };
  } catch {
    return null;
  }
}
