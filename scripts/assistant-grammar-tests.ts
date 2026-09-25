// =============================================================================
// Gramatika príkazov asistenta — trvalá regresná matica.
//
// SPUSTENIE
//   npm run test:assistant-grammar
//
// 1. Rozklad AKCIA + TYP + MENO: sloveso ani typové slovo nikdy nie sú menom.
// 2. Matica pre VŠETKY registrované intenty (kanonické, prirodzené,
//    preskupené, skloňované, EN/DE, hlasový tvar bez interpunkcie).
// 3. Mutácie (veľkosť písmen, interpunkcia, zdvorilosť, medzery, číslovky)
//    → ROVNAKÝ štruktúrovaný výsledok.
// 4. Kolízie (zložka vs. hľadanie, servis vs. nový stroj, …) — každá
//    historická produkčná chyba je tu natrvalo.
// 5. Hlas a text: tá istá veta → ten istý intent (líši sa iba modalita).
// 6. Aktívna úloha vs. nový príkaz; AI nikdy neprebije výslovný príkaz.
// 7. Záťaž hlasovej relácie: 25 kôl, oneskorené callbacky, mikrofón a reč nikdy naraz.
// Mená entít sú syntetické.
// =============================================================================

import assert from "node:assert/strict";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "ab".repeat(32);
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { makeDb, type Role } from "./support/memory-db.ts";

const { parseIntentDeterministic } = await import("@/lib/intents/parse");
const { decomposeCommand, actionOfWord, stripActionWords } = await import("@/lib/intents/command-grammar");
const { INTENT_NAMES } = await import("@/lib/intents/types");
const { runAssistantTurnDetailed } = await import("@/lib/intents/orchestrator");
const { translate } = await import("@/lib/i18n/translate");
const { voiceSessionReducer, INITIAL_VOICE_SESSION, decideVoiceConfirmation } = await import("@/lib/voice/voice-session");

type ParsedIntent = import("@/lib/intents/types").ParsedIntent;
type IntentResult = import("@/lib/intents/types").IntentResult;
type VoiceEvent = import("@/lib/voice/voice-session").VoiceEvent;
type VoiceEffect = import("@/lib/voice/voice-session").VoiceEffect;
type VoiceSessionState = import("@/lib/voice/voice-session").VoiceSessionState;

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const t = (key: string, vars?: Record<string, string | number>) => translate("sk", key, vars);
const parse = (text: string) => parseIntentDeterministic(text);
const low = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : value);
/** Hlavné meno entity v argumentoch intentu (na porovnanie výsledkov). */
const entityOf = (intent: ParsedIntent | null) =>
  low(intent?.args.query ?? intent?.args.entityName ?? intent?.args.folderName ?? intent?.args.categoryName ?? intent?.args.partnerQuery ?? null);

// Syntetické mená.
const ITEM = "Trimex";
const FOLDER = "Test 5";
const MACHINE = "Borvak 323";
const PLATE = "BA123CD";

// =============================================================================
// 1. ROZKLAD PRÍKAZU
// =============================================================================

await check("rozklad: príklady zo zadania → akcia, typ, meno (bez slovesa a typového slova)", () => {
  const cases: [string, string, string | undefined, string | undefined, string?][] = [
    [`Uprav skladovú položku ${ITEM}`, "update", "inventory_item", ITEM],
    [`Vymaž zložku ${FOLDER}`, "delete", "category", FOLDER],
    [`Premenuj zložku ${FOLDER} na Archív`, "rename", "category", FOLDER, "Archív"],
    [`Otvor stroj ${MACHINE}`, "open", "machine", MACHINE],
    [`Zmaž priečinok ${FOLDER}`, "delete", "folder", FOLDER],
    [`Nájdi partnera Müller Bau`, "find", "partner", "Müller Bau"],
    [`Otvor vozidlo ${PLATE}`, "open", "vehicle", PLATE],
    [`Otvor faktúru 2026001`, "open", "invoice", "2026001"],
    [`Prosím, vymaž mi tú zložku ${FOLDER}`, "delete", "category", FOLDER],
    [`Delete the folder ${FOLDER}`, "delete", "folder", FOLDER],
    [`Lösche den Ordner ${FOLDER}`, "delete", "folder", FOLDER],
  ];
  for (const [sentence, action, type, name, target] of cases) {
    const d = decomposeCommand(sentence);
    assert.equal(d?.action, action, sentence);
    assert.equal(d?.entityType, type, sentence);
    assert.equal(d?.name, name, sentence);
    if (target) assert.equal(d?.target, target, sentence);
  }
  assert.equal(decomposeCommand(`Pridaj 5 kusov do ${ITEM}a`)?.action, "add");
  assert.equal(decomposeCommand("Koľko máme vrutov")?.action ?? null, null, "bez slovesa akcie nič");
});

await check("rozklad: KAŽDÉ podporované sloveso (SK/EN/DE) × KAŽDÝ typ → meno nikdy neobsahuje sloveso ani typ", () => {
  const verbs = [
    "vytvor", "sprav", "pridaj", "uprav", "zmeň", "premenuj", "vymaž", "zmaž", "odstráň", "otvor", "ukáž", "nájdi", "presuň",
    "exportuj", "stiahni", "zvýš", "zníž", "uber", "nastav", "create", "edit", "change", "rename", "delete", "remove", "open", "show",
    "find", "move", "export", "download", "erstelle", "bearbeite", "ändere", "lösche", "entferne", "öffne", "zeige", "finde", "verschiebe",
  ];
  const types = ["zložku", "priečinok", "položku", "skladovú položku", "stroj", "vozidlo", "partnera", "faktúru", "folder", "item", "machine", "vehicle", "Ordner", "Maschine"];
  for (const verb of verbs) {
    assert.ok(actionOfWord(verb), `sloveso ${verb}`);
    for (const type of types) {
      const d = decomposeCommand(`${verb} ${type} Kolvaz 7`);
      assert.equal(d?.name, "Kolvaz 7", `${verb} ${type}`);
      for (const word of (d?.name ?? "").split(" ")) assert.equal(actionOfWord(word), null, `${verb} ${type}: sloveso v mene`);
    }
  }
  assert.equal(stripActionWords("uprav sprej"), "sprej");
  assert.equal(stripActionWords("Oprava bŕzd"), "Oprava bŕzd", "podstatné meno „Oprava“ nie je sloveso");
});

// =============================================================================
// 2. MATICA VŠETKÝCH INTENTOV
// =============================================================================

