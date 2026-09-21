import { normalizeSpz } from "@/lib/normalize-spz";
import { DEADLINE_THRESHOLD_DAYS } from "@/lib/deadlines";
import type {
  DeadlineTypeFilter,
  DocumentTypeFilter,
  IntentArgs,
  IntentName,
  ParsedIntent,
} from "@/lib/intents/types";

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

/**
 * Odstráni z textu CELÉ tokeny (slová), ktoré ZAČÍNAJÚ na niektorý zo
 * zadaných kmeňov. Na rozdiel od stripKeywords() vyššie (naivné nahradenie
 * PODREŤAZCA) toto nikdy nenechá vo výslednom voľnom texte osamotený
 * zvyšok písmen po odstránení kmeňa zo skloňovaného slova — napr. "servis
 * bagra" so slovníkom obsahujúcim kmeň "bagr" (skloňovaný tvar slova
 * "bager" — "bagra"/"bagru"/"bagrom") by naivným nahradením nechalo
 * osamotené "a" ("servis a" namiesto "servis"), tu sa namiesto toho
 * odstráni CELÝ token "bagra". Interpunkcia na konci tokenu (napr. "302.")
 * sa pri porovnaní ignoruje, no token samotný ostáva vo výsledku (číslo/
 * názov nie je príkazové slovo) — presnú bodku na konci celej query
 * odstraňuje až build() nižšie.
 */
function stripWholeWordsStartingWith(text: string, stems: string[]): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((token) => {
    const clean = token.replace(/[.?!,;:]+$/, "");
    return !stems.some((stem) => clean.startsWith(stem));
  });
  return kept.join(" ").trim();
}

/**
 * Odstráni z textu CELÉ tokeny, ktoré sa PRESNE (po odstránení interpunkcie)
 * zhodujú s niektorým z "výplňových" slov (predložky ako "v"/"na"/"pre"/
 * "in"/"im"/"für"). Na rozdiel od stripWholeWordsStartingWith() vyššie
 * (prefix zhoda, vhodná pre skloňované kmene podstatných mien) tu MUSÍ ísť
 * o PRESNÚ zhodu — inak by prefix zhoda nechtiac odstránila aj skutočné
 * hľadané slová začínajúce na tie isté písmená (napr. "v" ako prefix by
 * odstránilo aj "vozidlo"). Rieši napr. "Spray v sklade." → po odstránení
 * kmeňa "sklad" by bez tohto kroku zostalo query="spray v" (osamotená
 * predložka), doplnenie zadania, úloha 2.
 */
function stripExactFillerWords(text: string, fillers: string[]): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((token) => {
    const clean = token.replace(/[.?!,;:]+$/, "");
    return !fillers.includes(clean);
  });
  return kept.join(" ").trim();
}

const QUERY_FILLER_WORDS = ["v", "vo", "na", "pre", "in", "im", "fur", "je"];

/** stripWholeWordsStartingWith() + stripExactFillerWords() v jednom kroku —
 * jediné miesto, cez ktoré prechádza extrakcia voľného `query` textu pre
 * stroje/sklad/vozidlá (branch 5/7/8 nižšie), aby žiadna z dvoch úprav
 * nechýbala na niektorom mieste použitia. */
function extractFreeQuery(text: string, stemWords: string[]): string {
  return stripExactFillerWords(stripWholeWordsStartingWith(text, stemWords), QUERY_FILLER_WORDS);
}

// Holé slovesné kmene ("ukáž"/"zobraz"/"nájdi"/... BEZ nasledujúceho "mi"/
// "me"/"mir") — použité VÝHRADNE pri stripWholeWordsStartingWith() na
// vyčistenie voľného textu query (nie pri detekcii OPEN_WORDS nižšie, ktorá
// je teraz zámerne ROVNAKÁ množina holých slovies — pozri komentár pri
// OPEN_WORDS nižšie, prečo boli bez "mi"/"me"/"mir" varianty doteraz
// chýbajúcim zdrojom bugu 1 doplnenia zadania).
const OPEN_VERB_STEMS = [
  "ukaz",
  "zobraz",
  "najdi",
  "otvor",
  "find",
  "open",
  "finde",
  "suche",
  "offne",
  "zeige",
  "show",
];

