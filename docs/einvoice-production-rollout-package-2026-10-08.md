# eFaktúra — PRE-PRODUCTION PACKAGE (8. 10. 2026)

Jeden dokument pre deň spustenia. Nič z neho sa ešte nespustilo na produkcii. Produkčná DB (`assetpilot`,
`fkpgvgvsmbpieduoatrt`) sa v tejto fáze **nečítala ani nemenila**. `[SÚHLAS]` = krok vyžaduje výslovný súhlas vlastníka.

Súvisiace dokumenty:
- `scripts/sql/einvoice-prod-precheck.sql` + test `npm run test:einvoice-prod-precheck`;
- `docs/ops/einvoice-health-alert.github-workflow.yml` (neaktívne);
- `docs/efaktura-provider-conformance-2026-10-08.md` (poskytovateľ);
- `docs/einvoice-tax-accounting-open-items-2026-10-07.md` (sekcia „Opätovné overenie 8. 10. 2026“);
- `docs/einvoice-operations-runbook.md` (prevádzka po spustení).

---

## 1. Freeze / baseline

| | |
| --- | --- |
| Vetva | `einvoice-port` |
| **Funkčný baseline** | **`1b53193`** — „fix(einvoice): provider conformance — 409 in-progress retry, document_id correlation, SBDH ids“ |
| Po baseline | iba dokumentácia, precheck, jeho test a neaktívny workflow (tento balík) — žiadna zmena aplikačného kódu ani migrácií |
| Preview | READY pre `1b53193` |
| Migrácie (staging `esblu-test`) | všetkých 23 aplikovaných; md5 tiel zmenených funkcií = PGlite |

