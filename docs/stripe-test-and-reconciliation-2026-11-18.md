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

1. **C1 — dvojitá platba: OPRAVENÉ (2026-11-18, § 7).** Pôvodne dva súbežné pokusy vytvorili dva zámery a dve zaplatiteľné
   relácie; DB odmietla iba druhé predplatné (`conflict`) a druhá karta bola stiahnutá. Teraz má firma najviac jeden
   zaplatiteľný webový checkout. Operátorský postup „conflict → zrušiť + refund“ ostáva ako poistka pre anomálie providera.
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

## 7. Oprava: jedna zaplatiteľná relácia na firmu (2026-11-18)

Ostré platby ostávajú vypnuté (DB `environment='test'`, `VERCEL_ENV=production` → billing off, iba `sk_test_`/`rk_test_`).

| Vrstva | Zmena | Súbor |
|---|---|---|
| DB | `esblu_billing_create_purchase_intent` (pod advisory lockom firmy): otvorený webový zámer s rovnakým plánom/intervalom/kanálom/cenou → **ten istý zámer** (`reused: true`); iný plán/kanál → `ESBLU_BILLING_CHECKOUT_IN_PROGRESS`; webový zámer platí **1 h**; expirované sa uzavrú automaticky; zámer bez relácie s < 31 min platnosti sa nahradí | `supabase/migrations/20261118120000_billing_single_open_checkout.sql` |
| DB poistka | čiastočný unikátny index `billing_checkout_sessions_one_open_web_idx` (company) pre `created/open` a `stripe/fake` | to isté |
| DB | `esblu_billing_attach_checkout_session` idempotentné; nové `esblu_billing_checkout_for_cancel` (owner) a `esblu_billing_mark_checkout_expired` (iba service_role) | to isté; rollback `supabase/rollback/20261118120000_…_rollback.sql` |
| Stripe adaptér | `expires_at` = koniec zámeru (rovnaké parametre pri opakovaní); pri `409 idempotency_key_in_use` počká a zopakuje; `expireCheckout` (`/checkout/sessions/{id}/expire`, inak rozhodne stav relácie) | `lib/billing/providers/stripe.ts`, `lib/billing/types.ts` |
| Server | spoločný `startWebCheckout`: Idempotency-Key `esblu-checkout-<zámer>`, 1 okamžité opakovanie po výpadku, idempotentné priradenie | `lib/billing/web-checkout.ts`, `app/api/billing/checkout/route.ts`, `app/api/billing/purchase-intent/route.ts` |
| Zrušenie | `POST /api/billing/checkout/[id] {action:"cancel"}`: najprv expirácia u providera, potom uzavretie zámeru; dokončenú platbu neruší | `app/api/billing/checkout/[id]/route.ts` |
| UI | návrat `?checkout=canceled` zavolá zrušenie; hláška `checkoutInProgress` (SK/EN/DE) | `app/nastavenia/predplatne/page.tsx`, `lib/i18n/dictionaries/*` |
| Fake checkout | po uplynutí platnosti zámeru už nie je zaplatiteľný (ako Stripe) | `app/api/billing/fake/complete/route.ts` |

### Výsledky testov opravy

| Test | Prostredie | Výsledok |
|---|---|---|
| dve karty / dvaja manažéri súbežne, rovnaký plán → 1 zámer (1× `reused:false`, 2× `true`), attach 2× OK, iná relácia odmietnutá | PGlite (produkčné migrácie) | PASS |
| iný plán / interval počas otvorenej relácie → `CHECKOUT_IN_PROGRESS`; zrušenie (owner OK, zamestnanec FORBIDDEN, iná firma `found:false`, `mark_expired` iba service_role) → nový zámer | PGlite | PASS |
| výpadok: zámer bez relácie → opakovanie = ten istý zámer; < 31 min → nový; expirovaný → uzavretý | PGlite | PASS |
| unikátny index + forward-only (bez DROP/TRUNCATE/DELETE) | PGlite | PASS |
| Stripe mock: dve súbežné požiadavky, druhá dostane 409 → **1 relácia**, rovnaký `Idempotency-Key` aj `expires_at` | unit | PASS |
| Stripe mock: relácia vznikla, odpoveď 504 → opakovanie vráti **tú istú reláciu** (aj pri opakovaní klientom po 502) | unit | PASS |
| zrušenie: open → expired; dokončená relácia → `complete` (neruší sa) | unit | PASS |
| **10 skutočných paralelných Postgres spojení** (dblink, bariéra, rozptyl 32 ms), owner firmy QA-A, rovnaký plán | staging `esblu-test` | PASS — 1 zámer, 1× `reused=false`, 9× `reused=true` |
| 5 paralelných spojení, 4× Pro + 1× Starter | staging | PASS — prvý (Starter) vytvoril zámer, 4× `CHECKOUT_IN_PROGRESS` |
| izolácia: owner firmy B nevidí/neruší zámer A (`found:false`), `mark_expired`/`attach` permission denied; zamestnanec A FORBIDDEN, tabuľka nedostupná; owner B má vlastný nezávislý zámer | staging | PASS |
| regresia: `test:subscriptions` 28, `test:subscriptions-db` 60, `test:subscriptions-lifecycle` 47, `test:subscriptions-lifecycle-db` 73, `billing-ui`, `account-deletion-subscription`, `native-billing-contract` 13 | lokálne | PASS |

Staging po teste: zámery QA uzavreté, `web_provider='none'`, dočasná rola `qa_checkout_runner`, schéma a rozšírenie `dblink`
odstránené. Ostali syntetické firmy `QA-CHECKOUT A/B` (bez osobných údajov) pre test v prehliadači. Advisors: bez ERROR,
rovnaké WARN/INFO ako baseline (owner RPC `security definer` je zámerný).

### Test v dvoch kartách prehliadača (2026-11-18, PASS)

Prostredie: Vercel Preview `dpl_As98TG1h6bx2PboMdnRYApY2WbyD` (SHA `bac46e4`, alias
`esblu-git-android-release-payments-ios-2026-11-18-esblu.vercel.app`, fra1) → Supabase staging `cjbdijbbcujvmrzezusd`
(overené z relácie v prehliadači). Billing iba pre túto vetvu v Preview: `ESBLU_BILLING_MODE=fake`, testovací fake secret,
`NEXT_PUBLIC_ESBLU_BILLING_UI=1`; staging `web_provider='fake'` počas testu. Syntetický owner `QA-CHECKOUT A`.

| # | Krok | Výsledok |
|---|---|---|
| B1 | Dve karty, „Pokračovať na platbu“ (Pro) naplánované na **ten istý okamih** (obe kliky 12:29:45.333 UTC) | obe karty presmerované na **ten istý** `checkout_id` `1d58a73c-…`; v DB 1 zámer `open` s jednou reláciou |
| B2 | Druhá karta: iný plán (Starter) / iný interval (ročne) | `409 ESBLU_BILLING_CHECKOUT_IN_PROGRESS`; UI: „Pre firmu už prebieha iná rozpracovaná platba. Dokončite ju alebo ju zrušte a skúste znova.“ |
| B3 | Výpadok spojenia: požiadavka zrušená po 5 ms (AbortError), opakovanie po 1,5 s | opakovanie vrátilo **ten istý** `checkout_id` (`reused:true`) |
| B4 | 3 ďalšie súbežné požiadavky z karty | 3× ten istý `checkout_id`, `reused:true` |
| B5 | Zaplatenie v prvej karte (fake „úspešná platba“) | zámer `completed`, predplatné `active` (test_pro, fake), **1** spracovaný event |
| B6 | Druhá karta sa pokúsi zaplatiť ten istý checkout | `409 ESBLU_BILLING_CHECKOUT_STATE` — žiadna druhá platba |
| B7 | Nový nákup po zaplatení | `409 ESBLU_BILLING_ALREADY_SUBSCRIBED` |

Nepokryté v prehliadači: zrušenie rozpracovanej platby cez `POST /api/billing/checkout/[id]` (overené PGlite + unit; E2E
v prehliadači neprebehlo, firma A už mala predplatné).

Po teste: staging `web_provider='none'`, QA používatelia `banned_until=infinity`, heslo zneplatnené, relácie zmazané;
Preview premenné vetvy prepnuté na `ESBLU_BILLING_MODE=off`, `NEXT_PUBLIC_ESBLU_BILLING_UI=0`, fake secret zneplatnený
(zmazanie premenných vetvy môže vlastník spraviť vo Verceli). Produkcia sa nemenila; ostré platby vypnuté.
Vedľajší nález: na `/nastavenia/predplatne` sa zobrazovali nepreložené kľúče `subscription.planPanel.*` — **opravené 19. 11. 2026**: preklady (sk/en/de) existovali, ale boli omylom vnorené v `settings…deletion.subscription.planPanel`; presunuté do `subscription.planPanel`, doplnené `subscription.plans.esblu_complete`. Kontrola: všetky statické kľúče `subscription.*` použité v kóde existujú v sk/en/de, `test:i18n` 114/114, `tsc` 0 chýb.

## 8. Stripe sandbox cez oficiálny Stripe CLI (2026-11-18)

### 8.1 Overený postup (`stripe sandbox create --help`)

Oficiálny Stripe CLI **1.55.12** (npm `@stripe/cli`, repozitár `github.com/stripe/stripe-cli`, správcovia Stripe;
binárka `@stripe/cli-linux-x64`). `stripe sandbox` je alias `stripe sandboxes` (`create`, `claim`, `list`, `delete`).
Podľa `stripe sandboxes create --help`:

- **Bez prihlásenia a bez API kľúča v profile** CLI vytvorí **dočasný claimable sandbox s testovacími kľúčmi** — iba
  s parametrom `--email <adresa>` (adresa iba predvyplní registračný formulár pri neskoršom „claim“) alebo `--from-git`
  (e-mail a meno z git configu). Kľúče sa uložia do aktuálneho CLI profilu a ďalšie príkazy `stripe …` fungujú hneď.
- `stripe sandboxes create "<meno>"` (s menom) vyžaduje prihlásenie k live účtu — pre Esblu nepoužiteľné.
- `--create-blank --country SK` iba pre spravovaný sandbox pod live účtom.
- Ak anonymné vytvorenie zlyhá, CLI prejde na registráciu v prehliadači.

### 8.2 Pokus v prostredí agenta — BLOKOVANÉ sieťou

```
stripe sandboxes create --email qa-sandbox@example.invalid --non-interactive --log-level debug
sandbox: POST /keys/challenge
sandbox: challenge request failed  error="Post \"https://ai.stripe.com/keys/challenge\": Forbidden"
Could not provision a sandbox automatically. Opening browser …
Post "https://dashboard.stripe.com/stripecli/auth": Forbidden
```

Proxy prostredia agenta blokuje `ai.stripe.com`, `api.stripe.com`, `dashboard.stripe.com` aj sťahovanie z GitHub Releases
(`HTTP 403 from proxy after CONNECT`). Sandbox sa preto musí vytvoriť na počítači vlastníka (krok 8.4/1). Použitá bola iba
syntetická adresa `@example.invalid`; žiadny sandbox nevznikol.

### 8.3 Čo sa overilo lokálne s oficiálnymi nástrojmi Stripe (bez siete)

| Test | Výsledok |
|---|---|
| Podpis webhooku z **oficiálnej knižnice `stripe` 23.1.0** (`webhooks.generateTestHeaderString`) → overenie adaptérom Esblu | PASS 4/4: platný podpis prijatý; cudzí secret, `livemode:true` a starý timestamp (1 h) odmietnuté |
| Parametre Checkout Session a Billing Portal z adaptéra Esblu typované oficiálnym SDK (`Stripe.Checkout.SessionCreateParams` vrátane `origin_context`, `expires_at`, `tax_id_collection`, `customer_update`) | PASS (`tsc --strict`) |

