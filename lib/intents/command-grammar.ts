import { findNumber } from "./number-words.ts";

// =============================================================================
// Rozklad príkazu: AKCIA + TYP ENTITY + MENO (+ cieľ, množstvo) — deterministicky.
//
// PREČO
// -----
// Produkčné chyby 2026-09-26 (prepis bol SPRÁVNY, chyba bola v parseri):
//   „Uprav skladovú položku sprej." → hľadanie položky „uprav sprej"
//     (voľné hľadanie skladu nepoznalo sloveso „uprav" a nechalo ho v mene)
//   „Vymaž zložku test 5." → „Tomuto príkazu som nerozumel."
//     (parser nikdy nemal pravidlo na zmazanie zložky; fungovalo to cez AI
//     klasifikátor a od 5257071 — správne — AI nesmie vybrať mazanie)
//
// Pravidlo tohto modulu: VÝSLOVNÉ sloveso akcie na začiatku vety + podstatné
// meno typu hneď za ním určujú zámer. Sloveso ani typové slovo sa NIKDY
// nestanú súčasťou mena entity. Meno je zvyšok vety presne v pôvodnom tvare
// (overí ho resolver pod RLS — nič sa tu nedomýšľa).
//
// Modul je čistý (bez DB, bez prehliadača) a testovaný maticou fráz.
// =============================================================================

export type CommandAction =
  | "create"
  | "update"
  | "rename"
  | "delete"
  | "open"
  | "show"
  | "find"
  | "move"
  | "export"
  | "download"
  | "add"
  | "increase"
  | "decrease"
  | "set";

export type CommandEntityType =
  | "folder"
  | "category"
  | "inventory_item"
  | "machine"
  | "vehicle"
  | "partner"
  | "invoice"
  | "document";

export type CommandDecomposition = {
  action: CommandAction;
  /** Pôvodný tvar slovesa (diagnostika; nikdy nie je súčasťou mena). */
  actionWord: string;
  entityType?: CommandEntityType;
  /** Meno entity v pôvodnom tvare (bez slovesa, typu, výplne). */
  name?: string;
  /** „Premenuj X na Y" → Y. */
  target?: string;
  quantity?: number;
};

