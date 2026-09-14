# Esblu — Intent Engine + inteligentné textové vyhľadávanie + automatické upozornenia na lehoty

Dátum: 2026-09-14
Stav: **implementované a syntakticky overené** (viď sekcia "Overenie" nižšie
pre presný rozsah — `npx tsc`/`eslint`/`npm run build`/`git` neboli v tejto
session dostupné, pozri "Známe limity").

## 1. Čo táto session pridala (zhrnutie)

| Vrstva | Súbor | Stav |
|---|---|---|
| Deadline Engine | `lib/deadlines.ts` | nové |
| Entity resolution | `lib/entity-search.ts` | nové |
| Vehicle/Machine Report | `lib/vehicle-report.ts` | nové |
| User-scoped server klient | `lib/server-supabase-user-client.ts` | nové |
| Intent typy/allowlist | `lib/intents/types.ts`, `lib/intents/registry.ts` | nové |
| Deterministický parser | `lib/intents/parse.ts` | nové |
| AI fallback (OpenAI) | `lib/intents/ai-fallback.ts` | nové |
| Handlery (execute) | `lib/intents/handlers.ts` | nové |
| API endpoint | `app/api/assistant/intent/route.ts` | nové |
| Dashboard search + upozornenia | `app/components/Dashboard.tsx` | upravené |
| Detail vozidla — upozornenie | `app/vozidla/VehicleDetailView.tsx` | upravené |
| Detail stroja — upozornenie | `app/stroje/MachineDetailView.tsx` | upravené |
| i18n (SK/EN/DE) | `lib/i18n/dictionaries/{sk,en,de}.ts` | rozšírené (namespace `search`) |

Žiadna DB migrácia nebola potrebná — deadline dáta (STK/EK na
`vehicles`, `vehicle_vignettes.valid_until`,
`vehicle_services.next_service_date`, `machine_services.next_service_date`)
už existovali. `custom_document_categories` (z predchádzajúcej session)
zostáva bezo zmeny.

## 2. Audit pred implementáciou (dôležité zistenia)

- **Dashboard.tsx UŽ MAL** funkčný STK/EK/známky alert systém
  (`createAlerts()`/`checkDate()`, 30-dňový prah, farby red/orange) AJ
  jednoduché plain-substring vyhľadávanie (`search`/`searchResults`) naprieč
  vozidlami/strojmi/skladom. Zadanie predpokladalo, že appka "nemá" search
  pole — v skutočnosti existovalo, iba nerozumelo prirodzenému jazyku.
  **Riešenie:** existujúcu logiku som extrahoval do zdieľaného
  `lib/deadlines.ts` (žiadna duplicita, presne podľa zadania bod 8) a Intent
  Engine som napojil na TO ISTÉ search pole ako druhú, prídavnú vrstvu —
  nie ako náhradu.
- `public.vehicles.stk`/`.ek` sú `NOT NULL` — STK/EK teda NIKDY nie je "bez
  dátumu" v dnešnej schéme (na rozdiel od PZP/servisu).
- **PZP nemá štruktúrovaný dátumový stĺpec** nikde v schéme — existuje iba
  ako AI-extrahovaný `documents.extracted_fields.insuranceFields.validTo`
  na jednotlivom dokumente. Preto NIE JE súčasťou aktívneho Deadline Enginu
  (žiadne "PZP končí o X dní" upozornenie) — bol by to buď hádaný odhad,
  ktorý dokument je "aktuálna" zmluva, alebo N+1 query pre každé vozidlo
  firmy. `lib/vehicle-report.ts` ho zobrazuje iba ako best-effort READ
  (posledný priradený PZP dokument), nikdy ako aktívne upozornenie. Toto je
  vedomé, zdokumentované obmedzenie, nie prehliadnutie.
- Všetky RLS SELECT politiky na `vehicles`/`machines`/`inventory_items`/
  `vehicle_services`/`machine_services`/`documents`/`document_links`/
  `vehicle_vignettes` sú `company_id = esblu_my_active_company_id()` bez
  obmedzenia na rolu — owner/admin/employee dnes vidia rovnaké READ dáta.
  Intent Engine preto nepotrebuje vlastnú rolovú logiku pre READ intenty —
  RLS cez user-scoped klienta je jediná a postačujúca autorizácia (zadanie,
  bod 12).
