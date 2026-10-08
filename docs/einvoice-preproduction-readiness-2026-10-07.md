# eFaktúra — PRE-PRODUCTION READINESS audit a rollout plán (7. 10. 2026)

> **Aktualizované 7. 10. 2026 (closure):** stav podľa dimenzií CODE / CONFIG / LEGAL / PROVIDER / ROLL-OUT,
> nálezy (konečná faktúra so zálohou — FS FAQ príklad 38; lehota § 85o ods. 6), Vercel Pro crony, alerting,
> backup, read-only precheck a merge readiness: `docs/einvoice-preproduction-closure-2026-10-07.md`.

Interný technický podklad. **Nie je to povolenie produkčného nasadenia** ani právne stanovisko.
Vetva `einvoice-port`. Produkčná DB, `main`, produkčné secrets ani live eFaktúra sa počas auditu
nemenili. Na produkčnej DB (`fkpgvgvsmbpieduoatrt`) sa vykonalo **iba** čítanie zoznamu
aplikovaných migrácií (určenie rozsahu). Žiadny dotaz nad dátami, žiadna zmena.

---

## 1. Opravený zoznam blockerov

### Uzavreté (už nie sú blocker)

| Položka | Stav | Overenie 7. 10. |
| --- | --- | --- |
| Preview env (prod service_role / OpenAI v Preview) | **vyriešené** vlastníkom | Všeobecný Preview: `NEXT_PUBLIC_SUPABASE_URL` → staging `cjbdijbbcujvmrzezusd`; Production má samostatné záznamy; `einvoice-port` má branch override (Supabase, CRON, eFaktura sandbox). Hodnoty secrets sa nečítali. |
| Príjem 386 a konečnej faktúry s BT-113 | vyriešené (`20261008100008`) | reálny sandbox E2E N–S |
| `test:partners` 83/84 | vyriešené | príčina nižšie (sekcia 2) |

### Otvorené — technické (detail v sekcii 10.B)

1. Produkčné migrácie `20261002100000` … `20261008100008` (20 súborov) — nespustené.
2. Zlúčenie `einvoice-port` → `main` (main má 2 commity navyše; jediný konflikt `package.json`, triviálny).
3. Prvý import kurzov ECB hneď po migráciách (inak finalizácia vydanej faktúry v cudzej mene zlyhá `ESBLU_FX_RATE_DATA_MISSING`).
4. Notifikácia monitoringu (Vercel/externý alert na zlyhaný cron) — kód je pripravený, kanál musí nastaviť vlastník.
5. Vercel plán musí povoliť crony častejšie ako 1× denne (overiť plán; Preview build s cronmi je READY).
6. Odpovede eFaktura.sk na P1/P2/P4 (bezpečnosť opakovaného odoslania).

### Otvorené — právne / zmluvné (sekcia 10.C)

Zmluva + DPA s eFaktura.sk, CLIA stanovisko k API modelu a delta (sekcia 6), retenčná politika Esblu,
potvrdenie účtovníčky (XML ako účtovný doklad, postup záloh). Kód typu zálohy: CLOSED 8. 10. — 388.

---

## 2. Quality gate

Testy bežali na čistom LF checkout-e `HEAD` (rovnaký stav ako CI/Vercel) aj v pracovnom strome.