export function normalizeWord(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Slovesá akcií — celé slová (rozkazovací spôsob, neurčitok, zdvorilé tvary).
 * Zámerne celé tvary, nie predpony: „Oprava" (meno) nie je „oprav", „Stav"
 * nie je „stiahni".
 */
const ACTION_WORDS: Record<CommandAction, readonly string[]> = {
  create: ["vytvor", "vytvorte", "vytvorit", "sprav", "spravte", "urob", "zaloz", "zalozte", "zalozit", "create", "make", "erstelle", "erstellen", "lege", "anlegen"],
  update: ["uprav", "upravte", "upravit", "zmen", "zmente", "zmenit", "edit", "change", "update", "modify", "bearbeite", "bearbeiten", "andere", "aendere", "andern", "aendern"],
  rename: ["premenuj", "premenujte", "premenovat", "rename", "benenne", "umbenennen"],
  delete: ["vymaz", "vymazte", "vymazat", "zmaz", "zmazte", "zmazat", "odstran", "odstrante", "odstranit", "delete", "remove", "losch", "losche", "loesch", "loesche", "loschen", "loeschen", "entferne", "entfernen"],
  open: ["otvor", "otvorte", "otvorit", "open", "offne", "oeffne", "offnen", "oeffnen"],
  show: ["ukaz", "ukazte", "ukazat", "zobraz", "zobrazte", "zobrazit", "show", "zeig", "zeige", "zeigen"],
  find: ["najdi", "najdite", "najst", "hladaj", "vyhladaj", "vyhladajte", "find", "search", "finde", "suche"],
  move: ["presun", "presunte", "presunut", "move", "verschiebe", "verschieben"],
  export: ["exportuj", "exportujte", "exportovat", "export", "exportiere", "exportieren"],
  download: ["stiahni", "stiahnite", "stiahnut", "download", "lade", "herunterladen"],
  add: ["pridaj", "pridajte", "pridat", "add", "fuge", "fuege", "hinzufugen", "hinzufuegen"],
  increase: ["zvys", "zvyste", "zvysit", "navys", "increase", "erhohe", "erhoehe"],
  decrease: ["zniz", "znizte", "znizit", "uber", "uberte", "decrease", "reduce", "reduziere", "verringere"],
  set: ["nastav", "nastavte", "nastavit", "set", "setze"],
};

const WORD_TO_ACTION = new Map<string, CommandAction>();
for (const [action, words] of Object.entries(ACTION_WORDS) as [CommandAction, readonly string[]][]) {
  for (const word of words) WORD_TO_ACTION.set(word, action);
}

/** Je slovo (normalizované) slovesom akcie? */
export function actionOfWord(word: string): CommandAction | null {
  return WORD_TO_ACTION.get(normalizeWord(word).replace(/[^a-z]/g, "")) ?? null;
}

/** Zdvorilé a oslovovacie slová pred slovesom („Prosím, Esblu, vymaž …"). */
const LEADING_FILLERS = new Set([
  "prosim", "esblu", "hej", "ok", "okej", "tak", "no", "a", "mozes", "mohol", "mohla", "by", "si", "chcem", "potrebujem", "treba",
  "please", "can", "could", "you", "hey", "i", "want", "to", "bitte", "kannst", "konntest", "du", "ich", "mochte", "moechte", "will",
]);

/** Slová medzi slovesom a typom („vymaž MI tú zložku", „delete THE folder"). */
const BETWEEN_FILLERS = new Set([
  "mi", "nam", "tu", "tuto", "ten", "tento", "to", "toto", "tej", "tu", "the", "a", "an", "this", "that", "my",
  "die", "der", "das", "den", "dem", "diese", "diesen", "dieses", "mir", "uns", "bitte", "prosim", "please",
]);

/** Typové podstatné mená (normalizované kmene) — rozhoduje ZAČIATOK slova. */
const TYPE_STEMS: [CommandEntityType, readonly string[]][] = [
  ["folder", ["priecin", "folder", "ordner", "belegordner"]],
  ["category", ["zlozk", "kategori", "category", "categories"]],
  ["inventory_item", ["polozk", "item", "artikel", "lagerartikel"]],
  ["machine", ["stroj", "machine", "maschine"]],
  ["vehicle", ["vozidl", "vehicle", "fahrzeug"]],
  ["partner", ["partner", "zakaznik", "odberatel", "dodavatel", "klient", "customer", "supplier", "client", "kunde", "lieferant"]],
  ["invoice", ["faktur", "invoice", "rechnung"]],
  ["document", ["dokument", "doklad", "document", "beleg"]],
];
/** Celé slová typu, ktoré by kmeň chytil priširoko („auto" ≠ „automat"). */
const TYPE_WORDS: [CommandEntityType, readonly string[]][] = [
  ["vehicle", ["auto", "auta", "autu", "autom", "car"]],
];
/** Prídavné mená typu, ktoré nepatria do mena („skladovú položku", „obchodného partnera"). */
const TYPE_ADJECTIVES = ["skladov", "obchodn", "vlastn", "uctovn", "novu", "novy", "nova", "nove", "noveho", "business", "inventory", "stock", "accounting", "new", "neue", "neuen", "neues", "neuer"];

function typeOfWord(word: string): CommandEntityType | null {
  const w = normalizeWord(word).replace(/[^a-z0-9]/g, "");
  if (!w) return null;
  for (const [type, words] of TYPE_WORDS) if (words.includes(w)) return type;
  for (const [type, stems] of TYPE_STEMS) if (stems.some((stem) => w.startsWith(stem))) return type;
  return null;
}

function isTypeAdjective(word: string): boolean {
  const w = normalizeWord(word).replace(/[^a-z]/g, "");
  return TYPE_ADJECTIVES.some((adjective) => w.startsWith(adjective));
}

function tokens(rawText: string): string[] {
  return rawText
    .replace(/[„"“”'()]/g, " ")
    .split(/[\s;:!?]+/)
    .map((token) => token.replace(/^[.,]+/, "").replace(/[.,]+$/, ""))
    .filter(Boolean);
}

/** Úvodné slová mena, ktoré nie sú menom („s názvom", „menom", „číslo"). */
const NAME_INTRO = new Set(["s", "nazvom", "menom", "cislo", "c", "named", "called", "number", "no", "namens", "nr", "nummer", "mit", "dem", "namen"]);

function cleanName(parts: string[]): string | undefined {
  const list = [...parts];
  while (list.length > 0 && NAME_INTRO.has(normalizeWord(list[0]).replace(/[^a-z]/g, ""))) list.shift();
  const name = list.join(" ").replace(/^[„"'“]+|[”"'“.?!,;:]+$/g, "").trim();
  return name || undefined;
}

/**
 * Rozloží vetu na akciu, typ, meno. `null` = veta nezačína výslovným
 * slovesom akcie (rozhodne zvyšok parsera).
 */
export function decomposeCommand(rawText: string): CommandDecomposition | null {
  const list = tokens(rawText);
  let i = 0;
  while (i < list.length && LEADING_FILLERS.has(normalizeWord(list[i]).replace(/[^a-z]/g, "")) && !actionOfWord(list[i])) i++;
  if (i >= list.length) return null;
  const action = actionOfWord(list[i]);
  if (!action) return null;
  const actionWord = list[i];
  i++;

  // Typ hneď za slovesom (povolené iba výplňové slová a prídavné meno typu).
  let j = i;
  while (j < list.length && (BETWEEN_FILLERS.has(normalizeWord(list[j]).replace(/[^a-z]/g, "")) || isTypeAdjective(list[j]))) j++;
  const entityType = j < list.length ? typeOfWord(list[j]) : null;
  if (!entityType) {
    // Bez typu: sloveso je známe, meno/typ určí iná vetva parsera.
    const quantity = findNumber(list.slice(i).join(" "))?.value;
    return { action, actionWord, ...(quantity !== undefined ? { quantity } : {}) };
  }

  let rest = list.slice(j + 1);
  let target: string | undefined;
  if (action === "rename") {
    const at = rest.findIndex((token, index) => index > 0 && ["na", "to", "in", "zu"].includes(normalizeWord(token)));
    if (at > 0) {
      target = cleanName(rest.slice(at + 1).filter((token) => !["umbenennen"].includes(normalizeWord(token))));
      rest = rest.slice(0, at);
    }
  }
  // Nemecký slovosled: „Lösche den Ordner Test 5" je v poriadku; koncové
  // sloveso („… löschen") do mena nepatrí.
  while (rest.length > 0 && actionOfWord(rest[rest.length - 1])) rest = rest.slice(0, -1);
  const name = cleanName(rest);
  return { action, actionWord, entityType, ...(name ? { name } : {}), ...(target ? { target } : {}) };
}

/**
 * Obrana do hĺbky: sloveso akcie nesmie ostať v mene/hľadanom výraze
 * („uprav sprej" → „sprej"). Odstraňuje iba CELÉ slová slovies na okrajoch.
 */
export function stripActionWords(value: string | undefined): string | undefined {
  if (!value) return value;
  const parts = value.split(/\s+/).filter(Boolean);
  while (parts.length > 1 && actionOfWord(parts[0])) parts.shift();
  while (parts.length > 1 && actionOfWord(parts[parts.length - 1])) parts.pop();
  const cleaned = parts.join(" ").trim();
  return cleaned || undefined;
}

/** Akcie, ktoré nikdy nie sú hľadaním (voľné hľadanie ich nesmie zjesť). */
export function isWriteAction(action: CommandAction | undefined | null): boolean {
  return Boolean(action) && !["open", "show", "find"].includes(action as string);
}
