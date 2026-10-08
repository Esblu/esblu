# Unified Subscriptions / Billing — architektúra (staging/test)

**ONE ESBLU SUBSCRIPTION. BUY ANYWHERE. USE EVERYWHERE. SERVER-SIDE ENTITLEMENTS ARE THE SOURCE OF TRUTH.**

| | |
|---|---|
| Branch | `subscriptions-platform` (z `main` @ `901c46c`) — **nemergovať**, žiadny production deploy |
| Migrácia | `supabase/migrations/20261008120000_subscriptions_platform.sql` — **NEAPLIKOVANÁ** nikde (overená iba v PGlite) |
| Rollback | `supabase/rollback/20261008120000_subscriptions_platform_rollback.sql` |
| Policy audit | `docs/subscriptions-store-compliance-2026-10-08.md` |
| GDPR delta | `docs/subscriptions-gdpr-provider-delta-2026-10-08.md` (interné, CLIA neodoslané) |

## A. Architektúra

```
 Web (Next.js)          Android (Capacitor)        iOS (Capacitor)
   │  Predplatné UI         │  ta istá obrazovka       │  ta istá obrazovka
   │  (web_checkout)        │  (iba text, bez nákupu)  │  (bez nákupu)
   └──────────────┬─────────┴──────────────┬───────────┘
                  │ GET /api/billing/subscription (JWT) — rovnaká odpoveď pre všetkých
                  ▼
        ┌──────────────────────── Esblu server (route handlers) ───────────────────┐
        │ checkout / manage  ──► DB RPC (rola + plán + price)                       │
        │ webhooks/{stripe,fake} ─► pipeline: verify → record(dedupe) → normalize   │
        │                                     → apply_event → sync_entitlements    │
        │ BillingProvider: stripe(test) │ fake │ apple* │ google*  (*NOT_CONFIGURED) │
        └───────────────────────────────────┬──────────────────────────────────────┘
                                            ▼
     Postgres: subscription_accounts (1/firma) ─► company_entitlements(source='subscription')
                                                       ▲
                    esblu_resolve_entitlement (EXISTUJÚCI) ─ triggery, RPC, AI ledger, hlas
```

- **Zdroj pravdy:** existujúci resolver `esblu_resolve_entitlement` nad `company_entitlements` (migrácia 20260928100000). Predplatné **nevytvára paralelný systém** — iba zapisuje alebo odvoláva riadky `source='subscription'` (jeden na kľúč a firmu, čiastočný unique index).
- **Provider nie je zdroj pravdy.** Neplatí „Stripe status = entitlement“. Platí: provider stav → kanonický `subscription_accounts.status` → `esblu_billing_sync_entitlements` → `company_entitlements` → resolver.
- **Trial** ostáva bez zmeny: 14 dní, 1 používateľ, 2 vozidlá, 2 stroje, 5 skladových položiek, 5 AI spracovaní, nemenné `companies.trial_*`. Platený grant má v resolveri prednosť. Po skončení predplatného sa firma vráti na trial alebo `TRIAL_EXPIRED`. **Dáta sa nikdy nemažú.**

## B. Kanonický model

| Tabuľka | Účel | Kľúčové pravidlá |
|---|---|---|
| `subscription_plans` | katalóg plánov (balík nárokov) | `status`: draft / **test_fixture** / approved / retired |
| `subscription_plan_entitlements` | plán → `entitlement_catalog` kľúče + limity | jediný vstup pre prepočet nárokov |
| `billing_provider_prices` | **server-side** plán + interval → provider price ID | unique (provider, env, price); prehliadač ho nikdy nevidí |
| `billing_runtime_config` | kill-switch: `web_provider` none / fake / stripe, `environment` | check: **iba `test`** (live = nová migrácia + súhlas) |
| `subscription_accounts` | **1 riadok na firmu**: plán, interval, stav, provider, ID, obdobie, `cancel_at_period_end`, `canceled_at`, `ended_at`, provider trial, `grace_until`, `provider_state_at`, `version` | zapisuje iba `esblu_billing_apply_event` |
| `billing_provider_links` | firma ↔ customer / subscription / account_token | unique externé ID ⇒ jeden identifikátor = jedna firma |
| `billing_checkout_sessions` | checkout zámer vytvorený serverom | webhook nájde firmu **iba** cez `checkout_ref` = id tohto riadku |
| `billing_events` | audit + idempotencia | unique (provider, env, event_id), sha256 tela, minimalizovaný súhrn; **žiadny raw payload** |