| Sada | Výsledok |
| --- | --- |
| eFaktúra: einvoice-db 44, ubl 65, efaktura 17, outbound 47, inbound 47, ops 23, ui 53, l3-inbound-one 16, partner 23, hardening 19, reception 23, staging-guard 8 | PASS |
| e2e self-testy: sandbox 27 PASS + 1 PARTIAL (I12 webhook iba offline časť — zámerne), partner 25 PASS | PASS |
| fakturácia: invoicing-flow **39**, invoicing-sk 33, handoff 122, i18n 114, plan-entitlements 47, closed-beta-p0 36, p0-bank-sql 17 | PASS |
| ostatné: voice 38, partners **84**, dates 62, items 109, state 43, register 23, money 41, lifecycle 30, pricemode 55, vat 29, gross 230, format 55, folders 45, intent-permissions 44, voice-flow 17, assistant-grammar 24, push 28, company-lookup 57, l3-launcher 25, m1-authz-db 47, push-db 31, company-lookup-db 13 | PASS |
| voice-conversation 75, assistant-orchestrator 66, master-control 34, continuous-voice 38, mobile-m0 24, mobile-m1 64 | PASS na LF checkout-e; na Windows pracovnom strome (CRLF) 1 falošné zlyhanie v každej — pozri nižšie |
| TypeScript (`tsc --noEmit`) | PASS |
| ESLint — všetky súbory zmenené vo vetve (133) | 0 chýb, 10 kozmetických warningov (nepoužité importy, `<img>`) |
| ESLint — celé repo | 33 chýb, **všetky v súboroch, ktoré vetva nemení** (`app/vozidla`, `app/sklad`, `app/obchodni-partneri`, `app/ai-evidencia`, `Dashboard.tsx`) — existujúci dlh `main` |
| Vercel Preview build `4947ba1` (vrátane `vercel.json` s cronmi) | READY |

**`test:partners` 83/84 — príčina:** test hľadá mená testovacích partnerov v produkčnom kóde po odstránení
komentárov. Riadkové komentáre odstraňoval regexom `\/\/.*$` po `split("\n")`. Na Windows pracovnom
strome (CRLF) ostáva na konci riadku `\r`, ktoré `.` nezachytí, takže `$` nesedí a komentár sa
neodstráni → všetky nálezy boli **v komentároch** („Tester1“ v opisoch chýb). Repo bloby sú LF; na
CI test prechádza. Oprava: `split(/\r?\n/)`. Nejde o produkčnú chybu.
Rovnaká trieda (reťazcové `includes` s `\n` na CRLF súboroch) spôsobuje falošné zlyhania 6 hlasových/
mobilných sád v Windows pracovnom strome; na LF checkout-e sú zelené. Tie sady nie sú súčasťou eFaktúry —
neopravované (mimo rozsah), iba nahlásené.

**Zlúčenie s `main` (skúšobne, nič nepushnuté):** konflikt iba v `package.json` (obe strany pridali
test skripty → zjednotenie). Po zlúčení: tsc PASS, einvoice-ui padal na allowlist migrácií
(`20261005090000/091000` zo `main`) → opravené vopred vo vetve; ostatné overené sady PASS
(storage-media 10, storage-media-db 33, google-oauth 17, google-oauth-db 18, m1-authz-db 47, einvoice-db,
inbound, invoicing-flow, invoicing-sk, i18n, handoff, partners, master-control, mobile-m1).

---

## 3. Migration chain audit

### Presný rozsah

Produkcia má posledné `20261005091000_private_media_buckets` (zo `main`). Neaplikované a potrebné:

```
20261002100000_einvoice_foundation
20261002110000_einvoice_en16931_fields
20261002120000_einvoice_outbound_flow
20261002130000_einvoice_inbound_flow
20261002140000_einvoice_operations
20261002150000_einvoice_rollout_gate
20261003100000_einvoice_inbound_draft_totals
20261005100000_einvoice_partner_onboarding
20261005110000_einvoice_enroll_error_code_active
20261006100000_einvoice_supplier_dic_feed_cursor
20261007100000_einvoice_event_ops_enroll_limit
20261008100000_invoicing_sk_compliance
20261008100001_invoicing_sk_trigger_fn_revoke
20261008100002_finance_helpers_bind_active_company
20261008100003_fx_rate_date_exact
20261008100004_fx_official_reference_rates
20261008100005_invoicing_corrections_payments_advances
20261008100006_einvoice_outbound_payment_received
20261008100007_einvoice_correction_backlink
20261008100008_received_advances
```

Súbory s časovou pečiatkou < `20260909` chýbajú v produkčnej histórii iba preto, že produkcia sleduje
migrácie od 9. 9. 2026 (baseline) — nie sú súčasťou rozsahu.

