// =============================================================================
// AI usage metering — serverová väzba (service role). Iba server routes.
//
// GDPR: ACCESS / COST TELEMETRY ONLY — NO CONTENT LOGGING (pozri usage-meter.ts).
// Company scoping (fail closed):
//   - skeny dokumentov: scope = AI rezervácia → firmu + používateľa odvodí DB
//     (esblu_record_ai_usage_for_reservation); usage patrí presne firme,
//     ktorej sa započítala AI kvóta,
//   - hlas / intent fallback: aktívna firma zo serverom overeného členstva,
//   - DB (esblu_record_ai_usage) vždy ešte raz overí aktívne členstvo.
// Zápis je best-effort: nikdy nehádže a nemení odpoveď používateľovi.
// =============================================================================
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { recordAiUsageWith, type AiUsageRecord, type MeterScope, type UsageRpc } from "@/lib/ai/usage-meter";
import { buildIntentCommandRpcArgs, type IntentTurnTelemetry } from "@/lib/intents/command-telemetry";

export { reservationMeterScope, type MeterScope } from "@/lib/ai/usage-meter";

function adminRpc(): UsageRpc | null {
  try {
    const admin = getSupabaseAdmin();
    return async (fn, args) => {
      const { data, error } = await admin.rpc(fn, args);
      return { data, error };
    };
  } catch {
    return null;
  }
}

export async function recordAiUsageInScope(scope: MeterScope | null, record: AiUsageRecord): Promise<boolean> {
  if (!scope) return false;
  const rpc = adminRpc();
  if (!rpc) return false;
  return recordAiUsageWith(rpc, scope, record);
}

/**
 * Hlas: aktívna firma session volajúceho (esblu_my_active_company_id cez
 * user-scoped klienta — serverom validovaná voľba, nikdy z tela požiadavky).
 * null = neznáma → nemerať.
 */
export async function meterScopeFromRequest(req: Request, userId: string): Promise<MeterScope | null> {
  try {
    const authorization = req.headers.get("authorization") || "";
    const accessToken = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    if (!accessToken) return null;
    const { data, error } = await getUserScopedSupabaseClient(accessToken).rpc("esblu_my_active_company_id");
    if (error || typeof data !== "string" || !data) return null;
    return { kind: "member", companyId: data, userId };
  } catch {
    return null;
  }
}

/**
 * J8: +1 príkaz asistenta v triede (deterministic / ai-fallback /
 * unsupported / ambiguous) pod aktívnu firmu z overeného členstva. Iba
 * počítadlo — žiadny text, prepis ani user_id sa neukladá. Best-effort:
 * nikdy nehádže a nemení odpoveď používateľovi.
 */
export async function recordIntentCommandInScope(
  scope: { companyId: string; userId: string },
  telemetry: IntentTurnTelemetry
): Promise<boolean> {
  const args = buildIntentCommandRpcArgs(scope, telemetry);
  if (!args) return false;
  try {
    const { data, error } = await getSupabaseAdmin().rpc("esblu_record_intent_command", args);
    return !error && data === true;
  } catch {
    return false;
  }
}