- Žiadny existujúci `/api/assistant/*` alebo iný search/intent endpoint
  neexistoval — toto je prvá implementácia.

## 3. Architektúra (ako to funguje)

```
Dashboard search pole (existujúce, rozšírené)
        │ (debounced, 400ms)
        ▼
POST /api/assistant/intent  { text }
        │  1) verifyRequestUser (Bearer JWT)
        │  2) company_members aktívny membership check
        │  3) parseIntentDeterministic(text)  ──null──▶ classifyIntentWithAi(text)
        │  4) isRegisteredReadOnlyIntent()  (2. nezávislá allowlist kontrola)
        │  5) executeIntent() cez USER-SCOPED Supabase klienta (RLS)
        ▼
IntentResult { navigate | answer | report | list | deadline_list
             | disambiguate | not_found | error }
        │
        ▼
Dashboard vyrenderuje presne podľa `kind` (klik-to-navigate, nikdy
auto-redirect počas písania) — PRÍDAVNE nad existujúcim substring
zoznamom, ktorý zostáva bezo zmeny ako fallback.
```

Intenty (16, všetky `readOnly: true`, žiadny write/delete v tejto fáze —
pozri `lib/intents/types.ts`): `OPEN_VEHICLE`, `SEARCH_VEHICLE`,
`SHOW_VEHICLE_DOCUMENTS`, `SHOW_VEHICLE_SERVICE`, `VEHICLE_STK_STATUS`,
`VEHICLE_EK_STATUS`, `VEHICLE_VIGNETTE_STATUS`, `VEHICLE_COST_SUMMARY`,
`VEHICLE_REPORT`, `OPEN_MACHINE`, `SEARCH_MACHINE`,
`SHOW_MACHINE_SERVICE`, `MACHINE_REPORT`, `OPEN_INVENTORY_ITEM`,
`SEARCH_INVENTORY_ITEM`, `SEARCH_DOCUMENTS`, `UPCOMING_DEADLINES`.

Deadline Engine (`lib/deadlines.ts`) — jediná definícia prahov v celej
appke: `overdue` (<0 dní), `urgent` (0–7), `due_soon` (8–30), `upcoming`
(31–60), nad 60 dní sa negeneruje vôbec. Dashboard panel zámerne zostáva
na pôvodnom 30-dňovom okne/farbách (`buildLegacyDashboardAlerts`) —
`upcoming` pásmo a servisné termíny sú dostupné cez Intent Engine a cez
nové upozornenia na detaile vozidla/stroja, nie cez tento panel (nulová
vizuálna regresia Dashboardu).

## 4. Bezpečnosť

- Každý handler beží cez `getUserScopedSupabaseClient(accessToken)` —
  anon key + Bearer JWT prihláseného používateľa, NIE service_role. RLS
  (`company_id = esblu_my_active_company_id()`) je jediná autorizačná
  hranica, presne ako pri bežnom prehliadačovom prístupe.
- AI (`lib/intents/ai-fallback.ts`) sa spúšťa iba keď deterministický
  parser vráti `null`, a vracia VÝHRADNE hodnotu zo `INTENT_NAMES` enumu
  (strict `json_schema`, `store: false`) — nemôže vrátiť ľubovoľný string,
  natrvalo negeneruje SQL/JS.
- Dvojitá allowlist kontrola: `lib/intents/types.ts#isKnownIntentName` PRI
  parsovaní + `lib/intents/registry.ts#isRegisteredReadOnlyIntent` PRED
  spustením handlera — fail closed, ak sa nezhodujú.
- Žiadny write/delete intent v tejto fáze neexistuje (nie je iba vypnutý —
  v allowliste chýba úplne).

## 5. Overenie (presný rozsah — dôležité)

`device_bash` (shell na používateľovom PC) bol v tejto session
NEFUNKČNÝ (rovnaká chyba ako v predošlých session) — `npx tsc --noEmit`,
ESLint, `npm run build` ani žiadny `git` príkaz preto NEBOLO MOŽNÉ
spustiť. Vykonané namiesto toho:

