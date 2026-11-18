# Stripe test režim, scenáre predplatného a mesačné párovanie (2026-11-18)

Zdroj kódu: `main` @ `12da726`. Predaj cez platobné brány = **iba vlastné predplatné Esblu**. Všetko v tomto dokumente je
test režim / syntetické údaje; produkcia má billing vypnutý kódom (`VERCEL_ENV=production` → `off`, `lib/billing/config.ts`).

## 1. Čo je dostupné (overené 2026-11-18)

| Položka | Stav | Dôkaz |
|---|---|---|
| Stripe účet / test režim | **neprístupný** — vstavaný prehliadač nie je prihlásený, Stripe konektor nie je k dispozícii | dashboard.stripe.com → prihlasovacia stránka |
| Testovacie kľúče a webhook secret | **chýbajú** — vo Verceli `esblu` nie je žiadna `STRIPE_*`, `ESBLU_BILLING_MODE` ani `ESBLU_BILLING_RETURN_ORIGIN` (Production ani Preview) | Vercel API, iba názvy premenných |
| Produkty / ceny Stripe | **neexistujú v DB stagingu** — `billing_provider_prices` na `esblu-test` má iba `fake` / `google` / `apple` test ceny pre `test_starter` / `test_pro`; plán `esblu_complete` existuje bez Stripe ceny | read-only SQL na `esblu-test` |
| `billing_runtime_config` (staging) | `web_provider='none'`, `environment='test'`, 0 účtov, 0 eventov (čistý stav po QA 2026-10-11) | read-only SQL |
| Stripe adaptér v kóde | hotový, iba test kľúče (`sk_test_`/`rk_test_`, `livemode:false`), hosted Checkout, Billing Portal, cancel/resume, refund, dispute | `lib/billing/providers/stripe.ts` |
| Režim servera | `ESBLU_BILLING_MODE=stripe_test` + `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + `ESBLU_BILLING_RETURN_ORIGIN`; webhook `POST /api/billing/webhooks/stripe` | `lib/billing/config.ts` |

**Záver:** reálny Stripe test režim sa dnes nedá spustiť samostatne. Všetky scenáre som prešiel cez existujúce simulácie
(mock Stripe API s reálnymi tvarmi objektov + PGlite Postgres s produkčnými migráciami). Reálne overenie je pripravené ako
runbook v § 4 — chýbajú 3 kroky vlastníka.

### Výsledky simulácií (spustené 2026-11-18 na `12da726`, Node 22, PGlite 0.5.8)

| Suita | Výsledok |
|---|---|
| `test:subscriptions` | 28 / 28 PASS |
| `test:subscriptions-db` | 60 / 60 PASS |
| `test:subscriptions-lifecycle` (unit) | PASS |
| `test:subscriptions-lifecycle-db` | 69 / 69 PASS |
| pomenované: `stripe-adapter`, `webhook-idempotency`, `purchase-idempotency`, `subscription-refund-revoke`, `subscription-rbac`, `subscription-cross-device`, `subscription-concurrency`, `reconciliation`, `billing-ui`, `account-deletion-subscription` | všetky PASS |

## 2. Scenáre (tabuľka testov)

Legenda: **SIM PASS** = overené simuláciou dnes · **REAL —** = čaká na Stripe test účet (§ 4) · prístup = nárok firmy na moduly plánu.

| # | Scenár | Stav v Stripe (očakávaný) | Stav predplatného v Esblu | Prístup firmy | Simulácia | Reálny Stripe test |
|---|---|---|---|---|---|---|
| S1 | Nákup ako vlastník (hosted Checkout, karta `4242…`) | Checkout `complete`, subscription `active`, invoice `paid` | `active`, plán z `billing_provider_prices` (server, nie klient) | moduly plánu ON na webe aj v appke (ten istý RPC) | SIM PASS (`stripe-adapter`, `subscription-cross-device`) | REAL — |
| S2 | Odmietnutá platba v Checkout (`4000 0000 0000 0002`) | Checkout ostane `open`, žiadna subscription | žiadny účet; zámer `open` → `expired` po 24 h | bez zmeny (trial / zamknuté) | SIM PASS (failure matrix: nič sa nezapíše) | REAL — |
| S3 | Obnova (test clock +1 mesiac) | `invoice.paid`, nové obdobie | `active`, `current_period_end` posunutý; platba zapísaná do `billing_store_reports` iba pre kanály s reportingom | ON | SIM PASS (lifecycle, reconciliation) | REAL — |
| S4 | Zlyhanie obnovy (`4000 0000 0000 0341`) | `invoice.payment_failed`, subscription `past_due`, Smart Retries | `past_due`, `grace_until` = +7 dní | ON do `grace_until`, potom OFF | SIM PASS (`subscriptions-lifecycle-db` grace) | REAL — |
| S5 | Opakovanie platby úspešné (zmena karty v Portáli → retry) | invoice `paid`, `active` | `active`, grace zrušený | ON | SIM PASS | REAL — |
| S5b | Retry vyčerpané | `unpaid` (alebo `canceled` podľa nastavenia Billing) | `account_hold` / `canceled` | OFF, dáta ostávajú | SIM PASS | REAL — |
| S6 | Vypnutie obnovovania (Esblu „Zrušiť“ alebo Portál) | `cancel_at_period_end=true` | `active` + `cancel_at_period_end` | ON do konca zaplateného obdobia (+ 2 dni buffer), potom `canceled` → OFF | SIM PASS (`subscriptions-lifecycle`, staging 15.5) | REAL — |
| S6b | Obnovenie pred koncom obdobia („Pokračovať“) | `cancel_at_period_end=false` | `active` | ON | SIM PASS | REAL — |
| S7 | Zrušenie rozpracovanej platby (zatvorený Checkout) | `checkout.session.expired` | iba audit (`AUDIT_ONLY`); zámer `expired`; nový nákup povolený | bez zmeny | SIM PASS | REAL — |
| S8 | Plná refundácia (Dashboard → Refund celé) | `charge.refunded`, `amount_refunded = amount` | `refunded` (terminálny), refund charge zapísaný | **OFF okamžite**, dáta ostávajú; nový nákup = nové predplatné | SIM PASS (`subscription-refund-revoke`) | REAL — |
| S9 | Čiastočná refundácia | `charge.refunded`, `amount_refunded < amount` | bez zmeny stavu, iba refund charge | **bez zmeny** (prístup ostáva) — produktové/CLIA rozhodnutie | SIM PASS | REAL — |
| S10 | Spor otvorený (`4000 0000 0000 0259`) | `charge.dispute.created` | `review_flag=dispute_open` | **bez zmeny** do rozhodnutia | SIM PASS | REAL — |
| S10b | Spor prehratý / vyhratý | `charge.dispute.closed` lost / won | lost → `revoked`; won → príznak zmazaný | lost → OFF; won → ON | SIM PASS | REAL — |
| W1 | Neplatný podpis webhooku | — | `rejected` 4xx, nič sa nezapíše | bez zmeny | SIM PASS (`webhook-idempotency`) | REAL — (Stripe CLI `--skip-verify` nie; podvrhnutý header) |
| W2 | Duplicitná udalosť (rovnaké `evt_…` 10×) | — | 1× applied, 9× duplicate; 1 účtovný záznam | správny | SIM PASS + staging 10 backendov (2026-10-11) | REAL — (Dashboard → Resend event) |
| W3 | Oneskorená / staršia udalosť po novšej | — | `stale`; adaptér vždy znova načíta subscription z API | správny | SIM PASS | REAL — |
| W4 | Live event v test režime | — | `LIVE_MODE_FORBIDDEN` | bez zmeny | SIM PASS | — |
| C1 | Súbežné pokusy o nákup (2 manažéri, 2 karty) | 2 Checkouty | druhý zámer `ALREADY_SUBSCRIBED`; ak prejdú oba → `conflict`, žiadny druhý nárok | 1 nárok | SIM PASS + staging (test C/D) | REAL — (pozn.: 2. platba v Stripe vtedy vznikne → refund operátorom, § 3) |
| C2 | Web + Google súčasne | — | 1 applied, 1 `conflict` | 1 nárok | SIM PASS + staging (test E) | — |
| I1 | Izolácia firiem (cudzí `client_reference_id` / metadata) | — | `CROSS_TENANT_IDENTIFIER`, žiadny nárok | bez zmeny | SIM PASS | REAL — |
| R1 | Oprávnenia: owner kupuje; admin / účtovník / zamestnanec nie | — | `FORBIDDEN` pre nevlastníka (owner-only od 2026-10-26) | — | SIM PASS (`subscription-rbac`) + staging 5 rolí | REAL — (UI) |

Zistenia z revízie kódu (nemenené, na rozhodnutie):

1. **C1 — dvojitá platba:** ak dva Checkouty dobehnú v Stripe, DB správne odmietne druhé predplatné (`conflict`), ale druhá
   karta je stiahnutá. Treba operátorský postup „conflict → zrušiť subscription + plná refundácia“ (dnes iba event pre operátora).
2. **S9 — čiastočná refundácia nemení prístup.** Je to zámer kódu; potvrdiť v podmienkach predplatného (CLIA, § 6 nižšie).
3. **Doklady:** Esblu dnes neukladá Stripe `balance_transaction` (poplatok, čistá suma, výplata). Mesačné párovanie preto
   ide zo Stripe reportov (§ 5), nie z DB Esblu. Ak chce účtovníčka automatiku, treba nový import reportu — až po jej rozhodnutí.
4. **Viac položiek na jednom predplatnom** (Komplet + add-on) adaptér odmietne (`UNKNOWN_PRICE`, iba 1 položka). Pri moduloch
   a add-onoch to znamená samostatné platby a fixný poplatok 0,25 € každá — pozri ekonomiku.

## 3. Čo bude robiť vlastník (bežné prípady a výnimky)

| Situácia | Kde / kto | Výsledok pre zákazníka | Prístup |
|---|---|---|---|
| Vypnutie obnovovania | zákazník (vlastník firmy) v Esblu → Nastavenia → Predplatné → „Zrušiť“ (alebo Stripe Portál z rovnakej obrazovky) | potvrdenie na obrazovke + e-mail zo Stripe (zapnúť „Cancellation emails“ v Billing nastaveniach) | do konca zaplateného obdobia |
| Obnovenie | to isté → „Pokračovať“ | potvrdenie | bez prerušenia |
| Zmena karty, faktúry | Stripe Portál (tlačidlo v Esblu) | Stripe e-maily s faktúrou / potvrdením platby | — |
| Zlyhaná platba | automaticky Smart Retries + e-mail Stripe; vlastník Esblu nič nerobí | e-mail „platba zlyhala“ s odkazom na úhradu | 7 dní grace, potom zamknuté |
| **Refundácia (výnimka)** | majiteľ Esblu v **Stripe Dashboard → Payments → Refund** (plná / čiastočná) + dôvod; Esblu sa aktualizuje webhookom | e-mail od Stripe o vrátení (zapnúť „Refunds“ e-maily) + opravný doklad od Esblu podľa účtovníčky | plná → okamžite zamknuté (dáta ostávajú); čiastočná → bez zmeny |
| **Spor** | Stripe Dashboard → Disputes → odpoveď s dôkazmi (faktúra, prihlásenia, VOP) do termínu | — | počas sporu bez zmeny; prehratý → zamknuté |
| **Dvojitá platba (C1)** | Stripe: zrušiť duplicitnú subscription + plná refundácia; v Esblu nič (druhé predplatné nemá nárok) | e-mail o vrátení | bez zmeny |
| Zákazník chce zrušiť a vrátiť peniaze | podľa podmienok predplatného (CLIA) — buď vypnutie obnovy, alebo refundácia ako výnimka | — | — |

Navrhovaná zmena kódu (neimplementovaná, čaká na CLIA texty): e-mail z Esblu cez Resend pri `refunded` / `revoked`
(„prístup k modulom bol ukončený, dáta ostávajú“) — dnes zákazník vidí iba stav v aplikácii a e-mail od Stripe.

## 4. Runbook — reálny Stripe test na stagingu (po krokoch)

**Kroky vlastníka (cena 0 €, test režim nič neúčtuje):**

1. Vytvoriť / otvoriť Stripe účet Esblu s.r.o. a prepnúť na **Test mode** (alebo Sandbox). Bez aktivácie live účtu.
2. V test režime vytvoriť produkt **Esblu Komplet**, cena **15,90 EUR / mesiac** (recurring) a poslať mi `price_…` ID.
3. Developers → API keys → **Restricted key** (`rk_test_…`) s právami: Checkout Sessions write, Customers write,
   Subscriptions write, Billing Portal write, Invoices read, Charges read, Refunds write, Disputes read; webhook endpoint
   `https://<preview-host>/api/billing/webhooks/stripe` s eventmi `checkout.session.*`, `customer.subscription.*`,
   `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `charge.refunded`, `charge.dispute.created`,
   `charge.dispute.closed`. Kľúč a `whsec_…` zadať **iba** vo Verceli → `esblu` → Environment Variables → **Preview**,
   obmedzené na vetvu `android-release-payments-ios-2026-11-18` (nikdy Production):
   `ESBLU_BILLING_MODE=stripe_test`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ESBLU_BILLING_RETURN_ORIGIN=<preview origin>`,
   `NEXT_PUBLIC_ESBLU_BILLING_UI=1`.

