# Supabase explicit Data API grants — audit, hardening, rollout plan (2026-10-21)

Zmena platformy: od **2026-10-30** Supabase pri existujúcich projektoch prestane automaticky udeľovať Data API
grants (`SELECT/INSERT/UPDATE/DELETE` na tabuľky, `EXECUTE` na funkcie, `USAGE/SELECT` na sekvencie) rolám
`anon`, `authenticated`, `service_role` na **nové** objekty v `public`. Nové / preview projekty a čistý
`db reset` sa tak správajú už dnes. **GRANT ≠ RLS** — musí platiť oboje.

Branch `preprod-release-candidate` (východisko `e2763e6`). Staging `cjbdijbbcujvmrzezusd` (esblu-test),
produkcia `fkpgvgvsmbpieduoatrt` (assetpilot) **iba read-only**.

## 1. Zistenia

| # | zistenie | dopad |
|---|---|---|
| F1 | 24 tabuliek, ktoré appka používa ako `authenticated` (invoices, invoice_items, documents, document_links/attachments/review_log, ai_evidence, vehicles*, machines*, inventory*, business_partners, company_billing_profile, custom_document_categories, invoice_parties/payments/tax_breakdowns/events/number_sequences), nemalo v repe žiadny grant — fungovali iba vďaka historickým default privileges | čistý replay / nový projekt = `42501 permission denied` pre celú appku |
| F2 | `service_role` mala na 57 tabuľkách a 156 funkciách prístup iba z default privileges projektu | čistý replay = zrušenie účtu, cron notifikácie, billing, media cleanup zlyhajú |
| F3 | 9 tabuliek (`settings`, `vehicles`, `vehicle_services`, `machines`, `machine_services`, `machine_photos`, `inventory_items`, `inventory_photos`, `ai_evidence`) nevytvára žiadna migrácia (vznikli v Dashboarde pred `20260721000100`) | čistý replay zlyhal hneď na prvej migrácii — opravené baseline `20260720000000` (no-op na existujúcich DB) |
| F4 | poradie súborov ≠ poradie aplikovania: `20260916094000` závisí od `20260916120000` a `20260916140000` (produkcia ich aplikovala skôr) | replay používa 2 zdokumentované presuny (`REPLAY_ORDER_OVERRIDES`); súbory sa nepremenúvajú (MIGRATIONS.md §5) |
| F5 | príliš široké auto-granty: authenticated CRUD na `ai_scan_limits`/`ai_scan_usage` (bez politík), I/U/D na `invoice_parties`/`invoice_tax_breakdowns`/`invoice_payments`/`invoice_events`/`invoice_number_sequences` (iba SELECT politika), DELETE na `company_billing_profile` (bez DELETE politiky) a `settings` (nikdy zámer repa), `service_role` TRUNCATE/REFERENCES/TRIGGER/MAINTAIN všade | RLS ich zamietala — odobraté bez zmeny správania |
| F6 | default privileges (`postgres` v `public`): tables `authenticated=arwd`, `service_role=arwdDxtm`; functions `service_role=X`; sequences `anon/authenticated/service_role=rwU` | nová tabuľka dnes dostane CRUD pre authenticated automaticky — po 2026-10-30 už nie (nekonzistentné prostredia) |
| F7 | `anon` funkcie / PUBLIC: replay == staging (9 PUBLIC čistých helperov, anon iba `esblu_get_invite_preview`) | bez zmeny |
| F8 | `supabase_admin` default privileges v produkcii stále udeľujú anon/authenticated/service_role (spravuje Supabase, `postgres` ich nemôže meniť); žiadna Esblu tabuľka/funkcia nemá vlastníka `supabase_admin` | iba informatívne |

Nesúvisiace nálezy (neopravené, iba hlásené):
- `lib/i18n/LocaleProvider.tsx` zapisuje `settings.locale`, ale stĺpcový grant (od `20260721000100`) povoľuje UPDATE iba `company_name, logo_path` → uloženie jazyka do DB dnes ticho zlyháva (best-effort, chyba sa iba loguje). Oprava = `grant update (locale)` v samostatnej migrácii po rozhodnutí.
- Politiky na `invoices`, `invoice_items`, `business_partners`, `documents`, `document_links`, … sú `TO public` (nie `TO authenticated`). Bez grantu je anon aj tak `42501`, ale anon dostane hlášku *permission denied for function esblu_…* (planner narazí na helper v politike skôr než na ACL tabuľky). Kozmetika / hygiena politík.
- `npm run build` (Turbopack) v sandboxe nedosiahne Google Fonts; build overený `next build --webpack` s offline font mockom a placeholder env.

