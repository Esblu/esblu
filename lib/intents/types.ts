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
