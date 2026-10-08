# Esblu mobile — architektúra (Android + iOS), 2026-10-08

Branch: `mobile-platform`, vytvorená z `main` @ `901c46c`. Billing (`subscriptions-platform`) je zámerne mimo; v appke nie je žiadny nákup.

Klasifikácia blockerov: **CODE**, **CONFIG**, **GOOGLE USER ACTION**, **APPLE USER ACTION**, **LEGAL/CLIA**, **STORE REVIEW**, **REAL DEVICE TEST**.

## 1. Princíp: jeden backend, jedna business logika

```
app/** (Next.js stránky + lib/**)  ──►  web build (Vercel)          https://www.esblu.com
          │ re-export (mobile/app/**/page.tsx, 0 duplikovanej logiky)
          └────────────────────────►  mobile build (static export) ──► Capacitor 8
                                                                         ├─ android/ (com.esblu.app)
                                                                         └─ ios/     (com.esblu.app)
API: apiUrl("/api/…")  →  web: relatívne  |  mobile: https://www.esblu.com (alebo NEXT_PUBLIC_ESBLU_API_ORIGIN)
DB:  ten istý Supabase projekt, RLS + RPC = posledná autorita (rovnaké role, firma, dáta)
```

- **Účet, firma, role, oprávnenia:** tie isté. Mobilná navigácia skrýva položky podľa role (`lib/mobile-nav.ts`), ale autorizuje vždy server a RLS.
- **Mobilné rozdiely sú iba platformové:**
  - otváranie a sťahovanie súborov (`lib/file-actions.ts`);
  - deep linky (`mobile/app/deep-link-resolve.ts`);
  - push (`lib/push/native.ts`);
  - OAuth v systémovom prehliadači;
  - životný cyklus appky (`AppLifecycleBridge`);
  - Android späť (`BackButtonBridge`);
  - safe areas;
  - offline banner.
- `IS_MOBILE_BUILD` je build-time konštanta. Kód pre Capacitor sa importuje dynamicky, takže webový bundle sa nemení.

## 2. Inventúra

READY = hotové v kóde, PARTIAL = funguje s výhradou, MISSING = chýba.

| Oblasť | Android | iOS | Poznámka / blocker |
|---|---|---|---|
| Capacitor projekt, appId `com.esblu.app` | READY | READY (nové, `mobile/ios`, SPM) | iOS: Xcode build **neoverený** (REAL DEVICE TEST) |
| Build tooling | READY (Gradle, compile/target SDK 36, min 24) | PARTIAL (deployment target iOS 15, SPM) | Sandbox nemá Android SDK ani macOS |
| Signing bez secrets | READY (`keystore.properties` mimo Git) | PARTIAL (automatic signing, bez Team ID) | APPLE USER ACTION: Team |
| Firebase / FCM | PARTIAL | n/a — iOS ide priamo cez APNs | GOOGLE USER ACTION: `google-services.json` (mimo Git) |
| APNs | n/a | PARTIAL (AppDelegate odovzdáva token, entitlement) | APPLE USER ACTION: APNs kľúč `.p8` do server env |
| Push: povolenie, refresh, logout, multi-device, tap, firma | READY | PARTIAL (kód rovnaký) | REAL DEVICE TEST |
| E-mail + heslo, reset, overenie e-mailu | READY | READY | |
| Google Sign-In | READY (Custom Tab + PKCE, custom scheme) | **zámerne vypnutý** | 4.8: bez Sign in with Apple sa Google na iOS neponúkne. CONFIG: Supabase redirect allowlist |
| Sign in with Apple | READY (systémový prehliadač) | READY (natívne, fail closed) | APPLE USER ACTION: Services ID, kľúč, capability, Supabase provider |
| Session po reštarte | READY (Supabase localStorage vo WebView, PKCE) | READY | |
| Refresh tokenu po návrate z pozadia | READY (nové) | READY (nové) | |
| Vypršaná / odvolaná session → login | READY (nové) | READY (nové) | |
| Deep links: App Links / Universal Links | READY (autoVerify, `assetlinks.json`) | PARTIAL (entitlement `applinks:`) | APPLE USER ACTION: AASA súbor s Team ID |
| Deep links: OAuth custom scheme | READY (nové) | READY (nové, `CFBundleURLTypes`) | |
| Fotoaparát / galéria (input capture) | READY | READY (usage strings) | REAL DEVICE TEST |
| Dokumenty: PDF upload | READY | READY | |
| Preview súborov (signed URL) | READY (in-app browser; opravené 4 miesta) | READY | |
| Export / download / share (PDF, ZIP, XLSX) | READY (Cache + Share sheet) | READY | REAL DEVICE TEST na iOS |
| Android späť | READY | n/a (swipe-back WKWebView) | |
| Safe areas | READY (`viewport-fit=cover` iba v appke) | READY | REAL DEVICE TEST (notch) |
| Klávesnica | READY (resizes-content; tab bar sa pri písaní skryje) | PARTIAL | REAL DEVICE TEST |
| Offline stav | READY (banner, nič sa nepredstiera) | READY | |
| Ochrana pred dvojitým odoslaním | PARTIAL | PARTIAL | pozri sekciu 5 |
| Zrušenie účtu v appke | READY (opravené) | READY | |
| Hlasový asistent | READY (`RECORD_AUDIO`) | PARTIAL (usage string; WKWebView `getUserMedia`) | REAL DEVICE TEST |
| Ikony / splash | ikona **MISSING** (default Capacitor), splash READY | ikona **MISSING**, splash READY | jediný vstup: 1024×1024 Esblu master ikona (generátor pripravený) |
| Nákup predplatného | — (mimo scope) | — | billing vetva |

