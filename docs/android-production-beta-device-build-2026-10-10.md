# Android device build — PRODUCTION closed beta (2026-10-10)

Interný test na vlastnom telefóne proti **produkčnému** Esblu (rovnaký účet a dáta ako web). Nič sa nepublikuje do Google Play.

| | Hodnota |
|---|---|
| Supabase | produkcia `assetpilot` (`fkpgvgvsmbpieduoatrt`), verejný anon kľúč |
| API | `https://www.esblu.com` (bez `NEXT_PUBLIC_ESBLU_API_ORIGIN`) |
| Package | `com.esblu.app` (rovnaký ako staging build → inštalácia ho na telefóne **nahradí**) |
| Variant | debug (Android debug kľúč) |
| Zmeny v produkcii | žiadne (iba read-only audit) |

## Pripravený projekt

```
C:\Users\roiaj\assetpilot\Claude outputs\esblu-mobile-production-beta\mobile\android
```

Obsahuje produkčný `mobile\.env.local` (iba verejné hodnoty), web bundle po `cap sync android` a Capacitor Android knižnice. Nie je to git checkout (iba súbory z `mobile-platform`).

Android Studio: File → Open → priečinok vyššie → Gradle Sync → variant **debug** → telefón → **▶ Run 'app'**.

## Opakovaný build

```powershell
copy mobile\.env.production.example mobile\.env.local   # doplň NEXT_PUBLIC_SUPABASE_ANON_KEY (verejný, ako na webe)
npm run build -w mobile
cd mobile; npx cap sync android; cd ..
node scripts\android-prebuild-check.mjs --target production
```

`--target production` zlyhá pri: inom Supabase než produkcia, anon kľúči iného projektu, akomkoľvek `role` ≠ `anon` v bundli, staging refe / `mobile-staging.esblu.com` / `*.vercel.app` v bundli, API ≠ `www.esblu.com`, server secrets, a ak `https://www.esblu.com/api/push/preferences` neodpovie samotná appka (`401 {"success":false}`).

## Read-only audit produkcie (2026-10-10)

| Oblasť | Stav |
|---|---|
| Auth | e-mail/heslo zapnuté, potvrdenie e-mailom povinné, Google provider zapnutý |
| Redirect URLs | `https://www.esblu.com/**`, `https://esblu.com/**`, localhost + **`com.esblu.app://auth/callback`** (pridané 2026-10-10 so súhlasom vlastníka; nič iné sa nemenilo) |
| API + CORS | `www.esblu.com/api/*` odpovedá appkou (401 JSON bez session), preflight povoľuje `https://localhost` |
| DB | bez `client_mutation_id` (migrácia je iba na esblu-test) → appka zapisuje bez idempotency kľúča (fallback) |
| App Links | `assetlinks.json` existuje pre `com.esblu.app`; debug kľúč sa s ním nezhoduje → **NOT VERIFIED UNTIL RELEASE SIGNING** |

## Čo v tomto builde nefunguje (fail closed)

- **Push:** PUSH NOT CONFIGURED (bez `google-services.json`); appka nevolá FCM a nepadá.
- **App Links** z e-mailov (`https://www.esblu.com/...`): otvoria sa v prehliadači (web), nie v appke.
- **Ochrana proti duplicitám** (`client_mutation_id`): na produkcii neaktívna, kým sa migrácia neschváli a nenasadí.

## Google login (zapnutý v production beta builde, 2026-10-10)

- `mobile\.env.local`: `NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS=google` (iba mobilný build; web používa vlastnú konfiguráciu, nezmenené).
- Existujúci produkčný Google provider (Supabase-hosted OAuth, web client ID + secret) — credentials sa nemenili.
- Tok: tlačidlo Google → `signInWithOAuth({ skipBrowserRedirect: true, redirectTo: "com.esblu.app://auth/callback" })` → **Chrome Custom Tab** (`@capacitor/browser`, nie WebView) → Google → Supabase → `com.esblu.app://auth/callback?code=…` → intent-filter otvorí appku → DeepLinkBridge zavrie Custom Tab a otvorí lokálny `/auth/callback.html?code=…&oauth=native` → PKCE výmena s code_verifierom z Keystore → session v Keystore.
- `redirectTo` je presne allowlistovaný reťazec bez query (Supabase glob porovnáva celé URL vrátane query).

## Push / FCM (production beta, 2026-10-10)

| Vrstva | Stav |
|---|---|
| Firebase | projekt `esblu-c0652`, Android app `com.esblu.app` (existujúci `google-services.json`, lokálny, gitignored) |
| Server | Vercel Production má `FCM_PROJECT_ID` (= `esblu-c0652`), `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`; push tabuľky + RPC sú v produkčnej DB; `/api/push/*` je na `main` totožné s `mobile-platform` |
| Ownership | registrácia cez RPC ako prihlásený používateľ (`user_id = auth.uid()`, `company_id = aktívna firma`, väzba na auth session); cudzí aktívny token → 409; doručenie iba živej session + aktívnemu členstvu v tej istej firme; neplatný token → revoke |
| Klient | povolenie (Android 13+ `POST_NOTIFICATIONS`) iba z kliknutia v Nastaveniach; kanál `esblu_default`; refresh tokenu (onNewToken) iba pre používateľa, ktorý push zapol; tap → allowlist obrazoviek (`screen` + UUID), nikdy URL; odhlásenie → `DELETE /api/push/devices` + `unregister()`; bez `google-services.json` žiadny `register()` |
| Ikona | monochrómna `@drawable/ic_stat_esblu`, farba `#0181FD` |

### Real-device test
1. Login (e-mail/heslo alebo Google).
2. Nastavenia → Notifikácie → Zapnúť → systémový dialóg **Povoliť**.
3. Registrácia: zariadenie sa zobrazí ako aktívne; server-side overenie `push_devices` (read-only).
4. Test push (bezpečný text, bez dát firmy): Firebase Console → projekt `esblu-c0652` → Messaging → New campaign → Notifications → názov `Esblu test`, text `Testovacia notifikácia` → Target: App `com.esblu.app` → Additional options → Custom data `screen` = `settings` → Publish.
5. Foreground (appka otvorená) aj background (appka na pozadí / zamknutý telefón): notifikácia s Esblu ikonou.
6. Ťuknutie → Esblu → Nastavenia.
7. Odhlásenie → zariadenie odregistrované (`revoked_at`).
8. Zopakovať krok 4 → nesmie doraziť.