### 8.3a Zistenia z behu na PC vlastníka (18. 11. 2026)

| # | Krok | Výsledok | Dôkaz / oprava |
|---|---|---|---|
| L1 | Nákup cez Stripe Checkout (lokálne Esblu + `stripe listen` + staging DB), karta `4000…0002` zamietnutá, `4242…` zaplatená | **PASS priamo cez Stripe** — 3 udalosti (`checkout.session.completed`, `customer.subscription.created`, `invoice.paid`) HTTP 200, spracované; predplatné `active`, 9 nárokov Kompletu; zamietnutá karta nič nevytvorila | staging `billing_events`, `subscription_accounts` |
| L2 | „renew“ cez `billing_cycle_anchor=now` | **NEPLATNÝ TEST** — Stripe CLI vrátil chybu s exit kódom 0, skript vypísal OK; žiadna nová faktúra | skript teraz kontroluje `"error"` v odpovedi; obnova iba cez **Test Clock** (OK až po zaplatenej `subscription_cycle` a zhode obdobia v Stripe aj Esblu) |
| L3 | `-Step status` vypísal celé `whsec_…` z logu `stripe listen` | **bezpečnostný nález** — všetky výpisy sa maskujú, logy sa mažú pri štarte a konci | tajomstvo `stripe listen` je viazané na **Stripe účet**, nie na zariadenie → rotácia = nový sandbox |
| L4 | „Nový sandbox“ cez `sandboxes create` v tom istom profile | **nevznikol** — podľa `--help` profil s kľúčom iba otvorí Dashboard; nová cena `price_1UdDE5…` je v **tom istom účte** (rovnaký segment účtu `B5dmk5ax59` v ID `price_1UdBoJ…`, `price_1UdDE5…`, `sub_1UdChQ…`), preto rovnaké tajomstvo | skript: samostatný profil CLI (`--project-name esblu-qa2`), `-Step new-sandbox` uloží odtlačok vystaveného tajomstva a overí, že nový sa líši |

| L5 | `-Step new-sandbox` v profile `esblu-qa2` | **PASS** — nový účet (iný segment účtu `RKE4QKs2UL` v `price_1UdE7tRKE4QKs2ULYWShYLxS`), tajomstvo sa líši od vystaveného, staging mapovanie prepnuté na novú cenu | staging `billing_provider_prices` |
| L6 | Po prevzatí sandboxu a `stripe login --project-name esblu-qa2` krok 1/5 „nie je testovací kľúč“ | príčina: po `stripe login` CLI ukladá kľúč do systémového trezoru (Windows Credential Manager), `config --list` ho nezobrazí | skript: `STRIPE_API_KEY` → profil → **skrytá výzva** na Secret key sandboxu; overenie účtu (kľúč vidí cenu profilu 15,90 EUR/mes.) a oprávnenia na Test Clocks priamo cez Stripe API; kľúč iba v procese |

| L7 | Test Clock (firma QA-STRIPE D, `sub_1UdEirRKE4QKs2ULOsvPiHDD`): clock-setup → renew → fail-renew → fix-payment → refund-partial → refund-full | **PASS v Stripe aj Esblu** pre každý krok (staging `billing_events`: `invoice.paid` 18. 12. → 18. 1. → 18. 2. 2027, `invoice.payment_failed` → `past_due`, `invoice.paid` → `active`, 2× `charge.refunded`) | výpis vlastníka + staging DB |
| L8 | Po plnej refundácii: Esblu `refunded` (9 nárokov odvolaných), Stripe `active`, `cancel_at_period_end=false` | **CHYBA** — Stripe by pri ďalšom období znova účtoval firme bez prístupu; neskoré `invoice.paid` by Esblu odmietlo (`TERMINAL_STATE`) | oprava 8.5 |

| L9 | `-Step reconcile` (D): Stripe `sub_1UdEirRKE4QKs2ULOsvPiHDD` → `canceled` (PASS), ale Esblu `refunded` → **`canceled`** | **CHYBA** — webhook `customer.subscription.deleted` (20:19:00 UTC, `processed`, stav `canceled`) prešiel pravidlom (e) v `esblu_billing_apply_event`, ktoré blokovalo iba ne-terminálne stavy; dôvod ukončenia `refunded` sa stratil (nároky ostali odvolané) | migrácia `20261118130000_billing_terminal_precedence` (pravidlo e2: revoked > refunded > canceled/expired), staging aplikované, md5 = repo |

| L10 | `refund-current` (D, `sub_1UdFX4RKE4QKs2ULa1Z9d0fn`): Stripe `canceled`, Esblu `refunded`, `customer.subscription.deleted` = `stale/TERMINAL_STATE` (PASS e2); skript hlásil „1 aktívny nárok“ | **chyba testovacieho dotazu, nie odobratia** — DB: všetkých 9 riadkov `company_entitlements` firmy D zo `subscription` (ref `subscription_account:83a9b525…`, `plan=esblu_complete`, `valid_until` 2027-01-20) má `status=revoked` (20:36:55 UTC); aplikačná kontrola `esblu_get_my_company_entitlements` ako owner D: 11/11 kľúčov `active=false` (`ENTITLEMENT_REQUIRED`), `explain` = `not_entitled`, `subscription_status=refunded`. Príčina: Windows PowerShell 5.1 vracia JSON pole z `Invoke-RestMethod` ako jeden objekt → `@(…).Count` = 1 aj pre prázdne pole. Pozostatok staršieho predplatného to nie je (riadky sú jeden na kľúč a nové predplatné ich prepísalo) | skript: `Get-Rows` rozbalí pole; kontrola zahŕňa všetky zdroje a platnosť a vypíše každý aktívny nárok |
| L11 | Väzba refundácie na faktúru | udalosti D: `charge.refunded` 20:35:31 (refund-old) → súhrn iba `{"charge_kind":"refund"}`; 20:36:54 (refund-current) → stav `refunded`, `period_end` 2027-01-18 = faktúra obnovy 20:34 (obdobie 18. 12. 2026 → 18. 1. 2027) — správne, ale audit nenesie ID faktúry ani obdobie | migrácia `20261118140000_billing_refund_audit` (súhrn: predplatné, faktúra, obdobie služby z riadku faktúry, suma, mena, rozsah `partial/older_invoice/current_period`); staging aplikované, md5 = repo; skript overí faktúru, rozsah aj obdobie proti Stripe |

### 8.5 Refundácia, prístup a ďalšie účtovanie (pravidlo + oprava, 2026-11-18)

| Prípad | Esblu (prístup) | Stripe (predplatné) | Implementácia |
|---|---|---|---|
| Čiastočná refundácia (akákoľvek faktúra) | bez zmeny | bez zmeny | iba účtovný záznam (`esblu_billing_apply_charge`) |
| Plná refundácia **staršej** faktúry (nie aktuálneho obdobia) | bez zmeny — aktuálne obdobie je zaplatené | bez zmeny | adaptér: refundovaná faktúra ≠ `latest_invoice` predplatného → iba účtovný záznam |
| Plná refundácia faktúry **aktuálneho obdobia** | `refunded`, nároky odvolané okamžite, dáta ostávajú | **okamžite ukončené** (`DELETE /v1/subscriptions/{id}`, `invoice_now=false`, `prorate=false`) — žiadne ďalšie účtovanie | `followUp: cancel_provider_now` v pipeline po zápise stavu; audit `esblu.audit.terminal_cancel` (stav v Esblu ostáva `refunded`) |
| Prehraný spor | `revoked` | okamžite ukončené | rovnaký `followUp` |
| Účet `refunded`/`revoked`, ale predplatné u providera stále beží (napr. zlyhalo ukončenie, alebo stav pred opravou) | bez zmeny (terminálny) | reconciliation ho ukončí | `reconcileOne`: terminálny účet + otvorený stav providera → `cancelNow`, výsledok `corrected / PROVIDER_CANCELED` |
| Nový nákup po refundácii | nové predplatné, nové ID | nové predplatné | bez zmeny (existujúce pravidlo) |

Rozhodnutie „plná refundácia aktuálneho obdobia = koniec prístupu a koniec predplatného“ je v súlade s pôvodným návrhom
(§ 2, S8) a doplnené o ukončenie u Stripe; formulácia pre zákazníka ostáva otázkou pre CLIA (`clia-delta-2026-11-24-draft.md` § 3.2).
Testy: unit (+4: staršia vs. aktuálna faktúra, DELETE bez prorácie a idempotentne, spor lost) a PGlite (+1: staršia faktúra
ponechá prístup; reconciliation ukončí otvorené predplatné pri účte `refunded`), regresia `test:subscriptions-lifecycle` 51,
`test:subscriptions-lifecycle-db` 74, `test:subscriptions-db` 60, `test:subscriptions` 28.

Zachovanie konečného stavu (migrácia `20261118130000`): pri tom istom predplatnom revoked > refunded > canceled / expired;
slabší terminálny stav → `stale / TERMINAL_STATE`, účet ani nároky sa nemenia; refunded → revoked (neskorý prehraný spor)
povolené. PGlite: `customer.subscription.deleted` po refundácii → stale, refunded ostáva, nároky 0; opakované doručenie →
`duplicate`; oneskorená udalosť → stale; spor lost → revoked; následné canceled → stale; opakovaná reconciliation (Stripe
canceled vs. Esblu refunded) → stav bez zmeny, žiadne ďalšie ukončenie u Stripe.

Opakovateľné overenie v Stripe (skript; firma D má po L9 stav `canceled` — nové predplatné ho nahradí):
`clock-setup` → `renew` → `refund-old` (Esblu aj Stripe `active`) → `refund-current` (Esblu `refunded`, Stripe `canceled`,
`customer.subscription.deleted` = `stale/TERMINAL_STATE`, 0 aktívnych nárokov) → `verify-terminal` (2× reconciliation,
stav bez zmeny, zoznam udalostí) → `advance-check` (ďalšie obdobie bez faktúry a platby).

#### Výsledky behu (firma QA-STRIPE D, `sub_1UdFkMRKE4QKs2ULSARsG1Rj`, 18. 11. 2026)

