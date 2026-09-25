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

// -----------------------------------------------------------------------------
// „Čo chcete na položke X zmeniť? Počet alebo názov?" (INVENTORY_ITEM_EDIT)
// -----------------------------------------------------------------------------

export type EditFieldReply =
  | { kind: "cancel" }
  | { kind: "repair" }
  | { kind: "new_command" }
  | { kind: "quantity"; quantity?: number; mode: QuantityMode }
  | { kind: "name"; newName?: string }
  | { kind: "unclear" };

const QUANTITY_FIELD = /\b(pocet|poctu|mnozstv\w*|stav|stavu|kus\w*|ks|zasob\w*|quantity|amount|stock|count|menge|bestand|anzahl|stuck\w*)\b/;
const NAME_FIELD = /\b(nazov|nazvu|nazvom|meno|mena|premenuj\w*|premenovat|name|rename|namen|bezeichnung|umbenennen)\b/;

/** Nový názov za „na / to / in / auf" („názov na Lak červený"). Pôvodný tvar. */
function nameAfterPreposition(rawText: string): string | undefined {
  const match = /(?:^|\s)(?:na|to|in|auf|zu)\s+(.+?)\s*[.!?]*$/i.exec(rawText.trim());
  const value = match?.[1]?.replace(/^[„"'“]+|[”"'“]+$/g, "").trim();
  return value || undefined;
}

/**
 * Odpoveď na výber poľa. Iba polia, ktoré hlas vie bezpečne zmeniť (počet,
 * názov). Holé číslo = nový počet (náhľad sa aj tak potvrdzuje).
 */
export function classifyEditFieldReply(rawText: string): EditFieldReply {
  const text = normalize(rawText);
  if (!text) return { kind: "unclear" };
  const words = text.split(" ");
  if (isTaskCancel(rawText) || (words.length <= 2 && BARE_NO.includes(words[0]))) return { kind: "cancel" };
  if (isExistingTargetRepair(rawText)) return { kind: "repair" };

  const wantsName = NAME_FIELD.test(text);
  const wantsQuantity = QUANTITY_FIELD.test(text);
  if (!wantsName && !wantsQuantity) {
    // Nový príkaz s vlastným cieľom má prednosť („Vymaž zložku Test 5").
    const parsed = parseIntentDeterministic(rawText);
    if (parsed && !(parsed.name === "INVENTORY_QUANTITY_ADJUST" && !parsed.args.entityName)) return { kind: "new_command" };
  }
  if (wantsName && !wantsQuantity) return { kind: "name", newName: nameAfterPreposition(rawText) };

  const found = findNumber(rawText);
  if (wantsQuantity || found) {
    const verbMode = words.map((word) => stockVerbMode(word)?.mode).find(Boolean);
    const quantity = found && found.value > 0 && found.value < 1_000_000 ? Math.abs(found.value) : undefined;
    return { kind: "quantity", quantity, mode: verbMode ?? "set" };
  }
  return { kind: "unclear" };
}

/**
 * Odpoveď na „Aký nový názov má mať položka X?". Nový názov je PRESNE to, čo
 * zaznelo (bez úvodného „na", „nový názov"). Výslovný príkaz = nový príkaz.
 */
export type NewNameReply = { kind: "cancel" } | { kind: "new_command" } | { kind: "answer"; value: string };

export function classifyNewNameReply(rawText: string): NewNameReply {
  const text = normalize(rawText);
  if (!text) return { kind: "new_command" };
  if (isTaskCancel(rawText) || (text.split(" ").length <= 2 && BARE_NO.includes(text.split(" ")[0]))) return { kind: "cancel" };
  const parsed = parseIntentDeterministic(rawText);
  if (parsed && text.split(" ").length > 1 && /^(ukaz|zobraz|otvor|najdi|vytvor|pridaj|vymaz|zmaz|odstran|premenuj|uprav|zniz|zvys|nastav|show|open|find|create|add|delete|remove|rename|zeig|offne|finde|erstell|losch)/.test(text)) {
    return { kind: "new_command" };
  }
  const value = rawText
    .trim()
    .replace(/^(?:nov[ýy]\s+)?(?:n[áa]zov|meno|name|new\s+name|neuer\s+name)\s*(?:je|bude|is|ist)?\s*[:,-]?\s*/i, "")
    .replace(/^(?:na|to|auf|in)\s+/i, "")
    .replace(/^[„"'“]+|[”"'“.?!,;:]+$/g, "")
    .trim();
  return value ? { kind: "answer", value: value.slice(0, 200) } : { kind: "new_command" };
}

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
