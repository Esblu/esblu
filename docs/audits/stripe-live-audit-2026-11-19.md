# Stripe LIVE — technický audit pripravenosti a aktivačný checklist (Esblu, 2026-11-19)

**Rozsah:** read-only audit kódu vo worktree vetvy `ops/esblu8-readiness` @ `f8262b4` (obsahuje Stripe S12–S15b z `fb349db`
a interný tarif prevádzkovateľa). Nič sa nespúšťalo (žiadny npm/build, žiadne volanie Stripe, žiadny commit, žiadny zápis do DB).
Súbory `.env*` vo worktree neexistujú; hodnoty tajomstiev sa nečítali. Cesty sú relatívne ku koreňu repozitára.

**Prečítané podklady:** `docs/stripe-test-and-reconciliation-2026-11-18.md` (celý), `docs/billing-live-rollout-2026-11-19.md`,
`docs/finance/stripe-monthly-reconciliation-template.csv`, `docs/prod-cleanup-and-operator-plan-2026-11-19.md`,
`docs/payment-channels-economics-2026-11-18.md` § 6, `docs/clia-delta-2026-11-24-draft.md` § 3.2, `lib/billing/**`,
`app/api/billing/**`, `app/api/cron/billing-*`, migrácie `20261118120000`–`20261119140000`, `vercel.json`.

Legenda: **✅ implementované** · **🟡 čiastočne** · **❌ chýba** · **⚠ riziko / nález**

---

## 0. Zhrnutie

Technické jadro (izolácia test/live, overenie webhookov, idempotencia, poradie udalostí, terminálne stavy, doťahovanie
zmeškaných udalostí, reconciliation, allowlist, pozastavenie predaja) je **nadpriemerne dobre implementované a otestované**
(PGlite + skutočný Stripe sandbox S12/S13 PASS 4/4). Live režim však **nikdy nebežal proti skutočnému live účtu**.

Najväčšie medzery nie sú v kóde predplatného, ale v **dokladoch a účtovníctve**: Esblu neeviduje Stripe faktúry (číslo, PDF,
sumy), nemá archív PDF, nemá mesačný export pre účtovníčku, refundácie nevytvárajú opravný doklad (credit note) a párovanie
platieb, poplatkov a výplat je iba ručný postup zo Stripe reportov. Daňový režim dokladov (§ 7a) nie je rozhodnutý. Hrozí
**dvojitá fakturácia** (Stripe faktúra + budúca e-faktúra z Esblu/eFaktura.sk za to isté predplatné), ak sa vopred neurčí
jeden zdroj pravdy.

### Top medzery podľa rizika

| # | Riziko | Oblasť | Stav | Prečo |
|---|---|---|---|---|
| 1 | **Vysoké (právne/účtovné)** | Doklady: daňový režim, náležitosti, číslovanie Stripe faktúr | ❌ nerozhodnuté | Stripe vystaví faktúru po každej platbe automaticky, s tým, čo je dnes v Dashboarde. Ak náležitosti/číslovanie/text o DPH nie sú správne, každý live predaj vytvorí chybný doklad |
| 2 | **Vysoké** | Dvojitá fakturácia Stripe ↔ e-faktúra (Peppol) | ❌ bez dizajnu | Dva doklady za jedno plnenie = dvojité zdanenie/výnos, nekonzistentné opravné doklady |
| 3 | **Stredne vysoké** | Refundácie bez opravného dokladu (credit note) | ❌ | Runbook vracia peniaze cez *Payments → Refund*. Takto Stripe credit note nevznikne, takže doklad k pôvodnej faktúre chýba |
| 4 | **Stredné** | Žiadny automatický alerting (webhook/cron/kurzor/dead-letter) | ❌ | Crony vracajú 500 iba do logov Vercelu; monitoring je ručný zoznam dotazov |
| 5 | **Stredné** | Doťahovanie nevie zopakovať udalosť, ktorá padla vo webhooku (hash payloadu sa líši) | ⚠ | pozri § 2.3. Poistkou sú opakovania Stripe a reconciliation, takže nejde o stratu stavu, iba o slabšiu „druhú cestu“, než tvrdí dokumentácia |
| 6 | **Stredné** | `STRIPE_API_VERSION` nie je pripnutá; verzia webhook endpointu nie je určená | ⚠ | Kód predpokladá tvary API ≥ 2025-03-31 (`invoice.parent`, `invoice_payments`). Live účet môže mať inú predvolenú verziu |
| 7 | **Stredné** | Restricted live kľúč nebol nikdy overený (`/v1/account`, `/v1/events`, `invoice_payments`, `DELETE subscription`) | 🟡 | Sandbox test bežal so sandbox kľúčom; zlé oprávnenie = tiché zlyhanie doťahovania alebo ukončenia |
| 8 | **Stredné** | Nastavenia Stripe Dashboardu, ktoré kód predpokladá (Portál iba „ku koncu obdobia“, bez zmeny plánu; Smart Retries vs. 7-dňová lehota Esblu; zákaznícke e-maily) | ❌ mimo kódu | Nesúlad = iné správanie než VOP a testy |
| 9 | Nízke–stredné | Mesačné párovanie (hrubé platby / poplatky / výplaty) | 🟡 iba ručný postup a CSV šablóna | Esblu neukladá `balance_transaction` ani `payout` |
| 10 | Nízke | Kill switch R1 zastaví aj spracovanie obnov | ⚠ zdokumentované | Pri dlhšom R1 platiaci zákazníci po období + 48 h stratia prístup. Preferovať R2 |

