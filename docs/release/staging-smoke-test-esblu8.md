# Staging smoke test — release/esblu8

**Rozsah:** Vercel **Preview** deployment vetvy `release/esblu8` + **staging** Supabase projekt `esblu-test`.
**Nikdy** produkčné kľúče, produkčná DB ani produkčný Vercel. Iba syntetické firmy (`QA-…`, `@example.invalid`).
Každý krok má očakávaný výsledok; ak sa nezhoduje → **STOP** (§ 9). Výstupy do protokolu bez tajomstiev,
tokenov a PII (iba stavy, kódy, počty, prefixy SHA-256).

Súvisiace: `docs/release/esblu8-integrated-release-2026-11-19.md` (vlny A/B), `docs/einvoice-mandate-and-safety-2026-11-19.md`,
`docs/billing-invoicing-architecture-2026-11-19.md`, `docs/retention-archive-design-2026-11-19.md`.

---

## 0. Predpoklady (kontrola pred začatím)

| # | Kontrola | Očakávané |
|---|---|---|
| 0.1 | Preview deployment pre presné SHA `release/esblu8` | `readyState = READY`, `target = preview` (nie production) |
| 0.2 | Supabase projekt v env Preview | URL/ref = staging `esblu-test`; **nie** produkčný projekt |
| 0.3 | Stripe kľúče v Preview | iba `sk_test_` / `rk_test_` (test mode); žiadna `STRIPE_LIVE_*` premenná v Preview |
| 0.4 | eFaktura kľúč v Preview | iba `efk_pk_test_…`; `ESBLU_EINVOICE_ENVIRONMENT=sandbox`; `ESBLU_EINVOICE_LIVE_ENABLED` nenastavené |
| 0.5 | `billing_runtime_config` na stagingu | `environment = 'test'` |
| 0.6 | Záloha / branch stagingu | staging je možné obnoviť (Supabase backup alebo branch), inak STOP |
| 0.7 | Lokálne offline testy na tom istom SHA | PASS (§ 8) |

### Premenné prostredia (iba názvy — hodnoty nikdy do protokolu)

- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Cron: `CRON_SECRET`; Vercel ochrana preview: `VERCEL_AUTOMATION_BYPASS_SECRET`
- Billing: `ESBLU_BILLING_MODE=stripe_test`, `ESBLU_BILLING_RETURN_ORIGIN` (URL preview), `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, voliteľne `STRIPE_API_VERSION` (iba overená verzia, inak nenastaviť);
  **nenastavovať** `ESBLU_BILLING_LIVE_APPROVED`, `STRIPE_LIVE_SECRET_KEY`, `STRIPE_LIVE_WEBHOOK_SECRET`, `STRIPE_LIVE_REPORTING_KEY`
- Ops alerty (voliteľné): `ESBLU_OPS_ALERT_EMAIL_TO`, `ESBLU_OPS_ALERT_EMAIL_FROM`, `RESEND_API_KEY`
- eFaktúra: `ESBLU_EINVOICE_PROVIDER=efaktura_sk`, `ESBLU_EINVOICE_ENVIRONMENT=sandbox`, `ESBLU_EFAKTURA_API_KEY`,
  `ESBLU_EFAKTURA_WEBHOOK_SECRET` (alebo `ESBLU_EFAKTURA_WEBHOOK_SECRETS`), voliteľne `ESBLU_EFAKTURA_BASE_URL`
- Lokálne skripty: `.env.local` vo worktree (iba sandbox/test hodnoty); `ESBLU_QA_SERVICE_ROLE` / `STRIPE_API_KEY`
  zadávať skryto podľa `scripts/stripe-local-sandbox.ps1`

---

## 1. Migrácie na staging (poradie)

Aplikovať po jednej (Supabase MCP `apply_migration` alebo SQL editor stagingu), po každej skontrolovať
`supabase_migrations.schema_migrations` a `get_advisors` (security) bez nového ERROR. Ak už staging niektorú má, preskočiť.

| # | Migrácia | Kontrola po aplikovaní |
|---|---|---|
| 1–8 | `20261118120000` … `20261119140000` (Stripe: single checkout, terminal precedence, refund audit, post-period, scheduled end, catch-up, live mode, allowlist) | `billing_runtime_config.environment = 'test'` |
| 9 | `20261120100000_internal_operator_entitlement` | bez grantu (grant až po registrácii prevádzkovateľa) |
| 10 | `20261123100000_billing_event_retry` | stĺpce `next_retry_at`, `dead_letter` v `billing_events` |
| 11 | `20261123110000_billing_invoice_documents` | tabuľky `billing_invoice_documents`, `billing_balance_transactions`, `billing_refund_observations` bez prístupu `anon/authenticated` |
| 12 | `20261123120000_billing_ops_alerts` | `billing_ops_alerts`, `billing_ops_heartbeats` |
| 13 | `20261122100000_einvoice_mandates` | `einvoice_mandates` (RLS on); INSERT outbound bez mandátu → `ESBLU_EINVOICE_MANDATE_REQUIRED` |
| 14 | `20261122110000_einvoice_deregistration_jobs` | `einvoice_deregistrations` |
| 15 | `20261122120000_einvoice_ops_alerts` | `einvoice_ops_alerts` |
| 16 | `20261121100000_retention_archive_company_termination` (vlna B — na stagingu áno, v produkcii až po rozhodnutí + CLIA) | schéma `esblu_retention` bez USAGE pre `anon/authenticated` |

**Pozor:** existujúce staging firmy s aktívnou eFaktúrou po migrácii 13 **nemajú mandát** → odosielanie je
zablokované, kým owner/finance nespraví regrant (§ 3.2). To je očakávané správanie, nie chyba.

Potom deploy kódu: Preview pre presné SHA `release/esblu8` (žiadny merge do `main`, žiadny production deploy).

---

## 2. Stripe sandbox (test mode)

Okno 1: `powershell -ExecutionPolicy Bypass -File .\scripts\stripe-local-sandbox.ps1` (Esblu lokálne + `stripe listen`
voči stagingu) — alebo webhook endpoint v Stripe test Dashboarde smerujúci na Preview URL
`/api/billing/webhooks/stripe` s API verziou **`2025-03-31.basil`**.

| # | Krok | Očakávané |
|---|---|---|
| 2.1 | `-Step s12-account` | test mode, kľúč vidí účet a udalosti; žiadny výpis kľúča |
| 2.2 | Pripnutá verzia: ľubovoľný krok (napr. `-Step status`) a v Stripe Dashboarde → Developers → Logs filtrovať requesty Esblu | každý request má hlavičku `Stripe-Version: 2025-03-31.basil` |
| 2.3 | Webhook endpoint s inou API verziou (dočasne test endpoint s inou verziou, alebo udalosť s iným `api_version`) | `billing_ops_alerts` riadok `WEBHOOK_API_VERSION_MISMATCH` (open), udalosť sa spracuje; potom endpoint vrátiť na `2025-03-31.basil` a alert vyriešiť |
| 2.4 | Nový checkout syntetickej firmy (QA-STRIPE E, `-Step qa-login` + nákup v UI Preview) → `-Step qa-check` | 1 `billing_events` záznam na udalosť, predplatné `active`, invarianty OK |
| 2.5 | **Replay zlyhanej udalosti:** okno 1 s `-NoListen`, `-Step s12-refund-missing` (udalosť bez webhooku) → `-Step s12-catchup` | doťahovanie udalosť spracuje; druhý beh `s12-catchup` = nič nové (`processed` 0 / `duplicate`) |
| 2.6 | Zlyhaná udalosť → retry: v Stripe Dashboarde „Resend“ tej istej udalosti po jej spracovaní | `duplicate` (žiadna druhá zmena); v `billing_events` 1 riadok, `status = processed`, `dead_letter = false` |
| 2.7 | `GET /api/cron/billing-stripe-events` (Bearer `CRON_SECRET`) | 200, `configured: true`, `retry.code = null` |
| 2.8 | `update billing_runtime_config set web_provider = 'none'` → znovu 2.7 → vrátiť `web_provider = 'stripe'` | pri `none` cron **beží** (`configured: true`) a doťahuje (pozastavený je iba predaj); nový checkout v UI odmietnutý |
| 2.9 | Doklad: `-Step renew` (Test Clock → nová zaplatená faktúra) | `billing_invoice_documents`: 1 riadok na `in_…`, `company_id` = firma, `provider_subscription_id`, `status = paid`, `paid_at`, `service_period_start/end` vyplnené; žiadne meno/e-mail/adresa |
| 2.10 | `GET /api/cron/billing-documents` (Bearer `CRON_SECRET`) | `pdf_sha256` + `pdf_storage_path` (`test/YYYY/MM/invoice/in_….pdf`) vyplnené; druhý beh `claimed = 0` |
| 2.11 | `-Step refund-partial` + dobropis v Stripe (credit note k faktúre) | `billing_refund_observations` riadok; dobropis `kind = credit_note`, `related_invoice_id = in_…`; po 24 h bez dobropisu by vznikol alert `REFUND_WITHOUT_CREDIT_NOTE` |
| 2.12 | Účtovný export: `GET /api/billing/admin/accounting-export?month=YYYY-MM&environment=test&refresh=1` (Bearer JWT používateľa v `billing_ops_admins` na stagingu) | CSV (`;`), stĺpce `gross`, `stripe_fee`, `net`, `bt_type`/`reporting_category` (refund), `payout_ids`, `payout_arrival_date`, `pdf_sha256`; bez e-mailov a mien; riadok v `billing_accounting_export_log`. Iný používateľ → 403 |
| 2.13 | `GET /api/cron/billing-ops-monitor` (Bearer `CRON_SECRET`) | 200 bez kritického alertu (po vyriešení 2.3); opakovaný beh nepošle druhý e-mail; e-mail neobsahuje `evt_/cus_/sub_/in_/pi_`, e-maily ani tajomstvá |
| 2.14 | Zákazník: owner v Preview → Nastavenia → Predplatné → „Spravovať“ (`POST /api/billing/manage {action:"portal"}`) | Stripe Customer Portal (test); admin/účtovník/employee → 403. História faktúr v Portáli podľa nastavenia Portálu |

---

## 3. eFaktura.sk sandbox

Syntetická firma `QA-EINV A` (owner + admin s financiami + employee) s nárokom `einvoice` a `einvoice_rollout`
(`sandbox`, stage `internal`) na stagingu. Sandbox kľúč `efk_pk_test_…`.

| # | Krok | Očakávané |
|---|---|---|
| 3.1 | Owner v Preview → Nastavenia → E-Faktúra → aktivácia príjmu (overovací kód zo sandbox portálu FS / test kód) | 200 `ENROLLED` (alebo `SEND_ONLY`); `einvoice_mandates`: 1 riadok, `statement_version = efaktura-mandate-2026-11-19`, `effective_at` vyplnené, `provider_org_id` = org firmy, `effective_scope` = `{send,receive}` (send_only → `{send}`); overovací kód nikde v DB ani logoch |
| 3.2 | Odoslanie faktúry ako e-faktúra (`POST /api/einvoice/outbound {invoice_id, confirm_send:true}`) | 202/200, riadok `einvoice_outbound`, cron `einvoice-outbound?mode=send` → `sent`/`delivered` |
| 3.3 | `POST /api/einvoice/mandate {action:"revoke", confirm_revoke:true}` → znovu 3.2 s inou faktúrou | revoke 200 `REVOKED`; odoslanie **403 `MANDATE_REQUIRED`**; žiadny nový riadok `einvoice_outbound` |
| 3.4 | `POST /api/einvoice/mandate {action:"grant", confirm_mandate:true, mandate_version:"efaktura-mandate-2026-11-19"}` → 3.2 | 200 `GRANTED` (`grant_channel = regrant`, `provider_outcome = ORG_VERIFIED`); odoslanie OK |
| 3.5 | Employee / admin bez financií: 3.3 a 3.4 | 403, nič sa nezapíše |
| 3.6 | Text poverenia je DRAFT: v Preview **nemeniť** `ESBLU_EINVOICE_ENVIRONMENT` na `live` | (iba informatívne) v live by grant/enroll vrátil 409 `MANDATE_STATEMENT_NOT_APPROVED` — overené offline testom |
| 3.7 | Overenie org + deregistrácia (lokálne, `.env.local` so sandbox kľúčom): `node --env-file=.env.local --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs scripts/einvoice-deregistration-sandbox-smoke.ts --confirm-sandbox --org=<SANDBOX_ORG_ID>` | S1 `ok`, SHA-256 prefix; S2 `SKIP` |
| 3.8 | Deaktivácia IBA syntetickej throwaway org: `… --allow-deactivate=<THROWAWAY_ORG_ID>` | S2 2xx; S3 opakovanie 2xx alebo 409 (nie 404). Nikdy org z A/B E2E |
| 3.9 | Ukončenie syntetickej firmy `QA-EINV T` (s aktívnou org) cez `/zrusenie-uctu` | deregistračný job `einvoice_deregistrations` → `completed` (príp. po `einvoice-maintenance` crone); mandáty `revoked_by_kind = deregistration`; `einvoice_organizations` bez riadku; mandáty a job ostávajú |
| 3.10 | `usage.limit_exceeded`: v sandbox portáli eFaktura vyvolať / zopakovať test webhook tejto udalosti (ak to sandbox umožňuje) | `einvoice_ops_alerts` kód `PROVIDER_USAGE_LIMIT_EXCEEDED` (open, `occurrences` rastie pri opakovaní, 1 riadok); `GET /api/cron/einvoice-maintenance` hlási otvorený kritický alert; webhook iného prostredia (`data.mode` ≠ test) ignorovaný |
| 3.11 | Replay webhooku: ten istý webhook (rovnaké `X-Webhook-Id`) doručiť 2× | druhýkrát `DUPLICATE`, nič nové; iné telo pod tým istým ID → 409 |
| 3.12 | Voliteľne A/B E2E: `node --env-file=.env.local --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs scripts/einvoice-partner-sandbox-e2e.ts --confirm-sandbox` | PASS (PGlite, iba sandbox API) |

---

## 4. Retenčný archív (migrácia 16, iba staging)

| # | Krok | Očakávané |
|---|---|---|
| 4.1 | Syntetická firma `QA-RET A` s 1 finalizovanou faktúrou + e-faktúrou (XML v `einvoice-documents`) → ukončenie cez `/zrusenie-uctu` (waived) | `company_terminations.termination_mode = 'archive'`, `archive_id`; `esblu_retention.archived_records` (iba cez SQL editor ako `postgres`) s dokladmi; XML v Storage **ostáva**; cleanup job neobsahuje XML |
| 4.2 | Ako owner/admin/employee inej firmy a anon: `select * from esblu_retention.archived_records` cez Data API / REST | odmietnuté (schéma nie je exponovaná / bez USAGE) |
| 4.3 | Ako iný tenant: signed URL / download XML firmy `QA-RET A` | odmietnuté (Storage politiky nezmenené) |
| 4.4 | Operátor (service_role, SQL): `select esblu_retention.export_archive('<archive_id>', 'TICKET-…', 'staging smoke export')` | JSON `esblu.retention_archive_export.v1`; nový riadok `access_log` (`export`) |
| 4.5 | `select esblu_retention.purge_expired('PURGE-STAGING-1')` (default dry-run) | `dry_run = true`, `eligible = 0`, `skipped_unapproved_period > 0` (lehoty PROPOSED); nič sa nezmaže; riadok `purge_runs` |
| 4.6 | Guard: `select public.esblu_company_termination_synthetic_purge(<owner>, <id QA-RET A>, false, 'waived', true, 'OPS-STAGING-rerun', '<odôvodnenie ≥ 20 znakov>')` ako `postgres` | `already_completed: true, skipped: true`; nič sa nezmaže; `access_log` akcia `synthetic_test_data_purge_skipped` |
| 4.7 | To isté cez Data API / service_role | 42501 / `ESBLU_OPERATOR_ONLY` |

---

## 5. Všeobecné

| # | Krok | Očakávané |
|---|---|---|
| 5.1 | `GET /`, `/login` na Preview | 200 |
| 5.2 | Prihlásenie syntetického ownera, dashboard, faktúry, nastavenia | bez chýb v konzole / runtime logoch |
| 5.3 | `get_advisors` (security + performance) na stagingu | žiadny nový ERROR oproti stavu pred migráciami |
| 5.4 | Vercel runtime logy Preview počas smoke | žiadne kľúče, tokeny, e-maily ani overovacie kódy |

## 6. Upratanie

Syntetické firmy ukončiť cez `/zrusenie-uctu`; Stripe test predplatné zrušiť (`-Step verify-terminal`);
`billing_runtime_config.web_provider` vrátiť na pôvodnú hodnotu; dočasný webhook endpoint s inou API verziou zmazať;
sandbox org (throwaway) ostáva deaktivovaná. Auditné tabuľky (`billing_events`, `einvoice_mandates`, `access_log`, …) sa **nemažú**.

## 7. Protokol

Zapísať: SHA, Preview URL (bez bypass tokenu), čas, výsledok každého kroku (PASS/FAIL + kód), počty riadkov.
Ak sa pristupovalo k produkcii (nemá), záznam do `docs/ops/service-intervention-log.md`.

## 8. Offline testy (pred aj po)

`npx tsc --noEmit`; `npm run test:retention-archive-db`, `test:company-termination-db`, `test:einvoice-mandate`,
`test:einvoice-mandate-db`, `test:einvoice-reception`, `test:billing-ops-db`, `test:billing-live-mode-db`,
`test:subscriptions-lifecycle`, `test:prelaunch-blockers`, `test:grants-guard`.

## 9. STOP kritériá (okamžite prerušiť, nič ďalšie neaplikovať, informovať prevádzkovateľa)

- Akýkoľvek náznak produkčného prostredia: produkčný Supabase ref, `VERCEL_ENV=production`, `sk_live_`/`rk_live_`,
  `efk_pk_live_`, `ESBLU_BILLING_LIVE_APPROVED` alebo `ESBLU_EINVOICE_LIVE_ENABLED` v Preview.
- Migrácia zlyhá alebo `get_advisors` hlási nový ERROR (RLS vypnuté, verejný prístup k novým tabuľkám).
- Ktorýkoľvek request Esblu na Stripe bez `Stripe-Version: 2025-03-31.basil`, alebo udalosť spracovaná 2× (dva riadky
  / dve zmeny stavu pre jedno `evt_…`).
- Odoslanie e-faktúry prejde **bez** účinného mandátu (3.3), alebo employee/iný tenant udelí/odvolá mandát.
- Overovací kód FS, API kľúč, webhook secret, JWT alebo e-mail zákazníka sa objaví v DB, logu, alerte alebo e-maile.
- Archív / doklady čitateľné iným tenantom alebo anon (4.2, 4.3), purge zmaže čokoľvek pri PROPOSED lehote alebo
  legal hold, alebo opakovaný synthetic purge niečo zmaže (4.6).
- Deregistrácia vráti 404 pre org, ktorá existuje, alebo by sa mala deaktivovať iná než throwaway sandbox org.
