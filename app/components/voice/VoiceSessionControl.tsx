"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";
import { isSessionActive, type VoiceSessionState } from "@/lib/voice/voice-session";
import { useCompanyEntitlements } from "@/hooks/use-company-entitlements";
import { useActiveMembership } from "@/hooks/use-active-membership";
import { voiceTranscriptionAllowed } from "@/lib/intents/permissions";
import { micGate, type MicGateNotice } from "@/lib/voice/mic-gate";

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
      // Konkrétna príčina (zakázaný / zablokovaný / obsadený / žiadny
      // mikrofón / časový limit), nie jedna všeobecná veta.
      return session.noticeKey ? t(`search.voice.session.${session.noticeKey}`) : t("search.voice.errors.notSupported");
    default:
      return "";
  }
}

export function VoiceSessionControl({
  session,
  onTap,
  onStop,
  variant = "button",
  canOpenSettings = false,
  onOpenSettings,
  onGateNotice,
}: {
  session: VoiceSessionState;
  onTap: () => void;
  onStop: () => void;
  /** "icon" = kruhové tlačidlo v poli hľadania (Nástenka). */
  variant?: "button" | "icon";
  /** Mikrofón je trvalo zablokovaný a platforma vie otvoriť nastavenia appky. */
  canOpenSettings?: boolean;
  onOpenSettings?: () => void;
  /**
   * Ťuknutie na neaktívny mikrofón: „locked" (firma nemá nárok voice) alebo
   * „unavailable" (nároky sa nepodarilo načítať). Volajúci zobrazí vysvetlenie.
   */
  onGateNotice?: (notice: MicGateNotice) => void;
}) {
  const { t } = useLocale();
  const entitlements = useCompanyEntitlements();
  const membershipState = useActiveMembership();
  const active = isSessionActive(session.status);
  const listening = session.status === "listening";
  const speaking = session.status === "speaking";
  const label = !active
    ? t("search.voice.session.start")
    : speaking
      ? t("search.voice.session.interrupt")
      : t("search.voice.session.stop");

  const processing = session.status === "transcribing" || session.status === "waiting_server";
  // Stavy: počúva (červený + pulz), spracúva (spinner), aktívny, chyba (tlmená červená), nečinný.
  const tone = listening
    ? "border-danger/50 text-danger"
    : active
      ? "border-brand-400/50 text-brand-300"
      : session.status === "error"
        ? "border-danger/35 text-danger/80"
        : "";

  // Hlas je platený modul (nárok `voice`, nie je v triali). Mikrofón sa už
  // NESKRÝVA potichu: počas načítania drží miesto, bez nároku ukáže zámok
  // a vysvetlenie, pri chybe nárokov ponúkne opakovanie (lib/voice/mic-gate.ts).
  // Reláciu bez nároku spustiť nemožno; bezpečnosť drží server
  // (/api/assistant/transcribe → esblu_require_my_entitlement('voice')).
  // Rola bez hlasového asistenta (zamestnanec) mikrofón nedostane vôbec.
  const gate = micGate({
    sessionActive: active,
    membershipLoading: membershipState.loading,
    roleAllowsVoice: voiceTranscriptionAllowed(membershipState.membership?.role),
    entitlementsLoading: entitlements.loading,
    entitlementsError: entitlements.error,
    hasVoiceEntitlement: entitlements.has("voice"),
  });
  if (gate === "hidden") return null;

  if (gate !== "ready") {
    const gateLabel =
      gate === "pending"
        ? t("search.voice.gate.pending")
        : gate === "unavailable"
          ? t("search.voice.gate.unavailable")
          : t("search.voice.gate.locked");
    return (
      <button
        type="button"
        data-voice-gate={gate}
        aria-label={gateLabel}
        title={gateLabel}
        aria-disabled={gate === "pending" || undefined}
        aria-busy={gate === "pending" || undefined}
        onClick={() => {
          if (gate === "pending") return;
          if (gate === "unavailable") entitlements.retry();
          onGateNotice?.(gate);
        }}
        className={
          variant === "icon"
            ? `relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-doc-border bg-doc-surface text-muted-esblu transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${gate === "pending" ? "cursor-default opacity-50" : "hover:text-secondary"}`
            : `relative inline-flex min-h-[var(--control-h)] items-center gap-1.5 rounded-doc-sm border border-doc-border bg-doc-surface px-3 text-[13px] font-medium text-muted-esblu transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${gate === "pending" ? "cursor-default opacity-50" : "hover:bg-surface-hover"}`
        }
      >
        <MicGlyph />
        {gate === "locked" && <LockBadge />}
        {variant === "button" && <span>{gateLabel}</span>}
      </button>
    );
  }

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
            ? `relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-doc-surface transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${tone || "border-doc-border text-secondary hover:text-primary"}`
            : `inline-flex min-h-[var(--control-h)] items-center gap-1.5 rounded-doc-sm border bg-doc-surface px-3 text-[13px] font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${tone || "border-doc-border text-primary hover:bg-surface-hover"}`
        }
      >
        {listening && variant === "icon" && (
          <span aria-hidden="true" className="absolute inset-0 animate-ping rounded-full border border-danger/40 motion-reduce:hidden" />
        )}
        {processing ? <SpinnerGlyph /> : <MicGlyph />}
        {variant === "button" && <span>{label}</span>}
      </button>
      {active && (
        <button
          type="button"
          onClick={onStop}
          className="inline-flex min-h-[var(--control-h-sm)] items-center rounded-doc-sm border border-doc-border bg-doc-surface px-2.5 text-xs font-medium text-secondary transition hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          {t("search.voice.session.stop")}
        </button>
      )}
      {!active && canOpenSettings && onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex min-h-[var(--control-h-sm)] items-center rounded-doc-sm border border-doc-border bg-doc-surface px-2.5 text-xs font-medium text-brand-300 transition hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          {t("search.voice.session.openSettings")}
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

/** Malý zámok v rohu mikrofónu — stav nie je iba farbou. */
function LockBadge() {
  return (
    <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-doc-border bg-surface-2 text-muted-esblu">
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" focusable="false">
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
    </span>
  );
}

function SpinnerGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false" className="animate-spin motion-reduce:animate-none">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}
