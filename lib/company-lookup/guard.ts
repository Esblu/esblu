// =============================================================================
// Esblu — Company lookup: autorizácia volajúceho.
// =============================================================================
// Lookup existuje IBA na založenie/úpravu obchodného partnera (Obchodní
// partneri, nový partner pri faktúre). Preto má presne rovnaké oprávnenie
// ako zápis do business_partners: public.esblu_my_finance_manage()
// (migrácie 20260916140000 + 20260922100000):
//   owner, accountant → áno; admin iba s permissions.finance.manage;
//   employee nikdy; bez aktívneho členstva nikdy.
// Rola ani firma sa NIKDY neberú z požiadavky — iba z DB cez user-scoped
// klienta (JWT volajúceho). RLS na business_partners ostáva posledná
// autorita pri samotnom uložení partnera.
//
// Čistá funkcia so vstrekovanými závislosťami (rovnaký vzor ako
// lib/voice/transcribe-guard.ts), testovaná v scripts/company-lookup-tests.ts.
// =============================================================================

export type CompanyLookupGuardDeps = {
  /** Overený používateľ z Bearer JWT, alebo null. */
  getUser: () => Promise<{ id: string } | null>;
  /** esblu_my_finance_manage() cez user-scoped klienta; chyba = false. */
  canManageFinance: () => Promise<boolean>;
  /** esblu_my_active_company_id() cez user-scoped klienta; null = žiadne aktívne členstvo. */
  getActiveCompanyId: () => Promise<string | null>;
};

export type CompanyLookupGuardResult =
  | { ok: true; userId: string; companyId: string }
  | { ok: false; status: 401 | 403; code: "UNAUTHENTICATED" | "FORBIDDEN" };

export async function guardCompanyLookup(deps: CompanyLookupGuardDeps): Promise<CompanyLookupGuardResult> {
  let user: { id: string } | null = null;
  try {
    user = await deps.getUser();
  } catch {
    user = null;
  }
  if (!user) return { ok: false, status: 401, code: "UNAUTHENTICATED" };

  let allowed = false;
  try {
    allowed = (await deps.canManageFinance()) === true;
  } catch {
    allowed = false;
  }
  if (!allowed) return { ok: false, status: 403, code: "FORBIDDEN" };

  let companyId: string | null = null;
  try {
    companyId = await deps.getActiveCompanyId();
  } catch {
    companyId = null;
  }
  if (!companyId) return { ok: false, status: 403, code: "FORBIDDEN" };

  return { ok: true, userId: user.id, companyId };
}
