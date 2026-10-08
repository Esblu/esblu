# Unified subscriptions — nákup predplatného priamo z mobilnej aplikácie

> Nahrádza odporúčanie „mobil = iba prihlásenie a používanie“ v `subscriptions-store-compliance-2026-10-08.md` (sekcia 4).
> Zdroje: oficiálne stránky Apple, Google a Stripe, overené 8. 10. 2026. Položky **NEOVERENÉ** treba potvrdiť pred enrollmentom.
> Stav: **staging / test.** Žiadny enrollment, žiadny live režim, žiadne produkčné secrets.

## Princíp

```
Web (Stripe) ─┐
iOS (StoreKit IAP | EÚ: ExternalPurchaseCustomLink → Stripe) ─┼─► normalizovaný stav ─► subscription_accounts (1 na firmu)
Android (Play Billing | EEA: billing choice → Esblu/Stripe) ──┘                       └─► company_entitlements(source='subscription')
```

- Každý kanál končí v tom istom kanonickom stave a prepočte rovnaké nároky.
- **Neexistuje „mobilný plán“.** Platforma ani krajina sa nedostanú do entitlement engine.
- Kanál, ktorým predplatné vzniklo, sa ukladá iba ako informácia (`purchase_method`) a pre povinnosť reportingu obchodu (`store_reporting`).
- **Geografické pravidlá sú dáta:**
  - `billing_region_groups`: EU27, EEA, …
  - `billing_channel_rules`: platforma × krajina / skupina / `*` → zoznam metód. Najšpecifickejšie pravidlo vyhráva.
  - `billing_runtime_config.enabled_methods`: globálny kill-switch.
  - Zmena = UPDATE riadku, bez zmeny kódu.

## B. Web checkout flow

Predplatné → plán → mesačne / ročne → **Pokračovať na platbu** →
`POST /api/billing/purchase-intent {method: stripe_web_checkout}` → Stripe-hosted Checkout (karta; Apple Pay a Google Pay podľa Stripe Dashboardu) →
webhook (`checkout.session.completed`, `invoice.paid`, …) → kanonický stav →
UI čaká na `GET /api/billing/checkout/[id]` = `completed` a aktívne predplatné.

Query `?checkout=returned` nie je dôkaz platby.

## C. Android EEA checkout flow — billing choice program (scenár 1A)

**Prečo tento variant:**
- Google ho spustil 30. 6. 2026 a je to jediný EEA program, ktorý dovoľuje **Play Billing aj vlastný billing v tej istej appke**. External offers sa s Play Billing kombinovať nedá.
- Choice screen kreslí Google, takže compliance práce na UX je najmenej.
- Používateľ ostáva v appke: Stripe Checkout sa otvorí v Custom Tab, nikdy nie na desktope.

**Postup:**
1. Predplatné → plán → mesačne / ročne → **Kúpiť**.
2. `purchase-intent {method: google_play}` → server vráti `productId`, `basePlanId` a `accountToken` (nereverzibilný token firmy).
3. Natívny plugin spustí `launchBillingFlow` s `setObfuscatedAccountId(accountToken)` + `enableDeveloperBillingOption(BILLING_CHOICE)` → **Google choice screen**.
   - **Používateľ zvolí Google Play** → `purchaseToken` → `POST /api/billing/mobile/confirm`.
     - Server zavolá `purchases.subscriptionsv2.get` (autoritatívny stav), zapíše kanonický stav a urobí **acknowledge** (do 3 dní, inak auto-refund).
   - **Používateľ zvolí Esblu** → `DeveloperProvidedBillingListener` → `externalTransactionToken`.
     - → `purchase-intent {method: google_choice_developer, storeToken}` → Stripe Checkout v **Custom Tab** (`origin_context=mobile_app`).
     - → Stripe webhook → kanonický stav.
     - → outbox `billing_store_reports` (`google_initial`, termín do **24 h**) → cron `/api/cron/billing-store-reports` zavolá `externalTransactions.createexternaltransaction`.
     - Obnovy sa reportujú ako `google_renewal` (`initialExternalTransactionId`), refundy ako `google_refund` (`:refund`).
4. Návrat: App Link `https://www.esblu.com/nastavenia/predplatne?checkout_id=…` (manifest + `deep-link-resolve`). UI medzitým polluje server.
5. Zmena plánu: `SubscriptionUpdateParams.setOldPurchaseToken` → nový token s `linkedPurchaseToken`. Server ho prijme ako náhradu, nie ako druhé predplatné.
   - Predplatné kúpené cez Esblu billing sa mení cez Stripe (`/api/billing/manage`).
6. Zrušenie: Play subscriptions center (plugin `manageSubscriptions`) → RTDN (Pub/Sub, OIDC overené) → `cancel_at_period_end` všade.

## D. iOS EÚ checkout flow — Apple IAP + ExternalPurchaseCustomLink (Attachment 14, od 1. 10. 2026)

