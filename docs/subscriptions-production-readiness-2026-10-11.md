# Subscriptions / Payments — production readiness (2026-10-11)

Vetva `subscriptions-platform` (nad `main` 901c46c). Stav: **test-ready, nič live**.
Žiadna migrácia nie je aplikovaná v žiadnej databáze (ani staging). Žiadny Stripe/Google/Apple
live účet, produkt ani secret nebol vytvorený ani použitý.

Súvisiace: `subscriptions-architecture-2026-10-08.md`, `subscriptions-mobile-purchase-2026-10-08.md`,
`subscriptions-store-compliance-2026-10-08.md`, `subscriptions-gdpr-provider-delta-2026-10-08.md`.

---

## 1. Princíp

**Kúpiš kdekoľvek, používaš všade.** Jediný zdroj pravdy o predplatnom a nárokoch je DB
(`subscription_accounts` + `company_entitlements`). Stripe, Google Play a App Store sú iba
billing provideri. Klient nikdy nerozhoduje o nároku — iba zobrazuje, čo vráti server.

```
provider event / store token
  → verify (podpis / OIDC / JWS / Play API)       lib/billing/providers/*, lib/billing/stores/*
  → record_event (unique provider+env+event_id, sha256 payload check)
  → normalize → kanonický stav                     lib/billing/canonical-state.ts
  → apply_event (advisory lock, poradie provider_state_at, terminal guard,
                 cross-tenant guard, 1 firma = 1 otvorené predplatné)
  → sync_entitlements → company_entitlements (source=subscription)
  → esblu_get_my_company_entitlements (dashboard, locked moduly — nezmenený kontrakt)
```

## 2. Databáza

| Migrácia | Obsah |
|---|---|
| `20261008120000_subscriptions_platform.sql` | plány, ceny providerov, účty, eventy, checkout/purchase intents, kanály podľa platformy/storefrontu, store reporting outbox, RPC |
| `20261011120000_subscriptions_lifecycle_hardening.sql` | kanonické stavy, grace/hold/refund/revoke, `review_flag`, reconciliation (tabuľka + RPC), explain RPC, ops RPC, cross-provider `purchase_options`, opravy (nižšie) |

Obe sú forward-only a idempotentné (re-run testovaný). Rollback skripty sú v `supabase/rollback/` — iba
na staging a vždy zachovajú `billing_events` / účty (testované). `billing_runtime_config.environment`
má check `= 'test'`: live sa v DB zapnúť nedá bez novej migrácie.

**Opravené chyby nájdené testami v tomto bloku:**
1. Druhé predplatné od **toho istého** providera (napr. dva Stripe checkouty) obišlo konflikt — `NOT (x = NULL)` je v SQL `NULL`. Teraz `coalesce(..., false)` → `conflict`, žiadne dvojité účtovanie.
2. `esblu_billing_explain_my_entitlements` padal pre firmu bez grantov (nová firma v triale).
3. `reconcile_requeue` nevrátil dead-letter účet do fronty (ostal filtrovaný podľa `last_checked_at`).
4. Server by acknowledgoval Play nákup v stave `PENDING` — teraz iba zaplatený (entitling) nákup.

## 3. Kanonické stavy a mapovanie providerov

| Kanonický | Otvorený | Nárok | Terminálny |
|---|---|---|---|
| pending, incomplete | áno | nie | — |
| trialing, active | áno | áno (do konca obdobia + 2 dni buffer) | — |
| grace_period | áno | áno do `grace_until` (store grace) | — |
| past_due | áno | áno do `grace_until` (Stripe: 7 dní) | — |
| account_hold, unpaid, paused | áno | **nie** | — |
| canceled, expired, refunded, revoked | nie | **nie** | áno — neskorší event ten istý sub neoživí (`TERMINAL_STATE`) |