1. **Syntaktická kontrola** — všetkých 11 nových/upravených `.ts`/`.tsx`
   súborov prešlo `npx esbuild --bundle=false` (zachytí syntax chyby,
   NIE typové chyby).
2. **i18n štrukturálna parita** — Node skript porovnal skompilované
   `sk`/`en`/`de` slovníky: namespace `search` má presne 44 zhodných
   kľúčov vo všetkých troch jazykoch; CELÝ slovník má presne 1182 zhodných
   kľúčov vo všetkých troch (žiadny chýbajúci/naviac kľúč).
3. **Manuálna trasovacia kontrola** deterministického parsera oproti
   testovacej matici zo zadania (príklady 1–11) — zdokumentovaná
   v commit-sprievodnom texte, nie automatizovaný test.
4. **Secret/conflict-marker scan** — `grep` na API kľúče a
   `<<<<<<<`/`>>>>>>>` markery vo všetkých zmenených súboroch — čisté.
5. **Runtime NEOVERENÉ** — appka sa v tejto session nedala spustiť
   (`npm run dev`), takže reálne HTTP volanie na
   `/api/assistant/intent`, reálne prihlásenie, ani reálne OpenAI
   volanie z `lib/intents/ai-fallback.ts` NEBOLO vyskúšané. Toto je
   riziko, ktoré treba pokryť manuálnym testom v appke (zoznam nižšie).

## 6. Čo NIE JE v tejto fáze (vedome, podľa zadania)

- **Hlas** — explicitne vylúčený zo zadania tejto úlohy ("NEIMPLEMENTUJ
  ešte hlas").
- **Write/delete intenty** — architektúra je pripravená (`registry.ts`
  má `requiresConfirmation` pole), ale allowlist dnes neobsahuje ani
  jeden write intent.
- **Push/email notifikácie** — zadanie ich pre túto fázu vyslovene
  nevyžaduje ("nepovažuj úlohu za neúspešnú, ak push ešte nie je
  zavedený"). Architektúra (`DeadlineItem` s `entityType`/`entityId`/
  `dueDate`/`severity`) je pripravená na budúce napojenie.
- **`SEARCH_DOCUMENTS`** je zámerne minimálna (ilike na
  `original_filename`/`note`, výsledky smerujú na `/ai-evidencia`) —
  appka dnes nemá samostatnú route pre jeden dokument.
- **PZP ako aktívne upozornenie** — pozri sekciu 2 vyššie.

## 7. Čo si má používateľ konkrétne otestovať v appke

1. Dashboard → search pole: napísať presnú ŠPZ existujúceho vozidla →
   malo by sa objaviť odporúčanie "Otvoriť" NAD pôvodným zoznamom
   výsledkov.
2. Napísať `kedy končí STK <ŠPZ>` pre vozidlo s blížiacim sa/prekročeným
   STK → mala by sa objaviť textová odpoveď s dátumom a počtom dní.
3. Napísať `urob report vozidla <ŠPZ>` → mal by sa objaviť panel so
   sekciami Základné údaje / STK-EK-PZP-známky / Servis a náklady.
4. Napísať niečo nejednoznačné (napr. časť názvu, ktorý sedí na 2+
   vozidlá) → mal by sa objaviť výber, nie automatický skok na jedno z
   nich.
5. Napísať úplný nezmysel → "Tomuto príkazu som nerozumel."
6. Firma BEZ blížiacich sa termínov → STK/EK panel na Dashboarde by sa
   NEMAL vôbec zobraziť (predtým ukazoval "0"/"žiadne upozornenia").
7. Vozidlo/stroj s blížiacim sa ďalším servisom → na jeho detaile by sa
   mal objaviť nový červený/oranžový banner pod nadpisom.
8. Vyskúšať EN aj DE ekvivalenty (`show me the documents for X`,
   `Zeige mir die Dokumente für X`).
9. Skontrolovať, že existujúce funkcie (TP sken, PZP flow, vážne lístky,
   faktúry/bločky, Prehľad podľa ŠPZ vrátane "Neurčené" stavu, XLSX
   export, Sklad, Chat, Closed Beta, prijatie právnych dokumentov) fungujú
   bezo zmeny — nič z uvedeného sa v tejto session nemenilo.
