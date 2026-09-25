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
 * Silné odkazy na práve hovorené vety. Chrome (aj Android) inak vetu počas
 * rozprávania uvoľní z pamäte a `end` už nikdy nepríde — Esblu by „prestal
 * hovoriť" a relácia by čakala.
 */
const liveUtterances = new Set<SpeechSynthesisUtterance>();

function newUtterance(text: string, locale: string, synth: SpeechSynthesis): SpeechSynthesisUtterance {
  const utterance = new SpeechSynthesisUtterance(text);
  const lang = speechLangFor(locale);
  utterance.lang = lang;
  const prefix = lang.slice(0, 2).toLowerCase();
  const voice = synth.getVoices().find((candidate) => candidate.lang?.toLowerCase().startsWith(prefix));
  if (voice) utterance.voice = voice;
  utterance.rate = 1;
  return utterance;
}

/**
 * Povie text a počká na SKUTOČNÝ koniec reči (onend / onerror). Súvislý
 * hlasový režim zapne mikrofón až potom — Esblu tak nikdy nenahrá sám seba.
 *
 * Vypnuté hlasové odpovede / chýbajúce API → hneď „skipped" (dialóg ide
 * ďalej bez zvuku). `signal` preruší reč (barge-in, ukončenie relácie).
 *
 * SPOĽAHLIVOSŤ NA DLHÝ ROZHOVOR (príčina „Esblu po pár kolách mlčí"):
 *   - Po nahrávaní z mikrofónu nechá Chrome/Android syntézu občas v stave
 *     `paused` alebo zahodí `speak()` zavolané hneď po `cancel()`. Preto:
 *     `cancel()` iba keď naozaj niečo hovorí, vždy `resume()` pred `speak()`
 *     a keď sa reč do 2 s nespustí, JEDEN nový pokus (cancel → resume → speak).
 *   - Vety sa držia v pamäti až do konca (pozri `liveUtterances`).
 *   - Chrome občas nevyšle `end`: sleduje sa skutočný stav syntézy
 *     (`speaking/pending`) každých 250 ms — frekvencia vzorkovania stavu,
 *     nie odhad dĺžky vety.
 *   - Chyba jednej vety NEVYPNE ďalšie: každé volanie začína nanovo.
 */
export function speakAndWait(text: string, locale: string, signal?: AbortSignal): Promise<SpeechOutcome> {
  if (!text || !isSpeechSupported() || !voiceRepliesEnabled()) return Promise.resolve("skipped");
  return new Promise<SpeechOutcome>((resolve) => {
    const synth = window.speechSynthesis;
    let settled = false;
    let started = false;
    let idleChecks = 0;
    let attempts = 0;
    let current: SpeechSynthesisUtterance | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const release = () => {
      if (current) {
        current.onstart = null;
        current.onend = null;
        current.onerror = null;
        liveUtterances.delete(current);
      }
    };
    const finish = (outcome: SpeechOutcome) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      release();
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
    const attempt = () => {
      attempts += 1;
      release();
      started = false;
      idleChecks = 0;
      if (synth.speaking || synth.pending) synth.cancel();
      if (synth.paused) synth.resume();
      const utterance = newUtterance(text, locale, synth);
      current = utterance;
      liveUtterances.add(utterance);
      utterance.onstart = () => {
        started = true;
      };
      utterance.onend = () => finish("ended");
      utterance.onerror = (event) => {
        if (event.error === "interrupted" || event.error === "canceled") finish("cancelled");
        else if (!started && attempts < 2) attempt();
        else finish("error");
      };
      synth.speak(utterance);
      // Niektoré Android WebView po speak() ostanú „paused" — odblokovať.
      if (synth.paused) synth.resume();
    };

    if (signal?.aborted) {
      finish("cancelled");
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      attempt();
      poll = setInterval(() => {
        // Pozastavená syntéza (audio fokus po mikrofóne) sa odblokuje; iba
        // skutočné rozprávanie sa počíta ako pokrok. Zaseknuté „pending" bez
        // rozprávania sa počíta ako nespustené → nový pokus / chyba.
        if (synth.paused) synth.resume();
        if (synth.speaking && !synth.paused) {
          started = true;
          idleChecks = 0;
          return;
        }
        if (started && synth.pending) {
          idleChecks = 0;
          return;
        }
        idleChecks += 1;
        if (started) {
          // Dohovorené bez udalosti `end`.
          if (idleChecks >= 2) finish("ended");
        } else if (idleChecks >= 8) {
          // Reč sa za 2 s nespustila → jeden nový pokus, potom chyba.
          if (attempts < 2) attempt();
          else finish("error");
        }
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
