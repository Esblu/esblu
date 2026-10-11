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
  watchdogMsFor,
  type StopReason,
  type TranscribeFailureKind,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceSessionState,
} from "@/lib/voice/voice-session";
import { ASSISTANT_TIMEOUTS, fetchJsonWithTimeout } from "@/lib/voice/assistant-http";
import { canOpenMicSettings, haptic, openMicSettings } from "@/lib/voice/device-feedback";
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

/** Dve ťuknutia rýchlejšie než toto = jedno (dvojklik nesmie štart hneď zastaviť). */
export const TAP_DEBOUNCE_MS = 450;

/**
 * Udalosť, ktorou natívny most (mobile/app/AppLifecycleBridge.tsx) hlási
 * prechod appky do pozadia/popredia. Capacitor appStateChange je na Androide
 * spoľahlivejší než visibilitychange vo WebView.
 */
export const APP_STATE_EVENT = "esblu:app-state";

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
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapRef = useRef(0);
  const [settingsAvailable, setSettingsAvailable] = useState(false);
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
            // Neskoro dokončená nahrávka zastaveného/staršieho kola sa
            // neuloží — audio nesmie ostať visieť v pamäti bez použitia.
            if (stateRef.current.gen !== gen || stateRef.current.status !== "listening") return;
            blobRef.current = { blob: outcome.blob, mimeType: outcome.mimeType };
            dispatch({ type: "UTTERANCE_CAPTURED", gen });
          } else if (outcome.kind === "no_speech") dispatch({ type: "NO_SPEECH", gen });
          else if (outcome.kind === "too_long") dispatch({ type: "CAPTURE_FAILED", tooLong: true, gen });
          else if (outcome.kind === "error") dispatch({ type: "CAPTURE_FAILED", gen });
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
        transcribeAbortRef.current?.abort();
        const controller = new AbortController();
        transcribeAbortRef.current = controller;
        void transcribe(captured, latest.current.locale, latest.current.getTranscriptionContext?.() ?? null, controller.signal).then((outcome) => {
          if (transcribeAbortRef.current === controller) transcribeAbortRef.current = null;
          if (!outcome.ok) {
            if (outcome.kind !== "cancelled") dispatch({ type: "TRANSCRIBE_FAILED", kind: outcome.kind, gen });
            return;
          }
          const text = outcome.text;
          recordVoiceDiagnostic({ kind: "transcript", name: "ok", gen });
          latest.current.onTranscript?.(text);
          dispatch({ type: "TRANSCRIPT", text, gen });
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
          .catch((error: unknown) => {
            recordVoiceDiagnostic({ kind: "turn", name: "failed", gen });
            // Volajúci hádže Error("intent_<kind>") (VoiceLauncher) — iba typ, nikdy text.
            const message = error instanceof Error ? error.message : "";
            const kind = message === "intent_offline" ? "offline" : message === "intent_unavailable" ? "unavailable" : undefined;
            dispatch({ type: "TURN_FAILED", kind, gen });
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
      const previous = stateRef.current;
      const { state, effects } = voiceSessionReducer(previous, event);
      if (state === previous && effects.length === 0) return; // ignorované (oneskorené) dokončenie
      stateRef.current = state;
      setSession(state);
      recordVoiceDiagnostic({ kind: "state", name: state.status, gen: state.gen });

      // Strážny časovač: každý prechod ho zruší; stavy, ktoré čakajú na
      // mikrofón/prepis/server, dostanú nový. Nesie generáciu → neskorý
      // časovač staršieho kola automat ignoruje.
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
      const limit = watchdogMsFor(state.status);
      if (limit !== null) {
        const gen = state.gen;
        watchdogRef.current = setTimeout(() => dispatchRef.current({ type: "WATCHDOG", gen }), limit);
      }

      // Opustený prepis (stop, timeout, pozadie) → zrušiť upload, nech
      // zbytočne nebeží a jeho výsledok nič nespustí.
      if (state.status !== "transcribing" && transcribeAbortRef.current) {
        transcribeAbortRef.current.abort();
        transcribeAbortRef.current = null;
      }

      // Haptika: mikrofón začal počúvať (prvé kolo), relácia skončila, chyba.
      if (state.status === "listening" && previous.status === "starting" && state.turn === 0) haptic("start");
      else if (state.status === "stopped" && isSessionActive(previous.status)) haptic("stop");
      else if (state.status === "error" && previous.status !== "error") haptic("error");

      effects.forEach((effect) => runEffect(effect, state.gen));
      if (!isSessionActive(state.status)) {
        // Koniec relácie: AudioContext preč až po efektoch (reč oznámenia smie dobehnúť).
        micRef.current?.close();
        micRef.current = null;
        // Žiadne audio nesmie prežiť reláciu (ani neodoslaný blob).
        blobRef.current = null;
      }
    };
  }, [runEffect]);

  /** Ťuknutie na mikrofón (štart / ukončenie / prerušenie Esblu). */
  const tap = useCallback(() => {
    // Dvojité ťuknutie (alebo „ghost click" po touchend) nesmie reláciu
    // spustiť a hneď zastaviť, ani spustiť dve nahrávania.
    const now = Date.now();
    if (now - lastTapRef.current < TAP_DEBOUNCE_MS) return;
    lastTapRef.current = now;
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
    // Natívna appka do pozadia / zamknutie obrazovky / prerušenie systémom
    // (hovor). visibilitychange vo WebView nemusí prísť vždy.
    const onAppState = (event: Event) => {
      const active = (event as CustomEvent<{ isActive?: boolean }>).detail?.isActive;
      if (active === false) dispatchRef.current({ type: "STOP", reason: "hidden" });
      else if (active === true) dispatchRef.current({ type: "CLEAR_MIC_ERROR" });
    };
    // Page Lifecycle API: zmrazená stránka (Chrome/Android) = pozadie.
    const onFreeze = () => dispatchRef.current({ type: "STOP", reason: "hidden" });
    document.addEventListener("visibilitychange", onHidden);
    document.addEventListener("freeze", onFreeze);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("offline", onOffline);
    window.addEventListener(APP_STATE_EVENT, onAppState);
    const { data: auth } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") dispatchRef.current({ type: "STOP", reason: "session_end" });
    });
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("freeze", onFreeze);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener(APP_STATE_EVENT, onAppState);
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
      transcribeAbortRef.current?.abort();
      transcribeAbortRef.current = null;
      auth.subscription.unsubscribe();
      // Odmontovanie (navigácia v appke) = koniec relácie a uvoľnený mikrofón.
      dispatchRef.current({ type: "STOP", reason: "navigation" });
      speechAbortRef.current?.abort();
      micRef.current?.close();
      micRef.current = null;
    };
  }, []);

  // „Otvoriť nastavenia" pri odmietnutom/zablokovanom mikrofóne, iba tam,
  // kde to platforma vie (natívna appka). Android po 2. odmietnutí výzvu už
  // nezobrazí a WebView trvalé zablokovanie spoľahlivo nehlási (časová
  // heuristika v mic-errors.ts) → aj pri „denied" ponúknuť cestu do Settings.
  const micBlocked = session.status === "error" && (session.micFailure === "blocked" || session.micFailure === "denied");
  useEffect(() => {
    if (!micBlocked) return;
    let cancelled = false;
    void canOpenMicSettings().then((value) => {
      if (!cancelled) setSettingsAvailable(value);
    });
    return () => {
      cancelled = true;
    };
  }, [micBlocked]);

  const openSettings = useCallback(() => {
    void openMicSettings();
  }, []);

  return {
    session,
    active: isSessionActive(session.status),
    tap,
    stop,
    manualTurn,
    /** Mikrofón je trvalo zablokovaný a dá sa otvoriť systémové nastavenie. */
    canOpenSettings: micBlocked && settingsAvailable,
    openSettings,
  };
}

