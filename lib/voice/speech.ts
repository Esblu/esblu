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
