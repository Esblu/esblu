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
| subscriptions-lifecycle (unit) | 34 | `npm run test:subscriptions-lifecycle` |
| subscriptions-lifecycle-db (PGlite) | 47 | `npm run test:subscriptions-lifecycle-db` |
| native-billing-contract (integračná vetva) | 9 | `npm run test:native-billing-contract` |

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
| Idempotencia / poradie / konflikty | READY (multi-connection stres test → staging) |
| Refund / dispute / revoke | READY |
| Reconciliation (kód + RPC + route) | READY · scheduling NOT STARTED (zámerne) |
| Fake provider end-to-end | READY |
| Stripe test adapter | READY (mock) · reálny test účet BLOCKED EXTERNAL |
| Google server (RTDN, subscriptionsv2, acknowledge) | READY (fake API) · service account + produkty BLOCKED EXTERNAL |
| Google client plugin (Java) | PARTIAL — kontrakt testovaný, natívna kompilácia na PC, billing choice nezapojený |
| Apple server (JWS, ASN V2, Server API) | READY (fake) · kľúče + produkty BLOCKED EXTERNAL |
| Apple client (StoreKit 2) | PARTIAL — iba referenčný Swift, bez Macu |
| Web UI predplatného | READY (za flagom) |
| Mobile UI (managed via, pending, already owned, restore) | READY |
| Staging DB aplikácia migrácií | NOT STARTED (vyžaduje súhlas) |
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
