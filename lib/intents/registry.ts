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
  /**
   * Voice Phase 2 — tretia kategória: zapisuje, ale nepýta sa pred zápisom,
   * pretože výsledok POVINNE otvorí na kontrolu (dnes výhradne
   * CREATE_INVOICE_DRAFT).
   *
   * Je to samostatný, EXPLICITNÝ príznak, nie len `requiresConfirmation:
   * false`. Rozdiel je podstatný: keby stačilo vynechať potvrdenie, stačilo
   * by pri budúcom intente jedno opomenutie a zapisoval by bez akejkoľvek
   * kontroly. Takto musí autor nového intentu vedome napísať, že jeho
   * výsledok sa dá skontrolovať — a ak to napíše nepravdivo, je to vidieť
   * v diffe na jednom riadku.
   */
  createsReviewableDraft?: boolean;
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

  OPEN_MODULE: {
    name: "OPEN_MODULE",
    readOnly: true,
    requiresConfirmation: false,
    description: "Otvor modul appky (Inbox, Faktúry, Partneri, Vozidlá, Stroje, Sklad, Nastavenia).",
  },
  SEARCH_INVOICE: {
    name: "SEARCH_INVOICE",
    readOnly: true,
    requiresConfirmation: false,
    description: "Nájdi faktúru podľa čísla alebo protistrany.",
  },
  SHOW_UNPAID_INVOICES: {
    name: "SHOW_UNPAID_INVOICES",
    readOnly: true,
    requiresConfirmation: false,
    description: "Zobraz neuhradené faktúry.",
  },
  SEARCH_PARTNER: {
    name: "SEARCH_PARTNER",
    readOnly: true,
    requiresConfirmation: false,
    description: "Nájdi obchodného partnera podľa názvu alebo IČO.",
  },

  DELETE_DOCUMENT_CATEGORY: {
    name: "DELETE_DOCUMENT_CATEGORY",
    readOnly: false,
    requiresConfirmation: true,
    description: "Zmaž vlastnú zložku dokumentov. Dokumenty v nej zostávajú zachované.",
  },
  MOVE_DOCUMENTS_TO_CATEGORY: {
    name: "MOVE_DOCUMENTS_TO_CATEGORY",
    readOnly: false,
    requiresConfirmation: true,
    description: "Presuň dokumenty z jednej vlastnej zložky do druhej, alebo ich zo zložky vyraď.",
  },

  SHOW_INVOICES_BY_STATUS: {
    name: "SHOW_INVOICES_BY_STATUS",
    readOnly: true,
    requiresConfirmation: false,
    description: "Zobraz faktúry podľa stavu (neuhradené, uhradené, po splatnosti, vydané, prijaté, rozpracované).",
  },
  SHOW_LOW_STOCK: {
    name: "SHOW_LOW_STOCK",
    readOnly: true,
    requiresConfirmation: false,
    description: "Zobraz skladové položky pod minimom alebo úplne vypredané.",
  },
  SHOW_MACHINE_DOCUMENTS: {
    name: "SHOW_MACHINE_DOCUMENTS",
    readOnly: true,
    requiresConfirmation: false,
    description: "Zobraz dokumenty priradené ku stroju.",
  },
  SHOW_MACHINE_PHOTOS: {
    name: "SHOW_MACHINE_PHOTOS",
    readOnly: true,
    requiresConfirmation: false,
    description: "Otvor fotogalériu stroja.",
  },
  OPEN_DOCUMENT_FOLDER: {
    name: "OPEN_DOCUMENT_FOLDER",
    readOnly: true,
    requiresConfirmation: false,
    description: "Otvor vlastnú zložku dokumentov podľa názvu.",
  },

  CREATE_INVOICE_DRAFT: {
    name: "CREATE_INVOICE_DRAFT",
    readOnly: false,
    requiresConfirmation: false,
    createsReviewableDraft: true,
    description:
      "Vytvor DRAFT vydanej faktúry z nadiktovaných údajov a otvor ho na kontrolu. Nikdy nefinalizuje a nikdy nezakladá partnera.",
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

/**
 * Voice Phase 2 — intenty, ktoré zapisujú bez potvrdenia, ale ich výsledok
 * sa POVINNE otvorí na kontrolu.
 *
 * Podmienky sú tri a musia platiť naraz. `createsReviewableDraft === true`
 * sám osebe by nestačil: keby ho niekto pridal k intentu, ktorý navyše
 * vyžaduje potvrdenie, vznikli by dve cesty k tomu istému zápisu a jedna
 * z nich by potvrdenie obišla.
 */
export function isRegisteredReviewableDraftIntent(name: string): name is IntentName {
  const definition = INTENT_REGISTRY[name as IntentName];
  return (
    (INTENT_NAMES as readonly string[]).includes(name) &&
    definition?.readOnly === false &&
    definition?.requiresConfirmation === false &&
    definition?.createsReviewableDraft === true
  );
}

// Ktorýkoľvek allowlistovaný intent (read alebo write) — použi LEN na
// diagnostiku/UI rozhodovanie typu "poznám tento intent vôbec"; samotné
// spustenie/potvrdenie sa vždy vetví cez isRegisteredReadOnlyIntent alebo
// isRegisteredWriteIntent vyššie, nikdy len cez toto.
export function isRegisteredIntent(name: string): name is IntentName {
  return (INTENT_NAMES as readonly string[]).includes(name) && Boolean(INTENT_REGISTRY[name as IntentName]);
}
