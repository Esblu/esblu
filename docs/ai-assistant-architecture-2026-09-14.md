# Esblu — architektúra "Inteligentný Inbox + Univerzálne AI dokumenty + Hlasové vyhľadávanie a príkazy"

Stav: **architektonický návrh + Fáza 1 audit + základ pre Fázu 2 (custom kategórie)**.
Dátum: 2026-09-14. Autor: Claude (audit + návrh v rámci session, bez `device_bash` — pozri Known limits).

Tento dokument je podklad pre pokračovanie práce v ďalších sessions. Necháva jasnú hranicu medzi
**(A) čo už dnes v produkcii existuje** (netreba znovu stavať), **(B) čo je pridané touto session**
(migrácia + backend primitíva), a **(C) čo je zatiaľ iba návrh** (intent engine, voice, reporty,
permission hardening pre nové routes).

---

## 1. Fáza 1 — Dynamic Inbox: AUDIT VÝSLEDOK — už implementované

`app/ai-evidencia/page.tsx` už dnes odvodzuje viditeľnosť "Prehľad podľa ŠPZ" aj "Uložené doklady"
výhradne z `records.length > 0`, kde `records` je live state naplnený z `ai_evidence` (žiadny
DB flag typu `folderCreated`):

- Riadky do `ai_evidence` sa vkladajú **výhradne** pri kliknutí na "Uložiť" (funkcia volaná z
  review UI po kontrole AI výstupu) — počas samotnej AI analýzy (pred potvrdením) žiadny riadok
  nevzniká, výsledok žije iba v lokálnom React state (`result`). To znamená, že požiadavka
  "analyzovaný ale nepotvrdený lístok → sekcia sa ešte neaktivuje" (test 13) je splnená by design.
- `deleteRecord()` po úspešnom DB delete volá `loadRecords()` znova → ak bol zmazaný posledný
  záznam firmy, `records` sa stane `[]` a obe sekcie sa automaticky znova skryjú (test 5/13 zo
  zadania — žiadny ďalší kód netreba).
- Nový/prázdny firemný účet: `loadRecords()` vráti `[]` → nič sa nezobrazí (test 11).

