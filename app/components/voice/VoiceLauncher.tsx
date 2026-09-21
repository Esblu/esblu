"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { useVoiceCapture } from "@/hooks/use-voice-capture";
import { IntentResultView } from "@/app/components/voice/IntentResultView";
import { docButtonSecondary } from "@/app/components/document/DocumentLayout";
import { CloseIcon } from "@/app/components/icons/AppIcons";
import type { IntentResult } from "@/lib/intents/types";

// =============================================================================
// Globálny hlasový launcher.
//
// PREČO NIE ĎALŠIE PLÁVAJÚCE TLAČIDLO
// -----------------------------------
// Appka už jedno má — bublinku chatu, ktorá je `position: fixed`, na
// z-indexe 70 a používateľ si ju môže pretiahnuť kamkoľvek. Druhý plávajúci
// prvok by sa s ňou skôr či neskôr prekryl, nech by som ho umiestnil
// kamkoľvek. Preto je launcher súčasťou TOKU stránky: sedí v hlavičke
// spoločnej stránkovej schránky, takže s ničím plávajúcim kolidovať nemôže.
//
// Na Dashboarde sa nevykresľuje — tam je vstupným bodom vyhľadávacie pole
// s mikrofónom, ktoré robí presne to isté. Dva ovládače na jednej obrazovke
// by boli mätúce.
//
// PREČO NEOBCHÁDZA OPRÁVNENIA
// ---------------------------
// Prepis sa posiela na /api/assistant/intent ako obyčajný text — ten istý
// endpoint, ktorý obsluhuje písaný vstup. Server si sám odvodí firmu aj
// rolu z tokenu a všetko ďalej beží cez user-scoped klienta a RLS. Hlas
// tu nemá vlastnú cestu k dátam ani vlastný zoznam povolených akcií.
// =============================================================================

type Phase =
  | "idle"
  | "listening"
  | "transcribing"
  | "recognising"
  | "awaitingConfirmation"
  | "done"
  | "denied";

export function VoiceLauncher() {
  const { t, locale } = useLocale();

  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [intentResult, setIntentResult] = useState<IntentResult | null>(null);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");

  const { voiceState, voiceError, handleMicButtonClick, cancelVoiceRecording } =
    useVoiceCapture({
      onTranscript: (text) => {
        setTranscript(text);
        void runIntent(text);
      },
    });

  /** Prepis -> intent. Presne tá istá cesta ako pri písanom vstupe. */
  async function runIntent(text: string) {
    setPhase("recognising");
    setIntentResult(null);
    setMessage("");

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      setPhase("denied");
      setMessage(t("search.voice.states.denied"));
      return;
    }

    try {
      const response = await fetch(apiUrl("/api/assistant/intent"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
          [REQUEST_LOCALE_HEADER]: locale,
        },
        body: JSON.stringify({ text }),
      });

      const data = await response.json();

      // 403 znamená, že server rolu odmietol. Používateľovi sa ukáže
      // zrozumiteľná veta, nie stavový kód ani telo odpovede.
      if (response.status === 403 || response.status === 401) {
        setPhase("denied");
        setMessage(t("search.voice.states.denied"));
        return;
      }

      if (response.ok && data.success && data.recognized) {
        const result = data.result as IntentResult;
        setIntentResult(result);
        setPhase(result.kind === "action_preview" ? "awaitingConfirmation" : "done");
        return;
      }

      setPhase("done");
      setMessage(t("search.errors.commandNotUnderstood"));
    } catch (error) {
      // Nikdy nevypisujeme technický detail do rozhrania.
      console.error("VoiceLauncher: rozpoznanie príkazu zlyhalo:", error);
      setPhase("done");
      setMessage(t("search.errors.generic"));
    }
  }

  /**
   * Potvrdenie rizikovej akcie. Na server ide VÝHRADNE confirmationId —
   * žiadny intent ani argumenty, aby sa cestou nedalo nič podstrčiť.
   */
  async function handleConfirm() {
    if (!intentResult || intentResult.kind !== "action_preview") return;
    if (!intentResult.confirmationId) return;

    setActionSubmitting(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      setActionSubmitting(false);
      setPhase("denied");
      setMessage(t("search.voice.states.denied"));
      return;
    }

    try {
      const response = await fetch(apiUrl("/api/assistant/action/execute"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
          [REQUEST_LOCALE_HEADER]: locale,
        },
        body: JSON.stringify({ confirmationId: intentResult.confirmationId }),
      });

      const data = await response.json();
      setIntentResult((data?.result as IntentResult) ?? null);
      setPhase("done");
    } catch (error) {
      console.error("VoiceLauncher: vykonanie akcie zlyhalo:", error);
      setPhase("done");
      setMessage(t("search.errors.generic"));
    } finally {
      setActionSubmitting(false);
    }
  }

  function handleCancel() {
    setIntentResult(null);
    setPhase("idle");
    setMessage("");
  }

  function closePanel() {
    if (voiceState === "recording") cancelVoiceRecording();
    setOpen(false);
    setTranscript("");
    setIntentResult(null);
    setPhase("idle");
    setMessage("");
  }

  // Jedna veta o tom, čo sa práve deje. Žiadne technické výpisy.
  const statusText =
    voiceState === "recording"
      ? t("search.voice.states.listening")
      : voiceState === "processing"
        ? t("search.voice.states.transcribing")
        : phase === "recognising"
          ? t("search.voice.states.recognising")
          : phase === "awaitingConfirmation"
            ? t("search.voice.states.awaitingConfirmation")
            : phase === "denied"
              ? t("search.voice.states.denied")
              : "";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${docButtonSecondary} gap-2`}
      >
        <MicGlyph />
        {t("search.voice.launcher")}
      </button>
    );
  }

  return (
    <section
      aria-label={t("search.voice.launcher")}
      className="rounded-doc border border-doc-border bg-doc-surface p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleMicButtonClick}
          disabled={voiceState === "processing"}
          aria-pressed={voiceState === "recording"}
          className={`${docButtonSecondary} gap-2 ${
            voiceState === "recording" ? "border-danger/40 text-danger" : ""
          }`}
        >
          <MicGlyph />
          {voiceState === "recording"
            ? t("search.voice.stop")
            : t("search.voice.start")}
        </button>

        <span aria-live="polite" className="min-w-0 flex-1 text-sm text-secondary">
          {statusText || t("search.voice.hint")}
        </span>

        <button
          type="button"
          onClick={closePanel}
          aria-label={t("common.buttons.close")}
          className={`${docButtonSecondary} px-2.5`}
        >
          <CloseIcon size={16} />
        </button>
      </div>

      {voiceError && (
        <p className="mt-2 text-sm text-danger">{voiceError}</p>
      )}

      {transcript && (
        <p className="mt-2 truncate text-sm text-muted-esblu">
          {t("search.voice.transcriptPrefix")} „{transcript}“
        </p>
      )}

      {message && <p className="mt-2 text-sm text-secondary">{message}</p>}

      {intentResult && (
        <div className="mt-3">
          <IntentResultView
            intentResult={intentResult}
            actionSubmitting={actionSubmitting}
            onConfirm={handleConfirm}
            onCancel={handleCancel}
          />
        </div>
      )}
    </section>
  );
}

/** Mikrofón. Vlastný glyf, aby launcher nezávisel na ikone chatu. */
function MicGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}