---

## 1. Izolácia TEST / LIVE

| Kontrola | Stav | Dôkaz |
|---|---|---|
| Režim servera: live **iba** pri `VERCEL_ENV=production` + `ESBLU_BILLING_MODE=stripe_live` + `ESBLU_BILLING_LIVE_APPROVED=true` (presne). Produkcia s čímkoľvek iným = `off`, mimo produkcie `stripe_live` = `off` | ✅ | `lib/billing/config.ts:25-31` |
| Oddelené premenné: test `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`, live `STRIPE_LIVE_SECRET_KEY`/`STRIPE_LIVE_WEBHOOK_SECRET` | ✅ | `lib/billing/server.ts:108-131`, schéma `lib/billing/provider-modes.ts:45-53` |
| Prefixy kľúčov: test iba `sk_/rk_/rkcs_test_` (live → `LIVE_MODE_FORBIDDEN`), live iba `sk_/rk_live_` (test → `TEST_MODE_FORBIDDEN`); kontrola pri **každom** requeste | ✅ | `lib/billing/providers/stripe.ts:98-118`, `:254` |
| Env guardy: live kľúč v `STRIPE_SECRET_KEY` = chyba; live premenné mimo produkcie = `LIVE_OUTSIDE_PRODUCTION`; test premenné vedľa live = `TEST_CONFIG_IN_LIVE` → provider `null`; live návrat iba `https` | ✅ | `lib/billing/provider-modes.ts:80-93`, `lib/billing/server.ts:114-116` |
| `livemode` na webhooku (povinný), na udalostiach z `/v1/events` (povinný) a na **každom** API objekte | ✅ | `lib/billing/providers/stripe.ts:121-125`, `:278`, `:419`, `:485` |
| Ceny podľa prostredia (`billing_provider_prices.environment`, `esblu_billing_resolve_price(p_environment)`) | ✅ | `app/api/billing/manage/route.ts:77-82`; rollout § 3 krok 2 |
| Zámer (checkout intent) nesie prostredie z DB; provider iného prostredia sa nezavolá | ✅ | `lib/billing/web-checkout.ts:49`, `app/api/billing/checkout/route.ts:40` |
| Správa predplatného (`/manage`) iba providerom prostredia predplatného, inak 409 pred volaním Stripe | ✅ | `lib/billing/manage-guard.ts:20-37`, `app/api/billing/manage/route.ts:46` |
| DB: `billing_runtime_config.environment` ∈ {test, live}; live konfigurácia bez mock plánov a obchodov (constraint) | ✅ | `supabase/migrations/20261119130000_billing_live_mode.sql:17-25` |
| DB: `esblu_billing_record_event` odmietne udalosť iného prostredia (`ENVIRONMENT_MISMATCH`), nič sa neuloží | ✅ | tamže `:30-44` |
| DB: nároky iba z účtu prostredia DB; kandidáti reconciliation iba z prostredia DB | ✅ | tamže `:97-100`, `:179` |
| Cron doťahovania: prostredie servera ≠ DB → 503 `ENVIRONMENT_MISMATCH`; kurzor per prostredie + kontrola `acct_…` (`ACCOUNT_MISMATCH`) | ✅ | `app/api/cron/billing-stripe-events/route.ts:40-42`, `lib/billing/event-catchup.ts:78-97` |
| Reconciliation: účet iného prostredia → `skipped / ENVIRONMENT_MISMATCH` | ✅ | `lib/billing/reconciliation.ts:100-105` |
| **Fyzické oddelenie dát** | 🟡 | Staging (`esblu-test`) je samostatný Supabase projekt a Preview naň ukazuje. V produkcii sú test a live záznamy v **tých istých tabuľkách**, oddelené stĺpcom `environment`. Ostáva tam 12 test cien (fixtures) a riadky `environment='test'`. Je to akceptovateľné, lebo DB je v danom čase iba v jednom prostredí. Odporúčanie: test fixtures v produkcii deaktivovať (`active=false`) pred prepnutím na `live` |
| Overenie so skutočným live účtom | ❌ | nikdy (live účet neexistuje). Prvý dôkaz = interný nákup (rollout § 3 krok 5) |
| Nastavenie premenných vo Verceli s rozsahom **iba Production** | ❌ prevádzka | kód to vynúti (`LIVE_OUTSIDE_PRODUCTION`), ale nastavuje sa to ručne |

**Hodnotenie:** izolácia je viacvrstvová (env → kľúč → `livemode` → DB constraint → DB funkcia) a fail-closed. Bez nálezu v kóde.

---

## 2. Webhooky, idempotencia, poradie, doťahovanie, reconciliation

### 2.1 Implementované