type Row = { phrases: string[]; accept?: string[]; entity?: string };
const MATRIX: Record<string, Row> = {
  OPEN_VEHICLE: { phrases: [`Otvor vozidlo ${PLATE}`, `Otvor auto ${PLATE}`, PLATE, `open vehicle ${PLATE}`, `Öffne Fahrzeug ${PLATE}`, `otvor vozidlo ba123cd`], entity: PLATE },
  SEARCH_VEHICLE: { phrases: ["Nájdi vozidlo Škoda", "Ukáž všetky vozidlá", "Vozidlá", "find vehicle Skoda", "Zeige alle Fahrzeuge"] },
  SHOW_VEHICLE_DOCUMENTS: { phrases: [`Ukáž doklady vozidla ${PLATE}`, `Dokumenty k vozidlu ${PLATE}`, `show documents for vehicle ${PLATE}`, `doklady ${PLATE}`] },
  SHOW_VEHICLE_SERVICE: { phrases: [`Ukáž servis vozidla ${PLATE}`, `Servisná história ${PLATE}`, `service history ${PLATE}`, `Kedy bol servis ${PLATE}`] },
  VEHICLE_STK_STATUS: { phrases: [`Kedy končí STK ${PLATE}`, `STK ${PLATE}`, `Kedy má ${PLATE} STK`, `when does inspection expire ${PLATE}`, `Wann läuft der TÜV ${PLATE} ab`, `platí STK na ${PLATE}`] },
  VEHICLE_EK_STATUS: { phrases: [`Kedy končí EK ${PLATE}`, `emisná kontrola ${PLATE}`, `EK ${PLATE}`] },
  VEHICLE_VIGNETTE_STATUS: { phrases: [`Kedy končí známka ${PLATE}`, `diaľničná známka ${PLATE}`, `vignette ${PLATE}`] },
  VEHICLE_COST_SUMMARY: { phrases: [`Koľko sme minuli na servis ${PLATE}`, `Koľko stál servis ${PLATE} v roku 2026`, `náklady na servis ${PLATE}`] },
  VEHICLE_REPORT: { phrases: [`Report vozidla ${PLATE}`, `vehicle report ${PLATE}`, `Urob report ${PLATE}`] },
  OPEN_MACHINE: { phrases: [`Otvor stroj ${MACHINE}`, `Otvor stroj ${MACHINE}.`, `open machine ${MACHINE}`, `Öffne Maschine ${MACHINE}`, `otvor stroj borvak 323`], entity: MACHINE },
  SEARCH_MACHINE: { phrases: [`Nájdi stroj ${MACHINE}`, "Ukáž stroje", "Stroje", `find machine ${MACHINE}`, "Zeige Maschinen", "Ukáž všetky stroje"], accept: ["OPEN_MACHINE"] },
  SHOW_MACHINE_SERVICE: { phrases: [`Ukáž servis stroja ${MACHINE}`, `Servisná história stroja ${MACHINE}`, `Kedy bol servis stroja ${MACHINE}`, `machine service history ${MACHINE}`, "Ukáž servisnú históriu"] },
  MACHINE_REPORT: { phrases: [`Report stroja ${MACHINE}`, `machine report ${MACHINE}`, `Urob report stroja ${MACHINE}`] },
  OPEN_INVENTORY_ITEM: { phrases: [`Otvor skladovú položku ${ITEM}`, `Otvor položku ${ITEM}`, `open inventory item ${ITEM}`, `Otvor v sklade ${ITEM}`], entity: ITEM },
  SEARCH_INVENTORY_ITEM: { phrases: [`Nájdi v sklade ${ITEM}`, "Ukáž sklad", "Sklad", `skladová položka ${ITEM}`, `find in inventory ${ITEM}`, "Zeige Lager", `${ITEM} v sklade`], accept: ["OPEN_INVENTORY_ITEM"] },
  INVENTORY_ITEM_STATUS: { phrases: [`Koľko máme ${ITEM}u na sklade`, "Koľko je na sklade vrutov", `Stav skladu ${ITEM}`, `koľko máme ${ITEM}ov`, `Ukáž stav skladu ${ITEM}`] },
  SEARCH_DOCUMENTS: { phrases: ["Ukáž faktúry", "Nájdi bločky za august", "Ukáž doklady od Tester1", "show receipts from august", "Zeige Belege", "faktúry za september"] },
  EXPORT_DOCUMENTS: { phrases: ["Exportuj faktúry za august", "Exportuj bločky do Excelu", "export receipts", "Exportiere Rechnungen", "Exportuj doklady za september"] },
  UPCOMING_DEADLINES: { phrases: ["Aké termíny sa blížia", "Čo nás čaká", "Blížiace sa termíny", "upcoming deadlines", "Welche Fristen stehen an", "Ktoré stroje potrebujú servis"] },
  CREATE_DOCUMENT_CATEGORY: { phrases: ["Vytvor zložku Dodacie listy", "Vytvor novú zložku Nafta", "create category Diesel", "Založ zložku Nafta", "Erstelle Kategorie Diesel"] },
  RENAME_DOCUMENT_CATEGORY: { phrases: [`Premenuj zložku ${FOLDER} na Archív`, "Premenuj zložku Nafta na Palivo", "rename category Diesel to Fuel"] },
  ASSIGN_DOCUMENTS_TO_CATEGORY: { phrases: ["Daj všetky bločky za august do zložky August", "Priraď faktúry za september do zložky Archív", "Presuň bločky za august do zložky August"] },
  OPEN_MODULE: { phrases: ["Otvor faktúry", "Prejdi do skladu", "Otvor Inbox", "open invoices", "Öffne die Rechnungen", "otvor nastavenia"] },
  SEARCH_INVOICE: { phrases: ["Nájdi faktúru 2026001", "Otvor faktúru 2026001", "find invoice 2026001", "Finde Rechnung 2026001"] },
  SHOW_UNPAID_INVOICES: { phrases: ["Ukáž neuhradené faktúry", "Ktoré faktúry nie sú zaplatené", "unpaid invoices", "offene Rechnungen", "neuhradené faktúry"] },
  SEARCH_PARTNER: { phrases: ["Nájdi partnera Tester1", "Otvor zákazníka Tester1", "Ukáž obchodných partnerov", "find partner Tester1", "Finde Kunde Tester1", "Nájdi odberateľa Müller Bau"] },
  DELETE_DOCUMENT_CATEGORY: { phrases: [`Vymaž zložku ${FOLDER}`, `Zmaž zložku ${FOLDER}`, `Odstráň zložku ${FOLDER}`, `Delete category ${FOLDER}`, `Lösche Kategorie ${FOLDER}`, "prosím vymaž zložku test 5", `vymaz zlozku ${FOLDER}`], entity: FOLDER },
  MOVE_DOCUMENTS_TO_CATEGORY: { phrases: ["Presuň dokumenty zo zložky Alfa do zložky Beta", "Presuň doklady zo zložky Nafta do zložky Palivo", "move documents from category Alfa to category Beta"] },
  SHOW_INVOICES_BY_STATUS: { phrases: ["Ukáž uhradené faktúry", "Ukáž faktúry po splatnosti", "Ukáž prijaté faktúry", "paid invoices", "überfällige Rechnungen", "rozpracované faktúry"] },
  SHOW_LOW_STOCK: { phrases: ["Čo nám dochádza", "Položky pod minimom", "Nízke zásoby", "low stock", "Was geht aus", "čo dochádza na sklade"] },
  SHOW_MACHINE_DOCUMENTS: { phrases: [`Ukáž doklady stroja ${MACHINE}`, `Dokumenty stroja ${MACHINE}`, `machine documents ${MACHINE}`, `ukáž mi dokumenty k stroju ${MACHINE}`], entity: MACHINE },
  SHOW_MACHINE_PHOTOS: { phrases: [`Ukáž fotky stroja ${MACHINE}`, `Fotky stroja ${MACHINE}`, `machine photos ${MACHINE}`], entity: MACHINE },
  OPEN_DOCUMENT_FOLDER: { phrases: ["Otvor zložku Nafta", "Ukáž zložku Nafta", "open category Diesel"] },
  PROCESS_CURRENT_DOCUMENT_AS_RECEIVED_INVOICE: { phrases: ["Spracuj tento doklad ako prijatú faktúru", "Toto je prijatá faktúra", "process this document as received invoice"] },
  FOLDER_CREATE: { phrases: ["Vytvor priečinok August", "Založ nový priečinok Účtovníctvo", "create accounting folder August", "Erstelle Belegordner August", "vytvor priečinok august 2026"] },
  FOLDER_OPEN: { phrases: ["Otvor priečinok August", "Ukáž priečinok August", "open accounting folder August", "Öffne Belegordner August"] },
  FOLDER_ADD_ITEMS: { phrases: ["Pridaj do priečinka August bločky za august", "Daj bločky za august do priečinka August", "Pridaj faktúry do priečinka September", "add receipts to accounting folder August"] },
  FOLDER_REMOVE_ITEMS: { phrases: ["Odstráň z priečinka August bločky", "Vyraď z priečinka August faktúry", "remove receipts from accounting folder August"] },
  FOLDER_LIST_ITEMS: { phrases: ["Čo je v priečinku August", "Ukáž obsah priečinka August", "what is in accounting folder August"] },
  FOLDER_EXPORT: { phrases: ["Stiahni priečinok August", "Exportuj priečinok August", "download accounting folder August", "Lade Belegordner August herunter"] },
  DOCUMENTS_EXPORT: { phrases: ["Stiahni bločky za august", "Stiahni faktúry za september", "download receipts from august"] },
  DOCUMENTS_LIST_UNDOWNLOADED: { phrases: ["Ktoré doklady ešte neboli stiahnuté", "Nestiahnuté bločky", "undownloaded documents"] },
  DOCUMENTS_DOWNLOAD_STATUS: { phrases: ["Koľko ešte účtovníčka nestiahla", "Stiahla účtovníčka faktúry za august", "Boli bločky za august stiahnuté", "were august receipts downloaded"] },
  FOLDER_DELETE: { phrases: [`Vymaž priečinok ${FOLDER}`, `Zmaž priečinok ${FOLDER}`, `Odstráň priečinok ${FOLDER}`, `delete accounting folder ${FOLDER}`, `Lösche Belegordner ${FOLDER}`, "Vymaž mi priečinok test 5"], entity: FOLDER },
  INVENTORY_ITEM_CREATE: { phrases: [`Vytvor skladovú položku ${ITEM}`, `Pridaj do skladu novú položku ${ITEM}`, `Vytvor novú položku v sklade ${ITEM}`, `create inventory item ${ITEM}`, `založ skladovú položku ${ITEM.toLowerCase()}`] },
  INVENTORY_QUANTITY_ADJUST: { phrases: ["Pridaj do skladu 20 vrutov", `Pridaj do položky ${ITEM} 5 kusov`, `Zníž ${ITEM} o 2`, `Nastav ${ITEM} na 5`, `Pridaj 5 kusov do ${ITEM}a`, `Uber z položky ${ITEM} dva kusy`, `add 5 to item ${ITEM}`, `Pridaj do položky ${ITEM}`] },
  INVENTORY_ITEM_DELETE: { phrases: [`Vymaž skladovú položku ${ITEM}`, `Zmaž položku ${ITEM}`, `Odstráň položku ${ITEM} zo skladu`, `delete inventory item ${ITEM}`, `Lösche Artikel ${ITEM}`], entity: ITEM },
  INVENTORY_ITEM_EDIT: { phrases: [`Uprav skladovú položku ${ITEM}`, `Uprav položku ${ITEM}`, `Zmeň skladovú položku ${ITEM}`, `edit inventory item ${ITEM}`, `Bearbeite Artikel ${ITEM}`, `prosím uprav položku ${ITEM.toLowerCase()}`, `uprav skladovu polozku ${ITEM}`], entity: ITEM },
  MACHINE_CREATE: { phrases: [`Pridaj nový stroj ${MACHINE}`, `Vytvor stroj s názvom ${MACHINE}`, "Zaeviduj nový stroj CAT 320", `add machine ${MACHINE}`, `Lege neue Maschine ${MACHINE} an`] },
  MACHINE_SERVICE_ADD: { phrases: [`Pridaj servis k ${MACHINE}`, `Pridaj servis ${MACHINE}`, `Do stroja ${MACHINE} pridaj výmenu oleja`, `Zaeviduj servis stroja ${MACHINE} výmena oleja`, `Na ${MACHINE} bola výmena oleja`, `add service to machine ${MACHINE}`] },
  MACHINE_DELETE: { phrases: [`Vymaž stroj ${MACHINE}`, `Zmaž stroj ${MACHINE}`, `Odstráň stroj ${MACHINE}`, `delete machine ${MACHINE}`, `Lösche Maschine ${MACHINE}`], entity: MACHINE },
  MACHINE_PHOTO_ADD: { phrases: [`Pridaj fotku k stroju ${MACHINE}`, `Nahraj fotku stroja ${MACHINE}`, `upload photo of machine ${MACHINE}`] },
  VEHICLE_CREATE: { phrases: [`Pridaj nové vozidlo ${PLATE}`, `Vytvor vozidlo ${PLATE}`, `add vehicle ${PLATE}`, `Zaeviduj nové auto ${PLATE}`] },
  VEHICLE_SERVICE_ADD: { phrases: [`Pridaj servis k ${PLATE} za 250 eur`, `Zaeviduj servis vozidla ${PLATE}`, `Pri ${PLATE} sa robil servis za 350 eur`, `add service to vehicle ${PLATE}`] },
  VEHICLE_DELETE: { phrases: [`Vymaž vozidlo ${PLATE}`, `Zmaž auto ${PLATE}`, `Odstráň vozidlo ${PLATE}`, `delete vehicle ${PLATE}`], entity: PLATE },
  VEHICLE_PHOTO_ADD: { phrases: [`Pridaj fotku k vozidlu ${PLATE}`, `Nahraj fotku vozidla ${PLATE}`, `upload photo of vehicle ${PLATE}`] },
  DOCUMENT_INTAKE: { phrases: ["Pridaj bloček", "Nahraj bloček", "Odfoť dodací list", "upload receipt", "Pridaj dodací list", "naskenuj faktúru"] },
  ENTITY_CREATE: { phrases: ["Vytvor novú položku", `Pridaj položku ${ITEM}`, `Vytvor položku ${ITEM}`] },
  INBOX_LIST_UNASSIGNED: { phrases: ["Ukáž nepriradené bločky", "Koľko je nepriradených faktúr", "unassigned receipts", "nicht zugeordnete Belege"] },
  PARTNER_CREATE: { phrases: ["Pridaj nového partnera Müller Bau", "Vytvor obchodného partnera Tester2", "add new customer Muller", "Založ nového odberateľa Stavby s.r.o."] },
  FOLDER_RENAME: { phrases: ["Premenuj priečinok August na September", "rename accounting folder August to September", "rename folder August to September", "Benenne Ordner August in September um"] },
  INVENTORY_ITEM_RENAME: { phrases: [`Premenuj položku ${ITEM} na Lak`, `Premenuj skladovú položku ${ITEM} na ${ITEM} červený`, `rename item ${ITEM} to Lacquer`] },
  INBOX_DELETE_UNASSIGNED: { phrases: ["Vymaž nepriradené bločky", "Zmaž nepriradené faktúry", "delete unassigned receipts"] },
  CREATE_INVOICE_DRAFT: { phrases: ["Vytvor faktúru", "Vytvor faktúru pre Tester1", "Vystav faktúru Tester1 za kopanie 300 eur", "Nová faktúra", "create invoice for Tester1", "Erstelle Rechnung für Tester1"] },
};

