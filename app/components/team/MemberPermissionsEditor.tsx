"use client";

// =============================================================================
// Člen tímu → Oprávnenia (granulárne oprávnenia V1, 2026-10-23).
//
// Iba pre zamestnanca a iba pre ownera/admina aktívnej firmy. Zobrazuje
// zrozumiteľné vety, nie interné kľúče. Uloženie ide výhradne cez RPC
// esblu_set_member_permissions — server overí rolu, firmu, cieľ a register;
// UI je iba pohodlie. Predvoľby iba zaškrtnú políčka (nie je to rola).
// =============================================================================

import { useState } from "react";
import { SettingsDisclosure } from "@/app/components/ui/SettingsList";
import {
  delegablePermissionsFor,
  PERMISSION_PRESETS,
  TEAM_PERMISSION_AREAS,
  type TeamPermission,
} from "@/lib/team-permissions";
import { memberPermissionErrorKey, setMemberPermissions } from "@/lib/team-permissions-client";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function MemberPermissionsEditor({
  t,
  memberId,
  managerRole,
  initial,
  onSaved,
}: {
  t: Translate;
  memberId: string;
  managerRole: "owner" | "admin";
  initial: readonly string[];
  onSaved: (memberId: string, permissions: string[]) => void;
}) {
  const options = delegablePermissionsFor(managerRole);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const dirty = selected.size !== initial.length || [...selected].some((p) => !initial.includes(p));
  const summary =
    initial.length === 0
      ? t("settings.permissions.summaryNone")
      : t("settings.permissions.summaryCount", { count: initial.length });

  function toggle(permission: TeamPermission) {
    setFeedback(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  }

  function applyPreset(permissions: readonly TeamPermission[]) {
    setFeedback(null);
    setSelected(new Set(permissions.filter((p) => options.some((o) => o.key === p))));
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const saved = await setMemberPermissions(memberId, [...selected]);
      setSelected(new Set(saved));
      onSaved(memberId, saved);
      setFeedback({ tone: "success", text: t("settings.permissions.saved") });
    } catch (error) {
      setSelected(new Set(initial));
      setFeedback({ tone: "error", text: t(memberPermissionErrorKey(error)) });
    } finally {
      setSaving(false);
    }
  }

  if (options.length === 0) return null;

  return (
    <SettingsDisclosure title={t("settings.permissions.title")} subtitle={summary} open={open} onOpenChange={setOpen}>
      <div className="space-y-4" data-testid={`member-permissions-${memberId}`}>
        <p className="text-sm text-secondary">{t("settings.permissions.intro")}</p>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-esblu">{t("settings.permissions.presetsTitle")}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PERMISSION_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => applyPreset(preset.permissions)}
                className="rounded-full border border-subtle bg-surface-1 px-2.5 py-1 text-xs text-secondary transition hover:bg-surface-hover hover:text-primary"
              >
                {t(`settings.permissions.presets.${preset.key}`)}
              </button>
            ))}
          </div>
        </div>

        {TEAM_PERMISSION_AREAS.map((area) => {
          const areaOptions = options.filter((o) => o.area === area);
          if (areaOptions.length === 0) return null;
          return (
            <fieldset key={area} className="space-y-1.5">
              <legend className="text-sm font-semibold text-primary">{t(`settings.permissions.areas.${area}`)}</legend>
              <p className="text-xs text-muted-esblu">{t(`settings.permissions.baseline.${area}`)}</p>
              {areaOptions.map((option) => (
                <label key={option.key} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm text-primary">
                  <input
                    type="checkbox"
                    checked={selected.has(option.key)}
                    onChange={() => toggle(option.key)}
                    disabled={saving}
                    className="h-4 w-4 shrink-0"
                  />
                  <span>{t(`settings.permissions.labels.${option.key.replace(".", "_")}`)}</span>
                </label>
              ))}
            </fieldset>
          );
        })}

        <p className="text-xs text-muted-esblu">{t("settings.permissions.notDelegated")}</p>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void save()} disabled={!dirty || saving} className="ui-btn ui-btn-primary ui-btn-sm">
            {saving ? t("settings.permissions.saving") : t("settings.permissions.save")}
          </button>
          {feedback && (
            <span role="status" className={`text-xs ${feedback.tone === "error" ? "text-danger" : "text-success"}`}>
              {feedback.text}
            </span>
          )}
        </div>
      </div>
    </SettingsDisclosure>
  );
}