| Provider | Mapovanie (lib/billing/canonical-state.ts) |
|---|---|
| Stripe | incomplete→pending, incomplete_expired→expired, unpaid→account_hold, ostatné 1:1; úplný refund→refunded; dispute lost→revoked; dispute open→`review_flag` |
| Google | PENDING→pending, IN_GRACE_PERIOD→grace_period, ON_HOLD→account_hold, PAUSED→paused, CANCELED→active+cancel_at_period_end (alebo expired), EXPIRED→expired; RTDN 12→revoked; voided purchase→refunded |
| Apple | DID_FAIL_TO_RENEW/GRACE_PERIOD→grace_period, DID_FAIL_TO_RENEW→account_hold, GRACE_PERIOD_EXPIRED→account_hold, REFUND→refunded, REVOKE→revoked, EXPIRED→expired; Server API status 1–5 pre reconciliation |

Plán sa určuje **iba** server-side mapou `billing_provider_prices` (price/product → plan_code). Klient nikdy neposiela price ID.

## 4. Nároky (entitlements)

- Boolean aj kvantitatívne (`limit_value`, `limit_period`) z `subscription_plan_entitlements`.
- Zdroje: plán (subscription), manuálny grant, beta grant, implicitný 14-dňový trial (výpočet, nie zápis).
- `valid_from` / `valid_until`, revoke = `status='revoked'` (riadok sa nemaže).
- Priorita: aktívny grant > trial okno; zrušené predplatné počas trialu → späť na trial.
- Downgrade odvolá nároky mimo plánu, dáta modulu ostávajú.
- **Explain:** `esblu_billing_explain_my_entitlements()` / `GET /api/billing/entitlements` — pre každý kľúč
  active, source, reason, limit, platnosť, `explanation` (trial_window / subscription_<stav> / manual_grant /
  beta_grant / not_entitled), `managed_via`. Referencia a provider iba pre owner / billing.manage / finance view.
- Dashboard (`esblu_get_my_company_entitlements`) nezmenený — kontrakt test v `subscription-cross-device` a `entitlement-resolution`.

## 5. Cross-store / buy anywhere

- `purchase_options(platform, storefront)` vracia `current {status, managed_via, manage_here, cancel_at_period_end}`,
  `purchase_allowed`, `blocked_reason=ALREADY_SUBSCRIBED`; pri otvorenom predplatnom nie sú žiadne nákupné metódy.
- `create_purchase_intent` / `create_checkout_intent` pri otvorenom predplatnom → `ESBLU_BILLING_ACTIVE_ON_OTHER_PROVIDER` / `ALREADY_SUBSCRIBED`.
- Ak store/webhook UI obíde, `apply_event` → `conflict` (žiadny druhý nárok; event pre operátora).
- Správa: Stripe/fake iba na webe; Google iba na Androide; Apple iba na iOS. Inde UI ukáže
  „Predplatné spravujete cez web / Google Play / App Store" (`subscription.managedVia.*`, SK/EN/DE).
- Upgrade/downgrade iba v tom istom obchode (`mode=change`, Play `oldPurchaseToken` / StoreKit skupina).

## 6. Idempotencia a súbežnosť

- Webhook: unique `(provider, environment, provider_event_id)` + sha256 payloadu (iný obsah s rovnakým ID = odmietnuté).
- Store token: deterministické event ID `client:google:<sha256(token)>:<status>` → 10× ten istý token = 1 nárok.
- `apply_event` a `create_purchase_intent`: `pg_advisory_xact_lock(company)` + `for update`.
- Poradie: `provider_state_at` (Stripe = čas re-fetchu z API, nie čas eventu); starší stav = `stale`.
- Testy: 10× sekvenčne, 10× súbežne, payload mismatch, out-of-order, dve rôzne predplatné súbežne.
- Obmedzenie: PGlite má jedno spojenie (transakcie serializované) — DB zámky sú overené štrukturálne; skutočný
  multi-connection stres test patrí na staging Postgres (rollout krok 4).

## 7. Reconciliation

- `esblu_billing_reconcile_candidates(limit)`: otvorené predplatné + terminálne < 30 dní; nekontrolované 24 h alebo blízko konca obdobia.
- Drift (stav / koniec obdobia / cancel príznak) → oprava **tou istou pipeline** (`esblu.sync.reconcile` event).
- Chyba → backoff 15 min · 2^(n−1), max 24 h; po 8 chybách dead-letter; `reconcile_requeue` po oprave.
- `GET /api/cron/billing-reconcile` (CRON_SECRET, iba počty). **Nie je vo `vercel.json`** — žiadny produkčný cron.
- Zdroje: Stripe/fake `getSubscription`, Google `subscriptionsv2`, Apple Get All Subscription Statuses (+ JWS verify).

