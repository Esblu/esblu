// =============================================================================
// Esblu — Intent Engine: typy a allowlist názvov intentov.
// =============================================================================
// TOTO JE JEDINÝ ZDROJ PRAVDY pre "aké príkazy appka vôbec pozná". AI (ak sa
// použije — pozri lib/intents/ai-fallback.ts) dostáva TENTO ISTÝ enum ako
// striktnú json_schema `enum` množinu, takže nemôže "vymyslieť" intent mimo
// zoznamu — a aj keby vrátila neplatný reťazec, lib/intents/handlers.ts ho
// odmietne (žiadny handler = žiadna akcia, fail closed).
//
// FÁZA TEJTO ÚLOHY JE VÝHRADNE READ-ONLY (zadanie, bod 14) — preto tu
// zámerne NIE JE ani jeden write/delete intent (napr. "ADD_SERVICE",
// "DELETE_DOCUMENT" a pod.). Chýbajú tu ÚPLNE, nie iba vypnuté flagom —
// engine ich teda nemôže spustiť, pretože ich vôbec nepozná. Budúca fáza
// (write intents s Confirm/Cancel) pridá nové položky SEM AJ do registry.ts
// s `requiresConfirmation: true` a `readOnly: false` — pozri
// docs/ai-assistant-architecture-2026-09-14.md, sekcia 4.2, a
// docs/intent-engine-architecture-2026-09-14.md.
// =============================================================================

export const INTENT_NAMES = [
  "OPEN_VEHICLE",
  "SEARCH_VEHICLE",
  "SHOW_VEHICLE_DOCUMENTS",
  "SHOW_VEHICLE_SERVICE",
  "VEHICLE_STK_STATUS",
  "VEHICLE_EK_STATUS",
  "VEHICLE_VIGNETTE_STATUS",
  "VEHICLE_COST_SUMMARY",
  "VEHICLE_REPORT",

  "OPEN_MACHINE",
  "SEARCH_MACHINE",
  "SHOW_MACHINE_SERVICE",
  "MACHINE_REPORT",

  "OPEN_INVENTORY_ITEM",
  "SEARCH_INVENTORY_ITEM",

  "SEARCH_DOCUMENTS",

  // Nie je v pôvodnom zozname zo zadania (bod 2), ale zadanie ho EXPLICITNE
  // vyžaduje v bode 9C ("čo mi končí tento mesiac", "aké termíny treba
  // riešiť", "čo je po lehote", "ktoré vozidlá majú STK do 30 dní" — "majú
  // vrátiť reálne deadline dáta") a v teste 20 ("firma bez blížiacich sa
  // termínov → žiadny prázdny warning box"). Pridané ako plnohodnotný
  // allowlisted READ intent, rovnakej kategórie ako ostatné vyššie.
  "UPCOMING_DEADLINES",
] as const;

export type IntentName = (typeof INTENT_NAMES)[number];

export function isKnownIntentName(value: unknown): value is IntentName {
  return (
    typeof value === "string" && (INTENT_NAMES as readonly string[]).includes(value)
  );
}

// Jediný zdroj pravdy pre povolené hodnoty `documents.document_type` —
// zhodné s CHECK (documents_document_type_check) v produkčnej DB (overené
// priamo cez Supabase MCP, nie odhadnuté). Zdieľané medzi parserom
// (lib/intents/parse.ts, rozpoznávanie "bločky"/"faktúry"/"vážne lístky"
// a pod. z prirodzeného textu), AI fallbackom (lib/intents/ai-fallback.ts)
// a handlermi (lib/intents/handlers.ts) — presne bod zadania "voice must
// NOT be designed around a handful of hardcoded phrases", tu implementovaný
// ako JEDEN allowlist typu, nie duplicitne na troch miestach.
export const DOCUMENT_TYPE_FILTERS = [
  "weigh_ticket",
  "delivery_note",
  "invoice",
  "receipt",
  "insurance",
  "service_document",
  "vehicle_registration",
  "other",
] as const;

export type DocumentTypeFilter = (typeof DOCUMENT_TYPE_FILTERS)[number];