**Záver:** nenašiel som žiadny kódový problém, ktorý by zodpovedal popisu ("sekcia sa zobrazuje aj
bez dát"). Možné vysvetlenia: (a) pozorované na firme, ktorá už dáta mala, (b) požiadavka bola
preventívna do budúcna. Neurobil som žiadnu zmenu v `app/ai-evidencia/page.tsx` pre Fázu 1 —
pridávať kód na "opravu" niečoho, čo sa v aktuálnom stave repozitára nereprodukuje, by bolo viac
riskantné než užitočné. **Ak sa jav objaví znova, potrebujem presný scenár** (nová firma bez
žiadneho vozidla, presné kroky) — je možné, že ide o inú obrazovku, nie o `ai-evidencia/page.tsx`.

---

## 2. Existujúca architektúra — čo NEtreba stavať znova

### 2.1 Document pipeline (Fázy 2, 3, 5, 6 sú väčšinou už hotové)

`app/api/scan-document/route.ts` (OpenAI Responses API, `model: "gpt-5.6-terra"`, `store: false`,
`reasoning: {effort: "none"}`, strict `json_schema` structured output) **už dnes**:

- klasifikuje AJ extrahuje v jednom kroku (`documentType` je AI výstup, nie používateľský výber
  pred uploadom — presne to, čo žiada Fáza 2),
- rozpoznáva jazyk dokumentu (`documentLanguage`: `sk | cz | de | en | null` — Fáza 3 čiastočne
  hotová; **PL chýba**, pozri 4.1),
- vracia `confidenceScore` (0–1) a `fieldConfidence` (pole `{field, confidence}` per pole) — Fáza 5,
- vracia `reviewStatus` (`confirmed_candidate | needs_review`) — **počítané server-side
  autoritatívne** (threshold na `confidenceScore` + hmotnostný math-mismatch check), nikdy sa
  neverí AI vlastnému tvrdeniu naslepo,
- `additionalProperties: false` + presne jeden z `weighTicketFields/deliveryNoteFields/
  invoiceFields/receiptFields/insuranceFields/serviceDocumentFields/otherFields` vyplnený,
  ostatné `null` — vynucuje sa promptom AJ server-side validáciou po parse,
- `resolveSpzFallback()` — druhé, cielené AI volanie (`model: "gpt-4.1"`) IBA na doriešenie ŠPZ pri
  nejasnej hlavnej extrakcii, nie konkurenčný klasifikátor.

Review-before-save (Fáza 6) už existuje: AI výstup sa vždy najprv zobrazí na kontrolu (`result`
state v `page.tsx`), zápis do DB nastáva až po kliknutí na potvrdenie.

**Záver:** Fázy 2/5/6 nie sú "postav od nuly" — sú "rozšír existujúce". Konkrétne chýbajúce kusy:

- `suggestedAction`/`warnings`/`requiresUserConfirmation` ako explicitné pomenované polia v
  schéme — dnes ich nahrádza `reviewStatus` + aplikačná logika (`resolveVehicleIdBySpz` a pod.).
  Toto je vedomé, bezpečnejšie rozhodnutie existujúcej architektúry (entity-matching robí
  deterministický DB lookup podľa ŠPZ/VIN, nie AI odhad) — **odporúčam ho zachovať**, nie
  nahrádzať AI-generovaným "suggestedEntity" poľom.
- `documentType` nepozná žiadnu hodnotu mimo pevných 8 (`documents_document_type_check` CHECK v
  DB) — nová kategória vyžaduje `other` + custom kategóriu (pozri časť 3).

### 2.2 Permissions (kritické pre Fázu 11/16)

- Role: `owner | admin | employee` (`lib/company.ts`).
- **RLS je jediná skutočná autorita.** `company_members.permissions` (jsonb) existuje v DB, ale je
  dnes **nevyužitý** — owner/admin majú plný prístup podľa role, employee dnes vidí/môže v podstate
  všetko v rámci firmy, čo prejde `company_id = esblu_my_active_company_id()` (žiadne jemnejšie
  obmedzenie na úrovni employee dnes v RLS neexistuje).
- Praktický dôsledok pre Fázu 11: **akýkoľvek nový search/voice/report endpoint smie čítať dáta
  VÝHRADNE cez klienta s user JWT (`supabase` s Authorization header prihláseného používateľa),
  nikdy cez `service_role`.** Tým sa automaticky dedí presne tá istá hranica, akú má dnes bežné UI
  — nie je čo nanovo "vymýšľať", iba dôsledne NEPOUŽIŤ service_role v novom kóde. Ak by sa v
  budúcnosti employee permissions v `company_members.permissions` sprísnili, nový AI search vrstvu
  to automaticky zdedí bez zmeny — pokiaľ zostane user-scoped.

### 2.3 Chýbajúca infraštruktúra (skutočne nová práca)

Žiadny existujúci search, intent parser, voice endpoint ani report view — `app/api/` obsahuje iba
`scan-document`, `scan-vehicle-doc`, `scan-vehicle-registration`, `account/*`. Fázy 7–15 sú
100 % nová subsystéma.

---

## 3. Táto session — čo bolo REÁLNE pridané (aplikované, overené)

### 3.1 DB migrácia `add_custom_document_categories` (aplikovaná na produkciu, overená)

Čisto aditívna, bez rizika straty dát, bez zmeny existujúcich CHECK/RLS:

```
public.custom_document_categories (
  id, company_id → companies(id) cascade,
  name, canonical_slug (unique per company_id), description,
  created_by → auth.users(id) set null, created_at
)
public.documents.custom_category_id uuid null → custom_document_categories(id) set null
```

RLS (zrkadlí presne existujúci `documents` vzor, žiadne nové privilegované DB funkcie):
SELECT/INSERT pre ktoréhokoľvek aktívneho člena firmy, UPDATE/DELETE iba owner/admin.

Overené po aplikovaní: `pg_policies` ukazuje presne 4 politiky, `documents.custom_category_id` je
nullable uuid, `get_advisors(security)` nehlási žiadny nový nález spôsobený touto migráciou
(všetky existujúce nálezy sú predexistujúce a netýkajú sa tejto zmeny).

### 3.2 `lib/custom-document-categories.ts` (nový súbor, syntax-overený cez esbuild)

`normalizeCanonicalCategorySlug()`, `listCompanyCustomCategories()`,
`findMatchingCustomCategory()` (exact-slug match, **zámerne žiadny fuzzy/Levenshtein** — aby sa
nikdy tichým "priblížením" nespojili dve odlišné kategórie; mierne odlišná formulácia = nový
riadok, nie chybné zlúčenie), `createCustomCategory()` (RLS-scoped insert, `23505` unique
violation sa rieši ako úspech s dohľadaním existujúceho riadku, nie ako chyba).

Toto je **backend primitíva, ešte NEPRIPOJENÁ na UI** — review obrazovka v `ai-evidencia/page.tsx`
(alebo jej nástupca) ju musí zavolať vo vetve `documentType === "other"`, PO potvrdení
používateľom. Zámerne som nezasahoval do `page.tsx` v tomto kroku (veľký, už teraz 124 KB súbor,
bez build validácie by bola zmena tejto veľkosti nezodpovedná).

---

## 4. Návrh zvyšných fáz (NEIMPLEMENTOVANÉ — návrh pre pokračovanie)

### 4.1 Multijazyčná extrakcia (Fáza 3) — rozšírenie, nie prestavba

Pridať `"pl"` do `documentLanguage` enum v `DOCUMENT_SCAN_SCHEMA` (+ prompt sekcia s poľskými
label-ekvivalentmi, rovnaký vzor ako existujúce SK/CZ/DE/EN riadky). Významová extrakcia (nie
per-jazyk parser) už je princíp existujúceho promptu — rozšírenie je v podstate len pridanie
label-zoznamov do promptu + enum hodnoty, nízke riziko, ale vyžaduje prompt-tuning a testovanie na
reálnych PL dokumentoch, ktoré nemám k dispozícii.

### 4.2 Command/Intent Engine (Fázy 7–14) — navrhovaná kostra

```
lib/intents/
  schema.ts        // IntentName enum + Zod/JSON schéma argumentov per intent
  registry.ts       // allowlist: { intent → { permission, argsSchema, readOnly, handler } }
  handlers/
    vehicle.ts       // OPEN_VEHICLE, SEARCH_VEHICLE, SHOW_VEHICLE_DOCUMENTS, VEHICLE_REPORT, ...
    machine.ts
    inventory.ts

app/api/assistant/
  parse-intent/route.ts   // TEXT → structured intent (OpenAI structured output, allowlist enum,
                            // NIKDY voľný text/SQL） — auth + company-scoped, rate limited
  execute-intent/route.ts // structured intent → handler z registry.ts, používa VÝHRADNE
                            // user-scoped Supabase klient (Authorization: Bearer <user JWT>)
  transcribe/route.ts     // iba ak sa zvolí server-side transcription (pozri 4.3) — inak sa
                            // browser Web Speech API pripája priamo na parse-intent s transcriptom
```

Kľúčové bezpečnostné pravidlá pre `execute-intent`:

1. **Fail closed.** Neznámy/nerozpoznaný intent → `{ok: false, message: "Tomuto príkazu som
   nerozumel."}`, nikdy pokus o "najbližší" fallback.
2. **Read-only intenty** (`OPEN_*`, `SEARCH_*`, `SHOW_*`, `*_REPORT`, `*_COST_SUMMARY`) sa smú
   vykonať priamo po permission checku.
3. **Write intenty** (`ADD_SERVICE_RECORD`, `ASSIGN_DOCUMENT`, ...) vrátia iba **návrh** (presne
   naplnené argumenty + human-readable zhrnutie) — samotný zápis je SAMOSTATNÝ endpoint/krok,
   volaný iba po explicitnom potvrdení v UI (rovnaký vzor ako existujúci `document_review_log` +
   review-before-save v `scan-document`).
4. **Destructive intenty (DELETE_*) sa do allowlistu v prvej iterácii vôbec nezaraďujú** — bezpečnejšie
   nemať mazací intent vôbec, než ho mať za "ešte prísnejším" potvrdením, ktoré sa dá obísť chybou
   v implementácii.
5. Každý handler dostáva `{ userId, companyId, role }` odvodené SERVER-SIDE zo session JWT (nikdy z
   tela requestu) a používa iba `createServerSupabaseClient(request)` s user JWT — nikdy
   `supabase-admin` (service role, `lib/supabase-admin.ts` existuje, ale je dnes použitý iba v
   `account/delete` — vedomá výnimka pre nezvratné mazanie účtu, nie vzor na kopírovanie).

### 4.3 Voice — odporúčanie: browser/native Speech Recognition ako primárna cesta

Audit priority (zadanie: "preferuj minimálnu retenciu, žiadne audio v Storage, žiadny vendor
lock-in bez dôvodu"):

- **Web Speech API** (`webkitSpeechRecognition`/`SpeechRecognition`) beží v prehliadači, audio
  nikdy neopustí zariadenie, žiadny nový provider, žiadne server náklady. Funguje v Chrome/Edge
  (desktop aj Android WebView) — **treba overiť konkrétne správanie v Capacitor Android WebView**
  (známy rizikový bod: niektoré Android WebView verzie vyžadujú `@capacitor-community/speech-recognition`
  natívny plugin namiesto browser API). Toto je presne tá "potreba nového externého plateného
  providera" hranica zo STOP podmienok — **ak WebView test ukáže, že natívny plugin je nutný,
  zastavím sa a nahlásim to ako rozhodnutie pred inštaláciou závislosti**, keďže aj bezplatný nový
  natívny Capacitor plugin je architektonická zmena (nová natívna závislosť, Android permission).
- Server-side transcription (OpenAI `gpt-4o-transcribe`/Whister cez už existujúci OpenAI klient,
  `store: false`) ako **fallback** pre jazyky/zariadenia, kde Web Speech API chýba/je nespoľahlivé
  — audio sa po transkripcii okamžite zahodí, nikdy sa needpisuje do Storage. Toto NIE JE nový
  provider (OpenAI je už integrovaný), takže nezakladá STOP dôvod.
- V oboch prípadoch: transcript → **ten istý** `parse-intent` endpoint ako textové vyhľadávanie
  (žiadna samostatná voice-only logika, presne podľa zadania Fázy 8).

### 4.4 Vehicle report (Fáza 15)

Nový read-only agregačný endpoint/handler `VEHICLE_REPORT`, ktorý:

1. Načíta vozidlo (RLS-scoped `.eq("id", vehicleId)` — cudzia firma dostane prázdny výsledok, nie
   chybu s únikom informácie o existencii záznamu).
2. Paralelne načíta: `vehicle_services`, `ai_evidence` (dokumenty priradené cez `vehicle_id`),
   `vehicle_vignettes`, TP/PZP polia priamo z `vehicles` (ak tam už sú stĺpce — audit `vehicles`
   schémy je predpoklad pred implementáciou, nerobil som ho v tejto session z časových dôvodov).
3. Vracia iba to, čo je reálne v DB — chýbajúce pole sa v UI zobrazí ako "Nie je evidované", nikdy
   sa nedopĺňa AI odhadom.
4. Report VIEW (nie AI generovaný text) — AI smie iba zoradiť/zosumarizovať už načítané dáta, nikdy
   vymýšľať čísla/dátumy (presné zadanie Fázy 15).

---

## 5. Odporúčané poradie ďalšej práce (pre nasledujúcu session)

1. Audit `vehicles` schémy (STK/EK/PZP/diaľničná stĺpce) — predpoklad pre 4.4.
2. `lib/intents/schema.ts` + `registry.ts` + 3–4 najjednoduchšie read-only handlery
   (`OPEN_VEHICLE`, `SEARCH_VEHICLE`, `SHOW_VEHICLE_DOCUMENTS`) — malý, izolovaný, ľahko
   testovateľný prírastok.
3. `app/api/assistant/parse-intent` + `execute-intent` pre tú istú malú množinu intentov.
4. UI: jedno search pole + zoznam rozpoznaných intentov (bez mikrofónu zatiaľ) — Fáza 13 kostra.
5. Web Speech API integrácia + Android WebView test.
6. Zvyšné intenty (report, cost summary, write intenty s potvrdením).
7. Prepojenie `lib/custom-document-categories.ts` na review UI (dokončenie Fázy 2/4).
8. PL jazyk (4.1).
9. Permission hardening review (`get_advisors` + manuálny employee-scoped test) po tom, čo
   `execute-intent` existuje.

Každý bod je samostatne commitovateľný a testovateľný — presne v duchu "nerob jeden obrovský
neprehľadný patch" zo zadania.

---

## 6. Known limits tejto session

- `device_bash` (jediný spôsob spustenia `tsc`/`eslint`/`npm run build`/`git` na projekte) bol
  celý beh nedostupný (mount error, opakovane potvrdené). Migrácia a nový `.ts` súbor boli preto
  overené inak: migrácia priamo cez `pg_policies`/`information_schema`/`get_advisors` po aplikovaní
  na produkciu (silnejšie overenie než lokálny build by dal), nový TS súbor cez `esbuild` syntax
  transform (zachytí syntax chyby, NIE typové chyby cez celý projekt/tsconfig paths).
- Preto som zámerne NEROBIL zásahy do veľkých, už existujúcich súborov (`ai-evidencia/page.tsx`,
  `scan-document/route.ts`) v tejto session — riziko nevidenej typovej chyby bez build feedbacku
  je pri súboroch tejto veľkosti reálne, a ide o produkčnú appku s reálnymi používateľmi.
- Intent engine / voice / report view / permission hardening pre nové routes sú **iba návrh**,
  nie kód. Toto je vedomé rozhodnutie, nie prehliadnutie — dôvod je v bode vyššie plus reálny
  rozsah (nová subsystéma, nie rozšírenie existujúcej).