## 3. Funkčná parita web ↔ mobile

| Modul | Web | Mobile | Gap |
|---|---|---|---|
| Login / logout / registrácia / reset hesla / pozvánka | ✔ | ✔ | iOS bez Google (4.8) |
| Onboarding firmy, DPA a právne brány | ✔ | ✔ | |
| Dashboard / hľadanie | ✔ | ✔ | |
| Vozidlá, stroje, sklad (+ detail, fotky, doklady) | ✔ | ✔ (`/x/detail?id=`) | |
| Obchodní partneri | ✔ | ✔ | |
| Faktúry: vydané, prijaté, PDF, finalizácia, platby | ✔ | ✔ | Editor faktúry je dlhý formulár — REAL DEVICE TEST |
| Účtovnícky prístup (handoff ZIP) podľa rolí | ✔ | ✔ | |
| AI evidencia, scan dokladu | ✔ | ✔ (fotoaparát / galéria) | AI scan neprijíma PDF (rovnako ako web) |
| Priečinky / dokumenty | ✔ | ✔ | |
| Chat (+ prílohy, odkazy) | ✔ | ✔ | Príloha v chate bez priamej voľby fotoaparátu (systémový picker ju ponúka) |
| Text / hlasový asistent | ✔ | ✔ | Voice na iOS: REAL DEVICE TEST |
| Nastavenia, logo, členovia, push | ✔ | ✔ | |
| Cenník (verejná marketingová stránka) | ✔ | ✗ (zámerne web-only) | |
| Predplatné / nákup | — | — | billing vetva |

## 4. Auth

- **E-mail + heslo:** `signInWithPassword`, potvrdenie a reset cez `token_hash` + `verifyOtp` (`/auth/callback`). Funguje rovnako na webe aj v appke. E-mailové odkazy otvorí App Link alebo Universal Link na `/auth/callback`.
- **Google v natívnej appke:**
  1. `signInWithOAuth({ skipBrowserRedirect: true, redirectTo: "com.esblu.app://auth/callback?oauth=google" })`.
  2. URL sa otvorí cez `@capacitor/browser` (Chrome Custom Tab / SFSafariViewController), **nikdy vo WebView** (Google embedded WebView blokuje).
  3. Supabase presmeruje na custom scheme → `DeepLinkBridge` (prepustí iba `com.esblu.app://auth/callback`) → `/auth/callback.html?code=…`.
  4. PKCE výmena prebehne v **tom istom WebView**, kde je `code_verifier`. Odchytený `code` bez verifiera je bezcenný. Prehliadač sa zavrie (`Browser.close`).
  - Ak budú overené App Links / Universal Links, dá sa prepnúť na `NEXT_PUBLIC_ESBLU_MOBILE_OAUTH_REDIRECT=https://www.esblu.com/auth/callback`.