| Kontrola | Stav | Dôkaz |
|---|---|---|
| Overenie podpisu: HMAC-SHA256 nad `t.rawBody`, viac `v1`, porovnanie v konštantnom čase, tolerancia 300 s (replay), raw body cez `req.text()`, limit 512 kB | ✅ | `lib/billing/signature.ts:10-54`, `lib/billing/providers/stripe.ts:470-496`, `app/api/billing/webhooks/stripe/route.ts:17-26` |
| Neplatný podpis / zlý `livemode` → 400 bez zápisu; chýbajúci secret → 503 | ✅ | `lib/billing/pipeline.ts:40-54` |
| Idempotencia: unikátne `(provider, environment, provider_event_id)`, rovnaké ID s iným telom → `payload_mismatch` (nespracuje sa); `received`/`failed` → opakované spracovanie | ✅ | `supabase/migrations/20261119130000_billing_live_mode.sql:46-72` |
| Poradie: adaptér vždy znova načíta predplatné z API (nie snapshot z udalosti); DB porovnáva `state_at` → staršia = `stale` | ✅ | `lib/billing/providers/stripe.ts:505-509`; `20261118130000_billing_terminal_precedence.sql:161-173` |
| Prednosť terminálnych stavov: revoked > refunded > canceled/expired; slabší → `stale/TERMINAL_STATE` | ✅ | `20261118130000_billing_terminal_precedence.sql:176-188` |
| Plná refundácia / prehraný spor aktuálneho obdobia → okamžité ukončenie u Stripe (`DELETE`, `invoice_now=false`, `prorate=false`) + audit; zlyhanie → reconciliation | ✅ | `lib/billing/pipeline.ts:177-180`, `:217-229`; `lib/billing/providers/stripe.ts:344-356` |
| Doťahovanie `GET /v1/events` (každých 15 min): lease, kurzor po každej udalosti, dočasná chyba = stop bez posunu, limity 200 udalostí / 20 strán / 45 s, bootstrap pri kurzore mimo 30-dňovej retencie, kontrola účtu | ✅ | `lib/billing/event-catchup.ts:63-203`, `vercel.json:40` |
| Reconciliation (každých 6 h, 50 kandidátov/beh): stav predplatného **aj** platba aktuálnej faktúry (`invoice_payments` → `payment_intent.latest_charge` → `disputes`); terminálny účet + otvorené predplatné u Stripe → `cancelNow` | ✅ | `lib/billing/providers/stripe.ts:438-468`, `lib/billing/reconciliation.ts:89-170`, `vercel.json:44` |
| Crony chránené `CRON_SECRET` (konštantný čas); billing vypnutý → `configured:false` bez volania Stripe | ✅ | `app/api/cron/billing-stripe-events/route.ts:21-35`, `app/api/cron/billing-reconcile/route.ts:24-46` |
| Skutočný Stripe sandbox: stránkovanie `ending_before`, doťahovanie bez webhookov, reconciliation, `cancel_at` | ✅ | `docs/stripe-test-and-reconciliation-2026-11-18.md` § 8.13 (I1–I4 PASS) |

### 2.2 Čiastočne / chýba

| Položka | Stav | Poznámka |
|---|---|---|
| Alerting | ❌ | V `lib/billing/**` ani v cron routes nie je žiadne upozornenie (grep `alert/sentry/notify/resend` = 0). Cron s chybou vráti HTTP 500 iba do logov Vercelu. Rollout § 3 uvádza iba ručné dotazy |
| Škálovanie reconciliation | 🟡 | 50 kandidátov × 4 behy = 200 kontrol/deň. Pri stovkách predplatných stačí, neskôr zvýšiť `limit` alebo frekvenciu |
| `PROVIDER_CANCEL_FAILED` po refundácii | 🟡 | Nezopakuje sa hneď, až pri reconciliation, ktorá môže prísť až o 6 h. Medzitým môže Stripe vystaviť ďalšiu faktúru, ak koniec obdobia padne do tohto okna (nízka pravdepodobnosť) |
| Audit udalosti `checkout.session.async_payment_failed`, `trial_will_end` | ✅ iba audit | zámerné |

### 2.3 ⚠ Nález: doťahovanie nevie zopakovať udalosť, ktorá zlyhala vo webhooku

- Webhook ukladá `payload_sha256 = sha256(rawBody)` (`lib/billing/providers/stripe.ts:493`). Doťahovanie ukladá
  `sha256(JSON.stringify(event))` z odpovede API (`:426`). Stripe posiela webhook ako formátovaný JSON a verzia API
  endpointu sa môže líšiť od verzie requestu, takže **hashe sa v praxi takmer vždy líšia**.
- `esblu_billing_record_event` pri inom hashi vráti `duplicate/payload_mismatch` **skôr**, než stihne opakovať udalosť
  so stavom `received`/`failed` (`20261119130000_billing_live_mode.sql:63-72`). Doťahovanie ju potom započíta ako duplicitu
  a posunie kurzor.
- Dôsledok: udalosť, ktorá vo webhooku zlyhala technickou chybou, doťahovanie **nespracuje**. Zachránia ju iba opakovania
  Stripe (rovnaké telo, do 3 dní) alebo reconciliation (iba stav predplatného a platba aktuálnej faktúry).
  Test `stripe-catchup: súbeh …` (`scripts/subscriptions-lifecycle-pglite-tests.ts:1678`) používa pre obe cesty **rovnaký**
  reťazec `JSON.stringify(ev)`, preto tento prípad nezachytí.
- Odporúčaná oprava (malá): v doťahovaní posielať `p_payload_sha256 = null`. Udalosť z API je autentická a podmienka
  v SQL pri `null` porovnanie preskočí. Doplniť test, v ktorom má webhook iné telo a skončí stavom `failed`.

---

## 3. Zrušenia, refundácie, 48 h lehota, plánovaný koniec, allowlist, pozastavenie predaja

