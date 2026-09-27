// =============================================================================
// Dobropis (credit note) — JEDEN sémantický model pre všetky súčty.
//
// MODEL
// -----
// Doklad sa ukladá v KLADNÝCH veličinách (množstvo > 0, cena ≥ 0, súčty ≥ 0)
// — tak ho vyžadujú DB CHECK-y aj EN 16931 (credit note typ 381 s kladnými
// sumami). O ZNAMIENKU v ekonomických súčtoch rozhoduje DRUH dokladu:
//
//   regular_invoice, payment_received_invoice, debit_note  → +1
//   credit_note                                           → −1
//
// Preto:
//   - dobropis NIKDY nie je pohľadávka (nie je „neuhradený", „po splatnosti"),
//   - dobropis znižuje zostatok faktúry, ktorú opravuje (corrects_invoice_id),
//   - faktúra úplne pokrytá dobropismi nie je otvorená ani po splatnosti,
//   - súčty (obrat, DPH, exporty) = Σ znamienko × suma.
// Nikde sa znamienko neaplikuje dvakrát: uložené hodnoty sú vždy kladné,
// podpísaná hodnota vzniká IBA cez `documentSign`.
//
// Obmedzenie (zdokumentované): zostatok pri čiastočnej úhrade + čiastočnom
// dobropise sa v zozname určuje z payment_status a súčtu dobropisov, nie z
// jednotlivých platieb (tie sa v registri nenačítavajú).
//
// Modul je bez importov — beží v appke, na serveri aj v teste.
// =============================================================================

export type SettlementDocument = {
  id: string;
  kind: string;
  direction?: string;
  document_status: string;
  payment_status?: string | null;
  total_amount: number | string | null;
  corrects_invoice_id?: string | null;
  due_date?: string | null;
};

const EPSILON = 0.005;

function amount(value: number | string | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** +1 alebo −1 podľa druhu dokladu. */
export function documentSign(kind: string): 1 | -1 {
  return kind === "credit_note" ? -1 : 1;
}

export function isCreditNote(document: Pick<SettlementDocument, "kind">): boolean {
  return document.kind === "credit_note";
}

/** Podpísaná hodnota (pre súčty a exporty). */
export function signedAmount(kind: string, value: number | string | null | undefined): number {
  return documentSign(kind) * amount(value);
}

/** Pohľadávku/záväzok tvorí iba finalizovaný doklad, ktorý nie je dobropis. */
export function isReceivableDocument(document: SettlementDocument): boolean {
  return document.document_status === "finalized" && !isCreditNote(document);
}

/**
 * Súčet FINALIZOVANÝCH dobropisov podľa opravovanej faktúry.
 * (Koncept dobropisu nič neznižuje, kým nie je vystavený.)
 */
export function creditedTotals(documents: readonly SettlementDocument[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const document of documents) {
    if (!isCreditNote(document) || document.document_status !== "finalized" || !document.corrects_invoice_id) continue;
    totals.set(document.corrects_invoice_id, (totals.get(document.corrects_invoice_id) ?? 0) + amount(document.total_amount));
  }
  return totals;
}

/** Suma faktúry po odpočítaní vystavených dobropisov (nikdy záporná). */
export function remainingAfterCredits(document: SettlementDocument, credited: ReadonlyMap<string, number>): number {
  if (isCreditNote(document)) return 0;
  return Math.max(0, amount(document.total_amount) - (credited.get(document.id) ?? 0));
}

export function isFullyCredited(document: SettlementDocument, credited: ReadonlyMap<string, number>): boolean {
  return !isCreditNote(document) && (credited.get(document.id) ?? 0) > 0 && remainingAfterCredits(document, credited) <= EPSILON;
}

/** Otvorená pohľadávka: finalizovaná, nie dobropis, nie uhradená, nie celá dobropisovaná. */
export function isOpenReceivable(document: SettlementDocument, credited: ReadonlyMap<string, number>): boolean {
  if (!isReceivableDocument(document)) return false;
  if (document.payment_status === "paid") return false;
  return remainingAfterCredits(document, credited) > EPSILON;
}

/** Po splatnosti: otvorená pohľadávka so splatnosťou pred dneškom. */
export function isEffectivelyOverdue(
  document: SettlementDocument,
  credited: ReadonlyMap<string, number>,
  today: string
): boolean {
  if (!document.due_date) return false;
  return isOpenReceivable(document, credited) && document.due_date < today;
}

/**
 * Čistý ekonomický dopad finalizovaných dokladov (napr. obrat alebo
 * pohľadávky pred úhradou): Σ znamienko × suma. Koncepty sa nepočítajú.
 */
export function netDocumentTotal(documents: readonly SettlementDocument[]): number {
  let total = 0;
  for (const document of documents) {
    if (document.document_status !== "finalized") continue;
    total += signedAmount(document.kind, document.total_amount);
  }
  return Math.round(total * 100) / 100;
}

/** Súčet zostatkov otvorených pohľadávok (po dobropisoch). */
export function openReceivableTotal(documents: readonly SettlementDocument[]): number {
  const credited = creditedTotals(documents);
  let total = 0;
  for (const document of documents) {
    if (isOpenReceivable(document, credited)) total += remainingAfterCredits(document, credited);
  }
  return Math.round(total * 100) / 100;
}
