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
  // "Aký máme zostatok pre položku sprej?", "Koľko máme spreja?", "Máme
  // ešte sprej?" — na rozdiel od SEARCH_INVENTORY_ITEM (zoznam zhôd) tento
  // READ intent vždy vracia PRIAMU odpoveď s reálnym množstvom/jednotkou
  // (alebo "Množstvo nie je evidované.", ak DB stĺpec nemá hodnotu — nikdy
  // sa nevymýšľa). Pridané ako samostatný intent (nie rozšírenie
  // SEARCH_INVENTORY_ITEM), lebo výstupný TVAR je odlišný (answer s
  // konkrétnym číslom, nie zoznam odkazov) — pozri lib/intents/handlers.ts.
  "INVENTORY_ITEM_STATUS",

  "SEARCH_DOCUMENTS",
  // "Exportuj bločky a faktúry.", "Exportuj bločky za august." — WRITE
  // intent v zmysle "vykoná viditeľnú akciu" (stiahne/zdieľa súbor), ale
  // nezapisuje nič do DB. Napriek tomu prechádza rovnakým
  // preview→potvrdenie tokom ako ostatné write intenty nižšie (žiadny
  // export sa nespustí len preto, že AI rozpoznala zámer) — pozri
  // readOnly/requiresConfirmation v lib/intents/registry.ts.
  "EXPORT_DOCUMENTS",

  // Nie je v pôvodnom zozname zo zadania (bod 2), ale zadanie ho EXPLICITNE
  // vyžaduje v bode 9C ("čo mi končí tento mesiac", "aké termíny treba
  // riešiť", "čo je po lehote", "ktoré vozidlá majú STK do 30 dní" — "majú
  // vrátiť reálne deadline dáta") a v teste 20 ("firma bez blížiacich sa
  // termínov → žiadny prázdny warning box"). Pridané ako plnohodnotný
  // allowlisted READ intent, rovnakej kategórie ako ostatné vyššie.
  "UPCOMING_DEADLINES",

  // ---------------------------------------------------------------------
  // WRITE intenty (doplnenie zadania — "Intent Engine ako bezpečný
  // príkazový asistent nad celou aplikáciou"). KAŽDÝ z nich má v
  // lib/intents/registry.ts readOnly:false + requiresConfirmation:true —
  // spustenie vráti VÝHRADNE `action_preview` (lib/intents/types.ts#IntentResult),
  // samotný zápis do DB robí AŽ samostatný endpoint (app/api/assistant/
  // action/execute/route.ts) po explicitnom potvrdení v UI. Zámerne tu
  // NIE JE žiadny DELETE_*/mazací intent (rovnaké pravidlo ako pri
  // pôvodných READ intentoch vyššie — bezpečnejšie nemať mazací intent
  // vôbec, než ho mať za "ešte prísnejším" potvrdením).
  // ---------------------------------------------------------------------
  "CREATE_DOCUMENT_CATEGORY",
  "RENAME_DOCUMENT_CATEGORY",
  "ASSIGN_DOCUMENTS_TO_CATEGORY",

  // ---------------------------------------------------------------------
  // Voice Phase 1 — navigácia a účtovnícke čítanie.
  //
  // OPEN_MODULE je jediný intent, ktorý nič nehľadá — iba presmeruje. Je
  // zámerne oddelený od OPEN_* intentov nad entitami, lebo tie riešia
  // disambiguáciu a tento nie: modul buď existuje a rola naň má právo,
  // alebo nie.
  // ---------------------------------------------------------------------
  "OPEN_MODULE",

  // Finančné čítanie. Handler pre ne vyžaduje finance view EŠTE PRED
  // dotazom do DB — nie preto, že by RLS nestačila (vrátila by nula
  // riadkov), ale aby zamestnanec dostal zrozumiteľné odmietnutie namiesto
  // "nič sa nenašlo", ktoré by o existencii dát nepriamo vypovedalo.
  "SEARCH_INVOICE",
  "SHOW_UNPAID_INVOICES",
  "SEARCH_PARTNER",

  // ---------------------------------------------------------------------
  // Voice Phase 1 — rizikové zápisy nad zložkami.
  //
  // Doterajší komentár vyššie hovoril, že mazací intent je bezpečnejšie
  // nemať vôbec. To platilo, kým neexistovalo HMAC-podpísané potvrdenie a
  // kým mazanie zložky mohlo znamenať stratu dokumentov. Dnes platí ani
  // jedno: potvrdenie sa dá uplatniť práve raz a FK
  // documents.custom_category_id má ON DELETE SET NULL, takže dokumenty
  // zmazanie zložky prežijú. Preto je intent pridaný — s potvrdením.
  // ---------------------------------------------------------------------
  "DELETE_DOCUMENT_CATEGORY",
  "MOVE_DOCUMENTS_TO_CATEGORY",

  // ---------------------------------------------------------------------
  // Voice Phase 2 — doplnené čítanie naprieč modulmi.
  //
  // Stav faktúry (uhradené/vydané/prijaté/po splatnosti) je jeden intent s
  // parametrom, nie štyri samostatné. Štyri intenty by znamenali štyri
  // takmer rovnaké handlery, ktoré sa časom rozídu; parameter má jeden
  // handler a jeden allowlist hodnôt.
  // ---------------------------------------------------------------------
  "SHOW_INVOICES_BY_STATUS",
  "SHOW_LOW_STOCK",
  "SHOW_MACHINE_DOCUMENTS",
  "SHOW_MACHINE_PHOTOS",
  "OPEN_DOCUMENT_FOLDER",

  // ---------------------------------------------------------------------
  // Voice Phase 2 — vytvorenie DRAFTU vydanej faktúry.
  //
  // Tento intent zapisuje, ale NEMÁ potvrdzovací dialóg — a to je zámer,
  // nie opomenutie. Potvrdenie chráni pred nezvratnou stratou; draft
  // faktúry nie je nezvratný, nemá číslo, nič neúčtuje a dá sa zmazať.
  // Ochranou tu nie je otázka "naozaj?", ale to, že výsledok sa POVINNE
  // otvorí na kontrolu: používateľ vidí, čo vzniklo, skôr než to čokoľvek
  // znamená. Otázka pred vytvorením by bola rituál — prečítal by ju ten
  // istý človek, ktorý o sekundu neskôr uvidí skutočný doklad.
  //
  // Finalizácia ani úhrada rečou NEEXISTUJÚ a v tejto fáze ani vzniknúť
  // nemajú — tie nezvratné sú.
  // ---------------------------------------------------------------------
  "CREATE_INVOICE_DRAFT",

  // ---------------------------------------------------------------------
  // Voice Phase 3A — príkaz nad PRÁVE OTVORENOU entitou.
  //
  // „Spracuj tento dokument ako prijatú faktúru." Intent je označený ako
  // read-only, a to presne: nič nezapisuje. Overí, že dokument je naozaj
  // otvorený, že ho volajúci smie použiť a že je na to spôsobilý, a potom
  // otvorí existujúcu obrazovku na kontrolu. Doklad z neho vznikne až
  // vtedy, keď ho tam človek potvrdí — cez tú istú cestu ako pri kliknutí.
  //
  // „Tento" pritom NIKDY neznamená „posledný" — pozri lib/intents/
  // ui-context.ts, prečo je odvodzovanie z databázy tichá chyba.
  // ---------------------------------------------------------------------
  "PROCESS_CURRENT_DOCUMENT_AS_RECEIVED_INVOICE",
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
  // Nasledujúce polia rozširujú SEARCH_DOCUMENTS, SHOW_VEHICLE_DOCUMENTS,
  // EXPORT_DOCUMENTS a ASSIGN_DOCUMENTS_TO_CATEGORY o parametrizované
  // filtre (namiesto desiatok samostatných intentov — "Ukáž bločky za
  // august", "Ukáž faktúry od dodávateľa X", "Nájdi bloček za 86 eur").
  // Handler ich VŽDY interpretuje iba ako doplnkový, presne definovaný
  // filter nad existujúcimi tabuľkami — nikdy ako surový SQL/text fragment.
  //
  // `documentTypes` je POLE (nie jedna hodnota) — doplnenie zadania,
  // úloha "multi-type filter": "Ukáž bločky a faktúry." musí vedieť
  // vrátiť OBA typy naraz (`documentTypes:["receipt","invoice"]`), nie iba
  // jeden. Prázdne/chýbajúce pole = žiadny typový filter (všetky typy),
  // presne ako predtým `documentType: undefined`.
  documentTypes?: DocumentTypeFilter[];
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
  // CREATE_DOCUMENT_CATEGORY: názov novej zložky. RENAME_DOCUMENT_CATEGORY:
  // názov EXISTUJÚCEJ zložky, ktorá sa premenúva (zdroj). Vždy presne to,
  // čo je v texte doslova napísané — nikdy sa nedomýšľa/nedopĺňa.
  categoryName?: string;
  // RENAME_DOCUMENT_CATEGORY: nový názov, na ktorý sa `categoryName`
  // premenúva.
  newCategoryName?: string;
  // ASSIGN_DOCUMENTS_TO_CATEGORY: cieľová zložka, do ktorej sa priradia
  // dokumenty vyhovujúce ostatným filtrom vyššie (documentTypes/dateFrom/
  // dateTo/query). Musí existovať (appka ju NIKDY nezaloží automaticky v
  // rámci priradenia — pozri lib/intents/actions.ts).
  targetCategoryName?: string;
  // SHOW_INVOICES_BY_STATUS — presne jedna z povolených hodnôt nižšie.
  invoiceStatus?: InvoiceStatusFilter;
  // CREATE_INVOICE_DRAFT — meno odberateľa tak, ako ho používateľ vyslovil.
  // Handler ho VŽDY overí proti reálnym partnerom firmy a pri viacerých
  // zhodách sa spýta; nikdy nevyberá sám a nikdy nezakladá nového partnera.
  partnerQuery?: string;
};

