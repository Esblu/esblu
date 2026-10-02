import { toneSymbol, type StatusTone } from "@/lib/einvoice/ui/view-model";
import { TONE_CLASS } from "./styles";

/** Stav ako text + symbol (nie iba farba), s role="status" pre čítačky obrazovky. */
export function EinvoiceStatusPill({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span role="status" className={`inline-flex max-w-full items-center gap-1.5 rounded-doc-sm border px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[tone] ?? TONE_CLASS.neutral}`}>
      <span aria-hidden="true">{toneSymbol(tone)}</span>
      <span className="break-words">{label}</span>
    </span>
  );
}
