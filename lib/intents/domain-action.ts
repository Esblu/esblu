import type { IntentArgs, ParsedIntent } from "./types.ts";

// =============================================================================
// DOMÉNA + AKCIA určujú intent — samotné podstatné meno nie.
//
// Produkčná chyba: hlasový prepis „Faktúru, zakopanie, odvoz materiálu,
// materiál, pracovníci." (prepis reči stratil sloveso aj meno odberateľa)
// parser vyhodnotil ako SEARCH_DOCUMENTS — slovo „faktúru" je zároveň typ
// dokladu — a asistent ukázal „Nájdené dokumenty: 33084.png".
//
// Pravidlo pre ASISTENTA (hlas a dialóg; písané hľadanie na nástenke
// ostáva bez zmeny):
//   „faktúra"                    → otázka (vytvoriť / vyhľadať)
//   „faktúru, kopanie, doprava"  → otázka „Chcete vytvoriť novú faktúru?"
//   „ukáž / nájdi / otvor faktúru …", „faktúry za august" → čítanie
//   „vytvor faktúru …"           → draft faktúry
// To isté pre stroj, vozidlo, sklad, partnera, priečinok a doklady: holé
// podstatné meno bez akcie a bez konkrétneho cieľa sa nezmení na hľadanie.
//
// Modul je čistý (bez DB a bez prekladov), aby sa dal testovať v Node.
// =============================================================================

export type AssistantDomain = "invoice" | "document" | "machine" | "vehicle" | "inventory" | "partner" | "folder";

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Slovesá a opytovacie slová, ktoré nesú AKCIU (čítanie, zápis, otázka). */
const ACTION_STEMS = [
  // SK / CZ
  "ukaz", "zobraz", "otvor", "najdi", "najst", "hladaj", "vyhladaj", "kolko", "ktor", "ake", "aky", "aku", "kde",
  "mame", "vypis", "zoznam", "stiahni", "exportuj", "vytvor", "pridaj", "zaloz", "vystav", "priprav", "zmaz",
  "vymaz", "odstran", "presun", "prirad", "zaeviduj", "nahraj", "otevri",
  // EN
  "show", "open", "find", "search", "list", "which", "what", "how", "where", "display", "download", "create",
  "add", "delete", "remove", "export",
  // DE
  "zeig", "offne", "oeffne", "finde", "such", "welche", "wie", "wo", "liste", "erstell", "loesch", "losch",
];

/** Nesie veta výslovnú akciu? (Hranica slova — „Tester1" nie je „test".) */
export function hasExplicitAction(rawText: string): boolean {
  const words = fold(rawText).split(/[^a-z0-9]+/).filter(Boolean);
  // Krátke kmene (≤ 3 znaky: „ake", „kde", „wo", „how") iba ako celé slovo —
  // inak by „workers" bolo „wo…" a „kdekoľvek" otázka.
  return words.some((word) => ACTION_STEMS.some((stem) => (stem.length <= 3 ? word === stem : word.startsWith(stem))));
}

/** Konkrétny cieľ/filter — „faktúry za august", „stroj Takeuchi", „za 86 eur". */
export function hasSpecificTarget(args: IntentArgs): boolean {
  return Boolean(
    args.query?.trim() ||
      args.dateFrom ||
      args.dateTo ||
      args.amount !== undefined ||
      args.year !== undefined ||
      args.invoiceStatus ||
      args.invoiceDirection ||
      args.folderName?.trim() ||
      args.unassignedOnly ||
      (args.deadlineTypes && args.deadlineTypes.length > 0)
  );
}

/** Ktorej oblasti sa týka čítací intent, ktorý môže vzniknúť z holého podstatného mena. */
export function domainOfReadIntent(intent: Pick<ParsedIntent, "name" | "args">): AssistantDomain | null {
  switch (intent.name) {
    case "SEARCH_DOCUMENTS":
      return (intent.args.documentTypes ?? []).includes("invoice") ? "invoice" : "document";
    case "SEARCH_INVOICE":
      return "invoice";
    case "SEARCH_MACHINE":
      return "machine";
    case "SEARCH_VEHICLE":
      return "vehicle";
    case "SEARCH_INVENTORY_ITEM":
      return "inventory";
    case "SEARCH_PARTNER":
      return "partner";
    case "FOLDER_OPEN":
      return "folder";
    default:
      return null;
  }
}

/**
 * Má asistent namiesto hľadania položiť otázku? Iba pri čítacom intente
 * z holého podstatného mena: bez akcie a bez konkrétneho cieľa.
 */
export function needsDomainClarification(intent: Pick<ParsedIntent, "name" | "args">, rawText: string): AssistantDomain | null {
  const domain = domainOfReadIntent(intent);
  if (!domain) return null;
  if (hasExplicitAction(rawText) || hasSpecificTarget(intent.args)) return null;
  return domain;
}

const INVOICE_NOUN = /^\s*(fakt[uú]r\S*|rechnung\S*|invoice\S*)[\s,.:;!-]*/i;

/** „Faktúru, kopanie, …" → „kopanie, …" (iba úvodné slovo; inak bez zmeny). */
export function stripLeadingInvoiceNoun(rawText: string): string {
  const stripped = rawText.replace(INVOICE_NOUN, "");
  return stripped.trim() ? stripped : rawText;
}

/**
 * Popisy položiek, ktoré nasledujú za holým „Faktúru, …". Iba úseky bez
 * čísla (sumy sa tu nedomýšľajú) a najviac 10. Prázdne pole = nie sú.
 */
export function invoiceItemDescriptions(rawText: string): string[] {
  const rest = stripLeadingInvoiceNoun(rawText);
  if (rest === rawText) return [];
  const parts = rest
    .replace(/[.!?]+\s*$/, "")
    .split(/\s*[,;]\s*|\s+(?:a|and|und|plus)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 10 || parts.some((part) => /\d/.test(part))) return [];
  return parts;
}

export type InvoiceStartChoice = "create" | "search" | "cancel" | null;

/** Odpoveď na „Chcete vytvoriť novú faktúru (alebo existujúcu vyhľadať)?". */
export function readInvoiceStartChoice(rawText: string, confirmMeansCreate: boolean): InvoiceStartChoice {
  const text = fold(rawText).replace(/[.!?,]/g, " ").replace(/\s+/g, " ").trim();
  if (/(^| )(vyhlad|hladat|hladaj|najst|najdi|ukaz|existujuc|search|find|show|such|zeig)/.test(text)) return "search";
  if (/(^| )(vytvor|zaloz|novu|nova|novy|nove|create|new|erstell|neue)/.test(text)) return "create";
  if (/^(ano|hej|jasne|ok|okej|dobre|yes|yeah|ja|genau|jo)( |$)/.test(text)) return confirmMeansCreate ? "create" : null;
  if (/^(nie|no|nein|zrus|zrusit|nechaj|cancel|abbrechen|netreba)( |$)/.test(text)) return "cancel";
  return null;
}