// "Ukáž všetky stroje." (bez "mi") predtým vôbec nespúšťalo OPEN_WORDS
// vetvu (branch 7), lebo tam bolo iba "ukaz mi" — v bežnej slovenčine sa
// "ukáž" ako príkaz používa aj úplne samostatne, bez zvratného "mi" (TOTO
// bol koreňový bug 1 z produkčného testu). Pridané holé tvary "ukaz"/
// "zobraz"/"zeige"/"show" popri pôvodných frázach s "mi"/"me"/"mir"
// (ponechané zámerne, sú to podmnožinou nových holých tvarov, takže
// duplicita neškodí — containsAny je OR).
const OPEN_WORDS = [
  "najdi",
  "otvor",
  "ukaz mi",
  "ukaz",
  "zobraz",
  "find",
  "open",
  "show me",
  "show",
  "finde",
  "suche",
  "zeige mir",
  "zeige",
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
// "bagr" je doplnkový kmeň k "bager" — slovenské skloňovanie mení "bager"
// na "bagra"/"bagru"/"bagrom"/"bagre"/"bagrov" (vypadnuté "e"), takže samotné
// "bager" tieto tvary vôbec nezachytí ("Ukáž servis bagra CAT 302." —
// jeden z explicitných príkladov doplnenia zadania, bod 3).
const MACHINE_CONTEXT_WORDS = ["stroj", "bager", "bagr", "machine", "maschine", "bagger"];
// "vozidl" pokrýva "vozidlo"/"vozidlá"/"vozidiel"/"vozidlám" a pod. —
// doteraz NEEXISTOVAL žiadny samostatný kontextový slovník pre vozidlá (na
// rozdiel od strojov/skladu), takže vety typu "Ukáž všetky vozidlá."/"Aké
// vozidlá máme?" nemali ako spustiť LIST vetvu nižšie (doplnenie zadania,
// úloha 1).
const VEHICLE_CONTEXT_WORDS = ["vozidl", "fahrzeug", "vehicle"];
const INVENTORY_CONTEXT_WORDS = ["sklad", "inventory", "lager", "skladov"];
// Doplnkový kmeň pre generické podstatné meno "položka" ("skladová
// položka spray", "položku spray") — TERAZ použitý AJ pri detekcii
// hasInventoryContext (nie iba pri čistení voľného textu query ako
// predtým) — predtým bola detekcia "je táto veta o sklade" viazaná
// výhradne na slovo "sklad", takže samotné "Položku spray." (bez slova
// "sklad" kdekoľvek vo vete) nebolo vôbec rozpoznané ako dotaz na skladovú
// položku a padlo až na `return null` (TOTO bol koreňový bug 2 z
// produkčného testu).
const INVENTORY_ITEM_NOISE_WORDS = ["polozk"];
const DOCUMENT_SEARCH_WORDS = ["faktur", "invoice", "rechnung", "blocek", "receipt", "beleg"];

// "Aký máme zostatok pre položku sprej?", "Koľko máme spreja?", "Koľko
// kusov spreja máme?", "Máme ešte sprej?", "Aký je stav položky sprej?" —
// spúšťacie frázy pre INVENTORY_ITEM_STATUS (doplnenie zadania, sekcia 2 —
// koreňová príčina produkčného bugu "Nič sa nenašlo." na tieto vety bola,
// že appka vôbec NEROZPOZNALA zámer "opýtať sa na množstvo").
const INVENTORY_STATUS_TRIGGER_WORDS = [
  "zostatok",
  "kolko mame",
  "kolko este mame",
  "kolko kusov",
  "mame este",
  "aky je stav",
  "stav polozky",
  "how much do we have",
  "do we still have",
  "wie viel haben wir",
  "haben wir noch",
];
// Slová, ktoré sú súčasťou SAMOTNEJ OTÁZKY na stav ("Aký máme zostatok
// pre...", "Koľko kusov... máme?"), nie súčasťou hľadaného NÁZVU položky —
// odstraňujú sa z voľného textu presne tak isto ako kontextové slová
// (extractFreeQuery), nikdy nezasahujú do mena samotného ("spray"/"sprej").
const INVENTORY_STATUS_QUESTION_STEMS = [
  "zostatok",
  "kolko",
  "kusov",
  "mame",
  "stav",
  "este",
  "aky",
  "ake",
  "aka",
  "how",
  "much",
  "do",
  "we",
  "have",
  "still",
  "wie",
  "viel",
  "haben",
  "wir",
  "noch",
];

// "po splatnosti"/"po termine" sú bežné synonymá k "po lehote" — predtým
// chýbali, takže "Ktoré vozidlá majú po splatnosti STK a EK?"/"Čo je po
// termíne?" vôbec nespustili deadline vetvu (súčasť koreňovej príčiny
// bugu 3 z produkčného testu).
const OVERDUE_WORDS = [
  "po lehote",
  "po splatnosti",
  "po termine",
  "overdue",
  "uberfallig",
  "nach frist",
];
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
// "Ktorým vozidlám končí diaľničná známka?" — sloveso "končí" BEZ frázy
// "čo mi končí"/"čo končí" (DEADLINE_QUERY_WORDS vyššie tieto konkrétne
// frázy nezachytáva, keď je na začiatku vety iný podmet, napr. "vozidlám").
// Zámerne úzko orezané (nižšie sa používa iba spolu s explicitným STK/EK/
// VIGNETTE slovom a `!plate`) — samotné "končí" v spojení so servisom bez
// vozidla/termínového slova má prednostne ísť do branch 5 (SHOW_*_SERVICE
// pre KONKRÉTNY stroj/vozidlo), nie sem.
const DEADLINE_EXPIRY_WORDS = ["konci", "koncia", "expire", "expires", "lauft ab", "auslauft"];

// Kvantifikátory "všetko/všetky" naznačujúce LIST operáciu (chce ZOZNAM
// VŠETKÝCH záznamov danej entity firmy), nie textové vyhľadávanie s
// query="všetky"/"" — presne koreňová príčina bugu 1 z produkčného testu
// ("Ukáž všetky stroje." → predtým sa "všetky" bralo ako doslovný
// vyhľadávací text, ktorý sa nikdy nezhoduje so žiadnym reálnym názvom).
const LIST_ALL_QUANTIFIER_WORDS = ["vsetky", "vsetko", "vsetkych", "alle", "all"];
// "Aké stroje máme?"/"Was haben wir an Maschinen?"/"What machines do we
// have?" — opytovacia forma, sémanticky rovnaká LIST požiadavka ako
// "vsetky"/"alle" vyššie, bez explicitného kvantifikátora.
const WHAT_DO_WE_HAVE_REGEX = /\bake\b[\s\S]*\bmame\b/;
const WHAT_DO_WE_HAVE_PHRASES = [
  "was haben wir",
  "what do we have",
  "what machines do we have",
  "what vehicles do we have",
  "what inventory do we have",
];

function matchesWhatDoWeHavePattern(text: string): boolean {
  return WHAT_DO_WE_HAVE_REGEX.test(text) || containsAny(text, WHAT_DO_WE_HAVE_PHRASES);
}
const THIS_MONTH_WORDS = ["tento mesiac", "this month", "diesen monat"];
const THIS_YEAR_WORDS = ["tento rok", "tohto roku", "this year", "dieses jahr"];

// Slová/frázy pre "vyexportuj" (bod 5 doplnenia zadania — export sa PRE
// TÚTO FÁZU nikdy nevykoná automaticky, iba sa prekryje s SEARCH_DOCUMENTS/
// SHOW_VEHICLE_DOCUMENTS, aby používateľ dostal presne vyfiltrovaný zoznam,
// z ktorého existujúce "Export" tlačidlo v appke (klientsky generovaný
// XLSX, pozri lib/export-ai-inbox-documents-excel.ts a
// lib/export-ai-evidence-excel.ts) funguje úplne nezmenené).
const EXPORT_WORDS = ["vyexportuj", "exportuj", "export", "exportiere"];

// Slovesné kmene pre príkazy, ktoré appka VEDOME nepodporuje (§16C/§24G
// doplnenia zadania — mazanie, odoslanie dokumentu/faktúry, zmena
// skladového množstva). MUSIA sa overiť ÚPLNE PRVÉ, pred akoukoľvek inou
// vetvou nižšie — inak by napr. "Vymaž všetky faktúry." spadlo do branch 4
// (SEARCH_DOCUMENTS, lebo "faktúry" je rozpoznaný typ dokumentu) a appka by
// TICHO zamenila deštruktívny príkaz za neškodné vyhľadávanie namiesto
// toho, aby ho jasne odmietla. Fail-closed: keď appka rozpozná niektorý z
// týchto kmeňov, VŽDY vráti null priamo tu (nikdy sa nepokúša "zachrániť"
// vetu iným intentom) — volajúci (route.ts) to ukáže ako "Tomuto príkazu
// som nerozumel."/"Tento príkaz zatiaľ nepodporujem.".
const UNSUPPORTED_ACTION_STEMS = [
  "vymaz",
  "zmaz",
  "delete",
  "loschen",
  "loesch",
  "posli",
  "odosli",
  "send",
  "sende",
  "odpocitaj",
  "uprav mnozstvo",
  "zmen mnozstvo",
  "change quantity",
  "add quantity",
];

// =============================================================================
// Holé navigačné príkazy (Voice Phase 2, bod 12 zadania).
//
// PREČO VÔBEC
// -----------
// "Otvor sklad" je najčastejší a najmenej nejednoznačný príkaz, aký appka
// dostane — a doteraz kvôli nemu musela volať jazykový model. To znamená
// sieťové volanie, latenciu a závislosť na dostupnosti služby pri príkaze,
// ktorý má presne jeden možný význam. Tieto sa preto vyhodnotia lokálne.
//
// PREČO TO NIE JE VEĽKÁ REGEXOVÁ TABUĽKA
// --------------------------------------
// Vetva je zámerne úzka: rozpozná IBA "sloveso + názov modulu" a nič iné.
// Nevie, aké moduly existujú — názov posunie ďalej ako `query` a modul
// priradí handleOpenModule(), ktorý už zoznam modulov má. Nevzniká tak
// druhý zoznam modulov, ktorý by sa musel udržiavať v súlade s prvým.
//
// Veta musí byť KRÁTKA (najviac štyri slová po odstránení slovesa). Vďaka
// tomu "otvor faktúru 2026001 od Testera" sem nespadne a ide bežnou cestou
// na vyhľadávanie faktúry. Zložitejšie príkazy naďalej klasifikuje model.
// =============================================================================
// Výhradne slovesá POHYBU. "Ukáž"/"zobraz"/"show"/"zeig" tu ZÁMERNE nie sú:
// nie sú to navigačné slovesá, ale dotazovacie ("ukáž neuhradené faktúry",
// "ukáž všetky stroje") a ich zachytenie sem by tichým spôsobom pripravilo
// používateľa o filter, ktorý vyslovil.
const NAVIGATION_VERBS = [
  // SK/CZ
  "otvor",
  "otvorte",
  "otevri",
  "prejdi do",
  "prejdi na",
  "chod do",
  "chod na",
  "prepni na",
  // DE
  "offne",
  "oeffne",
  "offnen sie",
  "geh zu",
  "gehe zu",
  "wechsle zu",
  // EN
  "open",
  "go to",
  "navigate to",
  "switch to",
];

// Vytvorenie faktúry rečou. Kmene sú zámerne krátke a musia sa vyskytnúť
// OBA — sloveso aj podstatné meno. Samotné "faktúra" znamená hľadanie,
// samotné "vytvor" zakladanie zložky; až spolu znamenajú nový doklad.
const INVOICE_CREATION_VERBS = [
  "vytvor", "vystav", "sprav", "urob", "zaloz",
  "erstelle", "erstellen", "schreibe",
  "create", "make", "issue", "raise",
];
const INVOICE_CREATION_NOUNS = ["faktur", "rechnung", "invoice"];

function matchesInvoiceCreation(text: string): boolean {
  return (
    INVOICE_CREATION_VERBS.some((verb) => text.includes(verb)) &&
    INVOICE_CREATION_NOUNS.some((noun) => text.includes(noun))
  );
}

/** Členy, ktoré pred názvom modulu nič neznamenajú ("öffne die Rechnungen"). */
const NAVIGATION_ARTICLES = new Set(["the", "die", "der", "das", "den", "dem"]);

/**
 * Slová, ktoré z vety robia DOTAZ, nie navigáciu. Keď sa vo zvyšku objaví
 * čokoľvek z tohto zoznamu, vetva sa nechytá a príkaz ide bežnou cestou —
 * aby sa "otvor neuhradené faktúry" nezmenilo na "otvor faktúry".
 */
const NAVIGATION_DISQUALIFIERS = [
  "vsetk", "alle", "all",
  "neuhraden", "uhraden", "unpaid", "paid", "offene", "bezahlt",
  "po splatnosti", "overdue", "falig",
  "vydan", "prijat", "issued", "received", "ausgang", "eingang",
  "draft", "rozpracovan",
];

/**
 * Vráti to, čo za navigačným slovesom nasleduje — alebo `undefined`, keď
 * veta navigačný príkaz nie je.
 */
function readBareNavigationTarget(text: string): string | undefined {
  // Najdlhšie sloveso vyhráva, aby "prejdi do" nezostalo pri "prejdi".
  const verbs = [...NAVIGATION_VERBS].sort((a, b) => b.length - a.length);

  for (const verb of verbs) {
    if (!text.startsWith(`${verb} `)) continue;

    const rest = text.slice(verb.length).trim().replace(/[.?!]+$/, "");
    if (!rest) return undefined;

    // Číslica vo zvyšku znamená konkrétnu entitu ("otvor faktúru 2026001"),
    // nie modul.
    if (/\d/.test(rest)) return undefined;

    if (NAVIGATION_DISQUALIFIERS.some((stem) => rest.includes(stem))) return undefined;

    const words = rest.split(/\s+/).filter((word) => !NAVIGATION_ARTICLES.has(word));

    // Jedno až dve slová ("sklad", "obchodni partneri"). Čokoľvek dlhšie je
    // veta, nie príkaz — a patrí modelu.
    if (words.length === 0 || words.length > 2) return undefined;

    return words.join(" ");
  }

  return undefined;
}

// =============================================================================
// Zložky dokumentov (custom_document_categories) — "Vytvor zložku X.",
// "Premenuj zložku X na Y.", "Daj/Priraď [filter] do zložky X." (doplnenie
// zadania, sekcie 7/10/12). Bežia PROTI PÔVODNÉMU `rawText` (nie
// diakritiku-zbavenému `text`), aby zachytený názov zložky ostal presne
// tak, ako ho používateľ napísal/vyslovil ("Reklamácie", nie "reklamacie")
// — appka si nikdy nevymýšľa/neupravuje meno zložky. `i` flag pokrýva
// veľké/malé písmená bez potreby normalizácie.
// =============================================================================
const CREATE_CATEGORY_REGEX = /(?:vytvor|vytvoriť)\s+zložku\s+(.+)$/i;
const CREATE_CATEGORY_REGEX_EN = /create\s+(?:folder|category)\s+(.+)$/i;
const CREATE_CATEGORY_REGEX_DE = /erstelle\s+(?:ordner|kategorie)\s+(.+)$/i;

const RENAME_CATEGORY_REGEX = /premenuj\s+zložku\s+(.+?)\s+na\s+(.+)$/i;
const RENAME_CATEGORY_REGEX_EN = /rename\s+(?:folder|category)\s+(.+?)\s+to\s+(.+)$/i;
const RENAME_CATEGORY_REGEX_DE = /benenne\s+(?:ordner|kategorie)\s+(.+?)\s+(?:in|auf)\s+(.+?)\s*um$/i;

// Zámerne NEVYŽADUJE konkrétne úvodné sloveso ("daj"/"priraď"/"assign"/
// "put") — samotná fráza "do zložky X"/"into folder X" je dostatočne
// jednoznačný signál ASSIGN zámeru (nekoliduje s CREATE/RENAME vzormi
// vyššie, ktoré túto frázu neobsahujú), takže postačuje jeden all-purpose
// regex namiesto zoznamu synoným pre sloveso.
const ASSIGN_TO_CATEGORY_REGEX =
  /^(.*?)(?:do\s+zložky|into\s+folder|to\s+folder|in\s+den\s+ordner|in\s+die\s+kategorie)\s+(.+)$/i;

/** Orezanie zachyteného mena zložky (regex capture group) o koncovú
 * interpunkciu vety — rovnaký princíp ako build() pre `query` nižšie,
 * aplikovaný tu manuálne, lebo tieto 3 polia (categoryName/newCategoryName/
 * targetCategoryName) cez build()'s existujúcu `args.query` logiku
 * neprechádzajú. */
function cleanCapturedName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/[.?!,;:]+\s*$/, "").trim();
  return trimmed || undefined;
}