await check("matica: pokrýva VŠETKY registrované intenty", () => {
  const missing = INTENT_NAMES.filter((name) => !MATRIX[name]);
  assert.deepEqual(missing, [], `intenty bez fráz: ${missing.join(", ")}`);
  for (const [name, row] of Object.entries(MATRIX)) assert.ok(row.phrases.length >= 3, `${name}: aspoň 3 frázy`);
});

let matrixPhrases = 0;
await check("matica: každá fráza → správny intent (aj s entitou tam, kde je určená)", () => {
  const misses: string[] = [];
  for (const [name, row] of Object.entries(MATRIX)) {
    for (const phrase of row.phrases) {
      matrixPhrases++;
      const parsed = parse(phrase);
      const ok = parsed?.name === name || (row.accept ?? []).includes(parsed?.name ?? "");
      if (!ok) misses.push(`${name} ← „${phrase}“ = ${parsed?.name ?? "null"}`);
      else if (row.entity && parsed?.name === name && entityOf(parsed) !== row.entity.toLowerCase()) {
        misses.push(`${name} ← „${phrase}“ meno ${String(entityOf(parsed))} ≠ ${row.entity}`);
      }
    }
  }
  assert.deepEqual(misses, []);
});

// =============================================================================
// 3. MUTÁCIE — ten istý význam, ten istý výsledok
// =============================================================================

