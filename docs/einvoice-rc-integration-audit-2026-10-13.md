# eInvoice → preprod RC — integration audit (2026-10-13)

Stav: **AUDIT HOTOVÝ, MERGE HOTOVÝ (2026-10-13, izolovaný klon mimo Windows mountu).** Výsledok integrácie,
konflikty, reconciliation migrácia a test/build matica: **§12**. Staging (§10, §11.9) ani produkcia sa v tomto
bloku nedotkli.

## 1. Baseline

| | commit |
|---|---|
| `preprod-release-candidate` (lokálne = origin) | `bc96307` |
| `einvoice-port` (lokálne = origin) | `58d5a00` |
| merge-base | `50526a7` (feat(company-lookup)) |
| commity od merge-base | eInvoice 53, RC 68 |
| `main` / `mobile-platform` | `901c46c` / `76ad27f` (nedotknuté) |

Pokus o `git merge --no-commit einvoice-port` v RC worktree na pomalom Windows mounte bol prerušený
časovým limitom (bez MERGE_HEAD). Worktree bol vrátený do čistého stavu `bc96307` (obnovené zmenené
súbory, odstránené nesledované súbory z merge, odstránený `index.lock`). Overené `git status` = čistý.

## 2. Rozsah zmien

- eInvoice mení 213 súborov, RC 398; **prekryv 18 súborov** (očakávané konflikty):
  `.gitignore`, `app/ai-evidencia/ReceivedInvoiceReview.tsx`, `app/api/account/delete/route.ts`,
  `app/faktury/InvoiceDetailView.tsx`, `app/faktury/new/page.tsx`, `app/faktury/page.tsx`,
  `app/nastavenia/page.tsx`, `lib/app-routes.ts`, `lib/business-partners.ts`, `lib/i18n/dictionaries/{sk,en,de}.ts`,
  `lib/invoices.ts`, `mobile/package.json`, `package.json`, `package-lock.json`,
  `scripts/plan-entitlements-tests.ts`, `vercel.json`.
- Nové eInvoice časti (bez konfliktu): `lib/einvoice/**`, `lib/fx/**`, `lib/invoicing/{advance-summary,settlement,sk-deadlines}.ts`,
  `app/api/einvoice/**`, `app/api/cron/{einvoice-*,fx-rates}`, `app/api/invoices/[id]/{einvoice,einvoice-readiness,ubl}`,
  `app/faktury/efaktury/**`, `app/components/{einvoice,invoicing}/**`, docs.

### Pravidlá riešenia konfliktov

| súbor | rozhodnutie |
|---|---|
| `app/api/account/delete/route.ts` | **RC verzia** (orchestrácia DB-first, multi-company druhy). eInvoice pridal `countCompanyAccountingRecords` (blokovanie firmy s finalizovanými faktúrami / e-faktúrami) — **presunúť do DB** (reconciliation migrácia §5) + preflight kód. |
| `app/nastavenia/page.tsx` | RC (CompanySwitcher, Identita firmy, zrušenie) + eInvoice sekcia (prijímanie e-faktúr) |
| `lib/i18n/dictionaries/*` | zjednotenie oboch kľúčových stromov (`workspaces.*`, `einvoice.*`) |
| `vercel.json` | zjednotenie cronov (§9) |
| `package.json` / lock | zjednotenie `test:*` skriptov (RC 75 + eInvoice sady), deps eInvoice (fast-xml-parser…) |
| `lib/app-routes.ts` | zjednotiť `MOBILE_STATIC_ROUTES` (`/firmy/nova` + `/faktury/efaktury`) |
| ostatné faktúry / partneri | eInvoice verzia + RC zmeny (aktívna firma z DB, žiadne `maybeSingle` nad `company_members`) |

## 3. Migration DAG / poradie

eInvoice migrácie majú verzie **pred** RC multi-company migráciami:

```
… 20261001130000 push session binding (prod ✓)
  20261002100000 … 20261007100000   eInvoice foundation → event ops   (11)
  20261005090000, 20261005091000      media model (prod ✓)
  20261008100000 … 20261008100011   invoicing SK compliance, finance helpers bind active company,
                                     FX, corrections/payments/advances, eInvoice correction/transport (12)
  20261008120000 … 20261012091000   subscriptions (5)
  20261012120000, 20261012130000     account deletion guard / post-commit cleanup
  20261012140000                     multi-company
  20261012150000                     session context + legal-entity trial
  20261012160000                     legal-entity trial final
  [NEW] 20261013100000               eInvoice ↔ account deletion reconciliation (§5)
```

**Overené na stagingu (reálny Postgres, ktorý už má eInvoice + 120000–160000):**

- 140000 prepisuje 60 funkcií z produkčných tiel. Porovnanie staging (eInvoice) vs produkcia (whitespace-normalizované):
  líšia sa iba `esblu_my_finance_view` / `esblu_my_finance_manage` — eInvoice `20261008100002` ich už viazal na
  `esblu_my_active_company_id()`; 140000 robí sémanticky to isté. **140000 neprepisuje žiadnu eInvoice logiku späť.**
- Žiadna eInvoice funkcia neobsahuje „moje členstvo cez `company_members` + LIMIT 1". Všetky klientske eInvoice /
  invoicing RPC (`esblu_einvoice_my_rollout`, `esblu_add_invoice_payment`, `esblu_invoice_settlement`,
  `esblu_received_*`, `esblu_set_invoice_advance_deductions`, …) idú cez `esblu_my_active_company_id()` +
  `esblu_my_finance_*` → **automaticky per-session** (150000). Service-role funkcie berú `company_id` explicitne
  (z mapovania provider org → firma).
- eInvoice RLS: všetky `einvoice_*` tabuľky majú iba SELECT politiku `company_id = esblu_my_active_company_id() AND esblu_my_finance_view()`;
  zápisy iba cez SECURITY DEFINER / service role.

**Produkcia:** eInvoice migrácie majú staršie verzie než už aplikované `20261005090000/091000` → pri aplikovaní
cez Supabase CLI treba `--include-all`; odporúčané aplikovať **po jednej cez schválený postup v presnom poradí vyššie**
(rovnako ako staging). Historické migrácie sa nemenia.

## 4. Multi-company / session scoping eInvoice — výsledok (staging DB, rollback, bez providera)