## 2. Model prístupu (A–E) a výsledná matica

Zdroj pravdy: `supabase/grants/public-data-api-grants.json` (trieda, doména, granty, dôvod pre každú tabuľku).

| trieda | význam | počet |
|---|---|---|
| A | klient číta/zapisuje cez RLS | 29 |
| B | klient iba číta cez RLS, zápis RPC/server | 28 |
| C | RPC/server-only (žiadny priamy Data API prístup) | 11 |
| D | service-role only (billing, provider, webhook, cleanup, audit) | 23 |
| E | anon (iba `legal_documents` SELECT) | 1 |

`anon` = žiadny prístup okrem `legal_documents`. `service_role` = iba DML (SIUD), append-only / immutable
tabuľky užšie (`einvoice_events`, `einvoice_ops_audit`, `fx_*` = SI; `trial_claims`, `einvoice_event_cursors`,
`account_deletion_cleanup_jobs` = SIU). Funkcie: `service_role` EXECUTE iba allowlist 109 RPC (všetky serverové
volania z kódu); `authenticated` 120 RPC (bez zmeny); `anon` 1 RPC (bez zmeny).

## 3. Inventár všetkých 92 public tabuliek

Skratky: `a`=INSERT `r`=SELECT `w`=UPDATE `d`=DELETE `D`=TRUNCATE `x`=REFERENCES `t`=TRIGGER `m`=MAINTAIN.
„repo“ = čistý replay všetkých migrácií PRED touto zmenou (bez auto-grantov) = čo repo výslovne deklaruje.
„závislé od auto-grantu“ = rola appku/server potrebuje, ale repo ju neudeľovalo.