- **iOS a App Review 4.8:** appka, ktorá ponúka Google login, musí ponúknuť aj rovnocennú voľbu, typicky Sign in with Apple. `oauthProvidersForPlatform("ios", …)` preto Google na iOS skryje, kým nie je zapnutý Apple. **Rozhodnutie pre teba:**
  - (a) iOS iba s e-mailom a heslom (dnes, bez blockeru), alebo
  - (b) pridať Sign in with Apple. Vyžaduje Apple Developer (Services ID, kľúč) a Supabase Apple provider; CODE je pripravený na rovnakej ceste (`provider: "apple"` v `SUPPORTED_OAUTH_PROVIDERS` + bezpečnostná revízia).
- **Logout:**
  - Všetky vstupy idú cez `signOutOnThisDevice()`: push odregistrácia, potom vyčistenie OAuth stavu a `sessionStorage`, potom `signOut`.
  - Predtým 7 ciest vynechávalo push odregistráciu.
- **Životný cyklus session:**
  - Na pozadí sa zastaví auto-refresh. Po návrate do popredia sa spustí a `getSession()` session obnoví.
  - `SIGNED_OUT` (vypršaná / odvolaná session) presmeruje z chránenej obrazovky na `/login`.
  - Server overuje JWT pri každom volaní.

## 5. Sieť, offline, duplicity

- Esblu nie je offline-first.
- Offline banner (`navigator.onLine` + `online` / `offline` udalosti) jasne povie, že sa nič neuloží.
- Obrazovky ukazujú uloženie **iba po odpovedi servera** (žiadny optimistický zápis).
- **Idempotency key:**
  - Má ho: AI scan a scan technického preukazu.
  - Nemá ho: ostatné vytvárania (faktúra draft, platba, partner, vozidlo, stroj, sklad, priečinok, chat správa). Chránia ich iba UI guardy (disabled počas ukladania).
  - **Zostatkové riziko:** stratená odpoveď + opakovanie môže vytvoriť duplicitu. Oprava vyžaduje DB zmenu (idempotency kľúče pri insert RPC) → navrhnuté ako samostatný krok (CODE + DB migrácia so súhlasom).
  - Opravené: chat — dvojité Enter počas odosielania.

## 6. Deep links: jednotný routing

| Vstup | Príklad | Cieľ | Ochrana |
|---|---|---|---|
| App Link / Universal Link | `https://www.esblu.com/invite/<64hex>`, `/reset-hesla`, `/onboarding/company`, `/auth/callback?token_hash=…` | `/…html` | presný host, `https`, presné cesty, token iba 64 hex |
| OAuth custom scheme | `com.esblu.app://auth/callback?code=…` | `/auth/callback.html` | iba táto cesta, PKCE |
| Push tap | `{screen, id}` | `/chat/<uuid>`, `/vozidla/<uuid>`, … | allowlist obrazoviek + UUID; nikdy URL |
| Čokoľvek iné | | ignorované | žiadny open redirect |

**Cross-company:** odkaz alebo push na záznam inej firmy otvorí obrazovku, ale RLS nevráti dáta (not found). Push sa doručuje iba zariadeniam s aktívnym členstvom v tej istej firme.

## 7. Konfigurácia prostredí (dev / staging / prod)