## 8. Refund / chargeback / revoke

- Okamžité odvolanie nároku; `subscription_accounts`, `billing_events`, `billing_store_reports` sa **nikdy nemažú**.
- Čiastočný refund = iba účtovný záznam (charge), bez zmeny nároku.
- Dispute: `review_flag=dispute_open` (prístup ostáva do rozhodnutia), lost → revoked, won → príznak zmazaný.
- Po refunde/revoke je nový nákup povolený (nové predplatné, nové ID).

## 9. Bezpečnosť a roly

- Kupovať / meniť: owner, admin s `permissions.billing.manage`. Detaily: + finance view. Employee: iba stav a nároky.
- RLS je finálna autorita: klient nemá prístup k žiadnej billing tabuľke; service RPC iba `service_role`.
- Provider režimy `disabled | fake | sandbox | live`: default disabled, `live` → disabled + `LIVE_NOT_APPROVED`,
  `VERCEL_ENV=production` → vždy disabled (`lib/billing/config.ts`, `store-config.ts`, `provider-modes.ts`).
- `validateBillingEnv` vracia iba názvy premenných, `sk_live_` = chyba. Žiadny billing secret nie je `NEXT_PUBLIC_*`.
- Logy/ops: bez payloadov, bez customer ID; eventy referencované sha256 prefixom.

### Env schéma (iba názvy)

| Premenná | Secret | Potrebná pre |
|---|---|---|
| ESBLU_BILLING_MODE / ESBLU_BILLING_STORE_MODE | nie | režim (default vypnuté) |
| ESBLU_FAKE_BILLING_SECRET | áno | fake |
| ESBLU_BILLING_RETURN_ORIGIN | nie | web checkout |
| STRIPE_SECRET_KEY (iba `sk_test_`/`rk_test_`), STRIPE_WEBHOOK_SECRET, STRIPE_API_VERSION | áno/áno/nie | Stripe sandbox |
| GOOGLE_PLAY_PACKAGE_NAME, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, GOOGLE_RTDN_AUDIENCE, GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL | nie/áno/nie/nie | Google sandbox |
| APPLE_BUNDLE_ID, APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID, APPLE_IAP_PRIVATE_KEY, APPLE_ROOT_CA_SHA256 | nie/nie/nie/áno/nie | Apple sandbox |
| CRON_SECRET | áno | reconciliation / store reporting |

## 10. Klienti

- **Web:** `/nastavenia/predplatne` (za `NEXT_PUBLIC_ESBLU_BILLING_UI=1`), checkout cez server intent, návrat ≠ potvrdenie (polling servera).
- **Android:** natívny plugin `EsbluBilling` (Java) na vetve `subscriptions-mobile-integration`, kompiluje sa iba s
  `-PesbluBilling=true` (Play Billing Library 9.1.0). Default build je bez knižnice a bez `BILLING` povolenia.
  Výsledky: play / pending / canceled / already_owned / billing_unavailable / error. Plugin neacknowledguje — server áno.
  Billing choice (EEA) zámerne **nie je zapojený** (`BILLING_CHOICE_NOT_WIRED`).
- **iOS:** StoreKit 2 plugin je iba referenčný Swift (bez Macu/Xcode nekompilovaný, nezapojený).

## 11. Testy (všetky PASS 2026-10-11)

| Suite | Počet | Spustenie |
|---|---|---|
| subscriptions (unit, existujúce) | 28 | `npm run test:subscriptions` |
| subscriptions-db (PGlite, existujúce) | 60 | `npm run test:subscriptions-db` |
| subscriptions-lifecycle (unit) | 43 | `npm run test:subscriptions-lifecycle` |
| subscriptions-lifecycle-db (PGlite) | 49 | `npm run test:subscriptions-lifecycle-db` |
| native-billing-contract (integračná vetva) | 11 | `npm run test:native-billing-contract` |

