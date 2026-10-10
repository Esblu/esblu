import type { MicFailureReason } from "./voice-session.ts";

// =============================================================================
// Klasifikácia zlyhania getUserMedia (UI refresh + voice hardening 2026-10-11).
//
// PREDTÝM: každé zlyhanie = „Mikrofón nie je povolený" — aj keď mikrofón
// iba drží iná appka (hovor) alebo žiadny nie je. Používateľ potom hľadal
// povolenie, ktoré mal zapnuté.
//
// TRVALÉ ZABLOKOVANIE: prehliadač (Permissions API „denied") alebo
// natívny WebView, ktorý odmietne bez výzvy (Android po „Nepýtať sa znova"
// odmietne okamžite). Vtedy má zmysel ponúknuť „Otvoriť nastavenia" —
// opätovné ťuknutie by už výzvu nezobrazilo.
//
// Čistá funkcia (bez prehliadača) — testovaná v scripts/voice-hardening-tests.ts.
// =============================================================================

/** Odmietnutie rýchlejšie ako toto = výzva sa vôbec nezobrazila. */
export const INSTANT_DENIAL_MS = 450;

export type MicPermissionState = "granted" | "denied" | "prompt" | "unknown";

export function classifyMicError(
  error: unknown,
  context: { permission: MicPermissionState; elapsedMs: number; secureContext?: boolean }
): MicFailureReason {
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";

  if (context.secureContext === false) return "unsupported";

  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      if (context.permission === "denied" || context.elapsedMs < INSTANT_DENIAL_MS) return "blocked";
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "not_found";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    case "TypeError":
    case "NotSupportedError":
      return "unsupported";
    default:
      // Neznáma chyba: radšej „skúste znova" než tvrdiť, že je to zakázané.
      return context.permission === "denied" ? "blocked" : "busy";
  }
}

/** Stav povolenia mikrofónu, ak ho prehliadač prezradí (Safari < 16 nie). */
export async function queryMicPermission(): Promise<MicPermissionState> {
  try {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state === "granted" || status.state === "denied" || status.state === "prompt" ? status.state : "unknown";
  } catch {
    return "unknown";
  }
}