**Presný migration range (23 súborov, v tomto poradí):**

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
20261008100009_taxed_advance_deduction_lines
20261008100010_received_advance_match_safeupdate
20261008100011_einvoice_outbound_transport_ids
```

Predpoklad v produkcii: posledná aplikovaná je `20261005091000_private_media_buckets` (main). Časové pečiatky
`20261002…`–`20261005110000` sú staršie než produkčné `2026100509*`. Preto sa aplikuje **po súboroch** (Supabase MCP
`apply_migration`, názov = názov súboru bez `.sql`, rovnako ako staging). Pri `supabase db push` by bol nutný
`--include-all`, ten sa **nepoužíva**.

**Testy na baseline (8. 10. 2026), všetky zelené.**
- **eFaktúra / fakturácia:**
  - einvoice-db 44, ubl 66, efaktura 20, outbound 52, inbound 48, ops 23, ui 54;
  - l3-inbound-one 16, l3-launcher 25, e2e-selftest 27 + 1 PARTIAL, partner 23, partner-e2e 25;
  - hardening 19, reception 23, staging-guard 8;
  - invoicing-sk 33, invoicing-flow 55, handoff 122, i18n 114, plan-entitlements 47;
  - closed-beta-p0 36, p0-bank-sql 17;
  - **prod-precheck 6 (nový)**.
- **Ostatné moduly:**
  - voice 38, dates 62, items 109, state 43, register 23, money 41, lifecycle 30, pricemode 55, vat 29, gross 230;
  - format 45, folders 45, intent-permissions 44, voice-flow 17, voice-conversation 75, assistant-orchestrator 66;
  - master-control 34, continuous-voice 38, assistant-grammar 24, mobile-m0 24, mobile-m1 64, m1-authz-db 47;
  - push 28, push-db 31, company-lookup 57, company-lookup-db 13.
- **Poznámka k 6 hlasovým/mobilným testom:** vo Windows pracovnej kópii hlásia po 1 chybe. Sú to statické kontroly zdrojového textu a padajú na CRLF koncoch riadkov. V čistom LF checkoute toho istého commitu sú všetky zelené (75/66/34/38/24/64), takže nejde o chybu kódu.

---

## 2. Main compatibility (throwaway, nič nepushnuté)

Vykonané v dočasnom klone `/tmp`. `main` = `901c46c` (4. 10. 2026; `292f7e3` Google OAuth, `901c46c` storage media).

| Kontrola | Výsledok |
| --- | --- |
| Konflikty | **1:** `package.json`, iba sekcia `scripts`. Riešenie: zjednotenie oboch strán (eFaktúra testy + `test:google-oauth*`, `test:storage-media*`). |
| `package-lock.json` | `main` ho nemení. Lock z `einvoice-port` (next 16.3.8, eslint-config-next 16.3.8, @xmldom/xmldom 0.9.12) je konzistentný s `package.json` (0 rozdielov). |
| Typecheck (`tsc --noEmit`) | OK |
| `next build` (webpack, offline: mock Google Fonts, dummy env bez tajomstiev) | **OK**: kompilácia 59 s, TypeScript OK, 55/55 statických stránok |
| Testy na zlúčenom strome | OK: google-oauth 17, google-oauth-db 18, storage-media 10, storage-media-db 33 + všetky eFaktúra/fakturačné/auth/push sady (rovnaké čísla ako baseline) |
| ESLint `app lib` | 33 chýb, **všetky v súboroch mimo eFaktúry** (ai-evidencia, Dashboard, obchodni-partneri, sklad, vozidla). Na čistom `main` s rovnakými nástrojmi je ich tiež 33 — **nepribudli zlúčením**. Build ich neblokuje. |
| Poradie migrácií | `main` pridáva `20261005090000_media_storage_access_model` + `20261005091000_private_media_buckets` (v produkcii už aplikované). Prekryv objektov s reťazcom eFaktúry: **0** (36 vs. 228 objektov). |
| Storage | Politiky a fronta mazania z `main` sú obmedzené na 4 media buckety (`vehicle-photos`, `machine-photos`, `inventory-photos`, `company-logos`). `einvoice-documents` je privátny, bez klientskych politík (iba service_role). Cleanup skript ho nepozná. **Bez interakcie.** |
| `main` upravil už existujúcu migráciu `20260927120000` (OAuth beta gate) | Testy, ktoré ju čítajú (closed-beta-p0, google-oauth-db, master-control), sú na zlúčenom strome zelené. |

**Postup v deň merge `[SÚHLAS]`:**
1. Zlúčiť `main` do `einvoice-port` (konflikt `package.json` vyriešiť ako vyššie).
2. Počkať na Preview READY a plný test suite.
3. PR `einvoice-port` → `main`.

---

## 3. Production precheck (READ ONLY)

`scripts/sql/einvoice-prod-precheck.sql`:
- `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`;
- žiadne DML/DDL (overuje test);
- výstup iba počty a stav STOP / WARN / INFO / OK, bez osobných údajov;
- **36 kontrol.**

| Oblasť | Kontroly |
| --- | --- |
| Stav migrácií | 1 posledná verzia = `20261005091000`, eFaktúra 0 |
| Objekty, ktoré už nesmú existovať | 2 einvoice/fx tabuľky; 3 nové stĺpce (vrátane 100009/100011); 26 všetkých 15 nových tabuliek; 27 všetkých 91 nových funkcií; 28 triggre (DROP IF EXISTS → WARN) |
| Signatúry / závislosti / RLS | 4 signatúry 9 nahrádzaných funkcií; 29 požadované tabuľky, stĺpce a funkcie (auth.uid, storage.buckets, entitlement funkcie); 30 RLS na fakturačných tabuľkách; 5 kotva CHECK `invoice_events` |
| Faktúry / DPH | 6–7 kategórie DPH; 14 hlavička vs. rozpis DPH; 15 riadky vs. hlavička |
| Druh, opravy, úhrady | 8 `kind`; 9 `payment_status`; 10–11 väzby opráv; 20 proforma iba vydaná; 21 úhrady na dobropisoch |
| Číslovanie | 12 duplicitné čísla; 13 počítadlo za použitým číslom; 31 kolízia novej série PF; 32 prefixy sérií; 33 finalizované proformy |
| Meny | 16 formát meny; 17 koncepty v cudzej mene (ECB import); 18 finalizované v cudzej mene |
| Zálohy / prijaté | 24–25 záporné ceny a pôvodný CHECK `unit_price`; 36 koncepty so zápornou cenou; 34 prijaté faktúry (prehľad); 35 faktúry k prijatej platbe |
| Ostatné | 19 vydané koncepty; 22 bucket; 23 počty |

**Overenie (iba test DB):**
- **PGlite simulácia produkcie** (kostra + migrácie pred reťazcom + `schema_migrations` s `20261005091000`): všetkých 36 kontrol OK/INFO. Negatívny prípad (séria PF) → STOP. Po aplikovaní reťazca skript beží ďalej a hlási STOP pre migrácie a nové objekty.
- **Staging (read-only):** dátové kontroly nad reálnymi dátami (DPH, číslovanie, meny, opravy, záporné ceny, PF, RLS, prijaté) = 0 nálezov.

**Spustenie v produkcii `[SÚHLAS]`:** vlastník (alebo Claude na jeho výslovný pokyn) spustí celý súbor v SQL editore /
cez read-only spojenie. **Akékoľvek STOP = migrácie sa nespúšťajú.** Detailné dotazy sú v časti B súboru.

---

## 4. Backup / restore runbook (produkčný Supabase)

**Fakty (read-only zistenie 7. 10.):**
- projekt `assetpilot`, eu-central-1, Postgres 17.6, plán **Pro**;
- denné automatické zálohy, dostupných 7 dní;
- PITR je platený doplnok; či je zapnutý, overí vlastník v Dashboarde.

| Krok | Akcia | Očakávaný výsledok | STOP |
| --- | --- | --- | --- |
| B-1 | Dashboard → Project `assetpilot` → Database → **Backups**: zapísať čas poslednej dennej zálohy a stav PITR | záloha < 24 h, stav „Completed“ | záloha chýba alebo je staršia ako 24 h |
| B-2 `[SÚHLAS]` | **Logický dump tesne pred oknom**, z počítača vlastníka (nie z repa, nie z CI): `supabase db dump --linked -f prod-schema-YYYYMMDD.sql` · `supabase db dump --linked --data-only -f prod-data-YYYYMMDD.sql` · `supabase db dump --linked --role-only -f prod-roles-YYYYMMDD.sql`. Alternatíva: `pg_dump "$PROD_DB_URL" --format=custom --no-owner --no-privileges -f prod-YYYYMMDD.dump` (connection string iba z Dashboardu, nikdy do repa/chatu). | 3 súbory (resp. 1 `.dump`) bez chyby; veľkosť zapísať | chyba dumpu |
| B-3 | Overiť dump: `pg_restore --list prod-YYYYMMDD.dump \| grep -c "TABLE DATA"` (resp. `grep -c "^COPY" prod-data-*.sql`) a `sha256sum` súborov | počet tabuliek zodpovedá, hash zapísaný | 0 tabuliek / chyba |
| B-4 | Uložiť dumpy šifrovane mimo repa (napr. šifrovaný disk vlastníka); zmazať po 30 dňoch | — | — |

**Čo dump obsahuje / neobsahuje:**
- **Obsahuje:**
  - schému `public` (tabuľky, funkcie, triggre, politiky, granty v schema dumpe);
  - dáta `public`;
  - pri `supabase db dump` aj `auth` dáta (iba ak sa zvolí `--schema auth`, odporúčam samostatný súbor);
  - metadáta `storage.objects` (záznamy, nie súbory);
  - `supabase_migrations.schema_migrations`.
- **Neobsahuje:**
  - **súbory v Storage** (fotky, logá, dokumenty, `einvoice-documents`);
  - tajomstvá a nastavenia projektu (API kľúče, Auth providery, SMTP);
  - Edge Functions;
  - Vercel env;
  - interné schémy Supabase spravované platformou.

**Storage obmedzenie:** Storage nie je v dennej zálohe DB ani v dumpe. Reťazec eFaktúry storage súbory **nemaže ani nemení**.
- Iba vytvorí prázdny bucket `einvoice-documents`.
- Media buckety (`main`) sa reťazcom nemenia, preto pre migráciu netreba storage zálohu.
- Ak ju vlastník chce, potrebuje samostatný export cez Storage API alebo S3-kompatibilný prístup. Netýka sa eFaktúry.

**Restore postupy (od najmenšieho zásahu):**
1. **SQL rollback migrácií** (sekcia 5.R): bez straty dát, odporúčané pri zlyhaní v okne.
2. **Obnova jednotlivej tabuľky z logického dumpu:** `pg_restore -t <tabuľka> --data-only` do dočasnej schémy a ručný `INSERT … SELECT` iba chýbajúcich riadkov. Iba pri lokálnej strate dát; rozhoduje vlastník.
3. **Restore celého projektu z dennej zálohy / PITR** (Dashboard → Backups → Restore) `[SÚHLAS]`:
   - projekt je počas obnovy nedostupný;
   - stratia sa všetky zmeny po čase zálohy, vrátane faktúr vystavených medzi zálohou a obnovou;
   - po obnove znovu nasadiť zodpovedajúci Vercel deployment.
   Posledná možnosť.

**Čo sa dá vrátiť SQL migráciou a čo vyžaduje restore:**

| Situácia | Riešenie |
| --- | --- |
| Migrácia N zlyhá v okne | Migrácia beží v transakcii, N sa nezapíše. Predchádzajúce sú aditívne → forward-fix alebo rollback súbory v opačnom poradí. **Restore netreba.** |
| Treba vrátiť celý reťazec pred prvou e-faktúrou | Rollback súbory `supabase/rollback/2026100…` v opačnom poradí (12 súborov), pre migrácie bez súboru postup v hlavičke migrácie (8). `100001`/`100002`/`100006` → spustiť predchádzajúcu definíciu funkcie (pri `100002` uložená v P-2). Bez straty dát. |
| Po spustení už existujú finalizované doklady s novými poliami / riadkami odpočtu | Rollback `100009` a `100005` je bezpečný iba bez finalizovaných dokladov, ktoré nové polia používajú (podmienky sú v hlavičkách rollback súborov). Inak **iba forward-fix**. Finalizované doklady sú nemenné a mazať ich nemožno. |
| Poškodenie alebo strata existujúcich dát (neočakávané — reťazec produkčné dáta nemení) | Restore (bod 2 alebo 3) |

---

## 5. Migration runbook (deň spustenia)

Okno mimo pracovného času, bez paralelného deployu, jeden operátor + vlastník. Každý krok: **akcia → očakávaný
výsledok → STOP podmienka → rollback**.

| # | Krok | Akcia | Očakávaný výsledok | STOP | Rollback |
| --- | --- | --- | --- | --- | --- |
| R-0 | Brány | CLIA stanovisko, podpis zmluvy + DPA s eFaktura.sk, rozhodnutie o 386/388 (sekcia 8), súhlas s oknom `[SÚHLAS]` | všetko písomne | ktorákoľvek chýba | — |
| R-1 | **PRECHECK** | `scripts/sql/einvoice-prod-precheck.sql` celý (read-only) `[SÚHLAS]` | iba OK / INFO (WARN vysvetlený a zapísaný) | akékoľvek STOP | — (nič sa nezmenilo) |
| R-2 | **Backup confirmation** | B-1 až B-3 | záloha < 24 h, dump overený, hash zapísaný | chýba záloha alebo dump | — |
| R-2a | Uložiť definície pre rollback | `select pg_get_functiondef('public.esblu_my_finance_manage()'::regprocedure), pg_get_functiondef('public.esblu_my_finance_view()'::regprocedure);` → súbor mimo repa | 2 definície | — | — |
| R-3 | **Migration range** `[SÚHLAS]` | 23 súborov zo sekcie 1, **po jednom**, v poradí, `apply_migration` (názov = súbor bez `.sql`) | každý `success` | prvá chyba → **zastaviť**, nepokračovať ďalším súborom | chybná migrácia sa nezapísala; forward-fix, alebo rollback už aplikovaných v opačnom poradí (sekcia 4) |
| R-4 | **Verification queries** (read-only) | (a) `select count(*) from supabase_migrations.schema_migrations where name like '20261002%' or name like '20261003%' or name like '20261005100000%' or name like '20261005110000%' or name like '20261006%' or name like '20261007%' or name like '20261008%'` = **23** · (b) md5 tiel funkcií voči PGlite referencii (postup ako staging: `select proname, md5(replace(prosrc, E'\r','')) …`) · (c) Security advisor: 0 nových ERROR, 0 definer funkcií pre `anon` · (d) `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and (relname like 'einvoice\_%' or relname like 'fx\_%' or relname in ('received_advance_links','invoice_advance_deductions')) and not relrowsecurity` = 0 riadkov · (e) `select stage, count(*) from public.einvoice_rollout group by 1` = prázdne · (f) precheck znova: STOP iba pre „už existuje“ (očakávané) | presne podľa stĺpca | md5 nesedí, RLS chýba, advisor ERROR | sekcia 4 (SQL rollback, bez dát) |
| R-5 | **Application deploy** `[SÚHLAS]` | merge PR `einvoice-port` → `main` (po sekcii 2), produkčný deploy podľa SHA, Vercel → Deployments → READY | Production = nový SHA; https://www.esblu.com prihlásenie, EUR koncept → finalizácia → PDF → saldo OK | 5xx, chyba finalizácie | Vercel „Instant Rollback“ na predchádzajúci deployment; DB ostáva (nové objekty bez provider env sú no-op) |
| R-6 | **ECB initial import** | `curl -H "Authorization: Bearer $CRON_SECRET" https://www.esblu.com/api/cron/fx-rates` (secret iba v termináli vlastníka) | `success:true`, `inserted > 0` (resp. `duplicate:true` pri opakovaní) | `ECB_FETCH_FAILED` / 5xx 2× za sebou | nič — finalizácia v cudzej mene čaká na kurzy (EUR nedotknuté) |
| R-7 | **Cron verification** | Vercel → Project → Cron Jobs: 7 jobov z `vercel.json` aktívnych; po 10 min logy `einvoice-outbound` (send/reconcile), `einvoice-events`, `einvoice-inbound` = 200 so `configured:false` (bez provider env), `einvoice-maintenance` = 200, `fx-rates` po 16:00 UTC = 200 | všetko 200 | 401 (CRON_SECRET), 5xx | crony bez provider env nič nerobia; pri chybe odstrániť cron z `vercel.json` hotfixom |
| R-8 | **Provider env** `[SÚHLAS]` | Vercel Production env: `ESBLU_EINVOICE_PROVIDER=efaktura_sk`, `ESBLU_EINVOICE_ENVIRONMENT=live`, `ESBLU_EFAKTURA_API_KEY` (live kľúč `efk_pk_live_…`), `ESBLU_EFAKTURA_WEBHOOK_SECRETS`, `ESBLU_EINVOICE_LIVE_ENABLED=true`; redeploy | crony `configured:true`; žiadna firma nemá rollout → nič sa neodosiela | kľúč nesedí s prostredím (`EINVOICE_KEY_ENVIRONMENT_MISMATCH`) | odstrániť `ESBLU_EINVOICE_PROVIDER` + redeploy |
| R-9 | **Webhook** `[SÚHLAS]` | portál eFaktura.sk: registrácia `https://www.esblu.com/api/einvoice/webhook` (udalosti peppol.document.*, participant.*); testovacie doručenie | `einvoice_webhook_events`: 1 riadok `processed`/`ignored`, 0 `rejected` (podpis) | `WEBHOOK_SIGNATURE_FAILURES`, 4xx/5xx | vypnúť endpoint v portáli; poll fallback (`einvoice-events` feed) beží ďalej |
| R-10 | **Internal company** `[SÚHLAS]` | interná firma Esblu: PFS → voľba PDS eFaktura.sk → overovací kód → Esblu `/faktury/efaktury` → zapnúť príjem; `update public.einvoice_rollout set stage = 'internal' where company_id = '<Esblu>'` (service_role, jediný riadok) | `einvoice_organizations`: participant `0245:<DIČ>` aktívny, `reception = active` | enroll chyba, iný participant | `stage = 'paused'` |
| R-11 | **Smoke tests** (live, interná firma, dohodnutý partner) | (1) odoslať 1 faktúru → `sent` → `delivered` + dôkaz + `document_id`, `sbdh_instance_identifier`; (2) prijať 1 faktúru → koncept + ACK; (3) duplicitná udalosť → `DUPLICATE`; (4) maintenance 200 bez alertov; (5) export balíka obsahuje XML; (6) iná firma nič nevidí; (7) doručenie nemení stav úhrady | všetko podľa očakávania | dvojité odoslanie, doručenie zlému príjemcovi, únik medzi firmami, `retry_exhausted_unknown` | `stage = 'paused'` + odstrániť provider env (R-8); incident podľa operations runbooku |
| R-12 | **Alerting** `[SÚHLAS]` | GitHub secret `ESBLU_CRON_SECRET` + skopírovať `docs/ops/einvoice-health-alert.github-workflow.yml` do `.github/workflows/` na `main`; `workflow_dispatch` | prvý beh zelený (oba joby) | beh červený bez vysvetlenia | zmazať workflow súbor |
| R-13 | **Pilot** `[SÚHLAS]` | po 5 pracovných dňoch bez incidentu: vybraní zákazníci `stage = 'pilot'` (po jednom); denná kontrola maintenance prvé 2 týždne | žiadny kritický alert | rollback kritériá nižšie | `stage = 'paused'` pre dotknutú firmu |