**Poradie:** časové pečiatky `20261002…` sú staršie ako `main` migrácie `20261005090000/091000`, ktoré sú
v produkcii už aplikované. Na stagingu sa reťazec aplikoval **bez** týchto dvoch storage migrácií.
Interakcia overená: storage migrácie volajú `esblu_my_finance_manage()`, ktorú `20261008100002`
sprísňuje na aktívnu firmu → storage-media-db sada s pridanou `20261008100002` po storage migráciách:
33/33 PASS. Iné prekryvy (tabuľky, politiky, buckety) nie sú.

### Výsledky

| Kontrola | Výsledok |
| --- | --- |
| Závislosti | lineárne; každá migrácia závisí iba od predchádzajúcich v reťazci + produkčného baseline (invoicing core, finance helpers, entitlements). |
| SECURITY DEFINER + `search_path` | staging po reťazci: 75 definer funkcií v oblasti eFaktúra/fakturácia, **0 bez `search_path`**. |
| Anon | 0 funkcií spustiteľných rolou `anon`, 0 tabuľkových grantov pre `anon`. |
| RLS | všetky nové tabuľky RLS ON; servisné tabuľky (`einvoice_*` ops/cursor/rollout, `einvoice_enroll_attempts`) zámerne bez politík = prístup iba `service_role`. Supabase security advisor: žiadny nový nález pre eFaktúru. |
| Authenticated RPC | iba zámerné používateľské RPC (úhrady, saldo, zálohy, review opráv/záloh, compliance polia, rollout, kurz). Každé overuje finance oprávnenie a aktívnu firmu (pokryté testami, role matrix). |
| Idempotencia | `create or replace`, `if not exists`, `drop … if exists`; DO bloky s kotvami (`100006`, `100008`) sú idempotentné a pri neočakávanom stave zlyhajú, nič nezmenia. |
| Deštruktívne príkazy | žiadne nad produkčnými dátami. `20261008100004` maže tabuľku `fx_rate_publication_exceptions`, ktorú vytvorila `20261008100003` v tom istom reťazci (v produkcii prázdna). TRUNCATE iba nad `pg_temp`; TRUNCATE na `einvoice_events` je blokovaný triggerom. |
| Dátové transformácie existujúcich riadkov | žiadne `update`/`delete` produkčných dát. Iba konfigurácia: riadok `entitlement_catalog` (`einvoice`) a bucket `einvoice-documents` (privátny). |
| Syntetické firmy / users / secrets / staging ref | 0 výskytov (grep UUID literálov, `e2e5a…`, `example.com`, staging/prod ref, kľúčov). |
| **Riziko: nové CHECK obmedzenia nad existujúcimi tabuľkami** | `invoice_items`/`invoice_tax_breakdowns.vat_category_code`, `company_billing_profile.vat_payer_status`, `invoices.kind`, `proforma_issued_only`, `payment_status`, `corrects_required_for_notes` sa validujú voči **existujúcim produkčným riadkom**. Staging mal iné dáta → **precheck P-3 v runbooku je povinný**. |
| **Riziko: zmena správania pre všetky firmy** (nie iba eFaktúra rollout) | `20261008100000…100005` sprísňujú finalizáciu vydaných faktúr (§ 74 polia, § 26 kurz, opravné doklady, zálohy) a pridávajú úhrady/saldo. Platí okamžite pre všetkých zákazníkov — vyžaduje koordinované nasadenie aplikácie (sekcia 9). |
| Rollback | samostatné súbory pre `100000, 100003, 100004, 100005, 100007 (+100006), 100008` a partner onboarding/feed/ops; ostatné majú postup v hlavičke migrácie. `100001` (iba revoke) a `100002` (helpery) bez súboru → v prechecku sa uloží `pg_get_functiondef` pôvodných helperov. Odporúčaný rollback celého reťazca: **PITR/backup** (reťazec je aditívny; forward-fix je preferovaný). |

---

## 4. Production migration runbook (NESPUSTENÉ — vyžaduje súhlas vlastníka)

Cieľ: Supabase `assetpilot` (`fkpgvgvsmbpieduoatrt`). Okno: mimo pracovného času, bez paralelného deployu.

**P-0 Súhlas a backup**
- Výslovný súhlas vlastníka s oknom.
- Overiť dostupnosť PITR / vytvoriť manuálny backup (Supabase dashboard). Zaznamenať čas.