SZČO scenár (Y = employee ABC + owner „Ján Novák SZČO"; PC session = ABC, mobil session = SZČO, súčasne):

| kto / session | vidí org | inbound | webhooky | rollout |
|---|---|---|---|---|
| Y PC (ABC, employee) | — | — | — | false |
| Y mobil (SZČO, owner) | SZČO | SZČO | SZČO | true |
| ABC owner | ABC | ABC | ABC | false |
| ABC accountant | ABC | ABC | ABC | false |
| ABC finance admin | ABC | ABC | ABC | false |
| cudzí owner | iba vlastné | iba vlastné | — | false |

Finance admin (eInvoice prístup) **nemá** billing (`can_manage=false`) → billing authority ≠ finance/eInvoice access
(bez zmeny business pravidiel). Predchádzajúci staging QA (2026-10-13) potvrdil to isté pre `einvoice_organizations` /
`einvoice_inbound` pri prepínaní zariadení.

TS kód (einvoice-port): používateľské routy berú firmu výhradne z `esblu_my_active_company_id()` cez user-scoped
klienta (JWT so `session_id`) — `lib/einvoice/readiness-server.ts`, `ui/reception-server.ts`, `app/api/invoices/[id]/ubl`,
`/pdf`; odoslanie (`outbound/request.ts`) načíta readiness pod RLS volajúceho a až potom service role. Žiadne
`from("company_members")…maybeSingle()`. Webhook / crony = service role, firma z provider org mapovania.

## 5. Nález: zrušenie firmy × eInvoice (LEGAL/ACCOUNTING/CLIA DECISION REQUIRED)

FK `einvoice_organizations/outbound/inbound/webhook_events/events/rollout/enroll_attempts → companies` = **CASCADE**.
Ochrany, ktoré dnes existujú: `invoices` delete guard (finalizované) a `einvoice_events` guard (append-only, blokuje DELETE)
→ firma s finalizovanou faktúrou alebo s akoukoľvek e-faktúrou sa **nedá zmazať** (fail-closed, ale surová DB chyba,
nie čistý kód). **Diera:** firma len **enrollnutá** u providera (org s `provider_org_id`, bez dokumentov/udalostí) sa zmaže
kaskádou → identita u providera ostane osirotená (bez deaktivácie). XML v buckete `einvoice-documents` nie sú v
`storage_targets` zrušenia.

**Návrh reconciliation migrácie `20261013100000_einvoice_company_deletion_guard.sql` (implementovať + testovať v
ďalšom sedení):** v `esblu_account_deletion_commit('owner', …)` pred mazaním fail-closed
`ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION`, ak firma má finalizovanú faktúru, `einvoice_inbound`/`einvoice_outbound`,
alebo `einvoice_organizations` s `provider_org_id` (aktívna u providera) — kým nie je rozhodnutá retencia (CLIA) a
stratégia deaktivácie u providera. Preflight route + UI text (`settings.errors.*`) = existujúci vzor
`subscription_guard`. Retenčná doba sa **nevymýšľa**.

Odchod člena: `invoices.created_by/finalized_by/updated_by`, `invoice_events.actor_user_id`,
`invoice_payments.recorded_by` = NO ACTION → záznamy ostávajú firme; globálne zrušenie loginu autora je fail-closed
(`ESBLU_RETAINED_RECORDS_AUTHOR`, RC 140000). `business_partners.created_by` = SET NULL.

## 6. Entitlement

`entitlement_catalog.einvoice` (included_in_trial = false) + `company_entitlements` per firma + `einvoice_rollout`
per firma/prostredie. Architektúra podporuje free / addon / súčasť plánu — **cena nerozhodnutá** (Master checklist E).

## 7. Provider mode

`lib/einvoice/provider/index.ts`: `live` iba ak `ESBLU_EINVOICE_ENVIRONMENT=live` **a** `ESBLU_EINVOICE_LIVE_ENABLED=true`
**a** `VERCEL_ENV=production` **a** live kľúč; inak `null` (fail-closed). Ďalšie brány: `einvoice_rollout`,
`einvoice_organizations.environment`. Nič live sa neaktivuje.

## 8. E2E harness (Partner C/D)

`scripts/einvoice-staging-e2e-seed.sql` zakladá firmy C/D (onboarding testy: neplatný FS kód, send_only) bez
členov — vtedy to blokoval index „1 aktívne členstvo na používateľa". C/D **sú** reálne tenanty (enrollment je per
firma), teda správna oprava = **owner membership**, nie business partner. Patch pre merge (RC verzia skriptu):

```sql
insert into public.company_members (company_id, user_id, role, status, permissions) values
  (c_a, u_a, 'owner', 'active', '{}'),
  (c_b, u_b, 'owner', 'active', '{}'),
  (c_c, u_b, 'owner', 'active', '{}'),
  (c_d, u_b, 'owner', 'active', '{}')
on conflict do nothing;
```

+ assert na konci seedu: každá `e2e5a000-*` firma má presne 1 aktívneho ownera. Counterparty, ktoré nie sú
Esblu tenantmi (napr. odberateľ B v A), ostávajú `business_partners` (už tak je).

## 9. Crony (žiadne sa neaktivujú)

