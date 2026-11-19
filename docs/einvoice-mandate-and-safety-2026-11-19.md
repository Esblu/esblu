# E-Faktúra: elektronické poverenie (mandát), bezpečnostné brány a offboarding (2026-11-19)

**Vetva:** `ops/esblu8-p3` (z `ops/esblu8-readiness`). **Nič nie je nasadené ani aplikované** na staging/produkciu.
Nadväzuje na `docs/audits/efaktura-readiness-audit-2026-11-19.md` (nálezy D-M1, D-M2, D-M3, D-G2, D-O1, T1, T7).
Nie je to právne stanovisko — texty vyhlásení a retencia sú rozhodnutia prevádzkovateľa / CLIA.

## 1. Čo už existovalo (overené v kóde) vs. čo bolo doplnené

| # | Požiadavka | Existovalo (overené) | Doplnené v tejto vetve |
|---|---|---|---|
| 1 | Trvalý záznam poverenia | iba `einvoice_enroll_attempts` (30 dní, bez textu vyhlásenia, bez roly); `confirm_enroll:true` sa iba overil | tabuľka `einvoice_mandates` (append-only), RPC grant/confirm/revoke, zápis v enroll toku, route `/api/einvoice/mandate` (stav / opätovné udelenie / odvolanie) |
| 2 | Bez účinného mandátu nič neodoslať | brány: finance.manage, nárok, rollout, readiness, príjemca | **DB:** BEFORE INSERT + BEFORE UPDATE trigger na `einvoice_outbound`, mandát v `esblu_einvoice_claim_outbound('send')`; **app:** `requestOutboundForInvoice` → 403 `MANDATE_REQUIRED` pred volaním poskytovateľa |
| 3 | Izolácia tenantov | RLS `company_id = aktívna firma AND finance.view`; employee hard false | testy owner / admin bez financií / admin s finance.manage / účtovník / employee / iný tenant pre `companies`, `invoices`, `einvoice_*` vrátane nových tabuliek |
| 4 | Audit a dôkazy doručenia | `einvoice_events` append-only, outbound evidence allowlist, transport ID write-once, `company_terminations`/`company_export_runs` bez FK | nové tabuľky bez FK (prežijú výmaz firmy), DELETE/TRUNCATE zakázané aj pre service_role, rollbacky archivujú do `esblu_audit_archive`; test: dôkazy prežijú termination |
| 5 | Offboarding u poskytovateľa | **nebolo** (`peppol/deactivate` sa nevolal; termination pri registrácii zablokovaná) | `deactivatePeppol` v adaptéri, job `einvoice_deregistrations` so stavovým automatom a retry, napojenie na ukončenie firmy a hodinový cron |
| 6 | Alerty kredit / integrácia | 402 → `EINVOICE_PROVIDER_INSUFFICIENT_CREDIT` (terminálne `failed`); `usage.limit_exceeded` **ignorovaný**; health kandidáti bez perzistencie | `einvoice_ops_alerts` s dedupe + renotifikáciou, alert z workera (402/401/403/konfigurácia), z webhooku/feedu (`usage.limit_exceeded`), z deregistrácie a z maintenance; otvorený kritický alert → maintenance cron 503 |
| 7 | Duplicity | (1) RPC: aktívny pokus vráti existujúci + advisory lock, (2) DB: `idempotency_key` UNIQUE, `(invoice_id, attempt)` UNIQUE, partial UNIQUE 1 aktívny pokus/faktúru, kľúč a väzba nemenné, nový pokus pri neistom výsledku zakázaný, (3) poskytovateľ: Idempotency-Key 24 h + dedupe SHA-256/čísla | overené (existujúce testy dvojklik / súbežnosť / replay); doplnené priame DB testy: duplicitný kľúč, duplicitný `(invoice, attempt)` aj pre terminálny stav, nemennosť kľúča a väzby |

## 2. Mandát (`einvoice_mandates`, migrácia `20261122100000`)

Stĺpce: `company_id` (bez FK), `provider`, `environment`, `scope` (`send` / `receive`), `granted_by_user_id` + **snapshot**
`granted_by_name` / `granted_by_email` / `granted_by_role` (z `auth.users` a `company_members` v čase udelenia),
`statement_version`, `statement_sha256`, `statement_locale`, `authority_confirmed` (vždy true — text obsahuje vyhlásenie
o oprávnení konať za firmu, D-M2), `grant_channel` (`enroll` / `regrant` / `operator_backfill`), `provider_org_id`,
`participant_id`, dôkazy `request_id`, `ip_sha256`, `user_agent_sha256`, časy `granted_at` / `effective_at` / `revoked_at`
(DB čas), `effective_scope`, `provider_outcome`, `provider_response_sha256`, `revoked_by_kind`
(`user` / `operator` / `provider_event` / `deregistration` / `system`), `revoked_by_user_id`, `revocation_reason_code`.