Pomenované suity (`npm run test:<meno>`): subscription-domain, entitlement-resolution, cross-provider,
stripe-adapter, google-play-adapter, apple-adapter, webhook-idempotency, purchase-idempotency, reconciliation,
subscription-rbac, subscription-rls, subscription-migrations, subscription-concurrency, subscription-trial,
subscription-refund-revoke, subscription-cross-device. PGlite: `npm i --no-save @electric-sql/pglite@0.5.8`.

### Failure matrix (pokryté testami)

| Zlyhanie | Správanie |
|---|---|
| Neplatný podpis / OIDC / JWS | 4xx `rejected`, nič sa nezapíše |
| Live event / live token v test režime | `LIVE_MODE_FORBIDDEN` |
| Výpadok DB pri record_event | `retry` (5xx), nič nezapísané |
| Výpadok DB pri apply_event | `retry`; opakované doručenie → `applied` |
| Provider API 5xx / timeout | `retry` (webhook) / reconciliation `error` + backoff |
| Neznáma cena / neznáma firma | `failed_permanent`, žiadny nárok |
| Cudzí token / cudzí identifikátor | `CROSS_TENANT_IDENTIFIER`, žiadny nárok |
| Druhé predplatné (iný alebo ten istý provider) | `conflict`, žiadny druhý nárok |
| Starý / neskorý event | `stale` / `TERMINAL_STATE` |
| Pending nákup | bez nároku, bez acknowledge, nákup blokovaný |
| Provider nenakonfigurovaný | reconciliation `skipped` |

## 12. Otvorené právne a účtovné body (BLOCKED LEGAL — CLIA)

Tento dokument **nerobí** právne tvrdenia. Pred akýmkoľvek live predajom musí CLIA / účtovník rozhodnúť:

- merchant of record pre každý kanál (Esblu cez Stripe vs. Apple/Google ako predajca),
- doklady: faktúra / opravný doklad z našej strany vs. potvrdenia obchodov (Apple/Google),
- DPH: B2B (reverse charge, IČ DPH) vs. B2C, OSS, evidencia miesta plnenia (EU VAT evidence),
- ceny s/bez DPH v UI pre každý kanál, zobrazenie cien obchodov,
- refund policy a podmienky predplatného vo VOP; texty „spravujete cez…" a zrušenie,
- GDPR: provideri ako sprostredkovatelia / samostatní prevádzkovatelia (delta dokument z 2026-10-08),
- vzťah k eInvoice (zmrazené — žiadne zmeny).

## 13. Readiness matrix

| Oblasť | Stav |
|---|---|
| Kanonický model + migrácie (PGlite) | READY |
| Entitlement engine + explain + dashboard kontrakt | READY |
| Idempotencia / poradie / konflikty | READY — vrátane multi-connection testu na stagingu (15.3) |
| Refund / dispute / revoke | READY |
| Reconciliation (kód + RPC + route) | READY · scheduling NOT STARTED (zámerne) |
| Fake provider end-to-end | READY |
| Stripe test adapter | READY (mock) · reálny test účet BLOCKED EXTERNAL |
| Google server (RTDN, subscriptionsv2, acknowledge) | READY (fake API) · service account + produkty BLOCKED EXTERNAL |
| Google client plugin (Java) | PARTIAL — kontrakt testovaný (11), build kit + matrix skript hotové, kompilácia čaká na PC, billing choice nezapojený |
| Apple server (JWS, ASN V2, Server API) | READY (fake) · kľúče + produkty BLOCKED EXTERNAL |
| Apple client (StoreKit 2) | PARTIAL — iba referenčný Swift, bez Macu |
| Web UI predplatného | READY (za flagom) |
| Mobile UI (managed via, pending, already owned, restore) | READY |
| Staging DB aplikácia migrácií | READY — 4 migrácie na esblu-test, RLS/RBAC, concurrency, reconciliation, E2E overené (sekcia 15) |
| Ceny / DPH / doklady / VOP | BLOCKED LEGAL |
| Produkčná aktivácia | BLOCKED — explicitný súhlas vlastníka |

## 14. Rollout (16 krokov) — NIČ z toho nie je vykonané

Každý krok s „súhlas" vyžaduje explicitné schválenie vlastníka v chate.

