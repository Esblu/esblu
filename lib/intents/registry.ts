import { INTENT_NAMES, type IntentName } from "@/lib/intents/types";

// =============================================================================
// Esblu — Intent Engine registry (zadanie, bod 2 a 13).
// =============================================================================
// Metadáta ku KAŽDÉMU allowlistovanému intentu — read/write klasifikácia,
// požiadavka na potvrdenie, a krátky, needitovateľný popis pre
// diagnostiku/report. app/api/assistant/intent/route.ts z tohto registry
// vždy over, že:
//   1) intent, ktorý handler chce vykonať, je naozaj v allowliste,
//   2) ak `readOnly === true`, appka ho môže vykonať priamo (executeIntent),
//   3) ak `requiresConfirmation === true` (write intenty pridané nižšie),
//      appka NAJPRV vráti iba návrh (action_preview, lib/intents/actions.ts)
//      a čaká na explicitné potvrdenie — nikdy sa nevykoná priamo z
//      parsovaného intentu, či už z deterministického parsera alebo z AI
//      fallbacku (obe majú presne rovnakú dôveru — pozri ai-fallback.ts).
//
// Toto je teda zámerne DUPLICITNÁ, samostatná kontrola oproti
// lib/intents/types.ts#isKnownIntentName — obe musia súhlasiť, inak
// route vráti chybu namiesto spustenia čohokoľvek (fail closed).
//
// DELETE_* intent zámerne NEEXISTUJE v tomto registri ani v INTENT_NAMES —
// bezpečnejšie je nemať deletovací intent vôbec, než ho mať za potvrdením,
// ktoré by mohla obísť budúca chyba v implementácii.
// =============================================================================

export type IntentDefinition = {
  name: IntentName;
  readOnly: boolean;
  requiresConfirmation: boolean;
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
    description:
      "Zobraz dokumenty priradené k vozidlu, voliteľne filtrované podľa typu dokumentu a/alebo dátumového rozsahu.",
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
  INVENTORY_ITEM_STATUS: {
    name: "INVENTORY_ITEM_STATUS",
    readOnly: true,
    requiresConfirmation: false,
    description:
      "Priamo odpovedz na stav/zostatok jednej skladovej položky (napr. \"Aký máme zostatok pre položku sprej?\").",
  },
  SEARCH_DOCUMENTS: {
    name: "SEARCH_DOCUMENTS",
    readOnly: true,
    requiresConfirmation: false,
    description:
      "Nájdi dokumenty podľa voľného textu a/alebo filtrov (typy dokumentov, dátumový rozsah, suma).",
  },
  EXPORT_DOCUMENTS: {
    name: "EXPORT_DOCUMENTS",
    readOnly: false,
    requiresConfirmation: true,
    description:
      "Priprav export nájdených dokumentov do XLSX (žiadny zápis do DB, ale viditeľná akcia — vyžaduje potvrdenie).",
  },
  UPCOMING_DEADLINES: {
    name: "UPCOMING_DEADLINES",
    readOnly: true,
    requiresConfirmation: false,
    description: "Zoznam blížiacich sa/prekročených termínov (STK/EK/známky/servis).",
  },
  CREATE_DOCUMENT_CATEGORY: {
    name: "CREATE_DOCUMENT_CATEGORY",
    readOnly: false,
    requiresConfirmation: true,
    description: "Vytvor novú vlastnú zložku dokumentov (custom_document_categories).",
  },
  RENAME_DOCUMENT_CATEGORY: {
    name: "RENAME_DOCUMENT_CATEGORY",
    readOnly: false,
    requiresConfirmation: true,
    description: "Premenuj existujúcu vlastnú zložku dokumentov.",
  },
  ASSIGN_DOCUMENTS_TO_CATEGORY: {
    name: "ASSIGN_DOCUMENTS_TO_CATEGORY",
    readOnly: false,
    requiresConfirmation: true,
    description:
      "Hromadne priraď nájdené dokumenty (podľa filtrov) do existujúcej vlastnej zložky.",
  },
};

export function isRegisteredReadOnlyIntent(name: string): name is IntentName {
  return (
    (INTENT_NAMES as readonly string[]).includes(name) &&
    INTENT_REGISTRY[name as IntentName]?.readOnly === true
  );
}

// Write intenty — VŽDY vyžadujú requiresConfirmation === true (over sa
// explicitne, nielen readOnly === false, aby budúci nový intent nemohol
// omylom obísť potvrdzovací tok bez toho, aby to niekto všimol).
export function isRegisteredWriteIntent(name: string): name is IntentName {
  return (
    (INTENT_NAMES as readonly string[]).includes(name) &&
    INTENT_REGISTRY[name as IntentName]?.readOnly === false &&
    INTENT_REGISTRY[name as IntentName]?.requiresConfirmation === true
  );
}

// Ktorýkoľvek allowlistovaný intent (read alebo write) — použi LEN na
// diagnostiku/UI rozhodovanie typu "poznám tento intent vôbec"; samotné
// spustenie/potvrdenie sa vždy vetví cez isRegisteredReadOnlyIntent alebo
// isRegisteredWriteIntent vyššie, nikdy len cez toto.
export function isRegisteredIntent(name: string): name is IntentName {
  return (INTENT_NAMES as readonly string[]).includes(name) && Boolean(INTENT_REGISTRY[name as IntentName]);
}
