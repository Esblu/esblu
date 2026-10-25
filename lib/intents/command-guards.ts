// =============================================================================
// Esblu — Intent Engine: deterministické poistky a brána pred AI fallbackom
// (J8 Intent fallback cost optimization, 2026-10-25).
// =============================================================================
// Čisté funkcie text → rozhodnutie. Nič nečítajú z DB, nič neukladajú,
// nevolajú model. Použitie:
//
//   1. lib/intents/parse.ts#parseIntentDeterministic — POISTKY nad výsledkom
//      parsera: zápor („nechcem hľadať auto"), nepodporovaný zápis („Označ
//      faktúru ako zaplatenú", „Zmaž všetky stroje") a výslovné sloveso
//      zápisu („Zaeviduj bager X") nikdy nedajú READ intent.
//
//   2. lib/intents/orchestrator.ts — BRÁNA pred AI: keď parser nič nevrátil,
//      model sa NEVOLÁ pre vetu, pri ktorej by podľa vlastného promptu
//      (lib/intents/ai-fallback.ts) aj tak musel vrátiť intent: null —
//      zápor, nepodporovaný zápis, pozdrav/mimo domény (žiadne slovo
//      z domény appky). Odpoveď používateľovi je rovnaká ako pri null z AI
//      („Nerozumel som" / „Toto zatiaľ neviem"), len bez sieťového volania.
//
// Zámerne ŽIADNE fuzzy porovnávanie: iba celé slová / pevné kmene.
// =============================================================================

