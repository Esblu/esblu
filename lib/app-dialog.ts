// =============================================================================
// Jadro mobilne bezpečných dialógov (Mobile M1, 2026-09-28) — bez Reactu.
// Vykreslenie: app/components/ui/AppDialog.tsx (AppDialogHost). Bez hostu
// (napr. mimo React stromu) sa padá späť na natívne window.confirm/alert —
// akcia sa nikdy nevykoná bez odpovede používateľa.
// =============================================================================

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Nevratná akcia (mazanie, archív) — tlačidlo v nebezpečnej farbe. */
  destructive?: boolean;
};

export type NotifyOptions = {
  title?: string;
  message: string;
  okLabel?: string;
  tone?: "info" | "error";
};

export type DialogRequest =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "notify"; options: NotifyOptions; resolve: () => void };

type Listener = (request: DialogRequest) => void;
let listener: Listener | null = null;

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  if (!listener) {
    return Promise.resolve(typeof window !== "undefined" ? window.confirm(options.message) : false);
  }
  const current = listener;
  return new Promise((resolve) => current({ kind: "confirm", options, resolve }));
}

export function notify(options: NotifyOptions): Promise<void> {
  if (!listener) {
    if (typeof window !== "undefined") window.alert(options.message);
    return Promise.resolve();
  }
  const current = listener;
  return new Promise((resolve) => current({ kind: "notify", options, resolve }));
}


/** Pripojí host (iba AppDialogHost). Vráti odpojenie. */
export function attachDialogHost(next: Listener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}