**Prečo jeden riadok na firmu namiesto histórie predplatných:** produktová zásada „jedna firma = jeden stav“. Riadok je chránený advisory lockom a `version`. Históriu nesie `billing_events`.

**Stavy:** `none`, `incomplete`, `trialing`, `active`, `past_due`, `unpaid`, `paused`, `canceled`, `expired`.

**Prepočet nárokov:**

| Stav | Nároky |
|---|---|
| `active` / `trialing` | platia do `current_period_end` + 2 dni (buffer na oneskorený renewal webhook) |
| `past_due` | platia do `grace_until` (7 dní od prvého zlyhania) |
| ostatné stavy | odvolané (`status='revoked'`) |

Bez webhooku nárok sám vyprší cez `valid_until` (**fail closed**).

**Rolová matica:**

| Rola | Kúpa / zmena / zrušenie / portál | Detaily (obdobie, provider) | Plán + stav + nároky |
|---|---|---|---|
| owner | ✅ | ✅ | ✅ |
| admin + `permissions.billing.manage=true` | ✅ | ✅ | ✅ |
| admin (aj s `finance.manage`) | ❌ | podľa `finance.view` | ✅ |
| accountant | ❌ (externý — `finance.manage` pre faktúry ≠ platiť za Esblu) | ✅ (`esblu_my_finance_view`) | ✅ |
| employee | ❌ | ❌ | ✅ |
| iná firma / neaktívny | ❌ | ❌ | ❌ |

> Rozhodnutie na potvrdenie: nový kľúč `permissions.billing.manage` (nie `finance.manage`). Dnes ho žiadne UI nenastavuje — admin ho dostane iba ručne.

**Upgrade / downgrade:** Stripe `items[0].price` + `proration_behavior=create_prorations` (okamžite). Pri downgrade sa nároky mimo plánu odvolajú; existujúce záznamy nad limitom ostávajú (blokuje sa iba vznik nových).

> **Obchodné rozhodnutie:** downgrade okamžite vs. ku koncu obdobia (Stripe subscription schedules).

## C. Platobná matica

Pozri `docs/subscriptions-store-compliance-2026-10-08.md`, sekcia 4. Implementované (`purchaseChannel`):

- **web** = Stripe-hosted Checkout;
- **android** = bez nákupu, iba text bez odkazu;
- **ios** = bez nákupu a bez výzvy na nákup.

## D. Implementované na branchi (staging)

- **DB:** migrácia, RLS (default deny, žiadne politiky pre authenticated), granty iba `service_role`, a tieto RPC:
  - pre používateľa: `esblu_billing_my_access`, `esblu_get_my_subscription`, `esblu_get_my_checkout_status`, `esblu_billing_list_plans`, `esblu_billing_create_checkout_intent(plan, interval)`, `esblu_billing_authorize_manage`, `esblu_billing_issue_account_token(provider)`;
  - iba service_role: `esblu_billing_attach_checkout_session`, `esblu_billing_resolve_price`, `esblu_billing_record_event`, `esblu_billing_close_event`, `esblu_billing_apply_event`, `esblu_billing_sync_entitlements`.
- **Server:** `lib/billing/{types,signature,pipeline,config,server,client-model}.ts`, `lib/billing/providers/{stripe,fake,stores}.ts`.
- **API:**
  - `GET /api/billing/subscription`
  - `POST /api/billing/checkout`
  - `GET /api/billing/checkout/[id]`
  - `POST /api/billing/manage` (cancel / resume / change / portal)
  - `POST /api/billing/webhooks/stripe`
  - `POST /api/billing/webhooks/fake`
  - `POST /api/billing/fake/complete`
