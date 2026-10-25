# PRE-LAUNCH TECHNICAL BLOCKERS + PRODUCTION MIGRATION RUNBOOK (2026-10-22)

Branch `preprod-release-candidate` (RC HEAD pri audite `f06abe9`), `main` = `901c46c` (produkcia, deployment
`dpl_3She4DWLcGnehbkZQmgh6PMZqjUr`, READY). Staging Supabase `cjbdijbbcujvmrzezusd` (`esblu-test`), produkčný
Supabase `fkpgvgvsmbpieduoatrt` (`assetpilot`).

**Nič z tohto dokumentu sa nespustilo na produkcii.** Produkcia bola iba čítaná (read-only SELECT cez Supabase MCP,
Vercel GET API). Žiadna migrácia, žiadny zápis, žiadny deploy, žiadna zmena env/secrets/plánu/billingu.

Súvisiace: `supabase/MIGRATIONS.md` (prečo nikdy `supabase db push`), `docs/einvoice-production-rollout-package-2026-10-08.md`
(eFaktúra precheck, backup B-1…B-3), `docs/supabase-explicit-grants-audit-2026-10-21.md` §7, `docs/team-granular-permissions-2026-10-23.md`.

---

## V. Vercel plán a 1-minútový cron

### V.1 Autoritatívne zdroje (read-only)

| zdroj | výsledok |
|---|---|
| Vercel REST `GET /v13/deployments/{id}` — produkčný deployment `dpl_3She4DWLcGnehbkZQmgh6PMZqjUr` (`901c46c`) | `"plan": "pro"` |
| Vercel REST `GET /v13/deployments/{id}` — RC Preview `dpl_HsxHfZrxfomRJnwgSR4FqMoxJnj8` (`66c4db2`) | `"plan": "pro"`, `readyState: READY`, `crons` = všetkých 8 záznamov z `vercel.json` vrátane `* * * * *` (build ich prijal) |
| Vercel Billing API `GET /v1/billing/charges` (tím `esblu`, 1 deň) | 802 FOCUS záznamov: `PricingCategory: Committed`, licencia „Additional Team Seats“, fakturované využitie (Fluid CPU/Memory, ISR) — signatúra platenej Pro fakturácie (Hobby nemá seat licencie ani fakturované využitie) |
| Vercel REST `GET /v9/projects/esblu` | `crons.enabledAt` nastavené, `disabledAt: null`; Fluid compute; región `fra1`; `functionDefaultTimeout 300` |
| Dokumentácia (sekundárne) `vercel.com/docs/cron-jobs/usage-and-pricing` (2026-07-15) | Pro: 100 cronov / projekt, **minimálny interval 1 minúta**, per-minute presnosť; Hobby: 1× denne, inak deployment zlyhá |

Scoped `VERCEL_TOKEN` nemá prístup k `GET /v2/teams/{id}` billing poliam (`team_unauthorized`) — plán sa preto
potvrdil cez deployment `plan` pole a billing ledger, nie cez team endpoint. Plán ani billing sa nemenili.

**VERCEL 1-MINUTE CRON: SUPPORTED** (tím `esblu`, plán **Pro**).

Limity (Pro): 100 cronov / projekt (RC používa 8); min. interval 1 min; Vercel cron **neopakuje** zlyhaný beh a pri
dlhom behu môže štartovať ďalšia inštancia súbežne → každý častý cron musí byť idempotentný a bezpečný pri súbehu
(nižšie); funkcia: Fluid, default 300 s, routes s `maxDuration = 60`. **Crony bežia iba na produkčnom deploymente**
— Preview (staging) ich nespúšťa; staging workery sa volajú ručne s `CRON_SECRET` (tak prebehol eInvoice staging E2E).

### V.2 Cron inventory (`vercel.json` na RC)

Produkcia (`main`) má dnes iba `deadline-notifications`. Ďalších 7 sa aktivuje až produkčným deployom RC.