| cron | schedule | env | poznámka |
|---|---|---|---|
| deadline-notifications | `0 6 * * *` | — | existujúci |
| account-deletion-cleanup | `30 3 * * *` | CRON_SECRET, service role | RC |
| fx-rates (ECB) | `0 5,16 * * *` | CRON_SECRET | append-only, idempotentné |
| einvoice-outbound send | `* * * * *` | ESBLU_EINVOICE_*, CRON_SECRET | lease/claim, idempotency key |
| einvoice-outbound reconcile | `*/5 * * * *` | 〃 | |
| einvoice-events | `*/5 * * * *` | 〃 | cursor claim/advance |
| einvoice-inbound | `*/10 * * * *` | 〃 | dedup `provider_received_id` |
| einvoice-maintenance | `17 * * * *` | 〃 | retention webhookov, health |

Minútové crony vyžadujú Vercel plán, ktorý ich podporuje — overiť pred produkciou (Master checklist H).

## 10. Staging media/push baseline — plán (iba staging)

- `20261001130000` push session binding: **objekty už sú na stagingu** (fingerprint 13 `esblu_push_*` funkcií =
  produkcia), chýba iba záznam v histórii. Plán: aplikovať súbor cez `apply_migration` (idempotentný) → overiť
  fingerprint bez zmeny.
- `20261005090000` media model: definuje nové `esblu_media_*` / `esblu_can_*_media_object` (aktívna firma,
  žiadne LIMIT 1) a nahrádza per-bucket storage politiky `media_*_scoped`. **Neprepisuje** funkcie z 140000.
- `20261005091000` private buckets: vehicle/machine/inventory-photos + company-logos → private. Staging má 0 media
  objektov → bez dopadu na dáta.
- Poradie na stagingu: 20261001130000 → 20261005090000 → 20261005091000 (po jednej, verifikácia, fingerprint
  storage politík = produkcia). **Odporúčané aplikovať pred finálnym QA.** Dovtedy: súbory / signed URL =
  NON-AUTHORITATIVE UNTIL STAGING MEDIA BASELINE IS ALIGNED.

## 11. Integration plan (ďalšie sedenie s funkčným shellom)

1. Lokálny klon mimo Windows mountu; `git merge --no-ff einvoice-port` do vetvy z `bc96307`.
2. Konflikty podľa §2 (RC architektúra má prednosť).
3. Reconciliation migrácia §5 + rollback + PGlite test (vlastník s e-faktúrou / enrolled org / finalizovaná faktúra → blokované; bez nich → povolené).
4. Harness patch §8.
5. `vercel.json` union §9; `MOBILE_STATIC_ROUTES` union.
6. Testy: všetky RC sady (75) + eInvoice sady + nový `multi-company-einvoice` PGlite (SZČO, cross-device, roly, enrollment izolácia, outbound/inbound viditeľnosť, deletion guard).
7. tsc, lint baseline, web build, mobile static export, secret scan, whitespace.
8. Commit (konkrétne súbory), push `preprod-release-candidate`, RC kit.
9. Staging: §10 + reconciliation migrácia → eInvoice sandbox QA (bez live).

## 12. Výsledok integrácie (2026-10-13)

Merge `einvoice-port` (`58d5a00`) → `preprod-release-candidate` (`bc96307`), `--no-ff`, v čerstvom klone
(nie vo Windows worktree). RC architektúra má prednosť (multi-company, per-session aktívna firma, owner-only
billing, DB-first zrušenie, trial per právny subjekt, RLS izolácia).

**Konflikty (6, menej než odhad 18 — zvyšok git zlúčil automaticky):**

| súbor | riešenie |
|---|---|
| `.gitignore` | union (Android release artefakty + `/.l3-local/`) |
| `vercel.json` | union cronov §9 (8 cronov; nič sa neaktivuje bez env) |
| `package.json` | union `test:*` (RC + eInvoice) + `test:multi-company-einvoice-db`; deps auto-merge (`next` 16.3.8, `@xmldom/xmldom`), `npm ci` = lock konzistentný |
| `app/api/account/delete/route.ts` | **RC verzia** (orchestrácia DB → Storage → auth). eInvoice `countCompanyAccountingRecords` presunuté do `lib/account-deletion-retention.ts` + DB guard (nižšie) |
| `app/nastavenia/page.tsx` | RC UI (SettingsSection/FormField, CompanySwitcher) + eInvoice polia firmy (Peppol identifikátory, platiteľ DPH) + `EinvoiceReceptionPanel` (iba finance view aktívnej firmy) |
| `app/faktury/InvoiceDetailView.tsx` | RC štýl + eInvoice stĺpec „kód jednotky“ (popis `sm:col-span-3`, grid 12) |