- **UI:** `/nastavenia/predplatne` (web + mobile re-export) a `/nastavenia/predplatne/fake-checkout` (iba staging). Odkaz v Nastaveniach je iba pri `NEXT_PUBLIC_ESBLU_BILLING_UI=1`. Preklady sk/en/de.
- **Poistky:**
  - `VERCEL_ENV=production` ⇒ billing vždy `off`, API vracia 404;
  - default `off`;
  - Stripe kľúč musí byť `sk_test_`/`rk_test_`, inak `LIVE_MODE_FORBIDDEN`;
  - event `livemode:true` sa odmietne;
  - DB povoľuje iba `environment='test'`.

### Staging zapnutie (keď bude staging Supabase + Vercel preview)

1. Aplikovať migráciu na **staging** DB (nie `fkpgvgvsmbpieduoatrt`).
2. `update billing_runtime_config set web_provider='fake'` (alebo `'stripe'`).
3. Env v Vercel **Preview** (nie Production):
   - `ESBLU_BILLING_MODE=fake|stripe_test`
   - `ESBLU_FAKE_BILLING_SECRET` (≥16 znakov, náhodný)
   - `ESBLU_BILLING_RETURN_ORIGIN=https://<preview-host>`
   - `NEXT_PUBLIC_ESBLU_BILLING_UI=1`
4. Pre Stripe: v sandboxe vytvoriť produkty a ceny (mesačne/ročne) a vložiť test price IDs do `billing_provider_prices (provider='stripe', environment='test')` cez service_role. Potom nastaviť `STRIPE_SECRET_KEY` (sk_test_…), `STRIPE_WEBHOOK_SECRET` a webhook endpoint `https://<preview>/api/billing/webhooks/stripe` s eventmi zo sekcie F.

## E. Fake / test provider

- `FakeBillingProvider`: rovnaký kontrakt a rovnaká podpisová schéma (HMAC `t=,v1=`) ako Stripe. Pipeline sa tak testuje end-to-end.
- Na stagingu „hosted checkout“ = stránka `fake-checkout`. Tá zavolá `/api/billing/fake/complete`, ktoré **podpíše fake webhook** a pošle ho tou istou pipeline. Nič sa nezapisuje priamo.
- Test fixtures: plány `test_starter` / `test_pro` (`status='test_fixture'`). Price IDs `fake_price_*`, Apple `com.esblu.test.pro.*`, Google `esblu_test_pro:*`. **Nie sú to schválené ceny.**

## F. Stripe test mode