| # | Krok | Výsledok | Dôkaz |
|---|---|---|---|
| L12 | `refund-old` — plná refundácia staršej faktúry `in_1UdFkMRKE4QKs2ULvzwRrFaJ` (18. 11. → 18. 12. 2026) | **PASS (Stripe + Esblu)**: `charge.refunded` `evt_3UdFkNRKE4QKs2UL1MMgdeHg` prijatá 20:49:04.78, `processed` 20:49:05.77 UTC, bez chyby; audit `older_invoice`, faktúra, obdobie, 15,90 EUR, predplatné; Esblu aj Stripe `active`. Prvý beh hlásil timeout — **chyba testovacieho čakania, nie doručenia ani spracovania**: porovnanie „najnovšej“ udalosti a potom dvojúrovňový filter `summary->refund->>invoice` v PS 5.1 nevrátili riadok, hoci udalosť existovala | staging `billing_events`; skript: filter `summary->>subscription` (osvedčený) + porovnanie faktúry v PowerShelli, opakovaný beh nerefunduje znova (stav charge zo Stripe) |
| L13 | `refund-current` — plná refundácia faktúry aktuálneho obdobia `in_1UdFlMRKE4QKs2ULdJJDS2bk` (18. 12. 2026 → 18. 1. 2027) | **PASS**: `charge.refunded` `evt_3UdFlRRKE4QKs2UL0BGI8iYO` `processed` 21:22:00 UTC, audit `current_period`, 15,90 EUR; Esblu `refunded` 21:22:01; `esblu.audit.terminal_cancel` 21:22:02 (Esblu ukončilo predplatné u Stripe); `customer.subscription.deleted` 21:22:02 = `stale` (refunded ostal); Stripe `canceled`; 9/9 nárokov `revoked`, 0 účinných. Prvý beh hlásil „1590 != 0“ — **chyba skriptu**: suma sa porovnávala so snímkou charge načítanou **pred** refundáciou | skript: po spracovaní znova načíta charge zo Stripe (tá istá charge, plne refundovaná), porovnanie v centoch (audit = refundované = zaplatené na faktúre, mena), výpis „15,90 EUR“, kontrola 0 nárokov |
| L14 | `advance-check` — Test Clock posunutý do 22. 2. 2027 | **PASS**: Stripe `canceled`, počet faktúr 2, úspešných platieb 2 (žiadne ďalšie účtovanie); Esblu `refunded`; v staging DB **žiadna** udalosť po 21:22:03 UTC | výpis vlastníka + staging `billing_events` |
| L15 | `verify-terminal` | **PASS (po oprave)** — 2 skutočné behy: syntetické udalosti `esblu.sync.reconcile` 21:43:00 a 21:43:02 UTC, obe `stale / TERMINAL_STATE` (refunded ostal), `billing_reconciliation` účtu D: `last_checked_at` 21:43:03, `last_result=in_sync`, bez chyby; Esblu `refunded` (verzia účtu nezmenená od 21:22:01), Stripe `canceled`, 0 účinných nárokov. Pôvodne: reconciliation preskakuje účet 24 h po poslednej kontrole (D: `last_checked_at` 20:19, `next_check_at` 19. 11. 20:19), takže pôvodná verzia by vrátila `checked=0` a nič by nedokázala | skript: pred každým z 2 behov naplánuje účet QA na okamžitú kontrolu (`billing_reconciliation` iba tohto účtu: `last_checked_at=null`, `next_check_at` = teraz − 1 min) a vyžaduje `checked ≥ 1`, novú kontrolu účtu s výsledkom `in_sync`, Esblu stav bez zmeny, Stripe `canceled`, 0 nárokov. Prvý beh: stav `refunded` a 0 nárokov potvrdené, potom **HTTP 400** pri naplánovaní — `next_check_at=null` porušuje `NOT NULL` (23502, overené v transakcii s rollbackom); oprava = čas v minulosti (v rollbacku: účet sa stal kandidátom). Chyby staging REST a cron sa vypisujú s `code/message/details/hint` (maskované) |

Stav DB po L14 (read-only SQL, 18. 11. 2026): účet D `refunded`, `ended_at` 21:22:00 UTC, 9 riadkov nárokov zo `subscription`, všetky `revoked`, 0 účinných aktívnych.

### 8.6 Firma QA-STRIPE E — zrušenie v aplikácii a súbežný nákup v dvoch kartách (pripravené)

Staging: firma `QA-STRIPE E (dve karty + zrusenie)` (`5a5a0000-…-0000000000e0`), syntetický owner
`qa-stripe-e-owner@example.invalid` (bez osobných údajov), výber plánu Komplet (9 cieľových nárokov), 0 predplatných,
0 zámerov; `web_provider='stripe'`, aktívna cena `price_1UdE7tRKE4QKs2ULYWShYLxS`. Heslo pri vytvorení náhodné a nikomu
neznáme; prihlasovacie heslo nastaví `-Step qa-login` cez Admin API stagingu iba do schránky vlastníka.

| # | Krok (lokálne Esblu `http://localhost:3000` + `stripe listen`) | Očakávanie | Overenie |
|---|---|---|---|
| E1 | Dve karty `/nastavenia/predplatne`, „Pokračovať na platbu“ v oboch čo najrýchlejšie po sebe | obe karty → **tá istá** Stripe Checkout relácia; 1 otvorený zámer | `-Step qa-check` |
| E2 | Zaplatiť v karte 1 (`4242 4242 4242 4242`), potom skúsiť zaplatiť v karte 2 | 1 zaplatená relácia, 1 predplatné u Stripe; karta 2 zobrazí dokončenú reláciu / nové tlačidlo vráti `ALREADY_SUBSCRIBED` | `qa-check` (najviac 1 `completed`, najviac 1 `paid`, 1 neukončené predplatné) |
| E3 | V aplikácii zrušiť predplatné (Nastavenia → Predplatné) | Esblu aj Stripe `cancel_at_period_end=true`, stav `active` do konca obdobia, nároky ostávajú | `qa-check` (zhoda Esblu ↔ Stripe) |
| E4 | Upratanie po teste | owner E `banned_until=infinity`, `web_provider='none'` | agent (staging SQL) |

#### Výsledky (18. 11. 2026, lokálne Esblu + `stripe listen`, sandbox `RKE4QKs2UL`)

| # | Výsledok | Dôkaz (staging DB, read-only SQL; `qa-check` vlastníka pred aj po zrušení PASS) |
|---|---|---|
| E1 | **PASS** — dve karty → **1 zámer** `bba6a301-…` (vytvorený 21:53:28 UTC, `expires_at` +1 h), jedna Stripe relácia `cs_test_a0WC…` | `billing_checkout_sessions` firmy E: 1 riadok |
| E2 | **PASS** — zaplatené v karte 1 (21:57:52); zámer `completed` 21:57:56; `invoice.paid` + `checkout.session.completed` `processed`, `customer.subscription.created` `stale` (už zapísaný novší stav); 1 predplatné `sub_1UdGrWRKE4QKs2ULsxAllJ6Z`; karta 2 po obnovení zobrazila uzavretú reláciu; presne 1 zaplatená relácia | `billing_events`, `subscription_accounts` |
| E3 | **PASS** — zrušenie v aplikácii 22:02:50: `esblu.sync.cancel` + `customer.subscription.updated` `processed`, obe `cancel_at_period_end=true`; Esblu `active`, `cancel_at_period_end=true`, `canceled_at` 22:02:50, obdobie do 18. 12. 2026 21:57:52; Stripe `cancel_at` 2026-12-18 21:57:52 UTC; 9 nárokov `active`, `valid_until` 20. 12. 2026 21:57:52 | `qa-check`, DB |
| E4 | **hotové** 19. 11. 2026 — pozri § 8.7 | |

**Prístup po skončení zrušeného predplatného (pravidlo 2-dňovej rezervy):** `esblu_billing_sync_entitlements` pre
`active`/`trialing` nastavuje `valid_until = current_period_end + 2 dni` — rezerva **na oneskorený webhook obnovy**
(`subscriptions-architecture-2026-10-08.md`, scenár S6: „ON do konca zaplateného obdobia (+ 2 dni buffer), potom `canceled` → OFF“).
Rozdiel 18. 12. (UI) vs. 20. 12. (nároky) je teda **v súlade s pravidlom**: účinný koniec určuje `customer.subscription.deleted`
z 18. 12. (→ `canceled` → nároky okamžite `revoked`, overené na D v L9/L13); 20. 12. je iba poistka (fail closed), ak by webhook
nedorazil. Overené na stagingu v transakcii s **rollbackom** nad účtom E: (A) obdobie skončilo, webhook chýba → 9 účinných nárokov
do konca + 2 dní; (B) po uplynutí 2 dní bez webhooku → 0; (C) stav `canceled` → 0 okamžite. Reconciliation by v okne A
predplatné skontrolovala (kandidát pri `current_period_end < now + 1 deň`) a stav opravila.
**Rozhodnutie vlastníka 19. 11. 2026:** 48-hodinová ochranná lehota platí aj po riadnom skončení — pozri § 8.8.

### 8.8 48-hodinová ochranná lehota po skončení zaplateného obdobia (schválené 19. 11. 2026)

**Audit pred zmenou** (staging = repo `20261026100000`, `esblu_billing_sync_entitlements`):

| Situácia | Pred zmenou | Problém |
|---|---|---|
| `active` / `trialing` (aj so zrušeným obnovovaním) | nároky do `current_period_end + 2 days` | iba poistka na oneskorený webhook; `interval '2 days'` ≠ presne 48 h pri inej časovej zóne relácie |
| riadny koniec (`customer.subscription.deleted` na konci obdobia → `canceled`) | nároky **okamžite** odvolané | 48 h dostal iba ten, komu webhook meškal — nejednotné |
| `past_due` | do `grace_until` (7 dní od 1. zlyhania) | OK, bez sčítavania |
| ukončenie po neúspešných platbách | okamžite | OK |
| `refunded` / `revoked` | okamžite | OK |
| čiastočná refundácia | bez zmeny stavu (`review_flag`) | OK |
| dáta | nikdy sa nemažú (iba `status='revoked'`) | OK |
| vynucovanie | `esblu_resolve_entitlement`: `status='active' AND valid_until > now()` (bez cronu) | OK |
| UI | `status=canceled` → „Ukončené“, bez informácie o dobiehajúcom prístupe | doplniť |

**Zmena** — migrácia `20261119100000_billing_post_period_protection` (+ rollback), **aplikovaná iba na staging**:

| Stav účtu | Prístup (valid_until) |
|---|---|
| `active`, `trialing` | `current_period_end + 48 h` |
| `canceled`, `expired` — riadny koniec (`ended_at ≥ current_period_end − 5 min`, obdobie nebolo trial) | `current_period_end + 48 h` (**nové**) |
| `canceled`, `expired` — uprostred obdobia (dunning: Stripe pri obnove posunie obdobie, potom ukončí; okamžité zrušenie; koniec trialu) | žiadny |
| `past_due` | `grace_until` (7 dní) — **bez** ďalších 48 h |
| `grace_period` (obchody) | `grace_until` |
| `refunded`, `revoked`, `unpaid`, `account_hold`, `paused`, `incomplete`, `none` | žiadny, okamžite |

Jediná kotva = `current_period_end` (nie čas webhooku) → neskorý alebo chýbajúci webhook nič nepredlžuje, lehoty sa
nesčítavajú. `esblu_get_my_subscription` vracia `access_until` a `post_period_protection`; stránka Predplatné zobrazí
„Predplatné skončilo. Prístup ponechávame ešte 48 hodín — do …. Vaše dáta zostávajú uložené.“ (sk/en/de).
Manifest grantov doplnený o 3 service-only funkcie (`checkout_for_cancel`, `mark_checkout_expired`, nový helper).

**Testy:** nový `test:billing-post-period-db` 11/11 (čistý replay všetkých migrácií): hranice 47 h 58 min / 48 h 1 min,
riadny koniec vs. uprostred obdobia, tolerancia 5 min, trial, past_due bez sčítavania, dunning, úplná refundácia a spor aj
počas lehoty, čiastočná refundácia bez zmeny, neskorý webhook neposúva koniec, resolver bez cronu, klient nepredĺži ani
nespustí sync, dáta ostávajú, idempotencia, rollback a znovu-forward. Regresia: `test:pricing-entitlements-db` 35/35,
`test:subscriptions-db` 60/60, `test:subscriptions-lifecycle-db` 74/74, `test:subscriptions` 28/28,
`test:subscriptions-lifecycle` 51/51 (+ parsovanie `access_until`), `test:i18n` 114/114, `tsc` 0 chýb, `eslint` 0 chýb.
`test:grants-guard` / `test:grants-replay-db`: zostávajú iba zlyhania zdedené z `main` (`registration_policy` z `20261117100000`)
— mimo tejto zmeny; rozbor v § 8.9 (oprava: `fx_rate_publication_exceptions` tu bolo uvedené omylom — tabuľku zmaže
`20261008100004`, v DB neexistuje a testy ju nehlásia).

**Staging (skutočná pipeline, transakcia s rollbackom, účet QA-STRIPE E):** obdobie skončilo pred 1 h, webhook ešte nie →
`active`, nároky do cpe + 48 h; `customer.subscription.deleted` cez `esblu_billing_record_event` + `esblu_billing_apply_event`
→ `applied`, `canceled`, 9/9 nárokov aktívnych do cpe + 48 h (hlas aj vozidlá povolené); následne úplná refundácia →
`refunded`, 0 aktívnych, 9 riadkov ostáva. Advisors: 0 ERROR.