// Frázy naznačujúce "od dodávateľa/zákazníka X" — zvyšok textu za frázou sa
// použije ako voľný `query` (ilike na supplier/customer stĺpce), nikdy sa
// nehádá meno dodávateľa mimo toho, čo je v texte doslova napísané.
const SUPPLIER_PHRASES = [
  "od dodavatela",
  "od dodavatelom",
  "from supplier",
  "von lieferant",
];

// Typovo-špecifické slovníky pre `documents.document_type` (bod 2 a 7
// doplnenia zadania — appka musí rozumieť "bločky"/"faktúry"/"vážne
// lístky"/"dodacie listy" atď. ako CELÉ, prirodzené vety, nie iba
// naučeným zoznamom pevných fráz). Anglické/nemecké/slovenské varianty sú
// zámerne krátke KMENE (nie plný slovník skloňovania) — rovnaký princíp
// ako existujúci STK_WORDS/EK_WORDS vyššie — overené proti REÁLNYM
// hodnotám v produkčnej DB (documents_document_type_check, lib/i18n/
// dictionaries/{sk,de,en}.ts#inbox.documentTypes), nie vymyslené.
const DOCUMENT_TYPE_KEYWORDS: { type: DocumentTypeFilter; words: string[] }[] = [
  {
    type: "weigh_ticket",
    words: ["vazny listok", "vazne listky", "vaznych listkov", "wiegeschein", "weigh ticket"],
  },
  {
    type: "delivery_note",
    words: ["dodaci list", "dodacie listy", "dodacich listov", "lieferschein", "delivery note"],
  },
  { type: "invoice", words: ["faktur", "rechnung", "invoice"] },
  { type: "receipt", words: ["blocek", "blocky", "blockov", "bloceku", "beleg", "receipt"] },
  { type: "insurance", words: ["pzp", "poistn", "versicherung", "insurance"] },
  {
    type: "vehicle_registration",
    words: [
      "technicky preukaz",
      "technickeho preukazu",
      "fahrzeugschein",
      "registration certificate",
      "vehicle registration",
    ],
  },
  {
    type: "service_document",
    words: ["servisny doklad", "servicebeleg", "service document"],
  },
];