**Rollback kritériá (okamžite R-8 rollback + `paused`):**
- akékoľvek dvojité odoslanie;
- doklad doručený nesprávnemu príjemcovi;
- únik medzi firmami;
- podpisové zlyhania webhooku mimo rotácie;
- reject rate ≥ 20 % pri ≥ 3 dokladoch;
- `retry_exhausted_unknown` bez vysvetlenia do 24 h.

Regresia bežnej fakturácie po R-3/R-5 → R-5 rollback; DB podľa sekcie 4.

### 5.R SQL rollback poradie (iba ak treba vrátiť celý reťazec)

Postup:
1. Spúšťať v opačnom poradí 100011 → 100000.
2. Pre každú migráciu bez rollback súboru použiť postup z jej hlavičky.
3. `100010` → vrátiť spolu so `100009`.
4. `100002` → definície z R-2a.
5. Reťazec `20261002…`–`20261007…` (eFaktúra tabuľky) vrátiť **iba ak** `einvoice_outbound` / `einvoice_inbound` sú prázdne.

---

## 6. Alerting (neaktívne)

`docs/ops/einvoice-health-alert.github-workflow.yml`: GitHub Actions, iba existujúce interné endpointy, výstup
iba kódy a čísla, telo odpovede sa po vyhodnotení maže. Overené YAML parserom, jq logika na vzorových
odpovediach a statickým testom (neaktívne umiestnenie, secret iba odkazom).