**Otvorené riziká:** (1) Portál Stripe s `cancel_at` uprostred obdobia → koniec pred `current_period_end` → bez 48 h
(zámer: zákazník zvolil skorší koniec). (2) Obchody (Apple/Google) — `expired` po vypršaní obdobia dostane 48 h; po
`account_hold` je kotva v minulosti → bez efektu. (3) Zrušenie účtu/firmy počas lehoty lehotu prepadá (existujúci
forfeit text). (4) Produkcia: migrácia čaká na súhlas spolu s `20261118120000–140000`.

### 8.9 Kontrola po pushi `00afb87` (19. 11. 2026)

**Preview:** `dpl_hTaVtAJwxyAWWzAcw5vfX5PbL5hY` (`00afb87`) READY, alias vetvy ukazuje naň. Stránka Predplatné v sk/en/de bez
surových kľúčov, „Online predplatné zatiaľ nie je dostupné.“ (`/api/billing/subscription` a `purchase-options` → 404, billing
vypnutý). Text 48 h lehoty a polia `access_until` / `post_period_protection` sú v nasadenom JS (3 jazyky), ale pri vypnutom
billingu ich UI **nezobrazí** (pohľad na predplatné sa nenačíta) → UI lehoty **nie je E2E overené na Preview**. Server
overený na stagingu (DB Preview = staging, migrácia `20261119100000` aplikovaná): owner E cez `esblu_get_my_subscription`
ako `authenticated` (transakcia s rollbackom) → `canceled`, `post_period_protection=true`, `access_until` = cpe + 48 h,
hlas aktívny. Prihlásenie QA ownera E iba dočasne, potom znova zablokovaný, heslo zneplatnené, relácie zmazané.

**Chýbajúce vs. oneskorené webhooky:**

| Udalosť | Oneskorená (Stripe opakuje doručenie do 3 dní) | Úplne chýba | Riziko bez nápravy |
|---|---|---|---|
| okamžité ukončenie (`customer.subscription.deleted` uprostred obdobia) | spracuje sa v poradí podľa `state_at`, dedupe podľa ID | reconciliation (`getSubscription`) by našla `canceled` → oprava | **cron reconciliation nie je v `vercel.json`** → prístup do cpe + 48 h zadarmo |
| úplná refundácia (`charge.refunded`) | OK | **reconciliation ju nevidí** — porovnáva iba objekt predplatného, ktoré ostáva `active` | firma má prístup aj po vrátení peňazí a **Stripe účtuje ďalšie obdobie** |
| prehraný spor (`charge.dispute.closed` lost) | OK | rovnako neviditeľný | prístup aj ďalšie účtovanie pokračujú |

Návrh pred produkciou (nie implementované): (1) naplánovať `/api/cron/billing-reconcile` (napr. každých 6 h, `CRON_SECRET`);
(2) „catch-up“ udalostí: cron číta `GET /v1/events` (Stripe uchováva 30 dní) od poslednej spracovanej udalosti pre
`charge.refunded`, `charge.dispute.closed`, `customer.subscription.*`, `invoice.*` a posiela ich tou istou pipeline (dedupe
podľa ID udalosti, udalosť z API je autentická — bez podpisu); (3) alternatívne / doplnkovo: reconciliation pri otvorenom
účte načíta `latest_invoice` s platbou a pri plnej refundácii / prehranom spore aplikuje `refunded` / `revoked` + ukončenie;
(4) monitoring: upozornenie na zlyhané doručenia webhooku (Stripe e-mail) a na `billing_events` s chybou.
Rozsah (1)+(2): 1 route + adaptér Stripe events + testy, bez migrácie.

**Predčasné ukončenie (normalizácia Stripe, skutočný kód):**

| Prípad | Stripe objekt | Esblu dnes | Správne podľa pravidla |
|---|---|---|---|
| zrušenie obnovovania ku koncu obdobia | `cancel_at_period_end=true` | `cape=true`, prístup do cpe + 48 h; po konci `ended_at = cpe` → + 48 h | ✅ |
| ukončenie k zvolenému dátumu uprostred obdobia | `cancel_at` < koniec obdobia, `cancel_at_period_end=false` | normalizácia nastaví `cape=true` a dátum `cancel_at` **zahodí** → kým beží, nároky do cpe + 48 h, UI ukazuje koniec = cpe; po konci (webhook) `ended_at < cpe` → hneď off | ❌ ak webhook o skončení chýba, prístup beží do pôvodného cpe + 48 h; UI zobrazuje nesprávny dátum |
| okamžité ukončenie | `status=canceled`, `ended_at = teraz` | `ended_at < cpe` → hneď off | ✅ |

Esblu ponúka iba zrušenie ku koncu obdobia; dátum uprostred obdobia vie nastaviť iba operátor v Stripe Dashboarde / API.
Neoverené v sandboxe: či novšie API Stripe pri `cancel_at` skracuje `current_period_end` (potom by Esblu dalo + 48 h po
predčasnom konci). Návrh opravy (nie implementované): normalizácia `cancel_at_period_end` = iba príznak zo Stripe; nové pole
`cancel_at` v stave a účte; helper: ak `cancel_at` < cpe − 5 min → prístup do `cancel_at`, bez 48 h; test v sandboxe
(`subscriptions update … -d cancel_at=…`). Rozsah: 1 migrácia (stĺpec + helper), adaptér, unit + PGlite testy, sandbox krok.

**`registration_policy` (zdedené z `main`, `20261117100000`):** skutočný stav staging **aj produkcia** (read-only metadáta):
RLS zapnutá, 0 politík, ACL `postgres` + `service_role=arwd`, žiadny prístup `anon`/`authenticated`;
`esblu_ensure_my_owner_company()` EXECUTE `authenticated, service_role` (= manifest); `esblu_public_registration_open()`
iba `postgres` (volá sa z definer funkcií). Migrácia má správne `revoke all` + cielený grant. **Nejde o problém oprávnení ani
RLS** — chýba iba (a) položka `registration_policy` v `supabase/grants/public-data-api-grants.json` a (b) explicitné
`grant/revoke execute` pre `esblu_ensure_my_owner_company()` v tej migrácii (`create or replace` ponechal pôvodné ACL).
Návrh: doplniť manifest (`access: D`, service CRUD — ako `beta_allowlist`) a pridať no-op forward migráciu, ktorá ACL
funkcie iba explicitne zopakuje (alebo výnimku v guarde). Bezpečnostná zmena nie je potrebná.

### 8.10 S12 + S13 implementované (19. 11. 2026, schválené vlastníkom; iba staging)

**S12 — chýbajúce udalosti sa doťahujú dvoma nezávislými cestami:**

| Cesta | Čo robí | Spoľahlivosť |
|---|---|---|
| `GET /api/cron/billing-stripe-events` (každých 15 min) | číta `GET /v1/events` (stav predplatného, faktúry, `charge.refunded`, `charge.dispute.*`) od posledného kurzora dopredu (`ending_before`), spracuje od najstaršej po najnovšiu **tou istou pipeline ako webhook** (`processVerifiedEvent`: dedupe podľa ID udalosti, čerstvý stav z API, poradie podľa `state_at`, terminálne stavy) | kurzor v `billing_event_cursors` po každej udalosti; dočasná chyba = stop bez posunu (zopakuje sa); lease proti súbehu; max 200 udalostí / 20 strán / 45 s na beh (pokračuje ďalší beh); iný Stripe účet → `ACCOUNT_MISMATCH` (nič sa nespracuje, reset iba operátor); `livemode: true` sa nikdy nespracuje; kurzor mimo retencie (30 dní) → bootstrap okna + signál `CURSOR_EXPIRED` |
| `GET /api/cron/billing-reconcile` (každých 6 h) | pri Stripe overí okrem predplatného aj **platbu aktuálnej faktúry** (`invoice_payments` → `payment_intent.latest_charge`, spor cez `/v1/disputes`): plná refundácia → `refunded`, prehraný spor → `revoked`, hneď ukončiť u Stripe | nezávislé od retencie udalostí (aj po výpadku > 30 dní); refundácia staršej faktúry prístup nemení; opakovaný beh `in_sync` |

Oba crony: `CRON_SECRET` (časovo konštantné porovnanie), billing vypnutý / `VERCEL_ENV=production` / DB `web_provider ≠ stripe` →
`configured:false` bez volania Stripe aj DB. **Vercel Cron beží iba na produkčnom nasadení**, kde je billing tvrdo vypnutý →
dnes no-op; na stagingu/Preview sa spúšťa ručne (`curl -H "Authorization: Bearer $CRON_SECRET" …`). Plán Pro (100 cronov,
min. 1 / min): projekt má 11 cronov. Náklady: ~96 + 4 krátkych volaní funkcie denne (pri vypnutom billingu < 50 ms, inak
jednotky sekúnd) — v rámci kreditu Pro; Stripe API bez poplatkov (limit test mode ~25 req/s, beh je sekvenčný).

**S13 — ukončenie k zvolenému dátumu:** Stripe `cancel_at` mimo konca obdobia (± 5 min) a bez `cancel_at_period_end=true`
→ `scheduled_end_at` (stav, účet, audit, reconciliation drift). Prístup:

| Prípad | Prístup |
|---|---|
| riadny koniec obdobia / zrušenie obnovovania | koniec obdobia + 48 h |
| plánované predčasné ukončenie | presne do zvoleného dátumu, bez rezervy (aj keď webhook o skončení chýba) |
| okamžité ukončenie | hneď |
| plná refundácia, prehraný spor | hneď, bez rezervy |
| neúspešná platba | `grace_until` (7 dní), nesčítava sa |

UI: „Končí dňa“ ukazuje zvolený dátum. Reconciliation kontroluje účet skôr, keď sa blíži plánovaný koniec.

**Migrácie (staging aplikované, md5 tiel funkcií = repo):** `20261119110000_billing_scheduled_end`,
`20261119120000_billing_event_catchup` (+ rollbacky). Manifest grantov: `registration_policy`, `billing_event_cursors`,
4 nové service-only funkcie; guard: zdokumentovaná výnimka pre už aplikovanú `20261117100000` (ACL overené).

**Testy (DB úroveň — PGlite / staging transakcie s rollbackom, NIE end-to-end so živým Stripe):**
`test:subscriptions-lifecycle-db` 82/82 (+8 `stripe-catchup`: úplne chýbajúci webhook refundácie, oneskorená refundácia,
prehraný spor, výpadok `/events` a výpadok uprostred, stránkovanie + limit + pokračovanie, kurzor mimo retencie, súbeh dvoch
behov + webhook naraz, iný účet, live udalosť, klient bez prístupu, reconciliation refund/spor bez udalostí, migrácia/rollback),
`test:billing-post-period-db` 16/16 (+ S13: helper, predčasný koniec, zmeny dátumu, pipeline duplicita/stale, časové pásma
a DST), `test:subscriptions` 28/28 (normalizácia `cancel_at`), `test:subscriptions-lifecycle` 52/52 (route: 401, billing off,
produkcia), `test:subscriptions-db` 60/60, `test:pricing-entitlements-db` 35/35, `test:grants-replay-db` 43/43,
`test:grants-guard` 10/10, `test:prelaunch-blockers` 21/21, `test:cost-control` 18/18, `test:i18n` 114/114, `tsc` 0, `eslint` 0.
Staging (transakcia s rollbackom, účet QA-STRIPE E): `apply_event` uloží `scheduled_end_at`, nároky = zvolený dátum;
cursor RPC claim / advance / busy / release; `anon`/`authenticated` bez prístupu k tabuľke a RPC. Advisors: 0 ERROR.

**Zostáva overiť so živým Stripe sandboxom (PC vlastníka):** `GET /v1/account` a `/v1/events` s restricted kľúčom
(oprávnenia Events: read, Account: read), sémantika `ending_before` a správanie `cancel_at` (či Stripe neskracuje obdobie).