- Adaptér je pripravený a otestovaný proti mock `fetch`. **Reálne volanie Stripe neprebehlo** — chýba Stripe sandbox a test kľúče.
- Hosted Checkout s `mode=subscription`, dynamickými platobnými metódami (karta, Apple Pay a Google Pay podľa Dashboardu), `tax_id_collection`, `billing_address_collection=required`, `locale=sk` a idempotency key.
- Webhooky, ktoré menia stav:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `customer.subscription.created/updated/deleted/paused/resumed`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `invoice.payment_action_required`
- Iba audit: `charge.refunded`, `charge.dispute.created`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.trial_will_end`.
- Každý stavový event znova načíta predplatné z API (Stripe negarantuje poradie). `state_at` = čas načítania.

## G. Security audit

| Hrozba | Ochrana | Test |
|---|---|---|
| Podvrhnutý webhook | HMAC podpis (`timingSafeEqual`), tolerancia 300 s; zlý podpis → 400, nič sa neuloží | unit + pglite |
| Replay | timestamp tolerancia + unique event ID + rovnaké ID s iným telom = `payload_mismatch` | pglite |
| Duplicitné doručenie | `record_event` ON CONFLICT + `apply_event` iba pre stav `received` | pglite (`entitlements` = 7 riadkov aj po 3 doručeniach) |
| Nesprávne poradie | `provider_state_at` — starší stav = `stale`; ukončené predplatné toho istého ID sa nedá oživiť (`TERMINAL_STATE`) | pglite |
| Tampering price / product ID | klient posiela iba `plan_code` + interval; price ID z `billing_provider_prices`; webhook price → plán cez tú istú tabuľku; nesúlad s checkout zámerom = `PRICE_MISMATCH` + rejected | pglite |
| Plán dodaný klientom | plán musí byť `approved` (alebo `test_fixture` v teste); RPC nemá parameter price | pglite |
| Falošný „success“ redirect | UI ignoruje query; polluje `esblu_get_my_checkout_status` + kanonický stav | unit + pglite |
| Eskalácia práv | rola sa overuje v DB (SECURITY DEFINER, `auth.uid()`); authenticated nemá žiadny priamy grant | pglite (matica rolí) |
| Zmena cudzej firmy | firma vždy z `auth.uid()`; cudzí checkout → `found:false`; externé ID patriace inej firme → `CROSS_TENANT_IDENTIFIER` | pglite |
| Firma z payloadu providera | ignoruje sa; firma iba z `billing_checkout_sessions` / `billing_provider_links` | pglite (`UNKNOWN_COMPANY`) |
| Dvojité predplatné / dvojité účtovanie | checkout zablokovaný pri aktívnom stave; druhý provider = `conflict` (operátor) | pglite |
| Zneužitie trialu | trial nemenný (existujúci guard); billing ho nemení; nový trial pre existujúcu firmu nevzniká | existujúce testy |
| Checkout spam | max. 10 zámerov za hodinu na firmu | — (DB limit) |
| Únik webhook secretu | iba server env; žiadny `NEXT_PUBLIC_`; nelogujú sa hodnoty ani telá | code review |
| Live mode omylom | `VERCEL_ENV=production` ⇒ off; `sk_live` ⇒ chyba; `livemode:true` ⇒ 400; DB check `environment='test'` | unit + pglite |
| Open redirect v návratových URL | origin iba z `ESBLU_BILLING_RETURN_ORIGIN` (https), nie z hlavičiek požiadavky | unit |

**Zostatkové riziká:**

- refund alebo dispute sa iba audituje — o odobratí nároku rozhoduje operátor;
- Google upgrade: neskorší event starého tokenu skončí ako `conflict` (neškodné, ale viditeľné v audite);
- concurrency `apply_event` je serializovaná advisory lockom na firmu.

## H. Testy

| Sada | Výsledok |
|---|---|
| `npm run test:subscriptions` (unit / contract: podpisy, Stripe normalizácia + checkout params + live guard, Apple/Google stavy, provider contract, pipeline retry, config, UI model) | **16 / 16** |
| `npm run test:subscriptions-db` (PGlite: baseline + 20260928100000 + migrácia 2×; granty, matica rolí, trial→paid, mesačne, ročne, cancel, resume, upgrade, downgrade, payment failed, grace, recovery, unpaid, expirácia bez webhooku, reactivation, duplicate, out-of-order, replay, payload mismatch, wrong company, cross-tenant, unknown/mismatch price, fake success redirect, iOS / Android / web rovnaké nároky, Apple cancel, Google linkedPurchaseToken, conflict, rollback + re-apply) | **41 / 41** |
| Regresia: plan-entitlements, i18n, mobile-m0, mobile-m1, closed-beta-p0, push, google-oauth, storage-media, intent-permissions | všetky prešli |
| `tsc --noEmit` | čisté |
| `eslint` | bez nových chýb (main má 37 existujúcich chýb, branch rovnako 37 — žiadna nová) |
| `next build` (web) | OK — v sandboxe `--webpack` + mock Google Fonts (sandbox nemá prístup na fonts.googleapis.com, Turbopack s mockom nefunguje); všetky `/api/billing/*` routy + `/nastavenia/predplatne` |
| `next build` (mobile static export) | OK — `/nastavenia/predplatne` zabalená |

Spustenie DB testov: `npm i --no-save @electric-sql/pglite@0.5.8 && npm run test:subscriptions-db`.

## I. Migrácie

- `20261008120000_subscriptions_platform.sql` — aditívna. Nemení existujúce tabuľky ani funkcie; pridáva iba čiastočný unique index na `company_entitlements` (source='subscription').
  - **Neaplikovaná** na produkciu, staging ani inú DB.
  - Idempotentná (2× v teste).
  - Pozor: test baseline nepokrýva `20260929100000_closed_beta_p0_hardening` (potrebuje mnoho ďalších tabuliek). Tá mení iba RPC pozvánok a backfill `team_members`, resolver nie.
- Rollback: zruší RPC a index, nároky ponechá (vypršia cez `valid_until`). Tabuľky zhodí iba s `esblu.rollback_drop_billing_tables='yes'`.