| Podmienka | Zdroj |
| --- | --- |
| C1 maintenance critical | HTTP 503 `/api/cron/einvoice-maintenance` |
| C2 exhausted retries | `health.outbound.retry_exhausted_unknown > 0` |
| C3 outbound backlog | `outbound.stuck > 0` alebo najstarší > 30 min |
| C4 inbound backlog | `inbound.stuck > 0` alebo `ack_pending_too_long > 0` |
| C5 webhook / event failures | `webhook.failures_24h + unprocessed_older_15m`, `signature_failures_1h`, `EVENTS_EXHAUSTED` / `EVENT_FEED_STALE` / `EVENT_FEED_ERROR` |
| C6 ECB import stale | denný (po–pi 16:45 UTC) idempotentný beh `/api/cron/fx-rates` ≠ `success:true` |
| C7 route nedostupná | iné ako 200/503 |

Vercel: Cron Jobs zobrazuje zlyhané behy bez notifikácie. Vercel Alerts vyžadujú platený Observability Plus
(neodporúča sa). Žiadny produkčný secret sa nepridal.

---

## 7. Poskytovateľ (eFaktura.sk) — CLOSED

Technické otázky sú uzavreté (odpoveď 8. 10. 2026). Implementácia je overená a zhoduje sa
(`docs/efaktura-provider-conformance-2026-10-08.md`):

