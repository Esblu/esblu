import OpenAI from "openai";
import {
  DEADLINE_TYPE_FILTERS,
  DOCUMENT_TYPE_FILTERS,
  INTENT_NAMES,
  INVOICE_STATUS_FILTERS,
  isDeadlineTypeFilter,
  isDocumentTypeFilter,
  isInvoiceStatusFilter,
  type IntentName,
  type ParsedIntent,
} from "@/lib/intents/types";

// =============================================================================
// Esblu — Intent Engine: AI fallback pre text, ktorý deterministický parser
// (lib/intents/parse.ts) nevedel bezpečne rozpoznať.
// =============================================================================
// Spúšťa sa IBA keď parseIntentDeterministic() vráti null — teda iba pre
// naozaj nejednoznačný prirodzený text. `enum` v json_schema nižšie je
// PRESNE INTENT_NAMES z lib/intents/types.ts — model teda štrukturálne
// nemôže vrátiť nič mimo allowlistu (bod 2 zadania: "AI nikdy negeneruje
// SQL, nespúšťa arbitrary route/JS, nerozhoduje o service_role query").
// Rovnaký vzor ako existujúci app/api/scan-document/route.ts: store:false,
// strict:true json_schema, žiadny nástroj/tool-calling, žiadny prístup k DB
// z tohto volania — iba text→structured-intent klasifikácia. Výsledný
// intent AJ TAK prechádza rovnakým handler/permission/RLS pipeline ako
// deterministický (app/api/assistant/intent/route.ts), takže AI výstup nemá
// žiadnu vyššiu dôveru ani iné oprávnenia než deterministický parser.
//
// Model: "gpt-5.6-terra" — rovnaký, akým appka dnes klasifikuje AI
// dokumenty (app/api/scan-document/route.ts), per zadanie "nevymýšľaj
// neexistujúci model ani nemeň model bez dôvodu".
// =============================================================================

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const INTENT_CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: ["string", "null"],
      enum: [...INTENT_NAMES, null],
    },
    // Voľný vyhľadávací reťazec (ŠPZ/názov vozidla/stroja/skladovej
    // položky/dokumentu) tak, ako ho AI rozpoznala z textu — NIKDY
    // vymyslená hodnota, iba to, čo sa v texte skutočne nachádza. Handler
    // (lib/intents/handlers.ts) ho ešte raz nezávisle overí proti
        // reálnym dátam firmy (RLS-scoped) — AI iba naznačuje, nič
    // nepotvrdzuje.
    query: { type: ["string", "null"] },
    year: { type: ["number", "null"] },
    withinDays: { type: ["number", "null"] },
    onlyOverdue: { type: ["boolean", "null"] },
    // Nasledujúce polia patria k SEARCH_DOCUMENTS/SHOW_VEHICLE_DOCUMENTS/
    // EXPORT_DOCUMENTS/ASSIGN_DOCUMENTS_TO_CATEGORY (bod 4 a 18 doplnenia
    // zadania — parametrizovaný filter namiesto desiatok samostatných
    // intentov). `documentTypes` je POLE (multi-type filter — "bločky a
    // faktúry" → oba typy naraz) so striktným enum (rovnaký allowlist ako
    // CHECK v produkčnej DB, lib/intents/types.ts), takže AI ani tu nemôže
    // vrátiť nič mimo povolených hodnôt.
    documentTypes: {
      type: ["array", "null"],
      items: { type: "string", enum: [...DOCUMENT_TYPE_FILTERS] },
    },
    dateFrom: { type: ["string", "null"] },
    dateTo: { type: ["string", "null"] },
    amount: { type: ["number", "null"] },
    // "Ukáž všetky stroje.", "Aké vozidlá máme?" — LIST požiadavka na
    // SEARCH_VEHICLE/SEARCH_MACHINE/SEARCH_INVENTORY_ITEM (doplnenie
    // zadania, úloha 1). `query` sa v tom prípade ignoruje.
    listAll: { type: ["boolean", "null"] },
    // UPCOMING_DEADLINES — striktný enum (rovnaký allowlist ako v DB), AI
    // teda ani tu nemôže vrátiť nič mimo povolených typov (doplnenie
    // zadania, úloha 3).
    deadlineTypes: {
      type: ["array", "null"],
      items: { type: "string", enum: [...DEADLINE_TYPE_FILTERS] },
    },
    // CREATE_DOCUMENT_CATEGORY/RENAME_DOCUMENT_CATEGORY/
    // ASSIGN_DOCUMENTS_TO_CATEGORY — voľný text presne tak, ako je v
    // texte napísaný (nikdy sa nevymýšľa/nedopĺňa), pozri
    // lib/intents/actions.ts pre skutočné spracovanie a potvrdzovací tok.
    categoryName: { type: ["string", "null"] },
    newCategoryName: { type: ["string", "null"] },
    targetCategoryName: { type: ["string", "null"] },
    // SHOW_INVOICES_BY_STATUS — striktný enum, rovnaký allowlist ako v
    // lib/intents/types.ts. Model teda nemôže vrátiť "stav", ktorý appka
    // nepozná.
    invoiceStatus: {
      type: ["string", "null"],
      enum: [...INVOICE_STATUS_FILTERS, null],
    },
    // CREATE_INVOICE_DRAFT — meno odberateľa PRESNE tak, ako zaznelo.
    // Model tu nič neoveruje ani nedopĺňa; partnera resolvuje server proti
    // reálnym dátam firmy a pri viacerých zhodách sa pýta.
    partnerQuery: { type: ["string", "null"] },
  },
  required: [
    "intent",
    "query",
    "year",
    "withinDays",
    "onlyOverdue",
    "documentTypes",
    "dateFrom",
    "dateTo",
    "amount",
    "listAll",
    "deadlineTypes",
    "categoryName",
    "newCategoryName",
    "targetCategoryName",
    "invoiceStatus",
    "partnerQuery",
  ],
} as const;

