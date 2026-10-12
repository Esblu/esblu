# Unified subscriptions — policy audit Apple / Google / Stripe (2026-10-08)

> Interný technický audit, **nie právne stanovisko**. Zdroje: iba oficiálne stránky Apple, Google a Stripe, overené 8. 10. 2026.
> Položky označené **NEOVERENÉ** sa nepodarilo potvrdiť z oficiálneho zdroja — pred rozhodnutím ich treba overiť (Apple/Google kontakt, právnik).
> Žiadny program, entitlement ani platená služba nebola aktivovaná.
>
> **AKTUALIZÁCIA (8. 10. 2026):** odporúčanie „mobil bez nákupu“ v sekcii 4 je **nahradené** nákupom priamo v appke. Pozri `docs/subscriptions-mobile-purchase-2026-10-08.md`:
> - Android EEA: billing choice program;
> - iOS EÚ: IAP + ExternalPurchaseCustomLink;
> - inde: IAP / Play Billing.
>
> Guideline 3.1.3(c) sa **nepoužíva**, lebo samoobslužný predaj nespĺňa podmienku „only … organizations“.

## 0. Kľúčové zmeny posledných mesiacov

- **Apple EÚ — od 1. 10. 2026 nové jednotné podmienky (DPLA Attachment 14).** Zrušené: Core Technology Fee, Initial Acquisition Fee, Store Services tiers a starý StoreKit External Purchase Link (EU) Addendum. Core Technology Commission 5 % platí iba pre distribúciu mimo App Store.
  [Payment options in the EU](https://developer.apple.com/support/payment-options-on-the-app-store-in-the-eu/), [news 2026-08-18](https://developer.apple.com/news/?id=gmws0jgp)
- **Google — nový model poplatkov a „billing choice program“** v EEA/UK/US od 30. 6. 2026.
  [answer/16954621](https://support.google.com/googleplay/android-developer/answer/16954621), [answer/17161464](https://support.google.com/googleplay/android-developer/answer/17161464)
- **Google US** — programy externých odkazov / alternatívneho billingu účtujú poplatky od 1. 10. 2026.
  [answer/16470497](https://support.google.com/googleplay/android-developer/answer/16470497), [answer/16497028](https://support.google.com/googleplay/android-developer/answer/16497028)

## 1. Apple

Zdroj: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) (posledná aktualizácia 8. 6. 2026).

| Pravidlo | Čo hovorí | Dopad na Esblu |
|---|---|---|
| **3.1.1** | Odomknutie funkcií = In-App Purchase; restore mechanizmus pre obnoviteľné nákupy; „subscriptions must work on all of the user's devices“. | Ak predávame v iOS appke, musí to byť IAP (alebo EÚ alternatíva) + restore. |
| **3.1.2(a)** | SaaS je povolené auto-renewable predplatné; obdobie aspoň 7 dní. | Mesačný aj ročný plán sú v poriadku. |
| **3.1.3 (úvod)** | Mimo US appka nesmie nabádať na iný spôsob nákupu ako IAP. | Mimo US žiadne tlačidlá ani odkazy „kúpiť na webe“. |
| **3.1.3(a)** Reader apps | Platí iba pre magazíny, noviny, knihy, audio, hudbu, video. | **Nevzťahuje sa** na Esblu. |
| **3.1.3(b)** Multiplatform Services | Prístup k predplatnému kúpenému inde je povolený, ak je to isté dostupné aj ako IAP v appke. | Ak sa spoliehame na 3.1.3(b), **musíme ponúknuť aj IAP** (v EÚ IAP a/alebo alternatívnu platbu v appke). |
| **3.1.3(c)** Enterprise Services | Ak sa appka predáva **iba** priamo organizáciám pre zamestnancov, smie sprístupniť predplatné kúpené inde; predaj spotrebiteľom, jednotlivcom a rodinám musí ísť cez IAP. | **Relevantné pre B2B**, ale self-serve registrácia (aj živnostník, 1 používateľ) nemusí spĺňať slovo „only“. **NEOVERENÉ:** či App Review akceptuje self-serve SMB pod 3.1.3(c). |
| **3.1.3(f)** Free stand-alone apps | Bezplatný spoločník platenej webovej služby bez IAP, ak v appke nie je nákup ani výzva na nákup mimo appky. | Záložná cesta: iOS appka bez zmienky o cenách a nákupe. |
| **US storefront** | 3.1.1(a): tlačidlá, odkazy a výzvy na externý nákup sú povolené bez entitlementu. | Iba pre budúci US rollout. **NEOVERENÉ:** či Apple účtuje províziu z US link-out nákupov. |
| **Multiseat** | Volume Purchasing cez Apple Business Manager (od 22. 10. 2026) a Group Purchases. [news](https://developer.apple.com/news/?id=likeohx4) | Ak raz zavedieme IAP, firemné miesta kúpené na iOS sú technicky možné. |

### Apple EÚ (Attachment 14, platné od 1. 10. 2026)

**Možnosti platby:** IAP, alternatívny poskytovateľ platieb (PSP) priamo v appke a/alebo ponuka mimo appky (odkaz). Možnosti sa dajú kombinovať.

**Pravidlá:**
- Zvolenú kombináciu treba držať **12 mesiacov** naprieč EÚ storefrontmi.
- 3.1.3(b) appky musia mať IAP a/alebo alternatívnu platbu v appke — samotný odkaz von nestačí.
- Ak je IAP vedľa alternatívy, IAP musí byť aspoň rovnako výrazné.

**Entitlement:** `com.apple.developer.storekit.custom-purchase-link.allowed-regions` (napr. `sk`). Zapína sa po prijatí DPLA, funguje od iOS/iPadOS 26.2. **NEOVERENÉ:** či ide o self-service bez schvaľovania.

**Disclosure:** systémový disclosure sheet cez `ExternalPurchaseCustomLink.showNotice(type:)`. App Store navyše zobrazí banner a poznámku na produktovej stránke. Pre maloletých platia rodičovské brány.

**Provízie:**

| Spôsob platby | Štandard | Small Business / predplatné po 1. roku |
|---|---|---|
| IAP | 26 % | 15 % |
| Alternatívny PSP v appke | 20 % | 10 % |
| Ponuka mimo appky cez odkaz (predaje do 7 dní od kliknutia) | 15 % | 10 % |

**Reporting:** mesačne do 15 dní cez [External Purchase Server API](https://developer.apple.com/documentation/externalpurchaseserverapi/) (od OS 26.4), vrátane refundácií a obnovení. Apple má právo auditu.

**Review notes:** treba uviesť PSP, ktorý musí byť PCI Level 1. Stripe ním je ([docs](https://docs.stripe.com/security/guide)).

### Apple — server

- Pre nové implementácie [App Store Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications/enabling-app-store-server-notifications).
- [`appAccountToken`](https://developer.apple.com/documentation/appstoreserverapi/appaccounttoken) je UUID, ktoré vydá náš server. V Esblu ho vydáva `esblu_billing_issue_account_token('apple')`.

## 2. Google Play

Zdroj: [Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738), [FAQ](https://support.google.com/googleplay/android-developer/answer/10281818).

- **Play Billing je povinný** pri nákupe digitálnych funkcií v appke. Výslovne to zahŕňa „cloud software and services… business productivity software“.
- **Consumption-only je povolené:** appka smie sprístupniť obsah zaplatený inde, ak sa v nej nedá nič kúpiť. V takej appke je povolený **iba text bez odkazu** (napr. „predplatné zmeníte na našom webe“), žiadne priame odkazy na platobné stránky.

### Programy v EEA

| Program | Fee za predplatné | Povinnosti | Obmedzenie |
|---|---|---|---|
| **Billing choice program** (od 30. 6. 2026) — Play Billing + vlastný billing alebo odkaz na web ([17161464](https://support.google.com/googleplay/android-developer/answer/17161464)) | 10 % | Info obrazovka cez API, reporting do 24 h, PCI DSS, podpora a refundácie | — |
| **External offers** ([14372887](https://support.google.com/googleplay/android-developer/answer/14372887)) | 10 % + €1,20 za stiahnutie appky | Iba pre firmy, reporting do 24 h cez API | Nesmie sa kombinovať s Play Billing |

**Model poplatkov** ([16954621](https://support.google.com/googleplay/android-developer/answer/16954621)): predplatné 10 %, Play Billing navyše **+5 % billing fee** (EEA/UK/US/AU/JP). Zvyšok sveta prejde na nový model 30. 9. 2027.

**US:** programy externých odkazov a alternatívneho billingu vyžadujú deklaráciu, API a zápis v Play Console. Predplatné 10 %, poplatky od 1. 10. 2026.

**Zvyšok sveta:** Play Billing, alebo consumption-only. **NEOVERENÉ:** aktuálna základná sadzba mimo EEA/UK/US/AU/JP pred 30. 9. 2027.

**Server:**
- [RTDN](https://developer.android.com/google/play/billing/rtdn-reference) cez Pub/Sub. Stav sa vždy načíta cez `purchases.subscriptionsv2.get` a deduplikuje sa podľa `messageId`.
- Firma sa páruje cez `obfuscatedExternalAccountId`; v Esblu ho vydáva `esblu_billing_issue_account_token('google')`.
- Upgrade alebo downgrade vytvorí nový `purchaseToken` s `linkedPurchaseToken`.
- Od 31. 8. 2026 je povinná Play Billing Library 8+.

## 3. Stripe

| Téma | Zistenie | Zdroj |
|---|---|---|
| Provisioning | Webhooky sú pre predplatné povinné: `checkout.session.completed` a `checkout.session.async_payment_succeeded`. Prístup udeliť na `invoice.paid` až po overení, že predplatné je `active`. Odobrať pri `canceled` / `unpaid`. | [fulfillment](https://docs.stripe.com/checkout/fulfillment), [subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks) |
| Eventy | `customer.subscription.created/updated/deleted/paused/resumed/trial_will_end`, `invoice.paid/payment_failed/payment_action_required/finalized`, `charge.refunded`, `charge.dispute.created` | tamže |
| Podpis | `Stripe-Signature: t=…,v1=…`, HMAC-SHA256 nad `t.rawBody`, tolerancia 300 s, porovnanie v konštantnom čase. **Poradie eventov nie je garantované** — sledovať event ID a načítať aktuálny objekt z API. | [webhooks](https://docs.stripe.com/webhooks) |
| Apple Pay / Google Pay | V **hosted Checkout bez konfigurácie**. Elements a embedded Checkout potrebujú registráciu domény. V test mode sa testuje reálnou kartou s test kľúčmi. | [apple-pay](https://docs.stripe.com/apple-pay?platform=web), [pmd-registration](https://docs.stripe.com/payments/payment-methods/pmd-registration) |
| Customer Portal | Platobné údaje, DIČ, zmena alebo zrušenie plánu, faktúry. Nedá sa vložiť do iframe; neaktívna session vyprší po 5 min. | [customer-management](https://docs.stripe.com/customer-management) |
| VAT | `tax_id_collection[enabled]=true`. Stripe Tax aplikuje reverse charge podľa **formátu** DIČ bez ohľadu na verifikáciu → `unverified` IDs treba kontrolovať. | [tax-ids](https://docs.stripe.com/tax/checkout/tax-ids) |
| Testovanie | Pre nové integrácie odporúčané Sandboxes a test clocks. | [sandboxes](https://docs.stripe.com/sandboxes), [test-clocks](https://docs.stripe.com/billing/testing/test-clocks) |
| PCI | Checkout a Elements ⇒ SAQ A | [pci guide](https://stripe.com/guides/pci-compliance) |
| API verzia | Aktuálna GA `2026-09-30.endive`. V kóde sa nepinuje; voliteľne cez env `STRIPE_API_VERSION`. | [changelog](https://docs.stripe.com/changelog) |

## 4. Decision matrix

| | Checkout path | Povinný billing | Alternatíva / externá platba | Enrollment | Platform fee | Reporting | UX disclosure | Restore / sync | **Odporúčanie** |
|---|---|---|---|---|---|---|---|---|---|
| **WEB** | Stripe-hosted Checkout (subscription) + Customer Portal | — (Stripe) | n/a | žiadny | 0 % pre obchody; iba poplatky Stripe | — | vlastné obchodné podmienky | server = zdroj pravdy (webhooky) | **Primárny predajný kanál.** |
| **ANDROID EEA** | (a) consumption-only; (b) billing choice; (c) external offers | Play Billing, okrem (a) alebo zápisu do (b)/(c) | áno cez (b)/(c) | (b)/(c): Play Console + API | (a) 0 %; predplatné 10 % (+5 % pri Play Billing) | (b)/(c): do 24 h | Google info/choice screen | Play: RTDN + subscriptionsv2 | **(a) consumption-only teraz.** (b) až po obchodnom rozhodnutí. |
| **ANDROID mimo EEA** | consumption-only alebo Play Billing; US: programy | Play Billing pre nákup v appke | iba US cez programy | US: deklarácia + Console | US 10 % predplatné; zvyšok NEOVERENÉ | US: do 24 h | US: info screen | ako vyššie | **consumption-only.** |
| **iOS EÚ** | IAP a/alebo alternatívny PSP v appke a/alebo odkaz von; 3.1.3(c) / (f) bez nákupu | IAP alebo alternatívny PSP pri 3.1.3(b); nič pri 3.1.3(c) / (f) | áno (Attachment 14) | DPLA + StoreKit External Purchases/Offers entitlement, iOS 26.2+, záväzok na 12 mes. | IAP 26/15 %, PSP 20/10 %, odkaz 15/10 % | mesačne cez External Purchase Server API | systémový sheet + banner | IAP restore; ASSN V2 + appAccountToken | **Bez nákupu v appke** (3.1.3(c), s 3.1.3(f) ako záloha) — **vyžaduje potvrdenie** prijateľnosti pre self-serve B2B. IAP adaptér je pripravený ako záloha. |
| **iOS mimo EÚ** | IAP alebo 3.1.3(c) / (f); US: odkaz na web bez entitlementu | IAP okrem 3.1.3(c) / (f) | mimo US nie; US áno | US žiadny | IAP mimo EÚ NEOVERENÉ; US link-out NEOVERENÉ | US NEOVERENÉ | — | IAP restore | Ako v EÚ. V US neskôr zvážiť odkaz „Spravovať na webe“. |

### Čo je implementované v appkách (`lib/billing/client-model.ts → purchaseChannel`)

- **web** → Stripe Checkout (iba owner alebo admin s `billing.manage`).
- **android** → bez nákupu; iba text „plán spravuje majiteľ vo webovej aplikácii“ (bez odkazu).
- **ios** → bez nákupu a bez výzvy na nákup; iba stav predplatného a nároky.

Apple/Google adaptéry (`lib/billing/providers/stores.ts`) majú normalizáciu otestovanú na fixture payloadoch. Overenie notifikácií je zámerne `NOT_CONFIGURED`, kým neprebehne enrollment a obchodné rozhodnutie.
