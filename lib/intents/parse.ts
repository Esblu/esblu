import { normalizeSpz } from "@/lib/normalize-spz";
import { DEADLINE_THRESHOLD_DAYS } from "@/lib/deadlines";
import type { IntentName, ParsedIntent } from "@/lib/intents/types";

// =============================================================================
// Esblu — Intent Engine: deterministický parser prirodzeného jazyka
// (zadanie, bod 18: "Ak intent vieme bezpečne vyriešiť deterministicky
// (napr. presná ŠPZ), môžeš použiť rýchlejší deterministic path pred AI.").
// =============================================================================
// Tento parser NIKDY negeneruje SQL ani nevolá žiadny externý model — je to
// čistá, testovateľná funkcia text → ParsedIntent | null. Vracia null, keď
// si nie je istý (žiadne hádanie) — volajúci (app/api/assistant/intent/
// route.ts) vtedy skúsi AI fallback (lib/intents/ai-fallback.ts), ktorý
// vracia VÝHRADNE z rovnakého IntentName enumu.
//
// Jazyk je iba vstup — kľúčové slová nižšie sú zjednotené naprieč SK/CZ/EN/DE
// do JEDNÉHO pravidla na intent (bod 3 a 15 zadania: "Nerob tri business
// logiky... jazyk je iba vstup/output"), nikdy tri samostatné vetvy kódu.
// =============================================================================

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalizeText(value: string): string {
  return stripDiacritics(value).toLowerCase().trim();
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

// Slovenský/český formát ŠPZ: 1-3 písmená (okres) + 3 číslice + 2 písmená,
// s voliteľnou medzerou/pomlčkou — "TT123AB", "TT 123AB", "BA-123AB". Ide o
// HEURISTIKU na vytiahnutie kandidáta z voľného textu, nie o validáciu —
// skutočnú zhodu overí až lib/entity-search.ts#resolveVehicleByPlate cez
// normalizeSpz() proti reálnym vozidlám firmy.
const PLATE_CANDIDATE_REGEX = /\b([a-z]{2,3}[\s-]?\d{3}[\s-]?[a-z]{2})\b/i;

function extractPlateCandidate(rawText: string): string | null {
  const match = rawText.match(PLATE_CANDIDATE_REGEX);
  if (!match) return null;

  const normalized = normalizeSpz(match[1]);
  if (!normalized) return null;
  return normalized.length >= 5 && normalized.length <= 8 ? normalized : null;
}

/**
 * Zvyšok textu po odstránení rozpoznaného príkazového slovníka a ŠPZ
 * kandidáta — použije sa ako voľný `query` pre stroje/sklad/dokumenty,
 * kde presná ŠPZ neexistuje. Zámerne jednoduché (odstránenie kľúčových
 * slov, nie plnohodnotná tokenizácia) — presne zodpovedá rozsahu tejto
 * fázy (deterministický parser pre known-shape príkazy, nie generický NLU).
 */
function stripKeywords(text: string, keywords: string[]): string {
  let result = text;
  for (const keyword of keywords) {
    result = result.split(keyword).join(" ");
  }
  return result.replace(/\s+/g, " ").trim();
}

const OPEN_WORDS = [
  "najdi",
  "otvor",
  "ukaz mi",
  "find",
  "open",
  "show me",
  "finde",
  "suche",
  "zeige mir",
  "offne",
];

// "doklad" pokrýva "doklady"/"dokladu"/"dokladov" atď. ("ukáž doklady k
// TT123AB" — jeden z explicitných príkladov v zadaní, sekcia A/C).
const DOCUMENTS_WORDS = ["dokument", "document", "dokumenty", "doklad"];
const SERVICE_WORDS = ["servis", "service", "wartung"];
const REPORT_WORDS = ["report", "bericht"];
const COST_WORDS = [
  "kolko",
  "naklad",
  "how much",
  "cost",
  "spent",
  "kosten",
  "ausgegeben",
];
const STK_WORDS = ["stk", "technicka kontrola", "inspection", "hauptuntersuchung", " hu "];
const EK_WORDS = ["ek", "emisna kontrola", "emission", "abgasuntersuchung", " au "];
const VIGNETTE_WORDS = [
  "znamk",
  "dialnicna",
  "vignette",
  "toll sticker",
  "highway sticker",
  "maut",
];
const MACHINE_CONTEXT_WORDS = ["stroj", "bager", "machine", "maschine", "bagger"];
const INVENTORY_CONTEXT_WORDS = ["sklad", "inventory", "lager", "skladov"];
const DOCUMENT_SEARCH_WORDS = ["faktur", "invoice", "rechnung", "blocek", "receipt", "beleg"];

const OVERDUE_WORDS = ["po lehote", "overdue", "uberfallig", "nach frist"];
const DEADLINE_QUERY_WORDS = [
  "co mi konci",
  "co konci",
  "ake terminy",
  "co je po lehote",
  "what expires",
  "what's expiring",
  "whats expiring",
  "was lauft ab",
  "welche fristen",
];
const THIS_MONTH_WORDS = ["tento mesiac", "this month", "diesen monat"];

function parseWithinDays(text: string): number | undefined {
  const match = text.match(/(\d{1,3})\s*(dni|dni|days|tagen|tage)/);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  if (containsAny(text, THIS_MONTH_WORDS)) return 30;
  return undefined;
}

export function parseIntentDeterministic(rawText: string): ParsedIntent | null {
  const text = normalizeText(rawText);
  if (!text) return null;

  const plate = extractPlateCandidate(rawText);
  const hasMachineContext = containsAny(text, MACHINE_CONTEXT_WORDS);
  const hasInventoryContext = containsAny(text, INVENTORY_CONTEXT_WORDS);

  // 1) Deadline-dotazy ("čo mi končí", "aké termíny treba riešiť", "čo je
  //    po lehote") — nemajú ŠPZ, sú to dotazy na CELÚ firmu, nie na jednu
  //    entitu, preto sa vyhodnocujú PRED vozidlovými pravidlami nižšie.
  if (containsAny(text, DEADLINE_QUERY_WORDS) || containsAny(text, OVERDUE_WORDS)) {
    return build("UPCOMING_DEADLINES", {
      onlyOverdue: containsAny(text, OVERDUE_WORDS),
      withinDays: parseWithinDays(text),
    });
  }

  // 2) Report ("urob report vozidla TT123AB", "report für Fahrzeug").
  if (containsAny(text, REPORT_WORDS)) {
    if (hasMachineContext && !plate) {
      return build("MACHINE_REPORT", { query: stripKeywords(text, [...REPORT_WORDS, ...MACHINE_CONTEXT_WORDS]) });
    }
    if (plate) {
      return build("VEHICLE_REPORT", { query: plate });
    }
    return null;
  }

  // 3) Náklady na servis ("koľko sme minuli na servis TT123AB tento rok").
  if (containsAny(text, COST_WORDS) && containsAny(text, SERVICE_WORDS)) {
    if (plate) {
      const yearMatch = text.match(/\b(20\d{2})\b/);
      return build("VEHICLE_COST_SUMMARY", {
        query: plate,
        year: yearMatch ? Number(yearMatch[1]) : undefined,
      });
    }
  }

  // 4) Dokumenty vozidla ("ukáž dokumenty TT123AB", DE/EN ekvivalenty) —
  //    so ŠPZ ide vždy o SHOW_VEHICLE_DOCUMENTS; bez ŠPZ (napr. "nájdi
  //    faktúru za pneumatiky") ide o všeobecné SEARCH_DOCUMENTS.
  if (containsAny(text, DOCUMENTS_WORDS) || containsAny(text, DOCUMENT_SEARCH_WORDS)) {
    if (plate) return build("SHOW_VEHICLE_DOCUMENTS", { query: plate });
    const query = stripKeywords(text, [...DOCUMENTS_WORDS, ...OPEN_WORDS]);
    if (query) return build("SEARCH_DOCUMENTS", { query });
  }

  // 5) Servisná história ("ukáž servis TT123AB" / "ukáž servis CAT 302").
  if (containsAny(text, SERVICE_WORDS)) {
    if (hasMachineContext) {
      const query = stripKeywords(text, [...SERVICE_WORDS, ...MACHINE_CONTEXT_WORDS]);
      if (query) return build("SHOW_MACHINE_SERVICE", { query });
    }
    if (plate) return build("SHOW_VEHICLE_SERVICE", { query: plate });
  }

  // 6) STK / EK / diaľničná známka — vždy vozidlo, vyžaduje ŠPZ kandidáta.
  if (plate && containsAny(text, STK_WORDS)) {
    return build("VEHICLE_STK_STATUS", { query: plate });
  }
  if (plate && containsAny(text, EK_WORDS)) {
    return build("VEHICLE_EK_STATUS", { query: plate });
  }
  if (plate && containsAny(text, VIGNETTE_WORDS)) {
    return build("VEHICLE_VIGNETTE_STATUS", { query: plate });
  }

  // 7) Explicitné "nájdi/otvor/find/show me/finde" — rozhoduje kontext.
  if (containsAny(text, OPEN_WORDS)) {
    const query = stripKeywords(text, OPEN_WORDS);
    if (hasInventoryContext) {
      return build("OPEN_INVENTORY_ITEM", {
        query: stripKeywords(query, INVENTORY_CONTEXT_WORDS),
      });
    }
    if (hasMachineContext) {
      return build("OPEN_MACHINE", { query: stripKeywords(query, MACHINE_CONTEXT_WORDS) });
    }
    if (plate) return build("OPEN_VEHICLE", { query: plate });
    if (query) return build("OPEN_VEHICLE", { query });
  }

  // 8) Voľné vyhľadávanie strojov/skladu bez "nájdi" ("bager CAT 302",
  //    "skladová položka X").
  if (hasInventoryContext) {
    const query = stripKeywords(text, INVENTORY_CONTEXT_WORDS);
    if (query) return build("SEARCH_INVENTORY_ITEM", { query });
  }
  if (hasMachineContext) {
    const query = stripKeywords(text, MACHINE_CONTEXT_WORDS);
    if (query) return build("SEARCH_MACHINE", { query });
  }

  // 9) Samostatná ŠPZ bez ďalších slov ("TT123AB") → priamo OPEN_VEHICLE.
  if (plate && text.length <= plate.length + 3) {
    return build("OPEN_VEHICLE", { query: plate });
  }

  // 10) ŠPZ je súčasťou dlhšieho, inak nerozpoznaného textu → bezpečný
  //     fallback na SEARCH_VEHICLE (radšej zoznam/1 výsledok, než nič).
  if (plate) {
    return build("SEARCH_VEHICLE", { query: plate });
  }

  return null;
}

function build(name: IntentName, args: ParsedIntent["args"]): ParsedIntent {
  return { name, args, source: "deterministic" };
}

// Exportované pre AI fallback prompt (lib/intents/ai-fallback.ts) a pre
// testy — zoznam príkladov kľúčových slov, ktoré si appka pri hľadaní
// deterministickej zhody prihliada; DRŽANÉ tu, aby AI fallback prompt vedel
// vysvetliť modelu, kedy sa deterministický parser sám nespustil (napr.
// nejednoznačný text), bez toho, aby duplikoval polia vyššie.
export const DEADLINE_DEFAULT_WINDOW_DAYS = DEADLINE_THRESHOLD_DAYS.dueSoon;
