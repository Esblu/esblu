"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";
import { isSessionActive, type VoiceSessionState } from "@/lib/voice/voice-session";

// =============================================================================
// Ovládanie súvislého hlasového režimu — zdieľané Nástenkou aj launcherom.
//
// Používateľ vždy vidí, čo Esblu robí („Počúvam…", „Spracúvam…", „Esblu
// odpovedá…") a má jasný spôsob, ako hlas ukončiť. Počas reči Esblu ťuknutie
// na mikrofón Esblu preruší a hneď počúva (úmyselný barge-in); samostatné
// tlačidlo reláciu ukončí.
// =============================================================================

export function voiceSessionStatusText(t: (key: string) => string, session: VoiceSessionState): string {
  switch (session.status) {
    case "starting":
      return session.turn === 0 ? t("search.voice.session.starting") : t("search.voice.session.listening");
    case "listening":
      return t("search.voice.session.listening");
    case "transcribing":
    case "waiting_server":
      return t("search.voice.session.processing");
    case "speaking":
      return t("search.voice.session.speaking");
    case "stopped":
      return session.noticeKey ? t(`search.voice.session.${session.noticeKey}`) : "";
    case "error":
      return session.noticeKey === "micDenied"
        ? t("search.voice.session.micDenied")
        : t("search.voice.errors.notSupported");
    default:
      return "";
  }
}

export function VoiceSessionControl({
  session,
  onTap,
  onStop,
  variant = "button",
}: {
  session: VoiceSessionState;
  onTap: () => void;
  onStop: () => void;
  /** "icon" = kruhové tlačidlo v poli hľadania (Nástenka). */
  variant?: "button" | "icon";
}) {
  const { t } = useLocale();
  const active = isSessionActive(session.status);
  const listening = session.status === "listening";
  const speaking = session.status === "speaking";
  const label = !active
    ? t("search.voice.session.start")
    : speaking
      ? t("search.voice.session.interrupt")
      : t("search.voice.session.stop");

  const tone = listening
    ? "border-danger/50 text-danger"
    : active
      ? "border-primary/40 text-primary"
      : "";

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={onTap}
        aria-pressed={active}
        aria-label={label}
        title={label}
        className={
          variant === "icon"
            ? `relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-doc-surface ${tone || "border-doc-border text-secondary"}`
            : `inline-flex min-h-11 items-center gap-2 rounded-doc border bg-doc-surface px-3 text-sm font-medium ${tone || "border-doc-border text-primary"}`
        }
      >
        {listening && variant === "icon" && (
          <span aria-hidden="true" className="absolute inset-0 animate-ping rounded-full border border-danger/40 motion-reduce:hidden" />
        )}
        <MicGlyph />
        {variant === "button" && <span>{label}</span>}
      </button>
      {active && (
        <button
          type="button"
          onClick={onStop}
          className="inline-flex min-h-11 items-center rounded-doc border border-doc-border bg-doc-surface px-3 text-sm text-secondary"
        >
          {t("search.voice.session.stop")}
        </button>
      )}
    </span>
  );
}

function MicGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}