| route | schedule | účel | env | CRON_SECRET | idempotentný | retry / súbeh |
|---|---|---|---|---|---|---|
| `/api/cron/deadline-notifications` | `0 6 * * *` | push upozornenia na STK/EK/známky/servis | prod (už beží) | áno (timingSafeEqual, ≥ 16 zn., 401) | áno — dedupe na termín × okno | bezpečný |
| `/api/cron/account-deletion-cleanup` | `30 3 * * *` | post-commit cleanup po zrušení účtu (Storage + auth user), max 20 jobov | prod po RC deployi | áno | áno — remove chýbajúcej cesty / deleteUser neexistujúceho nie je chyba; `attempts` < max | bezpečný; pri súbehu môže `attempts` narásť 2× (iba skorší stop retry — neškodné); bez tabuľky (pred migráciou) vracia `skipped: no_table` |
| `/api/cron/fx-rates` | `0 5,16 * * *` | import ECB referenčných kurzov | prod po RC deployi | áno | áno — rovnaký súbor = rovnaký SHA-256 | bezpečný; **vyžaduje migráciu `20261008100004` pred deployom** |
| `/api/cron/einvoice-outbound?mode=send` | `* * * * *` | odoslanie e-faktúr | prod po RC deployi | áno | áno — claim `FOR UPDATE SKIP LOCKED` + lease 120 s, 1 Idempotency-Key na pokus (provider TTL 24 h), rozpočet 50 s < `maxDuration` 60 s | bezpečný; bez provider env → `configured: false` (no-op) |
| `/api/cron/einvoice-outbound?mode=reconcile` | `*/5 * * * *` | doťahovanie stavu odoslaných | prod po RC deployi | áno | áno — rovnaký claim/lease | bezpečný; no-op bez env |
| `/api/cron/einvoice-events` | `*/5 * * * *` | fallback k webhookom (event feed s kurzorom) | prod po RC deployi | áno | áno — kurzor + lease, dedupe udalostí | bezpečný; no-op bez env |
| `/api/cron/einvoice-inbound` | `*/10 * * * *` | príjem nepotvrdených dokladov | prod po RC deployi | áno | áno — idempotentná registrácia, claim + lease | bezpečný; no-op bez env |
| `/api/cron/einvoice-maintenance` | `17 * * * *` | health, alert kandidáti, retencia webhook metadát 90 dní | prod po RC deployi | áno | áno — maže iba uzavreté webhook metadáta po retencii | bezpečný; kritický alert → HTTP 503 (viditeľné v monitoringu) |

Zámerne **nenaplánované**: `/api/cron/billing-reconcile`, `/api/cron/billing-store-reports` (billing OFF).

Formát: query string v `path` (`?mode=send`) Vercel prijal (Preview build READY, `crons` v deployment objekte
obsahuje oba `einvoice-outbound` záznamy) — route číta `mode` zo `searchParams`. Account deletion cleanup: denný,
kompatibilný s každým plánom.

Secrets (bez hodnôt): `CRON_SECRET` existuje ako **samostatné** Sensitive záznamy pre `production`, `preview` a
`preview`+`preprod-release-candidate` (rôzne env záznamy — Preview nepoužíva produkčný záznam). `ESBLU_EINVOICE_*`
existujú iba pre Preview branche (`einvoice-port`, `preprod-release-candidate`), **nie pre Production** → po RC
deployi sú eInvoice crony v produkcii no-op, kým vlastník nenastaví live env (⛔ hard stop).

---

## S. Signed URL — reálny HTTP test (staging)

Najkritickejší používateľský tok: súkromné médiá (`vehicle-photos`, `machine-photos`, `inventory-photos`,
`company-logos`) cez `lib/storage/signed-media.ts` (`createSignedUrls`, TTL `SIGNED_MEDIA_TTL_SECONDS = 3600`).
`einvoice-documents` nemá žiadnu `authenticated` politiku (iba service role cez server route).

### S.1 Vykonané (Claude, 2026-10-22) — skutočné HTTP požiadavky na `https://cjbdijbbcujvmrzezusd.supabase.co`

Z prehliadača (sandbox sieť Supabase blokuje); iba publishable kľúč stagingu, bez prihlásenia, bez zápisu.

| test | výsledok |
|---|---|
| Storage API verzia | `1.80.2` |
| `GET /object/public/{bucket}/…` pre všetky 4 media buckety + `ai-inbox-documents` + `einvoice-documents` | **400** `Bucket not found` (žiadny bucket nie je public) |
| D: anon `POST /object/sign/{bucket}/{path}` (syntetická cesta, všetky buckety) | **400** `Object not found` |
| D: anon sign **existujúceho** syntetického objektu (`einvoice-documents`, staging E2E XML) | **400** `Object not found`; batch sign → 200 s `error` „does not exist or you do not have access“, **bez URL** |
| anon `GET /object/authenticated/…` existujúceho objektu | **400** `Object not found` |
| anon `POST /object/list/{bucket}` (aj s prefixom existujúcej firmy) | 200 `[]` |
| anon `GET /bucket` | 200 `[]` |
| falošný token `GET /object/sign/…?token=<forged>` | **400** `InvalidJWT` „signature verification failed“ |
| bez tokenu `GET /object/sign/…` | **400** `querystring must have required property 'token'` |
| traversal `GET /object/public/vehicle-photos/..%2F..%2Feinvoice-documents%2Fx` | **400** `Bucket not found` |

DB stav stagingu (read-only): všetkých 8 bucketov `public = false`; storage politiky = produkčný model
(`media_*_scoped` cez `esblu_can_*_media_object`; upload odmieta `''`, `.`, `..` segmenty a vyžaduje
`<uid>/<entity uuid vlastnej firmy>/<súbor>`).