**P-1 Stav (read-only)**
```sql
select max(version), count(*) from supabase_migrations.schema_migrations;   -- posledná = 20261005091000
select count(*) from pg_class where relname like 'einvoice_%';                -- 0
select pg_get_functiondef('public.esblu_my_finance_manage()'::regprocedure),
       pg_get_functiondef('public.esblu_my_finance_view()'::regprocedure);   -- uložiť mimo repa (rollback 100002)
```

**P-2 invoice_events constraint (kotva pre DO bloky 100005/100008)**
```sql
select count(*) from pg_constraint where conrelid = 'public.invoice_events'::regclass
  and contype = 'c' and pg_get_constraintdef(oid) like '%event_type%';            -- musí byť 1
```

**P-3 Existujúce riadky vs. nové CHECK (každý musí vrátiť 0)**
```sql
select 'items_vat' k, count(*) from public.invoice_items where vat_category_code not in ('S','Z','E','AE','K','G','O')
union all select 'tax_vat', count(*) from public.invoice_tax_breakdowns where vat_category_code not in ('S','Z','E','AE','K','G','O')
union all select 'vat_payer', count(*) from public.company_billing_profile where vat_payer_status is not null and vat_payer_status not in ('vat_payer','non_vat_payer')
union all select 'kind', count(*) from public.invoices where kind not in ('regular_invoice','payment_received_invoice','credit_note','debit_note','proforma')
union all select 'proforma_dir', count(*) from public.invoices where kind = 'proforma' and direction <> 'issued'
union all select 'payment_status', count(*) from public.invoices where payment_status not in ('unpaid','partially_paid','paid','overpaid')
union all select 'corrects', count(*) from public.invoices where (kind in ('credit_note','debit_note')) <> (corrects_invoice_id is not null);
```
Ak niektorý > 0 → STOP, nespúšťať, analyzovať riadky (mimo okna).

**P-4 Dopad na existujúcich zákazníkov (informatívne)**
```sql
select currency, document_status, direction, count(*) from public.invoices group by 1,2,3 order by 1;
select count(*) from public.invoices where document_status = 'draft' and direction = 'issued';
```
Koncepty v cudzej mene budú po migrácii vyžadovať importované kurzy ECB (krok M-3).

**M-1 Migrácie** — 20 súborov v poradí zo sekcie 3, každý samostatne (`apply_migration`, názov = názov
súboru bez `.sql`, rovnako ako staging). Pri prvej chybe STOP; nepokračovať ďalším súborom.

**M-2 Post-check (read-only)**
- `select count(*) from supabase_migrations.schema_migrations where name like '2026100%'` → 20 nových.
- md5 tiel funkcií voči PGlite referencii (rovnaký postup ako staging 7. 10.; 15 funkcií z `100008` sa zhodovalo).
- Security advisor: žiadny nový WARN pre eFaktúru; 0 definer funkcií pre `anon`; RLS na `einvoice_*`, `fx_*`, `received_advance_links`.
- `select stage, count(*) from public.einvoice_rollout group by 1` → prázdne (nikto nie je zapnutý).

**M-3 Kurzy ECB** — hneď po nasadení aplikácie (krok R-4): jedno manuálne volanie
`GET /api/cron/fx-rates` (CRON_SECRET) → `success:true`, coverage do posledného pracovného dňa.

**Rollback**
- Chyba počas M-1 v migrácii N: N je v transakcii (nič sa nezapísalo); predchádzajúce sú aditívne a
  bez aktivovaného poskytovateľa neškodné → opraviť a pokračovať (forward-fix), alebo vrátiť po
  súboroch `supabase/rollback/*` v opačnom poradí.
- Závažná regresia po nasadení (napr. finalizácia faktúr) → vrátiť aplikáciu na predchádzajúci
  produkčný deployment (Vercel „Promote“) a kompatibilne vypnúť triggre podľa rollback súborov
  `100000/100003/100004/100005`; PITR iba ako posledná možnosť (strata dát od času backupu).

---

## 5. Cron readiness

