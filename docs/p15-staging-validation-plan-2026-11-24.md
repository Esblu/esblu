# P1-5 — príprava stagingovej validácie 20261127100000 + 20261128100000 (2026-11-24)

Staging `esblu-test` (cjbdijbbcujvmrzezusd). Doteraz iba čítanie (SELECT cez MCP) a offline testy. Žiadna migrácia,
žiadny zápis, výmaz, push ani merge.

## 1. Read-only precheck stagingu (2026-11-24)

| Kontrola | Výsledok |
| --- | --- |
| nedokončené cleanup joby s cieľmi billing/einvoice | **0** |
| ukončenia v stave executing | **0** |
| objekty einvoice-documents bez existujúcej firmy | **0** |
| ukončenia celkom | 1 (historické, `termination_mode` NULL) |
| behy exportu | 4 (všetky bez väzby súborov → po migrácii nestačia na ukončenie, správne) |
| doklady RECIPIENT_MISMATCH | 0 |
| nedokončené cleanup joby | 0 |
| Storage | einvoice-documents 63 obj. (247 kB), billing-documents 3, ai-inbox-documents 1 |
| DB | 27 MB; existuje záloha `esblu_backup_p14_20261123` |

**Závislosti:** staging má 20261121 (esblu_retention), 20261122\* (mandáty, deregistrácie, ops alerty), 20261123\*,
**20261124100000_billing_document_company_link** (nie je v tejto vetve) a 20261125; **nemá 20261126** (nie je
potrebná). Všetky objekty, na ktoré 20261127/20261128 nadväzujú, existujú (export RPC, `esblu_account_deletion_commit`,
mandáty, deregistrácie, zdrojové tabuľky súborov); nové objekty zatiaľ neexistujú.
**esblu_retention:** retention_periods 5, archived_companies 0, archived_records 0, access_log 0, purge_runs 0 —
prázdny archív, migrácie ho nemenia.
**Offline replay presne v zložení stagingu** (s 20261121 a 20261124, bez 20261126): p15 54/54, ukončenie 23/23,
billing-ops 24/24, mandáty 34/34.
**Timeout:** `authenticator` má `statement_timeout = 8s` (platí aj pre service_role cez API) — limit pre výmaz.

## 2. Testovacie údaje — žiadna existujúca firma nie je určená na výmaz

16 firiem, 24 účtov (example.com 10, esblu-qa.invalid 7, example.invalid 6, **gmail.com 1**). Podľa názvu sa
nerozhoduje; žiadnu existujúcu firmu nepovažujem za bezpečnú na výmaz:

| Firmy | Dôvod vylúčenia |
| --- | --- |
| Anchar Bau (STAGING), QA UX Firma A, QA UX Firma B | vlastník je skutočný účet (gmail.com) |
| E2E Partner A–D, L3 Tatra Servis | registrované v sandboxe eFaktura.sk; A/B nesú dôkazy P14 (7 QA faktúr, 29 dokladov) — výmaz by spustil deregistráciu u poskytovateľa |
| QA-STRIPE D | 8 účtovných dokladov Stripe (billing-documents) |
| ostatné QA-\*, E2E Čitateľný Export, Moja firma, L3 Iná firma | slúžia iným testovacím sadám; ich účel ani pôvod nie je jednoznačne overený |

**Návrh:** nové, výhradne syntetické firmy vytvorené pre P1-5, identifikované **zaznamenanými UUID** (nie názvom),
účty `@esblu-qa.invalid` bez hesla na prihlásenie z UI:

| Firma | Účel | Výmaz |
| --- | --- | --- |
| QA-P15-T1 | hlavný výmaz: XML, UBL, karanténa, R3, osirelý súbor, dokument, vozidlo, mandát | áno |
| QA-P15-T2 | neúspešný výmaz a opakovanie (dočasne nezmazateľný objekt), retry, vyčerpanie pokusov | áno |
| QA-P15-ISO | kontrola izolácie (súbory, doklady); nikdy sa nemaže | nie |
| QA-P15-PERF | výkon odtlačku a exportu (~25 000 faktúr, ~150 000 riadkov, ~300 súborov) | áno (na konci) |

