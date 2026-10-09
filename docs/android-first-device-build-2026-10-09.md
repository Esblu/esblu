# Prvý Android build na reálnom telefóne (Windows), 2026-10-09

> **Prostredie prvého testu: STAGING** — pozri `android-staging-device-build-2026-10-09.md`. Sekcie 1–3 nižšie (produkčný backend) pre prvý test neplatia. Test plán (sekcia 6) platí.

- **Branch:** `mobile-platform`.
- **Výsledok:** debug APK nainštalované cez USB. Žiadna publikácia v Google Play.
- **Zakázané:** produkčný deploy a zmeny produkčnej DB.

## 0. Čo potrebuješ (verzie podľa aktuálneho projektu)

| Nástroj | Verzia | Prečo |
|---|---|---|
| Android Studio | aktuálna stabilná, ktorá podporuje **Android Gradle Plugin 8.13** (Narwhal 3 Feature Drop 2025.1.3 alebo novšia) | `mobile/android/build.gradle`: AGP 8.13.0, Gradle wrapper 8.14.3 |
| JDK | **21** — stačí zabudovaný JBR v Android Studiu | Capacitor 8 Android kompiluje Java 21 |
| Android SDK | **Platform 36** (Android 16), SDK Build-Tools 36, Platform-Tools (adb) | `compileSdk` / `targetSdk` 36, `minSdk` 24 (Android 7.0+) |
| Node.js | 22 LTS | build mobilného webového bundlu |
| Git | ľubovoľná aktuálna | |

Všetko inštaluje Android Studio: SDK Manager → SDK Platforms: Android 16 (API 36); SDK Tools: Build-Tools, Platform-Tools.

## 1. Samostatný pracovný priečinok

Tvoj `C:\Users\roiaj\assetpilot` má na `main` necommitnuté zmeny, okrem iného aj v `mobile/android/**`, a starý `.git/index.lock`. Nemiešaj ich. Použi nový clone:

```powershell
cd C:\Users\roiaj
git clone https://github.com/Esblu/esblu.git esblu-mobile
cd esblu-mobile
git checkout mobile-platform
npm ci
```

## 2. Konfigurácia (nič sa necommituje)

1. **`mobile\.env.local`**: skopíruj `mobile\.env.local.example` a doplň **iba** `NEXT_PUBLIC_SUPABASE_URL` a `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Hodnoty sú tie isté ako v koreňovom `C:\Users\roiaj\assetpilot\.env.local`.
   - Anon kľúč je verejný.
   - **Nikdy sem nedávaj** `SUPABASE_SERVICE_ROLE_KEY`, OpenAI ani iné server secrets.
2. **Prostredie:** bez `NEXT_PUBLIC_ESBLU_API_ORIGIN` appka volá **produkčný** backend `https://www.esblu.com` s produkčným Supabase.
   - Pre prvý test na zariadení je to v poriadku: appka nič nemení na serveri, používa rovnaké API a RLS ako web, a stačí tvoj vlastný testovací účet.
   - **Netestuj na produkcii zrušenie účtu.** Nová retenčná kontrola je zatiaľ iba na branchi.
   - **Netestuj na produkcii duplicitnú ochranu.** Stĺpec `client_mutation_id` je zatiaľ iba na `esblu-test`; na produkcii appka zapisuje bez kľúča (staré správanie).
3. **`google-services.json`** (iba pre push):
   - umiestnenie: `C:\Users\roiaj\esblu-mobile\mobile\android\app\google-services.json`;
   - je v `.gitignore` a nikdy sa necommituje;
   - musí obsahovať Android appku `com.esblu.app` (Firebase Console → Project settings → Your apps);
   - bez neho build **prejde**, len push nebude fungovať.

## 3. Build + kontrola pred inštaláciou

```powershell
cd C:\Users\roiaj\esblu-mobile
npm run build -w mobile
cd mobile
npx cap sync android
cd ..
node scripts\verify-mobile-bundle.mjs mobile\android\app\src\main\assets\public
node scripts\android-prebuild-check.mjs
```

`android-prebuild-check` overí:

- `com.esblu.app` a build varianty;
- že `google-services.json` ani keystore nie sú v Gite;
- registráciu secure storage pluginu;
- deep link `com.esblu.app://auth/callback` a `allowBackup=false`;
- že v APK assets nie sú `service_role`, OpenAI ani Stripe kľúče, súkromné kľúče ani lokálne cesty;
- na ktorý Supabase projekt a API bundle smeruje, a že prostredia nie sú zmiešané.

Musí skončiť **„Všetky kontroly prešli."**

## 4. Telefón

1. Nastavenia → Informácie o telefóne → 7× ťukni na „Číslo zostavy“ (zapnú sa Možnosti pre vývojárov).
2. Možnosti pre vývojárov → **Ladenie cez USB** zapnúť.
3. Pripoj USB kábel a na telefóne potvrď „Povoliť ladenie cez USB“.
4. Over pripojenie: `"%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" devices` → zariadenie so stavom `device`.

## 5. Debug build a inštalácia

**A) Android Studio:** File → Open → `C:\Users\roiaj\esblu-mobile\mobile\android`. Počkaj na Gradle sync, hore vyber svoj telefón a klikni ▶ Run 'app' (variant **debug**).

**B) Príkazový riadok:**

```powershell
cd C:\Users\roiaj\esblu-mobile\mobile\android
.\gradlew.bat assembleDebug
"%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" install -r app\build\outputs\apk\debug\app-debug.apk
```