Vercel spúšťa crony **iba pre produkčný deployment**. `vercel.json` vo vetve `einvoice-port` preto nič neaktivuje — produkčná konfigurácia cronov ostáva `deadline-notifications`
(overené cez API 7. 10.). Aktivuje sa až zlúčením do `main` a produkčným deployom. eFaktúra crony sú
bez env poskytovateľa no-op (`configured:false`).

Spoločné: `GET`, autorizácia `Authorization: Bearer $CRON_SECRET` (Vercel ho posiela automaticky,
timing-safe porovnanie, < 16 znakov = 401), `maxDuration` 60 s, odpoveď iba počty a kódy.

| Cron | Cadence | Timeout / retry | Idempotencia | Alert podmienka | Dopad, ak nebeží |
| --- | --- | --- | --- | --- | --- |
| `/api/cron/fx-rates` | `0 5,16 * * *` (ráno uzavretý deň; popoludní po publikácii ECB) | fetch 20 s; ďalší beh = retry | rovnaký súbor = rovnaký SHA-256; append-only, konflikt → chyba, nič sa neprepíše | HTTP 502/500 (`ECB_FETCH_FAILED`, `ESBLU_FX_*`) | finalizácia vydanej faktúry v cudzej mene zlyhá `ESBLU_FX_RATE_DATA_MISSING`; EUR nie je dotknuté |
| `/api/cron/einvoice-outbound?mode=send` | `* * * * *` (odoslanie do ~1 min) | dávka ≤ 10, lease 120 s, rozpočet pod 60 s; backoff v DB (max 8 pokusov, ~2 h) | claim `FOR UPDATE SKIP LOCKED`; rovnaký `Idempotency-Key` pri opakovaní | maintenance: `OUTBOUND_*`, `REJECT_RATE_HIGH` | odoslanie čaká vo fronte (`queued`); nič sa nestratí |
| `/api/cron/einvoice-outbound?mode=reconcile` | `*/5 * * * *` (stav sa dopytuje ≥ 5 min po zmene) | 45 s/položka | iba čítanie stavu + zápis prechodu | maintenance: stuck / unknown | stav `sent` sa nedoplní na `delivered` (UI ukáže starší stav) |
| `/api/cron/einvoice-events` | `*/5 * * * *` | 5 strán × 100, lease 120 s; súbežný beh = `LOCKED` | kurzor v DB, dedupe udalostí (`DUPLICATE`) | maintenance: `EVENT_FEED_STALE` (> 2 h), `EVENT_FEED_ERROR`, `EVENTS_EXHAUSTED` | fallback k webhooku chýba; pri výpadku webhooku sa príjem/stav oneskorí |
| `/api/cron/einvoice-inbound` | `*/10 * * * *` | dávka 5, lease 120 s | registrácia idempotentná (provider id, SHA-256) | maintenance: `INBOUND_*` / ACK pending > 60 min | druhá poistka príjmu; bez nej iba webhook + feed |
| `/api/cron/einvoice-maintenance` | `17 * * * *` | DB-only | retencia technických webhook dát 90 dní (dávky po 1 000) | **HTTP 503 pri kritickom alerte** (nové v `4947ba1`) | žiadne alerty, retencia sa nevykoná |
| `/api/cron/deadline-notifications` | `0 6 * * *` (už v produkcii) | — | — | — | (mimo eFaktúry) |

Predpoklady (vlastník): Vercel plán s cronmi častejšími ako 1× denne; nastaviť notifikáciu na zlyhaný
cron / 5xx (Vercel Observability alert, log drain alebo externý uptime monitor na tieto cesty).

---

## 6. Provider production checklist (eFaktura.sk) — nič nie je aktivované

