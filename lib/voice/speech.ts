"use client";

import { speechLangFor } from "@/lib/voice/spoken-text";

// =============================================================================
// Hlasové odpovede Esblu — Web Speech API (SpeechSynthesis) v prehliadači.
//
// PREČO PREHLIADAČ, NIE SERVEROVÉ TTS: je zadarmo, funguje offline, nič sa
// neposiela na ďalší server (žiadne firemné údaje von) a je v Chrome/Android
// WebView aj Safari/iOS. Keď hlas pre jazyk chýba, prehliadač použije
// predvolený; keď API chýba úplne, Esblu jednoducho mlčí (text je na obrazovke).
//
// Predvoľba (zapnuté/vypnuté) je iba pohodlie jedného prehliadača —
// localStorage v try/catch; bez úložiska platí „zapnuté".
// =============================================================================

const PREF_KEY = "esblu.voiceReplies.v1";

export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function voiceRepliesEnabled(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setVoiceRepliesEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(PREF_KEY, enabled ? "on" : "off");
  } catch {
    // Bez úložiska platí iba pre túto reláciu.
  }
  if (!enabled) cancelSpeech();
}

/** Zastaví rozprávanie (nový príkaz, nahrávanie, zatvorenie panela). */
export function cancelSpeech(): void {
  if (!isSpeechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Nič — hlas je iba doplnok.
  }
}

/**
 * iOS/Safari pustí syntézu reči iba vtedy, keď prvé `speak()` zaznie v rámci
 * používateľského gesta. Súvislý hlasový režim hovorí až po odpovedi servera
 * (mimo gesta), preto sa pri ťuknutí na mikrofón „odomkne" prázdnou vetou.
 */
export function primeSpeech(): void {
  if (!isSpeechSupported() || !voiceRepliesEnabled()) return;
  try {
    const utterance = new SpeechSynthesisUtterance("");
    utterance.volume = 0;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Nič — hlas je iba doplnok.
  }
}

export type SpeechOutcome = "ended" | "error" | "cancelled" | "skipped";

/**
 * Povie text a počká na SKUTOČNÝ koniec reči (onend / onerror). Súvislý
 * hlasový režim zapne mikrofón až potom — Esblu tak nikdy nenahrá sám seba.
 *
 * Vypnuté hlasové odpovede / chýbajúce API → hneď „skipped" (dialóg ide
 * ďalej bez zvuku). `signal` preruší reč (barge-in, ukončenie relácie).
 *
 * POISTKA: Chrome (desktop aj Android) pri dlhších vetách občas nevyšle
 * `end`. Namiesto odhadu dĺžky sa sleduje skutočný stav syntézy
 * (`speechSynthesis.speaking/pending`): keď syntéza reálne dohovorila a
 * udalosť neprišla, považuje sa to za koniec. Kontrola beží každých 250 ms
 * (frekvencia vzorkovania stavu, nie oneskorenie).
 */
export function speakAndWait(text: string, locale: string, signal?: AbortSignal): Promise<SpeechOutcome> {
  if (!text || !isSpeechSupported() || !voiceRepliesEnabled()) return Promise.resolve("skipped");
  return new Promise<SpeechOutcome>((resolve) => {
    const synth = window.speechSynthesis;
    let settled = false;
    let started = false;
    let idleChecks = 0;
    let poll: ReturnType<typeof setInterval> | null = null;
    const finish = (outcome: SpeechOutcome) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => {
      try {
        synth.cancel();
      } catch {
        // nič
      }
      finish("cancelled");
    };
    if (signal?.aborted) {
      finish("cancelled");
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const lang = speechLangFor(locale);
      utterance.lang = lang;
      const prefix = lang.slice(0, 2).toLowerCase();
      const voice = synth.getVoices().find((candidate) => candidate.lang?.toLowerCase().startsWith(prefix));
      if (voice) utterance.voice = voice;
      utterance.rate = 1;
      utterance.onstart = () => {
        started = true;
      };
      utterance.onend = () => finish("ended");
      utterance.onerror = (event) => finish(event.error === "interrupted" || event.error === "canceled" ? "cancelled" : "error");
      synth.speak(utterance);
      poll = setInterval(() => {
        const busy = synth.speaking || synth.pending;
        if (busy) {
          started = true;
          idleChecks = 0;
          return;
        }
        // Syntéza nič nerobí: po začatí = dohovorené bez udalosti; bez začatia
        // (8 kontrol = 2 s) = hlas sa nespustil (chýbajúci hlas, blokácia).
        idleChecks += 1;
        if (started ? idleChecks >= 2 : idleChecks >= 8) finish(started ? "ended" : "error");
      }, 250);
    } catch {
      finish("error");
    }
  });
}

/** Povie text v jazyku aplikácie. Predchádzajúcu vetu vždy preruší. */
export function speak(text: string, locale: string): void {
  if (!text || !isSpeechSupported() || !voiceRepliesEnabled()) return;
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const lang = speechLangFor(locale);
    utterance.lang = lang;
    const prefix = lang.slice(0, 2).toLowerCase();
    const voice = synth.getVoices().find((candidate) => candidate.lang?.toLowerCase().startsWith(prefix));
    if (voice) utterance.voice = voice;
    utterance.rate = 1;
    synth.speak(utterance);
  } catch {
    // Nič — text je na obrazovke.
  }
}
