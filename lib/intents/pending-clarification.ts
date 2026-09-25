import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { AwaitingClarification, ClarificationSlot, IntentArgs, IntentName, ParsedIntent } from "@/lib/intents/types";
import { isKnownIntentName } from "@/lib/intents/types";
import { classifyConfirmationReply } from "@/lib/intents/confirmation-reply";
import { parseIntentDeterministic } from "@/lib/intents/parse";
import { isNewCommandDuringInvoice } from "@/lib/intents/conversation-state";
import { hasExplicitAction } from "@/lib/intents/domain-action";

// =============================================================================
// Rozpracovaná otázka asistenta — spoločný mechanizmus pre všetky moduly.
//
// PREČO
// -----
// Asistent sa spýta „Ku ktorému stroju?" a používateľ povie iba „Aman."
// Predtým sa „Aman" spracoval ako NOVÝ príkaz: nerozpoznal sa, išiel na AI
// klasifikáciu a skončil ako „Nič sa nenašlo." Pôvodný zámer (servis,
// popis „výmena filtra a oleja") sa stratil.
//
// AKO
// ---
// Keď handler vráti otázku (`awaiting`), route zapečatí pôvodný intent,
// známe sloty a JEDEN chýbajúci slot do nepriehľadného tokenu:
//   AES-256-GCM, kľúč odvodený zo serverového tajomstva s oddelením domény,
//   viazaný na používateľa + AKTÍVNU firmu, platnosť 5 minút.
// Prehliadač ho iba drží a pošle s ďalšou vetou. Server ho rozšifruje,
// overí používateľa, firmu a čas, doplní odpoveď do slotu a pokračuje
// PÔVODNÝM intentom — cez tú istú bránu oprávnení a ten istý handler.
//
// Token nič nevykonáva: najviac vedie k náhľadu, ktorý má vlastné
// jednorazové potvrdenie (assistant_action_confirmations). Opakované
// použitie tokenu preto vytvorí najviac ďalší náhľad. Odhlásenie, iný
// používateľ, zmena firmy alebo uplynutie času = token neplatí.
//
// Bez migrácie: nič sa neukladá do databázy.
// =============================================================================

export const PENDING_CLARIFICATION_TTL_SECONDS = 5 * 60;
const VERSION = 1;
const MAX_TOKEN_LENGTH = 8192;

export type PendingClarification = {
  intent: IntentName;
  /** Známe sloty pôvodného príkazu (bez `entityId`). */
  args: IntentArgs;
  slot: ClarificationSlot;
  candidate?: { id: string; label: string };
};

type Envelope = { v: number; uid: string; cid: string; exp: number; p: PendingClarification };

type Binding = { userId: string; companyId: string };
type Options = { secret?: string; now?: number };

const SLOTS: readonly ClarificationSlot[] = ["machine", "vehicle", "machine_or_vehicle", "inventory_item", "folder", "partner_name", "invoice_start", "service_title", "quantity", "create_module", "edit_field", "new_name", "container_type"];

function key(secret: string | undefined = process.env.ESBLU_ACTION_CONFIRMATION_SECRET): Buffer | null {
  const trimmed = secret?.trim();
  if (!trimmed || trimmed.length < 32) return null;
  return createHash("sha256").update(`esblu-pending-clarification-v1:${trimmed}`).digest();
}

function b64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** `entityId` nikdy nevstupuje do známych slotov — nastaví ho až potvrdenie kandidáta. */
function sanitizeArgs(args: IntentArgs): IntentArgs {
  const clean: IntentArgs = { ...args };
  delete clean.entityId;
  return clean;
}