| # | Položka | Stav | Kto |
| --- | --- | --- | --- |
| 1 | Podpísaná partnerská (API) zmluva | NIE | vlastník |
| 2 | DPA / rola eFaktura.sk (P10), lokalita a prenosy (P11), retencia a ukončenie (P12) | NIE | vlastník + CLIA |
| 3 | Produkčný API kľúč `efk_pk_live_…` (minimálne scope, P15) — zobrazí sa raz, iba do Vercel Production env `ESBLU_EFAKTURA_API_KEY` | NIE (nevytvárať pred 1–2) | vlastník |
| 4 | Organizácie: model API partner (nie white-label), `POST /organizations` idempotentne podľa IČO, live enroll **cesta B** (FS overovací kód zadá klient v Esblu), Esblu nie je sprostredkovateľ na PFS | kód hotový, sandbox E2E | — |
| 5 | Webhook URL `https://www.esblu.com/api/einvoice/webhook` (partner webhook v portáli, session login) | NIE | vlastník |
| 6 | Webhook signing secret → `ESBLU_EFAKTURA_WEBHOOK_SECRETS` (Production; čiarkou pri rotácii) | NIE | vlastník |
| 7 | Odbery udalostí: outbound stav/doručenie, prijatý dokument, participant (enroll/mandát) — podľa portálu; feed `/v1/agent/events` ako fallback | overiť v portáli | vlastník |
| 8 | Rotácia: nový secret pridať ako druhú hodnotu → overiť príjem → odstrániť starý. API kľúč: nový kľúč do env → redeploy → revoke starého v portáli | postup pripravený | vlastník |
| 9 | Deaktivácia / rollback: `ESBLU_EINVOICE_PROVIDER` odstrániť → všetko `configured:false`; firmy `einvoice_rollout` → `paused`; per firma `POST /organizations/{id}/peppol/deactivate`; prijaté doklady ostávajú dostupné cez API | postup pripravený | vlastník/operátor |
| 10 | Live poistky v kóde: `ESBLU_EINVOICE_ENVIRONMENT=live` + `ESBLU_EINVOICE_LIVE_ENABLED=true` + `VERCEL_ENV=production` + `einvoice_rollout` + `einvoice_organizations` (environment) | hotové | — |
| 11 | Poplatky (podľa dokumentácie poskytovateľa zo 2. 10. 2026 — pred podpisom znovu overiť): sandbox zdarma; partner promo do 30. 11. 2026; od 1. 12. 2026 cenník za transakciu, minimum €10 bez DPH mesačne; mesačný program ×1,20. **Poplatok sa viaže na aktiváciu produkčného účtu** — rozhodnutie vlastníka | NIE | vlastník |
| 12 | Otvorené otázky P1 (TTL `Idempotency-Key`), P2 (súbežný replay), P4 (je `ERROR` terminálne?) | bez odpovede | eFaktura.sk |

---

## 7. LEGAL / CLIA delta matrix (interné — nič sa neposiela)

CLIA dostala 4. 10. 2026 konsolidovaný balík (`docs/clia-delta-annexes-2026-10-04.md` vo vetve `main`),
Príloha 6 = eFaktúra (iba test), Príloha 7 = uchovávanie/mazanie/export.

| Oblasť | V balíku 4. 10. | Zmena odvtedy | Klasifikácia |
| --- | --- | --- | --- |
| Model eFaktura.sk (API zmluva, klient volí PDS na PFS, overovací kód v Esblu) | áno | bez zmeny | — |
| Rozsah údajov pri odoslaní (UBL EN 16931) | áno | pribudli druhy dokladov: faktúra k prijatej platbe (386), konečná faktúra s odkazmi na zálohy (BG-3), dobropis/ťarchopis s odkazom na pôvodnú faktúru | **materiálne (rozsah toku) → oznámiť ako delta** |
| Príjem | „koncept na kontrolu, auto-založenie dodávateľa“ | príjem opráv, záloh a konečných faktúr s automatickým **návrhom** väzby (vždy kontrola človekom, žiadne automatické právne rozhodnutie o DPH) | **materiálne (automatizované spracovanie / väzby) → oznámiť** |
| Úhrady a saldo | nie | ručná evidencia úhrad, vrátení, preplatkov; saldo skupiny dokladov; doručenie ≠ úhrada | technický detail (žiadny nový príjemca/kategória) — stačí zmienka v delte |
| Kurzy ECB (§ 26) | nie | server sťahuje verejné kurzy ECB (bez osobných údajov) | technický detail — nový zdroj verejných dát, bez osobných údajov |
| § 73 lehota, compliance polia faktúry | nie | kontrola polí a lehôt pri finalizácii | technický detail |
| Export pre účtovníka | áno (balík) | export za obdobie: pôvodné XML, PDF, väzby opráv/záloh, úhrady, audit | **uchovávanie/export → zmieniť v delte** |
| Zrušenie firmy | „Samoobslužné, maže údaje aj súbory“ | firma s finalizovanými faktúrami alebo e-faktúrami sa **samoobslužne nezruší** (odmietnutie pred mazaním; predtým zlyhalo až po zmazaní súborov) | **materiálne (mazanie) → oznámiť** |
| Retencia eFaktúra (Esblu aj poskytovateľ) | otvorená otázka | bez zmeny; doklady sa nemažú | ostáva LEGAL/CLIA REVIEW |
| Rola eFaktura.sk, DPA, lokalita, subdodávatelia | otázky položené | bez odpovede poskytovateľa (P10–P12) | ostáva otvorené; pred spustením podľa Prílohy 8 bod 5 |
| Webhook/feed technické údaje, monitoring | čiastočne | maintenance alert stav (iba kódy) | technický detail bez právneho update |