## 3. Plán zálohy

| Krok | Obsah | Typ |
| --- | --- | --- |
| W1 | `scripts/sql/p15-staging-backup.sql`: schéma `esblu_backup_p15_20261124` (rovnaký mechanizmus ako P14) — firmy, členstvá, ukončenia, behy exportu, cleanup joby, faktúry + položky + udalosti + denník, dokumenty, e-faktúry (inbound/outbound/events/mandáty/deregistrácie/organizácie), billing dokumenty, metadáta `storage.objects`, definície nahrádzaných funkcií | **zápis (nová schéma)** |
| W1-check | tabuľka `completeness` (počty záloha = živé), `select … where not ok` = 0 riadkov | čítanie |
| R0 | `scripts/sql/p15-staging-isolation-snapshot.sql` — snímka všetkých existujúcich firiem a billing-documents. **Baseline 2026-11-24:** 16 firiem, 77 faktúr, 36 prijatých, 288 udalostí, 63 objektov, md5 `b3917b95420abdbd3b4ad50cbbece2a2` | čítanie |
| O1 (voliteľné) | bajty 67 existujúcich objektov stiahnuť lokálne (vlastník, kľúč iba v prostredí, mimo repozitára) + SHA-256 manifest | čítanie stagingu, zápis lokálne |

**Obnova:** migrácie → rollback SQL 20261128 → 20261127 (offline overené aj s esblu_retention); dáta existujúcich firiem
sa nemenia (overí R0 pred/po) — pri odchýlke `insert … from esblu_backup_p15_20261124.* on conflict do nothing`.
Platformové zálohy Supabase (plán, PITR) **nie sú overené** — nespoliehať sa na ne.

## 4. Plán aplikovania a testov na skutočnom stagingu

Vykonávanie: DB kroky cez MCP (SQL); kroky so Storage cez lokálny runner (`run-p15-staging.ps1`, vzor P14 —
service role kľúč iba v prostredí procesu, nikdy v chate, repozitári ani na disku). Aplikácia (route) sa na
stagingu netestuje bez Preview deploya (vyžaduje push → mimo rozsahu; voliteľne neskôr).

| # | Krok | Typ |
| --- | --- | --- |
| R0 | precheck + snímka izolácie | čítanie |
| W1 | cielená záloha + kontrola úplnosti | **zápis** |
| W2 | aplikovať **20261127100000** a hneď **20261128100000** (MCP apply_migration) + overenie objektov, grantov, triggerov | **zápis schémy** |
| R1 | snímka izolácie = baseline | čítanie |
| W3 | vytvoriť syntetické účty (Auth admin) a firmy T1, T2, ISO, PERF; seed údajov (SQL) a súborov (runner upload: XML so známym SHA-256, UBL, karanténa, R3 XML, osirelý XML, PDF dokument) | **zápis** |
| T1 | export T1 cez RPC (begin s p_files, dávky so SHA-256 stiahnutých bajtov) → completed; negatívne: zlý SHA XML/UBL (FILES_CORRUPT), chýbajúci súbor, zmena objektu počas exportu, zmena údajov (DATA_CHANGED) | **zápis (behy exportu)** |
| T2 | po exporte: doplnené vozidlo, výmena súboru na rovnakej ceste, nový súbor → preflight STALE; nový export | **zápis (syntetické)** |
| T3 | deregistrácia v DB bez volania poskytovateľa (fiktívne `provider_org_id` T1): request → retry → lease timeout → completed; preflight bez nového exportu = null; operátorská/užívateľská zmena mandátu = STALE (v transakcii s rollbackom) | **zápis (syntetické)** |
| T4 | potvrdenie oprávnenej osoby (chýba/staré), staré prihlásenie, waived, cross-company (ISO owner), klientske roly | čítanie (všetko zlyhá pred zápisom) |
| **D1** | **výmaz T1** (`esblu_company_termination_execute`) → ciele: XML, UBL, karanténa, R3, osirelý, PDF; incident R3; `storage_purged_at` NULL | **nenávratný výmaz** |
| **D2** | runner: výmaz cieľov + `exists()` + `esblu_cleanup_job_confirm_storage` → `storage_purged_at`; overiť neprítomnosť každého objektu cez Storage API aj `storage.objects` | **nenávratný výmaz súborov** |
| **D3** | T2: výmaz firmy; runner zámerne zmaže iba časť → confirm = pending so zvyškom; ručné „hotovo“ odmietnuté; opakovanie dočistí; simulácia vyčerpania pokusov (attempts) → `esblu_cleanup_health` + alert cronu (lokálne volanie handlera nie je možné bez deploya → overiť health RPC) | **nenávratný výmaz** |
| R2 | snímka izolácie = baseline (ISO a všetky existujúce firmy, billing-documents nezmenené) | čítanie |
| P1 | QA-P15-PERF: zmerať `esblu_company_export_fingerprint`, `file_list`, `storage_fingerprint`, preflight a export (dátová časť + dávky) — EXPLAIN ANALYZE, 3 opakovania | **zápis (seed)** + čítanie |
| **D4** | výmaz PERF (zmerať čas `execute` voči limitu 8 s) | **nenávratný výmaz** |
| W5 | upratanie: syntetické účty T1/T2/PERF (ISO a záloha ostanú do schválenia) | **zápis / výmaz** |
| ROLL (iba pri zlyhaní) | rollback 20261128 → 20261127 | **zápis schémy** |