### S.2 Čaká na vlastníka — prihlásené kroky A, B, C, E, F, G

Prihlásenie heslom a práca s účtami na vzdialenom hoste Claude nevykonáva (pravidlo projektu, pozri
`scripts/m1-branch-http-smoke.ts`). Pripravený skript `scripts/storage-signed-url-http-smoke.ts` použije QA UX
fixtures (bez zmeny), vytvorí 1 syntetický PNG 1×1 ako rozpracovaný upload vlastníka firmy A a na konci ho zmaže
štandardným `remove()`. Odmietne iný ref než staging. Nevypisuje URL, token, kľúč, heslo ani e-mail.

```powershell
$env:SIGNED_URL_SUPABASE_URL = "https://cjbdijbbcujvmrzezusd.supabase.co"
$env:SIGNED_URL_ANON_KEY = "<staging publishable key>"
# „A“ = zdrojový používateľ IBA z Firmy A s právom uploadu (nie nutne owner); „B“ = používateľ IBA z cudzej Firmy B.
# Osobný účet vlastníka oboch QA UX firiem NIE JE vhodný. Heslá iba lokálne v
# "Claude outputs/STAGING-QA-signed-url-credentials.txt" (gitignored).
$env:SIGNED_URL_SOURCE_A_EMAIL = "qa-ux-a-signedurl@esblu-qa.invalid";  $env:SIGNED_URL_SOURCE_A_PASSWORD = "<zo súboru>"   # admin, iba QA UX Firma A
$env:SIGNED_URL_FOREIGN_EMAIL = "qa-ux-b-foreign@esblu-qa.invalid";     $env:SIGNED_URL_FOREIGN_PASSWORD = "<zo súboru>"    # employee, iba QA UX Firma B
# (staršie aliasy SIGNED_URL_OWNER_A_* / SIGNED_URL_OWNER_B_* stále fungujú)
# voliteľne: $env:SIGNED_URL_EMPLOYEE_A_EMAIL / _PASSWORD
node --experimental-strip-types --no-warnings scripts/storage-signed-url-http-smoke.ts
```

Očakávané: `PASS signed URL HTTP smoke: N ok, 0 fail`. Pokrýva: A owner A podpíše; B `GET` 200 `image/png` 67 B +
`HEAD` 200; E TTL tokenu `exp − iat = 3600`, claims ⊆ allowlist Supabase Storage (`exp,iat,url,scope`
[+ `transformations`, `versionId`]), `scope = "download"`, `url = <bucket>/<path>`, žiadny role/sub/aud/email/
session/service_role claim, URL neobsahuje anon ani service kľúč; 5 s URL po
expirácii ≥ 400; C používateľ cudzej firmy B: sign/batch/list/download DENY; D anon sign DENY, public URL ≠ 200; traversal varianty
DENY, upload s `..` DENY; zamestnanec A nepodpíše cudzí rozpracovaný upload; G po `signOut({scope:"global"})` —
zapíše sa reálne správanie (očakávané podľa Supabase: už vydaná URL platí do `exp`, starý access JWT platí do
svojej expirácie); F po `remove()` sa nová URL nevydá a stará vráti ≠ 200. Ak cleanup zlyhá, `finally` skúsi
znova a vypíše `FAIL cleanup` — vtedy objekt odstrániť ručne v Dashboarde (staging → Storage → vehicle-photos,
súbor `qa-signed-url-*.png`).

### S.3 Security zhrnutie

| požiadavka | stav |
|---|---|
| bucket nie je public | PASS (DB + HTTP, staging; produkcia DB read-only: 7/7 `public = false`) |
| objekt nemá public URL | PASS (HTTP 400 pre všetky buckety) |
| signed URL neobsahuje service-role secret | PASS — klient podpisuje vlastným JWT (`lib/supabase`), nikdy service role; reálny token (staging): claims `exp,iat,scope,url`, bez anon/service kľúča v URL |
| claim `scope` | legitímny, neprivilegovaný claim Supabase Storage (`supabase/storage` `src/internal/auth/jwt.ts`: `SIGNED_URL_SCOPE_DOWNLOAD = 'download'` / `'upload'`) — viaže token na jednu akciu; `GET /object/sign/…` overuje `verifyObjectSignature(token, path, 'download')`, takže download token nejde prehrať na upload endpoint. Nenesie identitu ani rolu. Smoke test vyžaduje `scope = "download"` a allowlist claimov |
| logy neobsahujú celý signed token | kód nikde neloguje `signedUrl`; smoke skript má `redact()` + statický test |
| TTL konzistentný s app configom | 3600 s (`SIGNED_MEDIA_TTL_SECONDS`); runtime overí S.2 (E) |
| cross-company object path | DB politika PASS (predošlý audit); HTTP pre prihláseného cudzinca → S.2 (C) |
| path normalization | upload politika odmieta `''`/`.`/`..`, vyžaduje entitu vlastnej firmy; klient `normalizeMediaPaths` odmieta URL a `/…` |
| vydaná URL po logout / revoke session | **zistené (staging):** už vydaná signed URL ostáva platná do svojho `exp` aj po `signOut({scope:"global"})` — token je samostatný, neviazaný na session (TTL 1 h ohraničuje okno). Platformové správanie, nemení sa |
| access JWT po logout | **zistené (staging):** starý access JWT môže zostať použiteľný do vlastnej expirácie (bezstavový JWT); global sign-out ruší refresh tokeny, nie už vydané access JWT |
| vydaná URL po zmazaní objektu | **zistené (staging):** po `remove()` už vydaná signed URL okamžite prestane vracať obsah (≠ 200) a nová URL sa nevydá — zmazanie objektu je okamžitý revoke obsahu |