- **Nikdy** sa neukladá overovací kód FS (ani hash). IP a User-Agent iba ako SHA-256 (IP so soľou viazanou na firmu) —
  pseudonymizovaný osobný údaj, nie anonymizácia.
- Text vyhlásenia = i18n kľúč `invoices.einvoice.reception.confirm` (sk/en/de), verzia `efaktura-mandate-2026-11-19`
  (`lib/einvoice/mandate-statement.ts`). Hash = SHA-256(`verzia\njazyk\ntext`). Test pripína hashe — zmena textu bez novej
  verzie zlyhá. Klient posiela `mandate_version`; iná verzia → 409 `MANDATE_STATEMENT_OUTDATED`.
- Append-only: INSERT iba cez RPC (bez effective/revoked), UPDATE iba write-once `effective_*` a `revoked_*`,
  odvolaný mandát sa nedá znova aktivovať, DELETE/TRUNCATE nikdy (ani `postgres`/service_role).
- RLS: SELECT iba aktívna firma + `finance.manage` (owner, účtovník, admin s oprávnením). Employee, admin bez financií,
  iný tenant: 0 riadkov. Klient nemá INSERT/UPDATE ani EXECUTE na grant/confirm/revoke.
- `esblu_einvoice_my_mandate(env)` — stav pre UI/app-level kontrolu (finance.view).

**Toky**
1. **Enroll** (`POST /api/einvoice/reception/enroll`, telo `{verification_code, confirm_enroll:true, mandate_version}`):
   oprávnenia → provision → limit pokusov → **zápis udelenia** (ak zlyhá: 500 `MANDATE_RECORD_FAILED`, enroll sa nevolá)
   → enroll u poskytovateľa → úspech: `confirm` (enrolled/skipped = send+receive, send_only = send, SHA-256 surovej
   odpovede enroll) / neúspech: odvolanie `system` s kódom chyby.
2. **Opätovné udelenie** (`POST /api/einvoice/mandate {action:"grant", confirm_mandate:true, mandate_version}`): iba pre
   už registrovanú org (nie deactivated), overenie `GET /v1/agent/organizations/{id}`, hash normalizovanej odpovede.
   Slúži aj na doplnenie mandátu existujúcim staging firmám.
3. **Odvolanie** (`{action:"revoke", confirm_revoke:true}`, finance.manage) → od tejto chvíle sa nič nové neodošle.
   Registrácia u poskytovateľa ostáva (odregistrovanie = bod 5).
4. **participant.deactivated** (zmena PDS / odvolanie na PFS) → trigger odvolá mandáty (`provider_event`,
   `PARTICIPANT_DEACTIVATED`) — D-M3.

**Brána odosielania:** INSERT pokusu bez účinného `send` → `ESBLU_EINVOICE_MANDATE_REQUIRED`; claim workera vynechá
čerstvé riadky bez mandátu; obranný UPDATE trigger zablokuje čerstvý prechod do in-flight. **Výnimka (vedomá, rovnaká
ako pri nároku):** riadok s neistým výsledkom smie zopakovať TEN ISTÝ Idempotency-Key — poskytovateľ vráti uloženú
odpoveď, druhé odoslanie nevznikne.

## 3. Deregistrácia (`einvoice_deregistrations`, migrácia `20261122110000`)

Stavový automat (vynútený triggerom): `requested → in_progress → completed | retry_wait | failed`, `retry_wait → in_progress`,
`failed → requested` iba operátor (`esblu_einvoice_deregistration_requeue(job, '<operátor/ticket>')`). Najviac jeden
otvorený job na `(provider, environment, provider_org_id)`; požiadavka je idempotentná a **hneď odvolá mandáty**.
Iba owner (`company_members.role='owner'` + `companies.owner_id`) alebo operátor s identitou.

Volanie: `POST /v1/agent/organizations/{id}/peppol/deactivate` (podľa `docs/einvoice-production-provider-checklist.md`).
2xx → `completed`: snapshot mapovania (`org_snapshot`: org/participant ID, stavy, `onboarding_snapshot`, časy) sa uloží
do jobu a riadok `einvoice_organizations` sa zmaže — tým sa odblokuje `esblu_company_deletion_retention_blocker`
aj `esblu_company_termination_commit` **bez zmeny týchto funkcií** (žiadny konflikt s paralelnou úlohou archívu).
409 (rozbehnuté prenosy), 429, 5xx, sieť, 402, 401/403 → `retry_wait` (backoff 2^n min, strop 6 h, max 12 pokusov;
402/401/403 aj alert). 404 a iné 4xx → `failed` + kritický alert (nikdy sa nepredpokladá úspech).