const MUTATIONS: [string, (text: string) => string][] = [
  ["malé písmená", (text) => text.toLowerCase()],
  ["bez interpunkcie", (text) => text.replace(/[.,!?]/g, "")],
  ["bodka na konci", (text) => `${text.replace(/[.!?]+$/, "")}.`],
  ["dvojité medzery", (text) => text.replace(/ /g, "  ")],
  ["zdvorilosť na začiatku", (text) => `Prosím, ${text.charAt(0).toLowerCase()}${text.slice(1)}`],
  ["zdvorilosť na konci", (text) => `${text.replace(/[.!?]+$/, "")}, prosím.`],
  ["oslovenie", (text) => `Esblu, ${text.charAt(0).toLowerCase()}${text.slice(1)}`],
  ["prepis bez diakritiky", (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "")],
];

await check("mutácie: zápisy a kľúčové čítania dávajú ROVNAKÝ intent aj meno", () => {
  const writeIntents = [
    "DELETE_DOCUMENT_CATEGORY", "FOLDER_DELETE", "INVENTORY_ITEM_DELETE", "MACHINE_DELETE", "VEHICLE_DELETE", "INVENTORY_ITEM_EDIT",
    "INVENTORY_QUANTITY_ADJUST", "MACHINE_SERVICE_ADD", "FOLDER_CREATE", "CREATE_DOCUMENT_CATEGORY", "INVENTORY_ITEM_RENAME",
    "FOLDER_RENAME", "OPEN_MACHINE", "OPEN_VEHICLE", "SHOW_UNPAID_INVOICES", "SHOW_MACHINE_DOCUMENTS",
  ];
  const misses: string[] = [];
  for (const name of writeIntents) {
    for (const phrase of MATRIX[name].phrases.filter((p) => /[a-z]/i.test(p) && !/^(delete|lösche|add|edit|bearbeite|rename|create|upload|machine|open|unpaid|offene)/i.test(p))) {
      const base = parse(phrase);
      for (const [label, mutate] of MUTATIONS) {
        const mutated = parse(mutate(phrase));
        if (mutated?.name !== base?.name || entityOf(mutated)?.toString().normalize("NFD").replace(/[̀-ͯ]/g, "") !== entityOf(base)?.toString().normalize("NFD").replace(/[̀-ͯ]/g, "")) {
          misses.push(`${label}: „${mutate(phrase)}“ → ${mutated?.name}/${String(entityOf(mutated))} ≠ ${base?.name}/${String(entityOf(base))}`);
        }
      }
    }
  }
  assert.deepEqual(misses, []);
});

await check("mutácie: číslovka slovom = číslicou; skloňovaný tvar mena = ten istý cieľ", () => {
  for (const [digits, words] of [
    [`Pridaj do položky ${ITEM} 5 kusov`, `Pridaj do položky ${ITEM} päť kusov`],
    [`Zníž ${ITEM} o 2`, `Zníž ${ITEM} o dva`],
    [`Nastav ${ITEM} na 3`, `Nastav ${ITEM} na tri`],
  ]) {
    const a = parse(digits);
    const b = parse(words);
    assert.equal(a?.args.quantity, b?.args.quantity, words);
    assert.equal(a?.args.quantityMode, b?.args.quantityMode, words);
  }
});

// =============================================================================
// 4. KOLÍZIE — výslovná akcia vždy vyhráva
// =============================================================================