| Pravidlo | Stav | Dôkaz |
|---|---|---|
| Zrušenie v Esblu = `cancel_at_period_end=true` (iba owner) | ✅ | `lib/billing/providers/stripe.ts:335-338`, `app/api/billing/manage/route.ts:62-69` |
| Obnovenie pred koncom (`resume`) | ✅ | `stripe.ts:358-361` |
| 48 h po riadnom konci obdobia, kotva = `current_period_end` (nie čas webhooku); `past_due` = 7 dní bez sčítavania; refund/spor = hneď | ✅ | `20261119100000_billing_post_period_protection.sql:28-45`; grace `20261118140000_billing_refund_audit.sql:37,213-218` |
| Plánovaný predčasný koniec (`cancel_at` bez príznaku) → presne do dátumu, bez 48 h; rozhoduje príznak Stripe | ✅ | `stripe.ts:167-174`; `20261119110000_billing_scheduled_end.sql:28-45`; sandbox I4 PASS |
| Plná refundácia aktuálnej faktúry → `refunded` + ukončenie u Stripe; staršej → iba záznam; čiastočná → bez zmeny prístupu | ✅ | `stripe.ts:546-582`; sandbox L12–L15 PASS |
| Spor: `created` → príznak, `lost` → `revoked` + ukončenie, `won` → príznak preč | ✅ | `stripe.ts:588-602` |
| Live allowlist: `live_purchase_scope='allowlist'` (default); DB trigger blokuje LIVE zámer aj priradenie relácie pre firmu mimo allowlistu (každá cesta); UI kanály skryje, chyba = fail closed | ✅ | `20261119140000_billing_live_purchase_allowlist.sql:15-81`; `app/api/billing/purchase-options/route.ts:24-27` |
| Pozastavenie predaja (R2 `web_provider='none'`) blokuje nové zámery, ale webhook, doťahovanie a reconciliation bežia | ✅ | `20261118120000_billing_single_open_checkout.sql:101-103`; `app/api/cron/billing-stripe-events/route.ts:36-38`; webhook route `web_provider` nečíta; reconcile cron tiež nie |
| Jedna zaplatiteľná relácia na firmu (advisory lock, unikátny index, Idempotency-Key) | ✅ | `20261118120000_*`, `lib/billing/web-checkout.ts` |
| Refundáciu iniciuje **iba operátor** v Stripe Dashboarde (kód refundy nevytvára) | ✅ zámer | runbook § 3; kód nemá `POST /refunds` |
| Konfigurácia Billing Portálu (zrušenie iba ku koncu obdobia, bez okamžitého zrušenia, bez zmeny plánu a množstva) | ❌ mimo kódu | Portál otvára `createPortalSession` (`stripe.ts:377-382`), správanie však určuje Dashboard. Okamžité zrušenie v Portáli vedie k `canceled` bez 48 h; zmena plánu k prorácii a doplatkovej faktúre |
| Nastavenie dunningu Stripe (Smart Retries, čo po vyčerpaní: `canceled`/`unpaid`) vs. 7-dňová lehota Esblu | ❌ mimo kódu | Zladiť: retry okno Stripe ≈ 7 dní, inak sa líši VOP od reality |
| E-mail z Esblu pri `refunded`/`revoked` | ❌ | navrhnuté v runbooku § 3, neimplementované |

---

## 4. Fakturácia a účtovníctvo

### 4.1 Vystaví Stripe Billing faktúru automaticky?

**Áno, objekt Invoice vznikne vždy.** Checkout v režime `mode=subscription` (`stripe.ts:282-311`) vytvorí predplatné
a Stripe Billing pre každé obdobie (prvá platba aj každá obnova) automaticky vytvorí, finalizuje a zaplatí Invoice
s PDF a hosted invoice page. Z kódu vyplýva:

| Aspekt | Stav v kóde | Dôsledok |
|---|---|---|
| Fakturačná adresa | ✅ `billing_address_collection=required` | adresa odberateľa na faktúre |
| IČ DPH odberateľa | ✅ `tax_id_collection[enabled]=true` | zákazník môže zadať VAT ID. Kód ho **neoveruje** (VIES) ani neukladá |
| Výpočet dane | ❌ bez `automatic_tax`, bez `tax_rates` | faktúra bez DPH riadku, suma = cena (15,90 €). Či je to správne, je **otvorená daňová otázka** (§ 4.6) |
| Náležitosti dodávateľa (IČO, DIČ, IČ DPH § 7a, sídlo, text o DPH, číslovanie) | ❌ mimo kódu | nastavuje sa v Stripe Dashboarde (Business details, Invoice template, footer, custom fields, číslovanie) |
| Odoslanie zákazníkovi e-mailom | ❌ mimo kódu | závisí od Dashboardu (Customer emails, napr. *Successful payments* / *Finalized invoices*) |
| Prístup zákazníka k faktúram | 🟡 | Billing Portál (história faktúr, ak je zapnutá) a hosted invoice link z e-mailu; Esblu ich v UI samo nezobrazuje |
| Jazyk | 🟡 | Checkout/Portál `locale: "sk"`; jazyk PDF faktúry = `preferred_locales` zákazníka (kód ho nenastavuje) |

### 4.2 Archív PDF Stripe faktúr v Esblu
**❌ Chýba.** Esblu neukladá `invoice.id`, `number`, `invoice_pdf`, `hosted_invoice_url` ani sumy predajných faktúr.
`invoice.paid` sa premení na `charge` (`stripe.ts:76-92`), ale ten sa ukladá iba pre kanály s reportingom obchodu
(`esblu_billing_queue_store_report` vráti `null` pri `store_reporting='none'`, `20261008120000_subscriptions_platform.sql:1434`).
Súhrn udalosti (`billing_events.summary`) nesie stav, predplatné, cenu a koniec obdobia, nie faktúru
(`20261118140000_billing_refund_audit.sql:52-63`). Odkaz na faktúru majú iba refundácie.
Zákonná archivácia dokladov (10 rokov) by dnes závisela iba od Stripe účtu.