const INTENT_CLASSIFICATION_PROMPT = `
Si klasifikátor príkazov pre firemnú aplikáciu Esblu (vozidlá, stroje,
sklad, dokumenty). Dostaneš krátky text v slovenčine, češtine, nemčine
alebo angličtine a MUSÍŠ ho priradiť k JEDNÉMU z povolených intentov, alebo
vrátiť null, ak text jednoznačne nezodpovedá žiadnemu z nich.

Povolené intenty:
${INTENT_NAMES.map((n) => `- ${n}`).join("\n")}

Povolené hodnoty pre "documentTypes" (pole, presne ako v databáze, nič iné):
${DOCUMENT_TYPE_FILTERS.map((t) => `- ${t}`).join("\n")}

Povolené hodnoty pre "deadlineTypes" (pole, nič iné — PZP tu zámerne
chýba, appka nemá štruktúrovaný dátum platnosti PZP):
${DEADLINE_TYPE_FILTERS.map((t) => `- ${t}`).join("\n")}

Pravidlá:
- NIKDY nevracaj intent mimo tohto zoznamu.
- NIKDY si nevymýšľaj ŠPZ, názov vozidla/stroja, typ dokumentu, dátum ani
  sumu — žiadnu hodnotu, ktorá sa v texte doslova nenachádza alebo z neho
  jednoznačne nevyplýva. "query" je vždy iba to, čo je v texte skutočne
  napísané (napr. ŠPZ, časť názvu, meno dodávateľa).
- "documentTypes" nastav LEN na typy, ktoré text jednoznačne pomenúva
  (napr. "bločky" → [receipt], "faktúry" → [invoice], "vážne lístky" →
  [weigh_ticket], "dodacie listy" → [delivery_note], "PZP" → [insurance],
  "technický preukaz" → [vehicle_registration]). Text môže pomenovať
  VIACERO typov naraz (napr. "bločky a faktúry" → [receipt, invoice]) —
  vtedy vráť všetky spomenuté typy v jednom poli. Inak nechaj null — NIKDY
  nehádaj typ, ktorý text nespomína.
- "categoryName" (pre CREATE_DOCUMENT_CATEGORY a ako prvý/zdrojový názov
  pre RENAME_DOCUMENT_CATEGORY) nastav LEN na presný názov zložky tak, ako
  je v texte napísaný (napr. "Vytvor zložku Reklamácie." → "Reklamácie").
  "newCategoryName" (LEN pre RENAME_DOCUMENT_CATEGORY) je nový názov
  ("Premenuj zložku Servis na Servis 2026." → categoryName: "Servis",
  newCategoryName: "Servis 2026"). "targetCategoryName" (LEN pre
  ASSIGN_DOCUMENTS_TO_CATEGORY) je názov cieľovej zložky, do ktorej sa
  majú dokumenty priradiť ("Daj všetky bločky za august do zložky
  August." → documentTypes: [receipt], dateFrom/dateTo: august,
  targetCategoryName: "August"). NIKDY si nevymýšľaj názov zložky, ktorý
  text neobsahuje — inak nechaj null.
- OPEN_MODULE je pre "otvor Faktúry", "prejdi do Skladu", "öffne die
  Rechnungen", "open inventory" — teda keď text pomenúva MODUL appky, nie
  konkrétnu entitu. "query" nastav na to, čo používateľ povedal (napr.
  "faktúry"). Keď text pomenúva konkrétne vozidlo/stroj/položku, použi
  príslušný OPEN_* alebo SEARCH_* intent, nie OPEN_MODULE.
- SEARCH_INVOICE je pre hľadanie faktúry podľa čísla alebo protistrany,
  SHOW_UNPAID_INVOICES pre "neuhradené faktúry", "offene Rechnungen",
  "unpaid invoices". SEARCH_PARTNER je pre obchodného partnera.
- DELETE_DOCUMENT_CATEGORY je pre "Zmaž zložku X", "Lösche den Ordner X",
  "Delete the folder X" — "categoryName" je názov zložky presne z textu.
- MOVE_DOCUMENTS_TO_CATEGORY je pre presun OBSAHU jednej zložky inam:
  "Presuň dokumenty zo zložky A do zložky B" → categoryName: "A",
  targetCategoryName: "B". Keď text hovorí "vyraď zo zložky" / "odstráň zo
  zložky" bez cieľa, nechaj targetCategoryName null. Keď sa dokumenty
  vyberajú FILTROM (typ, dátum), a nie zdrojovou zložkou, použi
  ASSIGN_DOCUMENTS_TO_CATEGORY.
- SHOW_INVOICES_BY_STATUS je pre otázky na faktúry podľa STAVU. Povolené
  hodnoty "invoiceStatus" (nič iné):
${INVOICE_STATUS_FILTERS.map((s) => `  - ${s}`).join("\n")}
  Mapovanie: "uhradené"/"zaplatené"/"bezahlte"/"paid" → paid;
  "neuhradené"/"offene"/"unpaid" → unpaid; "po splatnosti"/"überfällig"/
  "overdue" → overdue; "vydané"/"Ausgangsrechnungen"/"issued" → issued;
  "prijaté"/"Eingangsrechnungen"/"received" → received;
  "rozpracované"/"koncepty"/"Entwürfe"/"drafts" → draft. Keď text pýta
  faktúry BEZ stavu, použi SEARCH_INVOICE, nie tento intent.
- SHOW_LOW_STOCK je pre "čo nám dochádza", "položky pod minimom", "was
  geht uns aus", "low stock". Keď text hovorí o ÚPLNE vypredaných
  ("vypredané", "nič nemáme", "out of stock", "ausverkauft"), nastav
  "onlyOverdue" na true — v tomto intente znamená "iba vypredané".
- SHOW_MACHINE_DOCUMENTS ("ukáž dokumenty k bagru CAT 302") a
  SHOW_MACHINE_PHOTOS ("ukáž fotky stroja X") — "query" je názov stroja
  presne z textu.
- OPEN_DOCUMENT_FOLDER je pre "otvor zložku X", "öffne den Ordner X",
  "open folder X" — "categoryName" je názov zložky presne z textu. Keď sa
  má zložka VYTVORIŤ, je to CREATE_DOCUMENT_CATEGORY, nie tento intent.
- CREATE_INVOICE_DRAFT je pre "vytvor faktúru pre X za Y 300 eur s 23
  percent DPH", "erstelle eine Rechnung für X", "create an invoice for X".
  Vyplň:
    * "partnerQuery" = meno odberateľa presne tak, ako zaznelo (nikdy
      vymyslené, nikdy doplnené o právnu formu, ktorá v texte nie je),
    * "query" = predmet fakturácie / popis položky ("kopanie",
      "Erdarbeiten", "excavation"),
    * "amount" = jednotková cena v číslach, LEN ak je vo vete suma,
    * "invoiceStatus" nechaj null.
  Ktorýkoľvek z týchto údajov môže chýbať — vtedy nechaj null. NIKDY
  nedopĺňaj sumu, sadzbu DPH ani partnera, ktorých text neobsahuje; appka
  sa na ne sama spýta. Sadzbu DPH nevraciaš vôbec — tú si appka číta
  deterministicky z textu.
- Príkazy, ktoré appka zatiaľ nepodporuje, VŽDY klasifikuj ako intent:
  null (NIKDY sa nesnaž vynútiť ich do najbližšieho povoleného intentu).
  Sem patrí najmä: zmazanie dokumentu ("Vymaž všetky faktúry."),
  odoslanie/poslanie dokumentu alebo emailu ("Pošli faktúru zákazníkovi."),
  zmena skladového množstva ("Odpočítaj 5 kusov spreja.", "Pridaj 10
  kusov."), úprava/vytvorenie vozidla alebo stroja príkazom,
  FINALIZÁCIA/vystavenie faktúry ("Vystav tú faktúru.", "Finalizuj
  faktúru.") a označenie faktúry za uhradenú ("Označ faktúru ako
  zaplatenú.") — tie posledné dve appka zámerne rečou nerobí — a čokoľvek
  iné, čo by vyžadovalo zápis do databázy mimo zoznamu povolených intentov
  vyššie.
- "dateFrom"/"dateTo" (formát "YYYY-MM-DD") nastav LEN ak text obsahuje
  jednoznačný časový rozsah (napr. "za august", "tento mesiac", "tento
  rok") — rok, ak nie je v texte, je vždy aktuálny kalendárny rok. Inak
  null.
- "amount" nastav LEN ak text obsahuje konkrétnu sumu v eurách (napr. "za
  86 eur" → 86). Inak null.
- "listAll" nastav na true LEN pre SEARCH_VEHICLE/SEARCH_MACHINE/
  SEARCH_INVENTORY_ITEM, keď používateľ chce ZOZNAM VŠETKÝCH záznamov
  danej entity ("Ukáž všetky stroje.", "Aké vozidlá máme?", "Ukáž sklad.")
  — NIE vyhľadávanie konkrétneho textu. Keď je listAll true, "query" nechaj
  null (ignoruje sa). Inak null.
- "deadlineTypes" (iba pre UPCOMING_DEADLINES) nastav LEN na typy, ktoré
  text VÝSLOVNE pomenúva (napr. "STK a EK" → ["STK","EK"]; "diaľničná
  známka" → ["VIGNETTE"]) — NIKDY nepridávaj typ, ktorý text nespomína
  (napr. otázka o STK sa NESMIE preložiť aj na VIGNETTE). Ak text pýta na
  všetky termíny bez konkrétneho typu ("čo mi končí", "čo je po termíne"),
  nechaj null/prázdne pole (handler potom vráti všetky typy).
- Ak text nie je jednoznačne príkaz/otázka o vozidle, stroji, sklade,
  dokumente alebo blížiacich sa termínoch, vráť intent: null.
- Text môže byť v ktoromkoľvek zo 4 jazykov — jazyk NEOVPLYVŇUJE, ktorý
  intent vrátiš, iba ktoré slová v ňom hľadáš.
`;