await check("kolízie: každá historická chyba je natrvalo zakázaná", () => {
  const cases: [string, string, string[]][] = [
    // [veta, očakávaný intent, zakázané intenty]
    [`Uprav skladovú položku ${ITEM.toLowerCase()}.`, "INVENTORY_ITEM_EDIT", ["SEARCH_INVENTORY_ITEM", "OPEN_INVENTORY_ITEM"]],
    [`Vymaž zložku ${FOLDER.toLowerCase()}`, "DELETE_DOCUMENT_CATEGORY", ["SEARCH_DOCUMENTS"]],
    ["Vytvor zložku Dodacie listy", "CREATE_DOCUMENT_CATEGORY", ["SEARCH_DOCUMENTS"]],
    [`Pridaj servis ${MACHINE}`, "MACHINE_SERVICE_ADD", ["MACHINE_CREATE"]],
    [`Do stroja ${MACHINE} pridaj výmenu oleja a filtrov`, "MACHINE_SERVICE_ADD", ["MACHINE_CREATE"]],
    ["Vytvor faktúru", "CREATE_INVOICE_DRAFT", ["SEARCH_DOCUMENTS"]],
    ["Nájdi partnera Tester1", "SEARCH_PARTNER", ["OPEN_VEHICLE", "SEARCH_MACHINE", "OPEN_MACHINE"]],
    ["Stiahni priečinok August", "FOLDER_EXPORT", ["DOCUMENTS_EXPORT", "EXPORT_DOCUMENTS"]],
    ["Exportuj faktúry za august", "EXPORT_DOCUMENTS", ["FOLDER_EXPORT"]],
    [`Pridaj do položky ${ITEM}`, "INVENTORY_QUANTITY_ADJUST", ["ENTITY_CREATE", "INVENTORY_ITEM_CREATE"]],
    [`Vytvor skladovú položku ${ITEM}`, "INVENTORY_ITEM_CREATE", ["INVENTORY_QUANTITY_ADJUST"]],
    ["Ukáž neuhradené faktúry", "SHOW_UNPAID_INVOICES", ["SEARCH_DOCUMENTS"]],
    ["Ktoré faktúry nie sú zaplatené", "SHOW_UNPAID_INVOICES", ["SHOW_INVOICES_BY_STATUS"]],
    ["Ukáž faktúry po splatnosti", "SHOW_INVOICES_BY_STATUS", ["UPCOMING_DEADLINES"]],
    [`Ukáž doklady stroja ${MACHINE}`, "SHOW_MACHINE_DOCUMENTS", ["SEARCH_DOCUMENTS"]],
    ["Otvor zložku Nafta", "OPEN_DOCUMENT_FOLDER", ["OPEN_MODULE", "OPEN_VEHICLE"]],
    ["Presuň doklady zo zložky Nafta do zložky Palivo", "MOVE_DOCUMENTS_TO_CATEGORY", ["SEARCH_DOCUMENTS"]],
    ["Vymaž nepriradené bločky", "INBOX_DELETE_UNASSIGNED", ["DELETE_DOCUMENT_CATEGORY", "FOLDER_DELETE"]],
    ["Odstráň z priečinka August bločky", "FOLDER_REMOVE_ITEMS", ["FOLDER_DELETE"]],
    ["Nájdi vozidlo Škoda", "SEARCH_VEHICLE", []],
  ];
  for (const [sentence, expected, forbidden] of cases) {
    const parsed = parse(sentence);
    assert.equal(parsed?.name, expected, sentence);
    assert.ok(!forbidden.includes(parsed?.name ?? ""), sentence);
  }
  // Typové slovo nikdy nie je súčasťou hľadaného mena.
  assert.equal(parse("Nájdi vozidlo Škoda")?.args.query, "Škoda");
  assert.equal(parse(`Uprav skladovú položku ${ITEM}`)?.args.query, ITEM);
  for (const sentence of [`Uprav skladovú položku ${ITEM}`, `Zmeň položku ${ITEM}`, `Vymaž zložku ${FOLDER}`, `Otvor stroj ${MACHINE}`]) {
    const query = String(parse(sentence)?.args.query ?? parse(sentence)?.args.categoryName ?? "").toLowerCase();
    for (const word of ["uprav", "zmen", "zmeň", "vymaž", "otvor", "položk", "zložk", "stroj", "skladov"]) assert.ok(!query.includes(word), `${sentence}: „${word}“ v mene`);
  }
});

// =============================================================================
// 5. ORCHESTRÁTOR: hlas = text, aktívna úloha, AI, chýbajúce sloty
// =============================================================================

const CONV = "abcdefabcdefabcdefabcdefabcdef12";
const ACCESS: Record<Role, { financeView: boolean; financeManage: boolean; canOperate: boolean }> = {
  owner: { financeView: true, financeManage: true, canOperate: true },
  admin: { financeView: true, financeManage: true, canOperate: true },
  accountant: { financeView: true, financeManage: true, canOperate: false },
  employee: { financeView: false, financeManage: false, canOperate: true },
};
type Env = ReturnType<typeof makeDb>;
const TABLES = () => ({
  inventory_items: [{ id: "i-trimex", name: ITEM, quantity: 12, unit: "ks" }],
  machines: [{ id: "m-borvak", name: MACHINE, manufacturer: null, model: null }],
  document_folders: [{ id: "f-test5", name: FOLDER, description: null, created_at: "2026-01-01", updated_at: "2026-01-01", created_by: "x" }],
  custom_document_categories: [{ id: "c-nafta", name: "Nafta", canonical_slug: "nafta" }],
});

function session(env: Env, opts: { voice: boolean; ai?: (text: string) => ParsedIntent | null }) {
  let pending: string | null = null;
  let aiCalls = 0;
  return {
    get aiCalls() { return aiCalls; },
    get pending() { return pending; },
    async say(text: string) {
      const { output, finalIntent } = await runAssistantTurnDetailed(
        { db: env.db, classifyWithAi: async (raw) => { aiCalls++; return opts.ai ? opts.ai(raw) : null; } },
        {
          rawText: text, locale: "sk", userId: env.userId, companyId: env.companyId, role: env.state.role, ...ACCESS[env.state.role],
          // Hlas na nástenke posiela dialóg; písaný text na nástenke nie.
          conversationId: opts.voice ? CONV : null,
          pendingClarification: pending, structuredPartnerId: null, issueDate: "2026-09-26", uiContext: null,
          moduleContext: "dashboard" as never, selection: null, folderContextId: null,
        }
      );
      pending = output.pendingClarification ?? null;
      return { result: output.result, intent: finalIntent };
    },
  };
}
const text = (r: IntentResult) => ((r as { text?: string }).text ?? (r as { summary?: string }).summary ?? (r as { question?: string }).question ?? (r as { title?: string }).title ?? "").replace(/ /g, " ");

