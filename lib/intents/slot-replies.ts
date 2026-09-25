import { findNumber } from "@/lib/intents/number-words";
import { parseIntentDeterministic, parseInventoryStockPhrase, stockVerbMode } from "@/lib/intents/parse";
import { isTaskCancel } from "@/lib/intents/conversation-state";

// =============================================================================
// Odpoveď na JEDEN chýbajúci slot a konverzačné opravy — čisté funkcie.
//
// PREČO
// -----
// Produkčná chyba (2026-09-25): po otázke asistenta používateľ povedal
// „To je už vytvorené." a asistent odpovedal „Tomuto príkazu som
// nerozumel." Veta sa poslala globálnemu parseru ako NOVÝ príkaz, hoci bola
// opravou prebiehajúcej úlohy. Rovnako „päť" po „Koľko kusov?" nemalo kam
// patriť — otázka na množstvo nemala zapečatený stav.
//
// PORADIE pri otázke na množstvo (slot má prednosť pred novým príkazom):
//   1. výslovné zrušenie („zrušiť", „nechaj tak")      → cancel
//   2. oprava („už existuje", „nechcem novú")          → repair (úloha ostáva)
//   3. VÝSLOVNÝ nový príkaz s vlastným cieľom          → new_command
//      („Ukáž faktúry", „Pridaj do položky Klince 5")
//   4. číslo (číslicou aj slovom, aj s „vlastne", „pridaj")→ answer
//   5. holé „nie"                                        → cancel
//   6. čokoľvek iné                                      → unclear (spýtať sa znova)
// Nič sa nedomýšľa: bez čísla sa množstvo nikdy nevyplní.
// =============================================================================

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.!?,;:„“”"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Oprava nedorozumenia „cieľ už existuje, nechcem nový" — SK/EN/DE.
 * Rozhoduje význam (existencia / nechcem nové / myslel som existujúce),
 * nie konkrétna veta. Dlhé vety sú príkazy, nie opravy.
 */
const REPAIR_PATTERNS: RegExp[] = [
  // „už existuje", „to už je vytvorené", „tá položka už je", „už ju mám", „je to vytvorené"
  /\buz\b.*\b(existuj\w*|vytvoren\w*|zalozen\w*|zaevidovan\w*|je|su|mam|mame)\b/,
  /\b(je|su)\s+(to\s+|uz\s+)*(vytvoren\w*|zalozen\w*|zaevidovan\w*)\b/,
  /\bexistuj\w*\b/,
  /\bnechcem\s+(ziad\w+\s+)?(nov\w*|vytvar\w*|zaklad\w*|dalsi\w*)\b/,
  /\b(nie|netreba)\s+(nov\w*|vytvar\w*|zaklad\w*)\b/,
  /\bmyslel[a]?\s+som\b.*\b(existuj\w*|t[uo]\s+(istu|isty|iste)|tu|ten|to)\b/,
  // EN
  /\balready\s+(exists?|created|there|have)\b/,
  /\b(it|that|this)\s+(already\s+)?exists\b/,
  /\bdon\s?t\s+want\s+(a\s+)?new\b/,
  /\bi\s+meant\s+the\s+existing\b/,
  /\bnot\s+a\s+new\s+one\b/,
  // DE
  /\b(existiert|gibt\s+es)\s+(schon|bereits)\b/,
  /\b(schon|bereits)\s+(angelegt|erstellt|vorhanden|da)\b/,
  /\bkeine?n?\s+neue\w*\b/,
  /\bich\s+meinte\s+(die|den|das)\s+(bestehende|vorhandene)\w*\b/,
];

export function isExistingTargetRepair(rawText: string): boolean {
  // Otázka („Existuje položka X?") je dopyt, nie oprava.
  if (rawText.includes("?")) return false;
  const text = normalize(rawText);
  if (!text || text.split(" ").length > 10) return false;
  return REPAIR_PATTERNS.some((pattern) => pattern.test(text));
}

export type QuantityMode = "add" | "subtract" | "set";

export type QuantityReply =
  | { kind: "cancel" }
  | { kind: "repair" }
  | { kind: "new_command" }
  | { kind: "answer"; quantity: number; mode: QuantityMode }
  | { kind: "unclear" };

const BARE_NO = ["nie", "no", "nein", "nee"];

/**
 * Veta ako odpoveď na „Koľko kusov chcete pridať k položke X?".
 * `mode` = pôvodný zámer; „uber tri" / „nastav na päť" ho smie zmeniť.
 */
export function classifyQuantityReply(rawText: string, mode: QuantityMode): QuantityReply {
  const text = normalize(rawText);
  if (!text) return { kind: "unclear" };
  const words = text.split(" ");

  if (isTaskCancel(rawText)) return { kind: "cancel" };
  if (isExistingTargetRepair(rawText)) return { kind: "repair" };

  // Výslovný nový príkaz s VLASTNÝM cieľom — „Ukáž faktúry", „Pridaj do
  // položky Klince 5". Holé „pridaj desať" / „pridaj 10" cieľ nemá → odpoveď.
  const stock = parseInventoryStockPhrase(rawText);
  if (stock?.name) return { kind: "new_command" };
  const parsed = parseIntentDeterministic(rawText);
  if (parsed && !(parsed.name === "INVENTORY_QUANTITY_ADJUST" && !parsed.args.entityName)) return { kind: "new_command" };

  const found = findNumber(rawText);
  if (found && words.length <= 6 && Number.isFinite(found.value) && found.value > 0 && found.value < 1_000_000) {
    const verbMode = words.map((word) => stockVerbMode(word)?.mode).find(Boolean) ?? mode;
    return { kind: "answer", quantity: Math.abs(found.value), mode: verbMode };
  }

  if (words.length <= 2 && BARE_NO.includes(words[0])) return { kind: "cancel" };
  return { kind: "unclear" };
}
