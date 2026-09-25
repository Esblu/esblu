"use client";

import { useSyncExternalStore } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { isSpeechSupported, setVoiceRepliesEnabled, voiceRepliesEnabled } from "@/lib/voice/speech";

// Prepínač „Esblu odpovedá nahlas". Iba pohodlie tohto prehliadača.
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function VoiceReplyToggle({ className = "" }: { className?: string }) {
  const { t } = useLocale();
  const enabled = useSyncExternalStore(subscribe, voiceRepliesEnabled, () => true);
  const supported = useSyncExternalStore(subscribe, isSpeechSupported, () => false);
  if (!supported) return null;
  return (
    <button
      type="button"
      aria-pressed={enabled}
      onClick={() => {
        setVoiceRepliesEnabled(!enabled);
        listeners.forEach((listener) => listener());
      }}
      className={`min-h-11 rounded-full border border-subtle px-3 py-1.5 text-xs font-bold text-secondary ${className}`}
    >
      {enabled ? t("search.voice.replies.on") : t("search.voice.replies.off")}
    </button>
  );
}
