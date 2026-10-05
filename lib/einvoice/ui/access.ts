// =============================================================================
// E-Faktúra UI — klasifikácia chýb pri overovaní prístupu (user-scoped klient).
//
// Root cause staging nálezu 5. 10. 2026 (ACCESS_CHECK_FAILED pri prvom načítaní):
// PostgREST odmietol čerstvo vydaný JWT s PGRST303 „JWT issued at future“ —
// `iat` tokenu bol o desatiny sekundy v budúcnosti voči hodinám jednej inštancie
// PostgREST (paralelný druhý dotaz s tým istým tokenom prešiel). Nejde o chybu
// oprávnení ani o výpadok DB. Riešenie:
//   - chyby sa KLASIFIKUJÚ (nie všetko = 500): expirovaný/neplatný JWT → 401,
//     skutočné odmietnutie → 403 (rozhoduje RLS/RPC, nie klient), dočasná chyba → 503,
//   - iba „issued at future“ (clock skew) sa ohraničene zopakuje na serveri
//     (najviac 2×, čakanie ≤ 1,5 s) — iné chyby sa NEopakujú a nemaskujú.
// =============================================================================

export type AccessErrorKind = "clock_skew" | "unauthenticated" | "forbidden" | "temporary";

type PgError = { code?: string | null; message?: string | null } | null | undefined;

export function classifyAccessError(error: PgError, status?: number | null): AccessErrorKind {
  const code = (error?.code ?? "").toUpperCase();
  const message = (error?.message ?? "").toLowerCase();
  if (code === "PGRST303" && /issued at future/.test(message)) return "clock_skew";
  if (code === "PGRST301" || code === "PGRST302" || code === "PGRST303" || status === 401 || /jwt (expired|invalid)|invalid jwt/.test(message)) {
    return "unauthenticated";
  }
  if (code === "28000" || /not_authenticated/.test(message)) return "unauthenticated";
  // Bez aktívnej firmy / zamietnuté oprávnenie = skutočný stav prístupu, nie dočasná chyba.
  if (code === "42501" || status === 403 || /esblu_no_active_company|esblu_forbidden/.test(message)) return "forbidden";
  return "temporary";
}

export type RpcLike = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: PgError; status?: number | null }>;

export type AccessFlags = { financeView: boolean; financeManage: boolean; entitlements: unknown; rollout: boolean | null };

/**
 * Načíta finance.view / finance.manage / nároky (a voliteľne rollout) jedným pokusom;
 * pri clock skew zopakuje (ohraničene). Iné chyby vráti klasifikované.
 */
export async function loadAccessFlags(
  rpc: RpcLike,
  opts: { rolloutEnvironment: string | null; sleep?: (ms: number) => Promise<void>; maxClockSkewRetries?: number }
): Promise<{ ok: true; flags: AccessFlags } | { ok: false; kind: Exclude<AccessErrorKind, "clock_skew"> | "temporary" }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = Math.max(0, Math.min(2, opts.maxClockSkewRetries ?? 2));
  for (let attempt = 0; ; attempt++) {
    const [view, manage] = await Promise.all([rpc("esblu_my_finance_view"), rpc("esblu_my_finance_manage")]);
    // Nároky iba pri finance.view (bez aktívnej firmy RPC nárokov hlási chybu — to nie je výpadok).
    const ent = view.data === true && !view.error ? await rpc("esblu_get_my_company_entitlements") : { data: null, error: null, status: 200 };
    const failed = [view, manage, ent].find((r) => r.error);
    if (failed) {
      const kind = classifyAccessError(failed.error, failed.status ?? null);
      if (kind === "clock_skew" && attempt < maxRetries) {
        await sleep(750 * (attempt + 1));
        continue;
      }
      // Pretrvávajúci clock skew = dočasný stav infraštruktúry, nie chyba oprávnení.
      return { ok: false, kind: kind === "clock_skew" ? "temporary" : kind };
    }
    let rollout: boolean | null = null;
    if (opts.rolloutEnvironment && view.data === true) {
      const r = await rpc("esblu_einvoice_my_rollout", { p_environment: opts.rolloutEnvironment });
      if (r.error) {
        const kind = classifyAccessError(r.error, r.status ?? null);
        if (kind === "clock_skew" && attempt < maxRetries) {
          await sleep(750 * (attempt + 1));
          continue;
        }
        if (kind !== "forbidden") return { ok: false, kind: kind === "clock_skew" ? "temporary" : kind };
        rollout = false; // fail-closed
      } else {
        rollout = r.data === true;
      }
    }
    return { ok: true, flags: { financeView: view.data === true, financeManage: manage.data === true, entitlements: ent.data, rollout } };
  }
}
