"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { MicSession } from "@/lib/voice/utterance-capture";
import { cancelSpeech, primeSpeech, speakAndWait } from "@/lib/voice/speech";
import { recordVoiceDiagnostic } from "@/lib/voice/voice-diagnostics";
import {
  INITIAL_VOICE_SESSION,
  isSessionActive,
  voiceSessionReducer,
  type StopReason,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceSessionState,
} from "@/lib/voice/voice-session";
import type { TranscriptionContext } from "@/hooks/use-voice-capture";

// =============================================================================
// useVoiceSession — súvislý hlasový režim (jedno ťuknutie → rozhovor).
//
// Stavový automat je čistý (lib/voice/voice-session.ts); tento hook iba
// vykonáva jeho efekty v prehliadači: mikrofón (lib/voice/utterance-
// capture.ts), prepis (/api/assistant/transcribe — ten istý endpoint ako
// doteraz), odoslanie vety volajúcemu a reč (lib/voice/speech.ts).
//
// O VÝZNAME vety rozhoduje volajúci (`onUtterance`) cez ten istý server a
// tie isté oprávnenia ako pri písaní. Hook vracia iba to, čo sa má povedať.
//
// SÚKROMIE: mikrofón je zapnutý IBA v stave „počúvam". Karta na pozadí,
// zamknutý telefón, výpadok siete, odobraté povolenie, odchod zo stránky →
// relácia sa ZASTAVÍ a mikrofón sa uvoľní (nikdy nepočúva potichu ďalej).
// =============================================================================

export type VoiceTurnReply = {
  /** Čo Esblu povie (null = nič, hneď počúvať znova). */
  spoken: string | null;
  /** Ukončiť reláciu (napr. vypršané prihlásenie). */
  endSession?: boolean;
};