/**
 * Vytiahne VŠETKY spomenuté typy dokumentov v texte ("Ukáž bločky a
 * faktúry." → ["receipt","invoice"]) — doplnenie zadania, "multi-type
 * filter": pôvodná verzia (detectDocumentType, jednotné číslo) vracala iba
 * PRVÚ zhodu, takže kombinované vety ako "bločky a faktúry" alebo "PZP a
 * technické preukazy" stratili druhý typ. Poradie zhody v texte sa
 * nezachováva (nie je podstatné — handler filtruje `IN (...)`, nie podľa
 * poradia), duplicity sa nikdy nepridajú dvakrát.
 */
function detectDocumentTypes(text: string): DocumentTypeFilter[] {
  const types: DocumentTypeFilter[] = [];
  for (const entry of DOCUMENT_TYPE_KEYWORDS) {
    if (!types.includes(entry.type) && entry.words.some((w) => text.includes(w))) {
      types.push(entry.type);
    }
  }
  return types;
}

/**
 * Vytiahne KONKRÉTNE typy termínov spomenuté v texte ("STK a EK" →
 * ["STK","EK"]) — znovupoužíva rovnaké STK_WORDS/EK_WORDS/VIGNETTE_WORDS/
 * SERVICE_WORDS slovníky ako branch 6/5 nižšie (jeden zdroj pravdy na
 * detekciu daného typu, nie duplicitný zoznam). Prázdne pole (žiadny
 * konkrétny typ nespomenutý) → handler nefiltruje, správa sa presne ako
 * doteraz (všetky typy) — nikdy sa nehádaní žiadny typ navyše.
 */
