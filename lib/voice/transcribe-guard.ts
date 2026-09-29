// =============================================================================
// Autorizácia platného prepisu reči (/api/assistant/transcribe) — M1 authz
// follow-up 2026-09-28.
//
// Prepis stojí peniaze a jeho jediný účel je vstup do asistenta. Preto ho
// endpoint SÁM (nie až neskoršie odmietnutie intentu) pustí iba vtedy, keď:
//   1. požiadavka má overeného používateľa (JWT),
//   2. používateľ má AKTÍVNE členstvo vo firme (rola z DB, nie z klienta),
//   3. rola smie hlasový asistent (voiceTranscriptionAllowed — zamestnanec nie),
//   4. firma má nárok `voice`.
// Poradie je zámerne: rola pred nárokom — zamestnanec sa nikdy nedostane ani
// k overovaniu nároku, audio sa nečíta, OpenAI sa nevolá.
//
// Čistá funkcia so vstrekovanými závislosťami, aby ju testy overili bez
// Supabase aj OpenAI (scripts/mobile-m1-tests.ts).
// =============================================================================

import { voiceTranscriptionAllowed } from "../intents/permissions.ts";

export type TranscribeGuardDeps = {
  /** Overený používateľ z JWT, alebo null. */
  getUser: () => Promise<{ id: string } | null>;
  /** esblu_my_active_role() cez user-scoped klienta; null = žiadne aktívne členstvo. */
  getActiveRole: () => Promise<string | null>;
  /** Nárok `voice` firmy volajúceho (esblu_require_my_entitlement). */
  hasVoiceEntitlement: () => Promise<boolean>;
};

export type TranscribeGuardResult =
  | { ok: true; role: string }
  | { ok: false; status: 401 | 403; reason: "UNAUTHENTICATED" | "NO_ACTIVE_MEMBERSHIP" | "ROLE_NOT_ALLOWED" | "VOICE_ENTITLEMENT_REQUIRED" };

export async function guardTranscription(deps: TranscribeGuardDeps): Promise<TranscribeGuardResult> {
  const user = await deps.getUser();
  if (!user) return { ok: false, status: 401, reason: "UNAUTHENTICATED" };

  const role = await deps.getActiveRole();
  if (!role) return { ok: false, status: 403, reason: "NO_ACTIVE_MEMBERSHIP" };
  if (!voiceTranscriptionAllowed(role)) return { ok: false, status: 403, reason: "ROLE_NOT_ALLOWED" };

  if (!(await deps.hasVoiceEntitlement())) return { ok: false, status: 403, reason: "VOICE_ENTITLEMENT_REQUIRED" };

  return { ok: true, role };
}