Výsledok (owner, Windows, staging × RC `cdc3ff3`, QA identity `qa-ux-a-signedurl@…` / `qa-ux-b-foreign@…`):
**24 ok / 1 fail** — jediný FAIL bola príliš prísna assertion claimov (`exp,iat,url`), reálny token má navyše
legitímny `scope`. Všetky bezpečnostné kontroly (A, B, C, D, E, F, G, traversal, employee, cleanup) PASS.
Assertion opravená na allowlist + `scope = "download"` (bez zmeny storage/RLS) v `9da058c`.
**Rerun (owner, Windows, staging): `PASS signed URL HTTP smoke: 25 ok, 0 fail`** — signed URL HTTP test PASS,
cross-company isolation PASS. Cleanup PASS — syntetický objekt odstránený, QA fixtures nedotknuté.

---

## A. Precheck (read-only)

1. Overiť cieľ: Supabase MCP `list_projects` → `fkpgvgvsmbpieduoatrt` = `assetpilot`. Nikdy `esblu-test` / `skitze-protokoly`.
2. Spustiť `scripts/sql/prod-migration-precheck.sql` (blok `BEGIN-CHECKS … END-CHECKS` cez `execute_sql`, alebo celý
   súbor v psql — `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`). **Každé STOP = koniec okna.**
3. Spustiť `scripts/sql/einvoice-prod-precheck.sql` (detail eFaktúra reťazca; očakávané OK/INFO).
4. Zapísať do protokolu okna výstup oboch (iba počty a kódy, žiadne osobné údaje).

**Dry-run 2026-10-22 na produkcii (read-only): 0 STOP, 0 WARN** — 56 history riadkov, posledný
`20261005091000_private_media_buckets`, 0 RC migrácií, 9/9 legacy tabuliek, 61/61 pre-RC tabuliek, 0 z 36 RC
tabuliek, 0 neznámych tabuliek, 0 tabuliek bez RLS, politiky public 114 / storage 11, anon iba
`legal_documents:SELECT`, anon definer iba `esblu_get_invite_preview`, 0 TRUNCATE/TRIGGER/REFERENCES pre klientov,
0 definer bez `search_path`, 7/7 bucketov privátnych, každá firma presne 1 aktívny owner = `owner_id`, 0 používateľov
s viac ako 1 aktívnym členstvom (predpoklad backfillu `20261012140000`), 0 osirelých členstiev; INFO: 4 firmy /
6 aktívnych členov / 6 auth používateľov, 2 finalizované faktúry, 20 riadkov `company_entitlements`, 27 Storage objektov.

## B. Backup / recovery point

| položka | stav |
|---|---|
| Supabase organizácia `Esblu s.r.o.` | plán **Pro** (`get_organization`: `plan: pro`) → denné zálohy, prístupných posledných **7 dní** (Supabase docs „Database Backups“) |
| scheduled backups | **PASS** — overené vlastníkom 2026-10-22 v Dashboarde (`fkpgvgvsmbpieduoatrt` → Database → Backups): scheduled **physical** daily backups ACTIVE, predchádzajúce denné dostupné |
| PITR | **DISABLED / OPTIONAL ADD-ON** — nie blocker pre aktuálny RC; „Point in Time Recovery is available as an add-on“, neaktivované (platené, vyžaduje min. Small compute). Recovery point = posledná denná záloha (RPO až ~24 h) → preto povinný logický dump tesne pred oknom |
| posledný recovery point | **22 Oct 2026 02:38:07 UTC** (najnovší viditeľný scheduled backup pri overení). **V okne (krok I.3) znova potvrdiť čerstvý úspešný scheduled backup** (< 24 h, „Completed“) — inak STOP |
| logický dump tesne pred oknom | povinný (runbook eFaktúra B-2/B-3): `supabase db dump --db-url … -f prod-schema.sql` + `--data-only` → `sha256sum`, uložiť mimo repa |
| Storage súbory | **nie sú v DB zálohe** (iba metadáta). RC migrácie Storage súbory nemažú; nový bucket `einvoice-documents` vznikne prázdny |