**Moje kroky (agent, staging `esblu-test`):**

4. `insert into billing_provider_prices (provider, environment, plan_code, billing_interval, provider_price_id, active)
   values ('stripe','test','esblu_complete','month','price_…',true)` a `update billing_runtime_config set web_provider='stripe'`.
5. Syntetické firmy `QA-STRIPE A/B` (owner, admin, accountant, employee) cez staging SQL — bez osobných údajov.
6. Prejsť S1–S10b (test cards + Stripe **test clocks** na obnovy), W1–W3 (Resend event, podvrhnutý podpis), C1 (dva prehliadače),
   I1, R1. Pri každom zapísať: Stripe ID objektu, stav v Stripe, `esblu_billing_explain_my_entitlements`, prístup na webe aj v appke.
7. Cleanup: firmy QA, účty, eventy na stagingu; `web_provider='none'`; Stripe test dáta ostanú v test režime (neúčtujú sa).

## 5. Vzor mesačného párovania pre účtovníčku

**Zdroje:** Stripe → Reports → **Payout reconciliation** (itemized, za mesiac) a **Balance change from activity**;
mesačná daňová faktúra Stripe (Documents); bankový výpis (Fio); faktúry / opravné doklady Esblu.
Mena: EUR (bez konverzie; ak by sa objavila iná mena, stĺpec `kurz` = kurz Stripe z balance transaction, nie ECB).

