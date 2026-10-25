// =============================================================================
// Koľko sekúnd hlasu sa započíta do kvóty firmy (voice_minutes) za 1 prepis.
//
// OpenAI pri gpt-4o-transcribe vracia usage typu `tokens` (nie sekundy), klient
// dĺžku neposiela (a nedôverovali by sme jej). Preto serverový odhad:
//   1. usage typu `duration` → presné sekundy,
//   2. inak z veľkosti audia (opus/webm ~32 kbps ≈ 4 000 B/s),
//   ohraničené na [1 s, MAX_RECORDING_SECONDS] (klient nahrávanie natvrdo
//   zastaví po MAX_RECORDING_SECONDS). Odhad = ESTIMATE; skutočná spotreba
//   OpenAI sa zosúlaďuje cez ai_usage_monthly (audio tokeny).
// =============================================================================
import { MAX_RECORDING_SECONDS } from "@/lib/voice-config";

export const VOICE_BYTES_PER_SECOND_ESTIMATE = 4000;

export function billableVoiceSeconds(input: { usageSeconds?: number | null; audioBytes: number }): number {
  const fromUsage = typeof input.usageSeconds === "number" && Number.isFinite(input.usageSeconds) && input.usageSeconds > 0 ? input.usageSeconds : null;
  const fromBytes = Number.isFinite(input.audioBytes) && input.audioBytes > 0 ? input.audioBytes / VOICE_BYTES_PER_SECOND_ESTIMATE : 1;
  const seconds = fromUsage ?? fromBytes;
  return Math.round(Math.min(Math.max(seconds, 1), MAX_RECORDING_SECONDS) * 1000) / 1000;
}