| tabuľka | vytvára | doména | trieda | RLS · politiky | repo auth / svc | staging pred auth / svc | prod (RO) | **finálne** anon / auth / svc | závislé od auto-grantu |
|---|---|---|---|---|---|---|---|---|---|
| `account_deletion_cleanup_jobs` | 20261012130000 | deletion | D | RLS · 0 (—) | – / arw | – / arwdDxtm | n/a (RC) | – / – / arw | – |
| `accounting_handoff_export_items` | 20260923100000 | invoicing | A | RLS · 2 (INSERT,SELECT) | ar / – | ar / arwdDxtm | = staging | – / ar / arwd | svc |
| `accounting_handoff_exports` | 20260923100000 | invoicing | A | RLS · 2 (INSERT,SELECT) | ar / – | ar / arwdDxtm | = staging | – / ar / arwd | svc |
| `ai_evidence` | 20260720000000 | documents | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `ai_evidence_review_log` | 20260930125000 | documents | B | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | – / r / arwd | svc |
| `ai_processing_usage` | 20260928100000 | ai | C | RLS · 0 (—) | – / – | – / arwdDxtm | = staging | – / – / arwd | svc |
| `ai_scan_limits` | 20260921140000 | ai | C | RLS · 0 (—) | – / – | arwd / arwdDxtm | = staging | – / – / arwd | svc |
| `ai_scan_usage` | 20260921120000 | ai | C | RLS · 0 (—) | – / – | arwd / arwdDxtm | = staging | – / – / arwd | svc |
| `assistant_action_confirmations` | 20260915120000 | ai | C | RLS · 0 (—) | – / – | – / arwdDxtm | = staging | – / – / arwd | svc |
| `assistant_conversation_contexts` | 20260924100000 | ai | C | RLS+FORCE · 0 (—) | – / – | – / arwdDxtm | = staging | – / – / arwd | svc |
| `beta_allowlist` | 20260816130000 | auth | D | RLS · 0 (—) | – / – | – / arwdDxtm | = staging | – / – / arwd | svc |
| `billing_channel_rules` | 20261008120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `billing_checkout_sessions` | 20261008120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `billing_events` | 20261008120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `billing_provider_links` | 20261008120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `billing_provider_prices` | 20261008120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `billing_reconciliation` | 20261011120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `billing_region_groups` | 20261008120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `billing_runtime_config` | 20261008120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `billing_store_reports` | 20261008120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `business_partners` | 20260916120000 | company | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `chat_attachments` | 20260827100000 | chat | A | RLS · 2 (INSERT,SELECT) | ar / – | ar / arwdDxtm | = staging | – / ar / arwd | svc |
| `chat_conversation_members` | 20260827100000 | chat | B | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | – / r / arwd | svc |
| `chat_conversations` | 20260827100000 | chat | B | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | – / r / arwd | svc |
| `chat_message_references` | 20260827100000 | chat | B | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | – / r / arwd | svc |
| `chat_messages` | 20260827100000 | chat | A | RLS · 3 (INSERT,SELECT,UPDATE) | arw / – | arw / arwdDxtm | = staging | – / arw / arwd | svc |
| `companies` | 20260814110000 | membership | B | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | – / r / arwd | svc |
| `company_billing_profile` | 20260916120000 | company | A | RLS · 3 (INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arw / arwd | auth, svc |
| `company_dpa_acceptances` | 20260816090000 | legal | B | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | – / r / arwd | svc |
| `company_entitlements` | 20260928100000 | billing | C | RLS · 0 (—) | – / – | – / arwdDxtm | = staging | – / – / arwd | svc |
| `company_invites` | 20260814130000 | membership | C | RLS · 0 (—) | – / – | – / arwdDxtm | = staging | – / – / arwd | svc |
| `company_legal_identities` | 20261012150000 | trial | B | RLS · 1 (SELECT) | r / arwd | r / arwdDxtm | n/a (RC) | – / r / arwd | – |
| `company_members` | 20260814110000 | membership | B | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | – / r / arwd | svc |
| `custom_document_categories` | 20260914120000 | documents | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `document_attachments` | 20260814100000 | documents | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `document_download_events` | 20260926100000 | documents | B | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | – / r / arwd | svc |
| `document_export_package_items` | 20260926100000 | documents | A | RLS · 2 (INSERT,SELECT) | ar / – | ar / arwdDxtm | = staging | – / ar / arwd | svc |
| `document_export_packages` | 20260926100000 | documents | A | RLS · 2 (INSERT,SELECT) | ar / – | ar / arwdDxtm | = staging | – / ar / arwd | svc |
| `document_folder_items` | 20260926100000 | documents | A | RLS · 3 (DELETE,INSERT,SELECT) | ard / – | ard / arwdDxtm | = staging | – / ard / arwd | svc |
| `document_folders` | 20260926100000 | documents | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | arwd / – | arwd / arwdDxtm | = staging | – / arwd / arwd | svc |
| `document_links` | 20260812150000 | documents | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `document_review_log` | 20260812150000 | documents | A | RLS · 2 (INSERT,SELECT) | – / – | ar / arwdDxtm | = staging | – / ar / arwd | auth, svc |
| `documents` | 20260812150000 | documents | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `einvoice_enroll_attempts` | 20261007100000 | einvoice | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `einvoice_event_cursors` | 20261006100000 | einvoice | D | RLS · 0 (—) | – / arw | – / arwdDxtm | n/a (RC) | – / – / arw | – |
| `einvoice_events` | 20261002100000 | einvoice | B | RLS · 1 (SELECT) | r / ar | r / ar | n/a (RC) | – / r / ar | – |
| `einvoice_inbound` | 20261002100000 | einvoice | B | RLS · 1 (SELECT) | r / arwdDxtm | r / arwdDxtm | n/a (RC) | – / r / arwd | – |
| `einvoice_ops_audit` | 20261007100000 | einvoice | D | RLS · 0 (—) | – / ar | – / arwdDxtm | n/a (RC) | – / – / ar | – |
| `einvoice_organizations` | 20261002100000 | einvoice | B | RLS · 1 (SELECT) | r / arwdDxtm | r / arwdDxtm | n/a (RC) | – / r / arwd | – |
| `einvoice_outbound` | 20261002100000 | einvoice | B | RLS · 1 (SELECT) | r / arwdDxtm | r / arwdDxtm | n/a (RC) | – / r / arwd | – |
| `einvoice_rollout` | 20261002150000 | einvoice | D | RLS+FORCE · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `einvoice_webhook_events` | 20261002100000 | einvoice | B | RLS · 1 (SELECT) | r / arwdDxtm | r / arwdDxtm | n/a (RC) | – / r / arwd | – |
| `einvoice_webhook_rejections` | 20261002140000 | einvoice | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `entitlement_catalog` | 20260928100000 | billing | C | RLS · 0 (—) | – / – | – / arwdDxtm | = staging | – / – / arwd | svc |
| `esblu_intake_attestations_used` | 20260930125000 | ai | D | RLS · 0 (—) | – / – | – / arwdDxtm | = staging | – / – / arwd | svc |
| `fx_rate_import_batches` | 20261008100004 | invoicing | B | RLS · 1 (SELECT) | r / ar | r / arwdDxtm | n/a (RC) | – / r / ar | – |
| `fx_reference_rates` | 20261008100004 | invoicing | B | RLS · 1 (SELECT) | r / ar | r / arwdDxtm | n/a (RC) | – / r / ar | – |
| `inventory_items` | 20260720000000 | assets | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `inventory_photos` | 20260720000000 | assets | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `invoice_accounting_state` | 20260923100000 | invoicing | A | RLS · 3 (INSERT,SELECT,UPDATE) | arw / – | arw / arwdDxtm | = staging | – / arw / arwd | svc |
| `invoice_accounting_state_log` | 20260923140000 | invoicing | B | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | – / r / arwd | svc |
| `invoice_advance_deductions` | 20261008100000 | invoicing | B | RLS · 1 (SELECT) | r / arwd | r / arwdDxtm | n/a (RC) | – / r / arwd | – |
| `invoice_events` | 20260916094000 | invoicing | B | RLS · 1 (SELECT) | – / – | arwd / arwdDxtm | = staging | – / r / arwd | auth, svc |
| `invoice_items` | 20260916094000 | invoicing | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `invoice_number_sequences` | 20260916094000 | invoicing | B | RLS · 1 (SELECT) | – / – | arwd / arwdDxtm | = staging | – / r / arwd | auth, svc |
| `invoice_parties` | 20260916094000 | invoicing | B | RLS · 1 (SELECT) | – / – | arwd / arwdDxtm | = staging | – / r / arwd | auth, svc |
| `invoice_payments` | 20260916094000 | invoicing | B | RLS · 1 (SELECT) | – / – | arwd / arwdDxtm | = staging | – / r / arwd | auth, svc |
| `invoice_tax_breakdowns` | 20260916094000 | invoicing | B | RLS · 1 (SELECT) | – / – | arwd / arwdDxtm | = staging | – / r / arwd | auth, svc |
| `invoices` | 20260916094000 | invoicing | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `legal_documents` | 20260815100000 | legal | E | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | r / r / arwd | svc |
| `machine_photos` | 20260720000000 | assets | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `machine_services` | 20260720000000 | assets | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `machines` | 20260720000000 | assets | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `media_deletion_queue` | 20261005090000 | media | D | RLS · 0 (—) | – / – | – / arwdDxtm | = staging | – / – / arwd | svc |
| `notification_deliveries` | 20260927110000 | push | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | = staging | – / – / arwd | – |
| `notification_preferences` | 20260927110000 | push | C | RLS · 0 (—) | – / arwd | – / arwdDxtm | = staging | – / – / arwd | – |
| `plan_limits` | 20260721000100 | billing | B | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | – / r / arwd | svc |
| `push_devices` | 20261001130000 | push | C | RLS · 0 (—) | – / arwd | – / arwdDxtm | = staging | – / – / arwd | – |
| `push_subscriptions` | 20260927110000 | push | C | RLS · 0 (—) | – / arwd | – / arwdDxtm | = staging | – / – / arwd | – |
| `received_advance_links` | 20261008100008 | invoicing | B | RLS · 1 (SELECT) | r / arwd | r / arwdDxtm | n/a (RC) | – / r / arwd | – |
| `session_active_company` | 20261012150000 | membership | B | RLS · 1 (SELECT) | r / arwd | r / arwdDxtm | n/a (RC) | – / r / arwd | – |
| `settings` | 20260720000000 | company | A | RLS · 1 (ALL) | r / – | rd / arwdDxtm | = staging | – / r+col / arwd | svc |
| `subscription_accounts` | 20261008120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `subscription_plan_entitlements` | 20261008120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `subscription_plans` | 20261008120000 | billing | D | RLS · 0 (—) | – / arwd | – / arwdDxtm | n/a (RC) | – / – / arwd | – |
| `trial_claims` | 20261012150000 | trial | D | RLS · 0 (—) | – / arw | – / arwdDxtm | n/a (RC) | – / – / arw | – |
| `user_active_company` | 20261012140000 | membership | B | RLS · 1 (SELECT) | r / arwd | r / arwdDxtm | n/a (RC) | – / r / arwd | – |
| `user_legal_acceptances` | 20260815100000 | legal | B | RLS · 1 (SELECT) | r / – | r / arwdDxtm | = staging | – / r / arwd | svc |
| `vehicle_photos` | 20260816110000 | assets | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `vehicle_services` | 20260720000000 | assets | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `vehicle_vignettes` | 20260823090000 | assets | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |
| `vehicles` | 20260720000000 | assets | A | RLS · 4 (DELETE,INSERT,SELECT,UPDATE) | – / – | arwd / arwdDxtm | = staging | – / arwd / arwd | auth, svc |

Produkcia (read-only, 2026-10-21): 61 tabuliek, ACL každej zhodné so stagingom pred zmenou; 31 RC tabuliek
(billing, eInvoice, multi-company, trial, deletion) v produkcii ešte neexistuje → ak by sa RC migrácie aplikovali
po 2026-10-30 bez tejto zmeny, **všetky** by boli pre appku aj server nedostupné.

## 4. Implementácia

| súbor | účel |
|---|---|
| `supabase/migrations/20260720000000_legacy_pre_migration_baseline.sql` | 9 legacy tabuliek pre čistý replay; na existujúcich DB no-op (`to_regclass … is null`), žiadne granty |
| `supabase/migrations/20261021100000_explicit_data_api_grants.sql` | cieľový ACL stav všetkých 92 tabuliek, service_role function allowlist, default privileges opt-in (nič pre klientske roly); fail-closed precondition; idempotentná |
| `supabase/rollback/20261021100000_explicit_data_api_grants_rollback.sql` | presný návrat ACL pred zmenou (vrátane širokých grantov) — iba núdza |
| `supabase/grants/public-data-api-grants.json` | matica (zdroj pravdy) |
| `supabase/GRANTS.md` | pravidlo pre budúce migrácie |
| `scripts/sql/pglite/supabase-platform-stub.sql` | kostra Supabase platformy BEZ default privileges (= nový projekt po 2026-10-30) |
| `scripts/grants-replay-pglite-tests.ts` (`npm run test:grants-replay-db`) | čistý replay od nuly + ACL == manifest + rolová matica (33 testov) |
| `scripts/grants-migration-guard-tests.ts` (`npm run test:grants-guard`) | statický guard pre budúce migrácie (9 testov) |
| `scripts/sql/grants-data-api-matrix.sql` | rolová matica na reálnom Postgrese (staging), výsledok vo výnimke → nič nezostane zapísané |

Bez zmeny: politiky, RLS/FORCE RLS, funkcie, triggre, `storage.objects` politiky, dáta, `anon`/`authenticated`/PUBLIC EXECUTE.

## 5. Výsledky

| test | výsledok |
|---|---|
| čistý replay 126 migrácií od nuly bez auto-grantov (PGlite) | PASS |
| negatívna kontrola: replay BEZ reconciliation | FAIL 12/32 (tenant/media/service/ACL — dôkaz závislosti od auto-grantov) |
| replay == staging: politiky (`public`+`storage`, 137) md5, množina funkcií (269) md5, tabuľky (92) md5 | PASS (zhodné hashe) |
| staging po aplikácii: ACL tabuliek / stĺpcov / funkcií == čistý replay | PASS (zhodné md5 pre t / c / f) |
| zapísané statements v histórii == repo súbor (md5) | PASS (oba súbory) |
| baseline na stagingu no-op (ACL + politiky md5 pred = po) | PASS |
| PostgREST HTTP (anon, publishable key) | PASS — `legal_documents` 200; invoices/vehicles/documents/companies/billing/trial/cleanup/push/eInvoice 401 `42501`; `rpc/esblu_get_invite_preview` 200; `rpc/esblu_my_active_company_id` 401 |
| staging rolová matica (SET ROLE + JWT claims, ako PostgREST) | PASS — viď §6 |
| security advisors (staging po zmene) | 3 typy, všetky očakávané: `rls_enabled_no_policy` INFO ×34 (= presne triedy C+D), `anon_security_definer_function_executable` ×1 (`esblu_get_invite_preview`, zámerné), `authenticated_security_definer_function_executable` (RPC model, bez zmeny grantov) — žiadny nový typ |
| všetkých 77 test sád (`npm run test:*`) | PASS (77/77) |
| `tsc --noEmit` | PASS |
| `eslint` | baseline 34 errors / 28 warnings v nedotknutých súboroch; nové súbory 0 / 0 |
| `next build --webpack` (offline font mock) | PASS (59/59 stránok) |

## 6. Rolová matica (staging, reálny Postgres)

Vrstva: **privilege** = `42501 permission denied` (chýba GRANT) · **rls** = `42501 row-level security` /
0 riadkov · **ok:n** = povolené, n riadkov.

| scenár | výsledok | vrstva |
|---|---|---|
| anon SELECT invoices/documents/vehicles/companies/company_members/billing_events/trial_claims/cleanup_jobs/media_queue/push_devices/einvoice_outbound/subscription_accounts | deny | privilege |
| anon SELECT legal_documents | ok:9 | — |
| anon INSERT vehicles | deny | privilege |
| owner SELECT 20 service/RPC-only tabuliek (billing_*, subscription_accounts, trial_claims, cleanup, media queue, einvoice_rollout/cursors/rejections/ops_audit, push_*, notification_preferences, company_entitlements/invites, ai_scan_*, assistant_action_confirmations, beta_allowlist) | deny | privilege |
| owner UPDATE invoice_payments / DELETE invoice_events / DELETE company_billing_profile / DELETE settings / UPDATE settings.plan / UPDATE companies / TRUNCATE vehicles | deny | privilege |
| owner A vs owner B — SELECT vehicles / invoices | ok:1 každý (iba vlastné) | rls |
| owner A INSERT vehicle do A / do B | ok:1 / deny | — / rls |
| owner A UPDATE/DELETE vozidla B / UPDATE vlastného | ok:0 / ok:1 | rls |
| rovnaký user, session A vs session B (aktívna firma) | A vidí iba A, B iba B (ok:0 na cudziu) | rls |
| billing `esblu_billing_authorize_manage`: owner / admin (aj s permissions.billing.manage) / accountant / employee / anon | ok / FORBIDDEN / FORBIDDEN / FORBIDDEN / privilege | RPC (owner-only) |
| eInvoice org: owner / accountant / employee (forged finance) / owner B → A | ok:1 / ok:1 / ok:0 / ok:0 | rls |
| eInvoice owner UPDATE org; service DELETE einvoice_events | deny / deny | privilege |
| trial_claims: owner / service SELECT / service DELETE | deny / ok / deny | privilege |
| legal identity: owner / admin / employee / owner B → A | ok:1 / ok:0 / ok:0 / ok:0 | rls |
| cleanup_jobs & media_queue: owner SELECT / service SELECT / service DELETE cleanup | deny / ok / deny | privilege |
| media metadata vehicle_photos: vlastná firma / cudzia; storage.objects politiky | ok:1 / rls; 11 (bez zmeny) | rls |
| push_devices owner / `esblu_push_my_devices()` | deny / ok | privilege / RPC |
| service_role: SELECT vehicles, `esblu_active_membership_for_user`, `esblu_einvoice_health`, `esblu_billing_reconcile_candidates`, `esblu_push_companies_with_targets` | ok | — |
| service_role TRUNCATE billing_events; interný helper `esblu_my_active_company_id()` | deny | privilege |
| authenticated → service-only RPC `esblu_billing_reconcile_candidates` | deny | privilege |

## 7. PRODUCTION GRANTS ROLLOUT PLAN (⛔ vyžaduje samostatný výslovný súhlas)

**Poradie.** `20261021100000_explicit_data_api_grants` sa aplikuje v rámci produkčného rolloutu RC **hneď po
poslednej RC migrácii** (`20261013100000_einvoice_company_deletion_guard`) — precondition ju inak odmietne
(chýbajúce RC tabuľky). Ak RC rollout prebehne **po 2026-10-30**, RC migrácie vytvoria tabuľky bez grantov a appka
bude do aplikácie tejto migrácie v jednom kroku nefunkčná → aplikovať v tom istom okne, bez prestávky.
`20260720000000_legacy_pre_migration_baseline` je v produkcii no-op; aplikovať voliteľne (iba záznam histórie).

**Precheck (read-only):**
```sql
-- a) presne 92 očakávaných tabuliek, žiadna navyše (inak precondition zlyhá)
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p','v','m','f');
-- b) všetkých 109 allowlist funkcií existuje
select count(*) from unnest(array[/* zoznam zo supabase/grants/public-data-api-grants.json */]::text[]) f
where to_regprocedure('public.' || f) is not null;
-- c) ACL snapshot PRED (uložiť do výstupu rolloutu)
-- scripts: dotaz z §5 (md5 per k = t/c/f) + pg_default_acl pre postgres/public
-- d) posledné migrácie
select version, name from supabase_migrations.schema_migrations order by version desc limit 10;
```

**Záloha.** Logický dump schémy + ACL (`pg_dump --schema-only` vrátane `GRANT`) a PITR bod tesne pred aplikáciou;
uložiť výstup precheck c). Dáta sa nemenia.