| Pravidlo poskytovateľa | Stav |
| --- | --- |
| Ten istý Idempotency-Key + to isté telo = replay | áno |
| 409 „práve sa spracúva“ = odložený retry | áno |
| Kľúč platí 24 h (všetky auto-retry < 2 h) | áno |
| Trvalá SHA-256 deduplikácia + blok rovnakého čísla a typu | Esblu na ňu nespolieha (druhá vrstva) |
| `document_id` → `/submissions/{document_id}` → `invoice_id` → `/sent/{invoice_id}/evidence` | áno |
| Webhook `messageId` / `transactionId` (SBDH) uložené | áno |

Zmluva: DPA podľa čl. 28 GDPR je **Príloha č. 2** API zmluvy. Informácie o lokalite a retencii platia aj pre API model.
Právne posúdenie zmluvy a DPA ostáva na CLIA; nie je to schválené.

Overiť pri R-11: tvar odpovede `/submissions/{document_id}` (nie je vo verejnej OpenAPI) a presné telo 409
„práve sa spracúva“. Obe cesty sú fail-closed.

---

## 8. Nález 8. 10. 2026: kód typu faktúry k prijatej platbe (386 vs. 388)

**FAQ FS k eFaktúre, technický príklad 22 (str. 42):** pre „Daňový doklad k prijatej platbe“ sa použije
**UNCL1001 kód 388 – Tax invoice**.