Restore (Dashboard → Backups → Restore) = celá DB do bodu zálohy, projekt nedostupný počas obnovy, stratia sa
všetky zápisy po bode zálohy → iba `[SÚHLAS]` a iba ak SQL rollback nestačí.

## C. Presné poradie migrácií (43) — absent v produkcii

Zdroj: repo `supabase/migrations` × produkčná história (56 riadkov, read-only) × staging história (40 riadkov).
Aplikovať **po jednej** cez MCP `apply_migration` (`project_id = fkpgvgvsmbpieduoatrt`, `name` = názov súboru bez
`.sql`, SQL = obsah súboru). Nikdy `supabase db push`. Typ: S = iba schéma/funkcie/politiky, N = seed nových
tabuliek, B = backfill/zmena existujúcich dát. Rollback: RB = súbor `supabase/rollback/<name>_rollback.sql`,
HDR = postup v hlavičke migrácie, FN = predchádzajúca definícia funkcie (uložiť pred oknom), — = netreba.

| # | migrácia | skupina | typ | rollback | lossless | poznámka |
|---|---|---|---|---|---|---|
| 1 | `20260720000000_legacy_pre_migration_baseline` | G0 baseline | S | — | áno | CONDITIONAL — viď §J0 |
| 2 | `20261002100000_einvoice_foundation` | G1 eFaktúra | N | HDR | áno pred 1. e-faktúrou | seed `entitlement_catalog` + bucket `einvoice-documents` |
| 3 | `20261002110000_einvoice_en16931_fields` | G1 eFaktúra | S | HDR | áno pred 1. e-faktúrou | |
| 4 | `20261002120000_einvoice_outbound_flow` | G1 eFaktúra | S | HDR | áno pred 1. e-faktúrou | |
| 5 | `20261002130000_einvoice_inbound_flow` | G1 eFaktúra | S | HDR | áno pred 1. e-faktúrou | |
| 6 | `20261002140000_einvoice_operations` | G1 eFaktúra | S | HDR | áno pred 1. e-faktúrou | |
| 7 | `20261002150000_einvoice_rollout_gate` | G1 eFaktúra | S | HDR | áno | rollout allowlist fail-closed |
| 8 | `20261003100000_einvoice_inbound_draft_totals` | G1 eFaktúra | S | HDR | áno pred 1. prijatou | |
| 9 | `20261005100000_einvoice_partner_onboarding` | G1 eFaktúra | S | RB | áno pred onboardingom | |
| 10 | `20261005110000_einvoice_enroll_error_code_active` | G1 eFaktúra | S | HDR | áno | |
| 11 | `20261006100000_einvoice_supplier_dic_feed_cursor` | G1 eFaktúra | S | RB | áno | |
| 12 | `20261007100000_einvoice_event_ops_enroll_limit` | G1 eFaktúra | S | RB | áno | |
| 13 | `20261008100000_invoicing_sk_compliance` | G2 fakturácia/FX | S | RB | podmienečne | bez proforiem / odpočtov záloh |
| 14 | `20261008100001_invoicing_sk_trigger_fn_revoke` | G2 fakturácia/FX | S | FN | áno | iba revoke |
| 15 | `20261008100002_finance_helpers_bind_active_company` | G2 fakturácia/FX | S | FN | áno | uložiť `esblu_my_finance_view/manage` pred oknom |
| 16 | `20261008100003_fx_rate_date_exact` | G2 fakturácia/FX | S | RB | áno | |
| 17 | `20261008100004_fx_official_reference_rates` | G2 fakturácia/FX | S | RB | podmienečne | iba ak žiadny doklad nepoužil FX väzbu |
| 18 | `20261008100005_invoicing_corrections_payments_advances` | G2 fakturácia/FX | S | RB | podmienečne | iba bez finalizovaných dokladov s novými poliami |
| 19 | `20261008100006_einvoice_outbound_payment_received` | G2 fakturácia/FX | S | FN | áno | |
| 20 | `20261008100007_einvoice_correction_backlink` | G2 fakturácia/FX | S | RB | áno | |
| 21 | `20261008100008_received_advances` | G2 fakturácia/FX | S | RB | podmienečne | stratia sa väzby na zálohy |
| 22 | `20261008100009_taxed_advance_deduction_lines` | G2 fakturácia/FX | S | RB | podmienečne | iba bez finalizovanej konečnej faktúry s odpočtom |
| 23 | `20261008100010_received_advance_match_safeupdate` | G2 fakturácia/FX | S | RB | áno | |
| 24 | `20261008100011_einvoice_outbound_transport_ids` | G2 fakturácia/FX | S | RB | áno pred 1. odoslaním | inak strata transport ID |
| 25 | `20261008120000_subscriptions_platform` | G3 predplatné | N | RB | áno pri billing OFF | rollback hlavička „STAGING ONLY“ → v produkcii iba po revízii, inak restore/forward-fix |
| 26 | `20261008130000_client_mutation_idempotency` | G3 predplatné | S | RB | áno | rollback „STAGING ONLY“ (iba index + stĺpec) |
| 27 | `20261011120000_subscriptions_lifecycle_hardening` | G3 predplatné | S | RB | áno pri billing OFF | rollback „STAGING ONLY“ |
| 28 | `20261012090000_subscriptions_event_token_redaction` | G3 predplatné | N | RB | áno | update iba novej `billing_events` (prázdna) |
| 29 | `20261012091000_subscriptions_purchase_options_owned_methods` | G3 predplatné | S | RB | áno | |
| 30 | `20261012120000_account_deletion_subscription_guard` | G4 zrušenie účtu | S | RB | áno | |
| 31 | `20261012130000_account_deletion_post_commit_cleanup` | G4 zrušenie účtu | S | RB | podmienečne | stratia sa pending cleanup joby |
| 32 | `20261012140000_multi_company_workspaces` | G5 multi-company | B | RB | áno **iba kým nikto nemá 2. firmu** | backfill `user_active_company`; prepisuje 60 funkcií |
| 33 | `20261012150000_session_company_context_and_legal_entity_trial` | G5 multi-company | B | RB | áno (dáta ostávajú) | `companies.trial_policy = 'legacy'` pre existujúce firmy, `trial_claims` |
| 34 | `20261012160000_legal_entity_trial_final` | G5 multi-company | B | RB | áno (dáta ostávajú) | prepis iba novej `trial_claims` |
| 35 | `20261013100000_einvoice_company_deletion_guard` | G6 eFaktúra guard | S | RB | áno | |
| 36 | `20261021100000_explicit_data_api_grants` | G7 grants | S | RB | áno | presný návrat ACL (vrátane širokých grantov) |
| 37 | `20261022100000_grants_locale_and_policy_hygiene` | G7 grants | S | RB | áno | 27 politík `TO public` → `TO authenticated` |
| 38 | `20261023100000_team_granular_permissions` | G8 tímové oprávnenia | S | RB | áno **kým nie sú udelené oprávnenia** | rollback zmaže granty + audit |
| 39 | `20261025100000_ai_usage_metering` | G9 cost control | S | RB | áno (iba technická telemetria) | nová service-only tabuľka `ai_usage_monthly` + RPC; rollback zmaže počítadlá |
| 40 | `20261025110000_notification_deliveries_chat_retention` | G9 cost control | S | RB | áno | iba funkcia čistenia chat dedupe riadkov; nič nemaže sama |
| 41 | `20261026100000_pricing_entitlements` | G10 pricing + entitlements | N | RB | áno **kým nie je žiadny platený plán** | katalóg (trial limity), kanonické plány, výber plánu, usage počítadlá, storage RESTRICTIVE politika, backfill legacy ručných nárokov; `allow_mock_plans` = false |
| 42 | `20261026110000_pricing_entitlement_corrections` | G10 pricing + entitlements | S | RB | áno | J7 korekcie: Dokumenty 10 AI, 0 nových uploadov bez plánu (+ RESTRICTIVE UPDATE), eFaktúra half-units, rezervované miesta v prehľade |
| 43 | `20261027100000_intent_command_telemetry` | G11 intent fallback (J8) | S | RB | áno (iba technická telemetria) | `ai_usage_monthly` flow `intent_command` + service-only RPC `esblu_record_intent_command`; bez obsahu príkazov; rollback zmaže iba tieto počítadlá |

