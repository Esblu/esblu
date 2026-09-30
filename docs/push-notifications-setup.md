# Push notifikácie — architektúra a manuálne kroky (2026-10-01)

Stav: kód a migrácie pripravené lokálne. **Nič z toho nie je v produkcii** — migrácie nie sú aplikované, FCM/APNs kľúče nie sú nastavené.

## Architektúra

| Vrstva | Súbor | Úloha |
| --- | --- | --- |
| DB tabuľky | `supabase/migrations/20260927110000_push_notifications.sql` | `push_subscriptions` (web), `notification_preferences`, `notification_deliveries` |
| DB natívne + RPC | `supabase/migrations/20261001130000_push_devices_session_binding.sql` | `push_devices` (FCM/APNs), väzba na auth session, jazyk, RPC |
| Abstrakcia | `lib/push/providers/*`, `lib/push/dispatch.ts`, `lib/push/server.ts` | Web Push / FCM HTTP v1 / APNs za jedným `PushProvider` rozhraním |
| Deep link | `lib/push/deep-link.ts`, `public/sw.js` | allowlist obrazoviek (`screen` + UUID), nikdy URL |
| Obsah | `lib/push/routing.ts` | text v jazyku zariadenia príjemcu (sk/de/en), príjemcovia podľa rolí |
| API | `app/api/push/{subscribe,devices,preferences,chat-message}`, `app/api/cron/deadline-notifications` | registrácia, odhlásenie, predvoľby, Human Chat push, termíny |
| Klient | `lib/push/client.ts` (web + delegovanie), `lib/push/native.ts` (iba mobil), `mobile/app/PushBridge.tsx`, `app/components/push/PushRegistrationSync.tsx` | zapnutie z Nastavení, obnova po prihlásení, kliknutie na notifikáciu |

### Bezpečnostný model

- Registrácia ide cez RPC **ako prihlásený používateľ**: `user_id = auth.uid()`, `company_id = esblu_my_active_company_id()`, `auth_session_id = JWT session_id`. Z tela sa berie iba token, platforma, installationId a jazyk.
- Cudzí aktívny token sa neprevezme (`409`); výnimka je tá istá inštalácia appky (prepnutie účtu na zariadení). Web endpoint iného aktívneho používateľa sa neprevezme nikdy.
- Doručuje sa iba zariadeniam: nezrušeným, so **živou auth session** (`auth.sessions`), s **aktívnym členstvom v tej istej firme**. Odhlásenie, „odhlásiť všade", reset hesla aj odobratie z firmy doručovanie okamžite zastavia.
- Tabuľky nemajú priamy prístup pre `anon`/`authenticated`; serverové RPC (`esblu_push_delivery_targets`, `esblu_push_chat_recipients`, `esblu_push_record_outcome`, `esblu_push_revoke_ended`, `esblu_push_companies_with_targets`) má iba `service_role`.
- Human Chat push: príjemcovia podľa M1 modelu (`esblu_push_chat_recipients` = zrkadlo `esblu_chat_can_access_conversation`), každá rola vrátane zamestnanca. AI asistent oprávnenia sa nepoužívajú.
- Termíny: iba owner a admin (prevádzkové termíny firmy).
- Neplatný token (FCM `UNREGISTERED`/404/`SENDER_ID_MISMATCH`, APNs 410/`BadDeviceToken`, Web Push 404/410) sa zruší (`revoke_reason = invalid_token`).

### Prečo `@capacitor/push-notifications`

Oficiálny plugin Capacitor tímu (Ionic/OutSystems, `ionic-team/capacitor-plugins`), verzia 8.1.2 s `peerDependencies @capacitor/core >=8.0.0` — rovnaká major verzia ako zvyšok appky (`@capacitor/core` 8.5). Android dáva FCM token (firebase-messaging 25.x), iOS natívny APNs token — preto server hovorí s FCM aj APNs priamo a nepotrebujeme Firebase SDK na iOS. Komunitné pluginy (`@capacitor-firebase/messaging`) by pridali Firebase aj na iOS bez potreby.

## Čo musíš urobiť ručne (Firebase / Google / Apple)

### Android (FCM)

1. Firebase Console → vytvor/zvoľ projekt → **Add app → Android**, package `com.esblu.app`.
2. Stiahni `google-services.json` a vlož ho do `mobile/android/app/google-services.json` (Gradle ho už podmienene aplikuje). Rozhodni, či ho verzovať (nie je tajný, ale je projektovo špecifický).
3. Firebase Console → Project settings → **Service accounts → Generate new private key**. Do Vercel (projekt `esblu`, Production — **nie** `NEXT_PUBLIC_`):
   - `FCM_PROJECT_ID`
   - `FCM_CLIENT_EMAIL`
   - `FCM_PRIVATE_KEY` (PEM; `\n` sú povolené)
4. Lokálne: `npm install` (doplní `@capacitor/push-notifications` do node_modules), `npm run build --workspace mobile`, `cd mobile && npx cap sync android`.

### iOS (APNs) — projekt ešte neexistuje

1. Na Macu: `cd mobile && npx cap add ios`, otvor v Xcode.
2. Signing & Capabilities → **Push Notifications** (+ Background Modes → Remote notifications, ak bude treba).
3. `AppDelegate.swift` — podľa dokumentácie pluginu pridaj `didRegisterForRemoteNotificationsWithDeviceToken` / `didFailToRegisterForRemoteNotificationsWithError` (posielajú `capacitorDidRegisterForRemoteNotifications`).
4. Apple Developer → Keys → nový kľúč s **APNs** → stiahni `.p8`. Do Vercel:
   - `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` (obsah .p8)
   - `APNS_BUNDLE_ID` (predvolene `com.esblu.app`)
   - `APNS_ENVIRONMENT` = `production` (TestFlight/App Store) alebo `development` (Xcode debug)
5. `lib/cors.ts` už povoľuje `capacitor://localhost`.

### Web Push (ak ešte nie je)

`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, voliteľne `VAPID_SUBJECT`; cron potrebuje `CRON_SECRET` (≥ 16 znakov).

## Produkčný apply (iba po schválení)

Poradie cez Supabase MCP `apply_migration` na `assetpilot` / `fkpgvgvsmbpieduoatrt`:

1. `20260927110000_push_notifications.sql`
2. `20261001130000_push_devices_session_binding.sql`

Po apply: `scripts/sql/push-oauth-hardening-matrix.sql` (časť A), advisors (security + performance), smoke test `/api/push/devices` a `/api/push/subscribe` s reálnym tokenom.

## Testy

- `npm run test:push` — deep link (TS aj `sw.js`), jazyk, poskytovatelia s podvrhnutým transportom a skutočnými podpismi, doručovanie, roly, invarianty kódu.
- `npm i --no-save @electric-sql/pglite@0.5.8 && npm run test:push-db` — PostgreSQL matica: owner/admin/accountant/employee/neaktívny/cudzia firma, session, členstvo, idempotencia, token refresh, multi-device, Human Chat príjemcovia.
- `npm run test:master-control` — pôvodné push/OAuth kontroly (aktualizované).

## Otvorené

- Retencia `notification_deliveries` (čistenie > 400 dní) — neschválená deštruktívna úloha.
- UI pre predvoľby (API `/api/push/preferences` je pripravené).
- Deduplikácia sa zapíše pred odoslaním: pri dočasnej chybe poskytovateľa sa tá istá udalosť už nezopakuje (zámerne — radšej žiadna než dvojitá notifikácia).
