"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { pushLayer } from "@/lib/back-stack";
import { attachDialogHost, type DialogRequest, type NotifyOptions } from "@/lib/app-dialog";

// =============================================================================
// Mobilne bezpečné potvrdzovacie a informačné dialógy (Mobile M1, 2026-09-28).
//
// Náhrada natívnych window.confirm()/alert(), ktoré v natívnej appke
// vyzerajú ako systémové chybové okno, nerešpektujú tmavý vzhľad, bezpečné
// zóny ani Android „späť". Použitie (async):
//
//   if (!(await confirmAction({ message: t("..."), destructive: true }))) return;
//   await notify({ message: t("...") });
//
// Host (<AppDialogHost />) je mountovaný raz v app/layout.tsx. Ak by host
// chýbal (napr. mimo React stromu), padá sa bezpečne späť na natívne
// window.confirm/alert — nikdy sa akcia nevykoná bez odpovede.
// Na mobile je to spodný panel (bottom sheet), na širšej obrazovke
// centrovaný dialóg. Android „späť" / Escape = Zrušiť.
// =============================================================================

export { confirmAction, notify, type ConfirmOptions, type NotifyOptions } from "@/lib/app-dialog";

export function AppDialogHost() {
  const { t } = useLocale();
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const current = queue[0] ?? null;

  useEffect(() => attachDialogHost((request) => setQueue((items) => [...items, request])), []);

  function finish(result: boolean) {
    if (!current) return;
    if (current.kind === "confirm") current.resolve(result);
    else current.resolve();
    setQueue((items) => items.slice(1));
  }

  // Latest finish pre listenery (Escape / späť).
  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  });

  useEffect(() => {
    if (!current) return;
    primaryRef.current?.focus();
    const unregister = pushLayer(() => finishRef.current(false));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finishRef.current(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unregister();
      window.removeEventListener("keydown", onKey);
    };
  }, [current]);

  if (!current) return null;

  const isConfirm = current.kind === "confirm";
  const destructive = isConfirm && current.options.destructive;
  const title = current.options.title;
  const titleId = "esblu-dialog-title";
  const messageId = "esblu-dialog-message";

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" onClick={() => finish(false)} />
      <div
        role={isConfirm ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={messageId}
        className="relative w-full max-w-md rounded-t-3xl border border-subtle bg-surface-1 px-5 pb-[calc(var(--esblu-safe-bottom)+20px)] pt-5 shadow-2xl sm:rounded-3xl sm:pb-5"
      >
        {title && (
          <h2 id={titleId} className="text-lg font-bold text-primary">
            {title}
          </h2>
        )}
        <p
          id={messageId}
          className={`whitespace-pre-line break-words text-base leading-relaxed ${title ? "mt-2" : ""} ${
            current.kind === "notify" && current.options.tone === "error" ? "text-danger" : "text-secondary"
          }`}
        >
          {current.options.message}
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {isConfirm && (
            <button
              type="button"
              onClick={() => finish(false)}
              className="btn-secondary min-h-11 px-5 py-2.5 text-base font-semibold"
            >
              {current.options.cancelLabel ?? t("common.buttons.cancel")}
            </button>
          )}
          <button
            ref={primaryRef}
            type="button"
            onClick={() => finish(true)}
            className={`min-h-11 rounded-xl px-5 py-2.5 text-base font-bold ${
              destructive ? "bg-danger text-white hover:opacity-90" : "btn-primary"
            }`}
          >
            {isConfirm
              ? current.options.confirmLabel ?? t("common.buttons.confirm")
              : (current.options as NotifyOptions).okLabel ?? t("common.buttons.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