// Stavy faktúr, na ktoré sa dá pýtať. Zámerne "priateľské" hodnoty, nie
// stĺpce — `overdue` v databáze neexistuje ako hodnota, je to kombinácia
// splatnosti a stavu úhrady (lib/invoicing/vat-engine.ts#isInvoiceOverdue),
// a `issued`/`received` je smer, nie stav. Mapovanie robí handler na
// jednom mieste.
export const INVOICE_STATUS_FILTERS = [
  "unpaid",
  "paid",
  "overdue",
  "issued",
  "received",
  "draft",
] as const;

export type InvoiceStatusFilter = (typeof INVOICE_STATUS_FILTERS)[number];

export function isInvoiceStatusFilter(value: unknown): value is InvoiceStatusFilter {
  return (
    typeof value === "string" &&
    (INVOICE_STATUS_FILTERS as readonly string[]).includes(value)
  );
}

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
  | { kind: "error"; text: string }
  // ---------------------------------------------------------------------
  // WRITE intent preview/výsledok (doplnenie zadania, sekcia 6/23; hardened
  // podľa bezpečnostného review — pozri lib/intents/actions.ts a migráciu
  // 20260915120000_add_assistant_action_confirmations.sql).
  //
  // `action_preview` sa vráti VŽDY namiesto priameho vykonania write
  // intentu — appka tu ešte NIČ nezapísala do DB (EXPORT_DOCUMENTS
  // výnimočne aj nič zapisovať nebude, pozri nižšie).
  //
  // KĽÚČOVÁ ZMENA: klient tu NIKDY nedostáva surové kanonické `args`, ktoré
  // by mohol pri potvrdení ľubovoľne upraviť. Pre CREATE_DOCUMENT_CATEGORY/
  // RENAME_DOCUMENT_CATEGORY/ASSIGN_DOCUMENTS_TO_CATEGORY appka namiesto
  // toho vytvorí server-side "pending action" záznam
  // (public.assistant_action_confirmations) a klient dostane iba jeho
  // opaque `confirmationId` — TOTO (a NIČ iné) sa posiela na
  // app/api/assistant/action/execute. Server si canonical args/company/
  // user/expected count NAČÍTA sám z DB podľa confirmationId (nikdy z tela
  // requestu) a potvrdenie spotrebuje presne raz (replay protection).
  // ---------------------------------------------------------------------
  | {
      kind: "action_preview";
      action:
        | "EXPORT_DOCUMENTS"
        | "CREATE_DOCUMENT_CATEGORY"
        | "RENAME_DOCUMENT_CATEGORY"
        | "ASSIGN_DOCUMENTS_TO_CATEGORY"
        | "DELETE_DOCUMENT_CATEGORY"
        | "MOVE_DOCUMENTS_TO_CATEGORY";
      summary: string;
      confirmLabel: string;
      cancelLabel: string;
      // VÝHRADNE CREATE_DOCUMENT_CATEGORY/RENAME_DOCUMENT_CATEGORY/
      // ASSIGN_DOCUMENTS_TO_CATEGORY — opaque referencia na server-side
      // uložený pending action (assistant_action_confirmations.id).
      // EXPORT_DOCUMENTS toto pole nemá (nezapisuje nič do DB, pozri
      // exportPayload nižšie) a Dashboard.tsx ho preto pre EXPORT_DOCUMENTS
      // nikdy nepoužije.
      confirmationId?: string;
      // Počet dotknutých entít, ak je pre daný intent zmysluplný
      // (ASSIGN_DOCUMENTS_TO_CATEGORY: počet dokumentov; EXPORT_DOCUMENTS:
      // celkový počet exportovaných záznamov) — čisto informačné pre UI,
      // execute krok ho NIKDY neberie ako vstup, vždy ho revaliduje sám
      // nanovo z DB.
      affectedCount?: number;
      // VÝHRADNE EXPORT_DOCUMENTS — export nezapisuje nič do DB (iba
      // stiahne/zdieľa súbor cez už existujúci klientsky ExcelJS flow),
      // takže server môže bezpečne poslať už teraz aj samotné riadky na
      // export. Potvrdenie v UI tak iba spustí klientsky
      // exportAiInboxFolderToExcel/exportAiEvidenceToExcel — BEZ ďalšieho
      // network volania na /action/execute (to je vyhradené pre skutočné
      // DB zápisy — CREATE/RENAME/ASSIGN vyššie, cez confirmationId).
      exportPayload?: {
        inboxDocuments: {
          kind: "receipt" | "invoice";
          records: {
            id: string;
            created_at: string | null;
            note: string | null;
            extracted_fields: Record<string, unknown> | null;
          }[];
        }[];
        evidenceRecords: {
          id: string;
          spz: string | null;
          document_type: string | null;
          movement_type: string | null;
          supplier: string | null;
          customer: string | null;
          document_number: string | null;
          material: string | null;
          material_original: string | null;
          material_category: string | null;
          document_date: string | null;
          brutto: number | null;
          tara: number | null;
          netto: number | null;
          unit: string | null;
          construction_site: string | null;
          source_location: string | null;
          destination_location: string | null;
          photo_url: string | null;
          raw_text: string | null;
          created_at: string | null;
          quantity: number | null;
        }[];
      };
    }
  | { kind: "action_result"; success: boolean; text: string }
  // ---------------------------------------------------------------------
  // Voice Phase 2 — viackrokový dialóg.
  //
  // `clarify` znamená: príkaz je rozpoznaný, ale niečo v ňom chýba alebo
  // je nejednoznačné, a appka sa PÝTA namiesto toho, aby doplnila. Je to
  // samostatný tvar, nie `answer` s otáznikom — UI podľa neho vie, že má
  // čakať odpoveď a poslať ju do toho istého dialógu.
  //
  // `conversationId` je opaque identifikátor, ktorý klient vráti pri
  // ďalšom kroku. Sám osebe nič neodomyká: server pri ňom vždy overuje aj
  // totožnosť volajúceho a jeho aktívnu firmu (pozri migráciu
  // 20260924100000_add_assistant_conversation_context.sql).
  //
  // `choices` sa posiela IBA pri výbere z konkrétnych kandidátov (napr.
  // dvaja partneri s podobným menom) a nesie ich označenia — nie preto,
  // aby si klient vybral sám, ale aby používateľ videl, medzi čím vyberá.
  // Výber sa aj tak vyhodnocuje na serveri proti uloženému kontextu.
  // ---------------------------------------------------------------------
  | {
      kind: "clarify";
      question: string;
      conversationId: string;
      choices?: { value: string; label: string }[];
    }
  // Draft vznikol a MUSÍ sa skontrolovať. `entity` vedie na detail
  // dokladu; `summary` je to isté, čo je v doklade, aby používateľ videl
  // výsledok skôr, než naň klikne. Žiadne potvrdzovanie pred vytvorením —
  // dôvod je pri CREATE_INVOICE_DRAFT v INTENT_NAMES vyššie.
  | {
      kind: "draft_created";
      title: string;
      note: string;
      summary: { label: string; value: string }[];
      entity: EntityRef;
    };
