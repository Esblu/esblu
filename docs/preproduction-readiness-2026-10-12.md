# Esblu — pre-production readiness (release candidate, 2026-10-12)

Branch `preprod-release-candidate` (integračný, **nie produkčný**). Nič z tohto dokumentu nebolo
nasadené do produkcie, žiadna produkčná DB zmena, žiadne secrets, žiadne live billing, žiadny
reviewer účet, žiadne produkčné assetlinks, žiadny merge do `main` ani `mobile-platform`.

## Baseline a zloženie RC

| Branch | HEAD | Poznámka |
|---|---|---|
| `main` | `901c46c` | = origin. Lokálny pracovný strom `main` má 52 necommitnutých položiek (39 súborov iba CRLF šum, 1 reálna zmena v `docs/closed-beta-and-plans-2026-09-25.md`, nesledované CLIA/eFaktúra docs a rollback SQL) — **nedotknuté**. |
| `mobile-platform` | `76ad27f` | = origin, `main` ⊂ `mobile-platform` (30 commitov navyše) |
| `subscriptions-platform` | `2e3cdc3` | = origin, `main` ⊂ |
| `subscriptions-mobile-integration` | `1fe2c17` | = origin; obsahuje `mobile-platform` aj `subscriptions-platform` (16 commitov nad `76ad27f`, 0 chýbajúcich) |

Ancestry je konzistentná: `main ⊂ mobile-platform ⊂ subscriptions-mobile-integration` a `subscriptions-platform ⊂ subscriptions-mobile-integration`.

RC = `origin/mobile-platform` + `--no-ff` merge `origin/subscriptions-mobile-integration` (bez konfliktov; strom merge commitu
je identický so `1fe2c17`) + 3 hardening commity. **Nemergované:** `main`, `einvoice-port`/`einvoice-foundation`, žiadne právne texty.

### Konflikt audit (mobile-platform → RC)

Billing mení existujúce súbory iba aditívne:

| Oblasť | Zmena | Riziko |
|---|---|---|
| `package.json` | iba nové `test:*` skripty; lock: `@capacitor/ios` (už v `mobile/package.json`) | žiadne |
| `app/nastavenia/page.tsx` | odkaz „Predplatné" iba ak `NEXT_PUBLIC_ESBLU_BILLING_UI=1` (default skrytý) | žiadne |
| entitlement RPC | bez zmeny volaní; nároky zo `subscriptions` zapisujú do tých istých `company_entitlements` | žiadne |
| `lib/cors.ts` | `/api/billing/webhooks/*` vyňaté z CORS (server-to-server) | žiadne |
| `MainActivity.java` | voliteľná registrácia `EsbluBillingPlugin` cez reflection (pred core pluginmi) | žiadne pri billing OFF |
| `build.gradle` | `-PesbluBilling=true` pridá `src/billing/java` + `billing:9.1.0` | default nezmenený |
| `AndroidManifest.xml` | +1 App Link path `/nastavenia/predplatne` | žiadne nové povolenie |
| `deep-link-resolve.ts` | návrat zo Stripe (`checkout_id` UUID, `checkout` enum) | whitelist |
| JDK tooling | `release/jdk21.ps1` (PS 5.1 NativeCommandError fix) + testy | — |
| auth/session, dashboard, voice, push, Capacitor config | **bez zmeny** z billing vetvy | — |

## A. Code readiness

- tsc: **PASS** (0 chýb). Lint: **37 chýb / 26 varovaní = identické s baseline** `1fe2c17` (porovnanie súbor × pravidlo; 0 nových).
- `git diff --check`: PASS. Secret scan diffu aj repa: PASS (iba testovacie fixtures).
- Testy: **52/52 test suites PASS** (≈ 2 300 kontrol vrátane PGlite DB testov: subscriptions, lifecycle, RLS, push, storage, M1 authz, OAuth, idempotency).
- Web build: **PASS** (`next build --webpack`, dummy env). Mobile static export: **PASS** (billing OFF aj `NEXT_PUBLIC_ESBLU_BILLING_UI=1`).
  Sandbox nemá prístup na Google Fonts → build so `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` + webpack; **Turbopack build (`npm run build -w mobile`) treba pustiť na Windows kite** (`verify:mobile-bundle` vyžaduje Turbopack bundle).

### Opravy v RC (konkrétne bugy, bez redesignu dashboardu)