**Ukončenie firmy** (`POST /api/account/delete`, owner, `termination.confirmed`): po všetkých kontrolách (owner, predplatné,
forfeit) a **pred** výmazom: `ensureCompanyDeregistered` (zaradí job + jeden okamžitý pokus). Nedokončené → 409
`EINVOICE_DEREGISTRATION_PENDING` (klient zopakuje; job dobehne v `/api/cron/einvoice-maintenance`, hodinovo), trvalá chyba
→ 409 `EINVOICE_DEREGISTRATION_FAILED` (operátor). Po dokončení sa blocker vyhodnotí znova; `EINVOICE_PROVIDER_ENROLLED`
už nie je koncový stav (termination_available = true).

## 4. Prevádzkové alerty (`einvoice_ops_alerts`, migrácia `20261122120000`)

Kódy: `PROVIDER_INSUFFICIENT_CREDIT` (402), `PROVIDER_USAGE_LIMIT_EXCEEDED` (webhook/feed `usage.limit_exceeded`),
`PROVIDER_AUTH_FAILED` (401/403), `PROVIDER_CONFIG_INVALID`, `DEREGISTRATION_FAILED`, `MAINTENANCE_CRITICAL`.
Dedupe: jeden otvorený záznam na `code:prostredie:firma|platform`; opakovanie iba zvýši `occurrences`;
notifikácia pri vzniku a potom najskôr po 6 h. Úspešné odoslanie automaticky uzavrie kredit/auth alert.

**Kanál:** Esblu nemá e-mailový ani operátorský notifikačný mechanizmus (push je iba pre používateľov firiem) →
(a) záznam v DB, (b) jeden riadok `[einvoice-ops-alert] {code, severity, environment, detail, occurrences}` v serverovom
logu (`lib/ops-alert-log.ts`, mimo `lib/einvoice`, bez firmy a obsahu), (c) otvorený kritický alert → `/api/cron/einvoice-maintenance`
vráti 503 (monitoring cronu). Žiadna nová platená služba. Odporúčanie: Vercel log alert / drain na `[einvoice-ops-alert]`.
Uzavretie operátorom: `select public.esblu_einvoice_ops_alert_resolve('<CODE>', '<env>', null, '<operátor>');`.

Politika 402 sa **nemenila** (pokus ostáva terminálne `failed`, nový pokus = operátorská akcia) — iba pribudol alert.

## 5. Archivovateľnosť (koordinácia s retenčným archívom pri ukončení firmy)

Nové dôkazové tabuľky `einvoice_mandates`, `einvoice_deregistrations`, `einvoice_ops_alerts`: kľúč `company_id`
(alerty môžu mať `null` = platforma), **bez FK** na `companies`, prežijú termination (overené testom), DELETE/TRUNCATE
zakázané. Archívna úloha ich môže kopírovať podľa `company_id`; fyzické mazanie (retenčná purge) bude vyžadovať
samostatnú migráciu, ktorá upraví guard trigger — **rozhodnutie o retencii nie je súčasťou tejto vetvy.**
Existujúci problém D-G1 (termination maže `einvoice_events` a outbound evidence) táto vetva **nerieši** — patrí
paralelnej úlohe archívu.

## 6. Migrácie a rollback

| Migrácia | Rollback | Poznámka |
|---|---|---|
| `20261122100000_einvoice_mandates.sql` | `supabase/rollback/20261122100000_einvoice_mandates_rollback.sql` | vráti claim na 20261002150000; neprázdna tabuľka → `esblu_audit_archive.einvoice_mandates_rb_<ts>` |
| `20261122110000_einvoice_deregistration_jobs.sql` | `…_einvoice_deregistration_jobs_rollback.sql` | neprázdna → archív; zmazané mapovania sa neobnovujú (ostávajú v `org_snapshot`) |
| `20261122120000_einvoice_ops_alerts.sql` | `…_einvoice_ops_alerts_rollback.sql` | neprázdna → archív |

Poradie rollbacku: 120000 → 110000 → 100000. Granty sú v `supabase/grants/public-data-api-grants.json`
(grants replay + guard PASS). **Po aplikovaní v prostredí so živými firmami treba mandát doplniť** (enroll alebo
`/api/einvoice/mandate` grant), inak sa odosielanie zastaví (zámerne fail closed). Produkcia má 0 `einvoice_*` riadkov → bez dopadu.

## 7. Testy (lokálne, PGlite + mock poskytovateľ; žiadna sieť)