Šablóna CSV: `docs/finance/stripe-monthly-reconciliation-template.csv`. Jeden riadok = jedna balance transaction.

| Stĺpec | Zdroj | Príklad (syntetický) |
|---|---|---|
| `obdobie` | mesiac výkazu | 2026-12 |
| `typ` | charge / refund / dispute / dispute_reversal / stripe_fee / payout | charge |
| `stripe_balance_txn_id` | `txn_…` | txn_TEST001 |
| `stripe_source_id` | `ch_…` / `re_…` / `du_…` / `po_…` | ch_TEST001 |
| `stripe_invoice_id` | `in_…` (pri platbe predplatného) | in_TEST001 |
| `stripe_subscription_id` | `sub_…` | sub_TEST001 |
| `esblu_firma_ico` | z faktúry Esblu (nie zo Stripe metadata) | 99999991 |
| `datum_vytvorenia` | `created` (UTC) | 2026-12-01 |
| `datum_dostupnosti` | `available_on` | 2026-12-04 |
| `mena` / `kurz` | currency / exchange_rate | EUR / 1 |
| `hruba_suma` | amount | 15,90 |
| `poplatok` | fee | -0,70 |
| `cista_suma` | net | 15,20 |
| `payout_id` / `datum_payoutu` | `po_…` / arrival_date | po_TEST001 / 2026-12-04 |
| `bankovy_pohyb_id` | ID pohybu z výpisu | FIO-20261204-01 |
| `doklad_esblu` | číslo faktúry / opravného dokladu Esblu | 2026120001 |
| `stav_parovania` | OK / ROZDIEL / CHÝBA_DOKLAD | OK |
| `poznamka` | dôvod rozdielu | — |