**Kritériá úspechu:** všetky očakávané kódy; žiadny objekt T1/T2 v Storage ani `storage.objects`; incident R3 bez
obsahu; R2 = R0 pre všetky firmy mimo P15; billing-documents nezmenené; výmaz PERF < 8 s.

## 5. Výkon (offline PGlite, horná hranica)

| Syntetická firma | Riadky | Odtlačok | Zoznam súborov | Odtlačok Storage |
| --- | --- | --- | --- | --- |
| 5 000 faktúr | 31 500 | 0,8 s | 9 ms (1 500 súb.) | 15 ms |
| 25 000 faktúr | 157 500 | 3,5 s | 32 ms (7 500 súb.) | 62 ms |

Odtlačok je lineárny (~22 µs/riadok v PGlite). Výmaz počíta odtlačok raz (brána) → pri ~150 tis. riadkoch sa
blíži limitu 8 s v PGlite; skutočný Postgres je rýchlejší — **P1 to musí potvrdiť**. Ak nie: zvýšiť
`statement_timeout` pre volanie výmazu (samostatné schválenie) alebo odtlačok po tabuľkách vopred.
Skript: `scripts/p15-fingerprint-perf-pglite.ts` (`N=25000`).

## 6. GO / NO-GO

**GO pre stagingovú validáciu**, za podmienok: schválenie krokov nižšie; iba nové syntetické firmy; R0/R2 izolácia.
NO-GO by bol: existujúca firma ako cieľ výmazu, chýbajúca záloha W1, nesúlad R2 ≠ R0, výmaz PERF > 8 s bez riešenia.

## 7. Rozsah potrebného schválenia

| Skupina | Kroky | Charakter |
| --- | --- | --- |
| A | W1 záloha (nová schéma), O1 voliteľné | zápis bez zmeny existujúcich dát |
| B | W2 aplikovanie 20261127 + 20261128 (a ROLL pri zlyhaní) | zmena schémy stagingu |
| C | W3 syntetické účty, firmy, súbory; T1–T3; P1 seed | zápis syntetických dát |
| **D** | **D1–D4 nenávratný výmaz syntetických firiem a ich súborov** | **deštruktívne** |
| E | W5 upratanie syntetických účtov | výmaz syntetických dát |
| mimo rozsahu | push / Preview deploy, volania eFaktura.sk (aj sandbox), Stripe, produkcia | samostatne |
