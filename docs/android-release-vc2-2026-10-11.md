# Android release vc2 — Internal Testing (2026-10-11)

| Položka | Hodnota |
|---|---|
| Package | `com.esblu.app` (nezmenené) |
| versionName / versionCode | **1.0.0 / 2** (vc1 = prvý build z `main` @ 901c46c, nikdy sa neprepisuje) |
| minSdk / targetSdk | 24 / 36 (`mobile/android/variables.gradle`, nezmenené) |
| Zdroj | `mobile-platform` (commit uvedený v `esblu-1.0.0-vc2.signing.txt` a v reporte). **Nie `main`** |
| Backend | **produkcia**: Supabase `fkpgvgvsmbpieduoatrt`, API `https://www.esblu.com` |
| Výstup | `Claude outputs\esblu-mobile-production-beta\release\esblu-1.0.0-vc2.aab` + `.signing.txt` (mimo Gitu) |
| Upload key | `%USERPROFILE%\Documents\Esblu-keys\esblu-upload-key-2026.jks`, alias `esblu` |
| Upload key SHA-256 | `51:83:9A:35:D8:3F:29:96:2F:CB:B5:5C:9F:4F:B0:8A:F6:34:97:E7:48:A6:EB:02:30:DC:41:95:AC:6B:11:BA` |
| Upload key SHA-1 | `09:F1:11:63:0F:5F:DF:AB:97:B4:A4:6A:9B:AF:B6:35:28:CD:53:07` |

## Postup

**1. Pripravené agentom v sandboxe:**
- produkčný checkout `Claude outputs\esblu-mobile-production-beta` aktualizovaný na zdrojový commit `mobile-platform`. Lokálne súbory sa zachovali: `mobile/.env.local`, `keystore.properties`, `google-services.json`, `release/*` artefakty vc1;
- čerstvý produkčný web build (`mobile: npm run build`) a `npx cap sync android`;
- `android-prebuild-check.mjs --target production` a `verify-mobile-bundle`.

**2. Podpis a bundle (vlastník, Windows, PowerShell)** — sandbox nemá upload keystore, heslo ani Android SDK. Heslo sa zadáva skryto a nikde sa neukladá:

```powershell
cd "C:\Users\roiaj\assetpilot\Claude outputs\esblu-mobile-production-beta\release"
powershell -ExecutionPolicy Bypass -File .\build-release-aab.ps1
```

Skript postupne:
- vyberie JDK 21 (`jdk21.ps1`, JDK 25/JBR 25 nikdy);
- overí odtlačok keystore **pred** buildom (inak STOP, nič nepostaví);
- overí, že `google-services.json` obsahuje klienta `com.esblu.app`;
- spustí `gradlew bundleRelease -Dorg.gradle.java.home=<JDK21> -PesbluVersionCode=2 -PesbluVersionName=1.0.0`;
- overí podpis (`jarsigner`, nie debug, SHA-256 = upload key);
- zapíše `esblu-1.0.0-vc2.signing.txt` (iba verejné odtlačky);
- existujúci AAB s rovnakým versionCode **neprepíše**.

Kontrola JVM pred buildom: `.\gradlew.bat -version -Dorg.gradle.java.home=$env:JAVA_HOME` v `mobile\android`. Launcher JVM aj Daemon JVM = 21.

**3. Overenie (agent alebo vlastník):**

```bash
python3 scripts/verify-release-aab.py "<…>/release/esblu-1.0.0-vc2.aab" \
  --expected-sha256 51:83:9A:35:D8:3F:29:96:2F:CB:B5:5C:9F:4F:B0:8A:F6:34:97:E7:48:A6:EB:02:30:DC:41:95:AC:6B:11:BA
```

Verifier kontroluje:
- package, versionCode/Name, min/target SDK;
- podpisový certifikát (nie debug, očakávaný SHA-256);
- 64-bit ABI;
- `android-prebuild-check --target production` nad zabalenými web assetmi: iba produkčný Supabase/API, žiadna stopa stagingu, žiadne server secrets ani lokálne cesty.

## Upload key ≠ Play App Signing key

- **Upload key** (vyššie) podpisuje iba súbor, ktorý nahráme do Play Console. Google ho overí a odstráni.
- Do zariadení ide APK podpísané kľúčom **Play App Signing**, ktorý drží Google. Ten vznikne a zobrazí sa až po **prvom uploade** (Play Console → Test and release → App integrity → App signing key certificate).
- Pre App Links nainštalované zo storu (`https://www.esblu.com/.well-known/assetlinks.json`) je hlavný **Play App Signing SHA-256**. Upload key SHA-256 sa môže pridať ako druhý (pre sideload/interné buildy).
- Úprava a produkčný deploy `assetlinks.json` je **samostatný krok s explicitným súhlasom vlastníka**. Teraz sa nemení (legacy `D0:D0:81…` ostáva, kým sa krok nespraví).
- Play App Signing sa aktivuje pri prvom uploade v Console, nie týmto buildom.

## Čo vc2 obsahuje (oproti vc1)

| Oblasť | Stav |
|---|---|
| nová nástenka | valec modulov, zamknuté moduly s „Požiadať o aktiváciu", bezpečný fallback zoznam |
| navigácia | Viac a Chat ako nepriehľadné obrazovky (bez presvitania), FAB iba na nástenke |
| vizuál | aktualizovaný mobilný vizuál a dizajnový systém |
| hlas | hardening (stavový automat, offline/chyby, upratanie mikrofónu, haptika, nastavenia), bezpečnostný model príkazov (zápis iba po potvrdení, mazanie iba ťuknutím), stav mikrofónu podľa nároku (zámok namiesto skrytia), 503 pri vypnutej AI |
| z vc1 ostáva | produkčný Google login, push (Firebase), secure storage, správa médií |

**Server:** vc2 volá produkčné API (`main`). Zmeny `app/api` v `mobile-platform` voči `main` sú spätne kompatibilné:
- preflight/delete: nové voliteľné polia;
- transcribe: 503 iba bez kľúča.

vc2 preto funguje aj s dnešnou produkciou. Serverové časti sa nasadia až pri schválenom merge.

## Internal Testing release notes

**SK (sk-SK)**
```
• Nový prehľad: moduly v otočnom valci, rýchlejší prístup k vozidlám, strojom, skladu a faktúram
• Prepracované mobilné rozhranie a čitateľnejší vzhľad
• Stabilnejšie hlasové ovládanie s jasnými stavmi a bezpečným potvrdzovaním zmien
• Opravy navigácie (Viac, Chat) a celkové zlepšenie výkonu
```

**EN (en-US)**
```
• New overview: modules in a rotating carousel for quick access to vehicles, machines, inventory and invoices
• Redesigned mobile interface with improved readability
• More reliable voice control with clear status and safe confirmation of changes
• Navigation fixes (More, Chat) and general performance improvements
```

## Hranice

- Nič sa nenahráva do Play a nič sa nepublikuje.
- Closed testing a Production stále čakajú na CLIA/GDPR/VOP, Data Safety, reviewer účet a ďalšie gates (`release/play-submission/09-release-gates.md`).