---

## 8. Retention / account closure — technický stav

| Oblasť | Stav |
| --- | --- |
| Export pred ukončením | `/api/accounting-handoff/package` (finance.manage, user JWT, explicitná firma): finalizované doklady za obdobie, `metadata.json`, súhrnné CSV (doklady + saldo, úhrady, partneri, DPH, opravy, odpočty záloh vydané aj prijaté, audit). |
| Pôvodné UBL/XML | v balíku (SHA-256 overený pred zabalením) pre finalizované doklady; jednotlivo aj cez `/api/einvoice/inbound/{id}/xml` a `/api/einvoice/outbound/{id}/ubl`. **Medzera:** prijaté XML bez konceptu (manuálne spracovanie, napr. `UNSUPPORTED_PROFILE`) nie sú v hromadnom balíku — iba jednotlivé stiahnutie. |
| PDF / render | v balíku pre každý doklad (generované); právne je dokladom XML (otázka pre účtovníčku). |
| Väzby opráv | `corrections.csv`, `corrects_invoice_number` v metadata. |
| Úhrady / zálohy | `payments.csv` (payment/refund), `advance-deductions.csv`, `received-advance-links.csv`. |
| Dôkaz doručenia | `metadata.json` → `einvoice.delivery_evidence` (vydané), `received_at/acknowledged_at` (prijaté). |
| Audit | `audit-events.csv` (`invoice_events`); transportné `einvoice_events` nie sú v balíku (technický audit, iba ops). |
| Zrušenie firmy (nález) | Pred auditom: route zmazala súbory v Storage (doklady, prílohy, logá) **a potom** DB krok zlyhal na finalizovaných faktúrach (`ESBLU_INVOICE_FINALIZED_NO_DELETE`) → nevratné čiastočné zmazanie podkladov. Platilo už v produkcii (fakturácia). **Opravené (`4947ba1`):** kontrola finalizovaných faktúr a e-faktúr pred akýmkoľvek mazaním → 409 s výzvou na export a kontakt podpory; regresný test. XML v `einvoice-documents` sa pri zrušení nemaže nikdy. |
| Doba uchovávania, zmluvné záväzky Esblu, postup zrušenia firmy s dokladmi | **LEGAL/CLIA REVIEW** (nevymýšľa sa) |

---

## 9. Bank / payment status

- `payment_status` mení iba ručná evidencia (`esblu_add_invoice_payment`, `…_refund`, `…_remove_invoice_payment`)
  a prepočet skupiny pri finalizácii opravy/konečnej faktúry. Žiadna eFaktúra funkcia, trigger, webhook,
  feed ani cron ho nemení — overené: DB (zdroj všetkých `esblu_einvoice_*`/`esblu_received_advance_*`
  funkcií) aj kód (`lib/einvoice`, `app/api/einvoice`, eFaktúra crony). Regresné testy v `test:invoicing-flow`.
