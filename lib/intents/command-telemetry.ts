// =============================================================================
// Esblu — Intent Engine: počítadlá príkazov asistenta (J8, 2026-10-27).
// =============================================================================
// Čistá klasifikácia JEDNÉHO spracovaného príkazu do triedy, ktorá sa
// pripočíta v ai_usage_monthly (flow 'intent_command', migrácia
// 20261027100000). Do DB ide IBA: firma, mesiac, trieda, výsledok, +1.
// NIKDY text príkazu, prepis, prompt, odpoveď modelu, entita, ŠPZ, user_id.
//
//   deterministic — vyriešené bez AI (parser alebo rozpracovaná úloha)
//   ai-fallback   — zavolal sa AI klasifikátor (outcome = či niečo rozpoznal)
//   unsupported   — odmietnuté / nerozpoznané bez AI
//   ambiguous     — výsledkom je otázka na upresnenie (bez AI)
// =============================================================================

export const INTENT_ROUTE_CLASSES = ["deterministic", "ai-fallback", "unsupported", "ambiguous"] as const;
export type IntentRouteClass = (typeof INTENT_ROUTE_CLASSES)[number];

export type IntentTurnTelemetry = { routeClass: IntentRouteClass; outcome: "success" | "failure" };

export function classifyIntentTurn(turn: {
  aiCalled: boolean;
  recognized: boolean;
  resultKind: string;
  pendingClarification: boolean;
  /** Brána pred AI vetu odmietla ako nepodporovaný zápis (odpoveď „Toto zatiaľ neviem"). */
  refusedUnsupported?: boolean;
}): IntentTurnTelemetry {
  const outcome = turn.recognized ? "success" : "failure";
  if (turn.aiCalled) return { routeClass: "ai-fallback", outcome };
  if (!turn.recognized) return { routeClass: "unsupported", outcome };
  if (turn.refusedUnsupported && turn.resultKind === "answer") return { routeClass: "unsupported", outcome: "failure" };
  if (turn.resultKind === "clarify" || turn.pendingClarification) return { routeClass: "ambiguous", outcome };
  return { routeClass: "deterministic", outcome };
}

/** Argumenty RPC — iba identifikátory na overenie členstva + trieda. */
export function buildIntentCommandRpcArgs(
  scope: { companyId: string; userId: string },
  telemetry: IntentTurnTelemetry
): Record<string, string> | null {
  if (!scope.companyId || !scope.userId) return null;
  if (!(INTENT_ROUTE_CLASSES as readonly string[]).includes(telemetry.routeClass)) return null;
  return {
    p_company_id: scope.companyId,
    p_user_id: scope.userId,
    p_route_class: telemetry.routeClass,
    p_outcome: telemetry.outcome,
  };
}
