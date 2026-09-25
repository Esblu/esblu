"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { disablePushOnThisDevice, enablePushOnThisDevice, isThisDeviceSubscribed, pushSupport, type PushSupport } from "@/lib/push/client";

// Nastavenie „Upozornenia v telefóne". Povolenie sa žiada IBA po ťuknutí.
export function PushNotificationSettings() {
  const { t } = useLocale();
  const [support, setSupport] = useState<PushSupport>("unsupported");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const current = pushSupport();
    void isThisDeviceSubscribed().then((value) => {
      if (cancelled) return;
      setSupport(current);
      setSubscribed(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (support === "not_configured") return null;

  async function toggle() {
    setBusy(true);
    setMessage("");
    if (subscribed) {
      await disablePushOnThisDevice();
      setSubscribed(false);
      setMessage(t("settings.push.disabled"));
    } else {
      const outcome = await enablePushOnThisDevice();
      setSubscribed(outcome === "enabled");
      setMessage(t(outcome === "enabled" ? "settings.push.enabled" : outcome === "denied" ? "settings.push.denied" : "settings.push.failed"));
    }
    setBusy(false);
  }

  return (
    <section className="rounded-3xl border border-subtle bg-surface-1 p-8 shadow-lg backdrop-blur-xl">
      <h2 className="text-2xl font-bold text-primary">{t("settings.push.title")}</h2>
      <p className="mt-2 leading-7 text-secondary">{t("settings.push.description")}</p>
      {support === "supported" ? (
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy}
          aria-pressed={subscribed}
          className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-blue-600 px-6 py-3 text-center font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60 sm:w-auto"
        >
          {subscribed ? t("settings.push.disableButton") : t("settings.push.enableButton")}
        </button>
      ) : (
        <p className="mt-4 text-sm leading-6 text-secondary">
          {t(support === "ios_needs_install" ? "settings.push.iosHint" : "settings.push.unsupported")}
        </p>
      )}
      {message && <p className="mt-3 text-sm leading-6 text-secondary">{message}</p>}
      <p className="mt-3 text-sm leading-6 text-secondary">{t("settings.push.privacyHint")}</p>
    </section>
  );
}