export function normalizeCommandText(rawText: string): string {
  return rawText
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[.?!,;:„“"()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const POLITE_LEAD = /^(?:(?:hej|hey|hi|hallo|ok|okej|okay|esblu|prosim(?: ta| te)?|please|bitte)\s+)+/;

function core(text: string): string {
  return text.replace(POLITE_LEAD, "").trim();
}

// -----------------------------------------------------------------------------
// Zápor / odmietnutie
// -----------------------------------------------------------------------------
const SK_NEGATED_LEAD =
  /^(?:ja\s+)?(?:nechcem|nechceme|nechcel|nehladaj\w*|neotvaraj\w*|neukazuj\w*|nezobrazuj\w*|nevyhladavaj\w*|nepotrebujem|nepotrebujeme|netreba|nerob\w*|nespustaj\w*|nemam|nemame\s+(?:stk|ek|znamk\w*|dialnicn\w*)|nehledej|nechci|neotevirej)\b/;
const EN_NEGATED_LEAD = /^(?:i\s+|we\s+)?(?:don'?t|do\s+not|never|no\s+need\s+to|i\s+do\s+not)\b/;
const DE_NEGATED = /^(?:ich\s+|wir\s+)?(?:will|wollen|brauche|brauchen|habe|haben)\s+(?:kein\w*|nicht)\b|^(?:such|suche|zeig|zeige|offne|oeffne|finde|mach)\w*\s+(?:\S+\s+){0,3}nicht(?:\s+(?:nach|mehr)\b|\s*$)|\bnicht\s*$|^kein\w*\b/;

/** Veta je zápor/odmietnutie príkazu („nechcem hľadať auto", „don't open …"). */
export function isNegatedCommand(rawText: string): boolean {
  const text = core(normalizeCommandText(rawText));
  if (!text) return false;
  return SK_NEGATED_LEAD.test(text) || EN_NEGATED_LEAD.test(text) || DE_NEGATED.test(text);
}

// -----------------------------------------------------------------------------
// Nepodporované zápisy (rovnaký zoznam ako „VŽDY null" v prompte AI)
// -----------------------------------------------------------------------------
export type UnsupportedActionReason = "send" | "bulk_delete" | "delete_document" | "finalize" | "mark_paid" | "edit_field";

const DELETE_VERB = /(^|\s)(vymaz\w*|zmaz\w*|odstran\w*|delete|remove|losch\w*|loesch\w*|entfern\w*|smaz\w*)\b/;
const ALL_WORD = /\b(vsetk\w*|vsetko|vsechn\w*|all|alle|alles|samtlich\w*)\b/;
const DOC_NOUN = /\b(faktur\w*|invoices?|rechnung\w*|doklad\w*|dokument\w*|documents?|blocek|blocky|blockov|receipts?|beleg\w*|quittung\w*|uctenk\w*)\b/;
// Zložky/priečinky a inbox (nepriradené) majú vlastné, podporované zápisy s potvrdením.
const CONTAINER_OR_INBOX = /\b(zlozk\w*|priecin\w*|folder\w*|\w*ordner\w*|kategori\w*|category|categories|nepriraden\w*|nezaraden\w*|unassigned|zugeordnet|unzugeordnet|inbox\w*)\b/;
const SEND_VERB = /(^|\s)(posli|poslite|odosli|odoslite|preposli|send|forward|email|e-mail|sende|schick\w*|versende\w*|posli\w*)\b/;
const FINALIZE = /\b(finaliz\w*|finalis\w*|finalize\w*)\b|^(vystav|vystavte)\s+(tu|tuto|tento|toto|tieto|tu istu)\b/;
const MARK_PAID = /\b(oznac\w*|mark\w*|markier\w*|nastav\w*|set)\b.*\b(zaplaten\w*|uhraden\w*|paid|bezahlt\w*|beglichen)\b/;
const EDIT_FIELD = /\b(zmen\w*|uprav\w*|prepis\w*|change|edit|update|ander\w*|aender\w*|bearbeit\w*)\b.*\b(vin|fin|spz|evc|ecv|kennzeichen|plate|license|rok vyroby|baujahr|year)\b/;

/** Zápis, ktorý appka zámerne nepodporuje — nikdy sa nesmie zmeniť na iný intent. */
export function unsupportedActionReason(rawText: string): UnsupportedActionReason | null {
  const text = core(normalizeCommandText(rawText));
  if (!text) return null;
  if (SEND_VERB.test(text)) return "send";
  if (MARK_PAID.test(text) && DOC_NOUN.test(text)) return "mark_paid";
  if (FINALIZE.test(text)) return "finalize";
  if (DELETE_VERB.test(text) && !CONTAINER_OR_INBOX.test(text)) {
    if (ALL_WORD.test(text)) return "bulk_delete";
    if (DOC_NOUN.test(text)) return "delete_document";
  }
  if (EDIT_FIELD.test(text)) return "edit_field";
  return null;
}

// -----------------------------------------------------------------------------
// Výslovné sloveso zápisu na začiatku vety
// -----------------------------------------------------------------------------
const WRITE_LEAD =
  /^(?:vytvor\w*|zaloz\w*|zaeviduj\w*|zaregistruj\w*|vymaz\w*|zmaz\w*|odstran\w*|premenuj\w*|presun\w*|zmen\w*|uprav\w*|odober\w*|create|register|delete|remove|rename|move|change|erstelle\w*|registrier\w*|losch\w*|loesch\w*|entfern\w*|benenn\w*|verschieb\w*|ander\w*|aender\w*)\b/;

/** Veta začína slovesom zápisu (zakladanie, mazanie, premenovanie, zmena). */
export function startsWithWriteVerb(rawText: string): boolean {
  return WRITE_LEAD.test(core(normalizeCommandText(rawText)));
}

// -----------------------------------------------------------------------------
// Doménové kotvy — bez nich veta nie je príkaz pre Esblu
// -----------------------------------------------------------------------------
// Kmene (začiatok slova) zo všetkých oblastí appky a príkazových slovies
// SK/CS/EN/DE. Veta bez JEDINEJ kotvy, bez čísla a bez ŠPZ je pozdrav,
// poďakovanie alebo otázka mimo appky — AI by podľa promptu vrátila null.
const DOMAIN_STEMS = [
  // vozidlá
  "vozid", "vuz", "auto", "auta", "aut", "fary", "fara", "dodavk", "kamion", "nakladiak", "flotil", "vozov", "spz", "ecv", "evc",
  "vehicle", "car", "cars", "truck", "van", "fleet", "fahrzeug", "lkw", "transporter", "fuhrpark", "kennzeichen",
  "stk", "ek", "emisn", "technick", "tuv", "mot", "inspection", "hauptuntersuch", "abgas", "znamk", "dialnic", "vignet", "maut", "toll",
  // stroje
  "stroj", "bager", "bagr", "bagger", "nakladac", "zeriav", "zerav", "traktor", "valec", "mechanizm", "technik", "machine", "excavat",
  "equipment", "maschin", "gerat", "kran", "radlader",
  // sklad
  "sklad", "zasob", "polozk", "inventor", "stock", "warehouse", "lager", "artikel", "item", "material", "tovar", "vypredan", "dochadz",
  "doobjedn", "objedn", "reorder", "ausverkauf", "nachbestell", "bestand", "kus", "ks",
  // doklady, faktúry, partneri
  "faktur", "invoice", "rechnung", "doklad", "dokument", "document", "beleg", "blocek", "blocky", "blockov", "receipt", "quittung", "uctenk",
  "dodaci", "dodacie", "delivery", "liefer", "vazn", "weigh", "wiege", "pzp", "poist", "insur", "versicher", "preukaz",
  "partner", "odberatel", "dodavatel", "zakaznik", "klient", "kunde", "customer", "supplier", "lieferant", "firma", "firm", "company",
  "zaplat", "nezaplat", "uhrad", "neuhrad", "paid", "unpaid", "bezahl", "unbezahl", "dlz", "dluz", "owe", "schuld", "splatnost", "offen",
  "dph", "vat", "mwst", "eur", "euro", "suma", "cena", "price", "preis", "naklad", "cost", "kosten", "minul", "stal", "spent",
  "zlozk", "priecin", "folder", "ordner", "kategori", "category", "inbox", "nepriraden", "unassigned", "zugeordnet",
  "export", "stiahn", "download", "herunterlad", "zip", "report", "prehlad", "overview", "ubersicht", "bericht", "uctovn", "accountant", "steuerberat",
  // servis, termíny
  "servis", "service", "wartung", "werkstatt", "oprav", "repair", "olej", "oil", "ol",
  "termin", "deadline", "frist", "lehot", "konci", "koncia", "vyprs", "prepad", "expir", "lauft", "ablauf", "due", "platnost", "platn", "valid", "gultig",
  // moduly, nastavenia
  "modul", "nastaven", "settings", "einstellung", "kalendar", "calendar", "chat", "spravy", "nastenk", "dashboard", "uvod", "home", "profil",
  // príkazové slovesá
  "otvor", "otevr", "ukaz", "zobraz", "najdi", "hladaj", "vyhladaj", "hledej", "zoznam", "vypis", "kolko", "kolik", "mame", "mam", "mate",
  "vytvor", "zaloz", "pridaj", "dopln", "prihod", "zaeviduj", "zaregistr", "vymaz", "zmaz", "odstran", "uprav", "zmen", "premenuj", "presun",
  "nastav", "odober", "zniz", "zvys", "nahraj", "odfot", "naskenuj", "spracuj", "zauctuj", "daj", "prirad", "vyrad", "prejdi", "chod", "prepni",
  "open", "show", "find", "search", "list", "look", "check", "much", "many", "create", "add", "register", "delete", "remove",
  "rename", "move", "set", "change", "update", "upload", "scan", "process", "go", "navigate", "switch",
  "offne", "oeffne", "zeig", "such", "finde", "liste", "viel", "viele", "haben", "erstell", "fuge", "fugen", "fueg", "hinzu", "registrier",
  "losch", "loesch", "entfern", "benenn", "verschieb", "setz", "ander", "aender", "lade", "hochlad", "scann", "verarbeit", "geh", "gehe", "wechsl",
  // krátke tvary (≤ 3 znaky sa porovnávajú iba ako celé slovo)
  "kusov", "kusy", "dlzi", "dlzia", "dlzne", "owes",
];

const PLATE_LIKE = /\b[a-z]{2,3}\s?-?\d{3}\s?-?[a-z]{2}\b/;

/** Veta obsahuje aspoň jedno slovo z domény appky, číslo alebo ŠPZ. */
export function hasDomainAnchor(rawText: string): boolean {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  if (/\d/.test(text) || PLATE_LIKE.test(text)) return true;
  const tokens = text.split(" ").map((t) => t.replace(/^'+|'+$/g, ""));
  // Kmene do 3 znakov („ek", „stk", „car", „eur") iba ako celé slovo — inak
  // by „ol" chytilo „olovrant" a „go" slovo „good".
  return tokens.some((token) => token.length > 0 && DOMAIN_STEMS.some((stem) => (stem.length <= 3 ? token === stem : token.startsWith(stem))));
}

// -----------------------------------------------------------------------------
// Brána pred AI fallbackom
// -----------------------------------------------------------------------------
export type AiSkipReason = "empty" | "negated" | "unsupported" | "no_domain_anchor";

/**
 * Dôvod, prečo NEVOLAŤ AI klasifikátor pre vetu, ktorú deterministický
 * parser nerozpoznal — alebo null (AI sa zavolá ako doteraz).
 */
export function aiFallbackSkipReason(rawText: string): AiSkipReason | null {
  const text = normalizeCommandText(rawText);
  if (!text || !/[a-z]/.test(text)) return "empty";
  if (isNegatedCommand(rawText)) return "negated";
  if (unsupportedActionReason(rawText)) return "unsupported";
  if (!hasDomainAnchor(rawText)) return "no_domain_anchor";
  return null;
}
