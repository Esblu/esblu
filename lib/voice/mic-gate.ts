// =============================================================================
// Kedy a ako sa zobrazí mikrofón Esblu (voice QA 2026-10-11).
//
// PREDTÝM: VoiceSessionControl vrátil `null` vždy, keď firma nemala nárok
// `voice` — aj počas načítania nárokov a pri chybe ich načítania. Hlas nie je
// súčasťou 14-dňového trialu, takže na nových firmách (aj na stagingu)
// mikrofón v poli hľadania bez vysvetlenia CHÝBAL. Používateľ nevedel, či je
// to chyba, nastavenie alebo platená funkcia, a natívne QA sa nedalo začať.
//
// TERAZ (čistá funkcia, testovaná v scripts/voice-mic-gate-tests.ts):
//   hidden       rola hlas nemá (zamestnanec) — politika rolí sa nemení
//   pending      členstvo/nároky sa načítavajú → stabilné miesto, neaktívne
//   unavailable  nároky sa nepodarilo načítať → ťuknutie = skúsiť znova
//   locked       firma nemá nárok `voice` → zámok, ťuknutie = vysvetlenie
//                + „Požiadať o aktiváciu" (rovnako ako zamknutý modul)
//   ready        oprávnený používateľ s nárokom → mikrofón funguje
//
// Bezpečnosť sa tým NEMENÍ: server (/api/assistant/transcribe →
// guardTranscription → esblu_require_my_entitlement('voice')) odmietne prepis
// bez nároku aj bez povolenej roly. Bežiacu reláciu sa dá vždy ukončiť.
// Platforma (web / natívna appka) mikrofón neskrýva — rovnaká politika všade.
// =============================================================================

export type MicGate = "hidden" | "pending" | "unavailable" | "locked" | "ready";

export type MicGateInput = {
  /** Hlasová relácia beží — ovládanie sa nikdy nesmie stratiť. */
  sessionActive: boolean;
  membershipLoading: boolean;
  /** Rola smie hlasový asistent (lib/intents/permissions.ts → voiceTranscriptionAllowed). */
  roleAllowsVoice: boolean;
  entitlementsLoading: boolean;
  entitlementsError: boolean;
  hasVoiceEntitlement: boolean;
};

export function micGate(input: MicGateInput): MicGate {
  if (input.sessionActive) return "ready";
  if (input.membershipLoading) return "pending";
  if (!input.roleAllowsVoice) return "hidden";
  if (input.entitlementsLoading) return "pending";
  if (input.hasVoiceEntitlement) return "ready";
  if (input.entitlementsError) return "unavailable";
  return "locked";
}

/** Dôvod, ktorý komponent ohlási volajúcemu pri ťuknutí na neaktívny mikrofón. */
export type MicGateNotice = "locked" | "unavailable";