### 8.11 Validácia po pushi `ab8f186` (19. 11. 2026)

**Preview:** `dpl_2icCeeg6CrjwS6KotKrnVUXz3nuV` (`ab8f186`) READY; premenné vetvy `ESBLU_BILLING_MODE=off`,
`NEXT_PUBLIC_ESBLU_BILLING_UI=0`; žiadne `STRIPE_*` v Preview ani v produkcii; `/api/billing/purchase-options` → 404
`ESBLU_BILLING_DISABLED`; `/api/cron/billing-stripe-events` bez `CRON_SECRET` → 401. DB Preview = staging (overené
prihlásením syntetického QA účtu, ktorý existuje iba na stagingu). Ručný beh cronu na Preview nebol možný (hodnota Preview
`CRON_SECRET` je *sensitive* a nečitateľná) — pri vypnutom billingu by aj tak vrátil `configured:false` (pokryté testom).

**Skutočný Stripe sandbox:** z prostredia agenta **nedostupný** (proxy blokuje `api.stripe.com`, HTTP 000). Testy
so skutočným API sa spúšťajú na PC vlastníka novými krokmi skriptu (`scripts/stripe-local-sandbox.ps1`, sandbox profilu
`esblu-qa2`, cena `price_1UdE7t…`, účet so segmentom `RKE4QKs2UL`; pôvodný sandbox firmy C sa nepoužíva):

| Krok | Overuje |
|---|---|
| okno 1 `-NoListen` | Esblu bez `stripe listen` → webhooky sa nedoručia; všetko ide iba cez doťahovanie (aj aktivácia v `clock-setup`) |
| `-Step s12-account` | typ kľúča (iba prefix), test mode, `GET /v1/account` a `GET /v1/events` (oprávnenia), zhoda účtu s kurzorom |
| `-Step s12-events` | skutočné stránkovanie `ending_before` po 2 = rovnaké poradie ako plný zoznam, bez medzier a duplicít; neexistujúci kurzor → 400/404 |
| `-Step s12-catchup` | 2× lokálny cron; druhý beh bez zmeny stavu (idempotencia); kurzor a lease v DB |
| `-Step s12-cancel-at` | `cancel_at` uprostred obdobia na test clock: či Stripe skracuje obdobie, Esblu `scheduled_end_at`, nároky do dátumu; po posune hodín `canceled` a 0 nárokov |
| `-Step s12-refund-missing` | plná refundácia bez webhooku → doťahovanie: `refunded`, Stripe `canceled`, 0 nárokov, opakovanie bez zmeny |

Staging pripravený na tento test: `web_provider='stripe'`, aktívna cena `price_1UdE7t…` (po teste vrátiť `none` / neaktívna).

**Produkčná konfigurácia (zistenie, nie chyba):** live Stripe dnes v kóde **neexistuje** — 4 nezávislé tvrdé zámky:
(1) `VERCEL_ENV=production` → režim billingu `off`; (2) `StripeTestProvider` prijme iba `sk_/rk_/rkcs_test_` a odmietne
každý objekt / udalosť s `livemode:true`; (3) DB `billing_runtime_config.environment` iba `test`; (4) `billing_event_cursors`
iba `environment='test'`. Ochrana proti live udalostiam je teda trvalo **zapnutá** (nie vypnutá), ale pre ostré spustenie
treba vedomú implementáciu live režimu (S15): provider s očakávaným `livemode` podľa prostredia (live odmieta test udalosti
a test kľúče, test odmieta live), explicitný príznak `ESBLU_BILLING_MODE=stripe_live` iba pri `VERCEL_ENV=production`,
DB `environment='live'` (config, ceny, kurzor) a test, že sandbox kľúč v produkcii a live kľúč v Preview zlyhá.

### 8.12 Audit dôkazov a minimálne zostávajúce testy S12/S13 (19. 11. 2026)

Legenda: **R** = overené skutočným Stripe sandboxom 18. 11. (ostáva platné), **DB** = PGlite / staging transakcie
s mockom Stripe API, **API** = vyžaduje skutočné Stripe API, **—** = nepodstatné pre prvé spustenie.

| Scenár | Stav | Dôkaz |
|---|---|---|
| nákup, obnova, zlyhanie obnovy, oprava platby | R | L1, L7 |
| refundácia staršej / aktuálnej faktúry, ukončenie u Stripe, terminálne stavy | R | L12–L15 |
| zrušenie obnovovania → Stripe `cancel_at_period_end=true` + `cancel_at` = koniec obdobia | R | E3 (rozhoduje príznak, nie dátum) |
| dve karty, 1 zaplatená relácia | R | E1–E2 |
| 48 h lehota (pravidlá, hranice, DST) | DB | `test:billing-post-period-db` 16/16 + staging pipeline |
| doťahovanie: chýbajúci webhook, refund, spor, výpadok, prerušenie, súbeh, iný účet, live udalosť | DB | `stripe-catchup` 8/8 |
| reconciliation platby aktuálnej faktúry (refund / spor bez udalostí) | DB | `stripe-catchup` |
| **skutočné stránkovanie `ending_before` a poradie** | API | `s12-events` — iba čítanie existujúcich udalostí |
| **oprávnenie kľúča na `/v1/account` a `/v1/events`, bootstrap nad reálnymi udalosťami 18. 11., idempotencia** | API | `s12-catchup` — bez nových objektov (udalosti 18. 11. → `duplicate`) |
| **reálne volania reconciliation (`invoice_payments?invoice=`, `payment_intents` + `latest_charge`, `disputes?charge=`)** | API | `verify-terminal` nad existujúcou refundovanou D — iba čítanie Stripe |
| **`cancel_at` uprostred obdobia: skráti Stripe `current_period_end`? (riziko + 48 h)** | API, **prioritný** | `s13-existing` — existujúce predplatné E, bez nového objektu |
| plná refundácia bez webhooku na skutočnom Stripe | — (nie je nutné) | normalizácia refundácie R (L13) + generická cesta doťahovania API (`s12-catchup`) + DB |
| výpadok / prerušenie na skutočnom Stripe | — | nereprodukovateľné bez zásahu do siete; DB testy |
| obmedzený kľúč `rk_test_` s minimálnymi právami | — (pred live: S15) | — |

**Oprava pred testom (S13, nájdená pri audite):** normalizácia brala `cancel_at` rovné koncu obdobia (± 5 min) ako
riadne zrušenie. Ak by Stripe pri `cancel_at` skrátil `current_period_end`, predčasný koniec by dostal + 48 h. Teraz
rozhoduje iba príznak Stripe `cancel_at_period_end` (overený na skutočnom Stripe v E3): bez neho = zvolený dátum bez 48 h.
Unit testy rozšírené (skrátené obdobie), `test:subscriptions` 28/28, `test:subscriptions-lifecycle` 52/52,
`test:subscriptions-lifecycle-db` 82/82, `tsc` 0, `eslint` 0. DB pravidlá sa nemenili.

**Minimálny postup (PC vlastníka, sandbox `esblu-qa2`):** okno 1 `-NoListen` → `s12-events` → `s12-catchup` →
`verify-terminal` → `s13-existing`. Nové predplatné ani nový zákazník nevzniká; jediná zmena v Stripe je `cancel_at`
na existujúcom predplatnom E (ukončí sa po 5 min — E bolo už zrušené ku 18. 12.). `clock-setup`, `s12-cancel-at`
a `s12-refund-missing` netreba (vytvárali by nové predplatné bez nového dôkazu).

**Staging pred testom (pôvodné hodnoty zachované):** pred 19. 11. `web_provider='none'`, všetky ceny stripe neaktívne;
pre test `web_provider='stripe'`, aktívna `price_1UdE7t…`; po teste vrátiť `none` a cenu neaktívnu.

### 8.13 Výsledky reálnych integračných testov S12/S13 (19. 11. 2026, PC vlastníka) — PASS 4/4

Prostredie: lokálne Esblu (`af55a4d`) v okne 1 s **`-NoListen`** (žiadny webhook), staging DB, Stripe sandbox profilu
`esblu-qa2` — účet `acct_1UdCxsRKE4QKs2UL` (test mode), cena `price_1UdE7t…`. Bez nových predplatných a zákazníkov.

| # | Krok | Výsledok | Dôkaz (staging DB, read-only SQL) |
|---|---|---|---|
| I1 | `s12-events` | **PASS** — skutočné stránkovanie `ending_before` = rovnaké poradie ako plný zoznam, bez medzier a duplicít; neexistujúci kurzor → 400/404 | výstup vlastníka |
| I2 | `s12-catchup` | **PASS** — kľúč číta `/v1/account` a `/v1/events`; bootstrap nad reálnymi udalosťami 18. 11. (už spracované → `duplicate`), opakovaný beh bez zmeny stavu | `billing_event_cursors`: účet `acct_1UdCxsRKE4QKs2UL`, 34 spracovaných, `consecutive_failures` 0, bez chyby, lease uvoľnený |
| I3 | `verify-terminal` (D) | **PASS** — reálne volania novej reconciliation (platba aktuálnej faktúry) nad refundovaným D, výsledok `in_sync`, stav `refunded` bez zmeny | `billing_reconciliation` D: 12:34:18 UTC `in_sync` |
| I4 | `s13-existing` (E, prioritný) | **PASS** — Stripe pri `cancel_at` uprostred obdobia **skrátil `current_period_end`** na `cancel_at` a vrátil `cancel_at_period_end=false`; Esblu uložilo `scheduled_end_at`, nároky iba do 12:40:57 UTC (**bez 48 h**); po ukončení v Stripe `canceled`, 0 účinných nárokov; obe zmeny prišli **iba doťahovaním** | E: `customer.subscription.updated` 12:36:04 (`scheduled_end_at` 12:40:57) a `customer.subscription.deleted` 12:41:32, oba `processed`; účet `canceled`, `ended_at` = `scheduled_end_at` = `current_period_end` 12:40:57; 9/9 nárokov `revoked`, 0 účinných |

**Význam opravy S13 (`af55a4d`):** keďže Stripe obdobie skutočne skracuje (`current_period_end` = `cancel_at`),
pôvodná normalizácia z `ab8f186` (porovnanie `cancel_at` s koncom obdobia ± 5 min) by predčasné ukončenie vyhodnotila
ako riadny koniec a Esblu by **omylom pridalo 48 h**. Oprava (rozhoduje príznak `cancel_at_period_end`) to reálne
potvrdzuje I4. Bez opravy by test zlyhal.

**Po teste (19. 11. 2026 ~12:56 UTC):** staging vrátený do pôvodného stavu — `web_provider='none'`, všetky Stripe ceny
neaktívne (3 riadky ponechané ako dôkaz), 0 otvorených zámerov, 0 držaných lease, všetci QA používatelia zablokovaní.
Kurzor doťahovania ponechaný (technický stav, bez osobných údajov). Preview `dpl_2icCeeg6CrjwS6KotKrnVUXz3nuV` →
`ESBLU_BILLING_DISABLED`. Produkcia nedotknutá: nasadenie `main` @ `12da726` (17. 11.), posledná migrácia
`20261117213219`, žiadna z `20261118*` / `20261119*`, `billing_event_cursors` neexistuje, `web_provider='none'`
(read-only metadáta, záznam v `docs/ops/service-intervention-log.md`).

### 8.14 S17 runbook — P4 billing na skutočnom Stripe sandboxe (pripravené 20. 11. 2026, zatiaľ NESPUSTENÉ)

**Cieľ:** overiť funkcie P4 z `origin/main` `1e2ab73` (produkčný kód) so skutočným Stripe sandboxom a staging DB
— pripnutá verzia Stripe API, retry/doťahovanie, účtovná kópia faktúr a dobropisov s nemenným snapshotom odberateľa,
archív PDF, pozorovanie refundácie, balance transactions + mesačný export, poplatok/čistá suma. Operátor spustí **presne
2 príkazy** (okno 1 `-Step start`, okno 2 `-Step s17`); všetko ostatné je automatické a každý pod-krok vypíše
`[PASS]` / `[FAIL]` / `[LIMITATION]` až po overení **v Stripe aj v staging DB**.

