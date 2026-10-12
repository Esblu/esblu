// =============================================================================
// Normalizácia registračného čísla právneho subjektu — ZRKADLO DB funkcie
// public.esblu_normalize_registration_id (20261012160000). Zhodu overuje
// PGlite test (trial-normalization). Kľúč subjektu = "<KRAJINA>:<číslo>".
// =============================================================================

const SPACES = /[\s  ]/g;
const SK_CZ_LABEL = /^(IČO|ICO|IČ|IC)[:.]?/i;
const SEPARATORS = /[-./]/g;

export function normalizeRegistrationId(country: unknown, value: unknown): string | null {
  if (typeof country !== "string" || typeof value !== "string") return null;
  const c = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  let raw = value.replace(SPACES, "");
  if (raw === "") return null;
  if (c === "SK" || c === "CZ") {
    raw = raw.replace(SK_CZ_LABEL, "");
    const digits = raw.replace(SEPARATORS, "");
    if (!/^[0-9]{6,8}$/.test(digits)) return null;
    const padded = digits.padStart(8, "0");
    return padded === "00000000" ? null : padded;
  }
  const other = raw.replace(SEPARATORS, "").toUpperCase();
  return /^[A-Z0-9]{2,32}$/.test(other) ? other : null;
}

export function legalEntityKey(country: string, value: string): string | null {
  const normalized = normalizeRegistrationId(country, value);
  return normalized ? `${country.trim().toUpperCase()}:${normalized}` : null;
}
