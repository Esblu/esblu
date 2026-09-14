import { INTENT_NAMES, type IntentName } from "@/lib/intents/types";

// =============================================================================
// Esblu — Intent Engine registry (zadanie, bod 2 a 13).
// =============================================================================
// Metadáta ku KAŽDÉMU allowlistovanému intentu — read/write klasifikácia,
// požiadavka na potvrdenie, a krátky, needitovateľný popis pre
// diagnostiku/report. app/api/assistant/intent/route.ts z tohto registry
// vždy over, že:
//   1) intent, ktorý handler chce vykonať, je naozaj v allowliste,
//   2) `readOnly === true` (v tejto fáze VŠETKY sú readOnly — pozri
//      lib/intents/types.ts),
//   3) ak by `requiresConfirmation === true` (budúca write fáza), appka by
//      musela najprv vrátiť návrh a čakať na explicitné potvrdenie — nikdy
//      by sa nespustil priamo z parsovaného intentu.
//
// Toto je teda zámerne DUPLICITNÁ, samostatná kontrola oproti
// lib/intents/types.ts#isKnownIntentName — obe musia súhlasiť, inak
// route vráti chybu namiesto spustenia čohokoľvek (fail closed).
// =============================================================================

export type IntentDefinition = {
  name: IntentName;
  readOnly: true;
  requiresConfirmation: false;
  description: string;
};

export const INTENT_REGISTRY: Record<IntentName, IntentDefinition> = {
  OPEN_VEHICLE: {
    name: "OPEN_VEHICLE",
    readOnly: true,
    requiresConfirmation: false,
    description: "Otvor detail vozidla podľa ŠPZ alebo názvu.",
  },
  SEARCH_VEHICLE: {
    name: "SEARCH_VEHICLE",
    readOnly: true,
    requiresConfirmation: false,
    description: "Nájdi vozidlo/á podľa ŠPZ, značky alebo modelu.",
  },
  SHOW_VEHICLE_DOCUMENTS: {
    name: "SHOW_VEHICLE_DOCUMENTS",
    readOnly: true,
    requiresConfirmation: false,
    description: "Zobraz dokumenty priradené k vozidlu.",
  },
  SHOW_VEHICLE_SERVICE: {
    name: "SHOW_VEHICLE_SERVICE",
    readOnly: true,
    requiresConfirmation: false,
    description: "Zobraz servisnú históriu vozidla.",
  },
  VEHICLE_STK_STATUS: {
    name: "VEHICLE_STK_STATUS",
    readOnly: true,
    requiresConfirmation: false,
    description: "Kedy končí STK vozidla.",
  },
  VEHICLE_EK_STATUS: {
    name: "VEHICLE_EK_STATUS",
    readOnly: true,
    requiresConfirmation: false,
    description: "Kedy končí EK vozidla.",
  },
  VEHICLE_VIGNETTE_STATUS: {
    name: "VEHICLE_VIGNETTE_STATUS",
    readOnly: true,
    requiresConfirmation: false,
    description: "Kedy končí diaľničná známka vozidla.",
  },
  VEHICLE_COST_SUMMARY: {
    name: "VEHICLE_COST_SUMMARY",
    readOnly: true,
    requiresConfirmation: false,
    description: "Súčet servisných nákladov vozidla (voliteľne za rok).",
  },
  VEHICLE_REPORT: {
    name: "VEHICLE_REPORT",
    readOnly: true,
    requiresConfirmation: false,
    description: "Jednotný report vozidla (STK/EK/PZP/servis/dokumenty/náklady).",
  },
  OPEN_MACHINE: {
    name: "OPEN_MACHINE",
    readOnly: true,
    requiresConfirmation: false,
    description: "Otvor detail stroja podľa názvu.",
  },
  SEARCH_MACHINE: {
    name: "SEARCH_MACHINE",
    readOnly: true,
    requiresConfirmation: false,
    description: "Nájdi stroj/e podľa názvu, výrobcu alebo sériového čísla.",
  },
  SHOW_MACHINE_SERVICE: {
    name: "SHOW_MACHINE_SERVICE",
    readOnly: true,
    requiresConfirmation: false,
    description: "Zobraz servisnú históriu stroja.",
  },
  MACHINE_REPORT: {
    name: "MACHINE_REPORT",
    readOnly: true,
    requiresConfirmation: false,
    description: "Jednotný report stroja (servis/náklady).",
  },
  OPEN_INVENTORY_ITEM: {
    name: "OPEN_INVENTORY_ITEM",
    readOnly: true,
    requiresConfirmation: false,
    description: "Otvor skladovú položku podľa názvu.",
  },
  SEARCH_INVENTORY_ITEM: {
    name: "SEARCH_INVENTORY_ITEM",
    readOnly: true,
    requiresConfirmation: false,
    description: "Nájdi skladovú položku/y podľa názvu.",
  },
  SEARCH_DOCUMENTS: {
    name: "SEARCH_DOCUMENTS",
    readOnly: true,
    requiresConfirmation: false,
    description: "Nájdi AI dokumenty podľa textu.",
  },
  UPCOMING_DEADLINES: {
    name: "UPCOMING_DEADLINES",
    readOnly: true,
    requiresConfirmation: false,
    description: "Zoznam blížiacich sa/prekročených termínov (STK/EK/známky/servis).",
  },
};

export function isRegisteredReadOnlyIntent(name: string): name is IntentName {
  return (
    (INTENT_NAMES as readonly string[]).includes(name) &&
    INTENT_REGISTRY[name as IntentName]?.readOnly === true
  );
}