**Predpoklady (PC operátora):**

| Čo | Ako |
|---|---|
| Stripe CLI profil `esblu-qa2` prihlásený do QA sandboxu (účet `acct_1UdCxs…`) | `npx --yes @stripe/cli@1.55.12 login --project-name esblu-qa2`; cena sandboxu `price_1UdE7t…` je v `%TEMP%\esblu-stripe-qa\sandbox-esblu-qa2.json` (z `-Step new-sandbox`, § 8.3a L5) |
| Testovací Secret key sandboxu | `$env:STRIPE_API_KEY` alebo skrytá výzva (Dashboard sandboxu → Developers → API keys); skript odmietne `*_live_*` |
| Staging service_role (`esblu-test`, `cjbdijbbcujvmrzezusd`) | skrytá výzva v **oboch** oknách (alebo `$env:ESBLU_QA_SERVICE_ROLE`); JWT iného projektu = stop; produkcia `fkpgvgvsmbpieduoatrt` sa nikdy nepoužije |
| Node 22.6+ (strip-types), git, Windows PowerShell 5.1 alebo 7 | `node -v`, `git --version` |
| Staging má migrácie P4 `20261123100000`–`20261123120000` + bucket `billing-documents` | stav k 20. 11. 2026: áno |
| Žiadny `.env*` s produkčným ref v checkoute | okno 1 to kontroluje |

**Worktree na `origin/main` + harness (jeden príkaz; hlavný checkout sa nemení):**

```powershell
git -C C:\Users\roiaj\assetpilot fetch origin; git -C C:\Users\roiaj\assetpilot worktree prune; git -C C:\Users\roiaj\assetpilot worktree add --detach C:\Users\roiaj\esblu-s17 ops/s17-sandbox
```

Vetva `ops/s17-sandbox` (lokálna, nepushnutá) = `origin/main` `1e2ab73` + iba harness (`scripts/stripe-local-sandbox.ps1`,
`scripts/s17-accounting-export.ts`) a tento dokument. Kontrola: `git -C C:\Users\roiaj\esblu-s17 diff --stat 1e2ab73 HEAD`
→ iba tieto 3 súbory. `-Step start` vypíše `HEAD: … | origin/main: … | aplikacny kod = 1e2ab73: ANO`; `-Step s17`
**odmietne beh**, ak sa aplikačný kód HEAD (vrátane necommitnutých zmien) líši od `1e2ab73`, ak lokálny `origin/main`
≠ `1e2ab73` alebo ak okno 1 beží z iného checkoutu/commitu (vedomé prepísanie iba `-Force`, zapíše sa do dôkazu).
Pri prvom `-Step start` sa v worktree spustí `npm ci` (node_modules potrebuje aj helper exportu).

**Dva príkazy:**

```powershell
# Okno 1 (Esblu next dev + stripe listen, staging DB) - nechať bežať:
cd C:\Users\roiaj\esblu-s17; powershell -ExecutionPolicy Bypass -File .\scripts\stripe-local-sandbox.ps1 -Step start

# Okno 2 (keď okno 1 vypíše "Ready"):
cd C:\Users\roiaj\esblu-s17; powershell -ExecutionPolicy Bypass -File .\scripts\stripe-local-sandbox.ps1 -Step s17
```

Voliteľne `-Month 2026-11` (default aktuálny mesiac UTC). Po audite: `… -Step s17-cleanup` (zmaže Test Clock S17;
idempotentne zopakuje aj obnovu stagingu — použiť aj po páde behu alebo Ctrl+C).

**Čo robí `-Step s17` (QA firma QA-STRIPE D, nový zákazník + predplatné na Test Clock, iba test mode):**

| # | Krok | PASS, keď |
|---|---|---|
| 1 | Preflight + zapnutie billingu na stagingu iba pre test | kľúč `sk/rk/rkcs_test_`, staging ref, HEAD = `1e2ab73` (aplikačný kód), okno 1 beží s `stripe listen` z toho istého commitu; pôvodný stav (`web_provider`, `active` každej Stripe ceny) uložený do `%TEMP%\esblu-stripe-qa\s17-esblu-qa2.json` **pred** zmenou; potom `web_provider='stripe'` + aktívna iba cena sandboxu |
| 2 | Pripnutá verzia + lokálny cron `/api/cron/billing-stripe-events` (lokálny `CRON_SECRET`) | `success`, `configured`, `result` ok, žiadny kód (`*VERSION*`, `NOT_CONFIGURED`); zaznamená verziu udalostí účtu (`/v1/events`) a verzie webhook endpointov vs. pripnutá `2025-03-31.basil` (čítaná z `lib/billing/stripe-api-version.ts`) |
| 3 | Nákup bez zadávania karty | zámer Esblu firmy D → Test Clock → zákazník → `pm_card_visa` → predplatné (metadata `esblu_checkout_id`); Stripe: faktúra `paid`, predplatné `active`; faktúra načítaná s pripnutou verziou má `invoice.parent.subscription_details`; Esblu: účet `active` firmy D, skutočné `invoice.paid` v `billing_events` = `processed` |
| 4 | Účtovná kópia faktúry | `billing_invoice_documents`: `kind=invoice`, `status=paid`, `company_id`=D, `provider_subscription_id`, `provider_customer_id`, EUR 1590, `payment_intent_id` = Stripe `/v1/invoice_payments`, obdobie služby = riadok faktúry v Stripe, `issued_at`, `pdf_url`; snapshot `customer_company_id`=D, `customer_legal_name`, `customer_snapshot_at`, `customer_snapshot_source='company'` (IČO/DIČ/adresa sa iba vykážu — syntetická firma ich mať nemusí) |
| 5 | Archív PDF | lokálny cron `/api/cron/billing-documents` → `pdf_sha256` + `pdf_storage_path` = `test/YYYY/MM/invoice/<in_…>.pdf`; objekt stiahnutý zo staging storage (service role) začína `%PDF-` a jeho SHA-256 = DB |
| 6 | Čiastočná refundácia dobropisom | Stripe `credit_notes` (5,00 EUR, `refund_amount`) → charge `amount_refunded=500`; Esblu: `credit_note.created` + `charge.refunded` spracované (webhook), doklad `credit_note` s `related_invoice_id` = faktúra, firma D, snapshot; `billing_refund_observations` = 500; Stripe aj Esblu ostávajú `active`, nároky ostávajú |
| 7 | Zmeškaná udalosť + idempotencia | skript **sám zastaví `stripe listen` okna 1** (strom procesov), vytvorí 2. dobropis 1,00 EUR (`out_of_band_amount`, bez pohybu peňazí); po 20 s v Esblu 0 riadkov aj 0 dokladov; doťahovanie → udalosť presne 1×, doklad 1×; opakované doťahovanie → bez zmeny (`processed_at`, `updated_at`). **`stripe listen` ostáva zastavený** (Esblu beží ďalej; webhooky = reštart okna 1) |
| 8 | Mesačný export bez prehliadača | `node … scripts/s17-accounting-export.ts` (kód aplikácie: `importStripeBalanceTransactions` s `StripeTestProvider` = pripnutá verzia, RPC `esblu_billing_accounting_export`, `buildAccountingCsv`); CSV **iba** do `%USERPROFILE%\esblu-backups\s17\` (OneDrive aj repozitár odmietne; iba syntetické QA dáta stagingu); faktúra + 2 dobropisy S17 v exporte, import nie je orezaný |
| 9 | Poplatok / čistá suma | Stripe balance transaction platby: `fee > 0`, `net = gross − fee`; export faktúry gross/fee/net = Stripe a obsahuje ID BT; export dobropisu = súčet refund BT v Stripe |
| 9b | Výplata (payout) | v sandboxe zvyčajne žiadna → **LIMITATION** (nikdy PASS); ak existuje, iba INFO |
| 10 | Izolácia a duplicity | presne 1 doklad na Stripe doklad (faktúra, 2 dobropisy), presne 1 riadok na každú udalosť S17, všetky doklady zákazníka S17 = firma D (aj snapshot), žiadne nové doklady firmy D od iného zákazníka, žiadne duplicitné udalosti od začiatku testu |
| 11 | Obnova stagingu (vždy, aj po FAIL) | Stripe predplatné `canceled` (okamžite) → Esblu účet `canceled` cez doťahovanie (listen je zastavený), 0 účinných nárokov firmy D; `web_provider` a `active` každej ceny = pôvodné hodnoty (overené čítaním); dôkazy (`billing_events`, doklady, archív PDF, ledger, export log) ostávajú; Test Clock ostáva pre audit (`s17-cleanup`) |

**Očakávaný výstup okna 2 (koniec):**

```
  S17-1   PASS        Preflight (test mode, staging, HEAD = origin/main) + zapnutie billingu na stagingu
  …
  S17-9b  LIMITATION  Vyplata (payout) - v sandboxe nie je
  S17-10  PASS        Izolacia a duplicity (...)
  S17-11  PASS        Obnova stagingu