export function useVoiceSession({
  onUtterance,
  getTranscriptionContext,
  onTranscript,
}: {
  /** Veta používateľa → odpoveď na vyslovenie. Volajúci aktualizuje UI. */
  onUtterance: (text: string) => Promise<VoiceTurnReply>;
  getTranscriptionContext?: () => TranscriptionContext | null;
  /** Zobrazenie prepisu (voliteľné). */
  onTranscript?: (text: string) => void;
}) {
  const { t, locale } = useLocale();
  const [session, setSession] = useState<VoiceSessionState>(INITIAL_VOICE_SESSION);
  const stateRef = useRef<VoiceSessionState>(INITIAL_VOICE_SESSION);
  const micRef = useRef<MicSession | null>(null);
  const blobRef = useRef<{ blob: Blob; mimeType: string } | null>(null);
  const speechAbortRef = useRef<AbortController | null>(null);
  // Najnovšie callbacky bez znovuvytvárania dispatchu.
  const latest = useRef({ onUtterance, getTranscriptionContext, onTranscript, t, locale });
  useEffect(() => {
    latest.current = { onUtterance, getTranscriptionContext, onTranscript, t, locale };
  });

  const dispatchRef = useRef<(event: VoiceEvent) => void>(() => undefined);

  // Každý efekt dostane generáciu prechodu, v ktorom vznikol; jeho
  // dokončenie ju pošle späť a automat oneskorené dokončenia ignoruje.
  const runEffect = useCallback((effect: VoiceEffect, gen: number) => {
    const dispatch = (event: VoiceEvent) => dispatchRef.current(event);
    const mic = micRef.current;
    recordVoiceDiagnostic({ kind: "effect", name: effect.type, gen });
    switch (effect.type) {
      case "acquireMic": {
        if (!mic) {
          dispatch({ type: "MIC_FAILED", reason: "unsupported", gen });
          return;
        }
        void mic.open().then((outcome) => {
          if (outcome === "cancelled") return; // zastavené medzitým; mikrofón už pustený
          if (outcome === "ready") dispatch({ type: "MIC_READY", gen });
          else dispatch({ type: "MIC_FAILED", reason: outcome, gen });
        });
        return;
      }
      case "listen": {
        if (!mic) return;
        void mic.listen().then((outcome) => {
          recordVoiceDiagnostic({ kind: "capture", name: outcome.kind, gen });
          if (outcome.kind === "speech") {
            blobRef.current = { blob: outcome.blob, mimeType: outcome.mimeType };
            dispatch({ type: "UTTERANCE_CAPTURED", gen });
          } else if (outcome.kind === "no_speech") dispatch({ type: "NO_SPEECH", gen });
          else if (outcome.kind === "too_long" || outcome.kind === "error") dispatch({ type: "CAPTURE_FAILED", gen });
          // aborted = zámerné zastavenie; automat už je v inom stave.
        });
        return;
      }
      case "cancelListen":
        mic?.abortListen();
        return;
      case "releaseMic":
        mic?.release();
        return;
      case "transcribe": {
        const captured = blobRef.current;
        blobRef.current = null;
        if (!captured) {
          dispatch({ type: "TRANSCRIBE_FAILED", gen });
          return;
        }
        void transcribe(captured, latest.current.locale, latest.current.getTranscriptionContext?.() ?? null).then((text) => {
          recordVoiceDiagnostic({ kind: "transcript", name: text === null ? "failed" : "ok", gen });
          if (text === null) dispatch({ type: "TRANSCRIBE_FAILED", gen });
          else {
            latest.current.onTranscript?.(text);
            dispatch({ type: "TRANSCRIPT", text, gen });
          }
        });
        return;
      }
      case "sendTurn":
        void latest.current
          .onUtterance(effect.text)
          .then((reply) => {
            recordVoiceDiagnostic({ kind: "turn", name: reply.spoken ? "spoken" : "silent", gen });
            dispatch({ type: "TURN_RESULT", spoken: reply.spoken, endSession: reply.endSession, gen });
          })
          .catch(() => {
            recordVoiceDiagnostic({ kind: "turn", name: "failed", gen });
            dispatch({ type: "TURN_FAILED", gen });
          });
        return;
      case "speak":
      case "speakNotice": {
        speechAbortRef.current?.abort();
        const controller = new AbortController();
        speechAbortRef.current = controller;
        const text = effect.type === "speak" ? effect.text : latest.current.t(`search.voice.session.${effect.key}`);
        void speakAndWait(text, latest.current.locale, controller.signal).then((outcome) => {
          recordVoiceDiagnostic({ kind: "speech", name: outcome, gen });
          // Prerušenie (barge-in / stop) rieši automat sám — žiadny druhý štart.
          // Chyba syntézy aj vypnuté odpovede → ďalej počúvať (nikdy neuviaznuť).
          if (outcome !== "cancelled") dispatch({ type: "SPEECH_DONE", gen });
        });
        return;
      }
      case "cancelSpeech":
        speechAbortRef.current?.abort();
        speechAbortRef.current = null;
        cancelSpeech();
        return;
    }
  }, []);

  useEffect(() => {
    dispatchRef.current = (event: VoiceEvent) => {
      const { state, effects } = voiceSessionReducer(stateRef.current, event);
      if (state === stateRef.current && effects.length === 0) return; // ignorované (oneskorené) dokončenie
      stateRef.current = state;
      setSession(state);
      recordVoiceDiagnostic({ kind: "state", name: state.status, gen: state.gen });
      effects.forEach((effect) => runEffect(effect, state.gen));
      if (!isSessionActive(state.status)) {
        // Koniec relácie: AudioContext preč až po efektoch (reč oznámenia smie dobehnúť).
        micRef.current?.close();
        micRef.current = null;
      }
    };
  }, [runEffect]);

  /** Ťuknutie na mikrofón (štart / ukončenie / prerušenie Esblu). */
  const tap = useCallback(() => {
    const status = stateRef.current.status;
    if (!isSessionActive(status)) {
      // V GESTE: odomknúť zvuk a reč pre celú reláciu (iOS/Android).
      const mic = new MicSession();
      try {
        mic.prime();
      } catch {
        dispatchRef.current({ type: "START" });
        dispatchRef.current({ type: "MIC_FAILED", reason: "unsupported" });
        return;
      }
      mic.onTrackEnded = () => dispatchRef.current({ type: "STOP", reason: "mic_lost" });
      micRef.current = mic;
      primeSpeech();
    }
    dispatchRef.current({ type: "USER_TAP" });
  }, []);

  const stop = useCallback((reason: StopReason) => {
    dispatchRef.current({ type: "STOP", reason });
  }, []);

  /** Ťuknutie na „Áno"/„Nie"/„Potvrdiť" počas relácie — pokračuje hlasom. */
  const manualTurn = useCallback((text: string) => {
    dispatchRef.current({ type: "MANUAL_TURN", text });
  }, []);

  // Súkromie: pozadie, zamknutie, výpadok siete, odchod zo stránky.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") dispatchRef.current({ type: "STOP", reason: "hidden" });
    };
    const onPageHide = () => dispatchRef.current({ type: "STOP", reason: "navigation" });
    const onOffline = () => dispatchRef.current({ type: "STOP", reason: "offline" });
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("offline", onOffline);
    const { data: auth } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") dispatchRef.current({ type: "STOP", reason: "session_end" });
    });
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("offline", onOffline);
      auth.subscription.unsubscribe();
      // Odmontovanie (navigácia v appke) = koniec relácie a uvoľnený mikrofón.
      dispatchRef.current({ type: "STOP", reason: "navigation" });
      speechAbortRef.current?.abort();
      micRef.current?.close();
      micRef.current = null;
    };
  }, []);

  return { session, active: isSessionActive(session.status), tap, stop, manualTurn };
}

/** Prepis jednej vety — ten istý endpoint a limity ako jednorazový mikrofón. */
async function transcribe(
  captured: { blob: Blob; mimeType: string },
  locale: string,
  context: TranscriptionContext | null
): Promise<string | null> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return null;
    const mime = captured.mimeType;
    const extension = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
    const form = new FormData();
    form.append("audio", captured.blob, `voice-command.${extension}`);
    if (context) form.append("context", context);
    const response = await fetch(apiUrl("/api/assistant/transcribe"), {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, [REQUEST_LOCALE_HEADER]: locale },
      body: form,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success || typeof data.text !== "string" || !data.text.trim()) return null;
    return data.text as string;
  } catch (error) {
    // Nikdy obsah zvuku ani prepisu v logu.
    console.error("Prepis hlasu zlyhal:", error instanceof Error ? error.message : error);
    return null;
  }
}
