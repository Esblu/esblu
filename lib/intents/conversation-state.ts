import type { ClarificationSlot, ParsedIntent } from "@/lib/intents/types";
import { parseIntentDeterministic } from "@/lib/intents/parse";
import { isRegisteredReadOnlyIntent } from "@/lib/intents/registry";
import { findCurrency } from "@/lib/intents/number-words";
import type { InvoiceDraftField, InvoiceDraftSlots } from "@/lib/intents/invoice-slots";
import { invoiceStage, readItemCorrection, readPartnerChange, type InvoiceConversationStage } from "@/lib/intents/invoice-slots";

// =============================================================================
// Spoločný model konverzačného stavu asistenta + JEDNO rozhodnutie
// „odpoveď / nový príkaz / zrušenie" pre všetky moduly.
//
// KONCEPČNÝ MODEL
// ---------------
// Asistent má v každej chvíli najviac JEDNU aktívnu úlohu. Jej stav je
// uložený na serveri (nikdy sa neverí tomu, čo o ňom tvrdí klient):
//
//   activeTask / activeIntent  čo používateľ práve robí (CREATE_INVOICE_DRAFT,
//                              MACHINE_SERVICE_ADD, PARTNER_CREATE, …)
//   activeModule               modul obrazovky (iba vyberá význam, nie právo)
//   activeEntity               entita otvorená na obrazovke, overená pod RLS
//   knownSlots                 čo už je známe (partner, položky, stroj, …)
//   missingSlots               čo chýba; PRVÉ = otázka, ktorá naozaj zaznela
//   pendingQuestion            text tejto otázky (vracia sa ako `clarify`/`answer`)
//   pendingSuggestion          „Myslíte …?" — jediný kandidát na potvrdenie
//   pendingConfirmation        náhľad zápisu s jednorazovým HMAC potvrdením
//                              (assistant_action_confirmations) — samostatný stav
//   conversationId / userId / companyId / createdAt / expiresAt
//
// Fyzicky sú to dve úložiská s rovnakou väzbou (používateľ + aktívna firma +
// expirácia):
//   - faktúra: assistant_conversation_contexts (DB, SECURITY DEFINER RPC,
//     10 min) — potrebuje atomický claim proti dvojitému dokladu,
//   - ostatné moduly: zapečatený token (AES-256-GCM, 5 min, bez DB).
// O tom, čo ďalšia veta ZNAMENÁ, však rozhoduje pre obe jedna funkcia
// nižšie (`decideTurn`), v jednom poradí:
//
//   1. zrušenie úlohy („Zrušiť", „Nechaj tak", „Cancel", „Abbrechen")
//   2. jasný NOVÝ príkaz (nová faktúra, čítanie, výslovný zápis inej oblasti)
//   3. inak ODPOVEĎ na chýbajúce pole aktívnej úlohy
//
// Globálny parser a AI klasifikátor sa spustia IBA vtedy, keď žiadna aktívna
// úloha vetu neprijala. Nová úloha nahrádza nedokončenú (žiadne implicitné
// obnovenie opustenej úlohy neskôr).
// =============================================================================

export type ActiveTask =
  | {
      kind: "invoice";
      field: InvoiceDraftField;
      stage: InvoiceConversationStage;
      slots: InvoiceDraftSlots;
    }
  | { kind: "clarification"; slot: ClarificationSlot; hasSuggestion: boolean };

export type TurnDecision = "cancel" | "new_command" | "answer";

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
 * Výslovné zrušenie CELEJ úlohy. Holé „Nie" sem nepatrí — pri otázke
 * „Myslíte …?" odmieta iba návrh, nie celú faktúru.
 */
const TASK_CANCEL_PHRASES = [
  "zrusit", "zrus", "zrus to", "zrus fakturu", "zrusit fakturu", "nechaj tak", "nechaj to", "nechajme to", "netreba",
  "stop", "koniec", "zabudni", "cancel", "cancel it", "never mind", "nevermind", "forget it", "stop it",
  "abbrechen", "abbruch", "lass es", "lass das", "vergiss es", "stopp", "zrusit to",
];

export function isTaskCancel(rawText: string): boolean {
  const text = normalize(rawText);
  if (!text || text.split(" ").length > 4) return false;
  return TASK_CANCEL_PHRASES.some((phrase) => new RegExp(`(^| )${phrase}( |$)`).test(text));
}

const READ_VERBS = ["ukaz", "zobraz", "otvor", "najdi", "show", "open", "find", "zeige", "zeig", "offne", "oeffne", "finde", "kolko"];

/** Zápis/založenie (nie čítanie) — „Vytvor nový stroj", „Pridaj do skladu 20 vrutov". */
function isExplicitWrite(intent: ParsedIntent): boolean {
  return !isRegisteredReadOnlyIntent(intent.name) || ["ENTITY_CREATE", "DOCUMENT_INTAKE", "PARTNER_CREATE"].includes(intent.name);
}

/**
 * Je veta počas rozpracovanej faktúry NOVÝ príkaz?
 *
 * Odpoveď na „Za čo má byť faktúra?" smie pomenovať stroj či materiál
 * („prenájom bagra 300 eur"). Novým príkazom je iba:
 *   - nové založenie faktúry alebo partnera,
 *   - čítací príkaz so slovesom („Ukáž sklad", „Otvor vozidlá"),
 *   - výslovný zápis inej oblasti BEZ sumy v mene („Vytvor nový stroj.",
 *     „Pridaj do skladu 20 vrutov"). Veta so sumou v mene je položka.
 */
export function isNewCommandDuringInvoice(rawText: string): boolean {
  const parsed = parseIntentDeterministic(rawText);
  if (!parsed) return false;
  if (parsed.name === "CREATE_INVOICE_DRAFT" || parsed.name === "PARTNER_CREATE") return true;
  const text = normalize(rawText);
  if (text.split(" ").some((word) => READ_VERBS.some((verb) => word.startsWith(verb)))) return true;
  return isExplicitWrite(parsed) && findCurrency(rawText) === null;
}

/**
 * JEDNO rozhodnutie pre ďalšiu vetu, keď je nejaká úloha aktívna.
 * Pri faktúre sa najprv uprednostnia jej vlastné opravy („Odstráň dopravu",
 * „Zmeň odberateľa na …") — tie sú odpoveďou, nie novým príkazom.
 */
export function decideInvoiceTurn(rawText: string, task: Extract<ActiveTask, { kind: "invoice" }>): TurnDecision {
  if (isTaskCancel(rawText)) return "cancel";
  if ((task.slots.items?.length ?? 0) > 0 && readItemCorrection(task.slots, rawText)) return "answer";
  if (readPartnerChange(rawText)) return "answer";
  return isNewCommandDuringInvoice(rawText) ? "new_command" : "answer";
}

export function invoiceTaskFrom(field: InvoiceDraftField, slots: InvoiceDraftSlots): Extract<ActiveTask, { kind: "invoice" }> {
  return { kind: "invoice", field, stage: invoiceStage(field), slots };
}