function detectDeadlineTypes(text: string, hasMachineContextFlag: boolean): DeadlineTypeFilter[] {
  const types: DeadlineTypeFilter[] = [];
  if (containsAny(text, STK_WORDS)) types.push("STK");
  if (containsAny(text, EK_WORDS)) types.push("EK");
  if (containsAny(text, VIGNETTE_WORDS)) types.push("VIGNETTE");
  if (containsAny(text, SERVICE_WORDS)) {
    types.push(hasMachineContextFlag ? "MACHINE_SERVICE" : "VEHICLE_SERVICE");
  }
  return types;
}

// Mesiace SK/CZ/DE/EN, normalizované (bez diakritiky) — použité pre "za
// august", "im august", "in august" a pod. Hraničné \b zámerne (namiesto
// plain .includes) — niektoré kmene sú krátke (napr. "maj", "jun", "jul")
// a bez hraníc by sa mohli zhodovať s časťou iného slova.
const MONTH_NAMES: readonly (readonly [number, readonly string[]])[] = [
  [0, ["januar", "january"]],
  [1, ["februar", "february"]],
  [2, ["marec", "marz", "march"]],
  [3, ["april"]],
  [4, ["maj", "mai", "may"]],
  [5, ["jun", "juni", "june"]],
  [6, ["jul", "juli", "july"]],
  [7, ["august"]],
  [8, ["september"]],
  [9, ["oktober", "october"]],
  [10, ["november"]],
  [11, ["december", "dezember"]],
];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function firstDayOfMonthIso(year: number, month0: number): string {
  return `${year}-${pad2(month0 + 1)}-01`;
}

function lastDayOfMonthIso(year: number, month0: number): string {
  const lastDay = new Date(year, month0 + 1, 0).getDate();
  return `${year}-${pad2(month0 + 1)}-${pad2(lastDay)}`;
}

/**
 * Vytiahne dátumový rozsah z textu — "tento mesiac"/"tento rok" alebo
 * konkrétny názov mesiaca ("za august"). Rok sa NIKDY nedomýšľa z ničoho
 * iného než z aktuálneho kalendárneho dátumu (žiadny rok v texte v tejto
 * fáze nie je podporovaný cez deterministický parser — "za august 2025"
 * padne cez AI fallback, alebo sa mesiac zoberie a rok ostane aktuálny,
 * presne ako by si bežný kalendár vyložil holé "august"). Vracia aj
 * `matchedWord`, aby volajúci vedel presne tú frázu odstrániť z voľného
 * textu query.
 */
function extractDateRange(
  text: string
): { dateFrom: string; dateTo: string; matchedWord: string } | undefined {
  const now = new Date();

  const yearWord = THIS_YEAR_WORDS.find((w) => text.includes(w));
  if (yearWord) {
    const year = now.getFullYear();
    return { dateFrom: `${year}-01-01`, dateTo: `${year}-12-31`, matchedWord: yearWord };
  }

  const monthWord = THIS_MONTH_WORDS.find((w) => text.includes(w));
  if (monthWord) {
    return {
      dateFrom: firstDayOfMonthIso(now.getFullYear(), now.getMonth()),
      dateTo: lastDayOfMonthIso(now.getFullYear(), now.getMonth()),
      matchedWord: monthWord,
    };
  }

  for (const [monthIndex, words] of MONTH_NAMES) {
    for (const word of words) {
      if (new RegExp(`\\b${word}\\b`).test(text)) {
        return {
          dateFrom: firstDayOfMonthIso(now.getFullYear(), monthIndex),
          dateTo: lastDayOfMonthIso(now.getFullYear(), monthIndex),
          matchedWord: word,
        };
      }
    }
  }

  return undefined;
}