S17 celkovo: PASS (LIMITATION: 1)
```

**Dôkazy:** `C:\Users\roiaj\assetpilot\release-backups\s17\s17-evidence.json` (hlavný checkout aj pri behu z worktree;
priečinok je v `.git/info/exclude`) — stav a detaily každého kroku, skrátené Stripe ID (prefix), počty, sumy v centoch,
SHA-256 PDF a CSV, HEAD/strom/origin/main; žiadne kľúče, `whsec_`, JWT, e-maily, mená ani URL dokladov. Plné CSV iba v
`%USERPROFILE%\esblu-backups\s17\`. Výpis okna 2 je maskovaný rovnako.

**Verzia API a `stripe listen` (čo výsledok znamená):** `stripe listen` bez `--latest` preposiela udalosti vo verzii
**predvolenej pre účet sandboxu** (nie v pripnutej). Esblu pri každej udalosti znova načíta stav predplatného z API
s hlavičkou `Stripe-Version: 2025-03-31.basil`; účtovnú kópiu dokladu berie z tela udalosti (verzia účtu) a PaymentIntent
dopĺňa cez `/v1/invoice_payments` s pripnutou verziou. Ak sa verzia účtu líši, webhook vyvolá ops alert
`WEBHOOK_API_VERSION_MISMATCH` (warning) a spracovanie pokračuje — S17 to zapíše (krok 2/3), nie je to FAIL. Pre live
endpoint platí § P4: verzia endpointu v Dashboarde = pripnutá verzia.

**LIMITATION (nie PASS):** (1) výplaty — sandbox spravidla nevytvorí payout, väzba BT → payout je overená iba DB testami;
(2) daňové polia — bez Stripe Tax v sandboxe sú DPH polia dokladu 0 / prázdne (S17 ich iba prenáša); (3) obnovy, zlyhania platby a plná refundácia sa v S17
neopakujú (PASS v L7, L12–L15, § 8.13); (4) skutočný výpadok siete / dead-letter po 8 pokusoch sa nereprodukuje
(DB testy `test:billing-ops-db`). **INFO:** nezhoda verzie udalostí účtu s pripnutou verziou (pozri vyššie).

**Čo test mení:** staging — dočasne `web_provider='stripe'` + aktívna cena sandboxu (vrátené v kroku 11), 1 zámer
checkoutu firmy D, riadky `billing_events` / dokladov / refundácie / ledgera / export logu (zachované ako dôkaz), 1 PDF
v `billing-documents`; Stripe sandbox (test mode) — 1 Test Clock, 1 zákazník, 1 predplatné (ukončené), 1 faktúra,
2 dobropisy, 1 refundácia 5,00 EUR. Produkcia, Vercel ani Preview sa nemenia.

**Validácia harnessu (agent, offline, 20. 11. 2026):** helper `scripts/s17-accounting-export.ts` — `tsc --noEmit` 0 chýb
(projekt aj helper samostatne, `scripts/` je mimo tsconfig), `eslint` 0, poistky overené spustením bez siete
(produkčný ref, live kľúč, OneDrive / repozitár ako cieľ CSV, neplatný mesiac → odmietnuté). PowerShell: oficiálny
parser (`pwsh` z GitHub Releases) bol v prostredí agenta **nedostupný** (proxy blokuje stiahnutie, HTTP 403), syntax
overená gramatikou tree-sitter-powershell 0.26.6 (0 chýb; pôvodný skript tiež 0; umelo pokazené kópie chyby nájde).
**Pred prvým behom** (PC operátora, priamo v okne PowerShell, 1 s, nič nespúšťa):

```powershell
$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile("C:\Users\roiaj\esblu-s17\scripts\stripe-local-sandbox.ps1",[ref]$null,[ref]$e); "parse errors: $($e.Count)"
```

očakávané `parse errors: 0` (PowerShell aj tak celý súbor parsuje pred spustením — syntaktická chyba by nič nezmenila).

**Zmena okna 1 (kompatibilná):** `stripe listen --events` odoberá navyše dokladové udalosti P4 (`invoice.finalized`,
`invoice.voided`, `invoice.marked_uncollectible`, `credit_note.created|updated|voided`, `customer.subscription.paused|resumed`
= rovnaká množina ako doťahovanie), ukladá PID `listen` a HEAD do `%TEMP%\esblu-stripe-qa\` (mažú sa pri Ctrl+C).
Existujúce kroky sa nezmenili.

### 8.7 Upratanie stagingu (19. 11. 2026, dôkazy zachované)

| Položka | Stav |
|---|---|
| `billing_runtime_config.web_provider` | `stripe` → **`none`** (billing na stagingu vypnutý) |
| `billing_provider_prices` stripe/test/`esblu_complete` | všetky `active=false` (riadky ponechané ako dôkaz) |
| QA používatelia `qa-stripe-c/d/e`, `qa-checkout-a/b` | všetci `banned_until=infinity`; heslá C a E zneplatnené náhodným hashom; relácie a refresh tokeny C, E zmazané (0 relácií QA) |
| Otvorené checkout zámery | 0 |
| Zachované dôkazy | `billing_events` (42: 34 processed, 5 stale, 3 ignored), 4 účty QA (A fake `active`, C `active`, D `refunded`, E `active` + `cancel_at_period_end`), `billing_reconciliation`, nároky |
| Vercel Preview vetvy | `ESBLU_BILLING_MODE=off`, `NEXT_PUBLIC_ESBLU_BILLING_UI=0`, fake secret prázdny (bez zmeny); Stripe kľúče vo Verceli nikdy neboli |
| Stripe sandboxy (test mode) | žiadne skutočné platby. E: Stripe ukončí 18. 12. (`cancel_at`); webhook už nepríde (staging billing vypnutý) → nároky E vypršia 20. 12. (fail closed) |
| Firma C (19. 11. 2026) | Esblu: syntetická operátorská udalosť `esblu.sync.operator_cancel` (`operator:qa-cleanup:sub_1UdChQB5dmk5ax59OxkKJaun`, cez `esblu_billing_record_event` + `esblu_billing_apply_event`, `processed`) → účet `canceled`, `ended_at` 08:58 UTC, 0 účinných nárokov. Stripe (pôvodný sandbox `B5dmk5ax59`, predvolený profil CLI) — **vlastník**: `npx --yes @stripe/cli@1.55.12 subscriptions cancel sub_1UdChQB5dmk5ax59OxkKJaun` (ak kľúč sandboxu už neplatí, sandbox zmazať: `stripe sandboxes delete`) |
| Kontrola Preview `729de27` (19. 11.) | `dpl_GnaBT839QpRvtDcC5tGLQL3QsL1V` READY; `/api/billing/purchase-options` → 404 `ESBLU_BILLING_DISABLED`; stránka Predplatné: „Online predplatné zatiaľ nie je dostupné.“, `subscription` aj `purchase-options` 404; panel „Plán a čerpanie firmy“ preložený v sk/en/de, 0 surových kľúčov. Prihlásenie: dočasne odblokovaný owner E, potom znova zablokovaný, heslo zneplatnené, relácie zmazané |


### 8.4 Runbook — reálny Stripe test (sandbox + Vercel Preview + staging DB)

1. **Vlastník (PowerShell na PC, Node je nainštalovaný):**
   `npx @stripe/cli@1.55.12 sandboxes create --email <adresa> --non-interactive` — anonymný claimable sandbox, test kľúče
   v profile CLI. (Adresa sa posiela Stripe; použiť firemnú alebo vlastnú.)
2. **Vlastník:** `npx @stripe/cli@1.55.12 prices create --currency eur --unit-amount 1590 -d "recurring[interval]=month" -d "product_data[name]=Esblu Komplet (test)"` → poslať agentovi `price_…` (nie je tajné).
3. **Agent (po súhlase):** Vercel → `esblu` → Deployment Protection → *Protection Bypass for Automation* (tajomstvo pre
   doručenie webhookov do chránenej Preview); pošle vlastníkovi presnú webhook URL.
4. **Vlastník:** `npx @stripe/cli@1.55.12 webhook_endpoints create --url "<URL od agenta>" -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=checkout.session.expired" -d "enabled_events[]=customer.subscription.created" -d "enabled_events[]=customer.subscription.updated" -d "enabled_events[]=customer.subscription.deleted" -d "enabled_events[]=invoice.paid" -d "enabled_events[]=invoice.payment_failed" -d "enabled_events[]=charge.refunded" -d "enabled_events[]=charge.dispute.created" -d "enabled_events[]=charge.dispute.closed"` → `whsec_…`.
5. **Vlastník (Vercel UI, nie do chatu):** Preview, vetva `android-release-payments-ios-2026-11-18`: `STRIPE_SECRET_KEY`
   (`sk_test_…` z `npx @stripe/cli@1.55.12 config --list`) a `STRIPE_WEBHOOK_SECRET` (`whsec_…`).
6. **Agent:** `ESBLU_BILLING_MODE=stripe_test`, `NEXT_PUBLIC_ESBLU_BILLING_UI=1`, `ESBLU_BILLING_RETURN_ORIGIN` (vetva),
   staging `billing_provider_prices` (stripe/test/esblu_complete/month/`price_…`) + `web_provider='stripe'`, redeploy, QA firma.
7. **Testy:** nákup (karta `4242 4242 4242 4242` — **zadáva vlastník** na `checkout.stripe.com`), aktivácia po webhooku,
   odmietnutá karta `4000 0000 0000 0002`, obnova (`subscriptions update <sub> -d billing_cycle_anchor=now -d proration_behavior=none`),
   zlyhanie obnovy (platobná metóda `pm_card_chargeCustomerFail` + nové obdobie), vypnutie obnovy v Esblu, refund
   (`refunds create --charge <ch>` plný / `--amount 500`), dve karty naraz (agent), spor (`pm_card_createDispute`).
8. **Cleanup:** staging `web_provider='none'`, Preview premenné vetvy vypnúť, bypass zrušiť, sandbox `stripe sandboxes delete`.

## 6. Otázky do podmienok predplatného (pre CLIA)

Pozri `docs/clia-delta-2026-11-24-draft.md` § 3: kto je predajca, kedy vzniká nárok na refund, či čiastočná refundácia
mení prístup, čo sa deje s dátami po ukončení, ako zákazník vypína obnovovanie a lehoty oznámení o zmene ceny.

#### 8.14a Oprava získania webhook secretu (2026-11-20)
- Príčina: skript vždy volal `npx --yes @stripe/cli@1.55.12` (aj keď bol nainštalovaný natívny Stripe CLI cez WinGet) a `Get-ListenSecret` zahodil výstup aj exit kód → každé zlyhanie npx/profilu sa prejavilo iba ako „nevrátil whsec_“. Navyše pri 1-prvkovom príkaze (natívny `stripe.exe`) by `$cli[1..0]` odovzdal samotný program ako argument.
- Oprava: poradie `ESBLU_STRIPE_CLI` → natívny `stripe` v PATH → npx; bezpečné delenie argumentov; `listen --print-secret --project-name <profil>` (rovnako ako overený ručný príkaz); pri zlyhaní maskovaná diagnostika (exit kód + 6 riadkov). `stripe listen` v okne 1 používa ten istý CLI.
- Kompromitované tajomstvá: `exposed.sha256` je zoznam odtlačkov (1/riadok); nový krok `-Step mark-exposed -Project <profil>` (bez platieb, bez výpisu tajomstva) pridá odtlačok aktuálneho whsec_ profilu. `start` aj `new-sandbox` odmietnu každé evidované tajomstvo.
- Whsec_ profilu `esblu-qa2` bol zverejnený v konverzácii → po `mark-exposed` je profil pre testy nepoužiteľný; ďalší test vyžaduje nový sandbox (`-Step new-sandbox -Project esblu-qa3 -Email <adresa>`), ktorý vytvorí nový účet, novú cenu a mapovanie na stagingu.

#### 8.14b Bezpečný `-Step new-sandbox` (2026-11-20)
Pred **prvým zápisom** (`stripe sandboxes create`): zdedená `STRIPE_API_KEY` sa zmaže z procesu; tajomstvo `esblu-qa2` musí byť v `exposed.sha256` (inak STOP); staging sa overí read-only (URL `cjbdijbbcujvmrzezusd`, `billing_runtime_config.environment=test`, čítanie `internal_operator_grants` = kľúč je service_role); nový profil musí byť prázdny.
Pred **cenou**: `account_id` nového profilu sa líši od default a `esblu-qa2`; kľúč sa berie iba z profilu (žiadna výzva ani premenná) a `/v1/account` musí vrátiť ten istý účet (403 = identita podľa profilu); nové whsec_ nie je kompromitované. Po cene `Assert-StripeAccount` (kľúč vidí cenu, Test Clocks).
Staging mapovanie je obnoviteľné: restore súbor → nový riadok neaktívny → staré neaktívne → nový aktívny → kontrola presne 1 aktívna; pri chybe návrat na predchádzajúci stav. Opakovanie iba mapovania: `-Step map-price -Project <profil>`.
`-Project` sa musí zadávať vždy výslovne; `esblu-qa2` je povolený iba pre `mark-exposed` a `status`.

#### 8.14c Kompromitovaný CLI kľúč `esblu-qa3`, chýbajúce mapovanie ceny, statická revízia `start`/`s17` (2026-11-20)
**Platí namiesto `esblu-qa2` v § 8.14** (profil `esblu-qa2` je blokovaný). Oba príkazy vždy s `-Project esblu-qa3`:

```powershell
# Okno 1:
cd C:\Users\roiaj\esblu-s17; powershell -ExecutionPolicy Bypass -File .\scripts\stripe-local-sandbox.ps1 -Step start -Project esblu-qa3
# Okno 2 (po "Ready"):
cd C:\Users\roiaj\esblu-s17; powershell -ExecutionPolicy Bypass -File .\scripts\stripe-local-sandbox.ps1 -Step s17 -Project esblu-qa3
```