Mimo zoznamu (už v produkcii, nespúšťať): `20261001130000`, `20261005090000`, `20261005091000`. 37 legacy súborov
`20260721000100 … 20260830090000` nemá v produkcii history riadok (aplikované mimo trackera, MIGRATIONS.md §3) —
**nespúšťať**. 3 produkčné riadky bez repo súboru (`accountant_role_rpc_updates`,
`harden_accounting_handoff_grants`, `harden_client_role_privileges_anon_select_default`) — známy historický stav.

Dôležité: od **2026-10-30** Supabase neudeľuje novým tabuľkám v `public` Data API grants. Tabuľky z #2–#35
dostanú granty až v #36 → celé okno #1–#43 vykonať **v jednej relácii** a aplikačný deploy až po #43 + E.

### J0. Legacy baseline `20260720000000` — **CONDITIONAL (odporúčané APPLY ako no-op)**

- Každý z 9 objektov je v `if to_regclass(...) is null` — žiadny `ALTER`/`GRANT`/`DROP` mimo podmienky.
- Produkcia (read-only 2026-10-22): všetkých 9 tabuliek existuje → **no-op** (nič nevytvorí, nezmení politiky ani ACL).
- Staging ho aplikoval 2026-10-21 ako no-op → aplikovanie v produkcii zosúladí históriu so stagingom.
- Riziko konfliktu: žiadne, pokiaľ 9/9 existuje. **Ak precheck `legacy_baseline_tables_present ≠ 9` → STOP**
  (nespúšťať baseline — vytvoril by tabuľku v legacy tvare do zrelej schémy).

