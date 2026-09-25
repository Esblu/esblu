// =============================================================================
// Koniec vety podľa hlasitosti (voice activity detection) — čistá logika.
//
// Súvislý hlasový režim nemá tlačidlo „stop" po každej vete: nahrávka sa
// ukončí sama, keď používateľ dohovorí. Rozhoduje iba úroveň signálu z
// mikrofónu (RMS), žiadny obsah, nič sa neposiela nikam navyše.
//
// PARAMETRE (každý má dôvod):
//   calibrationMs 250  — hluk miestnosti sa zmeria na začiatku (najtichšia
//                        vzorka); prah reči je jeho násobok, ohraničený
//                        min/max (tichá kancelária aj stavba; okamžitá reč).
//   minSpeechMs   100  — reč musí trvať aspoň 2 vzorky; klik/ťuknutie nie je veta.
//                        Krátke „áno", „päť" (~250–400 ms) prejdú bezpečne.
//   endSilenceMs  900  — ticho po reči, ktoré znamená koniec vety. Kratšie by
//                        sekalo vety s prirodzenou pauzou („päť… kusov").
//   noSpeechMs   8000  — nikto nehovorí → mikrofón sa vypne (nie je to trvalé
//                        počúvanie na pozadí).
//   maxMs              — strop dĺžky nahrávky (lib/voice-config.ts).
// =============================================================================

export type VadParams = {
  calibrationMs: number;
  minSpeechMs: number;
  endSilenceMs: number;
  noSpeechMs: number;
  maxMs: number;
  /** Najnižší prah RMS (0..1) — aj v úplnom tichu musí reč byť počuteľná. */
  minThreshold: number;
  /** Najvyšší prah — keď používateľ začne hovoriť hneď, kalibrácia nesmie „zjesť" jeho vetu. */
  maxThreshold: number;
  /** Násobok hluku pozadia, od ktorého je signál reč. */
  noiseFactor: number;
};

export const DEFAULT_VAD: Omit<VadParams, "maxMs"> = {
  calibrationMs: 250,
  minSpeechMs: 100,
  endSilenceMs: 900,
  noSpeechMs: 8000,
  minThreshold: 0.015,
  maxThreshold: 0.06,
  noiseFactor: 2.5,
};

export type VadVerdict = "waiting" | "speaking" | "end" | "no_speech" | "too_long";

export function createVad(params: VadParams) {
  const calibration: number[] = [];
  let threshold = params.minThreshold;
  let loudSince: number | null = null;
  let speechDetected = false;
  let lastLoud = 0;

  return {
    get speechDetected() {
      return speechDetected;
    },
    /** `level` = RMS 0..1, `elapsedMs` = čas od začiatku počúvania. */
    push(level: number, elapsedMs: number): VadVerdict {
      if (elapsedMs >= params.maxMs) return "too_long";
      if (elapsedMs < params.calibrationMs && !speechDetected) {
        calibration.push(level);
        // Najtichšia vzorka = hluk pozadia (aj keď reč začne hneď). Strop
        // zaručí, že krátke „päť" vyslovené okamžite sa neberie ako hluk.
        const floor = Math.min(...calibration);
        threshold = Math.min(params.maxThreshold, Math.max(params.minThreshold, floor * params.noiseFactor));
      }
      const loud = level > threshold;
      if (loud) {
        if (loudSince === null) loudSince = elapsedMs;
        lastLoud = elapsedMs;
        if (!speechDetected && elapsedMs - loudSince + 1 >= params.minSpeechMs) speechDetected = true;
      } else {
        loudSince = null;
      }
      if (speechDetected) {
        return elapsedMs - lastLoud >= params.endSilenceMs ? "end" : "speaking";
      }
      return elapsedMs >= params.noSpeechMs ? "no_speech" : "waiting";
    },
  };
}
