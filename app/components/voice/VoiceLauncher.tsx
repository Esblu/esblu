"use client";

import { useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { useVoiceCapture } from "@/hooks/use-voice-capture";
import { todayLocalDate } from "@/lib/local-date";
import type { UiContext } from "@/lib/intents/ui-context";
import { IntentResultView } from "@/app/components/voice/IntentResultView";
import {
  docButtonSecondary,
  docButtonPrimary,
  docField,
  docLabel,
} from "@/app/components/document/DocumentLayout";
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
//
// VIACKROKOVÝ DIALÓG (Phase 2)
// ----------------------------
// Keď príkazu chýba údaj, server namiesto odmietnutia vráti otázku a
// `conversationId`. Ten sa pošle späť pri ďalšej odpovedi. Je to OPAQUE
// identifikátor, nie oprávnenie: server pri ňom vždy overuje aj totožnosť
// volajúceho a jeho aktívnu firmu, takže cudzí (ani vymyslený)
// identifikátor neodomkne nič.
//
// Odpovedať sa dá hlasom aj klávesnicou. Nie z pohodlnosti — diktovanie
// mena partnera je presne ten prípad, kde sa prepis mýli najčastejšie, a
// používateľ musí mať možnosť ho napísať bez toho, aby začínal odznova.
// =============================================================================

// =============================================================================
// TYPOGRAFIA PANELA — JEDNA MIERKA PRE VŠETKY STAVY
//
// Na mobile sa text panela po odpovedi zmenšil. Nebolo to naschvál a ani
// to nebolo „prispôsobenie dlhšiemu obsahu": jednotlivé stavy boli písané
// v rôznom čase a každý si niesol vlastnú veľkosť — otázka `text-sm`,
// odpoveď a poznámky `text-xs`, štítky ešte menej. Pri prechode medzi
// stavmi to vyzeralo, akoby rozhranie zmenšovalo písmo, aby sa obsah
// zmestil.
//
// Veľkosť písma preto NEZÁVISÍ od stavu. Panel smie rásť do výšky, text sa
// smie zalamovať, ale zmenšovať sa nesmie. Žiadny `scale()`, žiadny zoom,
// žiadny `text-xs` ako únik pri dlhšom obsahu.
// =============================================================================

/** Obsah, ktorý používateľ číta: stav, prepis, otázka, odpoveď, položky. */
const VOICE_TEXT = "text-sm leading-relaxed";

/** Vedľajší popis (čo je otvorené). Stále čitateľný, nie drobné písmo. */
const VOICE_META = "text-sm leading-relaxed";

/**
 * Fázy dialógu. Používateľ musí v každom okamihu vedieť, čo sa deje —
 * preto má každá fáza vlastnú vetu, nie jeden univerzálny "pracujem…".
 */
type Phase =
  | "idle"
  | "listening"
  | "transcribing"
  | "understanding"
  | "clarification"
  | "awaitingConfirmation"
  | "review"
  | "complete"
  | "denied"
  | "failed";

export function VoiceLauncher({ uiContext = null }: { uiContext?: UiContext | null } = {}) {
  const { t, locale } = useLocale();

  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [intentResult, setIntentResult] = useState<IntentResult | null>(null);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");

  // Prebiehajúci dialóg. V ref, nie v state — hodnota sa musí dať prečítať
  // v callbacku hneď po jej nastavení, bez čakania na prekreslenie.
  const conversationIdRef = useRef<string>(newConversationId());
  const [clarifyAnswer, setClarifyAnswer] = useState("");

  const { voiceState, voiceError, handleMicButtonClick, cancelVoiceRecording } =
    useVoiceCapture({
      onTranscript: (text) => {
        setTranscript(text);
        void runIntent(text);
      },
    });

  /** Prepis alebo napísaný text -> intent. Presne tá istá cesta. */
  async function runIntent(
    text: string,
    structuredAnswer?: { type: "partner_selection"; partnerId: string }
  ) {
    setPhase("understanding");
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
        // `localDate` je kalendárny deň PREHLIADAČA. Server beží v UTC a
        // sám by o polnoci stredoeurópskeho času založil doklad s včerajším
        // dátumom. Server si hodnotu overí a ohraničí (lib/local-date.ts),
        // takže ju neprijíma naslepo.
        // `uiContext` hovorí, ČO MÁ POUŽÍVATEĽ OTVORENÉ — modul, typ entity
        // a jej identifikátor, nič viac. Žiadny obsah dokumentu, žiadny
        // text z OCR. Server si entitu aj tak overí znova a firmu ani rolu
        // z klienta neberie.
        // `answer` nesie ŠTRUKTÚROVANÝ výber (ťuknutie na tlačidlo
        // partnera). Predtým niesol význam iba zobrazený text a ten sa
        // musel spätne rozpoznávať — práve tak sa výber partnera dal
        // zameniť za inú odpoveď. Server identifikátor aj tak overuje.
        body: JSON.stringify({
          text,
          conversationId: conversationIdRef.current,
          localDate: todayLocalDate(),
          ...(uiContext ? { uiContext } : {}),
          ...(structuredAnswer ? { answer: structuredAnswer } : {}),
        }),
      });

      const data = await response.json();

      // 401/403 znamená, že server rolu odmietol. Používateľovi sa ukáže
      // zrozumiteľná veta, nie stavový kód ani telo odpovede.
      if (response.status === 403 || response.status === 401) {
        setPhase("denied");
        setMessage(t("search.voice.states.denied"));
        return;
      }

      if (response.ok && data.success && data.recognized) {
        const result = data.result as IntentResult;
        setIntentResult(result);
        setClarifyAnswer("");

        if (result.kind === "clarify") setPhase("clarification");
        else if (result.kind === "action_preview") setPhase("awaitingConfirmation");
        else if (result.kind === "draft_created") setPhase("review");
        else if (result.kind === "error") setPhase("failed");
        else setPhase("complete");
        return;
      }

      setPhase("complete");
      setMessage(t("search.errors.commandNotUnderstood"));
    } catch (error) {
      // Nikdy nevypisujeme technický detail do rozhrania.
      console.error("VoiceLauncher: rozpoznanie príkazu zlyhalo:", error);
      setPhase("failed");
      setMessage(t("search.errors.generic"));
    }
  }

  /** Odpoveď na otázku asistenta — písaná alebo vybraná zo zoznamu. */
  function submitClarifyAnswer(
    value: string,
    structuredAnswer?: { type: "partner_selection"; partnerId: string }
  ) {
    const answer = value.trim();
    if (!answer) return;
    setTranscript(answer);
    void runIntent(answer, structuredAnswer);
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
      setPhase("complete");
    } catch (error) {
      console.error("VoiceLauncher: vykonanie akcie zlyhalo:", error);
      setPhase("failed");
      setMessage(t("search.errors.generic"));
    } finally {
      setActionSubmitting(false);
    }
  }

  function handleCancel() {
    resetDialog();
  }

  /**
   * Zrušenie dialógu si vždy vypýta NOVÝ identifikátor. Bez toho by ďalší
   * príkaz pokračoval v rozpracovanom dialógu, ktorý používateľ práve
   * zavrel — a dostal by otázku na niečo, čo už nechce.
   */
  function resetDialog() {
    conversationIdRef.current = newConversationId();
    setIntentResult(null);
    setClarifyAnswer("");
    setPhase("idle");
    setMessage("");
  }

  function closePanel() {
    if (voiceState === "recording") cancelVoiceRecording();
    setOpen(false);
    setTranscript("");
    resetDialog();
  }

  // Označenie otvorenej entity. ZÁMERNE sa nezobrazuje identifikátor —
  // používateľovi nič nepovie a v rozhraní vyzerá ako chyba. Klient pozná
  // iba typ, takže ukáže názov typu; presné označenie (napr. názov súboru)
  // pozná až server a použije ho vo svojich odpovediach.
  const contextLabel = uiContext
    ? t(`search.voice.context.entityType.${uiContext.entityType}`)
    : "";

  // Jedna veta o tom, čo sa práve deje. Žiadne technické výpisy.
  const statusText =
    voiceState === "recording"
      ? t("search.voice.states.listening")
      : voiceState === "processing"
        ? t("search.voice.states.transcribing")
        : phase === "understanding"
          ? t("search.voice.states.understanding")
          : phase === "clarification"
            ? t("search.voice.states.clarification")
            : phase === "awaitingConfirmation"
              ? t("search.voice.states.awaitingConfirmation")
              : phase === "review"
                ? t("search.voice.states.review")
                : phase === "complete"
                  ? t("search.voice.states.complete")
                  : phase === "denied"
                    ? t("search.voice.states.denied")
                    : phase === "failed"
                      ? t("search.voice.states.failed")
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

  const clarify = intentResult?.kind === "clarify" ? intentResult : null;

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

        <span aria-live="polite" className={`min-w-0 flex-1 ${VOICE_TEXT} text-secondary`}>
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

      {/* Čo je otvorené. Bez toho by používateľ nevedel, na čo sa „tento"
          vzťahuje — a keď nie je otvorené nič, appka to netvrdí. */}
      {contextLabel && (
        <p className={`mt-2 ${VOICE_META} text-muted-esblu`}>
          {t("search.voice.context.workingWith")} {contextLabel}
        </p>
      )}

      {voiceError && <p className={`mt-2 ${VOICE_TEXT} text-danger`}>{voiceError}</p>}

      {transcript && (
        <p className={`mt-2 break-words ${VOICE_TEXT} text-muted-esblu`}>
          {t("search.voice.transcriptPrefix")} „{transcript}“
        </p>
      )}

      {message && <p className={`mt-2 break-words ${VOICE_TEXT} text-secondary`}>{message}</p>}

      {/* Otázka asistenta. Odpovedať sa dá hlasom (tlačidlo vyššie) aj
          písmom — meno partnera je presne to, čo prepis reči najčastejšie
          skomolí. */}
      {clarify && (
        <div className="mt-3 rounded-doc border border-doc-border bg-surface-2 p-3">
          <p className={`break-words ${VOICE_TEXT} font-medium text-primary`}>{clarify.question}</p>

          {clarify.choices && clarify.choices.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {clarify.choices.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() =>
                    submitClarifyAnswer(choice.label, {
                      type: "partner_selection",
                      partnerId: choice.value,
                    })
                  }
                  className={`${docButtonSecondary} ${VOICE_TEXT} min-h-11 max-w-full whitespace-normal text-left`}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}

          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitClarifyAnswer(clarifyAnswer);
            }}
          >
            <div className="min-w-0 flex-1">
              <label className={docLabel} htmlFor="esblu-voice-answer">
                {t("search.voice.answerLabel")}
              </label>
              <input
                id="esblu-voice-answer"
                className={`${docField} ${VOICE_TEXT} min-h-11`}
                value={clarifyAnswer}
                onChange={(event) => setClarifyAnswer(event.target.value)}
                placeholder={t("search.voice.answerPlaceholder")}
                autoComplete="off"
              />
            </div>
            <button
              type="submit"
              className={`${docButtonPrimary} ${VOICE_TEXT} min-h-11`}
              disabled={!clarifyAnswer.trim()}
            >
              {t("search.voice.answerSend")}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className={`${docButtonSecondary} ${VOICE_TEXT} min-h-11`}
            >
              {t("common.buttons.cancel")}
            </button>
          </form>
        </div>
      )}

      {intentResult && intentResult.kind !== "clarify" && (
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

/**
 * Náhodný identifikátor dialógu.
 *
 * Tvar (32 hex znakov) musí sedieť s CHECK-om v databáze. `crypto` je
 * dostupné vo všetkých prehliadačoch, ktoré appka podporuje; fallback
 * existuje len preto, aby komponent nespadol v prostredí bez neho —
 * identifikátor nie je tajomstvo ani oprávnenie, takže slabší zdroj
 * náhody tu nič neohrozuje.
 */
function newConversationId(): string {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
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
