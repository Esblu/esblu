"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { MAX_RECORDING_SECONDS } from "@/lib/voice-config";

// =============================================================================
// useVoiceCapture — zachytenie hlasu a jeho prepis.
//
// PREČO HOOK
// ----------
// Táto logika žila 250 riadkov priamo v Dashboarde, takže mikrofón
// existoval na jedinej obrazovke v celej appke. Obsahuje pritom netriviálne
// ochrany, ktoré sa nedajú prepísať po pamäti: session ID proti prekrývajúcim
// sa nahrávkam, 20-sekundový strop, 4-sekundový race na `stop` event a
// vyčistenie streamu pri odmontovaní. Preto je presunutá BEZO ZMENY
// SPRÁVANIA, nie napísaná nanovo.
//
// ČO HOOK NEROBÍ
// --------------
// Nerozpoznáva príkazy a nič nevykonáva. Vráti text a tým končí. O to, čo
// sa s textom stane, sa stará volajúci — v praxi ten istý Intent Engine
// reťazec, aký spracúva písaný vstup. Vďaka tomu hlas nemá vlastnú
// autorizačnú cestu a nemôže obísť oprávnenia.
// =============================================================================

export type VoiceState = "idle" | "recording" | "processing" | "error";

export function useVoiceCapture({
  onTranscript,
}: {
  /** Zavolá sa s hotovým prepisom. Volajúci rozhodne, čo s ním. */
  onTranscript: (text: string) => void;
}) {
  const { t, locale } = useLocale();

  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingSessionIdRef = useRef(0);

  // Odmontovanie komponentu musí zastaviť mikrofón — inak zostane v
  // prehliadači svietiť indikátor nahrávania nad zavretou obrazovkou.
  useEffect(() => {
    return () => {
      recordingSessionIdRef.current += 1;
      if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stream.getTracks().forEach((track) => track.stop());
        recorder.stop();
      }
    };
  }, []);

  // -----------------------------------------------------------------------------
  // Hlasové vyhľadávanie (zadanie, sekcia B/C/D/E/G) — READ-ONLY: VOICE →
  // audio → prepis (server) → PRESNE TEN ISTÝ text ako pri písaní → ten
  // istý debounced Intent Engine efekt vyššie. Žiadny nový parser, žiadny
  // nový handler, žiadne automatické spúšťanie akcie bez spoľahlivého
  // prepisu.
  //
  // Web API (getUserMedia/MediaRecorder) — funguje rovnako na desktop webe
  // aj mobile browseri; v Android Capacitor WebView appke (mobile/) funguje
  // BEZO ZMENY vďaka tomu, že mobile/app/* sú čisté re-exporty root app/*
  // (pozri mobile/tsconfig.json `"@/*": ["../*"]`) — jediná potrebná
  // natívna zmena je android.permission.RECORD_AUDIO v AndroidManifest.xml.
  // -----------------------------------------------------------------------------

  function stopMediaRecorderTracks(recorder: MediaRecorder) {
    recorder.stream.getTracks().forEach((track) => track.stop());
  }

  // Spoločné vyčistenie refs pre KAŽDÉ ukončenie nahrávky (manuálny stop,
  // cancel, timeout, unmount) — jedno miesto namiesto duplicitnej logiky na
  // 4 rôznych miestach, aby sa nemohlo stať, že niektorá cesta vynechá
  // clearTimeout()/vynulovanie refs.
  function resetVoiceRecordingRefs() {
    // Zvýšenie ID okamžite zneplatní AKÝKOĽVEK inak naplánovaný 20s
    // časovač patriaci tejto (teraz končiacej) nahrávke — aj v
    // hypotetickom prípade, že by nižšie clearTimeout() z nejakého dôvodu
    // nezasiahol správny timer (runtime bug fix z predchádzajúceho auditu:
    // "osirelý" časovač z prekrývajúcej sa nahrávky nesmie zasiahnuť
    // novšiu, aj krátku, nahrávku).
    recordingSessionIdRef.current += 1;
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    audioChunksRef.current = [];
    mediaRecorderRef.current = null;
  }

  async function startVoiceRecording() {
    setVoiceError(null);

    if (
      typeof window === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setVoiceState("error");
      setVoiceError(t("search.voice.errors.notSupported"));
      return;
    }

    // Ak by tu z nejakého dôvodu ešte "visela" predchádzajúca
    // nahrávka/časovač (napr. rýchly dvojklik na mikrofón, kým prehliadač
    // ešte čakal na povolenie mikrofónu pre PRVÝ klik), táto nová nahrávka
    // ju najprv čisto ukončí.
    if (mediaRecorderRef.current || recordingTimeoutRef.current) {
      resetVoiceRecordingRefs();
    }

    // Každá nahrávka dostane VLASTNÉ ID — 20s časovač aj pokračovanie po
    // getUserMedia si ho uzavrú v closure a pred akoukoľvek zmenou stavu
    // overia, že toto ID je STÁLE aktuálne.
    const sessionId = ++recordingSessionIdRef.current;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Medzičasom (kým prehliadač čakal na povolenie mikrofónu) mohol
      // používateľ túto nahrávku stihnúť zrušiť alebo spustiť inú novšiu —
      // ak toto ID už nie je aktuálne, táto oneskorená vetva sa potichu
      // vzdá namiesto toho, aby prevzala kontrolu nad stavom novšej
      // nahrávky.
      if (recordingSessionIdRef.current !== sessionId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const preferredMimeType = ["audio/webm", "audio/mp4", "audio/ogg"].find(
        (type) =>
          typeof MediaRecorder.isTypeSupported === "function" &&
          MediaRecorder.isTypeSupported(type)
      );
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);

      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setVoiceState("recording");

      // Klientska poistka pre max dĺžku nahrávky (bod D zadania) — po
      // uplynutí limitu appka záznam ZAHODÍ (neposiela na prepis) a ukáže
      // jasnú chybu, namiesto tichého odoslania orezanej nahrávky.
      recordingTimeoutRef.current = setTimeout(() => {
        if (recordingSessionIdRef.current !== sessionId) return;
        handleRecordingTooLong();
      }, MAX_RECORDING_SECONDS * 1000);
    } catch (error) {
      if (recordingSessionIdRef.current === sessionId) {
        console.error("Nahrávanie hlasu zlyhalo:", error instanceof Error ? error.message : error);
        setVoiceState("error");
        setVoiceError(t("search.voice.errors.micNotAllowed"));
      }
    }
  }

  function handleRecordingTooLong() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = () => stopMediaRecorderTracks(recorder);
      recorder.stop();
    }
    resetVoiceRecordingRefs();
    setVoiceState("error");
    setVoiceError(t("search.voice.errors.recordingTooLong"));
  }

  function cancelVoiceRecording() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      // Zrušenie zámerne NEPOSIELA žiadny transkript — iba zastaví
      // nahrávanie a zahodí zvuk (bod C zadania: "umožni stop/cancel").
      recorder.onstop = () => stopMediaRecorderTracks(recorder);
      recorder.stop();
    }
    resetVoiceRecordingRefs();
    setVoiceState("idle");
  }

  async function stopVoiceRecording() {
    // Timer sa ruší HNEĎ na začiatku, PRED čímkoľvek iným — a session ID sa
    // zvyšuje zároveň, takže aj v hypotetickom prípade, že by clearTimeout()
    // z nejakého dôvodu nestihol/nezasiahol správny timer, samotný 20s
    // callback (pozri startVoiceRecording) by sa aj tak sám odmietol
    // spustiť, lebo by už nesedelo jeho zachytené ID.
    recordingSessionIdRef.current += 1;
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    setVoiceState("processing");

    // Celý zvyšok tejto funkcie beží v try/catch — ak by `recorder.stop()`
    // alebo čakanie na "stop" event vyhodilo výnimku, appka nesmie zostať
    // "zamrznutá" v stave "processing" bez viditeľnej chyby.
    try {
      // Na časti reálnych mobilných prehliadačov (najmä staršie Android
      // WebView) sa stáva, že MediaRecorder po stop() nikdy nevyšle "stop"
      // event (napr. keď OS medzitým ukončí audio stream na pozadí). Bez
      // časového limitu by appka na tento event čakala navždy — preto sa
      // čaká maximálne 4s (nesúvisí s 20s max-recording-duration limitom
      // vyššie), potom sa pokračuje s chunkami, ktoré už prišli cez
      // ondataavailable.
      const stopped = new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
      });
      recorder.stop();
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => setTimeout(resolve, 4000)),
      ]);
      stopMediaRecorderTracks(recorder);

      const mimeType = recorder.mimeType || "audio/webm";
      const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
      audioChunksRef.current = [];
      mediaRecorderRef.current = null;

      if (audioBlob.size === 0) {
        setVoiceState("error");
        setVoiceError(t("search.voice.errors.noAudio"));
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        setVoiceState("error");
        setVoiceError(t("search.voice.errors.transcriptionFailed"));
        return;
      }

      const extension = mimeType.includes("mp4")
        ? "mp4"
        : mimeType.includes("ogg")
          ? "ogg"
          : mimeType.includes("wav")
            ? "wav"
            : "webm";
      const voiceFormData = new FormData();
      voiceFormData.append("audio", audioBlob, `voice-command.${extension}`);

      const response = await fetch(apiUrl("/api/assistant/transcribe"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          [REQUEST_LOCALE_HEADER]: locale,
        },
        body: voiceFormData,
      });

      // `.json()` môže zlyhať, ak server vráti neočakávané telo (napr.
      // platformová HTML chybová stránka pri 5xx).
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.success || typeof data.text !== "string" || !data.text) {
        setVoiceState("error");
        setVoiceError(
          typeof data?.error === "string"
            ? data.error
            : t("search.voice.errors.transcriptionFailed")
        );
        return;
      }

      // Prepis odovzdáme volajúcemu a tým sa úloha hooku končí. V praxi
      // ho volajúci vloží do toho istého textového poľa, do ktorého sa
      // píše — takže prejde tým istým Intent Engine reťazcom a používateľ
      // ho pred spustením akcie ešte vidí a môže opraviť.
      onTranscript(data.text);

      setVoiceState("idle");
    } catch (error) {
      // Production-safe error log — NIKDY audio obsah ani transcript text.
      console.error(
        "Prepis hlasu zlyhal:",
        error instanceof Error ? error.message : error
      );
      setVoiceState("error");
      setVoiceError(t("search.voice.errors.transcriptionFailed"));
    }
  }

  function handleMicButtonClick() {
    if (voiceState === "recording") {
      stopVoiceRecording();
    } else if (voiceState === "idle" || voiceState === "error") {
      startVoiceRecording();
    }
  }

  return {
    voiceState,
    voiceError,
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    handleMicButtonClick,
  };
}