await check("hlas vs. text: tá istá veta → ten istý intent (líši sa iba modalita)", async () => {
  const misses: string[] = [];
  for (const [name, row] of Object.entries(MATRIX)) {
    for (const phrase of row.phrases.slice(0, 3)) {
      const voice = await session(makeDb({ role: "owner", financeManage: true, tables: TABLES() }), { voice: true }).say(phrase);
      const typed = await session(makeDb({ role: "owner", financeManage: true, tables: TABLES() }), { voice: false }).say(phrase);
      if (voice.intent?.name !== typed.intent?.name) misses.push(`${name}: „${phrase}“ hlas=${voice.intent?.name} text=${typed.intent?.name}`);
    }
  }
  assert.deepEqual(misses, []);
});

await check("PRODUKCIA A: „Uprav skladovú položku sprej.“ → overená položka + otázka čo zmeniť, NIKDY hľadanie „uprav sprej“", async () => {
  const s = session(makeDb({ role: "owner", financeManage: true, tables: TABLES() }), { voice: true });
  const r = await s.say(`Uprav skladovú položku ${ITEM.toLowerCase()}.`);
  assert.equal(r.intent?.name, "INVENTORY_ITEM_EDIT");
  assert.equal(text(r.result), t("assistant.inventory.askEditField", { name: ITEM }));
  assert.doesNotMatch(text(r.result), /uprav/i);
  assert.ok(s.pending);
  const count = await s.say("počet");
  assert.equal(text(count.result), t("assistant.inventory.askQuantityFor.set", { name: ITEM }));
  const done = await s.say("päť");
  assert.equal(done.result.kind, "action_preview");
  assert.match(text(done.result), /z 12 ks na 5 ks/);
});

await check("úprava položky: „názov“ → otázka na nový názov → náhľad premenovania; „premenuj na X“ priamo", async () => {
  const s = session(makeDb({ role: "owner", financeManage: true, tables: TABLES() }), { voice: true });
  await s.say(`Uprav položku ${ITEM}`);
  assert.equal(text((await s.say("názov")).result), t("assistant.inventory.askNewName", { name: ITEM }));
  const renamed = await s.say("Lak červený");
  assert.equal(renamed.intent?.name, "INVENTORY_ITEM_RENAME");
  assert.equal(renamed.result.kind, "action_preview");
  const s2 = session(makeDb({ role: "owner", financeManage: true, tables: TABLES() }), { voice: true });
  await s2.say(`Uprav položku ${ITEM}`);
  assert.equal((await s2.say("premenuj na Lak modrý")).intent?.name, "INVENTORY_ITEM_RENAME");
});

await check("PRODUKCIA B: „Vymaž zložku test 5“ → presný priečinok → náhľad s potvrdením (aj „Zmaž/Odstráň“)", async () => {
  for (const phrase of [`Vymaž zložku ${FOLDER.toLowerCase()}`, `Zmaž priečinok ${FOLDER}`, `Odstráň zložku ${FOLDER}`]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
    const r = await session(env, { voice: true }).say(phrase);
    assert.equal(r.intent?.name, "FOLDER_DELETE", phrase);
    assert.equal(r.result.kind, "action_preview", phrase);
    assert.equal((r.result as { destructive?: boolean }).destructive ?? true, true);
    assert.equal(env.state.tables.document_folders.length, 1, "náhľad nič nezmazal");
  }
  // Iba zložka dokumentov s tým menom → zložka (bez otázky).
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const category = await session(env, { voice: true }).say("Vymaž zložku Nafta");
  assert.equal(category.intent?.name, "DELETE_DOCUMENT_CATEGORY");
  assert.equal(category.result.kind, "action_preview");
  // Hlasové odpovede na potvrdenie.
  assert.equal(decideVoiceConfirmation("Áno."), "confirm");
  assert.equal(decideVoiceConfirmation("Nie."), "cancel");
  assert.equal(decideVoiceConfirmation("hm"), "ask_again");
});

await check("chýbajúci slot: „Vymaž zložku“ → otázka; „Uprav položku X“ → čo zmeniť; „Pridaj do X“ → množstvo", async () => {
  const s = session(makeDb({ role: "owner", financeManage: true, tables: TABLES() }), { voice: true });
  const r = await s.say("Vymaž zložku");
  assert.equal(text(r.result), t("assistant.clarify.whichCategoryDelete"));
  const answer = await s.say(FOLDER);
  assert.equal(answer.intent?.name, "FOLDER_DELETE");
  const s2 = session(makeDb({ role: "owner", financeManage: true, tables: TABLES() }), { voice: true });
  assert.equal(text((await s2.say(`Pridaj do ${ITEM}a`)).result), t("assistant.inventory.askQuantityFor.add", { name: ITEM }));
});

await check("aktívna úloha: zrušenie > výslovný nový príkaz > odpoveď na slot > parser", async () => {
  const s = session(makeDb({ role: "owner", financeManage: true, tables: TABLES() }), { voice: true });
  await s.say(`Pridaj do položky ${ITEM}`);
  assert.equal(text((await s.say("stop")).result), t("assistant.clarify.cancelled"), "1. zrušenie");
  await s.say(`Pridaj do položky ${ITEM}`);
  assert.equal((await s.say(`Vymaž zložku ${FOLDER}`)).intent?.name, "FOLDER_DELETE", "2. výslovný nový príkaz");
  await s.say(`Pridaj do položky ${ITEM}`);
  assert.match(text((await s.say("Päť")).result), /na 17 ks/, "3. odpoveď na slot, nie nový príkaz");
  await s.say(`Uprav položku ${ITEM}`);
  assert.equal((await s.say(`Vymaž zložku ${FOLDER}`)).intent?.name, "FOLDER_DELETE", "otázka na pole nepohltí nový príkaz");
});

await check("AI nikdy neprebije výslovný príkaz; neznámy zápis = jasná veta, nie náhodný výsledok", async () => {
  const hostileAi = () => ({ name: "SEARCH_DOCUMENTS", args: { query: "čokoľvek" }, source: "ai" }) as ParsedIntent;
  const s = session(makeDb({ role: "owner", financeManage: true, tables: TABLES() }), { voice: true, ai: hostileAi });
  const r = await s.say(`Vymaž zložku ${FOLDER}`);
  assert.equal(r.intent?.name, "FOLDER_DELETE");
  const unsupported = await s.say("Vymaž partnera Müller Bau");
  assert.equal(text(unsupported.result), t("assistant.clarify.actionNotSupported"));
  const edit = await s.say(`Uprav skladovú položku ${ITEM}`);
  assert.equal(edit.intent?.name, "INVENTORY_ITEM_EDIT");
  assert.equal(s.aiCalls, 0, "AI sa pri výslovnej akcii ani nespýta");
});

await check("oprávnenia nezmenené: zamestnanec a účtovník nedostanú úpravu/mazanie", async () => {
  for (const role of ["employee", "accountant"] as const) {
    const s = session(makeDb({ role, financeManage: role === "accountant", tables: TABLES() }), { voice: true });
    for (const phrase of [`Uprav skladovú položku ${ITEM}`, `Vymaž stroj ${MACHINE}`]) {
      const r = await s.say(phrase);
      assert.equal(r.result.kind, "error", `${role}: ${phrase}`);
      assert.equal(s.pending, null);
    }
  }
});