export function isDocumentTypeFilter(value: unknown): value is DocumentTypeFilter {
  return (
    typeof value === "string" &&
    (DOCUMENT_TYPE_FILTERS as readonly string[]).includes(value)
  );
}

// Jediný zdroj pravdy pre "aký termín" filter na UPCOMING_DEADLINES
// ("Ktoré vozidlá majú po splatnosti STK a EK?" → deadlineTypes=["STK",
// "EK"], NIKDY nesmie vrátiť aj diaľničnú známku/iný typ). Zámerne
// PRIATEĽSKÉ, nie interné hodnoty (`lib/deadlines.ts#DeadlineType` používa
// "vehicle_stk"/"vehicle_ek"/... — handler medzi nimi mapuje, pozri
// handlers.ts#DEADLINE_TYPE_FILTER_MAP). PZP tu ZÁMERNE chýba — Esblu
// dnes nemá štruktúrovaný dátum platnosti PZP na vozidle (žiadny stĺpec),
// preto PZP nie je a nemôže byť súčasťou Deadline Enginu vôbec (pozri
// komentár v lib/deadlines.ts) — pridanie by znamenalo hádať/domýšľať dáta,
// čo appka nikdy nerobí.
export const DEADLINE_TYPE_FILTERS = [
  "STK",
  "EK",
  "VIGNETTE",
  "VEHICLE_SERVICE",
  "MACHINE_SERVICE",
] as const;

export type DeadlineTypeFilter = (typeof DEADLINE_TYPE_FILTERS)[number];

export function isDeadlineTypeFilter(value: unknown): value is DeadlineTypeFilter {
  return (
    typeof value === "string" &&
    (DEADLINE_TYPE_FILTERS as readonly string[]).includes(value)
  );
}

// Argumenty sú zámerne "plochý" string/number/boolean záznam — žiadne
// vnorené objekty, žiadny raw SQL/JS fragment, žiadny slobodný "query"
// objekt, ktorý by appka priamo posunula do DB dopytu bez validácie
// (bod 2 zadania: "AI nikdy negeneruje SQL"). Každý handler
// (lib/intents/handlers.ts) validuje/normalizuje svoje vlastné argumenty.
export type IntentArgs = {
  // Vyhľadávací reťazec pre vozidlo — môže byť ŠPZ ("TT123AB") ALEBO
  // voľný text (značka/model). Handler skúša ŠPZ match ako prvý, presnejší
  // krok (bod 18 zadania: "ak intent vieme bezpečne vyriešiť
  // deterministicky, môžeš použiť rýchlejší deterministic path").
  query?: string;
  // Nepovinný rok pre VEHICLE_COST_SUMMARY ("koľko sme minuli na servis
  // TT123AB tento rok" → aktuálny rok, ak nie je v texte iný rok).
  year?: number;
  // Nepovinné pre UPCOMING_DEADLINES — "do 30 dní" a pod. Bez hodnoty sa
  // použije DEADLINE_THRESHOLD_DAYS.dueSoon (30) z lib/deadlines.ts.
  withinDays?: number;
  onlyOverdue?: boolean;
  // Nasledujúce 4 polia rozširujú SEARCH_DOCUMENTS a SHOW_VEHICLE_DOCUMENTS
  // o parametrizované filtre (namiesto desiatok samostatných intentov —
  // "Ukáž bločky za august", "Ukáž faktúry od dodávateľa X", "Nájdi bloček
  // za 86 eur"). Handler ich VŽDY interpretuje iba ako doplnkový, presne
  // definovaný filter nad existujúcimi tabuľkami — nikdy ako surový
  // SQL/text fragment.
  documentType?: DocumentTypeFilter;
  // ISO dátum "YYYY-MM-DD" (vrátane) — dolná/horná hranica dátumu
  // DOKUMENTU (nie dátumu nahratia). Obe strany vypočíta VÝHRADNE parser
  // (kalendárny mesiac/rok), nikdy sa nehádajú čiastkové hodnoty.
  dateFrom?: string;
  dateTo?: string;
  // Suma v EUR z fráz ako "za 86 eur" — porovnáva sa s extracted_fields
  // totalAmount (bloček/faktúra) s malou toleranciou zaokrúhlenia.
  amount?: number;
  // "Ukáž všetky stroje.", "Aké vozidlá máme?", "Ukáž sklad." — explicitná
  // požiadavka na ZOZNAM VŠETKÝCH firemných entít daného typu (SEARCH_VEHICLE/
  // SEARCH_MACHINE/SEARCH_INVENTORY_ITEM), NIKDY textové vyhľadávanie s
  // query="všetky"/"". Keď je true, `query` sa ignoruje a handler vždy
  // vráti `list` so VŠETKÝMI RLS-scoped entitami firmy (aj keby bola iba
  // jedna — nikdy sa "všetky" nezredukuje na auto-navigáciu na jedinú
  // existujúcu entitu, lebo používateľ si explicitne vyžiadal ZOZNAM).
  listAll?: boolean;
  // UPCOMING_DEADLINES — voliteľný filter na KONKRÉTNE typy termínov
  // ("Ktoré vozidlá majú po splatnosti STK a EK?" → nesmie vrátiť
  // diaľničnú známku). Bez hodnoty (undefined/prázdne pole) sa správa
  // presne ako doteraz — všetky typy.
  deadlineTypes?: DeadlineTypeFilter[];
};