## D. Expected schema state po #43

- História: 56 + 43 = **99** riadkov; posledný `name = 20261027100000_intent_command_telemetry`.
- Tabuľky `public`: **97** = presne `supabase/grants/public-data-api-grants.json` (61 + 36), všetky RLS.
- Bucket `einvoice-documents` (private) navyše → 8 bucketov, všetky `public = false`.
- Funkcie / politiky / ACL: md5 == PGlite replay (`npm run test:grants-replay-db`) a == staging
  (`cjbdijbbcujvmrzezusd`, rovnaký postup ako J2/J4: `select proname, md5(replace(prosrc, E'\r','')) …`).
- `user_active_company`: 1 riadok na používateľa s aktívnym členstvom (dnes 6); `companies.trial_policy = 'legacy'` pre 4 existujúce firmy.
- `einvoice_rollout`: prázdne (fail-closed). `subscription_*`: iba katalóg; billing OFF.

## E. Grants verification (hneď po #43)

1. `scripts/sql/grants-data-api-matrix.sql` (read-only) → zhoda s manifestom; `anon` iba `legal_documents:SELECT`.
2. 0 TRUNCATE/TRIGGER/REFERENCES pre `anon`/`authenticated`; 0 SECURITY DEFINER bez `search_path`; anon EXECUTE iba
   zdokumentované výnimky.
3. `public` politiky: 0 `TO public` (okrem `legal_documents {anon,authenticated}`).
4. Supabase security + performance advisors: 0 nových ERROR.
5. PostgREST anon HTTP (publishable kľúč produkcie): `GET /rest/v1/companies` → `[]`/401, nikdy dáta.

## F. Targeted DB smoke (po E, pred aplikačným deployom)

V transakcii s `ROLLBACK` (vzor `scripts/sql/document-folders-rls-matrix.sql`), syntetické `request.jwt.claims`:
owner / admin / employee / accountant / cudzia firma / anon — čítanie firmy, faktúr, vozidiel, strojov, skladu;
billing owner-only; `esblu_my_has_permission` default deny; zrušenie účtu guard (dry). Žiadny trvalý zápis.

## G. Rollback poradie (po skupinách, opačne)

| skupina | rollback | lossless? | maže dáta? | kedy namiesto toho restore / forward-fix |
|---|---|---|---|---|
| G11 #43 | RB | áno | iba technické počítadlá príkazov (flow `intent_command`) | kedykoľvek; počítadlá sa stratia |
| G10 #42 → #41 | RB ×2 | áno, kým žiadna firma nemá kanonický platený plán | kompozícia plánov, hlasové počítadlá (staging mock) | po prvom platenom pláne: forward-fix |
| G9 #40 → #39 | RB ×2 | áno | iba technická AI usage telemetria (počítadlá) | kedykoľvek; počítadlá sa stratia |
| G8 #38 | RB | áno, kým nie sú udelené oprávnenia | áno — granty + audit oprávnení | po udelení oprávnení: forward-fix |
| G7 #37 → #36 | RB, RB | áno (ACL presne späť) | nie | preferovaný cielený grant fix namiesto rollbacku |
| G6 #35 | RB | áno | nie | — |
| G5 #34 → #33 → #32 | RB ×3 | áno, kým nikto nemá 2. firmu | nie (trial dáta ostávajú) | po vzniku 2. členstva: rollback by porušil index 1 aktívne/user → forward-fix |
| G4 #31 → #30 | RB ×2 | podmienečne | pending cleanup joby | ak existujú pending joby: dokončiť cron, potom rollback |
| G3 #29 → #25 | RB (hlavičky „STAGING ONLY“) | áno pri billing OFF | nie (entitlements sa nemažú) | v produkcii iba po revízii skriptu; inak forward-fix / restore |
| G2 #24 → #13 | RB / FN | podmienečne | väzby FX/zálohy/odpočty, transport ID | po finalizácii dokladu s novými poliami: **iba forward-fix** (finalizované doklady sú nemenné) |
| G1 #12 → #2 | RB / HDR | áno pred 1. e-faktúrou | nie business dáta | po prvej e-faktúre: forward-fix |
| G0 #1 | — | no-op | nie | — |

Zlyhanie migrácie N v okne: `apply_migration` beží v transakcii → N sa nezapíše; STOP, nepokračovať N+1;
predchádzajúce sú aditívne → forward-fix alebo rollback v opačnom poradí. Restore celej DB (B) iba pri
neočakávanej strate/poškodení existujúcich dát. Rollback sa **nesľubuje** pre stavy označené „podmienečne“ po tom,
čo podmienka prestala platiť.