### 4.3 Mesačný export pre účtovníčku
**🟡 iba ručný postup.** Existuje CSV šablóna (`docs/finance/stripe-monthly-reconciliation-template.csv`) a postup
zo Stripe reportov *Payout reconciliation (itemized)* a *Balance change from activity*
(`docs/stripe-test-and-reconciliation-2026-11-18.md` § 5). Automatický export (cron/route, ZIP faktúr + CSV) ❌ neexistuje.
Existujúci `accounting-handoff` balík sa týka faktúr modulu Esblu, nie Stripe dokladov.

### 4.4 Refundácie → opravné doklady
**❌ Chýba.** Runbook vracia peniaze cez *Payments → Refund* (§ 3). Takto Stripe **credit note nevytvorí**: faktúra ostane
„paid“ s refundovanou platbou a opravný doklad nevznikne. Kód refundáciu iba zaeviduje (`stripe.ts:546-582`). Možnosti
(rozhodne účtovníčka):
(a) refundovať **cez faktúru → Issue credit note** (s refundom), čím vznikne Stripe credit note PDF s väzbou na faktúru;
(b) opravný doklad vystaví Esblu (pozor na § 5, duplicita);
(c) kombinácia: credit note v Stripe = doklad a Esblu ho iba archivuje.
Pre spory (chargeback, poplatok 20 €) doklad tiež chýba. Je to otázka pre účtovníčku.

### 4.5 Párovanie hrubé platby ↔ poplatky ↔ výplaty
**🟡 iba ručne.** Esblu neukladá `balance_transaction` ani `payout` (potvrdené aj v § 2 bod 3 testovacieho dokumentu).
Šablóna CSV pokrýva charge / refund / dispute / stripe_fee / payout a väzbu na bankový pohyb. Odporúčaná automatizácia
(až po rozhodnutí účtovníčky): mesačný read-only import `GET /v1/balance_transactions?payout=…` a `GET /v1/payouts`,
uložený do tabuľky `billing_ledger` (environment, txn, typ, hrubá/poplatok/čistá, payout, invoice, credit note). Kontrola:
súčet čistých súm = payout a payout = bankový pohyb. Vyžaduje oprávnenia *Balance transactions: read*, *Payouts: read*
(do runtime kľúča ich nepridávať, použiť samostatný read-only kľúč na reporting).

### 4.6 Daňové rozhodnutia (iba otázky, Esblu s. r. o. = registrácia § 7a, nie bežný platiteľ)

Nerozhodujem. Pre prevádzkovateľa a účtovníčku:

1. **Stripe Tax:** zapnúť (výpočet a evidencia), alebo nie? Ak nie, ako zaručiť správny text na faktúre pre SK B2B,
   EU B2B a B2C?
2. **Text o DPH na faktúre:** aký text uvádzať pri predaji SK odberateľovi, keď Esblu nie je platiteľ podľa § 4 (iba § 7a)?
   Uvádza sa IČ DPH pridelené podľa § 7a?
3. **EU B2B služba (napr. CZ):** miesto dodania, „prenesenie daňovej povinnosti“ na faktúre, súhrnný výkaz, overenie VIES
   a jeho archivácia. Má sa predaj do iných štátov EÚ vôbec otvoriť pri spustení? (technicky dnes nič neobmedzuje krajinu)
4. **B2C / SZČO bez IČ DPH v inom štáte:** OSS / registrácia. Má sa B2C pri spustení vylúčiť?
5. **Číslovanie:** stačí číselný rad Stripe (per zákazník, alebo per účet), alebo musí byť rad Esblu?
6. **Credit notes:** spôsob opravného dokladu pri plnej a čiastočnej refundácii a pri prehratom spore.
7. **48 h ochranná lehota:** dobrovoľné bezodplatné plnenie bez vplyvu na DPH a fakturáciu? (už v CLIA § 3.2 bod 4)
8. **Poplatky Stripe:** § 39 oslobodené vs. zdaniteľné; samozdanenie podľa § 7a z mesačnej daňovej faktúry Stripe
   (už v `payment-channels-economics` § 6 bod 2).
9. **Mena a kurz:** iba EUR? Má Checkout zakázať iné meny?
10. **Archivácia:** stačí ako úložisko Stripe, alebo treba vlastný archív PDF (10 rokov, aj po zrušení Stripe účtu)?
11. **Povinná štruktúrovaná e-faktúra (eFaktura / Peppol):** vzťahuje sa na Esblu (§ 7a) pri predaji predplatného SK
    platiteľom DPH, a od kedy? Od odpovede závisí § 5.

---

## 5. Riziko duplicitnej fakturácie: Stripe faktúra vs. e-faktúra (eFaktura.sk / Peppol)

**Riziko:** Stripe Billing vystaví faktúru **automaticky a vždy** (§ 4.1). Ak Esblu neskôr pre to isté predplatné
vystaví aj vlastnú faktúru vo svojom module a odošle ju ako štruktúrovanú e-faktúru cez eFaktura.sk (Peppol), napríklad
z internej firmy Esblu s. r. o., ktorá má interný tarif, vzniknú **dva doklady za jedno plnenie**. Dôsledky: rôzne čísla,
riziko dvojitého zaúčtovania výnosu, odberateľ si môže dvakrát uplatniť náklad, refundácia potrebuje opravný doklad
v oboch radoch a pri nesúlade súm (zaokrúhlenie, dátum dodania, obdobie) vzniknú rozdiely. Dnes v kóde
**nie je žiadna väzba** medzi `subscription_accounts` / Stripe invoice a modulom faktúr ani `einvoice-outbound`
(grep: `lib/einvoice/**` Stripe nepoužíva).