1. CLIA / účtovník uzavrie bod 12 (MoR, DPH, doklady, VOP, refund policy).
2. Finálne plány a ceny (SK/EN/DE texty, s/bez DPH) — produktové rozhodnutie.
3. Aplikovať obe migrácie na **staging** (`esblu-test`) — súhlas so staging zápisom.
4. Staging: fake režim end-to-end (web + Android fake bridge) + multi-connection stres test idempotencie.
5. Stripe **test** účet: produkty/ceny v test mode, webhook endpoint na staging, `STRIPE_*` iba do staging env — súhlas, secrets zadáva vlastník priamo vo Verceli.
6. Staging Stripe test checkout/portal/cancel/refund/dispute podľa failure matrix; reconciliation ručne cez route.
7. Play Console: subscription produkty + base plany (draft), license testers, RTDN Pub/Sub topic, service account s minimálnymi právami — súhlas (vytváranie Play produktov).
8. Android build s `-PesbluBilling=true` na PC (JDK 21), internal testing track, test nákupy (license tester): purchase, pending, cancel, restore, upgrade, grace/hold (test karty).
9. Rozhodnutie o EEA billing choice programe; až potom zapojiť `BillingProgram` API (overiť voči aktuálnej knižnici).
10. App Store Connect: subscription group + produkty, App Store Server Notifications V2 (sandbox URL), In-App Purchase key — súhlas; StoreKit plugin skompilovať na Macu, sandbox testy.
11. Apple EU / US link-out iba ak právne schválené (entitlement, oznámenia, reporting).
12. Zapnúť scheduled reconciliation na **staging** (cron) a sledovať dead-letter.
13. Observability: alerty na `failed_permanent`, `conflict`, dead-letter, store report chyby.
14. Nová migrácia povoľujúca `environment='live'` + kód live režimu + review — súhlas.
15. Produkčný deploy + produkčné secrets + produkčná migrácia — súhlas (každé zvlášť).
16. Live aktivácia po kanáloch (najprv web, potom Android, potom iOS), postupne, s plánom rollbacku (kill-switch `web_provider='none'` / `enabled_methods`).

---

## 15. STAGING VALIDATION (2026-10-11)

Cieľ: **esblu-test** (`cjbdijbbcujvmrzezusd`, ACTIVE_HEALTHY, Postgres 17.6). Produkcia (`fkpgvgvsmbpieduoatrt`) sa **nepoužila**.

### 15.1 Migrácie (staging only, po jednej, s overením)

| Poradie | Migrácia | Stav |
|---|---|---|
| 1 | `20261008120000_subscriptions_platform` | aplikovaná |
| 2 | `20261011120000_subscriptions_lifecycle_hardening` | aplikovaná |
| 3 | `20261012090000_subscriptions_event_token_redaction` (nová — nález 15.6) | aplikovaná |
| 4 | `20261012091000_subscriptions_purchase_options_owned_methods` (nová — regresia zmeny plánu) | aplikovaná |

Pred aplikovaním: snapshot metadát (migration history, 74 tabuliek / 200 funkcií, počty riadkov, 4 manuálne granty,
RLS/indexy `company_entitlements`, md5 resolvera). Plný `pg_dump` z tohto prostredia nebol možný (iba SQL cez MCP) —
platformová záloha Supabase je fallback. Závislosti overené: `esblu_resolve_entitlement` a
`esblu_get_my_company_entitlements` sú na stagingu **bajtovo zhodné** s testovanou verziou.

Ekvivalencia s repom: odtlačok katalógu (funkcie + konfigurácia, stĺpce/defaulty/RLS, 84 constraintov, indexy, granty)
po migrácii 2 je **identický** s PGlite referenciou z repa; migrácie 3 a 4: md5 zdroja funkcie = repo.

### 15.2 Schéma / RLS / RBAC (reálne `authenticated` sessions na stagingu)

| Rola | Stav predplatného | Nákup / správa | Provider detaily | Tabuľky / service RPC |
|---|---|---|---|---|
| owner | áno | povolené | áno | permission denied |
| admin + `billing.manage` | áno | povolené | áno | permission denied |
| admin bez `billing.manage` (finance view) | áno | FORBIDDEN | áno (view) | permission denied |
| accountant | áno | FORBIDDEN | áno (view) | permission denied |
| employee | áno (bez provider polí) | FORBIDDEN | nie | permission denied |
| iná firma | — | `found:false` (bez oracle) | — | permission denied |
| anon | permission denied na všetky billing RPC a tabuľky | | | |

