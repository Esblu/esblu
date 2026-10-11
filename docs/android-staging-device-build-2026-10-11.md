# Android device build — STAGING, UI refresh + voice hardening (2026-10-11)

Debug build pre fyzický telefón. Beží **iba proti stagingu**, nič sa nepublikuje do Google Play.

| | Hodnota |
|---|---|
| Commit | `f212341` (`mobile-platform`) |
| Supabase | `esblu-test` (`cjbdijbbcujvmrzezusd`), iba anon kľúč |
| API | `https://mobile-staging.esblu.com`, Vercel Preview `dpl_Bw66HasQaBGCUxdybNcSAS27En5X` (READY) |
| Variant | debug (Android debug kľúč) |
| Push | NOT CONFIGURED (bez `google-services.json`), zámerne |

## Pripravený projekt

```
C:\Users\roiaj\assetpilot\Claude outputs\esblu-mobile-staging-2026-10-11\mobile\android
```

Je to čerstvý `git clone` vetvy `mobile-platform` na `f212341`. Priečinok `Claude outputs/` je v `.gitignore`. Starý kit `esblu-mobile-staging` (s neuloženými zmenami) som nemenil.

Obsah kitu:
- `mobile/.env.local` je skopírovaný zo starého kitu (staging anon kľúč, žiadne server secrets).
- `mobile/android/local.properties` je skopírovaný zo starého kitu (cesta k SDK).
- `node_modules/@capacitor/*` obsahuje natívne knižnice, ktoré Gradle potrebuje. Žiadny nový plugin nepribudol.
- Web bundle je už skopírovaný cez `cap sync android` do `app/src/main/assets/public`.
- `android-prebuild-check --target staging` prešiel vo všetkom okrem živej sondy API. Sandbox nemá DNS na staging, preto som sondu overil z prehliadača: `GET /api/push/preferences` vrátil JSON `401 {"success":false}`, teda OK a bez Vercel protection.

Poznámka k fontu: sandbox nemá prístup ku Google Fonts. Bundle v kite je preto zostavený s tým istým súborom Geist (latin woff2) z predchádzajúceho buildu cez `next/font/local`. Táto zmena je iba v build kópii, nie v repe. Vizuálne je to rovnaké ako pri builde zo siete. Ak chceš 100 % čistý bundle, spusti „Opakovaný build" nižšie.

## Oprava kitu (Gradle Sync FAIL, 2026-10-11)

Prvá verzia kitu mala chybu: `cap sync android` bežal v pomocnej kópii a späť sa skopírovali iba `assets/` a dva gradle súbory. Generovaný priečinok `mobile/android/capacitor-cordova-android-plugins/` (gitignored) chýbal, preto `app/capacitor.build.gradle` nevedel načítať `cordova.variables.gradle`.

Oprava:
- `cap sync android` (Capacitor CLI 8.5.0, node_modules podľa `package-lock.json`) nad identickým stromom.
- Do kitu sa prenieslo **celé** vygenerované `mobile/android` (vrátane `capacitor-cordova-android-plugins/`, `capacitor.plugins.json`, `res/xml/config.xml`).
- `node_modules/@capacitor/*` je byte-identické so syncom.
- Všetky súbory a projekty, na ktoré Gradle odkazuje, existujú.

Pri ďalšom kite: sync vždy spúšťať priamo v cieľovom checkoute (alebo preniesť celé `mobile/android`).

## Android Studio

1. File → Open → `...\esblu-mobile-staging-2026-10-11\mobile\android`.
2. Gradle Sync.
3. Build Variants: **debug**. Zariadenie: telefón cez USB (USB ladenie zapnuté).
4. **▶ Run 'app'**.
5. Ak je nainštalovaná staršia verzia s iným podpisom, odinštaluj ju.

Zmena v natívnom kóde:
- `EsbluAppConfigPlugin.java` má nové metódy `haptic` a `openAppSettings`.
- Statická kontrola proti zdrojom Capacitor 8 sedí (`getBridge().getWebView()`, `getActivity()`, `PluginCall.getString(name, default)`, `reject(msg)`).
- Gradle kompilácia prebehne až u teba, sandbox nemá Android SDK.

## Opakovaný build na tvojom PC (čerstvý bundle zo siete)

```powershell
cd "C:\Users\roiaj\assetpilot\Claude outputs\esblu-mobile-staging-2026-10-11"
npm ci
npm run build -w mobile
cd mobile; npx cap sync android; cd ..
node scripts\android-prebuild-check.mjs --target staging
```

## Čo otestovať na telefóne

Pozri report a `docs/esblu-ui-voice-refresh-2026-10-11.md` §10. Hlasový round-trip (prepis a AI) závisí od OpenAI kľúča v Preview prostredí. Ak je na stagingu vypnutý, chyba prepisu **nie je regresia**: appka má povedať „Služba je dočasne nedostupná" alebo „Spojenie zlyhalo" a po 3 pokusoch hlas ukončiť.
