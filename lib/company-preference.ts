// =============================================================================
// Posledná zvolená firma NA TOMTO ZARIADENÍ (20261012150000).
//
// Aktívna firma je per auth session na serveri (session_active_company).
// Nové prihlásenie = nová session bez kontextu → pri 2+ firmách by appka
// zakaždým ukázala výber. Toto je IBA pohodlie: zariadenie si pamätá poslednú
// voľbu a pri štarte ju POŠLE serveru (esblu_set_my_active_company), ktorý
// overí členstvo. Hodnota NIKDY nie je autorizácia — neplatná / cudzia firma
// = server odmietne → výber firmy. Kľúč je per používateľ (zdieľané
// zariadenie). Storage môže chýbať / hádzať → všetko v try/catch.
// =============================================================================

const KEY_PREFIX = "esblu.preferredCompany.";

export function readCompanyPreference(userId: string | null | undefined): string | null {
  if (!userId) return null;
  try {
    const value = window.localStorage.getItem(KEY_PREFIX + userId);
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberCompanyPreference(userId: string | null | undefined, companyId: string): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(KEY_PREFIX + userId, companyId);
  } catch {
    // bez storage: pri ďalšom prihlásení sa ukáže výber firmy
  }
}

export function forgetCompanyPreference(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(KEY_PREFIX + userId);
  } catch {
    // ignorované
  }
}