- **Kompromitovaný CLI kľúč:** `test_mode_api_key` profilu `esblu-qa3` (`rkcs_test_…`) bol zverejnený → `$CompromisedKeyProjects = @("esblu-qa3")`. Pre takýto profil `Get-StripeTestKey` **nepoužije** kľúč z profilu ani zdedenú `STRIPE_API_KEY` (zmaže ju z procesu) a vyžaduje skrytú výzvu (`Read-Host -AsSecureString`) na **nový** kľúč sandboxu `sk_test_`/`rk_test_` (CLI kľúč `rkcs_` sa odmietne). Ak sa SHA-256 zadaného kľúča zhoduje s SHA-256 kľúča z profilu, skript skončí. Porovnávajú sa iba odtlačky; odtlačok kompromitovaného kľúča sa uloží do `%TEMP%\esblu-stripe-qa\compromised-keys.sha256` (nie je tajomstvo), aby kontrola platila aj po presune kľúča do systémového trezoru. Live kľúče sa naďalej odmietnu.
  Pred testom v Dashboarde sandboxu `acct_1UdoxE…`: Developers → API keys → zmazať/rotovať reštriktívny kľúč Stripe CLI a vytvoriť/rotovať Secret key; ten sa vloží do výzvy v **oboch** oknách.
- **Identita účtu:** `Assert-StripeAccount` okrem ceny (15,90 EUR/mes.) a Test Clocks overí `GET /v1/account` = `account` zo `sandbox-<profil>.json`; ak ho súbor nemá (staršia verzia skriptu — prípad `esblu-qa3`), porovná sa s `account_id` profilu (`stripe config --list --project-name`). HTTP 403 (reštriktívny kľúč bez práva na účet) sa toleruje — účet potom potvrdzuje cena viazaná na účet.
- **Chýbajúce mapovanie ceny na stagingu:** S17-1 najprv spustí `Assert-StagingAccess` (read-only), vyžaduje `web_provider='none'`, uloží pôvodný stav (`web_provider`, `active` každej Stripe/test ceny) a až potom, ak pre `price_1UdpE1…` neexistuje riadok `billing_provider_prices`, ho vytvorí obnoviteľným `Set-StagingPriceMapping` (restore súbor → nový riadok neaktívny → staré neaktívne → nový aktívny → presne 1 aktívna). Obnova (S17-11 aj `-Step s17-cleanup`) vypne každú aktívnu cenu, ktorá pred S17 aktívna nebola (vrátane novej), zapne pôvodne aktívne (teraz žiadne) a vráti `web_provider='none'`; riadok mapovania ostáva neaktívny. `Assert-StagingAccess` beží aj v `-Step start` (pred spustením Esblu) a v `-Step s17-cleanup`.
- **Statická revízia (Windows PowerShell 5.1):** TLS 1.2 pre `Invoke-RestMethod` na .NET Framework; časy pre PostgREST filtre formátované s `InvariantCulture`; `Read-Host -AsSecureString` cez BSTR s `ZeroFreeBSTR` + `Trim()` (aj service_role); ukončenie okna 1 zabije celý strom `stripe listen` (`taskkill /T`); odstránené ne-ASCII znaky (súbor bez BOM). Helper exportu sa spúšťa rovnako ako testy repozitára (`node --experimental-strip-types --import ./scripts/alias-loader.mjs`, Node 22.6+, `node_modules` checkoutu `esblu-s17`); načítanie modulov overené v Linuxe (Node 22).
- **Rozsah S17** zostáva iba P4 (pripnutá verzia, účtovná kópia + snapshot, archív PDF, dobropis/čiastočná refundácia, zmeškaná udalosť + idempotencia, export gross/fee/net, payout = LIMITATION); obnovy, zlyhané obnovy, zrušenia ani 48 h (S12/S13/S16) sa nespúšťajú — S17-11 iba upratuje QA predplatné.
- **Známe obmedzenie:** `stripe listen` zapisuje do `%TEMP%\esblu-stripe-qa\listen*.log` aj riadok s `whsec_` (lokálny súbor používateľa; maže sa pri štarte a pri Ctrl+C okna 1; výpisy cez `-Step status` sú maskované).

#### 8.14d esblu-qa3 vyradený, jeden príkaz `-Step s17-auto` (2026-11-20)
- `esblu-qa3` (`acct_1UdoxE…`): CLI kľúč `rkcs_test_` zverejnený; prevzatie sandboxu Stripe odmieta (hlavný účet Esblu nie je aktivovaný) → kľúč sa nedá rotovať ani zmazať v Dashboarde. Profil je zablokovaný v skripte (`$CompromisedProjects`), odtlačok jeho kľúča ide do `compromised-keys.sha256` a žiadny kľúč s týmto odtlačkom sa nikdy nepoužije. Sandbox nie je mapovaný na staging, nedostáva webhooky Esblu a automaticky zanikne 27. 11. 2026 (bez dopadu na staging/produkciu; prípadne `stripe sandboxes delete` po ručnom overení syntaxe CLI).
- Nový izolovaný sandbox (napr. `esblu-qa4`) vytvorí `new-sandbox` s overeniami pred zápisom (§ 8.14b) + nová read-only sonda: kľúč a pripnutá `Stripe-Version` majú prístup k Test Clocks, cenám, zákazníkom, predplatným, faktúram, dobropisom, refundom, platbám, udalostiam a balance transactions (payouts = LIMITATION).
- `-Step s17-auto -Project <nový> -Email <adresa>`: jedna skrytá výzva (staging service_role) → nový sandbox (ak profil nemá cenu) → okno 1 v novom okne (`npm ci` ak chýba) → S17 → `s17-cleanup` → zastavenie okna 1 + zmazanie logov `stripe listen` a lokálneho CRON_SECRET. Pri chybe pred S17 sa staging nemení.

#### 8.14e balance_transactions 403 → LIMITATION, pokračovanie s esblu-qa4 (2026-11-20)
- Príčina: CLI kľúč claimable sandboxu (`rkcs_test_`) nemá právo **Balance transactions: read**; `GET /v1/balance_transactions` s `Stripe-Version 2025-03-31.basil` vrátil **403** (oprávnenie), nie 400/404 (chyba endpointu alebo verzie). Endpoint aj verzia sú správne. Iný kľúč pre neprevzatý sandbox získať nemožno (prevzatie odmietnuté) a obchádzanie oprávnení sa nerobí.
- Sonda teraz rozlišuje: povinné zdroje (Test Clocks, ceny, zákazníci, predplatné, faktúry, dobropisy, refundy, platby, udalosti) → inak STOP; účtovné (`balance_transactions`, `payouts`): 403 = LIMITATION a S17 pokračuje, 401/400/404 = STOP.
- S17-8 exportuje doklady (faktúra, dobropisy, snapshot) aj bez ledgeru (`ledger: PERMISSION_DENIED` v dôkaze); S17-9 (poplatok/čistá suma) a S17-9b (výplata) = **LIMITATION**, nie PASS.
- Dôsledok pre účtovnú pripravenosť: hrubé sumy dokladov, väzby a snapshot sú overené so skutočným Stripe; poplatky, čisté sumy a výplaty iba DB testami. Pred LIVE: pri prvej internej live platbe overiť import s restricted reporting kľúčom (Balance transactions read + Payouts read).
- `new-sandbox` pokračuje na existujúcom nekompromitovanom profile bez ceny (bez nového sandboxu); cena má `lookup_key esblu_complete_month_s17` a pri opakovaní sa použije znova (bez duplicity).

#### 8.14f Pokračovanie na existujúcom sandboxe – oprava identity (2026-11-20)
- Príčina: Stripe CLI bez `--project-name` nepoužíva profil `default`, ale aktuálny `project-name` z `config.toml`; `stripe sandboxes create --project-name esblu-qa4` ho prepol na `esblu-qa4`. „Účet default“ bol preto účet `esblu-qa4` → kontrola odmietla vlastný sandbox. Tá istá chyba pridala odtlačok whsec_ aktuálneho profilu medzi kompromitované.
- Oprava: profil `default` sa číta vždy výslovne (`--project-name default`). Identita: účet testovaného profilu nikdy nesmie byť účet `default`, `esblu-qa2`, `esblu-qa3`; nový sandbox = profil pred zápisom bez účtu; pokračovanie = účet profilu pred behom == po behu (žiadna zmena). Kompromitované kľúče a whsec_ sa naďalej odmietajú.
- Omylom pridaný odtlačok whsec_ testovaného profilu sa odstráni iba pri pokračovaní a iba s prepínačom `-ReleaseAutoMarked` (vedomé potvrdenie operátora, že tajomstvo nebolo zverejnené; záznam `exposed-released.log`); pre `esblu-qa2`/`esblu-qa3` nikdy.
- Simulácia 11 scenárov (nový sandbox, pokračovanie, zmena účtu, účet default/qa3, profil qa3, kompromitovaný kľúč, whsec v zozname s/bez prepínača): očakávané PASS/FAIL. S17-9/9b ostávajú LIMITATION pri 403 na balance_transactions.

#### 8.14g S17-2 ACCOUNT_MISMATCH – kurzor udalostí zo S16 (2026-11-20)
- Príčina: staging `billing_event_cursors` (stripe/test) bol viazaný na účet sandboxu S16 `acct_1UdCxsRKE4QKs2UL` (esblu-qa2, 34 spracovaných udalostí, posledný úspech 2026-11-19 12:41 UTC). S17 beží na `esblu-qa4` `acct_1UdohqBll2LfrkP1` → cron `billing-stripe-events` správne vrátil `ACCOUNT_MISMATCH` (zámerná ochrana v `esblu_billing_event_cursor_claim`). Nie je to chyba aplikácie; harness nerobil operátorský reset, ktorý migrácia predpokladá.
- Oprava (iba harness, aplikácia a kontrola účtu bez zmeny): S17-1 po uložení pôvodného stavu uloží celý riadok kurzora do stavu S17 a až potom ho zmaže (iba ak patrí inému účtu a nemá aktívny lease); cron ho založí pre účet testu. S17-11 / `s17-cleanup` zmaže iba kurzor testovaného účtu a vráti pôvodný riadok (idempotentne, overené podľa účtu a poslednej udalosti).

#### 8.14h Uzavretie S17: návrat na pôvodné prostredie `esblu-qa2`, bez ďalších sandboxov (2026-11-20)
- **Príčina zlyhania S17-3 na `esblu-qa4`:** kľúč `rkcs_test_` neprevzatého sandboxu má obmedzené práva — `GET test_helpers/test_clocks` = 200, ale `POST` = 403 (text Stripe: „claimable sandbox key with limited permissions“). Sonda harnessu testovala iba čítanie → nedostatok harnessu. Prevzatie `esblu-qa3/qa4` Stripe odmieta (hlavný účet nie je aktivovaný) → anonymné sandboxy sú pre S17 slepá ulička.
- **Pôvodné funkčné prostredie:** `esblu-qa2` = **prevzatý** sandbox `acct_1UdCxsRKE4QKs2UL` (L5/L6: prevzatie + `stripe login`, plný Secret key cez skrytú výzvu). Na ňom PASS: Test Clocks, obnovy, zlyhané platby, refundy, webhooky (L1, L7–L11), S12 I1–I3, S13 I4, kurzor 34 udalostí. Zverejnené bolo **iba** jeho `whsec_` zo `stripe listen`; API kľúč nie (`compromised-keys.sha256` = 1 odtlačok, `esblu-qa3`).
- **Harness:** nové sandboxy vypnuté (`new-sandbox` aj automatika `s17-auto`); `esblu-qa2` povolený iba pre `s17-auto`/`s17`/`s17-cleanup`/`status` a `start -NoListen`; očakávaný účet pripnutý; `whsec_` sa nečíta — lokálny webhook má náhodné jednorazové tajomstvo (overenie podpisu ostáva, podvrh = 400); udalosti iba cez doťahovanie (tá istá pipeline `processVerifiedEvent`); kľúč `rkcs_test_` sa pre zápisy odmietne (výzva na `sk_test_`); sonda zápisu `POST test_clocks` bez parametra (400 = oprávnené, nič nevznikne; 403 = STOP pred zápisom do stagingu); `s17-cleanup` označí zámer checkoutu QA-STRIPE D z neúspešného behu ako `expired`.
- Webhook podpis: kód overenia podpisu sa od S15 nezmenil (P4 pridal iba signály ops alertov) → pokrytý S12/S16 + unit testami.
