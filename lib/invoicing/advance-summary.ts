// =============================================================================
// Zhrnutie konečnej faktúry so zálohami pre PDF / UI (čistá funkcia, bez I/O).
// 20261008100009 — FS FAQ k eFaktúre (15. 9. 2026, príklad 38):
//   - ZDANENÁ záloha = mínusový riadok položiek (základ aj DPH) → už je v total_amount;
//   - NEZDANENÁ záloha = platba znižujúca sumu na úhradu (BT-113), rozpis DPH nemení;
//   - staršie doklady (pred 20261008100009): odpočet zálohy mimo riadkov (advanceDeductions).
// =============================================================================

export type AdvanceSummaryItem = {
  is_advance_deduction?: boolean;
  description: string;
  line_net_amount: number | string;
  line_vat_amount: number | string;
  line_gross_amount: number | string;
};

export type AdvanceSummary = {
  /** Položky bez mínusových riadkov záloh (s DPH). */
  itemsTotal: number;
  /** Mínusové riadky zdanených záloh (kladné čísla: základ, DPH, spolu). */
  taxedDeductions: { description: string; taxable: number; vat: number; gross: number }[];
  /** total_amount dokladu (po odpočte zdanených záloh). */
  total: number;
  /** Nezdanená záloha (BT-113). */
  untaxedPrepaid: number;
  /** Staršie doklady: odpočet mimo riadkov (s DPH). */
  legacyDeducted: number;
  /** Suma na úhradu = total − nezdanená − staršie odpočty. */
  payable: number;
};

const cents = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100);

export function advanceSummary(input: {
  totalAmount: number | string;
  untaxedPrepaidAmount?: number | string | null;
  items: AdvanceSummaryItem[];
  legacyDeductions?: { taxable_amount: number; vat_amount: number }[];
}): AdvanceSummary {
  const lines = input.items.filter((i) => i.is_advance_deduction);
  const itemsCents = input.items.filter((i) => !i.is_advance_deduction).reduce((s, i) => s + cents(i.line_gross_amount), 0);
  const legacy = lines.length > 0 ? 0 : (input.legacyDeductions ?? []).reduce((s, d) => s + cents(d.taxable_amount) + cents(d.vat_amount), 0);
  const total = cents(input.totalAmount);
  const untaxed = cents(input.untaxedPrepaidAmount);
  return {
    itemsTotal: itemsCents / 100,
    taxedDeductions: lines.map((l) => ({
      description: l.description,
      taxable: -cents(l.line_net_amount) / 100,
      vat: -cents(l.line_vat_amount) / 100,
      gross: -cents(l.line_gross_amount) / 100,
    })),
    total: total / 100,
    untaxedPrepaid: untaxed / 100,
    legacyDeducted: legacy / 100,
    payable: (total - untaxed - legacy) / 100,
  };
}
