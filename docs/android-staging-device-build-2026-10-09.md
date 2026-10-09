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
- **server secrets** alebo lokálnych cestách v APK;
- **API hostname**, ktorý nie je staging (`esblu-*.vercel.app` alebo `*staging*.esblu.com`), alebo viac ako jednom API origine;
- **živej sonde Preview API**: `GET <API>/api/push/preferences` bez session musí vrátiť odpoveď samotnej appky (`401 {"success":false}`). Vercel Deployment Protection (302 na `vercel.com/sso-api` alebo JSON 401 „Protected deployment“), HTML, timeout či sieťová chyba = **FAIL** (fail closed).

## Stav stagingu (precheck 2026-10-09)

| Oblasť | Stav |
|---|---|
| Preview | `https://esblu-git-mobile-platform-esblu.vercel.app` (READY, commit `f0b4e12`) |
| Preview env | `NEXT_PUBLIC_SUPABASE_URL` aj anon kľúč = esblu-test; nič neukazuje na produkčný Supabase. `SUPABASE_SERVICE_ROLE_KEY` a OpenAI kľúč sú *sensitive* → hodnotu nemožno prečítať ani overiť |
| Preview API | **BLOKOVANÉ** Vercel Authentication (`all_except_custom_domains`). Bez prihlásenia: 302 na `vercel.com/sso-api`, resp. JSON 401 „Protected deployment“. Prebuild check preto **zlyhá** (zámerne) |
| Riešenie (čaká na schválenie) | custom doména `mobile-staging.esblu.com` priradená iba vetve `mobile-platform`. Custom domény ochrana `all_except_custom_domains` nechráni, produkcia a ostatné Preview ostávajú chránené. DNS je v Namecheap → vyžaduje CNAME. Bypass secret do APK sa **nedáva** |
| Auth esblu-test | e-mail/heslo zapnuté, registrácia povolená, **potvrdenie e-mailom povinné** (`mailer_autoconfirm=false`). Účet `info@esblu.com` zatiaľ neexistuje (je na beta allowliste) |
| Redirect URL | `com.esblu.app://auth/callback` v esblu-test **nie je overený ani pridaný**: Auth URL Configuration nie je dostupná cez dostupné nástroje (bez Supabase Management tokenu) |
| Google login | esblu-test: provider **vypnutý** (NOT CONFIGURED); v appke `NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS` prázdne |
| Ochrana proti duplicitám | migrácia `client_mutation_id` je na esblu-test |
| Push | **PUSH NOT CONFIGURED** (bez `google-services.json`) — akceptované; appka nevolá FCM `register()` |
| App Links (debug) | **NOT VERIFIED UNTIL RELEASE SIGNING** (`assetlinks.json` má release fingerprint) |
| Ikony | finálna master ikona: launcher, adaptive, round, iOS, splash + monochrómna notifikačná ikona |