| Premenná (build-time, mobile) | Účel | Default |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | Supabase projekt (verejný anon kľúč) | z `.env` buildu |
| `NEXT_PUBLIC_ESBLU_API_ORIGIN` | backend pre staging / dev (iba `https`, `http` iba localhost/10.0.2.2) | `https://www.esblu.com` |
| `NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS` | `google` (Supabase provider musí byť zapnutý) | prázdne |
| `NEXT_PUBLIC_ESBLU_MOBILE_OAUTH_REDIRECT` | `com.esblu.app://auth/callback` alebo overený `https` callback | custom scheme |

- **Staging build musí mať staging Supabase aj staging API origin naraz.** Kombinácia staging API + produkčný Supabase alebo naopak je chyba. Kontroluje sa pri releasovom checkliste; `verify:mobile-bundle` vypíše origin.
- Žiadne secrets v bundli. Do mobilného buildu idú iba `NEXT_PUBLIC_*` (anon kľúč je verejný; RLS je autorita).

## 8. Overenie, ktoré tu nebolo možné

- Android `assembleDebug` / `bundleRelease`: sandbox nemá Android SDK a sťahovanie je blokované (403) → **REAL DEVICE TEST** na tvojom PC (Android Studio).
- iOS `xcodebuild`: vyžaduje macOS + Xcode → **XCODE NOT YET VERIFIED**.
- `npm run verify:mobile-bundle`: kontroly predpokladajú Turbopack výstup. V sandboxe s `--webpack` zlyhá rovnakých 23 kontrol aj na čistom `main` (nie regresia). Treba spustiť po bežnom `npm run build -w mobile` na dev stroji.

## 9. Aktualizácia 2 (2026-10-08) — autonómne dokončenie

| Oblasť | Stav |
|---|---|
| **Secure storage** | `lib/mobile/secure-storage.ts` je Supabase auth storage adapter. Natívne pluginy: Android Keystore AES-GCM, iOS Keychain ThisDeviceOnly. Migrácia z localStorage: najprv zápis do secure úložiska, až potom zmazanie legacy kópie; zlyhaný zápis používateľa neodhlási. Logout vyčistí úložisko aj pri zlyhaní servera. Web je nezmenený. Testy: cold start, vypršaná session → refresh cez skutočný supabase-js, resume, logout |
| **Idempotencia** | `client_mutation_id` + čiastočný unique index `(company_id, client_mutation_id)` na 7 tabuľkách (`20261008130000`, rollback). Klient: `lib/idempotent-insert.ts`. Rovnaký obsah = rovnaký kľúč; iný obsah alebo úspech = nový kľúč. Pri 23505 sa záznam s kľúčom prečíta cez RLS a vráti ako replay. Ak stĺpec v DB chýba, zapíše sa bez kľúča |
| **Sign in with Apple** | Pripravené. Fail closed bez konfigurácie, Apple credentials a capability |
| **Navigácia** | `LegalMarkdown` a výsledky hľadania idú cez `AppLink` / `resolveAppHref` |
| **Legal root** | `ESBLU_LEGAL_CONTENT_ROOT` je odstránený z mobilného `env`; `lib/legal-content.ts` nájde `../legal` sám |
| **verify:mobile-bundle** | Pôvodných 23 zlyhaní spôsobil **sandbox build `--webpack`**, nie bundling problém: produkčný Turbopack build (aj na čistom `main`) prejde. Verifier teraz najprv overí Turbopack a pri webpacku sa zastaví s jasnou správou (exit 3). Pribudla kontrola lokálnych ciest build stroja |
| **AASA / assetlinks** | Šablóny + fail-closed render, mimo `public/` |
| **Ikony / splash** | Splash je zo schválenej PWA ikony. App ikony (iOS aj Android sú **default Capacitor**) čakajú na jediný vstup: 1024×1024 master |

**Uzavretá beta a Apple:** pozvánková výnimka Auth hooku platí iba pre Google. Apple prihlásenie prejde iba s e-mailom z beta allowlistu. Pozor: „Hide My Email" relay adresa na allowliste nebude. Rozšírenie hooku je samostatná bezpečnostná revízia (DB).