/** Výsledok prepisu — chyba nesie typ, aby relácia vedela, čo povedať. */
type TranscribeOutcome = { ok: true; text: string } | { ok: false; kind: TranscribeFailureKind | "cancelled" };

/**
 * Prepis jednej vety — ten istý endpoint a limity ako jednorazový mikrofón.
 * Časový limit + zrušenie (stop relácie) cez AbortSignal. Zvuk ani prepis sa
 * nikdy nelogujú; blob žije iba v pamäti do odoslania (žiadny súbor, žiadna
 * object URL).
 */
async function transcribe(
  captured: { blob: Blob; mimeType: string },
  locale: string,
  context: TranscriptionContext | null,
  signal: AbortSignal
): Promise<TranscribeOutcome> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthenticated" };
  const mime = captured.mimeType;
  const extension = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("audio", captured.blob, `voice-command.${extension}`);
  if (context) form.append("context", context);
  const result = await fetchJsonWithTimeout<{ success?: boolean; text?: unknown }>(
    apiUrl("/api/assistant/transcribe"),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, [REQUEST_LOCALE_HEADER]: locale },
      body: form,
    },
    { timeoutMs: ASSISTANT_TIMEOUTS.transcribeMs, signal }
  );
  if (!result.ok) {
    switch (result.kind) {
      case "cancelled":
      case "offline":
      case "timeout":
      case "unauthenticated":
      case "forbidden":
      case "too_large":
        return { ok: false, kind: result.kind };
      case "rate_limited":
      case "unavailable":
        return { ok: false, kind: result.kind };
      case "server":
        return { ok: false, kind: "server" };
      case "bad_request":
        return { ok: false, kind: "empty" };
      default:
        return { ok: false, kind: "network" };
    }
  }
  const text = result.data?.success && typeof result.data.text === "string" ? result.data.text.trim() : "";
  return text ? { ok: true, text } : { ok: false, kind: "empty" };
}