**Očakávaný ACL pred → po (produkcia, 61 existujúcich tabuliek + 31 RC):**
- authenticated: `arwd` → `r` na `invoice_parties`, `invoice_tax_breakdowns`, `invoice_payments`, `invoice_events`, `invoice_number_sequences`; `arwd` → `–` na `ai_scan_limits`, `ai_scan_usage`; `arwd` → `arw` na `company_billing_profile`; `rd` → `r` na `settings` (stĺpcové granty bez zmeny); ostatné bez zmeny.
- service_role: `arwdDxtm` → `arwd` všade; užšie: `einvoice_events`/`einvoice_ops_audit`/`fx_*` `ar`, `trial_claims`/`einvoice_event_cursors`/`account_deletion_cleanup_jobs` `arw`.
- funkcie: service_role EXECUTE iba 109 allowlist RPC; authenticated / anon / PUBLIC bez zmeny.
- default privileges (`postgres`, `public`): iba `postgres=…` — žiadny záznam pre anon/authenticated/service_role.
- **Kontrola po:** md5 per `t`/`c`/`f` (dotaz §5) musí byť rovnaký ako staging: `t=938e3849…`, `c=8f76056d…`, `f=e90e2ad4…` (pri identickej množine tabuliek/funkcií).

**Rollback.** `supabase/rollback/20261021100000_explicit_data_api_grants_rollback.sql` (presný návrat ACL; overený
v PGlite: rollback → re-apply = identický manifest). Cielená oprava (preferovaná): doplniť chýbajúci grant
do manifestu + novej migrácie.

**Smoke po aplikácii:**
1. `scripts/sql/grants-data-api-matrix.sql` — **NIE na produkcii** (vkladá dočasné fixtures, hoci ich zahodí); v produkcii iba read-only: ACL md5 + `has_table_privilege`/`has_function_privilege` matica pre anon/authenticated/service_role.
2. anon HTTP: `legal_documents` 200, `invoices` 401 `42501`.
3. interná firma: prihlásenie, zoznam faktúr, vozidiel, strojov, skladu, dokumentov; vytvorenie a zmazanie testového vozidla; chat; nastavenia.
4. server: cron `deadline-notifications`, `account-deletion-cleanup` (dry), billing `my_access` (owner), eInvoice health.
5. Security advisors — iba 3 očakávané typy (§5).