**Postup (mesačne, do 10. dňa po stiahnutí daňovej faktúry Stripe):**

1. Stiahnuť Payout reconciliation (itemized) za mesiac. Súčet `cista_suma` riadkov jedného payoutu = suma payoutu.
2. Každý payout spárovať s pohybom na výpise (suma + dátum ± 2 prac. dni + referencia `STRIPE` / payout ID).
3. Každý `charge` spárovať s faktúrou Esblu (hrubá suma = suma faktúry); `refund` s opravným dokladom; `dispute` s internou
   poznámkou a prípadne opravným dokladom po prehre.
4. Poplatky (`fee` po riadkoch + samostatné `stripe_fee`, napr. Billing 0,7 %, spor 20 €) odsúhlasiť so mesačnou daňovou
   faktúrou Stripe; z ich zdaniteľnej časti vypočítať DPH 23 % (§ 69 ods. 3) podľa rozhodnutia účtovníčky.
5. **Rozdiel:** (a) payout ≠ súčet riadkov → stiahnuť report znova (oneskorené transakcie patria do nasledujúceho payoutu);
   (b) charge bez faktúry Esblu → vystaviť / doplniť; (c) faktúra bez charge → skontrolovať zlyhanú platbu / grace;
   (d) bankový pohyb bez payoutu → nepatrí Stripe. Každý rozdiel zapísať do `poznamka`, nič nezaokrúhľovať.
6. Automatické účtovanie (import do účtovníctva) zapnúť až po potvrdení analytiky a režimu DPH účtovníčkou.

**Ak dodávateľ (Stripe alebo iný) vyčíslil DPH:** (1) skontrolovať, či bolo v profile zadané IČ DPH Esblu; (2) doplniť
IČ DPH a požiadať o opravnú faktúru bez DPH; (3) do rozhodnutia účtovníčky účtovať DPH dodávateľa ako náklad a **neodvádzať**
slovenskú DPH duplicitne; (4) zapísať do evidencie § 70 s poznámkou.

## 6. Otázky do podmienok predplatného (pre CLIA)

Pozri `docs/clia-delta-2026-11-24-draft.md` § 3: kto je predajca, kedy vzniká nárok na refund, či čiastočná refundácia
mení prístup, čo sa deje s dátami po ukončení, ako zákazník vypína obnovovanie a lehoty oznámení o zmene ceny.
