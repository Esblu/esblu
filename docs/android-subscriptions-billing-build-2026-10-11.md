# Android — subscriptions billing compile + device contract test (STAGING, 2026-10-11)

Vetva `subscriptions-mobile-integration` (nemergovaná, nie pre `main` ani `mobile-platform`).
Beží **iba proti stagingu**, iba **debug** build, nič sa nenahráva do Google Play.

| | Hodnota |
|---|---|
| Kit | `C:\Users\roiaj\assetpilot\Claude outputs\esblu-subscriptions-integration` |
| Commit | `493ee27` (alebo novší na tej istej vetve) |
| Supabase | `esblu-test` (`cjbdijbbcujvmrzezusd`), iba anon kľúč |
| API | `https://mobile-staging.esblu.com` (Preview `mobile-platform` — **bez** `/api/billing`, preto obrazovka Predplatné ukáže „vypnuté“) |
| Play Billing | `com.android.billingclient:billing:9.1.0`, iba s `-PesbluBilling=true` |
| Push | bez `google-services.json` (zámerne) |

Kit obsahuje čerstvý web bundle (`npm run build -w mobile`), `cap sync android` spustený v tom istom strome
(vrátane `capacitor-cordova-android-plugins/`), `node_modules/@capacitor/*` a `mobile/android/local.properties`
z predchádzajúceho kitu. `android-prebuild-check --target staging`: všetko OK (živá sonda API overená cez prehliadač).

## 1. Build matrix (JDK 21)

```powershell
cd "C:\Users\roiaj\assetpilot\Claude outputs\esblu-subscriptions-integration\release"
powershell -ExecutionPolicy Bypass -File .\build-billing-matrix.ps1
```

Skript postaví ten istý checkout dvakrát a vypíše PASS/FAIL:

| Build | Príkaz | Očakávanie |
|---|---|---|
| A — billing OFF | `gradlew clean :app:assembleDebug` | žiadna `com.android.billingclient` závislosť, žiadne `com.android.vending.BILLING`, `EsbluBillingPlugin` sa neskompiluje |
| B — billing ON | `gradlew clean :app:assembleDebug -PesbluBilling=true` | `billing:9.1.0` v `debugRuntimeClasspath`, `EsbluBillingPlugin.class` existuje, manifest má `com.android.vending.BILLING` |
| Diff A → B | merged manifest | pribudne **iba** `com.android.vending.BILLING`, žiadne nové exportované komponenty, žiadna odobraná permission |

Výstup: `release\billing-matrix\report.txt`, oba merged manifesty, oba debug APK.
**Pošli mi iba `report.txt`** (APK ani logy netreba).

Ak `gradlew` zlyhá na kompilácii pluginu, chyba je v `release\billing-matrix\gradle-billing-on.log`
(posledných 40 riadkov je aj v `report.txt`).

## 2. Inštalácia na telefón (billing ON)

```powershell
adb install -r "C:\Users\roiaj\assetpilot\Claude outputs\esblu-subscriptions-integration\release\billing-matrix\esblu-staging-subscriptions-billing-on-debug.apk"
```

Ak je nainštalovaná appka s iným podpisom (Play / release), najprv ju odinštaluj.

## 3. Kontraktný test natívneho pluginu (bez nákupu)

Na PC v Chrome otvor `chrome://inspect` → pri `com.esblu.app` klikni **inspect** → záložka **Console**.
Prihlás sa v appke staging účtom. Potom postupne:

```js
const B = Capacitor.Plugins.EsbluBilling;
Capacitor.isPluginAvailable("EsbluBilling")                                  // true (billing ON build), false (OFF)
await B.getStorefront()                                                      // { platform: "android", country: "SK" alebo null }
await B.queryGoogleProducts({ productIds: ["esblu_test_pro"] })              // { products: [], missing: ["esblu_test_pro"], status: "unconfigured" | "unavailable" }
await B.restoreGoogle()                                                      // { purchaseTokens: [] }
await B.purchaseGoogle({ productId: "esblu_test_pro", basePlanId: "monthly", obfuscatedAccountId: "qa-contract-test", billingChoice: false })
//   → { kind: "error", code: "ITEM_UNAVAILABLE" } alebo { kind: "billing_unavailable" } — Play produkt neexistuje, NEOTVORÍ sa platba
await B.purchaseGoogle({ productId: "x", basePlanId: "y", obfuscatedAccountId: "z", billingChoice: true })
//   → { kind: "error", code: "BILLING_CHOICE_NOT_WIRED" }
await B.manageSubscriptions({ provider: "google", productId: "esblu_test_pro" })   // otvorí Play → Predplatné (iba zobrazenie)
```

| Kontrakt | Kde je pokrytý |
|---|---|
| isAvailable | `Capacitor.isPluginAvailable` (bridge `available`) |
| queryProducts / unconfigured | `queryGoogleProducts` → `status: "unconfigured"`, nie pád |
| purchase / pending / userCancelled / alreadyOwned / billingUnavailable | `purchaseGoogle` → `play` / `pending` / `canceled` / `already_owned` / `billing_unavailable` / `error{code}` (`lib/billing/native-bridge-contract.ts`) |
| restore / query owned | `restoreGoogle` (iba PURCHASED tokeny) |
| reconnect | `enableAutoServiceReconnection()` + `startConnection` pri každom volaní |
| manage subscription | `manageSubscriptions` → `https://play.google.com/store/account/subscriptions?package=com.esblu.app&sku=…` |

Pending / canceled / already_owned sa dajú reálne vyvolať až s Play test produktom a license testerom
(appka nahratá aspoň do internal testing) — to je ďalší, schvaľovaný krok.

## 4. Obrazovka Predplatné na telefóne

Nastavenia → **Predplatné**: staging API nemá billing routy → appka ukáže
„Online predplatné zatiaľ nie je dostupné.“ a **neponúkne žiadnu platbu** (fail closed). Ostatné UI stavy
(aktívne cez web / Google / Apple, restore, already owned, pending, nedostupné) sú pokryté testom
`npm run test:billing-ui` nad tými istými rozhodnutiami (`screenModel`), ktoré stránka vykresľuje.

## 5. Čo sa NEROBÍ

Žiadny release / AAB build, žiadny upload do Play, žiadne Play produkty, žiadny live billing, žiadne produkčné
API ani DB, žiadne secrets v kite (iba staging anon kľúč v `mobile/.env.local`, gitignored).
