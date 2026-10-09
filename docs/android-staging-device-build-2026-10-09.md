# Android device build — STAGING (2026-10-09)

Prvý test na fyzickom zariadení beží **iba proti stagingu**:

| | Hodnota |
|---|---|
| Supabase | `esblu-test` (`cjbdijbbcujvmrzezusd`) |
| API | Vercel Preview vetvy `mobile-platform`: `https://esblu-git-mobile-platform-esblu.vercel.app` |
| Produkcia | nepoužíva sa a nemení sa |
| Variant | debug (Android debug kľúč), žiadna publikácia |

Nahrádza prostredie v `android-first-device-build-2026-10-09.md`. Test plán zo sekcie 6 tam ostáva platný.

## Pripravený projekt (už postavený a synchronizovaný)

```
C:\Users\roiaj\assetpilot\Claude outputs\esblu-mobile-staging\mobile\android
```

- Je to git checkout `mobile-platform`. Priečinok `Claude outputs/` je v `.gitignore` tvojho repa, takže sa ho nedotkne.
- Obsahuje staging `mobile\.env.local`: verejný anon kľúč esblu-test, žiadne server secrets.
- Obsahuje web bundle už skopírovaný cez `cap sync android` a Capacitor Android knižnice (`node_modules\@capacitor\*`), ktoré Gradle potrebuje.
- `android-prebuild-check --target staging` prešiel: Supabase = esblu-test, API = Preview, žiadny produkčný Supabase v bundli, žiadne server secrets ani lokálne cesty.

### V Android Studio

1. File → Open → priečinok vyššie (`...\esblu-mobile-staging\mobile\android`).
2. Počkaj na Gradle Sync (prvýkrát stiahne závislosti). Ak sa spýta na SDK, potvrď predvolené (vytvorí `local.properties`).
3. Hore: konfigurácia **app**, variant **debug** (Build Variants), zariadenie = tvoj telefón cez USB.
4. Klikni na **▶ Run 'app'**.

## Opakovaný build na tvojom PC (ak treba čerstvý bundle)

```powershell
cd "C:\Users\roiaj\assetpilot\Claude outputs\esblu-mobile-staging"
npm ci
npm run build -w mobile
cd mobile; npx cap sync android; cd ..
node scripts\android-prebuild-check.mjs --target staging
```

Prebuild check zlyhá (exit 1) pri:

- **mixed prostredí:** staging Supabase + produkčné API, alebo produkčný Supabase + Preview API;
- **produkčnom Supabase** v staging builde;
- **server secrets** alebo lokálnych cestách v APK.

## Stav stagingu

| Oblasť | Stav |
|---|---|
| Účet | `info@esblu.com` je na beta allowliste **esblu-test** → registrácia v appke e-mailom a heslom (staging). Či staging pošle potvrdzovací e-mail, závisí od Auth nastavení esblu-test |
| Ochrana proti duplicitám | migrácia `client_mutation_id` je na esblu-test → plne testovateľná (W2–W4) |
| Preview API | **chránené Vercel Authentication (SSO)** → volania appky na `/api/*` (push registrácia, AI scan, zrušenie účtu, lookup firmy, PDF) dostanú presmerovanie a zlyhajú. Prihlásenie, čítanie a zápis dát idú priamo do Supabase a fungujú. Nie je overené, či Preview env smeruje na esblu-test |
| Google login | vypnutý (`NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS` prázdne): nie je overený Google provider ani redirect `com.esblu.app://auth/callback` v esblu-test |
| Push | **PUSH NOT CONFIGURED** (chýba `google-services.json`). Appka nevolá FCM `register()` (žiadny pád) a v Nastaveniach zobrazí „Push notifikácie nie sú v tejto zostave nakonfigurované" |
| Ikony | finálna master ikona: launcher, adaptive, round, iOS, splash + monochrómna notifikačná ikona |
