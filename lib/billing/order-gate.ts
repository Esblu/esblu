// =============================================================================
// Objednávka plateného predplatného — serverová brána (SERVER ONLY).
//
// Rozhodnutie vlastníka 2026-11-27 (prvé komerčné spustenie):
//   - predajný je IBA Esblu Komplet mesačne (esblu_complete / month);
//     samostatné moduly (esblu_modular), ďalšia firma (esblu_complete_secondary)
//     a rozšírenia sú „Pripravujeme“ a server ich nákup odmietne;
//   - testovacie plány (test_*) ostávajú pre staging/fake/Stripe TEST.
// VOP 1.3 čl. 10.4: pred odoslaním objednávky sa zobrazí cena, obdobie a automatické
// predĺženie; objednávku odosiela iba Vlastník (rolu overuje DB). Server preto vyžaduje
//   - výslovné potvrdenie objednávky s povinnosťou platby (orderConsent === true),
//   - firmou prijaté AKTUÁLNE VOP (esblu_get_my_company_terms_status) a zhodu verzie,
//     ktorú klient zobrazil (termsVersion), s aktuálnou verziou v DB.
// Verzia VOP sa zapíše do metadát Stripe Checkout relácie aj predplatného.
// =============================================================================

export const CANONICAL_PLAN_CODES = ["esblu_complete", "esblu_complete_secondary", "esblu_modular"] as const;
/** Plány, ktoré sa pri spustení predávajú. Iné kanonické plány = „Pripravujeme“. */
export const LAUNCH_SELLABLE_PLANS: ReadonlyArray<{ planCode: string; interval: "month" | "year" }> = [
  { planCode: "esblu_complete", interval: "month" },
];

export function planPurchasable(planCode: string, interval: "month" | "year"): boolean {
  if (!(CANONICAL_PLAN_CODES as readonly string[]).includes(planCode)) return true; // test fixtures (staging)
  return LAUNCH_SELLABLE_PLANS.some((p) => p.planCode === planCode && p.interval === interval);
}

type TermsStatusRow = { current_terms_version?: string | null; has_current_acceptance?: boolean | null } | null;
type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

export type OrderGateFailure = { code: string; status: number };

/**
 * Overí predajnosť plánu, potvrdenie objednávky a prijatie aktuálnych VOP firmou.
 * Vráti verziu VOP (do metadát Stripe) alebo chybu. Fail closed pri chybe DB.
 */
export async function checkOrderGate(
  db: RpcClient,
  input: { planCode: string; interval: "month" | "year"; orderConsent: unknown; termsVersion: unknown },
): Promise<{ ok: true; termsVersion: string } | ({ ok: false } & OrderGateFailure)> {
  if (!planPurchasable(input.planCode, input.interval)) {
    return { ok: false, code: "ESBLU_BILLING_PLAN_NOT_PURCHASABLE", status: 409 };
  }
  if (input.orderConsent !== true || typeof input.termsVersion !== "string" || !/^[0-9]{1,3}\.[0-9]{1,3}$/.test(input.termsVersion)) {
    return { ok: false, code: "ESBLU_BILLING_ORDER_CONSENT_REQUIRED", status: 400 };
  }
  const { data, error } = await db.rpc("esblu_get_my_company_terms_status");
  if (error) return { ok: false, code: "ESBLU_BILLING_TERMS_REQUIRED", status: 409 };
  const row = (Array.isArray(data) ? data[0] : data) as TermsStatusRow;
  const current = row?.current_terms_version ?? null;
  if (!current || row?.has_current_acceptance !== true) {
    return { ok: false, code: "ESBLU_BILLING_TERMS_REQUIRED", status: 409 };
  }
  if (current !== input.termsVersion) {
    // Klient zobrazil inú verziu, než je aktuálna → nech si obrazovku obnoví.
    return { ok: false, code: "ESBLU_BILLING_TERMS_REQUIRED", status: 409 };
  }
  return { ok: true, termsVersion: current };
}