| Commit | Oprava |
|---|---|
| `45665ae` | offline cold start s expirovaným tokenom už nevedie na `/login` (session ostáva, „Skúsiť znova"); `INITIAL_SESSION` neprepíše chybový štart; membership `null` (sieť) sa necachuje na celú session; Vozidlá/Stroje/Sklad bez nekonečného skeletonu; chyba načítania nárokov ≠ „limit plánu" (+ retry, create ostáva fail-closed); OfflineBanner sticky (neprekrýva Späť/nadpis); intent search 15 s timeout + abort; logout guard; DPA/Legal gate bez duplicitných RPC pri každej navigácii a token refreshi; MediaRecorder `stop` poistka (mic nevisí v „listening"); `app/error.tsx` + `global-error.tsx` (+ mobile) |
| `558de99` | Predplatné: double-submit (ref), busy počas redirectu a čakania na webhook, fetch timeout, stop pollingu po odchode, štart nikdy nevisí v „loading", Apple restore feedback, invalidácia cache nárokov po serverovom potvrdení (dashboard sa odomkne bez reštartu), live región, 44 px; fake natívny bridge iba pri `NEXT_PUBLIC_ESBLU_ENV=staging`; build matrix kontroluje produkčný baseline povolení + `allowBackup=false` |
| `3ebaf4b` | zrušenie účtu (owner): `companies.owner_id` overené **pred** mazaním Storage; scan routy logujú `safeAiErrorMeta` (nie raw SDK error); chat bublina z klávesnice; aria labely (chat, login) |

## B. Mobile readiness

| Oblasť | Stav | Overenie |
|---|---|---|
| Auth (email/heslo, Google PKCE, session restore, Keystore, logout cleanup) | PASS | `test:auth-recovery`, `test:secure-storage-runtime` (16), `test:google-oauth(-db)`, `test:mobile-m1`; headless offline cold-start (Chromium, sieť odpojená): chyba štartu po 15 s, session zachovaná |
| Dashboard (cylinder, 0/1/2/3+, locked, loading/error, overlay, Viac, reduced motion) | PASS | `test:dashboard-cylinder`, `test:mobile-layering`, `test:plan-entitlements`; headless 360/430 px bez horizontálneho pretečenia |
| Voice (mic gate, hidden/pending/locked/active, offline, permission denied, lifecycle, bez úniku audia) | PASS | `test:voice-mic-gate`, `voice-e2e`, `voice-hardening` (35), `continuous-voice` |
| Push (register/unregister, žiadny token v logoch, logout unregister, permission denied) | PASS | `test:push` (28), `test:push-db` (31) |
| Files/images (signed URLs, žiadny public bucket, bezpečné delete) | PASS | `test:storage-media(-db)` |
| Account delete (precheck, poradie DB → súbory) | PASS (po `3ebaf4b`) | `test:mobile-platform` (55) |

Nespustené tu (vyžaduje zariadenie): reálny Android WebView beh, FCM doručenie, mikrofón na zariadení.

## C. Android readiness

- Package `com.esblu.app`, `minSdk 24`, `compileSdk/targetSdk 36`, versionCode/Name cez `-PesbluVersionCode/-PesbluVersionName` (default 1/1.0; vc2 release tooling nezmenený). Upload key: nič neregenerované.
- Zdrojový manifest: `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`; `allowBackup="false"`; exported iba launcher `MainActivity`; FileProvider `exported=false`. FCM merge pridá `WAKE_LOCK`, `c2dm.RECEIVE`, `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`.
- Billing ON: + `com.android.vending.BILLING` (z knižnice `billing:9.1.0`), žiadna nová exported komponenta (kontroluje matrix).
- **Build matrix (JDK 21, Windows)**: sandbox nemá Android SDK ani JDK 21 → **treba spustiť na Windows kite**:
  `powershell -ExecutionPolicy Bypass -File .\release\build-billing-matrix.ps1`. Kontroluje billing OFF (žiadny billingclient, žiadne BILLING, plugin nekompilovaný) aj ON (9.1.0, plugin, BILLING, diff = iba BILLING, žiadny nový exported) + **nové v RC**: zakázané povolenia (location/camera/contacts/storage/media/AD_ID/exact alarm/FGS) a `allowBackup=false` v oboch merged manifestoch.
- Statické kontrakty PASS: `test:native-billing-contract` (14), `test:android-release-tooling`, `android-prebuild-check` (v `test:mobile-platform`).

## D. Billing readiness

- Default **DISABLED**: server `ESBLU_BILLING_MODE` / `ESBLU_BILLING_STORE_MODE` nenastavené → `off`; `VERCEL_ENV=production` → vždy `off` (aj s env); `live` → `LIVE_NOT_APPROVED`; DB check constraint povoľuje iba `environment='test'`; `sk_live_` kľúč = chyba validácie.
- Klient: UI odkaz iba s `NEXT_PUBLIC_ESBLU_BILLING_UI=1`; natívny plugin iba s `-PesbluBilling=true`; fake bridge iba v staging builde. Bez explicitnej provider konfigurácie **nie je možné spustiť reálnu platbu**.
- Kontrakty: `managed_via`, restore, `pending`, `already_owned`, `billing_unavailable`, fail-closed provider modes — testy `subscriptions` (60 PGlite), `subscriptions-lifecycle` (44 + 49 PGlite), `native-billing-contract`.
- Entitlement E2E (PGlite): fake/podpísaný webhook → subscription active → `company_entitlements` → rovnaké nároky web/Android/iOS; expiry bez webhooku → nárok vyprší; refund/revoke → zamknuté; manuálny/beta grant prežije zrušenie; trial zachovaný a nepredĺžiteľný klientom; employee vidí plán/stav, nesmie spravovať. Klient: po potvrdení sa zdieľaná cache nárokov invaliduje → dashboard odomkne modul bez reštartu (RC fix).
- ~~Gap: zrušenie účtu s aktívnym predplatným~~ → **vyriešené na branchi** (fail-closed precheck + DB poistka, `docs/account-deletion-subscription-policy-2026-10-12.md`). Migrácia `20261012120000` čaká na staging/prod schválenie.

## E. Security

- Klientsky bundle (web `.next/static`, mobile `out/`): žiadne `STRIPE_SECRET_KEY`, `OPENAI_API_KEY`, service role, Google/Apple privátne kľúče, webhook/cron/fake secrets, `sk_test_`/`whsec_`. Supabase kľúče v bundli iba `role=anon` (prebuild check).
- Žiadny import server-only modulov z 111 `"use client"` súborov ani `mobile/app/**`.
- Webhooky: podpis pred dedupe/zápisom (Stripe 300 s okno + constant-time, Apple JWS + bundle, Google OIDC iss/aud/email), fake routy 404 v produkcii.
- Logy: žiadne purchase tokeny, webhook payloady (DB iba sha256 + minimalizovaný súhrn), auth tokeny, push tokeny, audio/prepisy. RC: scan routy už nelogujú raw SDK error.
- Zostáva (LOW): `accounting-handoff` loguje `JSON.stringify(problems)`, `lib/intents/invoice-draft.ts` loguje rejection objekt; dev-only logy scan textu; billing/push routy nemajú štruktúrované outcome logy (webhook odmietnutia vidno iba v DB).

## F. Performance

- Zdieľaný layout chunk ≈ 476 KB (neminifikované bajty; Supabase + 3 slovníky i18n) na každej route; prvé načítanie route ≈ 0,94–1,0 MB JS (neskomprimované). `exceljs`/`jszip` sú lazy (932 KB chunk mimo initial). Predplatné pridáva ≈ 26 KB iba na svojej route.
- Opravené merateľné duplicity: DPA + Legal gate (4 → 2 RPC pri každej navigácii, 0 pri token refreshi), subscription polling po odchode zo stránky.
- Odporúčanie (neopravené, mimo scope): lazy-load neaktívnych jazykov slovníka; `usePlanUsage` obchádza zdieľanú entitlement cache (1 RPC na modulovú stránku); FloatingChatWidget (iba web) re-subscribuje realtime kanál pri otvorení panelu; Google JWKS sa sťahuje pri každom RTDN.

## G. Accessibility

- OK: cylinder (reduced-motion zoznam, aria labely ▲/▼, live región, inert karty), tab bar (safe area, aria-expanded), AppDialog (role, Escape/back), FormField (aria-invalid/describedby), delete modal (role=alert chyby), mic (aria-pressed/label, focus-visible).
- RC opravy: chat bublina klávesnicou, labely (login, chat composer, odstránenie prílohy), billing live región + aria-busy + 44 px, error boundary s role=alert.
- Zostáva (neopravené, väčší zásah): focus trap/Escape/návrat fokusu v chat paneli, EntityPicker, ConversationList, delete modale a DocumentModal; Legal/DPA gate bez `role=dialog` + `inert`; login chyby cez `alert()`; dashboard mic 32 px (≥ 24 px WCAG 2.2 AA 2.5.8; 44 px by zmenilo schválený layout).

## H. Store technical readiness (Google Play) — nič nevykonané

1. **Internal Testing AAB**: `release\build-release-aab.ps1` (JDK 21, upload key, versionCode 2, neprepisuje existujúci AAB). Billing OFF build.
2. **Play App Signing**: zapnúť pri prvom uploade (Google drží app signing key; upload key ostáva jediný platný upload key).
3. **App Integrity SHA-256**: Play Console → Test and release → App integrity → App signing key certificate → SHA-256.
4. **assetlinks**: doplniť Play SHA-256 do `public/.well-known/assetlinks.json` (vedľa upload SHA-256) → deploy webu (vyžaduje súhlas) → overiť `https://www.esblu.com/.well-known/assetlinks.json` (200, `application/json`) a `adb shell pm get-app-links com.esblu.app`.
5. **License tester**: Play Console → Settings → License testing → tester účty (iba pre billing ON build v Internal testing).
6. **Subscription product**: produkt + base plany podľa `docs/subscriptions-production-readiness-2026-10-11.md` (product ID = DB `store_product_id`; nič live bez schválenia).
7. **Service account**: Google Cloud SA s Play Developer API (iba View financial data + Manage orders/subscriptions), JSON iba do Vercel env `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (secret), nie do repa.
8. **RTDN**: Pub/Sub topic + push subscription s OIDC na `/api/billing/webhooks/google` (`GOOGLE_RTDN_AUDIENCE`, `GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL`).

## Store policy technical delta (od `google-play-readiness-2026-10-10.md`)

| Oblasť | Zmena |
|---|---|
| Permissions | default build bez zmeny; billing ON + `com.android.vending.BILLING` |
| Billing | nové: Play Billing 9.1.0 (opt-in), Android EEA billing choice → Stripe, iOS EU IAP/External link — všetko vypnuté; server ukladá purchase token **hash**, order/transaction ID, stav predplatného |
| Data types (iba pri zapnutom billingu) | Financial info → **Purchase history** (Collected; Shared iba s providerom ktorý platbu spracoval); Payment info spracúva Stripe/Google/Apple, Esblu ho nevidí |
| Voice | AI-off fallback (bez OpenAI kľúča 503 + lokálny parser), mic gate; typ dát nezmenený (Voice recordings, processed ephemerally) |
| Chat / AI / push | bez zmeny typov dát; push bez obsahu správ |
| Account deletion | in-app flow bez zmeny správania; owner precheck pred mazaním súborov; verejná `/zrusenie-uctu` **stále iba na vetve (produkcia 404)** |
| Error boundary | nezbiera ani neodosiela dáta |

Data Safety formulár sa **nevypĺňa** — toto je iba faktický podklad.

## Account deletion readiness

- In-app: Nastavenia → Zrušiť účet → `/api/account/preflight` → `/api/account/delete`. Owner: fráza, retention blocker (finalizované doklady → 409), **owner_id precheck (RC)**, zber Storage → mazanie Storage → `esblu_owner_delete_company` (transakcia) → `auth.admin.deleteUser` posledné. Člen: iba identita + vlastné nastavenia. Orphan: owner_id check → deleteUser.
- ~~Riziko: súbory zmazané pred DB transakciou~~ → **vyriešené na branchi**: DB najprv (`esblu_account_deletion_commit` + cleanup job), Storage a auth až po commite, retry cron (`docs/account-deletion-subscription-policy-2026-10-12.md` časť 5b). Migrácia `20261012130000` neaplikovaná.
- Verejná `/zrusenie-uctu`: `https://www.esblu.com/zrusenie-uctu` = **404** (commit `4caca14` nie je v `main`).
- Production delta checklist: (1) schváliť merge RC/route do `main`, (2) deploy, (3) overiť 200 SK/EN/DE bez prihlásenia, (4) URL do Play Console „Delete account URL", (5) pred billingom: blocker pre aktívne predplatné.

## Observability

- Error boundaries: pridané (route + global), logujú iba typ + digest.
- API: billing vracia stabilné `ESBLU_BILLING_*` kódy; ostatné preložené správy, žiadne `error.message` ku klientovi.
- Retry stavy: štart, nároky (dashboard + moduly), predplatné, offline banner.
- Crash breadcrumbs: žiadne crash SDK (zámer — Data Safety „App info and performance: Nie").
- Odporúčanie: 1 štruktúrovaný log na výsledok webhooku `{provider, outcome, code}` bez payloadu.

## I. Legal / CLIA blockers

- Privacy policy / `/subprocessors`: Firebase (push), OpenAI (hlas + text asistenta), registre RPO/RÚZ, **Stripe / Google Play / Apple** ako platobní sprostredkovatelia (pri zapnutí billingu).
- Obchodné podmienky predplatného, cenník (plány sú testovacie), odstúpenie od zmluvy / EÚ spotrebiteľské pravidlá, faktúra za predplatné.
- Data Safety odpovede (Shared vs service provider pre OpenAI), IARC.
- eFaktúra / Peppol provider a CLIA delta (mimo RC).

## J. Production blockers

1. Schválenie merge RC → `main` + produkčný deploy (zakázané v tomto bloku).
2. Produkčné DB migrácie subscriptions (4 migrácie + rollback skripty) — iba po schválení. Kód je bez nich bezpečný: pri billing OFF `authorizeBillingCaller` vráti `404 ESBLU_BILLING_DISABLED` ešte pred DB, Predplatné ukáže „disabled", v `vercel.json` nie je žiadny nový cron. Migrácie sú potrebné až pre zapnutie billingu.
3. `/zrusenie-uctu` na produkcii.
4. Android build matrix + Turbopack mobile build + device smoke na Windows kite.
5. Migrácie `20261012120000_account_deletion_subscription_guard` + `20261012130000_account_deletion_post_commit_cleanup` — aplikovať spolu s billing migráciami; texty zrušenia pri predplatnom = LEGAL/CLIA REVIEW REQUIRED.

## K. External provider blockers

Google Play Console (app, App Integrity SHA-256, Internal testing track, license testers, subscription produkty, service account, RTDN), Stripe (účet, live kľúče, webhook — zakázané), Apple (Developer Program, iOS build, App Store Connect, StoreKit produkty, EU external purchase entitlement), FCM produkčná konfigurácia (google-services.json mimo repa), OpenAI produkčný kľúč (voice/AI), eFaktúra provider, reviewer účet (produkčný allowlist — zakázané bez súhlasu).

## Staging smoke (Vercel Preview, read-only)

Preview `dpl_65E69MVmnRpysbxEgwRR6LuPY15N` (`esblu-5xd2lfvqn-esblu.vercel.app`) spárovaný presne so SHA `3ebaf4b` — **READY** (zároveň potvrdzuje Turbopack web build RC).

| Kontrola | Výsledok |
|---|---|
| `GET /api/billing/subscription` | `404 {"code":"ESBLU_BILLING_DISABLED"}` — billing vypnutý, žiadny DB prístup |
| `GET /zrusenie-uctu` | 200, SK text, bez prihlásenia |
| login / dashboard / entitlement RPC / settings / chat / voice AI fallback / push API s tokenom | **nespustené** — žiadne staging prihlasovacie údaje v tomto bloku; pokryté PGlite + kontraktnými testami. Doplniť pri device smoke. |

Žiadny produkčný zápis. Produkcia čítaná iba: `GET https://www.esblu.com/zrusenie-uctu` → 404.

## L. Exact rollout order (návrh, nič nevykonané)

1. Windows kit: Turbopack mobile build + `verify:mobile-bundle`, `build-billing-matrix.ps1` (PASS), device smoke (debug, staging).
2. CLIA: právne texty (privacy, subprocessors, VOP predplatného) → schválenie.
3. Schválenie: merge `preprod-release-candidate` → `main` (bez billing env) → Vercel production READY (párovanie podľa SHA) → smoke www.esblu.com (vrátane `/zrusenie-uctu`).
4. AAB (billing OFF, versionCode 2) → Play Internal testing → App Integrity SHA-256 → assetlinks deploy → App Links overenie.
5. Reviewer účet (demo firma, fiktívne dáta) — so súhlasom.
6. Data Safety + IARC + store listing (podľa CLIA).
7. Billing (samostatne, neskôr): produkčné DB migrácie → Play produkty + SA + RTDN + license testers → `ESBLU_BILLING_STORE_MODE=sandbox` iba na Preview → billing ON AAB do Internal testing → test nákupov → až potom live rozhodnutie (nový kód/migrácia pre `live`).

## Multi-company / workspace model (2026-10-12)

`docs/multi-company-architecture-2026-10-12.md`. Jeden login → N firiem s rôznymi rolami, explicitná a serverom
validovaná aktívna firma (nikdy `LIMIT 1`), prepínač firmy, „Pridať vlastnú firmu", pozvánka pre existujúceho
používateľa, presne 1 owner na firmu, billing authority = owner, odchod ≠ zrušenie firmy ≠ zrušenie loginu.
Migrácie `20261012140000` + `20261012150000` + `20261012160000` pripravené, **neaplikované** (staging ani
produkcia); PGlite `multi-company-db` 39/39, `company-legal-identity` 7/7, kontrakt 16/16, celý regres 75/75 suites.

**Finálne (20261012150000 + 20261012160000):** billing = iba owner (admin/billing.manage, accountant, employee deny;
prepnutie na inom zariadení nič neprenáša); **trial = iba overený právny subjekt** (krajina + normalizované IČO
overené v RPO) — **provizórny trial „1× na login" ODSTRÁNENÝ**; firma bez IČO funguje bez trialu (stav „čaká na
overenie"); IČO sa dá doplniť / overiť kedykoľvek v Nastaveniach → Identita firmy (iba owner; admin/účtovník čítajú);
nedostupný register = opakovateľné, nikdy trial ani vymyslená identita; overené IČO zamknuté; trvalá história
`trial_claims` (hash, bez FK na firmu); existujúce trialy bez zmeny; aktívna firma = per auth session.
Otvorené: CLIA retencia hashovaných `trial_claims` (+ autor faktúr), beta prístup bez IČO = manuálny grant (operátor),
zmena overeného IČO = samostatný postup cez podporu, overenie iba SK, push deep link z inej firmy, zoradenie eFaktúra
migrácií. Poradie migrácií: `docs/multi-company-architecture-2026-10-12.md` sekcia Z.

**Verdikt: READY FOR STAGING MIGRATION — YES** → **APLIKOVANÉ NA STAGING 2026-10-13.**

### STAGING VALIDATION (esblu-test `cjbdijbbcujvmrzezusd`) — PASS

Aplikované po jednej: `20261012120000`, `20261012130000`, `20261012140000`, `20261012150000`, `20261012160000`
(preskočené už aplikované `20261008120000`, `20261008130000`, `20261011120000`, `20261012090000`, `20261012091000`).
Schéma: 62/62 funkcií zhodných s repom (md5 prosrc). Owner invariant 7/7 (2 eInvoice E2E fixtures bez ownera
opravené so súhlasom). Dáta zachované (firmy, členstvá, trialy — identický fingerprint, granty, faktúry, eInvoice,
storage). QA: per-session izolácia, session security, RLS matica 9 tabuliek × 4 smery, owner-only billing (5 rolí +
cross-company), legal identity / trial, **skutočný paralelný race (2 backendy, 1 claim)**, normalizácia, Nastavenia,
druhá firma, pozvánka, odchod, zrušenie účtu + predplatné, hlas, nároky, eInvoice readiness. QA fixtures odstránené.
Súbory / signed URL: **NON-AUTHORITATIVE UNTIL STAGING MEDIA BASELINE IS ALIGNED** (staging nemá
`20261005090000`, `20261005091000`, `20261001130000`). Detail: `docs/multi-company-architecture-2026-10-12.md` → STAGING VALIDATION.

## Go / No-Go matrix

| Oblasť | Stav |
|---|---|
| web | PASS |
| mobile | PASS WITH EXTERNAL BLOCKER (Windows Turbopack build + device smoke) |
| auth | PASS |
| dashboard | PASS |
| voice | PASS WITH EXTERNAL BLOCKER (OpenAI prod kľúč; device mic test) |
| push | PASS WITH EXTERNAL BLOCKER (FCM prod config, device test) |
| files | PASS |
| account deletion | PASS WITH EXTERNAL BLOCKER (`/zrusenie-uctu` 404 na produkcii do deployu) |
| subscriptions | PASS WITH EXTERNAL BLOCKER (vypnuté; prod migrácie neaplikované) |
| Google Billing | BLOCKED EXTERNAL |
| Stripe | BLOCKED EXTERNAL |
| Apple | BLOCKED EXTERNAL |
| eInvoice | BLOCKED EXTERNAL (mimo RC; provider + CLIA) |
| Google Play | BLOCKED EXTERNAL |
| privacy | BLOCKED LEGAL |
| Data Safety | BLOCKED LEGAL |
| reviewer access | BLOCKED EXTERNAL (vyžaduje súhlas na produkčný účet) |
| multi-company | STAGING PASS (120000–160000 na esblu-test; produkcia neaplikovaná; media baseline stagingu + real-device smoke + CLIA retencia otvorené) |
| production rollout | BLOCKED LEGAL (CLIA) + čaká na explicitný súhlas |
