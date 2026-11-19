# Esblu 8 — integrovaný release `release/esblu8` (2026-11-19)

Stav: **pripravené, NEnasadené.** Push, deploy a každá produkčná migrácia vyžadujú osobitné schválenie prevádzkovateľa. LIVE platby a eFaktúra ostávajú vypnuté.
Doplňuje `docs/release/esblu8-release-runbook-2026-11-19.md` (postup merge → push → Vercel READY podľa SHA → `apply_migration` po jednej, zákaz `supabase db push`).

## 1. Obsah vetvy (lokálne, nepushnuté)

| Časť | Commity | Zmena |
|---|---|---|
| Stripe S12–S15b | `fb349db` a predchodcovia | billing pipeline, live režim pripravený (vypnutý) |
| Interný tarif | `f8262b4` | operator-only grant |
| Ochrana auditu v rollbackoch | `e9c64a6` | rollback neprázdnej auditnej tabuľky ju archivuje, nemaže |
| P2 retenčný archív | `ce125fe`, `9e0cfd3` | ukončenie firmy archivuje doklady namiesto výmazu |
| P3 eFaktúra | `d432c42` | mandát, brána odosielania, deregistrácia, alerty |
| P4 Stripe | `ee176a8` | pripnutá API verzia, retry/dead-letter, ops alerty, účtovná kópia dokladov, export |
| Integrácia | `943c746`, `756eb26`, `50a16b8` | merge grants manifestu, lint, testové inventáre |

## 2. Validácia integrovaného stromu (Linux, Node 22, čistý `npm ci`)

| Kontrola | Výsledok |
|---|---|
| `tsc --noEmit` | PASS, 0 chýb |
| `npm run lint` | 36 chýb / 31 varovaní = baseline `origin/main` (2 nové `prefer-const` opravené) |
| `npm run build` | PASS, 61 stránok (offline mock Google Fonts, fiktívne env) |
| DB/pglite + unit | 27 sád PASS: grants-guard 10, grants-replay-db 43, retention-archive-db 16, company-termination-db 20, company-termination 10, einvoice-mandate-db 27, einvoice-mandate 13, einvoice-outbound 54, einvoice-ops 23, einvoice-db 44, einvoice-reception 27, einvoice-inbound 56, multi-company-einvoice-db 10, billing-ops-db 15, billing-live-mode-db 14, billing-post-period-db 16, subscriptions-lifecycle-db 82, subscriptions-db 60, subscriptions 28, internal-operator-db 16, pricing-entitlements-db 35, account-deletion-orchestration 15, account-deletion-subscription 38, stripe-adapter 21, webhook-idempotency 5, prelaunch-blockers 21, clia-gdpr 17 |
| Secrets/PII sken `f8262b4..HEAD` | 0 kľúčov/tokenov; e-maily iba fixtures `@example.invalid` a firemné adresy |
| Nové migrácie | každá tabuľka má RLS; žiadny grant pre `anon`; všetky SECURITY DEFINER majú `search_path` |

## 3. Migračný plán (produkcia: posledná `20261117213219 open_public_registration`)

Vlna A — technická, po schválení nasadenia a platobnej časti (LIVE ostáva vypnutý):

| # | Migrácia | Poznámka |
|---|---|---|
| 1–8 | `20261118120000` … `20261119140000` (Stripe) | podľa runbooku |
| 9 | `20261120100000_internal_operator_entitlement` | grant až po osobnej registrácii prevádzkovateľa |
| 10 | `20261123100000_billing_event_retry` | **pred deployom kódu** |
| 11 | `20261123110000_billing_invoice_documents` | **pred deployom kódu** (inak `DOCUMENT_FAILED` → retry) |
| 12 | `20261123120000_billing_ops_alerts` | |
| 13–15 | `20261122100000` / `110000` / `120000` (eFaktúra P3) | bez dopadu, kým eFaktúra nie je aktívna (v produkcii 0 organizácií) |

Vlna B — **až po rozhodnutí prevádzkovateľa + stanovisku CLIA** (retencia dokladov po ukončení firmy, GDPR čl. 28 ods. 3 písm. g):

| # | Migrácia | Poznámka |
|---|---|---|
| 16 | `20261121100000_retention_archive_company_termination` | mení správanie ukončenia firmy; spolu s úpravou UI textov `/zrusenie-uctu` |

P2 nemá aplikačný kód, P3/P4 od neho nezávisia (žiadna spoločná funkcia) → odloženie vlny B je technicky bezpečné. Verzia v histórii = čas aplikovania (rovnako ako doteraz).

Poradie kódu: migrácie 1–12 → merge `release/esblu8` do `main` → push → Vercel READY pre presné SHA → smoke test → migrácie 13–15.

## 4. Rollback (opačné poradie, súbory v `supabase/rollback/`)

- Každá z 16 migrácií má rollback; neprázdne auditné/dôkazné tabuľky sa presúvajú do `esblu_audit_archive` (bez prístupu `anon/authenticated/service_role`), nikdy nemažú.
- Retenčný archív (P2) rollback nemaže; čítanie archívu ostáva funkčné.
- Rollback nemaže riadky v `supabase_migrations.schema_migrations` — pri opätovnom nasadení evidovať ručne.
- Kód: Vercel „Instant Rollback“ na predchádzajúci READY deployment `main`.

## 5. Produkčný smoke test (po schválenom deployi)

1. `GET https://www.esblu.com/` a `/login` → 200; Vercel deployment `readyState=READY` pre presné SHA.
2. Prihlásenie troch chránených účtov (playreview, gdpresblu, zamestnanec) — dashboard, moduly, foto, AI náhľad.
3. `/api/cron/billing-ops-monitor` (s CRON_SECRET) → 200 a bez kritického alertu; `billing_runtime_config.web_provider = none`.
4. `get_advisors` security/performance bez nových ERROR.
5. Kontrola `schema_migrations` po každej migrácii.

## 6. Otvorené technické riziká

- Pripnutá Stripe API verzia `2025-03-31.basil` nebola overená proti sandboxu — pred LIVE zopakovať S12/S13 sandbox testy.
- E-mailové alerty (Resend REST) sú voliteľné; bez nich iba DB + HTTP 503 z monitor cronu.
- eFaktúra sandbox E2E (deregistrácia, `usage.limit_exceeded`) neoverená — sandbox nedostupný z tohto prostredia; skript `scripts/einvoice-deregistration-sandbox-smoke.ts` pre staging.
