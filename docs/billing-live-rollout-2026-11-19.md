# Stripe LIVE — bezpečný produkčný rollout a rollback (S15, 2026-11-19)

Stav: **pripravené v kóde a na stagingu, NIČ nie je zapnuté.** Produkcia: billing vypnutý (`web_provider='none'`,
žiadne `STRIPE_*` premenné, migrácie od `20261118120000` neaplikované). Každý krok nižšie označený ⛔ vyžaduje výslovný
súhlas vlastníka. Live kľúče a webhook secret zadáva **iba vlastník** priamo do Vercel UI (nikdy do chatu, repa ani DB).

## 1. Čo S15 zabezpečuje (audit → implementácia)

| Vrstva | Pred S15 | Po S15 |
|---|---|---|
| Režim servera (`lib/billing/config.ts`) | produkcia vždy `off`, existoval iba `stripe_test` | `stripe_live` **iba** pri `VERCEL_ENV=production` + `ESBLU_BILLING_MODE=stripe_live` + `ESBLU_BILLING_LIVE_APPROVED=true` (presne). Produkcia so `stripe_test` / `fake` / bez schválenia → `off`. Preview / development / lokálne: `stripe_live` → `off` |
| Kľúče | iba `STRIPE_SECRET_KEY` (test) | test: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (`sk_/rk_/rkcs_test_`); live: **oddelené** `STRIPE_LIVE_SECRET_KEY` + `STRIPE_LIVE_WEBHOOK_SECRET` (`sk_/rk_live_`). Test provider odmietne live kľúč (`LIVE_MODE_FORBIDDEN`), live provider test kľúč (`TEST_MODE_FORBIDDEN`) |
| Env validácia (`validateBillingEnv`) | live = vždy chyba | live režim vyžaduje úplnú schému; **test premenné vedľa live = chyba** (`TEST_CONFIG_IN_LIVE`), live premenné mimo produkcie = chyba, návrat iba `https`. Neplatná schéma → `getWebBillingProvider` vráti `null` (billing vypnutý) |
| Adaptér Stripe | `StripeTestProvider` | `StripeProvider(environment)` + `StripeTestProvider` / `StripeLiveProvider`; `livemode` každej udalosti (webhook aj `/v1/events`) a každého API objektu musí zodpovedať prostrediu, inak odmietnuté |
| Webhook `/api/billing/webhooks/stripe` | iba `stripe_test` | `stripe_test` alebo `stripe_live`; podpis overený secretom aktívneho prostredia |
| Doťahovanie `/api/cron/billing-stripe-events` | iba test | test aj live; prostredie servera ≠ DB `environment` → **503 `ENVIRONMENT_MISMATCH`**, nič sa nevolá; kurzor per prostredie |
| Reconciliation | prostredie `"test"` napevno | prostredie zo zdroja; účet iného prostredia → `skipped / ENVIRONMENT_MISMATCH` |
| Checkout / nákupný zámer | — | zámer nesie prostredie z DB; provider iného prostredia sa nikdy nezavolá (`getWebBillingProvider(provider, environment)`, `startWebCheckout`) |
| DB `billing_runtime_config.environment` | iba `test` | `test` / `live`; live len s `web_provider` none/stripe, bez mock plánov a bez obchodov (constraint `billing_runtime_config_live_guard`) |
| DB `esblu_billing_record_event` | bez kontroly prostredia | udalosť iného prostredia ako DB → `ESBLU_BILLING_ENVIRONMENT_MISMATCH`, nič sa neuloží (platí pre webhook, doťahovanie, reconciliation aj akcie používateľa) |
| DB nároky / reconciliation | — | nároky iba z účtu prostredia DB; kandidáti reconciliation iba z prostredia DB |
| Ceny, väzby, zámery, udalosti | stĺpec `environment` (test/live) už existoval | bez zmeny — izolácia podľa prostredia platila už predtým |