export function sealPendingClarification(
  intent: IntentName,
  args: IntentArgs,
  awaiting: AwaitingClarification,
  binding: Binding,
  options: Options = {}
): string | null {
  const k = key(options.secret);
  if (!k) return null;
  const envelope: Envelope = {
    v: VERSION,
    uid: binding.userId,
    cid: binding.companyId,
    exp: Math.floor((options.now ?? Date.now()) / 1000) + PENDING_CLARIFICATION_TTL_SECONDS,
    p: {
      intent,
      args: sanitizeArgs(args),
      slot: awaiting.slot,
      ...(awaiting.candidate ? { candidate: { id: awaiting.candidate.id, label: awaiting.candidate.label.slice(0, 200) } } : {}),
    },
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
  const token = b64url(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
  return token.length <= MAX_TOKEN_LENGTH ? token : null;
}

/** Iba pre toho istého používateľa v tej istej aktívnej firme a kým neuplynul čas. Inak `null`. */
export function unsealPendingClarification(token: unknown, binding: Binding, options: Options = {}): PendingClarification | null {
  const k = key(options.secret);
  if (!k || typeof token !== "string" || token.length < 40 || token.length > MAX_TOKEN_LENGTH) return null;
  try {
    const raw = fromB64url(token);
    const decipher = createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const envelope = JSON.parse(plain) as Envelope;
    if (envelope.v !== VERSION || envelope.uid !== binding.userId || envelope.cid !== binding.companyId) return null;
    if (Math.floor((options.now ?? Date.now()) / 1000) > envelope.exp) return null;
    const p = envelope.p;
    if (!p || !isKnownIntentName(p.intent) || !SLOTS.includes(p.slot) || typeof p.args !== "object") return null;
    return { intent: p.intent, args: sanitizeArgs(p.args ?? {}), slot: p.slot, ...(p.candidate ? { candidate: p.candidate } : {}) };
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Odpoveď, zrušenie alebo nový príkaz?
// -----------------------------------------------------------------------------

export type ClarificationReply =
  | { kind: "cancel" }
  | { kind: "confirm_candidate" }
  | { kind: "answer"; value: string }
  | { kind: "new_command" };

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.!?,;:„“”"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CANCEL_PHRASES = [
  "zrusit", "zrus", "nechaj tak", "nechaj to", "nechajme to", "netreba", "nie", "stop", "koniec",
  "cancel", "never mind", "nevermind", "forget it", "stop it", "no",
  "abbrechen", "lass es", "lass das", "vergiss es", "nein", "stopp",
];

/**
 * Slovesá príkazov. Veta s nimi je NOVÝ príkaz („Ukáž sklad."), nie odpoveď.
 * Odpoveď na otázku je meno alebo označenie („Aman.", „Stroj Aman.").
 */
const COMMAND_STEMS = [
  "ukaz", "zobraz", "otvor", "najdi", "hladaj", "vyhladaj", "vytvor", "pridaj", "zaloz", "zaeviduj", "zapis",
  "zmaz", "vymaz", "odstran", "stiahni", "exportuj", "kolko", "kedy", "presun", "prirad", "premenuj", "spracuj",
  "nahraj", "naskenuj", "odfot", "zniz", "zvys", "odober", "nastav", "vypis", "ktor",
  "show", "open", "find", "search", "create", "add", "delete", "remove", "download", "export", "how", "when", "what", "which", "list",
  "zeige", "zeig", "offne", "oeffne", "finde", "erstelle", "losch", "loesch", "entfern", "lade", "exportiere", "wie", "wann", "welche",
];
/** Krátke kmene sa porovnávajú presne (aby „Howard" či „Addison" neboli príkaz), okrem týchto SK slovies. */
const SHORT_PREFIX_STEMS = new Set(["ukaz", "zniz", "zvys", "zmaz", "kolk", "ktor"]);

function isCommandWord(word: string): boolean {
  return COMMAND_STEMS.some((stem) =>
    stem.length >= 5 || SHORT_PREFIX_STEMS.has(stem) ? word.startsWith(stem) : word === stem
  );
}

/** Slová, ktoré pred odpoveďou nič nemenia („Stroj Aman", „Ten Aman", „do priečinka August"). */
const LEADING_NOISE = [
  "ten", "ta", "to", "tu", "tej", "tom", "tomu", "ku", "k", "do", "pre", "na", "je", "myslim", "asi", "hmm", "no", "tak",
  "stroj", "stroju", "stroja", "strojom", "vozidlo", "vozidlu", "vozidla", "auto", "autu", "auta", "spz",
  "polozka", "polozku", "polozke", "polozky", "skladova", "skladovu", "skladovej", "priecinok", "priecinka", "priecinku",
  "the", "machine", "vehicle", "car", "item", "folder", "der", "die", "das", "dem", "den", "maschine", "fahrzeug", "artikel", "ordner", "belegordner",
];

const MAX_ANSWER_WORDS = 7;

function hasPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(^| )${phrase}( |$)`).test(text);
}

/** Pôvodné slová odpovede bez úvodného „stroj", „ten" a pod. a bez koncovej interpunkcie. */
export function cleanClarificationAnswer(rawText: string): string {
  const tokens = rawText.trim().replace(/[.?!]+$/, "").split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEADING_NOISE.includes(normalize(tokens[0]))) tokens.shift();
  if (tokens.length === 1 && LEADING_NOISE.includes(normalize(tokens[0]))) return "";
  return tokens.join(" ").replace(/^[„"'“]+|[”"'“,;:]+$/g, "").trim();
}

// -----------------------------------------------------------------------------
// Nový príkaz má prednosť pred doplnením starého slotu
// -----------------------------------------------------------------------------
//
// Produkčná chyba: po otázke „Ku ktorému stroju alebo vozidlu?" sa ďalšia,
// úplne nová veta bez slovesa zo zoznamu („Vystav faktúru", „Nová faktúra",
// prepis „Faktúru pre Tester1") vyhodnotila ako ODPOVEĎ a asistent hľadal
// stroj/vozidlo menom „Vystav faktúru". Rozhodovalo sa iba podľa slovesa.
//
// Teraz sa pred doplnením slotu pýtame:
//   1. Pomenúva veta INÚ oblasť, než na akú sa pýtalo (faktúra, sklad,
//      priečinok … pri otázke na stroj)? → nový príkaz.
//   2. Rozumie jej parser ako celému príkazu (nie iba ako vyhľadaniu tej
//      istej entity — „AB123CD", „Stroj Aman")? → nový príkaz.

export type DialogContext = ClarificationSlot | "invoice";

const DOMAIN_NOUNS: Record<string, string[]> = {
  invoice: ["faktur", "rechnung", "invoice"],
  document: ["blocek", "blocky", "blockov", "doklad", "dokument", "dodaci list", "receipt", "beleg"],
  inventory: ["sklad", "zasob", "inventory", "lager"],
  folder: ["priecin", "zlozk", "folder", "ordner"],
  vehicle: ["vozidl", "vehicle", "fahrzeug"],
  machine: ["stroj", "machine", "maschine"],
  partner: ["partner", "zakaznik", "odberatel", "dodavatel", "kunde", "customer", "supplier"],
};

const ALLOWED_DOMAINS: Record<DialogContext, string[]> = {
  machine: ["machine"],
  vehicle: ["vehicle"],
  machine_or_vehicle: ["machine", "vehicle"],
  inventory_item: ["inventory"],
  folder: ["folder"],
  partner_name: ["partner"],
  invoice_start: ["invoice"],
  service_title: ["machine", "vehicle"],
  quantity: ["inventory"],
  create_module: ["inventory", "machine", "vehicle"],
  edit_field: ["inventory"],
  new_name: ["inventory", "folder"],
  container_type: ["folder"],
  invoice: ["invoice"],
};

/** Vyhľadanie entity, ktorá JE odpoveďou na otázku („AB123CD" → OPEN_VEHICLE). */
const SLOT_LOOKUPS: Record<DialogContext, readonly string[]> = {
  machine: ["SEARCH_MACHINE", "OPEN_MACHINE"],
  vehicle: ["OPEN_VEHICLE", "SEARCH_VEHICLE"],
  machine_or_vehicle: ["SEARCH_MACHINE", "OPEN_MACHINE", "OPEN_VEHICLE", "SEARCH_VEHICLE"],
  inventory_item: ["OPEN_INVENTORY_ITEM", "SEARCH_INVENTORY_ITEM", "INVENTORY_ITEM_STATUS"],
  // „do priečinka August 2026" je odpoveď na „Do ktorého priečinka?".
  folder: ["FOLDER_OPEN", "FOLDER_ADD_ITEMS"],
  partner_name: ["SEARCH_PARTNER"],
  invoice_start: [],
  service_title: [],
  quantity: [],
  create_module: [],
  edit_field: [],
  new_name: [],
  container_type: [],
  invoice: [],
};

const ALL_LOOKUPS = Array.from(new Set(Object.values(SLOT_LOOKUPS).flat()));

function mentionsDomain(text: string, noun: string): boolean {
  return new RegExp(`(^| )${noun.replace(/\s+/g, " ")}`).test(text);
}

/**
 * Je veta nový, úplný príkaz — nie odpoveď na otázku v kontexte `context`?
 *
 * Pri rozpracovanej faktúre (`invoice`) je pravidlo užšie: odpoveď na
 * „Za čo má byť faktúra?" smie pomenovať stroj či vozidlo („prenájom
 * bagra 300 eur"). Novým príkazom je tam iba nové založenie faktúry alebo
 * čítací príkaz („Ukáž sklad", „Otvor vozidlá").
 */
export function isClearNewCommand(rawText: string, context?: DialogContext): boolean {
  const text = normalize(rawText);
  if (!text) return false;
  const parsed = parseIntentDeterministic(rawText);

  // Faktúra má vlastné (užšie) pravidlo v zdieľanom rozhodovaní
  // lib/intents/conversation-state.ts — tu sa iba deleguje.
  if (context === "invoice") return isNewCommandDuringInvoice(rawText);

  const allowed = context ? ALLOWED_DOMAINS[context] : Object.keys(DOMAIN_NOUNS).filter((d) => d !== "invoice" && d !== "partner");
  for (const [domain, nouns] of Object.entries(DOMAIN_NOUNS)) {
    if (!allowed.includes(domain) && nouns.some((noun) => mentionsDomain(text, noun))) return true;
  }
  const lookups = context ? SLOT_LOOKUPS[context] : ALL_LOOKUPS;
  return Boolean(parsed && !lookups.includes(parsed.name));
}

export function classifyClarificationReply(
  rawText: string,
  pending: Pick<PendingClarification, "candidate"> & { slot?: ClarificationSlot }
): ClarificationReply {
  const text = normalize(rawText);
  if (!text) return { kind: "new_command" };

  if (CANCEL_PHRASES.some((phrase) => hasPhrase(text, phrase)) && text.split(" ").length <= 4) return { kind: "cancel" };

  if (pending.candidate) {
    const reply = classifyConfirmationReply(rawText);
    if (reply === "confirm") return { kind: "confirm_candidate" };
    if (reply === "cancel") return { kind: "cancel" };
  } else if (classifyConfirmationReply(rawText) === "confirm") {
    // „Áno" nie je meno — bez kandidáta nie je čo potvrdiť.
    return { kind: "new_command" };
  }

  const words = text.split(" ");
  // Popis servisu je veta („výmena oleja a filtrov na prednej náprave"),
  // nie meno — smie byť dlhší; nový príkaz rozpozná isClearNewCommand.
  if (pending.slot === "service_title") {
    const parsedCommand = hasExplicitAction(rawText) ? parseIntentDeterministic(rawText) : null;
    const newCommand = parsedCommand !== null && !["MACHINE_SERVICE_ADD", "VEHICLE_SERVICE_ADD"].includes(parsedCommand.name);
    if (words.length > 25 || newCommand) return { kind: "new_command" };
    const value = rawText.trim().replace(/[.?!]+$/, "").trim();
    return value ? { kind: "answer", value } : { kind: "new_command" };
  }
  if (words.length > MAX_ANSWER_WORDS) return { kind: "new_command" };
  if (words.some(isCommandWord)) return { kind: "new_command" };
  if (isClearNewCommand(rawText, pending.slot)) return { kind: "new_command" };

  const value = cleanClarificationAnswer(rawText);
  return value ? { kind: "answer", value } : { kind: "new_command" };
}

/**
 * Doplní odpoveď do chýbajúceho slotu a vráti PÔVODNÝ intent. Oprávnenie
 * aj existenciu entity overí volajúci znova (brána + handler pod RLS).
 */
export function resumePendingIntent(
  pending: PendingClarification,
  reply: Extract<ClarificationReply, { kind: "answer" } | { kind: "confirm_candidate" }>
): ParsedIntent {
  const args: IntentArgs = { ...pending.args };
  delete args.entityId;
  delete args.useContext;

  if (reply.kind === "confirm_candidate" && pending.candidate) {
    args.entityId = pending.candidate.id;
    if (pending.slot === "folder") args.folderName = pending.candidate.label;
    else args.query = pending.candidate.label;
    return { name: pending.intent, args, source: "deterministic" };
  }

  const value = reply.kind === "answer" ? reply.value.slice(0, 120) : "";
  switch (pending.slot) {
    case "folder":
      // „Ktorú zložku chcete zmazať?" — zložka dokladov má vlastné pole.
      if (pending.intent === "DELETE_DOCUMENT_CATEGORY" || pending.intent === "RENAME_DOCUMENT_CATEGORY") args.categoryName = value;
      else args.folderName = value;
      break;
    case "inventory_item":
      args.query = value;
      args.entityName = value;
      break;
    case "machine":
      args.query = value;
      if (pending.intent === "MACHINE_SERVICE_ADD") args.targetModule = "machines";
      break;
    case "vehicle":
      args.query = value;
      if (pending.intent === "VEHICLE_SERVICE_ADD") args.targetModule = "vehicles";
      break;
    case "machine_or_vehicle":
      // Handler skúsi stroj, potom vozidlo (ŠPZ).
      args.query = value;
      delete args.targetModule;
      break;
    case "service_title": {
      // „Výmena oleja za 80 eur" — suma iba ak zaznela s menou.
      const text = reply.kind === "answer" ? reply.value : "";
      const cost = /(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur\w*)/i.exec(text);
      args.serviceTitle = text.replace(/\s*(?:za\s+)?\d+(?:[.,]\d{1,2})?\s*(?:€|eur\w*)/i, "").replace(/[,\s]+$/, "").trim().slice(0, 120) || text.slice(0, 120);
      if (cost) args.amount = Number(cost[1].replace(",", "."));
      break;
    }
    case "partner_name":
      // „Ako sa volá nový obchodný partner?" → meno; ostatné vyslovené
      // údaje (IČO …) z pôvodnej vety ostávajú.
      args.entityName = reply.kind === "answer" ? reply.value.slice(0, 200) : value;
      break;
  }
  return { name: pending.intent, args, source: "deterministic" };
}