Nikto z klientov nevie zapísať `company_entitlements` (self-unlock). Advisors: žiadny ERROR; INFO „RLS bez policy“
(zámerne deny-all) a WARN „security definer executable“ iba pre zamýšľané klientske RPC s rolovou bránou.

### 15.3 Multi-connection concurrency (skutočné paralelné Postgres backendy)

Metóda: dblink fan-out na N samostatných backendov (dočasná staging rola s heslom cez TLS, zdieľaná bariéra
`pg_sleep_until`); každý backend = `record_event` tx → commit → `apply_event` tx → commit (rovnako ako server).

| Test | Backendy | Rozptyl | Výsledok |
|---|---|---|---|
| A rovnaký event 10× | 10 | record 46 ms / apply 24 ms | 1× applied, 9× duplicate, 1 event, 1 účet, 7 nárokov |
| B rovnaký Google token 10× | 10 | 32 ms / 24 ms | 1× applied, 9× duplicate, 1 účet |
| C dve súbežné aktivácie (2 manažéri, web + Google) | 2 | 6 ms | oba zámery vzniknú (zámer ≠ predplatné); dokončenie: 1 applied, 1 `conflict` |
| D dve predplatné toho istého providera | 2 | 0 ms | 1 applied, 1 `conflict/SECOND_ACTIVE_SUBSCRIPTION` |
| E cross-provider (web + Google) | 2 | 0 ms | 1 applied, 1 `conflict` |
| F cancel + renew race | 2 | — | finálny stav = najnovší snapshot providera |
| G stale po novšom | 2 + 1 | — | neskorší starší snapshot = `stale`; finál = najnovší |

### 15.4 Reconciliation (fake provider snapshot, bez live API, cron nenasadený)

Drift (`revoked`) → opravené tou istou pipeline, 7 nárokov odvolaných, 1 riadok/kľúč; neskorý `active` →
`stale/TERMINAL_STATE` (žiadne oživenie); in_sync/corrected → ďalšia kontrola o 24 h; backoff
15→30→60→120→240→480→960→1440 min, dead-letter po 8, requeue vráti do fronty; podvrhnutý kód chyby → `INVALID_ERROR_CODE`.

### 15.5 Entitlement E2E (dashboard RPC `esblu_get_my_company_entitlements`)

pred nákupom (voice OFF, ai_documents trial 5) → fake web nákup (voice ON zo subscription, ai_documents 200; Android:
„spravujete cez web“, žiadny nákup) → cancel na konci obdobia (stále ON) → expirácia (voice OFF, ai_documents späť trial 5)
→ Google nákup (spravuje sa na Androide) → store revoke (RTDN 12) (voice OFF, explain `not_entitled`).
Employee vidí v každom kroku identické nároky ako owner.

### 15.6 Bezpečnosť

- Klient nevidí provider identifikátory, tokeny ani surové eventy (subscription / explain / options / ops overené).
- Žiadne `console.*` v billing kóde; žiadny billing secret v `NEXT_PUBLIC_*`; `service_role` iba v `lib/supabase-admin.ts`.
- **Nález + oprava:** `billing_events.summary.subscription` obsahoval celý Google purchaseToken → migrácia
  `20261012090000` (trigger: `sha256:<24 hex>`), 5 riadkov redigovaných, overené aj na novom evente. Token ostáva iba
  v `billing_provider_links` (potrebný na overenie u Google).
- **Nález + oprava (fail closed):** server mohol ponúknuť Play/StoreKit kanál, aj keď obchody na serveri nie sú zapojené
  (`ESBLU_BILLING_STORE_MODE=off`) → `lib/billing/server-gates.ts` filtruje `purchase-options` a odmietne
  `purchase-intent` (`ESBLU_BILLING_PROVIDER_NOT_CONFIGURED`) ešte pred zápisom do DB.
- **Regresia + oprava:** pri otvorenom predplatnom `purchase_options` nevracal žiadne kanály → UI neponúklo zmenu plánu.
  Migrácia `20261012091000`: iba kanály providera-vlastníka a iba na jeho platforme; druhý nákup stále blokovaný.

