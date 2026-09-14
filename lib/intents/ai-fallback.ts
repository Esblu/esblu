import OpenAI from "openai";
import { INTENT_NAMES, type IntentName, type ParsedIntent } from "@/lib/intents/types";

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
  },
  required: ["intent", "query", "year", "withinDays", "onlyOverdue"],
} as const;

const INTENT_CLASSIFICATION_PROMPT = `
Si klasifikátor príkazov pre firemnú aplikáciu Esblu (vozidlá, stroje,
sklad, dokumenty). Dostaneš krátky text v slovenčine, češtine, nemčine
alebo angličtine a MUSÍŠ ho priradiť k JEDNÉMU z povolených intentov, alebo
vrátiť null, ak text jednoznačne nezodpovedá žiadnemu z nich.

Povolené intenty:
${INTENT_NAMES.map((n) => `- ${n}`).join("\n")}

Pravidlá:
- NIKDY nevracaj intent mimo tohto zoznamu.
- NIKDY si nevymýšľaj ŠPZ, názov vozidla/stroja ani žiadnu inú hodnotu,
  ktorá sa v texte doslova nenachádza. "query" je vždy iba to, čo je v
  texte skutočne napísané (napr. ŠPZ, časť názvu).
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