**Odporúčaný dizajn: jeden zdroj pravdy (rozhodnutie účtovníčky, potom implementácia)**

1. **Určiť jedného vystaviteľa daňového dokladu** pre predplatné:
   - **Variant A: daňový doklad = Stripe faktúra.** Esblu nevystavuje vlastnú faktúru za predplatné. Ak bude povinná
     štruktúrovaná e-faktúra, Esblu z finalizovanej Stripe faktúry vygeneruje **jej štruktúrovanú reprezentáciu
     (UBL/Peppol) s tým istým číslom a sumami**. Nejde o nový doklad. Credit note = Stripe credit note → jej UBL.
   - **Variant B: daňový doklad = faktúra Esblu (vlastný číselný rad + Peppol).** Stripe faktúra nesmie byť daňový doklad:
     vypnúť Stripe e-maily s faktúrou, v Portáli skryť históriu faktúr a v pätičke Stripe dokladu uviesť, že ide iba
     o potvrdenie platby (formuláciu schváli účtovníčka). Pozor: objekt Stripe Invoice vznikne aj tak.
   - Variant A je technicky jednoduchší (jeden číselný rad, jeden zdroj súm). Variant B dáva plnú kontrolu nad
     náležitosťami. Vybrať ho treba **pred** prvým live predajom.
2. **Väzbová tabuľka** (napr. `billing_invoice_documents`, environment-scoped, service-only):
   `unique (provider, environment, provider_invoice_id)`, `kind` (invoice/credit_note), `legal_issuer` (stripe/esblu),
   `legal_number`, sumy, mena, obdobie služby, `pdf_storage_path` + SHA-256, `einvoice_outbound_id`.
   Plní ju `invoice.paid` / `invoice.finalized` / `credit_note.created` cez tú istú pipeline (idempotentne podľa ID).
3. **Guard v e-faktúre:** outbound pre predplatné vznikne **iba** z tohto riadku. Unikát `(provider_invoice_id, kind)`
   a DB constraint zabránia vystaveniu druhého dokladu ručne v module faktúr pre tú istú Stripe faktúru.
   Ručné faktúry internej firmy Esblu s odberateľom = zákazníkom predplatného označiť varovaním.
4. **Refund → jediný opravný doklad** naviazaný na pôvodný riadok (credit note ID), nikdy samostatne v dvoch systémoch.
5. **Archív:** PDF zo Stripe (`invoice_pdf`) stiahnuť pri finalizácii do Storage (retencia 10 rokov) a zahrnúť do
   mesačného exportu (§ 4.3).

---

## 6. LIVE aktivačný checklist

Každý krok s ⛔ vyžaduje výslovný súhlas vlastníka. Tajomstvá zadáva **iba vlastník** priamo vo Verceli (typ *Sensitive*),
nikdy do chatu, repa ani DB. Poradie nadväzuje na `docs/billing-live-rollout-2026-11-19.md` § 2–4 a dopĺňa ho.

### 6.0 Predpoklady (blokujúce)
- [ ] CLIA: VOP (predplatné, 48 h, refundácie, spor), Zásady, DPA, `/subprocessors` (Stripe) publikované.
- [ ] Účtovníčka: rozhodnuté otázky § 4.6 (minimálne 1, 2, 3, 5, 6, 11) a variant A/B z § 5.
- [ ] Rozhodnuté, či sa pri spustení predáva iba SK B2B. Ak áno, obmedziť krajinu (Checkout/Stripe Radar pravidlo
      alebo validácia) a neotvárať B2C.
- [ ] (odporúčané) oprava § 2.3 (hash v doťahovaní) + test; pripnúť `STRIPE_API_VERSION`.
- [ ] ⛔ Produkčné migrácie `20261118120000` … `20261119140000` (8×, po jednej, `apply_migration`, nie `db push`),
      potom `20261120100000`; backup + dump pred nimi; `get_advisors` po každej.
- [ ] ⛔ Merge do `main` + produkčný deploy (billing ostáva `off`).

### 6.1 Aktivácia Stripe live účtu (vlastník)
- [ ] Účet Esblu s. r. o. (IČO 57815941): overenie firmy a konateľa (KYC), výplatný účet IBAN (SEPA), 2FA pre všetkých
      používateľov, role s minimom práv.
- [ ] Business details: obchodné meno, sídlo, IČO, DIČ, IČ DPH (§ 7a), podpora e-mail, URL VOP a Zásad.
- [ ] Invoice nastavenia podľa rozhodnutia účtovníčky: číslovanie (odporúčam rad **per účet**), prefix, pätička / text
      o DPH, custom fields, jazyk.
- [ ] Stripe Tax: zapnúť/vypnúť podľa § 4.6 bod 1 (nerozhodovať technicky).
- [ ] Customer emails: Successful payments / Finalized invoices / Refunds / Cancellation podľa VOP.
- [ ] Subscriptions & emails → Smart Retries: okno zladené so 7-dňovou lehotou Esblu; po vyčerpaní `canceled` alebo
      `unpaid` (Esblu: `account_hold`). Zapísať zvolené nastavenie do runbooku.
