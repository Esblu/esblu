import OpenAI from "openai";
import {
  DEADLINE_TYPE_FILTERS,
  DOCUMENT_TYPE_FILTERS,
  INTENT_NAMES,
  isDeadlineTypeFilter,
  isDocumentTypeFilter,
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
    // Nasledujúce 4 polia patria k SEARCH_DOCUMENTS/SHOW_VEHICLE_DOCUMENTS
    // (bod 4 doplnenia zadania — parametrizovaný filter namiesto desiatok
    // samostatných intentov). `documentType` je striktný enum (rovnaký
    // allowlist ako CHECK v produkčnej DB, lib/intents/types.ts), takže AI
    // ani tu nemôže vrátiť nič mimo povolených hodnôt.
    documentType: { type: ["string", "null"], enum: [...DOCUMENT_TYPE_FILTERS, null] },
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
  },
  required: [
    "intent",
    "query",
    "year",
    "withinDays",
    "onlyOverdue",
    "documentType",
    "dateFrom",
    "dateTo",
    "amount",
    "listAll",
    "deadlineTypes",
  ],
} as const;

const INTENT_CLASSIFICATION_PROMPT = `
Si klasifikátor príkazov pre firemnú aplikáciu Esblu (vozidlá, stroje,
sklad, dokumenty). Dostaneš krátky text v slovenčine, češtine, nemčine
alebo angličtine a MUSÍŠ ho priradiť k JEDNÉMU z povolených intentov, alebo
vrátiť null, ak text jednoznačne nezodpovedá žiadnemu z nich.

Povolené intenty:
${INTENT_NAMES.map((n) => `- ${n}`).join("\n")}

Povolené hodnoty pre "documentType" (presne ako v databáze, nič iné):
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
- "documentType" nastav LEN ak text jednoznačne pomenúva konkrétny typ
  dokumentu (napr. "bločky" → receipt, "faktúry" → invoice, "vážne
  lístky" → weigh_ticket, "dodacie listy" → delivery_note, "PZP" →
  insurance, "technický preukaz" → vehicle_registration). Inak nechaj
  null — NIKDY nehádaj typ, ktorý text nespomína.
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
      documentType: string | null;
      dateFrom: string | null;
      dateTo: string | null;
      amount: number | null;
      listAll: boolean | null;
      deadlineTypes: string[] | null;
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
        // jednej vrstve validácie modelového výstupu).
        documentType: isDocumentTypeFilter(parsed.documentType) ? parsed.documentType : undefined,
        dateFrom: parsed.dateFrom ?? undefined,
        dateTo: parsed.dateTo ?? undefined,
        amount: parsed.amount ?? undefined,
        listAll: parsed.listAll ?? undefined,
        // Rovnaký fail-closed princíp ako pri documentType vyššie — druhá,
        // nezávislá kontrola oproti json_schema enumu, a KAŽDÁ jednotlivá
        // hodnota poľa sa overuje samostatne (nikdy sa neverí, že celé pole
        // je validné len preto, že json_schema ho takto vrátilo).
        deadlineTypes: Array.isArray(parsed.deadlineTypes)
          ? parsed.deadlineTypes.filter(isDeadlineTypeFilter)
          : undefined,
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