### 15.7 Cleanup

QA dáta (12 firiem `QA-SUBS *`, 18 používateľov `qa-subs-*@example.invalid`, ich eventy/účty/väzby/zámery/nároky),
QA schéma `qa_subs`, dočasná rola `qa_subs_runner` a rozšírenie `dblink` **odstránené**. `billing_runtime_config` vrátený na
`web_provider='none'`, `enabled_methods={stripe_web_checkout}`. Stav po cleanup = baseline: 7 firiem, 9 členstiev,
4 pôvodné manuálne granty (ID overené), billing tabuľky prázdne. Ostali iba seed dáta migrácií (2 test plány, 12 test cien,
7 pravidiel kanálov, regióny EU27/EEA) — sú súčasťou migrácie, `test_fixture`, bez live cien.

### 15.8 Android native billing

Integračná vetva `subscriptions-mobile-integration`: Java plugin `EsbluBilling` (Play Billing 9.1.0) za `-PesbluBilling=true`.
Kit: `C:\Users\roiaj\assetpilot\Claude outputs\esblu-subscriptions-integration` (čerstvý web bundle + `cap sync android`,
staging backend, iba anon kľúč, `android-prebuild-check --target staging` všetko OK vrátane živej sondy cez prehliadač).
Kompilácia: `release\build-billing-matrix.ps1` (JDK 21) — build A bez billingu, build B s billingom, overenie závislosti,
triedy pluginu a diffu manifestu (očakávané: B pridá iba `com.android.vending.BILLING`, žiadny nový exportovaný komponent).
**Kompilácia beží na PC používateľa** (sandbox nemá Android SDK ani prístup na Maven/Gradle).

### 15.9 Rollback / bezpečné vypnutie (bez deštruktívneho DB rollbacku)

| Situácia | Postup |
|---|---|
| Vypnúť billing okamžite | server: `ESBLU_BILLING_MODE` / `ESBLU_BILLING_STORE_MODE` zmazať (= `off`, routy vrátia 404); DB: `update billing_runtime_config set web_provider='none', enabled_methods=array['stripe_web_checkout']` |
| Zastaviť príjem provider eventov | webhook routy pri `off` vracajú 404 (Stripe/Apple/Google eventy sa neprijmú; provider ich doručí znova neskôr); RTDN subscription v Pub/Sub pozastaviť |
| Odvolať testovacie granty | `update company_entitlements set status='revoked' where source in ('manual','beta_compat') and note like 'QA%'` (riadky sa nemažú) |
| Rollback kódu | revert commitu na vetve / redeploy predchádzajúceho Preview; produkcia sa netýka (billing je v produkcii vypnutý kódom) |
| DB migrácie | **nevraciať deštruktívne**; preferovať forward-fix. Rollback skripty v `supabase/rollback/` iba na staging a iba ak treba — nikdy nemažú `billing_events`, účty ani store reporty |

### 15.10 Ďalšie externé požiadavky (presne)

1. Spustiť `release\build-billing-matrix.ps1` na PC → poslať `billing-matrix\report.txt` (bez APK).
2. Pre test UI s fake nákupmi na zariadení: Preview backend s billing routami (vetva `subscriptions-mobile-integration`),
   `ESBLU_BILLING_MODE=fake` + `ESBLU_FAKE_BILLING_SECRET` v **Preview** env a doména/prístup pre appku
   (napr. ako `mobile-staging.esblu.com`) — vyžaduje súhlas (Vercel konfigurácia).
3. Play Console: test subscription produkt `esblu_test_pro` (base plany `monthly`/`yearly`), license testers,
   app nahraná aspoň do internal testing (Play Billing nefunguje pre sideload s iným package/podpisom) — súhlas.
4. Google service account (Play Developer API, read + acknowledge) + RTDN Pub/Sub topic/subscription — súhlas.
5. Stripe **test** kľúč + webhook secret (iba Preview/staging env, zadáva vlastník) — súhlas.
6. Apple: In-App Purchase key, App Store Connect subscription group, Mac na StoreKit — súhlas.
7. CLIA / účtovník: bod 12.