**Prečo tento variant:**
- Esblu je samoobslužný SaaS, ktorý si kúpi aj živnostník alebo 1 používateľ. Guideline 3.1.3(c) („**only** sold directly … to organizations“) **na to nestačí**.
- 3.1.3(b) Multiplatform v EÚ vyžaduje IAP a/alebo alternatívny PSP v appke. Preto je IAP vždy dostupný.
- Apple od 1. 10. 2026 vyžaduje pre externé platby `ExternalPurchaseCustomLink`. Starý `ExternalPurchase.presentNoticeSheet` pre EÚ už neplatí.

**Postup:** Predplatné → plán → mesačne / ročne → **dve rovnocenné tlačidlá**. IAP musí byť aspoň rovnako výrazné; v UI majú obe tlačidlá rovnaký štýl.

1. **Kúpiť cez App Store (IAP)**
   - `purchase-intent {method: apple_iap}` → `productId` + `appAccountToken` (UUID).
   - StoreKit 2 `Product.purchase(options: [.appAccountToken])` → `jwsRepresentation`.
   - `POST /api/billing/mobile/confirm`: server overí JWS (reťaz `x5c` k Apple Root CA - G3, Apple OID, ES256), bundle ID a Sandbox prostredie → kanonický stav.
   - Notifikácie: App Store Server Notifications V2 (`/api/billing/webhooks/apple`).
   - Obnova: tlačidlo **Obnoviť nákupy** (`Transaction.currentEntitlements`).
   - Zmena plánu: nákup iného produktu v tej istej subscription group (rovnaké `originalTransactionId`).
   - Zrušenie: `AppStore.showManageSubscriptions`.
2. **Zaplatiť kartou u Esblu**
   - Poradie: `canMakePayments` → `ExternalPurchaseCustomLink.isEligible` → `token(for: ACQUISITION)` → `showNotice(type: .browser)`. Iba pri `.continued`:
   - `purchase-intent {method: apple_eu_link_checkout, storeToken}` → Stripe Checkout v Safari → Universal Link späť; UI polluje server.
   - Platby idú do outboxu: `apple_subscription_start` / `apple_renewal`, `NO_LINE_ITEM` pre nevyužité tokeny.
   - Mesačný report `PUT /externalPurchase/v1/reports` do 15. dňa nasledujúceho mesiaca.
   - Variant `apple_eu_in_app_checkout` (`.withinApp`, in-app browser) je pripravený a predvolene vypnutý. Je drahší, pozri sekciu G.
3. **Podmienky:** iOS 26.2+, parental gate pre 13–17 rokov (pri B2B overiť), voľbu kanálov treba držať **12 mesiacov** naprieč EÚ storefrontmi, PSP v review notes (Stripe = PCI Level 1).

## E. Fallback mimo EÚ / EEA (predvolené pravidlá v DB)

| Platforma | Región | Metódy | Poznámka |
|---|---|---|---|
| web | `*` | stripe_web_checkout | |
| android | EEA | google_play, google_choice_developer | billing choice |
| android | US | google_play | US programy (externé odkazy, alternatívny billing) sa dajú pridať zmenou pravidla, enrollment zatiaľ nie |
| android | `*` | google_play | Play Billing povinný |
| ios | EU27 | apple_iap, apple_eu_link_checkout | Attachment 14 |
| ios | US | apple_iap, apple_us_link | 3.1.1(a): odkaz povolený; provízia **NEOVERENÁ** — predvolene vypnuté v `enabled_methods` |
| ios | `*` (aj neznámy storefront) | apple_iap | IAP povinné |
| ľubovoľná | pravidlo `view_only` / prázdne | — | appka iba zobrazí existujúce predplatné |

Storefront hlási obchod: Apple `Storefront.countryCode`, Google `BillingConfig.countryCode`. Kanály s reportingom navyše vyžadujú token, ktorý obchod vydá iba v oprávnenom regióne. Podvrhnutý storefront preto externú platbu neodomkne.

## F. Enrollment kroky, ktoré budú neskôr potrebovať tvoj zásah

**Apple:**
1. Apple Developer Program (platený).
2. Account Holder prijme DPLA s Attachment 14.
3. Produkty v App Store Connect: subscription group, `…starter/pro.monthly/yearly`.
4. Entitlement `com.apple.developer.storekit.custom-purchase-link.allowed-regions` (EÚ krajiny) — **NEOVERENÉ**, či ide o self-service.
5. App Store Server API kľúč (`APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_PRIVATE_KEY`).
6. Sandbox URL pre Server Notifications V2.
7. `APPLE_ROOT_CA_SHA256` (odtlačok Apple Root CA - G3 z apple.com/certificateauthority).
8. Pridať iOS platformu (`npx cap add ios`) a zapojiť `mobile/native-billing/ios`.
9. Associated Domains pre Universal Link `/nastavenia/predplatne`.
10. Review notes: Stripe ako PSP.