**Reconciliation (§5) — `20261013100000_einvoice_company_deletion_guard.sql` (+ rollback):**
`esblu_company_deletion_retention_blocker(company)` (service_role) a `esblu_account_deletion_commit('owner', …)`
→ fail closed `ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION` pri finalizovanej faktúre, `einvoice_inbound`/`einvoice_outbound`
alebo `einvoice_organizations.provider_org_id` (registrácia u providera) — **pred** zberom ciest aj mazaním.
Telo funkcie = 20261012140000 + jeden blok. `to_regclass` → bezpečné aj bez eInvoice tabuliek. Aditívne, idempotentné.
Preflight + delete route: `findOwnerDeletionBlocker` (rovnaké pravidlá, chýbajúca eInvoice tabuľka = 0, iná chyba =
fail closed), UI text podľa dôvodu (`lib/account-deletion-blockers.ts`; nový kľúč `ownerBlockedEinvoiceEnrolled`
— **LEGAL/CLIA REVIEW REQUIRED**). `/zrusenie-uctu` (legal stránka) nezmenená.

**Nemenná evidencia:** bucket `einvoice-documents` je v `lib/account-deletion-storage.ts` na zozname
`DELETION_PROTECTED_BUCKETS` (zahodí sa z jobu aj z `removeStorageTargets`). eInvoice upload = `upsert: false`,
žiadny `remove` v eInvoice kóde; DB identita XML (sha/path) je nemenná triggrami (20261002100000).

**E2E harness (§8):** `scripts/einvoice-staging-e2e-seed.sql` — firmy C/D majú ownera (Partner B) + assert
„presne 1 aktívny owner = `companies.owner_id`“ pre každú `e2e5a000-*` firmu. Na stagingu nespustené.

**Multi-company eInvoice:** nový `scripts/multi-company-einvoice-pglite-tests.ts` (10 sád) — skutočné eInvoice RLS
politiky (z 20261002100000) a rollout RPC (20261002150000) nad RC 140000–160000 + 20261013100000: SZČO PC/mobil
súčasne, roly (owner/účtovník/finance admin/employee/cudzí owner), billing ≠ finance, zákaz klientskych zápisov,
izolácia enrollmentu, deletion guard (blokované/povolené), odchod člena, rollback + re-apply.
`multi-company-pglite-tests` beží s guardom (39/39).

**Validácie:** 94/94 `test:*` sád PASS · `tsc --noEmit` čisté · lint 34 chýb (RC baseline 37, 0 nových; 2 nové
varovania pochádzajú z einvoice-port) · web build PASS (59 stránok) · mobile static export PASS (34 stránok,
`/faktury/efaktury`) + `verify-mobile-bundle` PASS · secret scan (diff + oba bundly) čistý · `git diff --check` čisté.
Sandbox nemá prístup ku Google Fonts → buildy overené offline (Turbopack s dočasne vypnutým `next/font/google`,
webpack s `NEXT_FONT_GOOGLE_MOCKED_RESPONSES`; nič z toho nie je v repe), placeholder public env.

**Otvorené:** §10 staging media baseline + aplikácia eInvoice migrácií a 20261013100000 na staging, eInvoice
sandbox QA na RC preview (driver guard `STAGING_E2E_BRANCH` je stále `einvoice-port` — rozhodnúť), retencia /
deaktivácia u providera (CLIA), minútové crony vs. Vercel plán.
