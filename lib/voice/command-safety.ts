import type { IntentResult } from "../intents/types.ts";
import { decideVoiceConfirmation, type VoiceConfirmationDecision } from "./voice-session.ts";

// =============================================================================
// Bezpečnostný model hlasových príkazov (voice hardening 2026-10-11).
//
//   A. navigation  „otvor faktúry"               → vykoná sa hneď (iba presun)
//   B. read        „koľko mám neuhradených…"     → odpovie hneď (nič nemení)
//   C. write       „vytvor faktúru / pridaj…"    → server vráti NÁVRH
//                                                  (action_preview / otázku);
//                                                  zápis až po potvrdení
//                                                  (hlasom „áno" alebo ťuknutím)
//   D. critical    mazanie, nevratné akcie       → NIKDY iba hlasom: vyslovené
//                                                  „áno" sa neberie, potvrdiť
//                                                  sa dá výhradne ťuknutím na
//                                                  tlačidlo v náhľade
//
// Server je autorita pre C aj D (jednorazový podpísaný confirmationId,
// registry.ts requiresConfirmation, RLS). Táto vrstva je druhá poistka na
// klientovi: rozpoznaný prepis môže byť skomolený („áno" z šumu), a pri
// nevratnej akcii nesmie stačiť jedna nepresná slabika.
// =============================================================================

export type CommandRisk = "navigation" | "read" | "write" | "critical";

type ActionPreview = Extract<IntentResult, { kind: "action_preview" }>;

const CRITICAL_ACTION = /(^|_)(DELETE|REMOVE)(_|$)/;

/** Nevratná akcia: server ju označil ako destructive alebo ide o mazanie/odobratie. */
export function isCriticalPreview(preview: ActionPreview): boolean {
  return preview.destructive === true || CRITICAL_ACTION.test(preview.action);
}

export function riskOfResult(result: IntentResult | null | undefined): CommandRisk {
  if (!result) return "read";
  switch (result.kind) {
    case "navigate":
      return "navigation";
    case "action_preview":
      return isCriticalPreview(result) ? "critical" : "write";
    case "draft_created":
    case "action_result":
      return "write";
    default:
      return "read";
  }
}

export type VoicePreviewDecision = VoiceConfirmationDecision | "tap_required";

/**
 * Hlasová odpoveď na zobrazený náhľad zápisu.
 *  - „áno" pri bežnom zápise → confirm (tá istá jednorazová cesta ako tlačidlo)
 *  - „áno" pri nevratnej akcii → tap_required (nič sa nevykoná, Esblu
 *    požiada o ťuknutie na tlačidlo)
 *  - „nie" → cancel; nejasné → ask_again; dlhá veta → new_command
 */
export function decideVoiceReplyForPreview(text: string, preview: ActionPreview): VoicePreviewDecision {
  const decision = decideVoiceConfirmation(text);
  if (decision === "confirm" && isCriticalPreview(preview)) return "tap_required";
  return decision;
}