- [ ] Billing Portal: zrušenie **iba ku koncu obdobia**, bez prorácie, **bez** zmeny plánu a množstva, história faktúr
      podľa variantu § 5, aktualizácia platobnej metódy áno, fakturačná adresa a VAT ID podľa rozhodnutia.
- [ ] Payment methods v Checkout: karty (+ Apple/Google Pay); asynchrónne metódy (SEPA DD) **vypnuté** pri spustení
      (`async_payment_*` je síce podporené, ale neotestované).
- [ ] Radar: pravidlá (minimálne blokovanie krajín mimo rozsahu predaja, ak sa tak rozhodne).

### 6.2 Produkt a cena (vlastník)
- [ ] Produkt „Esblu Komplet“, cena **15,90 EUR / mesiac**, recurring, `tax_behavior` podľa rozhodnutia účtovníčky
      (inclusive/exclusive/unspecified), jedna cena = jedna položka (adaptér odmietne viac položiek).
- [ ] `price_…` ID poslať agentovi (nie je tajné) → prod DB `billing_provider_prices` (`stripe`, `live`, `esblu_complete`,
      `month`, `active=true`); test fixtures v prod DB nastaviť `active=false`.

### 6.3 Restricted live kľúč `rk_live_…` (minimálne oprávnenia podľa kódu)
| Zdroj | Právo | Použitie v kóde |
|---|---|---|
| Checkout Sessions | Write | `POST /checkout/sessions`, `…/expire`, `GET` (`stripe.ts:282-328`) |
| Subscriptions | Write | `GET`, `POST` (cancel_at_period_end, change), `DELETE` (`stripe.ts:330-375`) |
| Customer portal (Billing portal sessions) | Write | `POST /billing_portal/sessions` (`:377`) |
| Invoices | Read | `GET /invoices/{id}` (`:532`) |
| Invoice payments | Read | `GET /invoice_payments` (`:445`, `:523`) |
| PaymentIntents | Read | `GET /payment_intents/{id}?expand=latest_charge` (`:451`) |
| Charges | Read | `GET /charges/{id}` (`:593`) |
| Disputes | Read | `GET /disputes?charge=` (`:460`) |
| Events | Read | `GET /events` (`:405`) |
| Account (Connect/Account) | Read | `GET /account` (`:386`). **Overiť**, že restricted kľúč smie čítať vlastný účet |
| Customers | Read (Write iba ak Checkout s `customer_update` vyžaduje) | Kód Customers API priamo nevolá. Začať s Read a pri chybe Checkoutu zvýšiť |
| Refunds, Payouts, Balance | **žiadne** | Refundy robí operátor v Dashboarde; reporting samostatným read-only kľúčom |
| Prices / Products | žiadne (kód ich nevolá) | Rollout dokument uvádza Prices read: neškodí, ale nie je potrebné |

- [ ] Po vytvorení: jednorazová read-only kontrola mimo produkcie zakázaná (live kľúč mimo produkcie = chyba). Overenie
      preto až v kroku 6.7 (interný nákup + manuálny beh cronu s `CRON_SECRET`).

### 6.4 Webhook endpoint + secret (vlastník)
- [ ] Endpoint `https://www.esblu.com/api/billing/webhooks/stripe`, **live mode**, snapshot udalosti, **API verzia =
      `STRIPE_API_VERSION`** (otestovaná v sandboxe).
