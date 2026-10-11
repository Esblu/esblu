"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { disablePushOnThisDevice, enablePushOnThisDevice, isThisDeviceSubscribed, pushSupport, type PushSupport } from "@/lib/push/client";
import { SettingsSection } from "@/app/components/ui/SettingsList";

// Nastavenie „Upozornenia v telefóne". Povolenie sa žiada IBA po ťuknutí.
// UI refresh 2026-10-11: jeden riadok s prepínačom (role="switch") v
// skupine nastavení namiesto veľkej karty s plným tlačidlom.
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
    if (busy) return;
    setBusy(true);
    setMessage("");
    if (subscribed) {
      await disablePushOnThisDevice();
      setSubscribed(false);
      setMessage(t("settings.push.disabled"));
    } else {
      const outcome = await enablePushOnThisDevice();
      setSubscribed(outcome === "enabled");
      setMessage(
        t(
          outcome === "enabled"
            ? "settings.push.enabled"
            : outcome === "denied"
              ? "settings.push.denied"
              : outcome === "not_configured"
                ? "settings.push.notConfigured"
                : "settings.push.failed"
        )
      );
    }
    setBusy(false);
  }

  const switchLabel = subscribed ? t("settings.push.disableButton") : t("settings.push.enableButton");

  return (
    <SettingsSection title={t("settings.push.title")} footer={t("settings.push.privacyHint")}>
      <div className="ui-row">
        <span className="min-w-0 flex-1">
          <span className="ui-row-title block">{t("settings.push.title")}</span>
          <span className="ui-row-sub mt-0.5 line-clamp-2">
            {support === "supported"
              ? t("settings.push.description")
              : t(support === "ios_needs_install" ? "settings.push.iosHint" : "settings.push.unsupported")}
          </span>
        </span>
        {support === "supported" && (
          <button
            type="button"
            role="switch"
            aria-checked={subscribed}
            aria-label={switchLabel}
            title={switchLabel}
            onClick={() => void toggle()}
            disabled={busy}
            className="ui-switch"
          />
        )}
      </div>
      {message && (
        <div className="ui-row">
          <span className="ui-row-sub" role="status">
            {message}
          </span>
        </div>
      )}
    </SettingsSection>
  );
}