| Sada | Výsledok |
|---|---|
| `npm run test:einvoice-mandate-db` (nová, čistý replay všetkých migrácií) | 27/27 |
| `npm run test:einvoice-mandate` (nová, unit, mock provider) | 13/13 |
| einvoice-reception 27, -outbound 54, -ops 23, -inbound 56, -partner 23, -hardening 19, -efaktura 20, -ui 54, -db 44, multi-company-einvoice-db 10, production-gate 8, staging-guard 10, prod-precheck 6, l3-inbound-one 16 | PASS |
| e2e-selftest `{PASS:27, PARTIAL:1}` (ako baseline), partner-e2e-selftest `{PASS:27}` | PASS |
| company-termination 10, company-termination-db 20, grants-replay-db 43, grants-guard 10, idempotency-db 26, i18n 114 | PASS |
| `tsc --noEmit` | 126 chýb = presne baseline (chýbajúce typy `next`/`openai` v zdieľanom `node_modules`), 0 nových |
| clia-gdpr | 16/1 — **predexistujúce** zlyhanie (`esblu.audit` v cookies inventári), rovnaké na baseline |

Staršie sady, ktoré testujú iné vrstvy, dostali migráciu mandátu + testovací seed (`scripts/einvoice-mandate-test-seed.ts`,
iba PGlite). Reception testy idú skutočnou cestou (RPC grant/confirm/revoke).

## 8. Sandbox eFaktura.sk

- Base URL v repo: `https://api.efaktura.sk` (sandbox aj live — prostredie určuje prefix kľúča).
- Z tohto prostredia: `curl` bez credentials → **proxy 403 po CONNECT** (egress blokovaný) → nedostupné.
- `.env.local` v hlavnom repe neobsahuje žiadne `ESBLU_EFAKTURA_*` / `ESBLU_EINVOICE_*` premenné; vo worktree `.env.local` nie je.
- **Sandbox smoke sa preto nespúšťal.** Musí bežať v stagingu / u operátora:

```powershell
# koreň worktree, sandbox kľúč efk_pk_test_… v .env.local (nikdy live)
node --env-file=.env.local --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs `
  scripts/einvoice-deregistration-sandbox-smoke.ts --confirm-sandbox --org=<SANDBOX_ORG_ID>
# deaktivácia IBA syntetickej org založenej na tento účel (nie A/B E2E org):
#   ... --allow-deactivate=<THROWAWAY_SANDBOX_ORG_ID>
# Existujúci A/B sandbox E2E (enroll, send, receive) bez zmeny:
node --env-file=.env.local --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs `
  scripts/einvoice-partner-sandbox-e2e.ts --confirm-sandbox
```

Overiť v sandboxe: (1) presnú cestu/metódu `peppol/deactivate` a tvar odpovede (2xx vs. 409 pri opakovaní, 404),
(2) či deaktivácia je nebillovaná, (3) tvar `usage.limit_exceeded` (`data.mode`, `orgId`).
Staging E2E po aplikovaní migrácií: enroll cez UI/route → riadok v `einvoice_mandates` (effective) → odoslanie OK →
`POST /api/einvoice/mandate {action:"revoke"}` → odoslanie 403 `MANDATE_REQUIRED` → regrant → OK → termination
syntetickej firmy → job `completed`, `einvoice_organizations` bez riadku, mandáty a job ostávajú.
Pozn.: `app/api/einvoice/staging-e2e` op `enroll` volá `enrollCompany` priamo (bez dôkazu) — pre outbound kroky použiť
op cez HTTP reception route alebo regrant.

## 9. Rozhodnutia pre prevádzkovateľa

1. **Text poverenia** (sk/en/de) bol rozšírený o vyhlásenie o oprávnení konať za firmu a poverenie Esblu — schváliť / upraviť s CLIA (zmena = nová verzia).
2. Kto smie udeliť mandát: dnes `finance.manage` (owner, účtovník, admin s oprávnením); deregistráciu iba owner. Obmedziť udelenie na ownera?
3. **Retencia** `einvoice_mandates` / `einvoice_deregistrations` / `einvoice_ops_alerts` (vrátane pseudonymizovaného IP hashu) a jej zosúladenie s archívom pri ukončení firmy (D-G1).
4. Politika 402: ponechať terminálne `failed` + alert, alebo meniť na „hold“ do doplnenia kreditu.
5. Alert kanál: nastaviť Vercel log alert / drain na `[einvoice-ops-alert]` (alebo iný existujúci kanál).
6. Frekvencia deregistračného jobu: dnes hodinový maintenance cron (+ okamžitý pokus v route); `vercel.json` sa nemenil.
7. Deregistrácia je nevratná aj keď následný výmaz firmy zlyhá (napr. iná kontrola) — akceptovať, alebo pridať samostatné potvrdenie.
8. UI pre odvolanie / opätovné udelenie mandátu (dnes iba API) a notifikácia ownera pri `participant.deactivated`.