/** "za 86 eur" / "for 86 euros" / "für 86 euro" — nikdy sa nedomýšľa mena. */
function extractAmount(text: string): { amount: number; matchedText: string } | undefined {
  const match = text.match(/(\d+(?:[.,]\d{1,2})?)\s*(eur|euro|eura|€)/);
  if (!match) return undefined;
  const value = Number(match[1].replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  return { amount: value, matchedText: match[0] };
}

/** "od dodávateľa X" → zvyšok za frázou je voľný text (dodávateľ/zákazník). */
function extractSupplierQuery(text: string): { query: string; matchedTail: string } | undefined {
  for (const phrase of SUPPLIER_PHRASES) {
    const idx = text.indexOf(phrase);
    if (idx < 0) continue;
    const rest = text
      .slice(idx + phrase.length)
      .replace(/[.?!,]+\s*$/, "")
      .trim();
    // matchedTail = celý "chvost" textu od frázy po koniec (fráza + zvyšok)
    // — použije sa na odstránenie z textu pri výpočte voľného query nižšie.
    if (rest) return { query: rest, matchedTail: text.slice(idx) };
  }
  return undefined;
}

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
  const hasVehicleContext = containsAny(text, VEHICLE_CONTEXT_WORDS);
  const hasInventoryContext =
    containsAny(text, INVENTORY_CONTEXT_WORDS) || containsAny(text, INVENTORY_ITEM_NOISE_WORDS);

  // 0) Vedome nepodporované príkazy (§16C/§24G doplnenia zadania) — MUSÍ
  //    bežať PRED každou inou vetvou (pozri komentár pri
  //    UNSUPPORTED_ACTION_STEMS vyššie), inak by sa deštruktívny/nepodporovaný
  //    príkaz mohol tichým pádom zmeniť na iný, neúmyselný intent.
  if (containsAny(text, UNSUPPORTED_ACTION_STEMS)) {
    return null;
  }

  // 0b) Vytvorenie faktúry — deterministický parser sa ho NESMIE dotknúť.
  //
  //     "Vytvor faktúru pre Tester1 za kopanie 300 eur." obsahuje slovo
  //     "faktúr", ktoré je nižšie rozpoznané ako TYP DOKUMENTU — bez tohto
  //     kroku by príkaz skončil ako SEARCH_DOCUMENTS a zobrazil zoznam
  //     dokladov namiesto založenia faktúry. Príkaz sa preto vracia ako
  //     nerozpoznaný a preberá ho klasifikátor, ktorý z vety vie vytiahnuť
  //     aj odberateľa a predmet (pozri lib/intents/ai-fallback.ts).
  //
  //     Odovzdanie modelu tu NIE JE oslabenie: klasifikátor môže vrátiť
  //     jedine intent z allowlistu a oprávnenia aj tak drží server a RLS.
  if (matchesInvoiceCreation(text)) {
    return null;
  }

  // 0c) Holý navigačný príkaz ("otvor sklad", "open inventory", "öffne
  //     Lager") — pozri NAVIGATION_VERBS vyššie.
  const navigationTarget = readBareNavigationTarget(text);
  if (navigationTarget) {
    return build("OPEN_MODULE", { query: navigationTarget });
  }

  // 1) Deadline-dotazy ("čo mi končí", "aké termíny treba riešiť", "čo je
  //    po lehote/splatnosti/termíne", "ktorým vozidlám končí diaľničná
  //    známka") — nemajú ŠPZ, sú to dotazy na CELÚ firmu, nie na jednu
  //    entitu, preto sa vyhodnocujú PRED vozidlovými pravidlami nižšie.
  //    `expiryTrigger` je zámerne úzky (DEADLINE_EXPIRY_WORDS samo osebe
  //    NESTAČÍ) — vyžaduje AJ explicitné STK/EK/VIGNETTE slovo a chýbajúcu
  //    ŠPZ, aby napr. "Kedy končí servis bagra CAT 302?" (jeden konkrétny
  //    stroj, žiadny STK/EK/VIGNETTE) naďalej padol do branch 5
  //    (SHOW_MACHINE_SERVICE), nie sem.
  const expiryTrigger =
    containsAny(text, DEADLINE_EXPIRY_WORDS) &&
    !plate &&
    (containsAny(text, STK_WORDS) || containsAny(text, EK_WORDS) || containsAny(text, VIGNETTE_WORDS));
  if (containsAny(text, DEADLINE_QUERY_WORDS) || containsAny(text, OVERDUE_WORDS) || expiryTrigger) {
    const deadlineTypes = detectDeadlineTypes(text, hasMachineContext);
    return build("UPCOMING_DEADLINES", {
      onlyOverdue: containsAny(text, OVERDUE_WORDS),
      withinDays: parseWithinDays(text),
      deadlineTypes: deadlineTypes.length > 0 ? deadlineTypes : undefined,
    });
  }

  // 1b) LIST požiadavky ("Ukáž všetky stroje.", "Aké vozidlá máme?", "Ukáž
  //     všetky skladové položky.") — používateľ chce ZOZNAM VŠETKÝCH
  //     záznamov danej entity, nie textové vyhľadávanie. MUSÍ bežať PRED
  //     vetvami 7/8 nižšie (voľné vyhľadávanie strojov/skladu/vozidiel),
  //     inak by "všetky"/"aké...máme" skončilo ako doslovný query text,
  //     ktorý sa nikdy nezhoduje so žiadnym reálnym názvom (presne bug 1 z
  //     produkčného testu). Rozlíšenie vozidlo/stroj/sklad je podľa toho,
  //     KTORÝ JEDEN kontextový slovník sa vo vete našiel — ak je viac než
  //     jeden, alebo žiadny, táto vetva zámerne nič nevráti (fail-closed,
  //     zadanie bod 6 — radšej padne na AI fallback/otázku, než aby hádala).
  const isListQuantified = containsAny(text, LIST_ALL_QUANTIFIER_WORDS) || matchesWhatDoWeHavePattern(text);
  if (isListQuantified) {
    const matchedContexts = [hasVehicleContext && !plate, hasMachineContext, hasInventoryContext].filter(
      Boolean
    ).length;
    if (matchedContexts === 1) {
      if (hasVehicleContext && !plate) return build("SEARCH_VEHICLE", { listAll: true });
      if (hasMachineContext) return build("SEARCH_MACHINE", { listAll: true });
      if (hasInventoryContext) return build("SEARCH_INVENTORY_ITEM", { listAll: true });
    }
  }

  // 1c) Stav skladovej položky ("Aký máme zostatok pre položku sprej?",
  //     "Koľko máme spreja?", "Koľko kusov spreja máme?", "Máme ešte
  //     sprej?", "Aký je stav položky sprej?") — vracia PRIAMU odpoveď s
  //     reálnym množstvom/jednotkou (INVENTORY_ITEM_STATUS), nie zoznam
  //     odkazov ako SEARCH_INVENTORY_ITEM nižšie. Scope zámerne úzky: iba
  //     keď vo vete NIE JE vozidlový ani strojový kontext ("zostatok"/
  //     "koľko máme" dáva v Esblu zmysel iba pre skladovú zásobu — vozidlá
  //     a stroje sú jednotlivo evidované kusy, nie sklad), inak fail-closed
  //     (nič sa tu nevráti, padne ďalej/na AI fallback).
  const isInventoryStatusQuery =
    containsAny(text, INVENTORY_STATUS_TRIGGER_WORDS) && !hasVehicleContext && !hasMachineContext;
  if (isInventoryStatusQuery) {
    const query = extractFreeQuery(text, [
      ...INVENTORY_STATUS_QUESTION_STEMS,
      ...INVENTORY_CONTEXT_WORDS,
      ...INVENTORY_ITEM_NOISE_WORDS,
    ]);
    if (query) return build("INVENTORY_ITEM_STATUS", { query });
  }

  // 1d) Vytvorenie zložky dokumentov ("Vytvor zložku Reklamácie.") — WRITE
  //     intent, vracia iba `action_preview` (potvrdenie v UI pred zápisom,
  //     pozri lib/intents/actions.ts).
  const createCategoryMatch =
    rawText.match(CREATE_CATEGORY_REGEX) ||
    rawText.match(CREATE_CATEGORY_REGEX_EN) ||
    rawText.match(CREATE_CATEGORY_REGEX_DE);
  if (createCategoryMatch) {
    const categoryName = cleanCapturedName(createCategoryMatch[1]);
    if (categoryName) return build("CREATE_DOCUMENT_CATEGORY", { categoryName });
  }

  // 1e) Premenovanie zložky ("Premenuj zložku Servis na Servis 2026.") —
  //     WRITE intent, owner/admin only (vynucuje handler/RLS, pozri
  //     lib/intents/actions.ts), vracia iba `action_preview`.
  const renameCategoryMatch =
    rawText.match(RENAME_CATEGORY_REGEX) ||
    rawText.match(RENAME_CATEGORY_REGEX_EN) ||
    rawText.match(RENAME_CATEGORY_REGEX_DE);
  if (renameCategoryMatch) {
    const categoryName = cleanCapturedName(renameCategoryMatch[1]);
    const newCategoryName = cleanCapturedName(renameCategoryMatch[2]);
    if (categoryName && newCategoryName) {
      return build("RENAME_DOCUMENT_CATEGORY", { categoryName, newCategoryName });
    }
  }

  // 1f) Hromadné priradenie dokumentov do zložky ("Daj všetky bločky za
  //     august do zložky August.", "Priraď faktúry do zložky Servis.") —
  //     WRITE intent, vracia iba `action_preview` (server pri potvrdení
  //     VŽDY prepočíta dotknuté dokumenty nanovo z týchto filtrov — nikdy
  //     sa neverí zoznamu ID od klienta, pozri lib/intents/actions.ts).
  //     Vozidlo/stroj filter v tejto fáze zámerne NIE JE podporovaný — ak
  //     veta obsahuje rozpoznanú ŠPZ, radšej nič nevrátime (fail-closed),
  //     než aby appka hromadne priradila VIAC dokumentov, než používateľ
  //     mal na mysli (bod 6 doplnenia zadania).
  const assignToCategoryMatch = rawText.match(ASSIGN_TO_CATEGORY_REGEX);
  if (assignToCategoryMatch) {
    if (plate) {
      // Fail-closed: veta jednoznačne znie ako ASSIGN príkaz ("...do zložky
      // X"), ale obsahuje aj ŠPZ, ktorú ASSIGN_DOCUMENTS_TO_CATEGORY v tejto
      // fáze nepodporuje (komentár vyššie) — appka to NIKDY nesmie tichým
      // pádom do inej vetvy (napr. branch 4 nižšie) zmeniť na iný,
      // neúmyselný príkaz (napr. obyčajné zobrazenie dokumentov vozidla),
      // preto sa vracia null priamo tu namiesto pokračovania ďalej.
      return null;
    }
    const targetCategoryName = cleanCapturedName(assignToCategoryMatch[2]);
    const filterText = normalizeText(assignToCategoryMatch[1] || "");
    const filterDocumentTypes = detectDocumentTypes(filterText);
    const filterDateRange = extractDateRange(filterText);
    if (targetCategoryName && (filterDocumentTypes.length > 0 || filterDateRange)) {
      return build("ASSIGN_DOCUMENTS_TO_CATEGORY", {
        documentTypes: filterDocumentTypes.length > 0 ? filterDocumentTypes : undefined,
        dateFrom: filterDateRange?.dateFrom,
        dateTo: filterDateRange?.dateTo,
        targetCategoryName,
      });
    }
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

  // 4) Dokumenty — "ukáž dokumenty TT123AB" (DE/EN ekvivalenty), ALE aj
  //    celé prirodzené vety s KOMBINÁCIOU typov dokumentu/dátumovým
  //    rozsahom/dodávateľom/sumou ("Ukáž bločky za august.", "Ukáž bločky
  //    a faktúry.", "Ukáž PZP a technické preukazy.", "Ukáž faktúry od
  //    dodávateľa X.", "Nájdi bloček za 86 eur.", "Exportuj bločky a
  //    faktúry za august." — `isExportRequest` iba PREPÍNA výsledný
  //    intent na EXPORT_DOCUMENTS namiesto SEARCH_DOCUMENTS, filtre sú
  //    úplne rovnaké; export sa NIKDY nevykoná automaticky — vracia iba
  //    `action_preview`, pozri lib/intents/actions.ts).
  //    So ŠPZ ide vždy o SHOW_VEHICLE_DOCUMENTS (dokumenty JEDNÉHO
  //    vozidla, bez EXPORT_DOCUMENTS varianty v tejto fáze — pozri report);
  //    bez ŠPZ ide o celofiremné SEARCH_DOCUMENTS/EXPORT_DOCUMENTS.
  {
    const documentTypes = detectDocumentTypes(text);
    const dateRange = extractDateRange(text);
    const amount = extractAmount(text);
    const supplier = extractSupplierQuery(text);
    const isExportRequest = containsAny(text, EXPORT_WORDS);

    const triggered =
      containsAny(text, DOCUMENTS_WORDS) ||
      containsAny(text, DOCUMENT_SEARCH_WORDS) ||
      isExportRequest ||
      documentTypes.length > 0;

    if (triggered) {
      if (plate) {
        return build("SHOW_VEHICLE_DOCUMENTS", {
          query: plate,
          documentTypes: documentTypes.length > 0 ? documentTypes : undefined,
          dateFrom: dateRange?.dateFrom,
          dateTo: dateRange?.dateTo,
        });
      }

      // Voľný text query: ak sme rozpoznali "od dodávateľa X", TO je
      // zámer (presne to, čo je za frázou). Ak sme rozpoznali ŠTRUKTÚROVANÝ
      // filter (typ dokumentu/dátum/suma), NEODVODZUJEME popri ňom ešte
      // aj "zvyšok vety" ako voľný text — po odstránení kmeňa typu
      // dokumentu (napr. "faktur" z "faktúry") by v texte často zostali
      // useless zvyšky písmen ("y za august"), ktoré by ako ILIKE filter
      // iba falošne zúžili/zhodili inak správny výsledok. Iba keď sme
      // NEROZPOZNALI žiadny štruktúrovaný filter, zachováme pôvodné,
      // jednoduché "celý zvyšok vety = voľný text" správanie.
      let freeText: string | undefined;
      if (supplier) {
        freeText = supplier.query;
      } else if (documentTypes.length === 0 && !dateRange && !amount) {
        const remainder = stripKeywords(text, [
          ...DOCUMENTS_WORDS,
          ...DOCUMENT_SEARCH_WORDS,
          ...OPEN_WORDS,
          ...EXPORT_WORDS,
        ]);
        freeText = remainder || undefined;
      }

      const args: IntentArgs = {
        query: freeText,
        documentTypes: documentTypes.length > 0 ? documentTypes : undefined,
        dateFrom: dateRange?.dateFrom,
        dateTo: dateRange?.dateTo,
        amount: amount?.amount,
      };

      if (args.query || (args.documentTypes && args.documentTypes.length > 0) || args.dateFrom || args.amount !== undefined) {
        return build(isExportRequest ? "EXPORT_DOCUMENTS" : "SEARCH_DOCUMENTS", args);
      }
    }
  }

  // 5) Servisná história ("ukáž servis TT123AB" / "ukáž servis bagra CAT
  //    302" — POZOR na skloňovanie "bagra", pozri stripWholeWordsStartingWith
  //    vyššie).
  if (containsAny(text, SERVICE_WORDS)) {
    if (hasMachineContext) {
      const query = extractFreeQuery(text, [
        ...SERVICE_WORDS,
        ...MACHINE_CONTEXT_WORDS,
        ...OPEN_VERB_STEMS,
      ]);
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

  // 7) Explicitné "nájdi/otvor/ukáž/zobraz/find/show/finde" — rozhoduje
  //    kontext. Ak po odstránení kontextového slovníka NEZOSTANE žiadny
  //    voľný text (napr. "Ukáž sklad."/"Ukáž stroje." — iba príkaz +
  //    kontextové slovo, žiadny konkrétny identifikátor), ide sémanticky o
  //    LIST požiadavku (rovnaká logika ako branch 1b vyššie, iba bez
  //    explicitného "všetky"), nie o vyhľadávanie prázdneho reťazca.
  if (containsAny(text, OPEN_WORDS)) {
    const query = stripKeywords(text, OPEN_WORDS);
    if (hasInventoryContext) {
      const itemQuery = extractFreeQuery(query, [
        ...INVENTORY_CONTEXT_WORDS,
        ...INVENTORY_ITEM_NOISE_WORDS,
      ]);
      if (!itemQuery) return build("SEARCH_INVENTORY_ITEM", { listAll: true });
      return build("OPEN_INVENTORY_ITEM", { query: itemQuery });
    }
    if (hasMachineContext) {
      const machineQuery = extractFreeQuery(query, MACHINE_CONTEXT_WORDS);
      if (!machineQuery) return build("SEARCH_MACHINE", { listAll: true });
      return build("OPEN_MACHINE", { query: machineQuery });
    }
    if (hasVehicleContext && !plate) {
      const vehicleQuery = extractFreeQuery(query, VEHICLE_CONTEXT_WORDS);
      if (!vehicleQuery) return build("SEARCH_VEHICLE", { listAll: true });
    }
    if (plate) return build("OPEN_VEHICLE", { query: plate });
    if (query) return build("OPEN_VEHICLE", { query });
  }

  // 8) Voľné vyhľadávanie vozidiel/strojov/skladu bez "nájdi" ("bager CAT
  //    302", "skladová položka spray", "spray v sklade") — rovnaká
  //    prázdna-query→listAll logika ako branch 7 vyššie ("Sklad."/
  //    "Stroje." samostatne = LIST, nie vyhľadávanie prázdneho textu).
  if (hasInventoryContext) {
    const query = extractFreeQuery(text, [...INVENTORY_CONTEXT_WORDS, ...INVENTORY_ITEM_NOISE_WORDS]);
    if (query) return build("SEARCH_INVENTORY_ITEM", { query });
    return build("SEARCH_INVENTORY_ITEM", { listAll: true });
  }
  if (hasMachineContext) {
    const query = extractFreeQuery(text, MACHINE_CONTEXT_WORDS);
    if (query) return build("SEARCH_MACHINE", { query });
    return build("SEARCH_MACHINE", { listAll: true });
  }
  if (hasVehicleContext && !plate) {
    const query = extractFreeQuery(text, VEHICLE_CONTEXT_WORDS);
    if (!query) return build("SEARCH_VEHICLE", { listAll: true });
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

// Koncová interpunkcia vety ("AB698CT.", "CAT 302.", "X.") sa do voľného
// textu query dostáva prirodzene (transkript celej vety sa už NESMIE
// skracovať — bod 1 doplnenia zadania), preto sa odstraňuje tu, na JEDNOM
// mieste, cez ktoré prechádza KAŽDÝ vytvorený ParsedIntent — nie
// duplicitne pri každej vetve vyššie. `plate`/dátumové/číselné hodnoty
// touto úpravou nie sú dotknuté (normalizeSpz už nemá interpunkciu, ISO
// dátumy a čísla tiež nie).
function build(name: IntentName, args: ParsedIntent["args"]): ParsedIntent {
  const cleanedArgs = { ...args };
  if (cleanedArgs.query) {
    const trimmed = cleanedArgs.query.replace(/[.?!,;:]+$/, "").trim();
    cleanedArgs.query = trimmed || undefined;
  }
  cleanedArgs.categoryName = cleanCapturedName(cleanedArgs.categoryName);
  cleanedArgs.newCategoryName = cleanCapturedName(cleanedArgs.newCategoryName);
  cleanedArgs.targetCategoryName = cleanCapturedName(cleanedArgs.targetCategoryName);
  return { name, args: cleanedArgs, source: "deterministic" };
}

// Exportované pre AI fallback prompt (lib/intents/ai-fallback.ts) a pre
// testy — zoznam príkladov kľúčových slov, ktoré si appka pri hľadaní
// deterministickej zhody prihliada; DRŽANÉ tu, aby AI fallback prompt vedel
// vysvetliť modelu, kedy sa deterministický parser sám nespustil (napr.
// nejednoznačný text), bez toho, aby duplikoval polia vyššie.
export const DEADLINE_DEFAULT_WINDOW_DAYS = DEADLINE_THRESHOLD_DAYS.dueSoon;