export type ParsedIntent = {
  name: IntentName;
  args: IntentArgs;
  // Odkiaľ intent prišiel — čisto diagnostické/auditné pole (nikdy sa
  // nezobrazuje používateľovi), aby report/logy vedeli rozlíšiť
  // deterministickú zhodu od AI fallbacku.
  source: "deterministic" | "ai";
};

export type EntityRef = {
  type: "vehicle" | "machine" | "inventory_item" | "document";
  id: string;
  label: string;
  href: string;
};

// Jednotný, UI-agnostický tvar výsledku — app/components/Dashboard.tsx (a
// akékoľvek budúce miesto s rovnakým search poľom) z neho vie vyrenderovať
// presne to, čo žiada bod 13 zadania: navigácia priamo, alebo compact
// result panel, alebo výber pri nejednoznačnosti, alebo bezpečná chybová
// hláška.
export type IntentResult =
  | { kind: "navigate"; entity: EntityRef }
  | { kind: "answer"; text: string; entity?: EntityRef }
  | {
      kind: "report";
      reportType: "vehicle" | "machine";
      entity: EntityRef;
      // Report dáta necháva handler odovzdať ako už-preložené riadky
      // (label/value), nikdy surové DB polia — UI ich iba vypíše. Chýbajúce
      // hodnoty sú vždy explicitný, preložený text "Nie je evidované"
      // (bod 5 zadania), nikdy prázdny reťazec/undefined.
      sections: { title: string; rows: { label: string; value: string }[] }[];
    }
  | { kind: "list"; title: string; items: EntityRef[] }
  | {
      kind: "deadline_list";
      title: string;
      items: {
        entity: EntityRef;
        typeLabel: string;
        severityLabel: string;
        dueDateLabel: string;
      }[];
    }
  | {
      // SHOW_VEHICLE_DOCUMENTS (zadanie, sekcia A) — obohatený zoznam
      // dokumentov PREUKÁZANE priradených ku KONKRÉTNEMU vozidlu (naprieč
      // documents+document_links a ai_evidence, pozri
      // lib/vehicle-documents.ts). Odlišné od "list" (EntityRef[]), lebo UX
      // špecifikácia vyžaduje na jednom riadku typ dokumentu, dátum (ak
      // existuje), názov/identifikátor AJ spôsob väzby na vozidlo —
      // rovnaký precedens ako "deadline_list" vyššie (nová špecializovaná
      // list-varianta, nie paralelný systém).
      kind: "document_list";
      title: string;
      entity: EntityRef;
      items: {
        typeLabel: string;
        dateLabel: string | null;
        label: string;
        href: string;
        linkLabel: string;
      }[];
    }
  | { kind: "disambiguate"; candidates: EntityRef[] }
  | { kind: "not_found"; text: string }
  | { kind: "error"; text: string };