Esblu dnes:
- **odosiela 386** („Prepayment invoice“; Peppol BIS ho povoľuje, sandbox ho doručil);
- pri príjme rozpoznáva faktúru k prijatej platbe **iba podľa 386**;
- prijatú 388 považuje za bežnú faktúru, takže konečná faktúra so zdanenou zálohou od takého dodávateľa ide do **review** (bezpečné, ale bez automatického rozpoznania zálohy).

Toto je **jediný nový CODE bod**. V tomto balíku sa **neopravoval** (freeze, bez vývoja). Možnosti na rozhodnutie
`[SÚHLAS]`:
1. **Pred spustením:**
   - odosielať 388 pre `payment_received_invoice`;
   - pri príjme akceptovať 386 aj 388 ako kandidáta na zálohu. 388 je všeobecný daňový doklad, preto rozpoznanie zálohy iba cez review (bez automatického zaúčtovania).
   - Malá zmena + testy + sandbox E2E.
2. **Spustiť bez zálohových e-faktúr:** odoslanie `payment_received_invoice` ako e-faktúry zablokovať (fail-closed) do opravy. Bežné faktúry, dobropisy a ťarchopisy idú ďalej.

Odporúčanie: možnosť 1 pred pilotom (R-13), najneskôr pred 1. 1. 2027.