// =============================================================================
// 6. ZÁŤAŽ HLASOVEJ RELÁCIE — 25 kôl
// =============================================================================

await check("záťaž: 25 kôl bez ťuknutia, každá odpoveď zaznie, mikrofón a reč nikdy naraz, oneskorené callbacky bez účinku", () => {
  let state: VoiceSessionState = INITIAL_VOICE_SESSION;
  let mic = false;
  let speaking = false;
  let speaks = 0;
  const effectsOf = (event: VoiceEvent): VoiceEffect[] => {
    const step = voiceSessionReducer(state, event);
    state = step.state;
    for (const effect of step.effects) {
      if (effect.type === "listen") {
        assert.ok(!speaking, "počúvanie počas reči");
        mic = true;
      }
      if (effect.type === "releaseMic" || effect.type === "cancelListen") mic = false;
      if (effect.type === "speak" || effect.type === "speakNotice") {
        assert.ok(!mic, "reč s otvoreným mikrofónom");
        speaking = true;
        speaks++;
      }
      if (effect.type === "cancelSpeech") speaking = false;
    }
    assert.ok(!(mic && speaking));
    return step.effects;
  };
  effectsOf({ type: "USER_TAP" });
  for (let turn = 0; turn < 25; turn++) {
    const genAtStart = state.gen;
    effectsOf({ type: "MIC_READY", gen: state.gen });
    // Krátke ticho medzi vetami reláciu neukončí.
    if (turn % 5 === 0) effectsOf({ type: "NO_SPEECH", gen: state.gen });
    effectsOf({ type: "UTTERANCE_CAPTURED", gen: state.gen });
    effectsOf({ type: "TRANSCRIPT", text: `veta ${turn}`, gen: state.gen });
    const speakGen = state.gen;
    effectsOf({ type: "TURN_RESULT", spoken: `odpoveď ${turn}`, gen: state.gen });
    assert.equal(state.status, "speaking", `kolo ${turn}: odpoveď zaznie`);
    // Oneskorené dokončenie STARŠIEHO kola nič nezmení.
    const stale = voiceSessionReducer(state, { type: "SPEECH_DONE", gen: genAtStart });
    assert.equal(stale.state, state, `kolo ${turn}: starý onend ignorovaný`);
    assert.equal(stale.effects.length, 0);
    speaking = false;
    effectsOf({ type: "SPEECH_DONE", gen: speakGen + 1 });
    assert.equal(state.status, "starting", `kolo ${turn}: znova počúva`);
  }
  assert.equal(speaks, 25, "každá odpoveď vyvolala reč");
  assert.equal(state.turn, 25);
  // Zastavenie: žiadny oneskorený callback ho nereštartuje.
  effectsOf({ type: "STOP", reason: "user" });
  for (const late of [{ type: "SPEECH_DONE", gen: state.gen }, { type: "MIC_READY", gen: state.gen }, { type: "TURN_RESULT", spoken: "x" }] as VoiceEvent[]) {
    const step = voiceSessionReducer(state, late);
    assert.equal(step.state.status, "stopped");
    assert.ok(!step.effects.some((effect) => effect.type === "acquireMic" || effect.type === "listen"));
  }
});

await check("záťaž: oneskorený prepis / odpoveď servera staršieho kola nemení novšie kolo", () => {
  let state: VoiceSessionState = INITIAL_VOICE_SESSION;
  const send = (event: VoiceEvent) => (state = voiceSessionReducer(state, event).state);
  send({ type: "USER_TAP" });
  send({ type: "MIC_READY", gen: state.gen });
  send({ type: "UTTERANCE_CAPTURED", gen: state.gen });
  const oldTranscribeGen = state.gen;
  // Používateľ reláciu zastaví a spustí znova, kým beží starý prepis.
  send({ type: "STOP", reason: "user" });
  send({ type: "USER_TAP" });
  send({ type: "MIC_READY", gen: state.gen });
  send({ type: "UTTERANCE_CAPTURED", gen: state.gen });
  const before = state;
  send({ type: "TRANSCRIPT", text: "stará veta", gen: oldTranscribeGen });
  assert.equal(state, before, "starý prepis ignorovaný");
  send({ type: "TRANSCRIPT", text: "nová veta", gen: state.gen });
  assert.equal(state.status, "waiting_server");
  const serverGen = state.gen;
  send({ type: "TURN_RESULT", spoken: "stará odpoveď", gen: serverGen - 5 });
  assert.equal(state.status, "waiting_server", "stará odpoveď servera ignorovaná");
  send({ type: "TURN_RESULT", spoken: "odpoveď", gen: serverGen });
  assert.equal(state.status, "speaking");
});


// =============================================================================
// 8. „ZLOŽKA" — nejednoznačný kontajner: žiadna automatická preferencia
// =============================================================================

const FOLDER_ROW = { id: "f-test5", name: FOLDER, description: null, created_at: "2026-01-01", updated_at: "2026-01-01", created_by: "x" };
const CATEGORY_ROW = { id: "c-test5", name: FOLDER, canonical_slug: "test 5" };
const containerEnv = (opts: { folder?: boolean; category?: boolean; role?: Role; finance?: boolean } = {}) => {
  const env = makeDb({
    role: opts.role ?? "owner",
    financeManage: opts.finance ?? true,
    tables: {
      document_folders: opts.folder ? [FOLDER_ROW] : [],
      custom_document_categories: opts.category ? [CATEGORY_ROW] : [],
    },
  });
  // Záznam, ktoré tabuľky sa čítali (dôkaz, že nepovolený typ sa nečíta).
  const touched: string[] = [];
  const from = env.db.from.bind(env.db);
  (env.db as unknown as { from: (table: string) => unknown }).from = (table: string) => {
    touched.push(table);
    return from(table);
  };
  return { env, touched };
};
function containerSession(env: Env, access: { financeView: boolean; financeManage: boolean; canOperate: boolean }, moduleContext = "dashboard") {
  let pending: string | null = null;
  return {
    get pending() { return pending; },
    async say(sentence: string) {
      const { output, finalIntent } = await runAssistantTurnDetailed(
        { db: env.db, classifyWithAi: async () => null },
        {
          rawText: sentence, locale: "sk", userId: env.userId, companyId: env.companyId, role: env.state.role, ...access,
          conversationId: CONV, pendingClarification: pending, structuredPartnerId: null, issueDate: "2026-09-26", uiContext: null,
          moduleContext: moduleContext as never, selection: null, folderContextId: null,
        }
      );
      pending = output.pendingClarification ?? null;
      return { result: output.result, intent: finalIntent };
    },
  };
}
const OWNER = ACCESS.owner;
const ask = (name: string) => t("assistant.container.ask", { name });
const noConfirmation = (env: Env) => assert.equal(env.state.confirmations.length, 0, "žiadne potvrdenie ešte nevzniklo");