Obchody (Apple / Google) a fake provider ostávajú **iba test**; live konfigurácia ich v DB nepovolí.
Pravidlá S12/S13/S16 (doťahovanie, reconciliation platby, 48 h lehota, `cancel_at`) sú pre live rovnaké.

Migrácia: `supabase/migrations/20261119130000_billing_live_mode.sql` (+ rollback). Staging: aplikovaná, `environment='test'`
bez zmeny, md5 tiel funkcií = repo.

## 2. Predpoklady pred zapnutím (všetky)

1. CLIA: schválené znenie VOP (predplatné, 48 h lehota, refundácie), Zásad, DPA a `/subprocessors` (Stripe) a ich publikácia.
2. Účtovníčka: DPH § 7a, doklady, mesačné párovanie (`docs/finance/stripe-monthly-reconciliation-template.csv`).
3. ⛔ Produkčné migrácie v poradí `20261118120000`, `20261118130000`, `20261118140000`, `20261119100000`,
   `20261119110000`, `20261119120000`, `20261119130000`, `20261119140000` — čerstvý backup + logický dump, po jednej,
   kontrola po každej (audit § 7).
4. ⛔ Merge vetvy do `main` a produkčný deploy (billing ostáva `off`, kým nie sú nastavené premenné z kroku 6).
5. Stripe live účet Esblu s.r.o.: overená firma, výplatný účet, DPH nastavenia, produkt „Esblu Komplet" a cena
   15,90 €/mesiac (EUR), Billing Portal (zrušenie **ku koncu obdobia**), webhook endpoint
   `https://www.esblu.com/api/billing/webhooks/stripe` s udalosťami: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `customer.subscription.created/updated/deleted/paused/resumed`, `invoice.paid`, `invoice.payment_failed`,
   `invoice.payment_action_required`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`
   a (P4, účtovná kópia dokladov) `invoice.finalized`, `invoice.voided`, `invoice.marked_uncollectible`,
   `credit_note.created`, `credit_note.updated`, `credit_note.voided`. **API verzia endpointu = `2025-03-31.basil`**
   (konštanta `STRIPE_API_VERSION` v `lib/billing/stripe-api-version.ts`; nezhoda → ops alert `WEBHOOK_API_VERSION_MISMATCH`).
6. Restricted live kľúč (`rk_live_`) s minimom oprávnení: Account (read), Events (read), Customers (write),
   Checkout Sessions (write), Subscriptions (write), Prices (read), Invoices (read), Invoice payments (read),
   PaymentIntents (read), Charges (read), Disputes (read), Billing portal sessions (write).
   P4: **samostatný** read-only kľúč `STRIPE_LIVE_REPORTING_KEY` (`rk_live_`, iba Balance transactions read + Payouts read)
   pre mesačný účtovný export; runtime kľúč tieto práva nedostane.

## 3. Postup zapnutia (každý krok ⛔, v tomto poradí)

1. **Vercel Production env (vlastník, typ Sensitive):** `STRIPE_LIVE_SECRET_KEY`, `STRIPE_LIVE_WEBHOOK_SECRET`,
   `ESBLU_BILLING_RETURN_ORIGIN=https://www.esblu.com`, `ESBLU_BILLING_MODE=stripe_live`. **Bez**
   `ESBLU_BILLING_LIVE_APPROVED` → po redeployi je billing stále `off` (overiť 404 na webhooku).
   Overiť, že v Production **nie sú** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ESBLU_FAKE_BILLING_SECRET`.
2. **Prod DB (agent so súhlasom):**
   `insert into billing_provider_prices (provider, environment, plan_code, billing_interval, provider_price_id, active) values ('stripe','live','esblu_complete','month','<price_live_…>', true);`
   `update billing_runtime_config set environment = 'live', enabled_methods = array['stripe_web_checkout'], allow_mock_plans = false;`
   (`web_provider` ostáva `none`).
3. **Schválenie:** `ESBLU_BILLING_LIVE_APPROVED=true` + redeploy. Webhook je aktívny, `/api/billing/purchase-options`
   stále bez kanálov (DB `web_provider='none'`).
4. **Prod DB (allowlist, S15b):** `insert into billing_live_purchase_allowlist (company_id, note) values ('<interná firma Esblu>', 'prvý live test');`
   `live_purchase_scope` ostáva `allowlist` (default). Potom `update billing_runtime_config set web_provider = 'stripe';`.
   LIVE zámer / Checkout vytvorí **iba** firma z allowlistu — DB trigger to vynúti pre každú cestu (UI aj priame API);
   ostatné firmy nemajú webové kanály v ponuke a priamy pokus skončí `403 ESBLU_BILLING_LIVE_NOT_ALLOWED`.
5. **UI:** `NEXT_PUBLIC_ESBLU_BILLING_UI=1` + redeploy (ostatné firmy vidia „Online predplatné zatiaľ nie je dostupné“ —
   bez kanálov). **Interný test vlastnou kartou** na internej firme: nákup → aktivácia, zrušenie ku koncu obdobia, plná
   refundácia → `refunded` + ukončenie v Stripe, cron doťahovania (`billing_event_cursors` = live účet, bez chýb).
6. ⛔ **Otvorenie predaja:** `update billing_runtime_config set live_purchase_scope = 'all';` (allowlist ostáva ako záznam).
   Crony (`billing-stripe-events` 15 min, `billing-reconcile` 6 h) bežia od kroku 3.

Monitoring (P4, automaticky): cron `billing-ops-monitor` (15 min) → `billing_ops_alerts` + e-mail (§ 9.3).
Ručne prvých 14 dní navyše: `billing_events` so `status='failed'`, `billing_event_cursors.consecutive_failures > 0`,
`billing_reconciliation.dead_letter`, Vercel runtime chyby na `/api/billing/*` a `/api/cron/billing-*`, Stripe
upozornenia na zlyhané doručenia webhooku.

## 4. Rollback

| Úroveň | Kedy | Postup | Dopad |
|---|---|---|---|
| R1 kill switch | akákoľvek pochybnosť | odstrániť `ESBLU_BILLING_LIVE_APPROVED` (alebo nastaviť ≠ `true`) + redeploy | režim `off`: nové nákupy nemožné, webhook 404 (Stripe opakuje 3 dni, potom doťahovanie po znovuzapnutí), crony `configured:false`. **Pozor:** obnovy predplatných sa nespracúvajú → zaplatení zákazníci stratia prístup po konci obdobia + 48 h, ak R1 trvá dlhšie; preto R1 iba krátkodobo |
| R2 pozastavenie predaja | chyba v nákupe | `update billing_runtime_config set web_provider = 'none';` (alebo `live_purchase_scope = 'allowlist'` = predaj iba internej firme) | žiadne nové zámery ani Checkout; **webhooky, doťahovanie (S15b oprava), reconciliation a obnovy bežia ďalej**; prístup ostáva kotvený na obdobie od Stripe + 48 h (nič sa nepredlžuje). Odporúčané namiesto R1 |
| R3 kód | chyba v aplikácii | Vercel Instant Rollback na predchádzajúci deploy | starý kód má produkciu tvrdo `off` (= R1) |
| R4 migrácia | iba ak live nikdy nebežal | `supabase/rollback/20261119130000_billing_live_mode_rollback.sql` (vyžaduje `environment='test'` a žiadny live kurzor) | po reálnych live platbách sa **nerobí** — live dáta (udalosti, účty) sa nemažú (účtovníctvo) |

Zmena Stripe live účtu (iný `acct_…`): doťahovanie vráti `ACCOUNT_MISMATCH` a nič nespracuje; reset kurzora iba vedome
(`delete from billing_event_cursors where environment = 'live'`) po overení, že nový účet je správny.

## 5. Testy S15 (DB a simulované Stripe API — NIE end-to-end so živým Stripe)

- `test:billing-live-mode-db` 13/13 (S15 9 + S15b 4; čistý replay všetkých migrácií + skutočná TS pipeline s mockom live Stripe):
  constraint live konfigurácie; `record_event` odmietne iné prostredie (test ← live, live ← test, obchody v live);
  nároky iba z účtu prostredia DB (+ 48 h riadny koniec v live, test účet v live DB nič neodomkne); kandidáti
  reconciliation per prostredie; live kurzor; live webhook applied, test udalosť / test secret / test provider odmietnuté
  bez zápisu; live plná refundácia → `refunded` + ukončenie u Stripe; live riadny koniec + 48 h a predčasný koniec
  (`cancel_at`, skrátené obdobie) bez 48 h; live doťahovanie (test udalosť v zozname preskočená, `TEST_EVENT_SKIPPED`);
  reconciliation test zdroja nad live účtom = `ENVIRONMENT_MISMATCH`, live zdroj `in_sync`; live API objekt
  s `livemode=false` → nič sa neaplikuje; migrácia idempotentná, rollback a znovu-forward.
- `test:subscriptions-lifecycle` 60/60 (+5 S15, +3 S15b: správa podľa prostredia, tajomstvá, pozastavenie predaja): matica režimov (produkcia / preview / development / lokálne,
  schválenie presne `true`), kľúče per prostredie, `livemode` webhooku, `/v1/events` a API objektov v oboch smeroch,
  env schéma (iba názvy, žiadne hodnoty), `getWebBillingProvider` (live iba pri platnej produkčnej konfigurácii,
  test kľúč vedľa live = `null`, zámer iného prostredia = `null`), checkout iného prostredia sa nevolá.
- Regresia bez zmeny výsledkov: `test:subscriptions` 28/28, `test:subscriptions-lifecycle-db` 82/82 (S12),
  `test:billing-post-period-db` 16/16 (48 h, S13), `test:subscriptions-db` 60/60, `test:pricing-entitlements-db` 35/35,
  `test:grants-replay-db` 43/43, `test:grants-guard` 10/10, `test:prelaunch-blockers` 21/21, `test:cost-control` 18/18,
  `test:i18n` 114/114, `tsc` 0, `eslint` 0.
- Staging: migrácia aplikovaná, `environment='test'`, `web_provider='none'`; `record_event('stripe','live',…)` →
  `ENVIRONMENT_MISMATCH` (transakcia s rollbackom). Reálne integračné testy S16 sa neopakovali (test cesta bez zmeny správania).

## 6. Otvorené riziká

1. Live režim nebol overený so skutočným live Stripe účtom (žiadny neexistuje) — prvý reálny dôkaz je interný nákup (krok 5).
2. R1 (kill switch) zastaví aj spracovanie obnov — dlhodobé vypnutie by zákazníkom po období + 48 h odobralo prístup;
   pri chybe nákupu použiť R2.
3. ~~Interný test bez allowlistu~~ — doplnené (S15b, migrácia `20261119140000`): `live_purchase_scope='allowlist'` je default.
4. ~~`/api/billing/manage` nevie prostredie účtu~~ — opravené (S15b): route čaká prostredie predplatného z
   `esblu_billing_authorize_manage` a provider musí byť z rovnakého prostredia, inak `409 ESBLU_BILLING_ENVIRONMENT_MISMATCH`
   **pred** akýmkoľvek volaním Stripe.
5. Apple / Google live billing nie je súčasťou S15 (constraint ho v live DB blokuje).

## 7. S15b — read-only audit 8 čakajúcich produkčných migrácií (19. 11. 2026)

Produkcia (`assetpilot`, read-only metadáta a počty, bez osobných údajov; záznam v `docs/ops/service-intervention-log.md`):
posledná migrácia `20261117213219`; billing tabuľky existujú, RLS zapnutá; **0** zámerov, **0** udalostí, **0** účtov,
**0** nárokov zo `subscription`; 12 cien (test fixtures obchodov / fake); `billing_runtime_config` = `test / none`, bez mock
plánov; žiadna z nových funkcií / tabuliek / stĺpca / indexu ešte neexistuje. **Všetkých 8 nahrádzaných funkcií má v produkcii
md5 tela totožné s poslednou verziou v repe pred 18. 11.** (`apply_event`, `apply_charge`, `attach_checkout_session`,
`create_purchase_intent`, `reconcile_candidates`, `record_event`, `sync_entitlements`, `get_my_subscription`) → žiadny drift.

| # | Migrácia | Mimo funkcií (DDL / dáta) | Závislosti v produkcii | Idempotencia / rollback | Riziko prestoja |
|---|---|---|---|---|---|
| 1 | `20261118120000_billing_single_open_checkout` | update duplicitných otvorených zámerov → `expired` (prod: 0 riadkov), unikátny čiastočný index | `billing_checkout_sessions` ✓ | `if not exists`, rollback súbor | index nad prázdnou tabuľkou — okamžité |
| 2 | `20261118130000_billing_terminal_precedence` | — (iba funkcie) | ✓ | replay test, rollback | žiadne |
| 3 | `20261118140000_billing_refund_audit` | — | ✓ | replay, rollback | žiadne |
| 4 | `20261119100000_billing_post_period_protection` | — | `esblu_billing_plan_targets` ✓ | replay, rollback | žiadne |
| 5 | `20261119110000_billing_scheduled_end` | `add column if not exists scheduled_end_at` (nullable) | ✓ | replay, rollback (stĺpec ponechá) | metadátová zmena, okamžitá |
| 6 | `20261119120000_billing_event_catchup` | nová tabuľka (RLS, service-only) | ✓ | `if not exists`, rollback | žiadne |
| 7 | `20261119130000_billing_live_mode` | constrainty `billing_runtime_config` / kurzor (existujúci riadok `test/none` ich spĺňa) | ✓ | replay, rollback (iba pri `test`) | 1 riadok — okamžité |
| 8 | `20261119140000_billing_live_purchase_allowlist` | stĺpec s defaultom, tabuľka, trigger na `billing_checkout_sessions` | `companies`, `esblu_billing_my_access` ✓ | replay, rollback | 0 riadkov — okamžité |

Poradie je povinné (7 a 8 nahrádzajú funkcie z 4–6). Všetky sú testované čistým replayom všetkých migrácií
(`test:grants-replay-db`: idempotencia, rollback → re-apply = rovnaké ACL a politiky) a na stagingu (md5 = repo).
Aplikácia nepotrebuje výpadok: billing je v produkcii vypnutý a tabuľky sú prázdne.

## 8. S15b — tajomstvá a súbežné test/live premenné

- Live secrety (`STRIPE_LIVE_SECRET_KEY`, `STRIPE_LIVE_WEBHOOK_SECRET`) číta **iba** `lib/billing/server.ts`; žiadny klientsky
  modul (`.tsx` / `"use client"`) neimportuje billing server, konfiguráciu ani Stripe adaptér; neexistuje `NEXT_PUBLIC_*`
  so Stripe / live; `lib/billing` nič nelogovaním nevypisuje; chyby Stripe nesú iba metódu, cestu a HTTP kód
  (statický test v `test:subscriptions-lifecycle`).
- Vercel: Preview ani Production nemajú žiadnu premennú `STRIPE_*` (19. 11.); repo a dokumentácia neobsahujú reálne kľúče
  (iba zjavné testovacie atrapy v testoch).
- Súbežne test + live premenné: v produkcii s live režimom → `TEST_CONFIG_IN_LIVE` → provider `null` (billing nebeží);
  mimo produkcie live premenné → `LIVE_OUTSIDE_PRODUCTION` a live režim sa nikdy nezapne; test provider live kľúč a live
  provider test kľúč odmietne aj samostatne.


## 9. P4 (2026-11-23) — doklady, refundácie, monitoring, API verzia

### 9.1 Nové migrácie (po `20261120100000`, v tomto poradí, každá ⛔)

| # | Migrácia | Čo robí | Rollback |
|---|---|---|---|
| 1 | `20261123100000_billing_event_retry` | stĺpce `next_retry_at`, `dead_letter`, `dead_lettered_at` na `billing_events`, trigger plánu opakovania (backoff 5 min → 6 h, max. 8 pokusov), RPC `esblu_billing_event_retry_claim` / `_dead_letter` | `supabase/rollback/20261123100000_…` — stĺpce **ponechá** (auditná stopa) |
| 2 | `20261123110000_billing_invoice_documents` | `billing_invoice_documents`, `billing_refund_observations`, `billing_balance_transactions`, `billing_ops_admins`, `billing_accounting_export_log`, privátny bucket `billing-documents`, RPC dokladov a exportu | neprázdne tabuľky → `esblu_audit_archive.*_rb_<ts>`; bucket s PDF ostáva |
| 3 | `20261123120000_billing_ops_alerts` | `billing_ops_alerts`, `billing_ops_heartbeats`, RPC `esblu_billing_ops_*` | história → `esblu_audit_archive` |

Rollback v opačnom poradí (3 → 2 → 1). **Deploy kódu až po migráciách 1–2**: nová pipeline zapisuje doklady pred
zmenou stavu; bez migrácie 2 by udalosti `invoice.*`, `credit_note.*` a `charge.refunded` končili `DOCUMENT_FAILED`
(opakujú sa, nič sa nestratí, ale zmena stavu pri refundácii čaká). Grants manifest `supabase/grants/public-data-api-grants.json`
je doplnený (tabuľky aj service RPC).

### 9.2 Refundácia = VŽDY cez dobropis (credit note)

Esblu refundácie **nevystavuje v kóde** (žiadne `POST /v1/refunds`); robí ich iba operátor v Stripe Dashboarde. Povinný postup:

1. Stripe Dashboard → **Invoices** → pôvodná faktúra → **Issue credit note** (nie *Payments → Refund*).
2. Suma = refundovaná suma, dôvod podľa skutočnosti, voľba **Refund to customer's payment method** (vrátenie peňazí
   a dobropis jedným krokom). Pri čiastočnej refundácii iba príslušná suma (prístup sa nemení).
3. Text / číslovanie dobropisu podľa rozhodnutia účtovníčky (`docs/accountant-questions-billing-2026-11-19.md`).
4. Kontrola: v `billing_invoice_documents` vznikne riadok `kind='credit_note'` s `related_invoice_id` pôvodnej faktúry;
   PDF sa archivuje cronom `billing-documents`.

Poistka: ak príde `charge.refunded` a do 24 h k faktúre neexistuje dobropis aspoň v sume refundácie, monitor otvorí
alert `REFUND_WITHOUT_CREDIT_NOTE` → operátor vystaví dobropis dodatočne (Invoices → faktúra → Issue credit note,
**bez** ďalšej refundácie — s väzbou na už vykonanú refundáciu, ak ju Dashboard ponúkne, inak spôsobom, ktorý určí
účtovníčka; nikdy nie druhé vrátenie peňazí).
Spory (chargeback): Stripe dobropis nevytvorí; postup určí účtovníčka (otázka v dokumente otázok).

### 9.3 Monitoring a alerty

- Cron `GET /api/cron/billing-ops-monitor` (`7,22,37,52 * * * *`, `CRON_SECRET`): vyhodnotí `EVENT_PROCESSING_FAILED`,
  `EVENT_DEAD_LETTER` (kritický), `CATCHUP_LAG` (> 1 h bez úspechu, kritický), `CATCHUP_ACCOUNT_MISMATCH`,
  `CATCHUP_CURSOR_EXPIRED`, `RECONCILE_DEAD_LETTER`, `RECONCILE_MISMATCH`, `RECONCILE_ERRORS`,
  `CRON_STRIPE_EVENTS_FAILING` / `CRON_RECONCILE_FAILING` / `CRON_DOCUMENTS_FAILING` (heartbeat),
  `REFUND_WITHOUT_CREDIT_NOTE`, `DOCUMENT_ARCHIVE_FAILED`; z webhooku `WEBHOOK_SIGNATURE_FAILURES` (≥ 10 / h) a
  `WEBHOOK_API_VERSION_MISMATCH`. Deduplikácia = 1 riadok a najviac 1 notifikácia na kód, prostredie a okno; podmienkové
  alerty sa samy uzavrú (`resolved`).
- Doručenie: vždy riadok v `billing_ops_alerts` a HTTP **503** cronu pri otvorenom kritickom alerte (Vercel cron
  monitoring / log drain). Voliteľne e-mail cez Resend REST API — premenné (iba názvy, Production, Sensitive pri kľúči):
  `RESEND_API_KEY`, `ESBLU_OPS_ALERT_EMAIL_TO`, `ESBLU_OPS_ALERT_EMAIL_FROM`. Bez nich sa e-mail neposiela.
- Obsah alertu: iba kód, závažnosť, prostredie, počty a časy. Žiadne ID firiem / zákazníkov / predplatných, sumy,
  e-maily, telo udalosti ani tajomstvá (sanitizácia v DB aj v kóde, testy).
- Dead-letter udalosť: zistiť príčinu (`error_code`), opraviť (cena, väzba, konfigurácia) a vrátiť do opakovania:
  `update billing_events set dead_letter = false, status = 'failed', error_code = 'MANUAL_RETRY', attempts = 1 where provider_event_id = '<evt_…>';`
  (⛔ produkcia so súhlasom, zápis do `docs/ops/service-intervention-log.md`).

### 9.4 Účtovná kópia a mesačný export

- Každá Stripe faktúra a dobropis → `billing_invoice_documents` (idempotentne z webhooku, doťahovania aj retry; stav iba
  dopredu), PDF → bucket `billing-documents` (`<env>/<YYYY>/<MM>/<kind>/<id>.pdf`, SHA-256, nemenné) cronom
  `GET /api/cron/billing-documents` (`41 * * * *`).
- Export: `GET /api/billing/admin/accounting-export?month=YYYY-MM&refresh=1` (Bearer JWT používateľa zapísaného v
  `billing_ops_admins`; zápis iba SQL: `insert into billing_ops_admins (user_id, note) values ('<auth uuid>', '<kto>');`).
  `refresh=1` najprv načíta balance transactions a výplaty kľúčom `STRIPE_LIVE_REPORTING_KEY`. CSV (`;`, UTF-8 BOM):
  doklady (číslo, dátum, sumy, DPH polia, krajina a IČ DPH odberateľa, hrubá suma, poplatok Stripe, čistá suma, payout)
  + všetky balance transactions mesiaca. Každý export je v `billing_accounting_export_log`.

### 9.5 Pred prvým LIVE predajom (doplnok k § 3)

- [ ] Sandbox: zopakovať S12/S13 integračné testy s hlavičkou `Stripe-Version: 2025-03-31.basil` (kód ju posiela vždy).
- [ ] Webhook endpoint v Stripe na rovnakej API verzii + udalosti z § 2 bod 5.
- [ ] Overiť, že `invoice_pdf` / `credit_note.pdf` sa dá stiahnuť bez API kľúča (sandbox; inak archív zlyhá → alert).
- [ ] Rozhodnutia účtovníčky a variant dokladov (`docs/billing-invoicing-architecture-2026-11-19.md`).
