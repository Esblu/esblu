# Android — Google Play release readiness (2026-10-08)

Appka **nie je vydaná** a nebol vytvorený žiadny platený účet ani služba. Android build sa v tomto prostredí nedal spustiť: chýba Android SDK a sťahovanie je blokované. Všetko nižšie je statická kontrola repa a kódu.

| Položka | Stav | Detail | Blocker |
|---|---|---|---|
| Application ID | READY | `com.esblu.app` (`build.gradle`, `capacitor.config.ts`) | — |
| versionCode / versionName | PARTIAL | `1` / `"1.0"` — pri každom uploade treba zvýšiť `versionCode` | CODE (release proces) |
| target / compile SDK | READY | 36 / 36, min 24 (najnovšie API; aktuálnu Play požiadavku na target API overiť v Play Console) | — |
| 64-bit | READY | čistý WebView + Capacitor pluginy, bez vlastných `.so` | — |
| AAB build | PARTIAL | `./gradlew bundleRelease` (mobile/android) | REAL DEVICE TEST (build na tvojom PC) |
| Signing | READY | `app/keystore.properties` mimo Git, `RELEASE_SIGNING.md`; bez súboru release build zlyhá jasnou chybou | GOOGLE USER ACTION: Play App Signing (upload kľúč) |
| Permissions | READY | `INTERNET`, `POST_NOTIFICATIONS`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`; žiadne `CAMERA` (camera intent), žiadne storage permission (Cache + Share) | — |
| Notification permission (Android 13+) | READY | žiada sa iba z kliknutia v Nastaveniach | REAL DEVICE TEST |
| Foto / súbory | READY | systémový picker / camera intent cez `<input capture>`; exporty do `Directory.Cache` + Share sheet | REAL DEVICE TEST |
| allowBackup | READY (opravené) | `allowBackup="false"` — session tokeny vo WebView úložisku sa nezálohujú ani neprenášajú na iné zariadenie | — |
| OAuth (Google) | PARTIAL | Custom Tab + PKCE + `com.esblu.app://auth/callback` intent-filter | CONFIG: pridať `com.esblu.app://auth/callback` do Supabase Auth → Redirect URLs; GOOGLE USER ACTION: Google Cloud OAuth client už existuje pre web — overiť consent screen |
| Deep links (App Links) | READY | `autoVerify` pre `/invite`, `/reset-hesla`, `/onboarding/company`, `/auth/callback`; `assetlinks.json` s upload certifikátom | GOOGLE USER ACTION: po zapnutí Play App Signing doplniť jeho SHA-256 do `assetlinks.json` |
| Firebase / FCM | PARTIAL | `google-services.json` mimo Git (Gradle ho voliteľne aplikuje); server FCM HTTP v1 | GOOGLE USER ACTION: Firebase projekt + `google-services.json` lokálne + service account v server env |
| Crash behavior | PARTIAL | WebView chyby sa zobrazia per obrazovku; offline banner; bez crash reportingu (Crashlytics nie je pridaný) | rozhodnutie (voliteľné) |
| Ikona | READY (2026-10-09) | zo schválenej master ikony `mobile/icon-source/esblu-master-icon.png`: legacy + round + adaptive foreground (zmenšený na 0.77 do safe zóny, biele pozadie). Text „Esblu" je čitateľný od 72 px, pri 48 px rozpoznateľný | STORE REVIEW; symbol-only notifikačná ikona je iba návrh v `mobile/icon-source/proposals/` (nezapojená) |
| Splash | READY | vygenerovaný zo schválenej `public/icons/icon-512.png` (bez zväčšenia) | STORE REVIEW (vizuálna kontrola) |
| Store listing | MISSING | názov, krátky/dlhý popis, screenshoty (telefón, 7" / 10" voliteľne), feature graphic 1024×500, kategória Business | GOOGLE USER ACTION |
| Privacy policy URL | READY | `https://www.esblu.com/ochrana-osobnych-udajov` | LEGAL/CLIA (aktuálnosť) |
| Data safety formulár | PARTIAL | vstupy nižšie | GOOGLE USER ACTION + LEGAL/CLIA |
| Zrušenie účtu | READY (opravené) | v appke: Nastavenia → Zrušiť účet; owner firmy s finalizovanými faktúrami dostane vysvetlenie, nič sa nezmaže; webový odkaz pre Play formulár: `https://www.esblu.com/nastavenia` (po prihlásení) | GOOGLE USER ACTION: uviesť URL v Data safety; LEGAL/CLIA: postup pre blokovaný prípad (info@esblu.com) |
| Prístup pre recenzenta | MISSING | uzavretá beta (allowlist) → treba demo účet s firmou a ukážkovými dátami | GOOGLE USER ACTION (pridať e-mail na allowlist + heslo do Play Console „App access") |
| Play Developer účet | MISSING? | ak ešte neexistuje: jednorazový poplatok, overenie identity / organizácie (D-U-N-S pre firmy) | GOOGLE USER ACTION |
| Testovanie pred produkciou | MISSING | nové osobné účty: closed testing ≥ 12 testerov × 14 dní (pravidlo pre nové osobné vývojárske účty; firemný účet túto podmienku nemá — overiť v Play Console) | GOOGLE USER ACTION |

## Data safety — vstupy (návrh na posúdenie)

- **Zbierané údaje:**
  - e-mail a meno (účet);
  - firemné údaje (IČO, DIČ, adresa);
  - fotky a súbory (doklady, vozidlá, stroje);
  - hlasový záznam (iba počas hlasového ovládania, spracovanie AI poskytovateľom);
  - správy (chat);
  - finančné údaje (faktúry);
  - identifikátory zariadenia (push token, installationId).
- **Zdieľanie:** subprocesori podľa `/subprocessors` (Supabase, Vercel, OpenAI, Google/Apple pre push).
- **Šifrovanie pri prenose:** áno (HTTPS).
- **Možnosť vymazania:** áno (v appke + kontakt).
- **Reklama:** nie. **Analytika tretích strán:** nie.

## Poradie krokov k internému testu (bez platenej aktivácie mimo Play registrácie)

1. **[GOOGLE]** Play Console účet a vytvorenie appky `com.esblu.app`.
2. **[GOOGLE]** Firebase projekt; `google-services.json` do `mobile/android/app/` (necommitovať).
3. **[CONFIG]** Supabase Redirect URLs: `com.esblu.app://auth/callback`.
4. **[REAL DEVICE]** `npm run build -w mobile && npx cap sync android && ./gradlew bundleRelease` → AAB → Internal testing.
5. **[GOOGLE]** Play App Signing; SHA-256 do `assetlinks.json` (web deploy so súhlasom).
6. **[GOOGLE + LEGAL]** Data safety, privacy policy, demo účet, store listing.

## Aktualizácia 2 (2026-10-08, autonómne dokončenie)

- **Secure storage:** Supabase session a PKCE verifier sú v Android Keystore (AES-256-GCM, `EsbluSecureStoragePlugin.java`, registrovaný v `MainActivity`). Staré localStorage sa bezpečne zmigruje. Logout úložisko vyprázdni.
- **Idempotencia:** `client_mutation_id` pre faktúru, partnera, vozidlo, stroj, sklad, priečinok a chat. Migrácia je aplikovaná na **esblu-test**, produkcia nie.
- **Deep links:** šablóna `assetlinks` s placeholderom Play App Signing SHA-256 je v `mobile/deep-link-templates/` (nenasadená).
- **verify:mobile-bundle:** prechádza na produkčnom Turbopack builde a na `cap sync` kópii.