await check("ZLOŽKA A: iba zložka dokumentov „Test 5“ → náhľad zmazania zložky", async () => {
  const { env } = containerEnv({ category: true });
  const r = await containerSession(env, OWNER).say(`Vymaž zložku ${FOLDER}`);
  assert.equal(r.intent?.name, "DELETE_DOCUMENT_CATEGORY");
  assert.equal(r.result.kind, "action_preview");
});

await check("ZLOŽKA B: iba priečinok „Test 5“ → náhľad zmazania priečinka", async () => {
  const { env } = containerEnv({ folder: true });
  const r = await containerSession(env, OWNER).say(`Vymaž zložku ${FOLDER}`);
  assert.equal(r.intent?.name, "FOLDER_DELETE");
  assert.equal(r.result.kind, "action_preview");
});

await check("ZLOŽKA C: oba existujú → otázka, ŽIADNY náhľad ani potvrdenie; odpoveď pokračuje tou istou úlohou", async () => {
  for (const [answer, expected] of [["priečinok", "FOLDER_DELETE"], ["zložka dokumentov", "DELETE_DOCUMENT_CATEGORY"], ["Priečinok", "FOLDER_DELETE"]] as const) {
    const { env } = containerEnv({ folder: true, category: true });
    const s = containerSession(env, OWNER);
    const r = await s.say(`Vymaž zložku ${FOLDER}`);
    assert.equal(r.result.kind, "answer");
    assert.equal((r.result as { text: string }).text, ask(FOLDER));
    assert.notEqual(r.result.kind, "action_preview");
    noConfirmation(env);
    assert.ok(s.pending, "otázka je zapečatená");
    const next = await s.say(answer);
    assert.equal(next.intent?.name, expected, answer);
    assert.equal(next.result.kind, "action_preview", `${answer}: potvrdenie až po rozhodnutí`);
    assert.equal(env.state.confirmations.length, 1);
  }
  // Nejasná odpoveď → tá istá otázka, stále nič pripravené.
  const { env } = containerEnv({ folder: true, category: true });
  const s = containerSession(env, OWNER);
  await s.say(`Vymaž zložku ${FOLDER}`);
  const unclear = await s.say("hm");
  assert.equal((unclear.result as { text: string }).text, ask(FOLDER));
  noConfirmation(env);
  const cancel = await s.say("zrušiť");
  assert.equal((cancel.result as { text: string }).text, t("assistant.clarify.cancelled"));
  noConfirmation(env);
});

await check("ZLOŽKA D: oba existujú → premenovanie sa pýta PRED výberom", async () => {
  const { env } = containerEnv({ folder: true, category: true });
  const s = containerSession(env, OWNER);
  const r = await s.say(`Premenuj zložku ${FOLDER} na Archív`);
  assert.equal((r.result as { text: string }).text, ask(FOLDER));
  noConfirmation(env);
  const next = await s.say("priečinok");
  assert.equal(next.intent?.name, "FOLDER_RENAME");
  assert.equal(next.intent?.args.newName, "Archív");
});

await check("ZLOŽKA E: holé „Vytvor zložku Test“ → otázka; obrazovka Priečinky / Inbox typ určí", async () => {
  const { env } = containerEnv({});
  const s = containerSession(env, OWNER);
  const r = await s.say("Vytvor zložku Test");
  assert.equal((r.result as { text: string }).text, t("assistant.container.askCreate"));
  noConfirmation(env);
  const answered = await s.say("priečinok");
  assert.equal(answered.intent?.name, "FOLDER_CREATE");
  const onFolders = await containerSession(containerEnv({}).env, OWNER, "folders").say("Vytvor zložku Test");
  assert.equal(onFolders.intent?.name, "FOLDER_CREATE");
  const onInbox = await containerSession(containerEnv({}).env, OWNER, "inbox").say("Vytvor zložku Test");
  assert.equal(onInbox.intent?.name, "CREATE_DOCUMENT_CATEGORY");
});

await check("ZLOŽKA F/G: výslovný pojem platí priamo — „priečinok“ → priečinok, „kategória / zložka dokumentov“ → zložka", async () => {
  const both = () => containerEnv({ folder: true, category: true }).env;
  assert.equal((await containerSession(both(), OWNER).say(`Vymaž priečinok ${FOLDER}`)).intent?.name, "FOLDER_DELETE");
  for (const phrase of [`Vymaž kategóriu ${FOLDER}`, `Vymaž zložku dokumentov ${FOLDER}`]) {
    const r = await containerSession(both(), OWNER).say(phrase);
    assert.equal(r.intent?.name, "DELETE_DOCUMENT_CATEGORY", phrase);
    assert.equal(r.result.kind, "action_preview", phrase);
  }
  const create = await containerSession(containerEnv({}).env, OWNER).say("Vytvor priečinok Test");
  assert.equal(create.intent?.name, "FOLDER_CREATE");
});

await check("ZLOŽKA: typ bez oprávnenia sa nečíta ani neprezradí (admin bez financií: iba zložky dokumentov)", async () => {
  const { env, touched } = containerEnv({ folder: true, category: true, role: "admin", finance: false });
  const r = await containerSession(env, { financeView: false, financeManage: false, canOperate: true }).say(`Vymaž zložku ${FOLDER}`);
  assert.equal(r.intent?.name, "DELETE_DOCUMENT_CATEGORY");
  assert.ok(!touched.includes("document_folders"), `priečinky sa čítali: ${touched.join(",")}`);
  assert.doesNotMatch(JSON.stringify(r.result), /priečinok/i, "otázka neprezradí priečinok");
  // Iba priečinok s tým menom → zložka sa nenájde, priečinok sa neprezradí.
  const only = containerEnv({ folder: true, role: "admin", finance: false });
  const r2 = await containerSession(only.env, { financeView: false, financeManage: false, canOperate: true }).say(`Vymaž zložku ${FOLDER}`);
  assert.equal(r2.intent?.name, "DELETE_DOCUMENT_CATEGORY");
  assert.ok(!only.touched.includes("document_folders"));
  assert.doesNotMatch(JSON.stringify(r2.result), /priečin/i);
  // Zamestnanec: bez asistenta, nič sa nečíta.
  const emp = containerEnv({ folder: true, category: true, role: "employee", finance: false });
  const r3 = await containerSession(emp.env, ACCESS.employee).say(`Vymaž zložku ${FOLDER}`);
  assert.equal(r3.result.kind, "error");
  assert.ok(!emp.touched.includes("document_folders") && !emp.touched.includes("custom_document_categories"));
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo (${matrixPhrases} fráz v matici)`);
if (failed > 0) process.exit(1);