## H. STOP conditions

STOP (nepokračovať, nič neopravovať „za behu“) ak:

- precheck vráti akékoľvek `STOP` (schéma ≠ očakávanie, história sa rozchádza, RC migrácia už čiastočne aplikovaná);
- neznáma tabuľka v `public`, ktorá nie je v grants manifeste;
- owner invariant zlyhá (firma bez presne 1 aktívneho ownera = `owner_id`) alebo existuje používateľ s > 1 aktívnym členstvom;
- migration history sa rozchádza s §C (počet, posledný názov);
- backup / recovery point nie je potvrdený vlastníkom (B);
- grants guard zlyhá (E) alebo md5 funkcií/politík/ACL ≠ replay;
- policy drift (počet/obsah politík ≠ očakávanie) bez vysvetlenia;
- kritický eFaktúra/billing stav nekonzistentný (`einvoice_rollout` nie je prázdne, `company_plan_values` mimo free/pro/admin, eFaktúra precheck STOP);
- akákoľvek migrácia vráti chybu;
- cieľový projekt ≠ `fkpgvgvsmbpieduoatrt`.

## I. Controlled apply window (neskôr — nespúšťa sa teraz)

| krok | akcia | súhlas |
|---|---|---|
| 1 | read-only precheck (A) — oba skripty, protokol | — |
| 2 | výslovný súhlas vlastníka s oknom a týmto runbookom | **[SÚHLAS vlastníka]** |
| 3 | backup/recovery potvrdenie (B) + logický dump + uloženie FN definícií (#14, #15, #19) | vlastník potvrdí |
| 4 | migrácie #1–#43 po jednej (C), po každej kontrola `schema_migrations` | **[SÚHLAS]** (krok 2) |
| 5 | grants verification (E) + advisors | — |
| 6 | targeted DB smoke (F) | — |
| 7 | aplikačný deploy: merge RC → `main` až teraz, deployment spárovaný podľa SHA, READY | **[SÚHLAS — merge/deploy]** |
| 8 | post-deploy smoke (J) | — |
| 9 | final sign-off (protokol: history, md5, smoke, deployment uid) | vlastník |

Mimo okna (samostatné súhlasy): live eFaktúra env/webhook, billing provideri, ECB import kontrola po prvom behu
cronu, pilot. Ak treba vrátiť aplikáciu: Vercel Instant Rollback na `dpl_3She4DWLcGnehbkZQmgh6PMZqjUr` — DB môže
ostať (nové objekty bez provider env sú no-op; starý `main` nové tabuľky nepoužíva).

## J. Post-migration / post-deploy smoke (produkcia, bez live provider transakcií)

- [ ] login (email) + session restore
- [ ] aktívna firma = správna; prepínač firiem (pri 1 firme skrytý / neutrálny)
- [ ] role access: owner, employee (existujúce účty) — menu a moduly podľa roly
- [ ] dashboard „Dnes“ načíta bez chyby (Urgentné/Dnes/Čoskoro/Info)
- [ ] faktúry: zoznam + detail existujúcej finalizovanej faktúry (iba čítanie)
- [ ] vozidlá: zoznam + detail (čítanie)
- [ ] stroje: zoznam + detail (čítanie)
- [ ] sklad: zoznam (čítanie)
- [ ] storage signed URL: fotka/logo sa zobrazí (podpísaná URL, HTTP 200), public URL ≠ 200
- [ ] billing: Predplatné viditeľné iba vlastníkovi; billing OFF → žiadna platba
- [ ] eFaktúra readiness: stav „pripravujeme“/neaktivované, `einvoice_rollout` prázdne — **žiadne odoslanie**
- [ ] granular permissions: zamestnanec bez grantov nevidí „Pridať stroj“; owner vidí editor oprávnení (bez uloženia)
- [ ] account deletion guard: dialóg zrušenia sa otvorí a pri aktívnom predplatnom/eFaktúre blokuje (bez potvrdenia)
- [ ] Vercel Crons (Settings → Cron Jobs): 8 záznamov; prvé behy eInvoice → `configured: false`; fx-rates 200
- [ ] runtime errors (Vercel `get_runtime_errors`) bez nových 5xx 30 min po deployi

## K. Kto čo schvaľuje

| akcia | kto |
|---|---|
| spustenie okna, produkčné migrácie | vlastník (výslovne, písomne v chate) |
| potvrdenie zálohy / PITR | vlastník (Dashboard) |
| merge RC → `main`, produkčný deploy | vlastník |
| produkčné env/secrets, live eFaktúra, billing, store, reviewer účet, `assetlinks.json` | vlastník — samostatne, mimo tohto okna |
| restore DB | vlastník |
| rollback migrácií označených „podmienečne“ | vlastník po vyhodnotení podmienky |