- [ ] Udalosti: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
      `checkout.session.expired`, `customer.subscription.created|updated|deleted|paused|resumed|trial_will_end`,
      `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `charge.refunded`,
      `charge.dispute.created`, `charge.dispute.closed` (+ podľa § 5 neskôr `invoice.finalized`, `credit_note.created`).
- [ ] `whsec_…` → Vercel `STRIPE_LIVE_WEBHOOK_SECRET`. Notifikačný e-mail Stripe o zlyhaných doručeniach na monitorovanú
      schránku.

### 6.5 Premenné vo Verceli (iba názvy; rozsah **iba Production**, typ Sensitive pri tajomstvách)
- `ESBLU_BILLING_MODE=stripe_live`
- `STRIPE_LIVE_SECRET_KEY` (secret)
- `STRIPE_LIVE_WEBHOOK_SECRET` (secret)
- `ESBLU_BILLING_RETURN_ORIGIN=https://www.esblu.com`
- `STRIPE_API_VERSION` (odporúčané pripnúť)
- `CRON_SECRET` (existuje; ≥ 16 znakov)
- `ESBLU_BILLING_LIVE_APPROVED=true`: **až v kroku schválenia** (kill switch)
- `NEXT_PUBLIC_ESBLU_BILLING_UI=1`: až po allowlist teste
- **Nesmú byť v Production:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ESBLU_FAKE_BILLING_SECRET` (inak `TEST_CONFIG_IN_LIVE`
  → billing beží ako vypnutý). **Nesmú byť v Preview/Development:** žiadne `STRIPE_LIVE_*`, `ESBLU_BILLING_LIVE_APPROVED`.

### 6.6 Crony
- [ ] `vercel.json`: `/api/cron/billing-stripe-events` `*/15 * * * *`, `/api/cron/billing-reconcile` `23 */6 * * *`
      (už v repe, bežia iba na produkcii; do schválenia `configured:false`).
- [ ] Po schválení: prvý beh doťahovania = **bootstrap** (`bootstrap:true`), `billing_event_cursors` (`live`) = live `acct_…`,
      `consecutive_failures=0`.

### 6.7 Allowlist-first rollout
1. [ ] ⛔ Premenné 6.5 bez `ESBLU_BILLING_LIVE_APPROVED` → redeploy → webhook vracia 404, `purchase-options` 404.
2. [ ] ⛔ Prod DB: cena live; `billing_runtime_config` → `environment='live'`, `enabled_methods={stripe_web_checkout}`,
       `allow_mock_plans=false`, `web_provider='none'`.
3. [ ] ⛔ `ESBLU_BILLING_LIVE_APPROVED=true` → redeploy. Overiť: cron doťahovania 200 `configured:true`, webhook test
       z Dashboardu (*Send test event*) → 200/`ignored`.
4. [ ] ⛔ `billing_live_purchase_allowlist` = interná firma Esblu s. r. o.; `live_purchase_scope='allowlist'`;
       `web_provider='stripe'`; `NEXT_PUBLIC_ESBLU_BILLING_UI=1` → redeploy.
5. [ ] Interný test **vlastnou kartou**: nákup → aktivácia (9 nárokov) → **skontrolovať Stripe faktúru** (náležitosti,
       číslo, text o DPH, e-mail) → zrušenie ku koncu obdobia → plná refundácia cez **credit note** (podľa § 4.4) →
       `refunded` + ukončené v Stripe → cron doťahovania bez chýb → reconciliation `in_sync`. Iná firma: žiadne webové
       kanály, priamy pokus `403 ESBLU_BILLING_LIVE_NOT_ALLOWED`.
       **Konflikt:** interná firma má interný neobmedzený tarif (`source='manual'`), takže nárok na moduly test nepreukáže.
       Na overenie nárokov použiť **inú** internú firmu bez interného grantu, alebo overovať `subscription_accounts`
       a nároky `source='subscription'`.
6. [ ] Účtovníčka skontroluje prvý doklad a prvý payout, vyplní šablónu CSV za prvý mesiac.
7. [ ] ⛔ Otvorenie predaja: `live_purchase_scope='all'`.

### 6.8 Monitoring a alerty (minimum pred krokom 6.7.7)
- [ ] Stripe: e-mail pri zlyhaní webhooku, pri spore, pri payout failure.
- [ ] Vercel: alert (alebo log drain) na 5xx `/api/billing/*` a `/api/cron/billing-*`.
- [ ] Denná kontrola (cron alebo ručne, kým neexistuje alerting): `billing_events.status='failed'` a `conflict`
      za 24 h, `billing_event_cursors` (`last_success` starší ako 1 h, `consecutive_failures>0`, `error_code` ∈
      {`ACCOUNT_MISMATCH`,`CURSOR_EXPIRED`}), `billing_reconciliation.dead_letter=true`, účty `refunded/revoked`
      s otvoreným predplatným, udalosti `REFUND_NEEDS_OPERATOR` / `DISPUTE_NEEDS_OPERATOR`.
- [ ] Prvých 14 dní: denný záznam v `docs/ops/service-intervention-log.md`.

### 6.9 Kill switch a rollback
| Úroveň | Akcia | Dopad |
|---|---|---|
| **R2 (preferované)** pozastavenie predaja | `web_provider='none'` alebo `live_purchase_scope='allowlist'` | nové nákupy stop; obnovy, webhooky, doťahovanie a reconciliation bežia |
| **R1** kill switch | odstrániť `ESBLU_BILLING_LIVE_APPROVED` + redeploy | všetko `off` vrátane obnov (webhook 404, Stripe opakuje 3 dni, potom doťahovanie po znovuzapnutí). Iba krátkodobo. Pozor: Stripe môže endpoint po dlhom zlyhávaní **vypnúť** |
| **R3** kód | Vercel Instant Rollback | starý kód má produkciu tvrdo `off` (= R1) |
| **R4** migrácia | rollback `20261119130000` iba ak live **nikdy** nebežal | po live platbách sa nerobí (účtovné dáta) |
| Stripe strana | pozastaviť predaj aj v Stripe: deaktivovať cenu / Payment Links; **predplatné nerušiť hromadne** bez rozhodnutia vlastníka | — |
| Zmena live účtu | doťahovanie `ACCOUNT_MISMATCH`; reset kurzora `live` iba vedome | — |

---

## 7. Rozhodnutia, ktoré môže urobiť iba prevádzkovateľ (a účtovníčka / CLIA)

1. Variant dokladov: **Stripe faktúra = daňový doklad**, alebo **faktúra Esblu (+ Peppol)** (§ 5).
2. Odpovede na daňové otázky § 4.6 (Stripe Tax, text o DPH pri § 7a, EU B2B reverse charge, B2C/OSS, číslovanie,
   credit notes, povinná e-faktúra).
3. Rozsah predaja pri spustení (iba SK B2B?), meny (iba EUR?), platobné metódy (bez SEPA DD?).
4. Nastavenia Stripe: Portál (zrušenie ku koncu obdobia, zmena plánu nie), Smart Retries vs. 7 dní, zákaznícke e-maily.
5. Postup refundácie (cez credit note) a kto ju smie robiť; politika čiastočnej refundácie (prístup sa nemení).
6. Archivácia: vlastný archív PDF v Esblu áno/nie a retencia.
7. Či opraviť § 2.3 a pripnúť `STRIPE_API_VERSION` pred spustením (odporúčané áno).
8. Ktorá interná firma (bez interného grantu) bude allowlist testovacím zákazníkom.
9. Súhlasy ⛔: produkčné migrácie, merge/deploy, každý krok 6.7, otvorenie predaja.
10. Alerting: kam chodia upozornenia (e-mail/Slack) a kto ich rieši.