- Stav doručenia (`einvoice_outbound.state`) a stav úhrady sú oddelené polia aj odznaky v UI.
- Úhrady: čiastočná, úplná, preplatok, vrátenie (`overpaid`, `refund`) — testy aj staging E2E.
- Úprava textu: „Odberateľ e-faktúru prijal“ (dalo sa čítať ako schválenie) → „E-faktúra bola doručená
  odberateľovi. Doručenie neznamená úhradu — platbu evidujte samostatne.“ (sk/en/de).
- Bankové napojenie neexistuje; nikde sa netvrdí automatické párovanie platieb.

---

## 10. Production rollout plan (NESPÚŠŤAŤ bez súhlasu)

`[SÚHLAS]` = vyžaduje výslovný súhlas vlastníka.

**R-0 PRECHECK**
1. Zmluva + DPA eFaktura.sk, CLIA delta odoslaná a odpoveď, potvrdenie účtovníčky `[SÚHLAS]`.
2. Overiť Vercel plán (crony < 1 deň) a pripraviť alert kanál.
3. Zlúčiť `main` → `einvoice-port` (konflikt `package.json`), plný test suite, Preview READY.
4. Runbook P-0…P-4 na produkčnej DB (read-only + backup) `[SÚHLAS]`.

**R-1 Migrácie** — runbook M-1, M-2 `[SÚHLAS]`.

**R-2 Aplikácia** — PR `einvoice-port` → `main`, merge, produkčný deploy podľa SHA, smoke test
https://www.esblu.com (prihlásenie, faktúra EUR koncept/finalizácia, saldo) `[SÚHLAS]`.
Okno medzi R-1 a R-2 minimalizovať (nové finalizačné pravidlá platia od R-1).
Crony sa aktivujú týmto deployom; eFaktúra crony zostávajú no-op.

**R-3 FX** — M-3 (manuálny import), potom kontrola nasledujúceho cron behu.

**R-4 Env / secrets (Production)** `[SÚHLAS]` — `ESBLU_EINVOICE_PROVIDER=efaktura_sk`,
`ESBLU_EINVOICE_ENVIRONMENT=live`, `ESBLU_EFAKTURA_API_KEY` (live), `ESBLU_EFAKTURA_WEBHOOK_SECRETS`,
`ESBLU_EINVOICE_LIVE_ENABLED=true`; `CRON_SECRET` už existuje. Redeploy. Žiadna hodnota do repa/logov.

**R-5 Provider webhook** `[SÚHLAS]` — registrácia `https://www.esblu.com/api/einvoice/webhook` v portáli,
test doručenie (podpis, 2xx), kontrola `einvoice_webhook_events`.

**R-6 Controlled enrollment** `[SÚHLAS]` — iba interná firma Esblu: PFS voľba PDS → overovací kód v Esblu
→ `einvoice_rollout.stage = internal`. Jedna odoslaná a jedna prijatá e-faktúra s reálnym partnerom
(dohodnutým). Potom pilot (vybraní zákazníci, `stage = pilot`), až potom širšie.

**R-7 Smoke testy (live, interná firma)** — odoslanie → `delivered` + dôkaz; príjem → koncept + ACK;
duplicitná udalosť → `DUPLICATE`; feed cron posúva kurzor; maintenance 200; export balíka s XML;
cudzia firma nevidí nič; úhrada sa nemení doručením.

**R-8 Monitoring** — denná kontrola maintenance (prvé 2 týždne), alert na 5xx cronov, `EVENT_FEED_STALE`,
`OUTBOUND_REJECT_RATE_HIGH`, `EVENTS_EXHAUSTED`, `WEBHOOK_SIGNATURE_FAILURES`.

**R-9 Rollback kritériá** — okamžite `ESBLU_EINVOICE_PROVIDER` odstrániť (+ rollout `paused`) pri:
akomkoľvek dvojitom odoslaní; doklade doručenom nesprávnemu príjemcovi; úniku medzi firmami;
podpisových zlyhaniach mimo rotácie; reject rate ≥ 20 % pri ≥ 3 dokladoch; neistom stave
(`retry_exhausted_unknown`) bez vysvetlenia do 24 h. Regresia fakturácie po R-1/R-2 → sekcia 4 Rollback.