- Debug build podpisuje Android debug kľúč; release keystore netreba.
- Debug build **nie je** pre Google Play.
- **Ladenie WebView:** Chrome na PC → `chrome://inspect` → Esblu → konzola a sieť.
- **Známe obmedzenie debug buildu:** App Links (`https://www.esblu.com/...` z e-mailu) sa automaticky neoveria, lebo `assetlinks.json` obsahuje release fingerprint. Odkaz sa otvorí v prehliadači alebo cez výber aplikácie. OAuth custom scheme funguje.

## 6. REAL DEVICE TEST PLAN

Ku každému bodu doplň PASS / FAIL a poznámku. Pri FAIL pošli screenshot a výpis z `chrome://inspect`.

| # | Oblasť | Krok | Očakávanie |
|---|---|---|---|
| A1 | Auth | Prihlásenie e-mailom a heslom | dashboard, správna firma a rola |
| A2 | Auth | Odhlásenie (Viac → Odhlásiť) | login obrazovka |
| A3 | Auth | Prihlásiť → zabiť appku (swipe z recents) → otvoriť | ostáva prihlásený (session z Keystore) |
| A4 | Auth | Appka 10+ min na pozadí → späť | žiadna chyba, dáta sa načítajú (refresh tokenu) |
| A5 | Auth | Vo webe „odhlásiť všade“ alebo zmeniť heslo → v appke ťuknúť na modul | presmerovanie na login |
| A6 | Auth | Google prihlásenie (**až po** Supabase redirect URL `com.esblu.app://auth/callback` a `NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS=google` v `mobile\.env.local`) | otvorí sa Chrome Custom Tab, po prihlásení návrat do appky a Custom Tab sa zavrie |
| S1 | Secure storage | A3 zopakovať 2× | stále prihlásený |
| S2 | Secure storage | Lietadlový režim → Odhlásiť → zabiť appku → zapnúť sieť → otvoriť | **login obrazovka** (session nezostala) |
| S3 | Secure storage | Nastavenia telefónu → Aplikácie → Esblu → Vymazať údaje → otvoriť | login (žiadna záloha) |
| F1 | Súbory | Vozidlá → pridať fotku → **Fotoaparát** | fotka sa nahrá a zobrazí |
| F2 | Súbory | Sklad / stroj → fotka z **galérie** | nahrá sa |
| F3 | Súbory | AI evidencia → nahrať doklad (fotka) | spracovanie prebehne |
| F4 | Súbory | Chat → príloha PDF | odoslaná, dá sa otvoriť |
| F5 | Súbory | Faktúra → **PDF** | otvorí sa v prehliadači v appke alebo cez Share |
| F6 | Súbory | Faktúry → export pre účtovníka (ZIP) / XLSX export | Share sheet; uloženie do Stiahnutých funguje |
| F7 | Súbory | Zrušiť Share sheet bez výberu | žiadna chybová hláška |
| P1 | Push | Nastavenia → Notifikácie → zapnúť | systémový dialóg povolenia (Android 13+) |
| P2 | Push | Po povolení | v Nastaveniach zariadenie aktívne (token zaregistrovaný) |
| P3 | Push | Odhlásiť sa | zariadenie odregistrované (už nepríde push) |
| P4 | Push | Iný používateľ pošle chat správu | notifikácia; ťuknutie otvorí konverzáciu |
| N1 | Navigácia | Android **Späť** z detailu, z otvoreného panelu „Viac“, z dialógu | zavrie vrstvu → krok späť → na koreni minimalizuje |
| N2 | Navigácia | Písanie vo formulári / chate | spodná navigácia sa skryje, klávesnica neprekrýva pole |
| N3 | Navigácia | Spodná navigácia: všetky položky podľa roly | správne obrazovky, žiadna prázdna |
| N4 | Navigácia | `adb shell am start -a android.intent.action.VIEW -d "https://www.esblu.com/reset-hesla" com.esblu.app` | otvorí reset hesla v appke |
| N5 | Navigácia | Právne dokumenty (Nastavenia → GDPR) a odkazy v nich | otvoria sa, žiadna mŕtva stránka |
| N6 | Navigácia | Dashboard → hľadanie → ťuknúť na výsledok | správny detail |
| W1 | Sieť | Lietadlový režim → otvoriť appku | offline banner, žiadny pád |
| W2 | Sieť | Formulár (napr. nové vozidlo) → vypnúť sieť → Uložiť | chyba, nič „neuložené“ sa nepredstiera |
| W3 | Sieť | Zapnúť sieť → Uložiť znova | uloží sa **raz** (na produkcii bez idempotency kľúča; plnú ochranu proti duplicitám over na stagingu) |
| W4 | Sieť | Chat: odoslať pri slabom signáli, rýchlo 2× Enter | jedna správa |

## 7. Čo z toho dnes nejde bez externého kroku

| Bod | Chýbajúci externý krok |
|---|---|
| A6 Google login | Supabase → Auth → URL Configuration → Redirect URLs: pridať `com.esblu.app://auth/callback` |
| P1–P4 push | `google-services.json` lokálne; na serveri FCM service account v env a push migrácie v produkčnej DB (podľa `docs/push-notifications-setup.md`) |
| N4 App Links (debug) | overené až s release / Play App Signing kľúčom v `assetlinks.json` |
| W3 plná duplicitná ochrana | staging backend s migráciou `20261008130000` (DB je na `esblu-test`; chýba staging API deployment) |