export async function classifyIntentWithAi(
  rawText: string
): Promise<ParsedIntent | null> {
  try {
    const response = await client.responses.create({
      model: "gpt-5.6-terra",
      store: false,
      reasoning: { effort: "none" },
      text: {
        format: {
          type: "json_schema",
          name: "intent_classification",
          strict: true,
          schema: INTENT_CLASSIFICATION_SCHEMA,
        },
      },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: INTENT_CLASSIFICATION_PROMPT },
            { type: "input_text", text: `Text: "${rawText}"` },
          ],
        },
      ],
    });

    if (!response.output_text) return null;

    const parsed = JSON.parse(response.output_text) as {
      intent: string | null;
      query: string | null;
      year: number | null;
      withinDays: number | null;
      onlyOverdue: boolean | null;
      documentTypes: string[] | null;
      dateFrom: string | null;
      dateTo: string | null;
      amount: number | null;
      listAll: boolean | null;
      deadlineTypes: string[] | null;
      categoryName: string | null;
      newCategoryName: string | null;
      targetCategoryName: string | null;
      invoiceStatus: string | null;
      partnerQuery: string | null;
    };

    if (!parsed.intent || !(INTENT_NAMES as readonly string[]).includes(parsed.intent)) {
      return null;
    }

    return {
      name: parsed.intent as IntentName,
      args: {
        query: parsed.query ?? undefined,
        year: parsed.year ?? undefined,
        withinDays: parsed.withinDays ?? undefined,
        onlyOverdue: parsed.onlyOverdue ?? undefined,
        // isDocumentTypeFilter je druhá, nezávislá kontrola oproti
        // json_schema enumu vyššie (rovnaký fail-closed princíp ako
        // isRegisteredReadOnlyIntent pre `intent` — nikdy sa neverí iba
        // jednej vrstve validácie modelového výstupu). KAŽDÁ jednotlivá
        // hodnota poľa sa overuje samostatne.
        documentTypes: Array.isArray(parsed.documentTypes)
          ? parsed.documentTypes.filter(isDocumentTypeFilter)
          : undefined,
        dateFrom: parsed.dateFrom ?? undefined,
        dateTo: parsed.dateTo ?? undefined,
        amount: parsed.amount ?? undefined,
        listAll: parsed.listAll ?? undefined,
        // Rovnaký fail-closed princíp ako pri documentTypes vyššie — druhá,
        // nezávislá kontrola oproti json_schema enumu, a KAŽDÁ jednotlivá
        // hodnota poľa sa overuje samostatne (nikdy sa neverí, že celé pole
        // je validné len preto, že json_schema ho takto vrátilo).
        deadlineTypes: Array.isArray(parsed.deadlineTypes)
          ? parsed.deadlineTypes.filter(isDeadlineTypeFilter)
          : undefined,
        // categoryName/newCategoryName/targetCategoryName — voľný text,
        // presne tak, ako ho AI rozpoznala (nikdy sa nevymýšľa). Skutočná
        // duplicitná kontrola/normalizácia prebieha až v
        // lib/intents/actions.ts nad reálnymi dátami firmy (RLS-scoped) —
        // rovnaký princíp ako pri `query` vyššie: AI iba naznačuje.
        categoryName: parsed.categoryName ?? undefined,
        newCategoryName: parsed.newCategoryName ?? undefined,
        targetCategoryName: parsed.targetCategoryName ?? undefined,
        // Druhá, nezávislá kontrola oproti json_schema enumu — rovnaký
        // fail-closed princíp ako pri documentTypes/deadlineTypes vyššie.
        invoiceStatus: isInvoiceStatusFilter(parsed.invoiceStatus)
          ? parsed.invoiceStatus
          : undefined,
        // Voľný text; skutočné overenie proti partnerom firmy robí server
        // (lib/intents/invoice-draft.ts). Model iba naznačuje.
        partnerQuery: parsed.partnerQuery ?? undefined,
      },
      source: "ai",
    };
  } catch (error) {
    // Fail closed: AI volanie zlyhalo (timeout, výpadok, nevalidný
    // output) → appka sa jednoducho správa, akoby žiadny intent
    // nerozpoznala (route.ts to zobrazí ako "Tomuto príkazu som
    // nerozumel.", bod 14 zadania) — NIKDY nepadne, NIKDY nevykoná
    // neoverenú akciu.
    console.error("classifyIntentWithAi zlyhalo:", error instanceof Error ? error.message : error);
    return null;
  }
}
