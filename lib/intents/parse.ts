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
  "mame na sklade",
  "mame v sklade",
  "je na sklade",
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

/**
 * „Vytvor / Priprav / Založ / Vystav faktúru pre X", „Nová faktúra pre X",
 * „Erstelle eine Rechnung für X", „Create an invoice for X". Iba keď za
 * menom nič nenasleduje — veta s položkami či sumou patrí existujúcej
 * ceste (extractInvoiceSlotsFromText / klasifikátor).
 */
const SIMPLE_INVOICE_REGEX =
  /^\s*(?:((?:vytvor|priprav|zaloz|založ|vystav|sprav|urob|erstelle|erstellen|schreibe|create|make|issue|raise|prepare)\S*)(?:\s+mi)?\s+)?(?:(nov[úuáaý]|new|neue|eine|eine\s+neue|an|a)\s+)?(?:fakt[úu]r[ua]|rechnung|invoice)(?:\s+(?:pre|pro|für|fur|fuer|for)\s+(.+?))?\s*[.!?]?\s*$/i;

export function parseSimpleInvoiceCreation(rawText: string): ParsedIntent | null {
  const match = SIMPLE_INVOICE_REGEX.exec(rawText);
  if (!match) return null;
  // „Vytvor faktúru." bez odberateľa = ten istý draft; asistent sa spýta,
  // pre koho. Holé „Faktúra." (bez slovesa) je hľadanie, nie založenie.
  if (!match[3]) {
    return match[1] || /^(nov|new|neue)/i.test(match[2] ?? "") ? build("CREATE_INVOICE_DRAFT", {}) : null;
  }
  const name = match[3].replace(/^[„"'“]+|[”"'“]+$/g, "").trim();
  if (!name || name.split(/\s+/).length > 6) return null;
  // Suma, čiarka či „za …" znamenajú položky — to nie je holé založenie.
  if (/[,;:]|\d+\s*(?:eur|€)|\b(?:za|for|über|ueber)\b/i.test(name)) return null;
  return build("CREATE_INVOICE_DRAFT", { partnerQuery: name });
}

/**
 * Založenie faktúry s položkami alebo s menom bez predložky:
 * „Vytvor faktúru Tester1.", „Vytvor faktúru Tester1 za kopanie, …",
 * „Faktúru pre Tester1 za kopanie 300 eur", „Vytvor faktúru za kopanie 300 eur".
 *
 * Deterministicky — aby o tom, či ide o faktúru, nerozhodoval AI
 * klasifikátor (produkčná chyba: taká veta skončila otázkou na stroj či
 * vozidlo). Z vety sa berie IBA meno odberateľa; položky a sumy číta
 * extractInvoiceSlotsFromText z celej vety a partnera overí server.
 */
const RICH_INVOICE_REGEX =
  /^\s*(?:((?:vytvor|priprav|zaloz|založ|vystav|sprav|urob|erstelle|erstellen|schreibe|create|make|issue|raise|prepare)\S*)(?:\s+mi)?\s+)?(?:(nov[úuáaý]|new|neue|eine\s+neue|eine|an|a)\s+)?(?:fakt[úu]r[ua]|rechnung|invoice)(?=[\s,.:;!?]|$)[\s,:;]*(.*)$/i;
const INVOICE_CUSTOMER_PREPOSITION = /^(pre|pro|für|fur|fuer|for)\s+/i;
const INVOICE_ITEMS_START = /\s(za|fuer|für|for|über|ueber)\s|[,;:]|\s(s|so|bez|mit|ohne|with|without)\s+(dph|mwst|vat)/i;

export function parseInvoiceCreation(rawText: string): ParsedIntent | null {
  const match = RICH_INVOICE_REGEX.exec(rawText);
  if (!match) return null;
  const rest = (match[3] ?? "").trim();
  const hasPreposition = INVOICE_CUSTOMER_PREPOSITION.test(rest);
  // Bez slovesa, bez „nová" a bez „pre X" je „Faktúra …" hľadanie, nie založenie.
  if (!match[1] && !/^(nov|new|neue)/i.test(match[2] ?? "") && !hasPreposition) return null;
  if (!rest || /^(za|über|ueber)\s/i.test(rest)) return build("CREATE_INVOICE_DRAFT", {});

  const afterPreposition = rest.replace(INVOICE_CUSTOMER_PREPOSITION, "");
  const cut = afterPreposition.search(INVOICE_ITEMS_START);
  const name = (cut >= 0 ? afterPreposition.slice(0, cut) : afterPreposition)
    .replace(/[.!?]+$/, "")
    .replace(/^[„"'“]+|[”"'“]+$/g, "")
    .trim();
  // Meno s sumou („kopanie 300 eur") alebo dlhá veta nie je meno odberateľa.
  if (!name || name.split(/\s+/).length > 6 || /\d+\s*(?:eur|euro|€|kc|czk)/i.test(name) || /^(nie|not|nicht|ale|but|aber)\b/i.test(name)) {
    return build("CREATE_INVOICE_DRAFT", {});
  }
  return build("CREATE_INVOICE_DRAFT", { partnerQuery: name });
}

/**
 * Faktúra, z ktorej prepis reči STRATIL slovo „faktúru":
 * „Vytvor testér jedna za kopanie materiál, odvoz materiálu, pracovníci za
 * 10 831 eur s DPH."
 *
 * Rozhoduje súhrn dôkazov, nie jedno slovo:
 *   - veta začína slovesom založenia (vytvor / vystav / priprav …),
 *   - obsahuje predmet uvedený „za …" a sumu S MENOU,
 *   - nepomenúva žiadnu inú oblasť (stroj, vozidlo, sklad, priečinok,
 *     partner, doklad …) a nie je to servisná veta.
 * Meno odberateľa je text medzi slovesom a prvým „za"; server ho VŽDY overí
 * proti existujúcim partnerom (hovorený tvar „testér jedna" → návrh
 * „Myslíte Tester1?"). Nič sa nezakladá — ďalej ide bežný bezpečný dialóg
 * draftu faktúry a suma sa berie presne tak, ako zaznela.
 */
const RECOVERY_VERB = /^\s*(?:pros[ií]m\s+)?(vytvor|vystav|priprav|sprav|urob|zaloz|založ)\S*\s+(?:mi\s+)?(.+)$/i;
const OTHER_DOMAIN_WORDS = [
  "stroj", "vozidl", "auto", "spz", "sklad", "polozk", "priecin", "zlozk", "kategori", "partner", "zakazn",
  "odberatel", "dodavatel", "firm", "spolocnost", "doklad", "bloc", "dodaci", "vazn", "dokument", "priloh",
  "export", "stiahn", "fotk", "foto", "report", "zostav", "servis", "oprav", "udrzb",
  "folder", "machine", "vehicle", "inventory", "rechnung", "invoice", "faktur",
];

export function recoverInvoiceWithoutNoun(rawText: string): ParsedIntent | null {
  const match = RECOVERY_VERB.exec(rawText);
  if (!match) return null;
  const text = normalizeText(rawText);
  if (OTHER_DOMAIN_WORDS.some((word) => new RegExp(`(^|[^a-z])${word}`).test(text))) return null;
  if (isServiceUtterance(rawText)) return null;
  const rest = match[2];
  const za = rest.search(/(^|\s)za\s/i);
  if (za < 0) return null;
  // Suma s menou („10 831 eur", „300 €") — bez nej to nie je dosť dôkazov.
  if (!/\d[\d   ]*(?:[.,]\d+)?\s*(?:€|eur|euro|eura|eurov)(?![a-z])/i.test(rest)) return null;
  const name = rest.slice(0, za).replace(/[,;:.]+$/, "").trim();
  if (!name) return build("CREATE_INVOICE_DRAFT", {});
  if (name.split(/\s+/).length > 4 || /\d+\s*(?:eur|€)/i.test(name) || /^(nov|new|neu)/i.test(normalizeText(name))) return null;
  return build("CREATE_INVOICE_DRAFT", { partnerQuery: name });
}

// -----------------------------------------------------------------------------
// Nový obchodný partner — „Vytvor obchodného partnera Tester2", „Pridaj
// zákazníka Firma ABC", „Vytvor firmu Stavby Kysuce s.r.o., IČO 12345678".
//
// Asistent partnera NEULOŽÍ: pripraví vyplnený formulár (existujúci model aj
// validácia v lib/business-partners.ts) a uloží ho človek. Z vety sa berú
// iba údaje, ktoré naozaj zazneli — nič sa nedopĺňa ani nevyhľadáva.
// -----------------------------------------------------------------------------
const PARTNER_CREATE_REGEX =
  /^\s*(?:pros[ií]m\s+)?(?:vytvor|pridaj|zaloz|založ|zaeviduj|zaregistruj|create|add|erstelle|lege)\S*\s+(?:mi\s+)?(?:(?:nov\S*|new|neue\S*|einen|eine|an|a)\s+)?(obchodn\S*\s+partner\S*|business\s+partner|gesch[aä]ftspartner\S*|partner\S*|z[aá]kazn[ií]k\S*|odberate\S*|dod[aá]vate\S*|klient\S*|firm[ua]|spolo[cč]nos[tť]|customer|supplier|client|company|kunde\S*|lieferant\S*|firma)(?=[\s,.:;!?]|$)[\s,:;]*(.*)$/i;
const PARTNER_FIELD_START = /,?\s*(?:i[cč]o|i[cč]\s|di[cč]|i[cč]\s*dph|so\s+s[ií]dlom|s[ií]dlo|adresa|company\s+id|firmennummer|ust|vat\s+id)\b/i;

function cleanPartnerName(raw: string): string {
  let name = raw.replace(/^[„"'“]+|[”"'“]+$/g, "").trim().replace(/[,;:]+$/, "").trim();
  // Koncová bodka je koniec vety — okrem právnej formy („s.r.o.", „a.s.").
  if (/\.$/.test(name) && !/(^|\s|\.)[a-z]\.$/i.test(name)) name = name.replace(/\.+$/, "").trim();
  name = name.replace(/\s+an$/i, "").trim(); // „Lege einen Kunden X an"
  return name.slice(0, 200);
}

/**
 * Hľadanie / otvorenie obchodného partnera: „Nájdi partnera X", „Otvor
 * zákazníka X", „Ukáž obchodných partnerov", „Find partner X". Meno overí
 * ZDIEĽANÝ resolver (lib/partner-resolver.ts) pod bránou finance view.
 * Veta s dokladom („faktúry od dodávateľa X") sem nepatrí.
 */
const PARTNER_SEARCH_REGEX =
  /^\s*(?:pros[ií]m\s+)?(?:n[aá]jdi|uk[aá][zž]|zobraz|otvor|vyh[lľ]adaj|h[lľ]adaj|find|show|open|search|finde|zeige?|[öo]ffne|oeffne|suche)\S*\s+(?:mi\s+)?(?:obchodn\S*\s+partner\S*|business\s+partners?|gesch[aä]ftspartner\S*|partner\S*|z[aá]kazn[ií]k\S*|odberate\S*|dod[aá]vate\S*|klient\S*|customers?|suppliers?|clients?|kunde\S*|lieferant\S*)(?=[\s,.:;!?]|$)[\s,:;]*(.*)$/i;

export function parsePartnerSearch(rawText: string): ParsedIntent | null {
  const match = PARTNER_SEARCH_REGEX.exec(rawText);
  if (!match) return null;
  if (/(faktur|rechnung|invoice|blocek|blocky|doklad|dokument)/.test(normalizeText(rawText))) return null;
  const name = cleanPartnerName(match[1] ?? "");
  return build("SEARCH_PARTNER", name ? { query: name } : {});
}

/**
 * Premenovanie: „Premenuj priečinok August na September", „Premenuj
 * (skladovú) položku Sprej na Sprej červený". Iba entity, ktoré UI dovoľuje
 * premenovať (priečinok dokladov, skladová položka). Doklady, faktúry ani
 * partneri sa hlasom nepremenúvajú.
 */
const RENAME_FOLDER_REGEX = /^\s*(?:premenuj|premenova[tť]|rename|benenne|umbenennen)\s+(?:mi\s+)?(?:priečin\S*|priecin\S*|folder|ordner|belegordner)\s+(.+?)\s+(?:na|to|in|zu)\s+(.+?)\s*[.!?]*$/i;
const RENAME_ITEM_REGEX = /^\s*(?:premenuj|premenova[tť]|rename|benenne|umbenennen)\s+(?:mi\s+)?(?:skladov\S*\s+)?(?:položk\S*|polozk\S*|item|artikel)\s+(.+?)\s+(?:na|to|in|zu)\s+(.+?)\s*[.!?]*$/i;

export function parseRenameIntent(rawText: string): ParsedIntent | null {
  const strip = (value: string) => value.replace(/^[„"'“]+|[”"'“]+$/g, "").trim();
  const folder = RENAME_FOLDER_REGEX.exec(rawText);
  if (folder) return build("FOLDER_RENAME", { folderName: strip(folder[1]), newName: strip(folder[2]) });
  const item = RENAME_ITEM_REGEX.exec(rawText);
  if (item) return build("INVENTORY_ITEM_RENAME", { query: strip(item[1]), newName: strip(item[2]) });
  return null;
}

/** „Otvor faktúru 2026001", „Nájdi faktúru č. FA-2026-7" → hľadanie faktúry podľa čísla. */
const INVOICE_NUMBER_READ_REGEX =
  /^\s*(?:otvor|uk[aá][zž]|n[aá]jdi|zobraz|vyh[lľ]adaj|open|show|find|[öo]ffne|oeffne|zeige?|finde)\S*\s+(?:mi\s+)?(?:fakt[uú]r\S*|rechnung|invoice)\s+(?:(?:č\.?|c\.?|číslo|cislo|number|no\.?|nr\.?)\s*)?([a-z]{0,4}[-/]?\d[\w/-]*)\s*[.!?]*$/i;

export function parseInvoiceNumberRead(rawText: string): ParsedIntent | null {
  const match = INVOICE_NUMBER_READ_REGEX.exec(rawText);
  return match ? build("SEARCH_INVOICE", { query: match[1] }) : null;
}

/** „Potrebujem / Chcem faktúru pre X" = založenie draftu (nie hľadanie). */
const NEED_INVOICE_REGEX =
  /^\s*(?:potrebujem|potreboval\S*\s+by\s+som|chcem|chcel\S*\s+by\s+som|treba|i\s+need|i\s+want|ich\s+brauche|ich\s+m[öo]chte)\s+(?:(?:nov\S*|new|neue\S*|an?|eine)\s+)?(?:fakt[uú]r\S*|rechnung|invoice)\s+(?:pre|pro|for|f[üu]r|fuer)\s+(.+?)\s*[.!?]*$/i;

export function parseNeedInvoice(rawText: string): ParsedIntent | null {
  const match = NEED_INVOICE_REGEX.exec(rawText);
  if (!match) return null;
  const cut = match[1].search(/\s(za|for|für|fuer)\s|[,;:]/i);
  const name = (cut >= 0 ? match[1].slice(0, cut) : match[1]).trim();
  return name && name.split(/\s+/).length <= 6 ? build("CREATE_INVOICE_DRAFT", { partnerQuery: name }) : build("CREATE_INVOICE_DRAFT", {});
}

export function parsePartnerCreate(rawText: string): ParsedIntent | null {
  const match = PARTNER_CREATE_REGEX.exec(rawText);
  if (!match) return null;
  const text = normalizeText(rawText);
  if (/(faktur|rechnung|invoice|blocek|blocky|doklad)/.test(text)) return null;
  const noun = normalizeText(match[1]);
  const rest = match[2] ?? "";
  const args: ParsedIntent["args"] = {};
  const cut = rest.search(PARTNER_FIELD_START);
  const name = cleanPartnerName(cut >= 0 ? rest.slice(0, cut) : rest);
  if (name) args.entityName = name;
  const ico = /i[cč]o\s*[:.]?\s*((?:\d\s?){6,8})(?!\d)/i.exec(rest) ?? /(?:company\s+id|firmennummer)\s*[:.]?\s*((?:\d\s?){6,8})(?!\d)/i.exec(rest);
  if (ico) args.partnerIco = ico[1].replace(/\s/g, "");
  const dic = /di[cč]\s*[:.]?\s*(\d{10})(?!\d)/i.exec(rest);
  if (dic) args.partnerDic = dic[1];
  const icDph = /(?:i[cč]\s*dph|vat\s+id|ust-?id\w*)\s*[:.]?\s*([a-z]{2}\s?\d{8,12})(?!\d)/i.exec(rest);
  if (icDph) args.partnerIcDph = icDph[1].replace(/\s/g, "").toUpperCase();
  if (/^(zakazn|odberate|klient|customer|client|kunde)/.test(noun)) args.partnerKind = "customer";
  else if (/^(dodavate|supplier|lieferant)/.test(noun)) args.partnerKind = "supplier";
  return build("PARTNER_CREATE", args);
}

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
  // „otvor položku skrutky" je skladová položka, nie modul
  "polozk", "item", "artikel",
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

// =============================================================================
// Priečinky dokladov a stav stiahnutia.
//
// Slovník je zámerne odlišný od „zložiek" (custom_document_categories):
//   SK „priečinok"  |  EN „accounting folder"  |  DE „Belegordner"
// Holé „folder"/„Ordner" ostáva pri zložkách, aby sa existujúce príkazy
// nezmenili potichu.
//
// Názov priečinka sa berie z PÔVODNÉHO textu (s diakritikou a veľkými
// písmenami) a nikdy sa nedomýšľa. Filter dokladov (typy, obdobie) sa číta
// z textu BEZ názvu priečinka — inak by priečinok „August 2026" sám osebe
// znamenal filter „za august".
// =============================================================================

const FOLDER_NOUN_REGEX = /(priečin\S*|priecin\S*|accounting\s+folders?|belegordner\S*|buchhaltungsordner\S*)/i;
const FOLDER_CREATE_VERBS = ["vytvor", "zaloz", "sprav", "urob", "priprav", "novy priecin", "create", "new accounting folder", "erstelle", "neuer belegordner", "anlegen"];
const FOLDER_OPEN_VERBS = ["otvor", "ukaz", "zobraz", "open", "show", "offne", "oeffne", "zeige"];
const FOLDER_LIST_WORDS = ["co je v", "obsah", "co obsahuje", "what is in", "whats in", "contents", "was ist in", "inhalt"];
const FOLDER_ADD_VERBS = ["daj", "pridaj", "vloz", "zarad", "presun", "hod", "add", "put", "move", "fuge", "fuege", "verschieb", "lege"];
const FOLDER_MOVE_VERBS = ["presun", "move", "verschieb"];
const FOLDER_REMOVE_VERBS = ["odober", "vyrad", "odstran", "remove", "take out", "entfern"];
const FOLDER_DELETE_VERBS = ["zmaz", "vymaz", "odstran", "zrus", "delete", "remove", "losch", "loesch", "entfern"];
/**
 * Rozkaz „stiahni", nie prídavné meno „stiahnuté". „Ukáž stiahnuté faktúry"
 * nesmie spustiť sťahovanie — preto iba rozkazovacie tvary a celé slovo
 * „download" (nie „downloaded").
 */
function wantsDownloadCommand(text: string): boolean {
  return (
    /(^|\s)(stiahni|stiahnite|stiahnime)(\s|$|[.,!?])/.test(text) ||
    /\bdownload\b(?!ed)/.test(text) ||
    /\bherunterladen\b/.test(text) ||
    /(^|\s)lade\s.*\bherunter\b/.test(text)
  );
}
const NOT_DOWNLOADED_WORDS = ["nestiahn", "nestiahl", "nestiahol", "not downloaded", "undownloaded", "not yet downloaded", "nicht heruntergeladen", "noch nicht heruntergeladen"];
const HOW_MANY_WORDS = ["kolko", "how many", "wie viele", "wieviele"];
const ACCOUNTANT_WORDS = ["uctovn", "accountant", "buchhalter", "steuerberater"];
const SELECTION_WORDS = ["tieto", "tento", "tuto", "tieto doklady", "these", "this document", "diese", "dieses"];
const THERE_WORDS = ["tam", "don", "do neho", "there", "into it", "dort", "dorthin", "hinein"];
const RECEIVED_WORDS = ["prijat", "received", "eingang", "incoming"];
const ISSUED_WORDS = ["vydan", "vystaven", "issued", "outgoing", "ausgang", "ausgestellt"];
const GENERIC_DOCUMENT_WORDS = ["doklad", "dokument", "document", "beleg", "podklad"];

/** „tento rok"/„tento mesiac" je obdobie, nie výber na obrazovke. */
function mentionsSelection(text: string): boolean {
  const withoutPeriods = [...THIS_MONTH_WORDS, ...THIS_YEAR_WORDS].reduce(
    (acc, phrase) => acc.split(phrase).join(" "),
    text
  );
  return hasWord(withoutPeriods, SELECTION_WORDS);
}

function hasWord(text: string, words: readonly string[]): boolean {
  return words.some((word) => new RegExp(`(^|[^a-z])${word.replace(/\s+/g, "\\s+")}`).test(text));
}

/** Názov za podstatným menom priečinka, bez chvosta s filtrom („… aj prijaté faktúry"). */
function extractFolderName(rawText: string): string | undefined {
  const match = FOLDER_NOUN_REGEX.exec(rawText);
  if (!match) return undefined;
  let tail = rawText.slice(match.index + match[0].length).trim();
  if (!tail) return undefined;

  // Chvost s ďalším filtrom alebo spojkou nepatrí do mena.
  const cut = tail.search(/\s(aj|tiež|tiez|a tiež|also|too|auch|a|and|und)\s/i);
  if (cut > 0) tail = tail.slice(0, cut);
  const normalizedTail = normalizeText(tail);
  for (const entry of DOCUMENT_TYPE_KEYWORDS) {
    for (const word of entry.words) {
      const at = normalizedTail.indexOf(word);
      if (at > 0) tail = tail.slice(0, at);
    }
  }
  // Nemecký slovosled: sloveso na konci („Belegordner Test1 löschen").
  tail = tail.replace(/\s+(löschen|loeschen|entfernen|öffnen|oeffnen|anzeigen|herunterladen|exportieren|anlegen|erstellen)[.?!]*\s*$/i, "");
  const cleaned = tail.replace(/^[„"'“]+|[”"'“.?!,;:]+$/g, "").trim();
  return cleaned || undefined;
}

/** Dátumový rozsah z filtra; „za august 2025" použije uvedený rok. */
function extractFilterDateRange(filterText: string): { dateFrom: string; dateTo: string } | undefined {
  const range = extractDateRange(filterText);
  if (!range) return undefined;
  const year = /\b(20\d{2})\b/.exec(filterText)?.[1];
  if (!year) return { dateFrom: range.dateFrom, dateTo: range.dateTo };
  return { dateFrom: `${year}${range.dateFrom.slice(4)}`, dateTo: `${year}${range.dateTo.slice(4)}` };
}

function detectInvoiceDirection(text: string): "issued" | "received" | undefined {
  if (containsAny(text, RECEIVED_WORDS)) return "received";
  if (containsAny(text, ISSUED_WORDS)) return "issued";
  return undefined;
}

/**
 * Priečinkové a stiahnutové príkazy. `null` = veta sem nepatrí a pokračuje
 * bežnými vetvami parsera.
 */
export function parseFolderIntent(rawText: string): ParsedIntent | null {
  const text = normalizeText(rawText);
  const hasFolderNoun = FOLDER_NOUN_REGEX.test(rawText) || FOLDER_NOUN_REGEX.test(text);
  const folderName = hasFolderNoun ? extractFolderName(rawText) : undefined;
  const filterText = folderName ? text.replace(normalizeText(folderName), " ") : text;

  const documentTypes = detectDocumentTypes(filterText);
  const invoiceDirection = detectInvoiceDirection(filterText);
  if (invoiceDirection && !documentTypes.includes("invoice")) documentTypes.push("invoice");
  const range = extractFilterDateRange(filterText);
  const hasFilter = documentTypes.length > 0 || Boolean(range) || containsAny(filterText, GENERIC_DOCUMENT_WORDS);
  const filterArgs = {
    documentTypes: documentTypes.length > 0 ? documentTypes : undefined,
    invoiceDirection,
    dateFrom: range?.dateFrom,
    dateTo: range?.dateTo,
  };

  // --- Stav stiahnutia (nemusí obsahovať priečinok)
  if (containsAny(text, NOT_DOWNLOADED_WORDS)) {
    if (containsAny(text, HOW_MANY_WORDS)) {
      return build("DOCUMENTS_DOWNLOAD_STATUS", {
        ...filterArgs,
        byAccountant: containsAny(text, ACCOUNTANT_WORDS) || undefined,
      });
    }
    return build("DOCUMENTS_LIST_UNDOWNLOADED", filterArgs);
  }

  const wantsDownload = wantsDownloadCommand(text);

  if (hasFolderNoun) {
    // „Zmaž priečinok X" = zmazanie priečinka. „Odstráň Z priečinka X …" =
    // odobratie dokladov. Rozhoduje predložka, nie sloveso.
    const removesFromFolder =
      /(^|\s)(z|zo)\s+priecin/.test(text) ||
      /from\s+(the\s+)?accounting\s+folder/.test(text) ||
      /aus\s+dem\s+belegordner/.test(text);
    if (!removesFromFolder && hasWord(text, FOLDER_DELETE_VERBS)) {
      return folderName ? build("FOLDER_DELETE", { folderName }) : build("FOLDER_DELETE", {});
    }
    if (hasWord(text, FOLDER_REMOVE_VERBS)) {
      return build("FOLDER_REMOVE_ITEMS", {
        folderName,
        ...filterArgs,
        useSelection: mentionsSelection(filterText) || undefined,
      });
    }
    // „Exportuj priečinok X" = to isté stiahnutie balíka ako „Stiahni priečinok X".
    if (wantsDownload || /(^|\s)(exportuj|export|exportiere)(\s|$)/.test(text)) return build("FOLDER_EXPORT", { folderName });
    if (containsAny(text, FOLDER_CREATE_VERBS) && !hasWord(filterText, FOLDER_ADD_VERBS.filter((v) => v !== "lege"))) {
      return folderName ? build("FOLDER_CREATE", { folderName }) : null;
    }
    if (hasWord(text, FOLDER_ADD_VERBS) || /\bdo\s+priecin/.test(text) || /\binto\s+accounting/.test(text) || /\bin\s+den\s+belegordner/.test(text)) {
      const useSelection = mentionsSelection(filterText);
      if (!useSelection && !hasFilter) return build("FOLDER_ADD_ITEMS", { folderName });
      return build("FOLDER_ADD_ITEMS", {
        folderName,
        ...filterArgs,
        useSelection: useSelection || undefined,
        move: hasWord(text, FOLDER_MOVE_VERBS) || undefined,
      });
    }
    if (containsAny(text, FOLDER_LIST_WORDS)) return build("FOLDER_LIST_ITEMS", { folderName });
    if (hasWord(text, FOLDER_OPEN_VERBS) || folderName) return build("FOLDER_OPEN", { folderName });
    return build("FOLDER_OPEN", {});
  }

  // --- „Daj tam bločky za august" — priečinok z kontextu rozhovoru.
  if (hasWord(text, FOLDER_ADD_VERBS) && hasWord(text, THERE_WORDS) && hasFilter) {
    return build("FOLDER_ADD_ITEMS", {
      ...filterArgs,
      useSelection: mentionsSelection(text) || undefined,
    });
  }

  // --- „Exportuj / Stiahni tieto doklady", „Stiahni originály" — výber z
  //     obrazovky; bez výberu sa asistent spýta (nikdy „všetko").
  if ((wantsDownload || /(^|\s)(exportuj|export|exportiere)(\s|$)/.test(text)) &&
      (mentionsSelection(text) || /(^|\s)(original\w*|originale?)(\s|$|[.!?])/.test(text)) &&
      !range && !documentTypes.length) {
    return build("DOCUMENTS_EXPORT", { useSelection: true });
  }

  // --- „Stiahni …" bez slova priečinok
  if (wantsDownload) {
    if (documentTypes.length > 0 || containsAny(text, GENERIC_DOCUMENT_WORDS)) {
      return build("DOCUMENTS_EXPORT", filterArgs);
    }
    // „Stiahni August 2026" — zvyšok vety je meno priečinka.
    const rest = rawText.replace(/^\s*\S+\s*/, "").replace(/[.?!]+$/, "").trim();
    if (rest && !/\d{5,}/.test(rest)) return build("FOLDER_EXPORT", { folderName: rest });
  }

  return null;
}

// =============================================================================
// Prevádzkové príkazy: sklad, stroje, vozidlá a príjem dokladov.
//
// Rovnaký princíp ako zvyšok parsera: sloveso (čo) + podstatné meno (nad
// čím) + štruktúrované sloty. Kontext obrazovky (`hints.module`) rozhoduje
// iba tam, kde veta modul nepomenúva („Vytvor novú položku" v Sklade).
// Mená sa berú z pôvodného textu a nikdy sa nedomýšľajú; chýbajúce povinné
// pole doplní otázka v handleri.
// =============================================================================

export type ParseHints = {
  /** Modul, v ktorom používateľ práve je. Nikdy nie oprávnenie. */
  module?: "dashboard" | "inventory" | "machines" | "vehicles" | "invoices" | "inbox" | "folders" | "partners";
};

const OP_INVENTORY_STRONG = ["sklad", "zasob", "inventory", "warehouse", "lager"];
const OP_GENERIC_ITEM = ["polozk", "zaznam", "item", "artikel", "eintrag", "position"];
const OP_MACHINE = ["stroj", "bager", "bagr", "machine", "maschine", "bagger", "nakladac", "zeriav"];
/** Triedne slová, ktoré nie sú súčasťou mena („stroj bager" → meno „bager"). */
const OP_MACHINE_CLASS = ["stroj", "machine", "maschine"];
const OP_LOW_STOCK = ["nizke zasoby", "nizky stav", "dochadza", "dochadzaju", "pod minimom", "low stock", "running low", "below minimum", "niedriger bestand", "geht aus", "unter minimum", "unter dem minimum"];
const OP_VEHICLE = ["vozidl", "auto", "auta", "fahrzeug", "vehicle", "car", "dodavk"];
const OP_CREATE = ["vytvor", "pridaj", "zaloz", "zaeviduj", "zapis", "create", "add", "register", "erstelle", "lege", "fuge", "fuege", "anlegen", "erfasse", "hinzufug", "hinzufueg"];
const OP_NEW = ["novy", "nova", "nove", "novu", "new", "neue", "neuen", "neues", "neuer"];
const OP_DELETE = ["zmaz", "vymaz", "odstran", "zrus", "delete", "remove", "losch", "loesch", "entfern"];
const OP_READ = ["ukaz", "zobraz", "historia", "historiu", "show", "zeige", "vypis", "otvor", "open"];
const OP_PHOTO = ["fotk", "foto", "photo", "bild", "obrazok"];
const OP_ADD_QTY = ["zvys", "zvacsi", "navys", "pridaj", "prihod", "naskladni", "prijmi", "dopln", "add", "increase", "erhohe", "erhoehe", "hinzufug", "hinzufueg", "buche"];
const OP_SUB_QTY = ["zniz", "zmensi", "odober", "odstran", "uber", "odpis", "odpocitaj", "vydaj", "zober", "subtract", "remove", "take", "decrease", "reduziere", "verringere", "entnehm", "entferne", "abziehen"];
const OP_SET_QTY = ["nastav", "zmen", "uprav", "set", "setze", "change"];
const OP_CONTEXT = ["tento", "tejto", "toto", "tomuto", "tuto", "tohto", "this", "diese", "dieses", "diesem", "diesen", "dieser"];
const OP_INTAKE = ["pridaj", "nahraj", "odfot", "naskenuj", "skenuj", "vloz", "prilož", "priloz", "upload", "scan", "photograph", "hochladen", "lade", "scanne", "fotografier", "hinzufug"];
const OP_UNITS = ["ks", "kus", "kusov", "kusy", "kg", "kilo", "g", "l", "litrov", "m", "metrov", "bal", "balenie", "baleni", "vrece", "vriec", "pcs", "pieces", "stuck", "stueck", "sack"];
const OP_NEEDS_SERVICE = ["potrebuj", "need service", "needs service", "due for service", "brauchen wartung", "wartung fallig", "wartung faellig"];
const OP_FILLERS = ["do", "zo", "z", "na", "v", "vo", "k", "ku", "pre", "a", "the", "to", "from", "into", "in", "zum", "zur", "vom", "den", "die", "der", "das", "ein", "eine", "einen", "ins", "im", "zu", "mi", "me", "o", "by", "um"];

function tokensOf(rawText: string): string[] {
  return rawText.trim().replace(/[.?!]+$/, "").split(/\s+/).filter(Boolean);
}


/** Pôvodné slová vety bez príkazových slov, podstatných mien a výplne. */
function remainderName(rawText: string, drop: readonly string[]): string | undefined {
  // Výplňové slová („na", „do", „z") sa zahadzujú iba na OKRAJOCH mena —
  // vnútri mena patria k nemu: „Kotúč na asfalt" nie je „Kotúč asfalt".
  // (Produkčná chyba: „Vymaž skladovú položku kotúča na asfalt" hľadala
  // „Kotúča asfalt" a nenašla nič.)
  const tokens = tokensOf(rawText).map((token) => ({ token, clean: normalizeText(token).replace(/[.?!,;:]+$/, "") }));
  const content = tokens.map(({ clean }) => Boolean(clean) && !OP_FILLERS.includes(clean) && !drop.some((stem) => clean.startsWith(stem)));
  const first = content.indexOf(true);
  const last = content.lastIndexOf(true);
  const kept = first < 0
    ? []
    : tokens
        .map(({ token, clean }, index) => ({ token, clean, index }))
        .filter(({ clean, index }) => index >= first && index <= last && (content[index] || OP_FILLERS.includes(clean)))
        .map(({ token }) => token);
  const name = kept.join(" ").replace(/^[„"'“]+|[”"'“.?!,;:]+$/g, "").trim();
  if (!name) return undefined;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Výslovne pomenované meno: „… s názvom Aman", „… called Aman",
 * „… namens Aman". Keď zaznie, je to meno — nič sa nedomýšľa a nepýta.
 */
const EXPLICIT_NAME_REGEX =
  /(?:^|\s)(?:s\s+n[áa]zvom|pod\s+n[áa]zvom|n[áa]zvom|s\s+menom|menom|s\s+ozna[čc]en[íi]m|called|named|with\s+(?:the\s+)?name|namens|mit\s+(?:dem\s+)?namen|genannt)\s+(.+)$/i;

function explicitEntityName(rawText: string): string | undefined {
  const match = EXPLICIT_NAME_REGEX.exec(rawText.trim());
  if (!match) return undefined;
  const name = match[1]
    .replace(/\s+(anlegen|erstellen|hinzuf[üu]gen|erfassen)\s*$/i, "")
    .replace(/^[„"'“]+|[”"'“.?!,;:]+$/g, "")
    .trim();
  if (!name) return undefined;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function readQuantity(text: string): { quantity: number; unit?: string } | undefined {
  const match = text.match(/(-?\d+(?:[.,]\d+)?)\s*([a-z]+)?/);
  if (!match) return undefined;
  const quantity = Number(match[1].replace(",", "."));
  if (!Number.isFinite(quantity)) return undefined;
  const unitWord = match[2];
  const unit = unitWord && OP_UNITS.includes(unitWord) ? unitWord : undefined;
  return { quantity, unit };
}

// =============================================================================
// INVARIANT: VETA O SERVISE NIKDY NEZALOŽÍ STROJ.
//
// Produkčná chyba (2026-09-24): „Do stroja TAKEUCHI 323 pridaj výmenu oleja
// a filtrov" nemala slovo „servis", takže servisná vetva sa nespustila a
// vetva „vytvor" zobrala sloveso „pridaj" + „stroja" ako „založ stroj" a
// všetko ostatné ako meno → nový stroj „TAKEUCHI 323 oleja a filtrov".
//
// Preto:
//   1. údržbové slová (výmena, oprava, údržba, olej, filter, Ölwechsel,
//      repair …) sú servisná veta rovnako ako „servis",
//   2. MACHINE_CREATE vyžaduje VÝSLOVNÉ založenie („nový stroj", „stroj
//      s názvom X", „Pridaj stroj X", „Add machine X", „Maschine … anlegen")
//      — „Do stroja X pridaj …" / „Stroju X …" nie je založenie,
//   3. servisná veta sa na založenie stroja nezmení NIKDY (ani z AI).
// =============================================================================

/** Údržbové slová — veta s nimi je o servise, nie o novom stroji. */
const MAINTENANCE_WORDS = [
  "vymen", "oprav", "udrzb", "olej", "oleja", "filter", "filtr", "mazan", "revizi",
  "repair", "maintenance", "oil change", "oil and", "filters",
  "olwechsel", "reparatur", "instandhaltung", "olfilter",
];

/** Je veta o servise/údržbe? (Pre invariant v route aj v parseri.) */
export function isServiceUtterance(rawText: string): boolean {
  const text = normalizeText(rawText);
  return containsAny(text, SERVICE_WORDS) || hasWord(text, MAINTENANCE_WORDS);
}

/**
 * Výslovné založenie stroja: „nový stroj", „stroj s názvom X", sloveso
 * hneď pred „stroj/machine/Maschine" (nie „do stroja", „stroju"), alebo
 * nemecký slovosled „Maschine X anlegen / hinzufügen".
 */
/**
 * Obsahuje veta VÝSLOVNÉ založenie pre daný intent? Používa sa na výsledok
 * AI klasifikátora: model smie vetu vyložiť, ale založenie (stroj, vozidlo,
 * položka, partner, faktúra, priečinok, zložka) musí zaznieť slovami —
 * sloveso založenia spolu s podstatným menom danej oblasti.
 */
export function hasExplicitCreateWording(intentName: string, rawText: string): boolean {
  const text = normalizeText(rawText);
  const createVerb = /(^|[^a-z])(vytvor|zaloz|pridaj|zaeviduj|zaregistruj|vystav|priprav|sprav|urob|nov[aeyuo]|create|add|new|make|issue|register|erstell|anleg|lege|neue?[nrs]?|hinzufug|hinzufueg)/.test(text);
  if (!createVerb) return false;
  switch (intentName) {
    case "MACHINE_CREATE":
      return hasExplicitMachineCreate(rawText);
    case "VEHICLE_CREATE":
      return /(vozidl|auto|nakladiak|dodavk|vehicle|truck|fahrzeug|lkw)/.test(text);
    case "INVENTORY_ITEM_CREATE":
      return /(sklad|polozk|inventory|stock|item|lager|artikel)/.test(text);
    case "PARTNER_CREATE":
      return parsePartnerCreate(rawText) !== null;
    case "CREATE_INVOICE_DRAFT":
      return /(faktur|rechnung|invoice)/.test(text);
    case "FOLDER_CREATE":
      return /(priecin|folder|ordner)/.test(text);
    case "CREATE_DOCUMENT_CATEGORY":
      return /(zlozk|kategori|category|kategorie)/.test(text);
    default:
      return false;
  }
}

export function hasExplicitMachineCreate(rawText: string): boolean {
  const text = normalizeText(rawText);
  if (hasWord(text, OP_NEW)) return true;
  if (explicitEntityName(rawText)) return true;
  const tokens = text.replace(/[.?!,;:]/g, " ").split(/\s+/).filter(Boolean);
  const verbs = [...OP_CREATE, "zaeviduj", "zaregistruj", "register"];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!verbs.some((verb) => tokens[i].startsWith(verb))) continue;
    let j = i + 1;
    if (["a", "an", "eine", "einen", "mi"].includes(tokens[j])) j++;
    if (["stroj", "machine", "maschine"].includes(tokens[j] ?? "")) return true;
  }
  return tokens.includes("maschine") && hasWord(text, ["anlegen", "hinzufug", "hinzufueg", "erfassen"]);
}

/**
 * Posledná poistka nad výsledkom parsera alebo AI: MACHINE_CREATE zo
 * servisnej vety, alebo bez výslovného založenia, sa nepustí ďalej.
 */
export function violatesMachineCreateInvariant(intentName: string, rawText: string): boolean {
  if (intentName !== "MACHINE_CREATE") return false;
  return isServiceUtterance(rawText) || !hasExplicitMachineCreate(rawText);
}

/**
 * Úzka poistka pred náhľadom zápisu: výsledný intent musí sedieť s TOUTO
 * vetou. „Vytvor faktúru" nikdy nevedie na stroj, vozidlo, sklad ani
 * „vytvor položku" — ani cez starý kontext, stránku alebo AI.
 */
const INVOICE_NOUNS = ["faktur", "rechnung", "invoice"];
export function isIntentCompatibleWithUtterance(intentName: string, rawText: string): boolean {
  const text = normalizeText(rawText);
  if (hasWord(text, INVOICE_NOUNS)) {
    return !/^(MACHINE_|VEHICLE_|INVENTORY_)/.test(intentName) && intentName !== "ENTITY_CREATE";
  }
  return true;
}

/** Popis údržby bez slova „servis" („pridaj výmenu oleja a filtrov" → „výmenu oleja a filtrov"). */
export function maintenanceDescription(rawText: string): string | undefined {
  const tokens = rawText.trim().replace(/[.?!]+$/, "").split(/\s+/).filter(Boolean);
  const start = tokens.findIndex((token) => MAINTENANCE_WORDS.some((word) => !word.includes(" ") && normalizeText(token).startsWith(word)));
  if (start < 0) return undefined;
  let rest = tokens.slice(start).join(" ");
  // Entita predložkou na konci („… na Takeuchi 323", „… k stroju X") do popisu nepatrí.
  rest = rest.replace(/\s+(?:na|k|ku|pre|for|to|bei|für|fur|zu|zum|zur|do)\s+.+$/i, "");
  rest = rest.replace(/^[„"'“]+|[”"'“.?!,;:]+$/g, "").trim();
  return rest || undefined;
}

/** Slovesá zápisu servisu, ktoré nie sú všeobecným „vytvor" („Service eintragen", „Log service"). */
const SERVICE_CREATE_EXTRA = ["eintrag", "trage", "log", "record"];

/**
 * Meno stroja vložené vo vete o servise. Berie slová ZA triednym slovom
 * („stroja", „machine", „Maschine") alebo za predložkou („bei", „für",
 * „for") až po sloveso, slovo „servis" alebo čiarku/dvojbodku. Nič sa
 * nedomýšľa; bez mena `undefined` → asistent sa spýta.
 */
function inlineServiceEntity(rawText: string): string | undefined {
  const tokens = rawText.trim().replace(/[.?!]+$/, "").split(/\s+/).filter(Boolean);
  const clean = (token: string) => normalizeText(token).replace(/[.?!,;:]+$/, "");
  const stopStems = [...OP_CREATE, ...SERVICE_CREATE_EXTRA, ...SERVICE_WORDS, ...MAINTENANCE_WORDS, "zaeviduj", "zaevid", "pridaj", "pridat", "zapis", "vytvorit", "eintragen", "hinzufug", "hinzufueg"];
  let start = tokens.findIndex((token) => OP_MACHINE_CLASS.some((stem) => clean(token).startsWith(stem)));
  if (start < 0) {
    const prep = tokens.findIndex((token) => ["bei", "fur", "fuer", "for", "na"].includes(clean(token)));
    if (prep >= 0) start = prep;
    // „Takeuchi 323 servis výmena oleja" — meno na začiatku, pred slovom servis.
    else if (tokens.length > 0 && !stopStems.some((stem) => clean(tokens[0]).startsWith(stem))) start = -1;
    else return undefined;
  }
  const name: string[] = [];
  for (let i = start + 1; i < tokens.length; i++) {
    const word = clean(tokens[i]);
    if (!word) break;
    if (stopStems.some((stem) => word.startsWith(stem))) break;
    name.push(tokens[i].replace(/[,;:]+$/, ""));
    if (/[,;:]$/.test(tokens[i])) break;
  }
  return name.length > 0 ? remainderName(name.join(" "), [...OP_MACHINE_CLASS, "the", "dem"]) : undefined;
}

/** „za 250 eur", „250 €", „for 250 euro" — iba výslovná suma v EUR. */
function readServiceCost(rawText: string): { amount: number; match: string } | undefined {
  const match = rawText.match(/(?:\b(?:za|for|für)\s+)?(\d+(?:[.,]\d{1,2})?)\s*(?:eur\w*|€)/i);
  if (!match) return undefined;
  const amount = Number(match[1].replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? { amount, match: match[0] } : undefined;
}

/**
 * Popis servisu za slovom „servis". Odstráni sa typ entity na začiatku
 * („stroja, …") a entita uvedená predložkou („k stroju X"). Nič sa
 * nedomýšľa — bez popisu handler použije predvolený názov.
 */
function serviceDescription(rawText: string): string | undefined {
  const match = rawText.match(/(?:^|\s)(?:serv[ií]s\S*|service\S*|wartung\S*)\s+(.+)$/i);
  if (!match) return undefined;
  let rest = match[1].trim();
  // „servis stroja, výmena oleja" / „servis vozidla BA123CD: …"
  const typed = rest.match(/^(?:stroj\S*|vozidl\S*|aut\S*|machine\S*|vehicle\S*|maschine\S*|fahrzeug\S*)[^,:–]*[,:–]\s*(.+)$/i);
  if (typed) rest = typed[1];
  else if (/^(?:stroj\S*|vozidl\S*|aut\S*|machine\S*|vehicle\S*|maschine\S*|fahrzeug\S*)\b/i.test(rest)) return undefined;
  // „Service eintragen: Ölwechsel", „Service hinzufügen, …" — sloveso nie je popis.
  rest = rest.replace(/^(?:eintragen|hinzuf(?:ü|ue|u)gen|anlegen|erfassen|zaeviduj|pridaj)\s*[,:–]?\s*/i, "");
  // Entita predložkou patrí inam („… k stroju X").
  if (/^(?:k|ku|pre|for|to|zu|zum|zur|do|na|bei|für|fur)\s/i.test(rest)) return undefined;
  rest = rest.replace(/\s+(?:k|ku|pre|for|to|zu|zum|zur)\s+(?:stroj\S*|vozidl\S*|machine\S*|vehicle\S*|maschine\S*|fahrzeug\S*).*$/i, "");
  rest = rest.replace(/^[„"'“]+|[”"'“.?!,;:]+$/g, "").trim();
  return rest || undefined;
}

export function parseOperationalIntent(rawText: string, hints: ParseHints = {}): ParsedIntent | null {
  const text = normalizeText(rawText);
  if (!text) return null;

  const plate = extractPlateCandidate(rawText);
  const hasInventoryStrong = hasWord(text, OP_INVENTORY_STRONG);
  const hasGenericItem = hasWord(text, OP_GENERIC_ITEM);
  const hasMachine = hasWord(text, OP_MACHINE);
  const hasVehicle = hasWord(text, OP_VEHICLE) || Boolean(plate);
  const hasService = containsAny(text, SERVICE_WORDS);
  const useContext = hasWord(text, OP_CONTEXT) || undefined;
  const isCreate = hasWord(text, OP_CREATE) || hasWord(text, OP_NEW);
  const isDelete = hasWord(text, OP_DELETE);
  const isRead = hasWord(text, OP_READ);
  // „Zníž množstvo o 5" — množstvo/stav má iba skladová položka.
  // Celé slová (nie predpony): „stav" nesmie chytiť „Stavby", „počet" nie „počítač".
  const hasQuantityNoun = /(^|[^a-z])(mnozstv\w*|pocet|poctu|stav|stavu|quantity|menge|bestand|anzahl)([^a-z]|$)/.test(text) && /\d/.test(text);
  // Zmena množstva aj bez slova „sklad": sloveso množstva + číslo („Pridaj
  // 20 vrutov", „Zníž Sprej o 2 kusy", „Nastav Sprej na 5 kusov") — ak veta
  // nepomenúva inú oblasť, nemá sumu v mene a nejde o servis. Položku overí
  // resolver skladu; neznáma = „nenašla sa" (pridanie navrhne založenie).
  const genericStock =
    /\d/.test(text) &&
    !hasMachine && !hasVehicle && !hasService && !hasWord(text, MAINTENANCE_WORDS) &&
    !/(€|\b(eur|euro|eura|eurov|czk|usd)\b)/.test(text) &&
    !FOLDER_NOUN_REGEX.test(text) &&
    (hasWord(text, OP_SET_QTY) && /\b(na|to|auf)\s+-?\d/.test(text) ||
      hasWord(text, ["zvys", "zvacsi", "navys", "zniz", "zmensi", "uber", "odpis", "odpocitaj", "increase", "decrease", "erhohe", "erhoehe", "reduziere", "verringere"]) ||
      /^\s*(pridaj|prihod\S*|naskladni|dopln\S*|add)\s+-?\d/.test(text));
  const inInventory = hasInventoryStrong || genericStock || ((hints.module === "inventory" || hasQuantityNoun) && !hasMachine && !hasVehicle);
  const nounCount = [hasInventoryStrong, hasMachine, hasVehicle].filter(Boolean).length;

  // Finančné doklady tu nikdy nerieši tento parser (okrem príjmu nižšie).
  const mentionsFinanceDoc = containsAny(text, DOCUMENT_SEARCH_WORDS) || containsAny(text, ["dodaci list", "dodacie listy", "lieferschein", "delivery note"]);

  // --- Stroje/vozidlá, ktoré potrebujú servis → termíny
  if (hasService && containsAny(text, OP_NEEDS_SERVICE) && !isCreate) {
    return build("UPCOMING_DEADLINES", {
      deadlineTypes: hasVehicle && !hasMachine ? ["VEHICLE_SERVICE"] : hasMachine && !hasVehicle ? ["MACHINE_SERVICE"] : ["MACHINE_SERVICE", "VEHICLE_SERVICE"],
    });
  }

  // --- Príjem dokladu: „Pridaj bloček", „Odfoť dodací list", „Upload receipt"
  if (hasWord(text, OP_INTAKE) && mentionsFinanceDoc && !hasInventoryStrong && !isRead) {
    const types = detectDocumentTypes(text).filter((t) => t === "receipt" || t === "invoice" || t === "delivery_note");
    return build("DOCUMENT_INTAKE", { documentTypes: types.length > 0 ? types : undefined });
  }

  if (mentionsFinanceDoc) return null;

  // --- Nízke zásoby (iba čítanie)
  if (containsAny(text, OP_LOW_STOCK) && !isCreate && !isDelete) return build("SHOW_LOW_STOCK", {});

  // --- Fotka k stroju / vozidlu (iba navigácia)
  if (containsAny(text, OP_PHOTO) && (hasWord(text, OP_CREATE) || hasWord(text, ["nahraj", "odfot", "upload"])) && !isRead) {
    const query = useContext ? undefined : plate ?? remainderName(rawText, [...OP_PHOTO, ...OP_CREATE, ...OP_MACHINE_CLASS, ...OP_VEHICLE, ...OP_CONTEXT, "nahraj", "odfot", "upload"]);
    if (hasVehicle && !hasMachine) return build("VEHICLE_PHOTO_ADD", { query, useContext });
    if (hasMachine || hints.module === "machines") return build("MACHINE_PHOTO_ADD", { query, useContext });
    if (hints.module === "vehicles") return build("VEHICLE_PHOTO_ADD", { query, useContext });
    return useContext ? build("MACHINE_PHOTO_ADD", { useContext, targetModule: undefined }) : null;
  }

  // --- Servisná história bez pomenovanej entity: „Ukáž servisnú históriu"
  //     (na detaile stroja/vozidla doplní entitu kontext obrazovky).
  if (hasService && isRead && !isCreate && !hasMachine && !hasVehicle) {
    if (hints.module === "vehicles") return build("SHOW_VEHICLE_SERVICE", {});
    return build("SHOW_MACHINE_SERVICE", {});
  }
  // „Ukáž servis stroja bager" / „Ukáž servis vozidla BA123CD"
  if (hasService && isRead && !isCreate && hasMachine !== hasVehicle) {
    if (hasVehicle) return plate ? build("SHOW_VEHICLE_SERVICE", { query: plate }) : null;
    const readDrop = [...OP_READ, ...SERVICE_WORDS, "histori"];
    // „servis bagra CAT 302" rieši pôvodná vetva (meno bez typu stroja);
    // sem patrí iba veta, kde je typ stroja jediným menom („stroja bager").
    if (remainderName(rawText, [...readDrop, ...OP_MACHINE])) return null;
    const query = remainderName(rawText, [...readDrop, ...OP_MACHINE_CLASS]);
    if (query) return build("SHOW_MACHINE_SERVICE", { query });
  }

  // --- „Na Takeuchi 323 bola výmena oleja", „Pri AB123CD sa robil servis za
  //     350 eur, výmena oleja" — minulý čas nad pomenovanou entitou.
  const pastService = /^\s*(?:na|pri|u)\s+(?:stroji\s+|vozidle\s+|aute\s+)?(.+?)\s+(?:bol[aoi]?|sa\s+rob\S*|sa\s+urob\S*|sme\s+rob\S*|sme\s+urob\S*|prebehl[aoi]?)\s+(.+?)\s*[.!?]*$/i.exec(rawText);
  if (pastService && (hasService || hasWord(normalizeText(pastService[2]), MAINTENANCE_WORDS))) {
    const cost = readServiceCost(pastService[2]);
    const detail = (cost ? pastService[2].replace(cost.match, " ") : pastService[2])
      .replace(/(^|\s)(servis|service|wartung)(?=[\s,.;:]|$)/gi, " ")
      .replace(/^[\s,:–-]+|[\s,:–-]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const entity = pastService[1].trim();
    const entityPlate = extractPlateCandidate(entity);
    const args = { query: entityPlate ?? entity, serviceTitle: detail || undefined, amount: cost?.amount };
    return entityPlate || (hints.module === "vehicles" && !hasMachine)
      ? build("VEHICLE_SERVICE_ADD", { ...args, targetModule: "vehicles" })
      : build("MACHINE_SERVICE_ADD", args);
  }

  // --- Servisný záznam
  // Údržbové slová (výmena, oprava, olej …) sú servisná veta aj bez slova
  // „servis" — okrem skladu („pridaj do skladu 5 olejov" je sklad).
  const hasMaintenance = hasWord(text, MAINTENANCE_WORDS) && !inInventory;
  const isServiceCreate = isCreate || hasWord(text, SERVICE_CREATE_EXTRA);
  const serviceAdd = isServiceCreate ? (hasService || hasMaintenance) : (hasService && hasMaintenance);
  if (serviceAdd && !isRead) {
    // „… k CAT 320, výmena oleja" / „… ku stroju X: výmena oleja"
    const cost = readServiceCost(rawText);
    const withoutCost = cost ? rawText.replace(cost.match, " ") : rawText;
    const after = withoutCost.match(/\b(?:k|ku|pre|for|to|zu|zum|zur)\s+(.+)$/i)?.[1] ?? "";
    const [entityPart, titlePart] = after.split(/\s*[,:–]\s*/, 2);
    // Entita: „… k CAT 320", alebo vložená v texte — „Do stroja Takeuchi 323
    // zaeviduj servis", „Stroju X pridaj servis", „Bei X Service …".
    // (Produkčná chyba: meno medzi „Do stroja" a slovesom sa zahodilo a
    // asistent sa pýtal „Ku ktorému stroju?", hoci stroj zaznel.)
    const entityQuery = plate ?? (entityPart
      ? remainderName(entityPart, [...OP_MACHINE_CLASS, ...OP_VEHICLE, ...OP_CONTEXT, ...SERVICE_WORDS])
      : inlineServiceEntity(withoutCost));
    // Popis servisu: text za slovom „servis", ak nie je súčasťou entity
    // („Zaeviduj servis výmena filtra a oleja", „… servis stroja, výmena
    // oleja"). Predtým sa bral IBA za čiarkou po „k …" a inak sa stratil.
    const serviceTitle = titlePart?.trim().replace(/[.?!]+$/, "") || serviceDescription(withoutCost) || maintenanceDescription(withoutCost) || undefined;
    const args = { query: useContext ? undefined : entityQuery, useContext, serviceTitle, amount: cost?.amount };
    if (hasVehicle && !hasMachine) return build("VEHICLE_SERVICE_ADD", { ...args, targetModule: "vehicles" });
    if (hasMachine && !hasVehicle) return build("MACHINE_SERVICE_ADD", { ...args, targetModule: "machines" });
    if (hints.module === "vehicles") return build("VEHICLE_SERVICE_ADD", { ...args, targetModule: "vehicles" });
    if (hints.module === "machines") return build("MACHINE_SERVICE_ADD", { ...args, targetModule: "machines" });
    // Modul nevieme — handler skúsi kontext obrazovky, inak sa spýta.
    return build("MACHINE_SERVICE_ADD", args);
  }

  const qty = readQuantity(text);

  // --- Zmazanie entity („Odober 5 cementu zo skladu" je zmena množstva, nie zmazanie)
  // „Vymaž položku Sprej" — položka bez inej oblasti je skladová (cieľ overí
  // resolver presne; približná zhoda vedie na otázku, nikdy na zmazanie).
  const genericItemDelete = hasWord(text, ["polozk"]) && !hasMachine && !hasVehicle && !hasService && !FOLDER_NOUN_REGEX.test(text);
  if (isDelete && !isRead && !(qty && inInventory) && nounCount + (genericItemDelete ? 1 : 0) >= 1) {
    const drop = [...OP_DELETE, ...OP_INVENTORY_STRONG, ...OP_GENERIC_ITEM, ...OP_MACHINE_CLASS, ...OP_VEHICLE, ...OP_CONTEXT];
    if (hasVehicle && !hasMachine && !hasInventoryStrong) {
      return build("VEHICLE_DELETE", { query: useContext ? undefined : plate ?? remainderName(rawText, drop), useContext });
    }
    if (hasMachine && !hasVehicle && !hasInventoryStrong) {
      return build("MACHINE_DELETE", { query: useContext ? undefined : remainderName(rawText, drop), useContext });
    }
    if ((inInventory || genericItemDelete) && !hasMachine && !hasVehicle) {
      return build("INVENTORY_ITEM_DELETE", { query: useContext ? undefined : remainderName(rawText, drop), useContext });
    }
    return null;
  }

  // --- Zmena množstva na sklade: „Pridaj do skladu 20 vrutov", „Odober 5 cementu"
  if (qty && inInventory && !hasMachine && !hasVehicle) {
    const mode: "add" | "subtract" | "set" | undefined = hasWord(text, OP_SET_QTY) && /\bna\s+-?\d|\bto\s+-?\d|\bauf\s+-?\d/.test(text)
      ? "set"
      : hasWord(text, OP_SUB_QTY)
        ? "subtract"
        : hasWord(text, OP_ADD_QTY)
          ? "add"
          : undefined;
    if (mode) {
      const drop = [...OP_ADD_QTY, ...OP_SUB_QTY, ...OP_SET_QTY, ...OP_INVENTORY_STRONG, ...OP_GENERIC_ITEM, ...OP_UNITS, "stav", "mnozstv", "pocet", "stand", "menge", "anzahl", "quantity", "stock", "bestand"];
      const name = remainderName(rawText.replace(/-?\d+(?:[.,]\d+)?/g, " "), drop);
      return build("INVENTORY_QUANTITY_ADJUST", {
        quantity: Math.abs(qty.quantity),
        unit: qty.unit,
        quantityMode: mode,
        entityName: name,
        query: name,
        useContext: name ? undefined : useContext,
      });
    }
  }

  // --- Vytvorenie
  if (isCreate && !isRead) {
    if (hasVehicle && !hasMachine && !hasInventoryStrong) {
      return build("VEHICLE_CREATE", { query: plate ?? undefined });
    }
    if (hasMachine && !hasVehicle && !hasInventoryStrong) {
      // „Do stroja X pridaj …" nie je založenie stroja a servisná veta nikdy
      // (invariant vyššie) → nič; radšej otázka než nový stroj.
      if (!hasExplicitMachineCreate(rawText) || isServiceUtterance(rawText)) return null;
      const name = explicitEntityName(rawText) ?? remainderName(rawText, [...OP_CREATE, ...OP_NEW, "stroj", "machine", "maschine"]);
      return build("MACHINE_CREATE", { entityName: name });
    }
    if (inInventory && !hasMachine && !hasVehicle && (hasInventoryStrong || hasGenericItem)) {
      const name = explicitEntityName(rawText) ?? remainderName(rawText, [...OP_CREATE, ...OP_NEW, ...OP_INVENTORY_STRONG, ...OP_GENERIC_ITEM, ...OP_UNITS]);
      return build("INVENTORY_ITEM_CREATE", { entityName: name, quantity: qty?.quantity, unit: qty?.unit });
    }
    // „Vytvor novú položku" bez modulu
    if (hasGenericItem && nounCount === 0) {
      // Meno sa vytiahne VŽDY — aj keď modul určí kontext obrazovky.
      // (Predtým sa pri kontexte Strojov zahodilo a asistent sa naň pýtal.)
      const name = explicitEntityName(rawText) ?? remainderName(rawText, [...OP_CREATE, ...OP_NEW, ...OP_GENERIC_ITEM]);
      if (hints.module === "machines") return isServiceUtterance(rawText) ? null : build("MACHINE_CREATE", { entityName: name });
      if (hints.module === "vehicles") return build("VEHICLE_CREATE", { query: plate ?? undefined, entityName: name });
      return build("ENTITY_CREATE", { entityName: name });
    }
  }

  return null;
}

// =============================================================================
// Inbox — „nepriradené bločky / faktúry". Rovnaká definícia ako Inbox UI
// (app/ai-evidencia: bez väzby na vozidlo/stroj, bez vlastnej zložky;
// faktúra navyše bez vzniknutej faktúry). Filter vyhodnocuje handler
// (lib/intents/inbox-intents.ts), parser iba rozpozná zámer a typy.
// =============================================================================

const UNASSIGNED_WORDS = ["nepriraden", "nezaraden", "unassigned", "not assigned", "nicht zugeordnet", "unzugeordnet", "ohne zuordnung"];
const INBOX_DELETE_VERBS = ["zmaz", "vymaz", "odstran", "delete", "remove", "losch", "loesch", "entfern"];

export function parseInboxUnassignedIntent(rawText: string): ParsedIntent | null {
  const text = normalizeText(rawText);
  if (!containsAny(text, UNASSIGNED_WORDS)) return null;
  const detected = detectDocumentTypes(text).filter((t) => t === "receipt" || t === "invoice" || t === "delivery_note");
  const documentTypes: DocumentTypeFilter[] = detected.length > 0 ? detected : ["receipt", "invoice"];

  // „Priraď nepriradené bločky do priečinka X", „Stiahni nepriradené bločky"
  // — existujúce priečinkové intenty, len s filtrom nepriradených.
  const folderIntent = parseFolderIntent(rawText);
  if (folderIntent && (folderIntent.name === "FOLDER_ADD_ITEMS" || folderIntent.name === "DOCUMENTS_EXPORT")) {
    return build(folderIntent.name, { ...folderIntent.args, documentTypes, unassignedOnly: true });
  }
  if (hasWord(text, INBOX_DELETE_VERBS)) return build("INBOX_DELETE_UNASSIGNED", { documentTypes });
  if (containsAny(text, HOW_MANY_WORDS)) return build("INBOX_LIST_UNASSIGNED", { documentTypes, countOnly: true });
  return build("INBOX_LIST_UNASSIGNED", { documentTypes });
}

export function parseIntentDeterministic(rawText: string, hints: ParseHints = {}): ParsedIntent | null {
  const text = normalizeText(rawText);
  if (!text) return null;

  // Priečinky, doklady, sklad, stroje, vozidlá — pred ostatnými vetvami, lebo
  // „faktúry" by inak spadli do vyhľadávania dokladov a „vytvor" do zložiek.
  //
  // Mazanie a zmenu množstva ako celok stále odmietame (UNSUPPORTED nižšie).
  // Výnimkou sú presne rozpoznané zápisy nad KONKRÉTNOU entitou, ktoré idú
  // cez povinné potvrdenie: zmazanie priečinka / stroja / vozidla / položky
  // a zmena stavu skladu. „Vymaž všetky faktúry" sem nespadne nikdy.
  // Odosielanie (pošli, send) nie je podporované vôbec.
  const unsupported = containsAny(text, UNSUPPORTED_ACTION_STEMS);
  const sendLike = containsAny(text, ["posli", "odosli", "send", "sende"]);
  const ALLOWED_DESPITE_UNSUPPORTED = new Set([
    "FOLDER_DELETE",
    "FOLDER_REMOVE_ITEMS",
    "INVENTORY_ITEM_DELETE",
    "INVENTORY_QUANTITY_ADJUST",
    "MACHINE_DELETE",
    "VEHICLE_DELETE",
  ]);
  // Nový obchodný partner — pred skladom/strojmi („Pridaj nového partnera X"
  // nie je nová položka) a pred faktúrou (veta s „faktúra" sem nespadne).
  const partnerCreate = parsePartnerCreate(rawText);
  if (partnerCreate) return partnerCreate;
  const partnerSearch = parsePartnerSearch(rawText);
  if (partnerSearch) return partnerSearch;
  // Premenovanie (priečinok / skladová položka) — pred priečinkami, inak
  // by „Premenuj priečinok A na B" otvorilo priečinok „A na B".
  const rename = parseRenameIntent(rawText);
  if (rename) return rename;
  const invoiceByNumber = parseInvoiceNumberRead(rawText);
  if (invoiceByNumber) return invoiceByNumber;
  const needInvoice = parseNeedInvoice(rawText);
  if (needInvoice) return needInvoice;

  if (!sendLike) {
    const inboxIntent = parseInboxUnassignedIntent(rawText);
    if (inboxIntent) return inboxIntent;
    const folderIntent = parseFolderIntent(rawText);
    if (folderIntent && (!unsupported || ALLOWED_DESPITE_UNSUPPORTED.has(folderIntent.name))) return folderIntent;
    if (!folderIntent) {
      const operational = parseOperationalIntent(rawText, hints);
      if (operational && (!unsupported || ALLOWED_DESPITE_UNSUPPORTED.has(operational.name))) return operational;
    }
  }

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
  // „Vytvor faktúru pre Tester1." — holé založenie draftu s odberateľom.
  // Deterministicky, aby nezáležalo na AI klasifikátore a aby „Nová
  // faktúra pre X" nespadla do vyhľadávania dokladov. Bohatšie vety
  // (položky, sumy) idú ďalej ako doteraz.
  const simpleInvoice = parseSimpleInvoiceCreation(rawText);
  if (simpleInvoice) return simpleInvoice;

  const richInvoice = parseInvoiceCreation(rawText);
  if (richInvoice) return richInvoice;
  // Prepis bez slova „faktúru" — iba pri súhrne dôkazov (pozri funkciu).
  const recoveredInvoice = recoverInvoiceWithoutNoun(rawText);
  if (recoveredInvoice) return recoveredInvoice;

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