**Google:**
1. Play Console: subscription produkty a base plany `monthly` / `yearly`.
2. **Zápis do Billing choice programu** (Settings → Billing choice) a nastavenie choice screenu.
3. Service account s Play Developer API (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`).
4. Pub/Sub topic + push subscription s autentifikáciou (`GOOGLE_RTDN_AUDIENCE`, `GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL`).
5. Gradle `com.android.billingclient:billing:9.1.0+` a zapojenie `mobile/native-billing/android`.
6. `assetlinks.json` pre App Link (už je TODO v `mobile/android/APP_LINKS_ASSETLINKS_TODO.md`).
7. License testers.

**Stripe:** Sandbox + test kľúče (Vercel Preview env), test produkty a ceny vložené do `billing_provider_prices`.

## G. Poplatky (predplatné)

| Kanál | Obchod | Poznámka |
|---|---|---|
| Web — Stripe | 0 % | iba poplatky Stripe |
| Android EEA — Play Billing | **10 % + 5 % billing fee** | [16954621](https://support.google.com/googleplay/android-developer/answer/16954621) |
| Android EEA — billing choice → Esblu (Stripe) | **10 %** + Stripe | [17161464](https://support.google.com/googleplay/android-developer/answer/17161464) |
| Android mimo EEA — Play Billing | **15 %** (krajiny ešte bez nového modelu) | [112622](https://support.google.com/googleplay/android-developer/answer/112622) |
| Android US — Play / US programy | Play: nový model; US programy 10 % | [16470497](https://support.google.com/googleplay/android-developer/answer/16470497) |
| iOS EÚ — IAP | **26 %** / 15 % (Small Business, resp. predplatné po 1. roku) | [EU payment options](https://developer.apple.com/support/payment-options-on-the-app-store-in-the-eu/) |
| iOS EÚ — alternatívny PSP v appke (`.withinApp`) | **20 %** / 10 % + Stripe | tamže |
| iOS EÚ — odkaz (`.browser`, predaje do 7 dní) | **15 %** / 10 % + Stripe | tamže |
| iOS mimo EÚ — IAP | Small Business 15 % potvrdené; štandard 30 % / 15 % **NEOVERENÉ** | [SBP](https://developer.apple.com/app-store/small-business-program/) |
| iOS US — odkaz na web | **NEOVERENÉ** | — |

Core Technology Fee, Initial Acquisition Fee a Store Services Fee v EÚ od 1. 10. 2026 neplatia.

## H. Čo je reálne implementované vs. adaptér / fake

| Časť | Stav |
|---|---|
| DB: pravidlá kanálov, nákupný zámer, purchase method, outbox reportingu, NO_LINE_ITEM, kill-switch | **implementované**, PGlite testy |
| Server: `/purchase-options`, `/purchase-intent`, `/mobile/confirm`, webhooky Apple a Google, cron reportingu | **implementované** |
| Apple JWS overenie (`x5c` reťaz, OID, ES256) | **implementované**, testované na openssl reťazi; reálny Apple root sa dodá cez env |
| Google OIDC (RTDN), service-account OAuth, Play API (subscriptionsv2, acknowledge, externalTransactions) | **implementované**, testované s mock `fetch` |
| Apple App Store Server API + External Purchase report | **implementované** (iba sandbox host), mock `fetch`; tvar Apple tokenu (`externalPurchaseId`) a `RefundLineItem` **NEOVERENÉ** → refund ostáva `failed` pre operátora |
| Stripe: checkout z mobilu (`origin_context`), platba z `invoice.paid`, refund cez `invoice_payments` | **implementované**, mock `fetch`; reálny Stripe neprebehol |
| Mobilná obrazovka Predplatné (plán, interval, Kúpiť / Zmeniť, polling serverového potvrdenia, obnova, správa v obchode) | **implementované** (web + mobile export) |
| Natívny plugin StoreKit 2 / Play Billing 9.1 (`mobile/native-billing`) | **referenčný kód, NEKOMPILOVANÝ a NEZAPOJENÝ** (chýba iOS platforma, enrollmenty, produkty) |
| Fake App Store / Play / disclosure / choice screen (`FakeBillingBridge`, `/api/billing/fake/store-purchase`) | **fake**, iba staging (`ESBLU_BILLING_STORE_MODE=fake`, `NEXT_PUBLIC_ESBLU_BILLING_FAKE_NATIVE=1`) |

## Staging zapnutie (Preview, nikdy Production)

- `ESBLU_BILLING_MODE=fake`
- `ESBLU_BILLING_STORE_MODE=fake`
- `ESBLU_FAKE_BILLING_SECRET` (≥16 znakov)
- `ESBLU_BILLING_RETURN_ORIGIN=https://<preview>`
- `NEXT_PUBLIC_ESBLU_BILLING_UI=1`
- Mobile build: `NEXT_PUBLIC_ESBLU_BILLING_FAKE_NATIVE=1` + `NEXT_PUBLIC_ESBLU_API_ORIGIN=https://<preview>`
- DB: `update billing_runtime_config set web_provider='fake', enabled_methods=array['stripe_web_checkout','apple_iap','apple_eu_link_checkout','google_play','google_choice_developer']`
