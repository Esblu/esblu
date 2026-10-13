// E-Faktúra UI — triedy tlačidiel a kariet (zhodné s app/components/document/DocumentLayout.tsx).
// Zámerne bez importu DocumentLayout, aby prezentačné komponenty ostali ľahké a testovateľné.

export const einvoiceButtonPrimary =
  "inline-flex min-h-11 items-center justify-center rounded-doc-sm bg-accent-esblu px-4 py-2 text-sm font-semibold text-on-accent transition hover:opacity-90 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export const einvoiceButtonSecondary =
  "inline-flex min-h-11 items-center justify-center rounded-doc-sm border border-doc-border px-4 py-2 text-sm font-medium text-secondary transition hover:bg-surface-hover hover:text-primary disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export const einvoiceCard = "min-w-0 rounded-doc border border-doc-border bg-doc-surface p-4 sm:p-5";

export const TONE_CLASS: Record<string, string> = {
  success: "border-success/30 text-success",
  danger: "border-danger/30 text-danger",
  warning: "border-warning/40 text-warning",
  progress: "border-accent-cyan/40 text-accent-cyan",
  neutral: "border-doc-border text-secondary",
};
