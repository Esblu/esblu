# Staging / Preview dôkazy — release/esblu8 (2026-11-19)

Kód: `114cfdf98ba49be6239b31d60f0f7cc17814efa9` (release/esblu8). Produkcia nedotknutá.

## 1. Oddelenie staging ↔ produkcia (overené pred nasadením preview)
| Kontrola | Výsledok |
|---|---|
| GitHub Actions | žiadne `.github/workflows` vo vetve → push nespúšťa CI ani migrácie |
| Vercel projekt `esblu` | production branch = `main`; preview = všetky ostatné deploymenty; ochrana Vercel Authentication (all_except_custom_domains) |
| Preview env `NEXT_PUBLIC_SUPABASE_URL` / anon kľúč | ref `cjbdijbbcujvmrzezusd` (= staging `esblu-test`), **nie** `fkpgvgvsmbpieduoatrt` (overené dekódovaním ref, hodnoty nevypísané) |
| Preview env Stripe / eFaktúra | žiadne `STRIPE_*`, `ESBLU_EFAKTURA_*`, `ESBLU_BILLING_LIVE_*` pre preview → live operácie nemožné |
| Vercel crony | bežia iba na produkčnom deploymente, nie na preview |
| Supabase branching / GitHub integrácia | iba default branch; produkčná história má verzie = čas aplikovania (nie názvy súborov) → integrácia neaplikuje migrácie automaticky |

## 2. Push a preview
- `git push` z prostredia Cowork je blokovaný (GitHub uploady nie sú povolené) → vetva **nie je na GitHube**.
- Preview nasadené cez Vercel REST API z presného stromu `git ls-files` (1278 súborov, bez `.env`, záloh a kľúčov): deployment `dpl_GCPCUpFvkjpJ5GSt4TDNmmUwozTg`, `target = preview`, `readyState = READY`, meta `githubCommitSha = 114cfdf…`.
- Build na Verceli so skutočným preview prostredím: `✓ Compiled successfully`, 61/61 statických stránok, bez chýb (žiadne fiktívne hodnoty).
- Preview `/login` → 200 (`x-robots-tag: noindex`, `data-dpl-id` = tento deployment). API routy preview sú za Vercel Authentication — bez „Protection Bypass for Automation“ ich nevieme volať.
- Produkcia po teste: posledný production deployment `dpl_7rkNSeF2…` = `12da726` (main), www.esblu.com 200.

## 3. Staging DB `esblu-test` — migrácie (apply_migration, obsah = súbor bajt po bajte, MD5 zhodné)
| Súbor | Verzia v DB |
|---|---|
| 20261120100000_internal_operator_entitlement | 20261119195939 |
| 20261121100000_retention_archive_company_termination | 20261119200324 |
| 20261122100000_einvoice_mandates | 20261119200527 |
| 20261122110000_einvoice_deregistration_jobs | 20261119200723 |
| 20261122120000_einvoice_ops_alerts | 20261119200836 |
| 20261123100000_billing_event_retry | 20261119200954 |
| 20261123110000_billing_invoice_documents | 20261119201244 |
| 20261123120000_billing_ops_alerts | 20261119201421 |
Advisors security: 0 ERROR pred aj po; nové INFO (deny-all tabuľky bez policy) a 2 WARN (zámerne authenticated RPC `esblu_einvoice_my_mandate`, `esblu_billing_is_ops_admin`).

## 4. Smoke testy na skutočnom Postgrese stagingu (všetko v transakcii s rollbackom, 0 zvyškov)
| Test | Výsledok |
|---|---|
| RLS mandátov (cudzia firma 0 riadkov, vlastná 3) | PASS |
| anon/authenticated → `esblu_retention.*`, `billing_invoice_documents`, `billing_ops_*`, `einvoice_ops_alerts`, `internal_operator_grants` | PASS (permission denied) |
| e-faktúra bez mandátu / s nepotvrdeným mandátom | PASS (`ESBLU_EINVOICE_MANDATE_REQUIRED`) |
| po potvrdení odoslanie povolené; odvolanie → znova zablokované; potvrdenie odvolaného → `MANDATE_REVOKED` | PASS |
| mandát firmy A neplatí pre B; grant bez finance.manage → `FORBIDDEN` | PASS |
| mandáty append-only (UPDATE/DELETE zamietnuté) | PASS |
| Stripe udalosť 2× rovnaké id → `duplicate`; iný payload → `payload_mismatch`; live udalosť na test DB → `ENVIRONMENT_MISMATCH` | PASS |
| retry plán (APPLY_FAILED → 5 min; MALFORMED → dead-letter) | PASS |
| snapshot odberateľa v účtovnej kópii; prepis IČO zamietnutý | PASS |
| zmazanie firmy → doklad ostáva so snapshotom; neskorý dobropis zdedí snapshot | PASS |
| DELETE účtovnej kópie (postgres aj service_role) zamietnutý | PASS |
| ukončenie firmy s finalizovanou faktúrou → archív (`retention_until` 2036-12-31) | PASS |
| purge dry-run / budúci dátum / neschválené lehoty → nič sa nezmaže | PASS |
| opakovaný synthetic purge → `already_completed`, archív nedotknutý; volanie s JWT → `OPERATOR_ONLY` | PASS |

## 5. ZABLOKOVANÉ — skutočný Stripe a eFaktura sandbox
Presné príčiny:
1. Egress z prostredia Cowork na `api.stripe.com` a `api.efaktura.sk` je blokovaný proxy (HTTP 000/403).
2. Preview prostredie nemá Stripe test kľúč, webhook secret ani `ESBLU_BILLING_MODE` pre túto vetvu; eFaktura sandbox kľúč (`ESBLU_EFAKTURA_API_KEY`, `ESBLU_EFAKTURA_WEBHOOK_SECRET`) nie je nikde vo Verceli.
3. Preview je za Vercel Authentication → Stripe/eFaktura webhooky naň nedoručia bez „Protection Bypass for Automation“.
4. Stripe CLI má iba anonymný sandbox (vyprší 2026-11-25); kľúč pomenovaného sandboxu „Esblu s.r.o.“ je v správcovi poverení Windows.
Bezpečné dokončenie: pozri `docs/release/esblu8-rollout-plan-2026-11-19.md` § 2.
