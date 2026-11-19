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
predplatné skontrolovala (kandidát pri `current_period_end < now + 1 deň`) a stav opravila. Rozhodnutie na zváženie (nie
chyba): pri `cancel_at_period_end=true` nepridávať rezervu (obnova už nenastane) — zmena migrácie, na rozhodnutie vlastníka.

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
