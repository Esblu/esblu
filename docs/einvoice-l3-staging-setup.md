# E-Faktúra — L3 staging (esblu-test) — audit a plán

**Stav:** 2026-10-03 · iba audit a plán. **Nič nebolo aplikované ani zmazané.**
**Staging:** `esblu-test`, ref `cjbdijbbcujvmrzezusd`, `eu-west-1`.
**Produkcia** (`fkpgvgvsmbpieduoatrt`) sa v tomto kroku nepoužila vôbec: žiadne SQL, žiadna migrácia,
žiadne env.

## 1. Audit stagingu (read-only, Supabase MCP, 2026-10-03)

| Položka | Stav |
| --- | --- |
| Status projektu | `ACTIVE_HEALTHY`, Postgres 17.6 |
| História migrácií | **žiadna** (`supabase_migrations.schema_migrations` neexistuje) |
| public tabuľky | 8 legacy tabuliek: `documents`, `document_links`, `document_review_log`, `inventory_items`, `machine_services`, `machines`, `vehicle_services`, `vehicles`. **Všetky majú 0 riadkov.** |
| public funkcie / triggery / views | 0 / 0 / 0 |
| public politiky | 10 (iba staré `*_own` na documents / document_links / document_review_log) |
| auth.users / identities / sessions | 0 / 0 / 0 |
| storage | 0 bucketov, 0 objektov, 0 politík |
| Rozšírenia | `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp` |
| Realtime (`supabase_realtime`) | publikácia existuje, 0 tabuliek |
| pg_cron / pg_net | nie sú nainštalované |

**Záver:** staging je **bezpečne resetovateľný**. Neobsahuje žiadne dáta, používateľov, súbory ani históriu
migrácií. Je to iba zvyšok starej, neúplnej schémy, ktorá nezodpovedá ani repu, ani produkcii.

## 2. Kľúčové zistenie: repo migrácie NEVEDIA postaviť databázu od nuly

Overené replayom všetkých 94 repo migrácií v PGlite nad minimálnou Supabase kostrou (roly, `auth`,
`storage`):

- prvá migrácia `20260721000100_add_plans_and_free_limits.sql` hneď zlyhá: `relation "public.settings" does not exist`,
- prešlo iba **19/94**, ostatné padajú na chýbajúcich legacy tabuľkách (`settings`, `vehicles`, `machines`,
  `inventory_items`, `ai_evidence`, `vehicle_services`, `machine_services`, `*_photos`, …).

**Prečo:**

- **Chýba pôvodná schéma.** Legacy tabuľky v produkcii vznikli pred migračnou históriou (ručne / Dashboard)
  a sú zdokumentované iba v `docs/db/schema-baseline-2026-08-12.md`. Ten je dokumentácia, nie spustiteľný
  DDL, a výslovne neobsahuje všetky stĺpce.
- **Repo nemá všetky produkčné migrácie.** Produkcia má 3 migrácie, ktoré v repe nie sú
  (`accountant_role_rpc_updates`, `harden_accounting_handoff_grants`,
  `harden_client_role_privileges_anon_select_default`, pozri `supabase/MIGRATIONS.md` §3).
- **Platforma navyše:** migrácie potrebujú Supabase roly (napr. `supabase_auth_admin`).

Doslovné „aplikovať všetky migrácie od nuly“ teda z repa **nie je možné bez rekonštrukcie pôvodnej
schémy**. Aj s ňou by výsledok nebol totožný s produkciou.

## 3. Odporúčaný postup (A): klon produkčnej ŠTRUKTÚRY + všetky E-Faktúra migrácie

L3 má overiť presne to, čo sa raz stane v produkcii: 6 E-Faktúra migrácií aplikovaných na **produkčnú**
schému. Preto:

1. **Staging marker + reset** public schémy stagingu (deštruktívne iba pre staging, s guardmi).
2. **Read-only export štruktúry produkcie** (bez dát firiem a používateľov). Spúšťa **používateľ** lokálne:
   - `pg_dump` beží v read-only transakcii (`default_transaction_read_only=on`),
   - `--schema-only` pre `public`,
   - zo spravovaných schém iba politiky `storage.objects`, triggery `auth.users` a konfigurácia bucketov,
   - referenčné katalógy (`legal_documents`, `plan_limits`, `ai_scan_limits`, `entitlement_catalog`),
     ktoré neobsahujú osobné údaje.
3. **Obnova do stagingu** (Claude cez Supabase MCP na `cjbdijbbcujvmrzezusd`, po odstránení psql
   meta-príkazov `\restrict`). Pred každým blokom beží SQL guard.
4. **Aplikácia všetkých 6 E-Faktúra migrácií** v poradí cez MCP `apply_migration` (rovnaký postup ako
   neskôr v produkcii, `MIGRATIONS.md` §9). Ostatných 88 je obsiahnutých v klone.
5. Realtime, Auth konfigurácia, Vault, seed, rollout (§5).

Výsledok: staging = produkcia + E-Faktúra. Zároveň je to **generálka produkčnej migrácie**.

### Alternatíva (B): replay celého repa (bez dotyku produkcie)

Treba napísať a overiť bootstrap pôvodnej (pred-migračnej) schémy z `docs/db/schema-baseline-2026-08-12.md`
a doplniť 3 produkčné migrácie chýbajúce v repe. Je to väčšia práca a výsledok sa môže od produkcie
odlišovať. **Neodporúča sa pre L3.** Hodí sa ako samostatná úloha na zdravie repa (aby sa DB dala
postaviť od nuly).

## 4. Hard guard (produkcia = okamžitý STOP)

| Vrstva | Súbor | Pravidlo |
| --- | --- | --- |
| Node | `scripts/l3/staging-guard.mjs` | Cieľ musí byť `cjbdijbbcujvmrzezusd`. Ak sa `fkpgvgvsmbpieduoatrt` objaví v ref / URL / DB URL → exit 3. |
| SQL | `scripts/l3/sql/00-guard.sql` (vložený na začiatok každého L3 SQL súboru) | Vyžaduje staging marker `esblu_l3.target = cjbdijbbcujvmrzezusd`. Odmietne DB s produkčnou históriou migrácií (verzie `20260930213531`, `20260930213818`, `20260929201345`). Produkcia marker nemá, takže každý L3 súbor tam zlyhá pred prvou zmenou. |
| SQL marker | `scripts/l3/sql/01-staging-marker.sql` | Vytvorí sa iba v **prázdnej** DB (0 `auth.users`, 0 `storage.objects`) bez produkčnej histórie. |
| Export | `scripts/l3/export-prod-schema.mjs` | Iba čítanie (read-only transakcia), výstup iba do gitignored `.l3-local/`, URL sa nevypisuje. |
| Claude | — | Každé MCP volanie s `project_id = cjbdijbbcujvmrzezusd`. Pred každou zmenou beží `00-guard.sql` cez `execute_sql`. |

Guardy sú overené v PGlite:

- guard bez markera vedie na STOP,
- marker na neprázdnej DB vedie na STOP,
- DB s produkčnou históriou vedie na STOP,
- reset zachová marker, vyprázdni public aj buckety,
- seed bez používateľov vedie na STOP,
- seed je idempotentný,
- nenahradená zástupná hodnota v rollout skripte vedie na STOP.

## 5. Rozdelenie setupu

### A) DB schéma / migrácie

| Krok | Kto | Ako |
| --- | --- | --- |
| A1 marker | Claude (po schválení) | `01-staging-marker.sql` cez MCP `execute_sql` |
| A2 reset public | Claude (po schválení) | `02-reset-public.sql` (guard + kontrola prázdnoty + Supabase predvolené granty + vymazanie bucketov) |
| A3 export produkcie | **používateľ** | `node --env-file=<mimo repa> scripts/l3/export-prod-schema.mjs --confirm-read-only` |
| A4 obnova | Claude | súbory `.l3-local/10, 20, 21, 30, 31` cez MCP (bez `\restrict` riadkov) |
| A5 E-Faktúra migrácie | Claude | MCP `apply_migration` v poradí `20261002100000` → `150000` |
| A6 kontrola | Claude | `03-post-restore.sql` (výpis), advisors stagingu, RLS matica |

### B) Supabase Auth (Dashboard stagingu, používateľ)

- **URL Configuration:**
  - Site URL = URL L3 aplikácie (lokálne `http://localhost:3000` alebo preview URL),
  - Redirect URLs + `http://localhost:3000/**`, `https://localhost`, `capacitor://localhost`.
- **Hooks:** ak má produkcia zapnutý „Before User Created“ → `public.esblu_before_user_created_beta_gate`,
  zapnúť rovnako. Over v produkčnom Dashboarde **iba pohľadom**.
- **Providers:** iba Email. OAuth nie (`NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS` prázdne).
- **Používatelia:** 6 L3 používateľov (`l3-owner@example.com`, `l3-accountant@…`, `l3-admin-fin@…`,
  `l3-admin@…`, `l3-employee@…`, `l3-other-owner@…`) cez Dashboard → Add user, s potvrdeným e-mailom a
  silným heslom, ktoré si necháš u seba. Ak je hook zapnutý, najprv `04-beta-allowlist.sql`.

### C) Storage

- Buckety a politiky prídu z klonu (A4): `ai-inbox-documents`, `chat-attachments`, `company-logos`,
  `inventory-photos`, `machine-photos`, `vehicle-photos`.
- `einvoice-documents` vytvorí migrácia `20261002100000` (privátny, bez klientskych politík).
- Kontrola: `03-post-restore.sql` (počet politík a zoznam bucketov).

### D) Vault / secrets

- **Vault:**
  - `esblu_intake_attest_key` (≥ 32 znakov) je potrebný iba pre AI intake (RPC z `20260930125000`).
    Pre L3 E-Faktúry **voliteľné**.
  - Ak áno, vytvorí ho používateľ v SQL Editore stagingu: `select vault.create_secret('<nová náhodná hodnota>', 'esblu_intake_attest_key');`
    Rovnaká hodnota ide do `ESBLU_INTAKE_ATTEST_SECRET`. Claude hodnotu nikdy nevidí.
- **Žiadne produkčné hodnoty** sa do stagingu nekopírujú.

### E) Realtime

- `03-post-restore.sql` pridá `chat_messages`, `chat_attachments`, `chat_message_references` do
  `supabase_realtime` (rovnako ako `20260827100000`).
- E-Faktúra realtime nepoužíva.

### F) Seed (syntetický)

- `05-seed.sql`:
  - firma A „L3 Tatra Servis s.r.o.“: IČO/DIČ sandbox organizácie z L2, Peppol `9915:2099999999`,
    odberateľ = tá istá organizácia (self-send),
  - firma B (cudzí tenant bez nároku),
  - roly owner / accountant / admin s finance / admin bez finance / employee (aj s podvrhnutým finance flagom),
  - nárok `einvoice` iba pre firmu A.
- Aplikácia si pri prvom prihlásení vyžiada súhlasy (Terms / Privacy / DPA). To je súčasť L3 testu.

### G) E-Faktúra rollout

- `06-einvoice-rollout.sql`:
  - `einvoice_organizations` (sandbox, `provider_org_id` = UUID sandbox organizácie z L2) a
    `einvoice_rollout` (sandbox, `internal`),
  - **live** riadok je zakázaný (guard).
- Partner webhook v portáli eFaktura.sk (sandbox) na verejnú URL `/api/einvoice/webhook` (§6).

## 6. Kde pobeží L3 aplikácia

| Variant | Push? | Poznámka |
| --- | --- | --- |
| **L3-local (odporúčané teraz)** | nie | `npm run dev` lokálne so staging env. Webhook cez verejný tunel (napr. cloudflared). Cron sa volá ručne (`GET /api/cron/einvoice-*` s `Authorization: Bearer $CRON_SECRET`). |
| L3-preview (Vercel) | **áno** (push `einvoice-port`, iba so súhlasom) | Env premenné **scoped na branch `einvoice-port` v Preview**. Inak by preview mohol dediť produkčné Supabase hodnoty. Vercel Cron beží iba v produkcii, takže aj tu sa cron volá ručne. |

## 7. Env pre L3 (iba staging / sandbox hodnoty, mimo repa)

| Premenná | Hodnota |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://cjbdijbbcujvmrzezusd.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | staging anon / publishable kľúč |
| `SUPABASE_SERVICE_ROLE_KEY` | staging service_role (**nikdy** produkčný) |
| `STAGING_SUPABASE_REF` | `cjbdijbbcujvmrzezusd` (pre guard) |
| `CRON_SECRET` | nová náhodná (≥ 32 znakov) |
| `ESBLU_ACTION_CONFIRMATION_SECRET` | nová náhodná |
| `ESBLU_INTAKE_ATTEST_SECRET` | voliteľné (= Vault, §5D) |
| `ESBLU_EINVOICE_PROVIDER` | `efaktura_sk` |
| `ESBLU_EINVOICE_ENVIRONMENT` | `sandbox` |
| `ESBLU_EFAKTURA_API_KEY` | sandbox `efk_pk_test_…` (z `efaktura-sandbox.env`) |
| `ESBLU_EFAKTURA_WEBHOOK_SECRETS` | secret sandbox partner webhooku z portálu |
| `OPENAI_API_KEY` | voliteľné (AI funkcie mimo E-Faktúry); samostatný kľúč alebo vynechať |
| `ESBLU_EINVOICE_LIVE_ENABLED` | **NENASTAVOVAŤ** |
| VAPID / FCM / APNS | vynechať (push mimo L3) |

## 8. Presné poradie migrácií v repe (94)

Pri postupe A je 88 migrácií obsiahnutých v klone produkčnej štruktúry. Klon navyše obsahuje 3
produkčné migrácie, ktoré v repe chýbajú. 6 E-Faktúra migrácií sa aplikuje.

| # | Súbor | Pri postupe A |
| --- | --- | --- |
| 1 | `20260721000100_add_plans_and_free_limits.sql` | obsiahnutá v klone produkčnej štruktúry |
| 2 | `20260812150000_add_ai_inbox_core_tables.sql` | obsiahnutá v klone produkčnej štruktúry |
| 3 | `20260812160000_add_ai_inbox_storage.sql` | obsiahnutá v klone produkčnej štruktúry |
| 4 | `20260813120000_add_machine_assignment_to_ai_evidence.sql` | obsiahnutá v klone produkčnej štruktúry |
| 5 | `20260814090000_add_insurance_document_type.sql` | obsiahnutá v klone produkčnej štruktúry |
| 6 | `20260814100000_add_document_notes_and_attachments.sql` | obsiahnutá v klone produkčnej štruktúry |
| 7 | `20260814110000_add_companies_and_company_members.sql` | obsiahnutá v klone produkčnej štruktúry |
| 8 | `20260814120000_add_company_id_to_business_tables.sql` | obsiahnutá v klone produkčnej štruktúry |
| 9 | `20260814130000_add_company_invites_and_owner_bootstrap.sql` | obsiahnutá v klone produkčnej štruktúry |
| 10 | `20260814140000_harden_legacy_storage_buckets.sql` | obsiahnutá v klone produkčnej štruktúry |
| 11 | `20260814150000_add_missing_business_fks.sql` | obsiahnutá v klone produkčnej štruktúry |
| 12 | `20260814160000_add_company_based_rls.sql` | obsiahnutá v klone produkčnej štruktúry |
| 13 | `20260814170000_add_company_aware_storage_policies.sql` | obsiahnutá v klone produkčnej štruktúry |
| 14 | `20260814180000_add_company_profile_rpc.sql` | obsiahnutá v klone produkčnej štruktúry |
| 15 | `20260814190000_fix_company_profile_rpc.sql` | obsiahnutá v klone produkčnej štruktúry |
| 16 | `20260815100000_add_legal_acceptance.sql` | obsiahnutá v klone produkčnej štruktúry |
| 17 | `20260816090000_add_company_dpa_acceptance.sql` | obsiahnutá v klone produkčnej štruktúry |
| 18 | `20260816100000_add_account_self_deletion.sql` | obsiahnutá v klone produkčnej štruktúry |
| 19 | `20260816110000_add_vehicle_photos_and_registration_type.sql` | obsiahnutá v klone produkčnej štruktúry |
| 20 | `20260816120000_add_privacy_policy_v1_2_namecheap.sql` | obsiahnutá v klone produkčnej štruktúry |
| 21 | `20260816130000_add_closed_beta_allowlist.sql` | obsiahnutá v klone produkčnej štruktúry |
| 22 | `20260818090000_fix_company_invites_accepted_consistency_check.sql` | obsiahnutá v klone produkčnej štruktúry |
| 23 | `20260818140000_fix_beta_allowlist_prevent_consumed_reuse.sql` | obsiahnutá v klone produkčnej štruktúry |
| 24 | `20260819090000_add_settings_locale.sql` | obsiahnutá v klone produkčnej štruktúry |
| 25 | `20260820090000_add_documents_vehicle_archive.sql` | obsiahnutá v klone produkčnej štruktúry |
| 26 | `20260823090000_add_vehicle_vignettes.sql` | obsiahnutá v klone produkčnej štruktúry |
| 27 | `20260827100000_add_chat_core.sql` | obsiahnutá v klone produkčnej štruktúry |
| 28 | `20260827110000_add_chat_storage.sql` | obsiahnutá v klone produkčnej štruktúry |
| 29 | `20260827120000_fix_chat_members_email_cast.sql` | obsiahnutá v klone produkčnej štruktúry |
| 30 | `20260827130000_fix_company_members_email_cast.sql` | obsiahnutá v klone produkčnej štruktúry |
| 31 | `20260827140000_fix_ai_inbox_documents_select_policy.sql` | obsiahnutá v klone produkčnej štruktúry |
| 32 | `20260827150000_fix_ai_evidence_documents_select_policy.sql` | obsiahnutá v klone produkčnej štruktúry |
| 33 | `20260828100000_fix_vehicle_photos_storage_delete.sql` | obsiahnutá v klone produkčnej štruktúry |
| 34 | `20260828110000_fix_machine_photos_storage_delete.sql` | obsiahnutá v klone produkčnej štruktúry |
| 35 | `20260828120000_fix_inventory_photos_storage_delete.sql` | obsiahnutá v klone produkčnej štruktúry |
| 36 | `20260828130000_fix_company_logos_storage_delete.sql` | obsiahnutá v klone produkčnej štruktúry |
| 37 | `20260830090000_fix_ai_evidence_max_uuid.sql` | obsiahnutá v klone produkčnej štruktúry |
| 38 | `20260909100000_add_esblu_sro_identity_legal_versions.sql` | obsiahnutá v klone produkčnej štruktúry |
| 39 | `20260914120000_add_custom_document_categories.sql` | obsiahnutá v klone produkčnej štruktúry |
| 40 | `20260915120000_add_assistant_action_confirmations.sql` | obsiahnutá v klone produkčnej štruktúry |
| 41 | `20260915173000_restrict_action_confirmation_rpc_execute.sql` | obsiahnutá v klone produkčnej štruktúry |
| 42 | `20260915190000_add_company_scoped_plan.sql` | obsiahnutá v klone produkčnej štruktúry |
| 43 | `20260916044000_fix_company_logo_delete_undefined_function.sql` | obsiahnutá v klone produkčnej štruktúry |
| 44 | `20260916094000_add_invoicing_core_schema.sql` | obsiahnutá v klone produkčnej štruktúry |
| 45 | `20260916095000_add_invoicing_core_rpc.sql` | obsiahnutá v klone produkčnej štruktúry |
| 46 | `20260916100000_harden_invoice_trigger_execute_grants.sql` | obsiahnutá v klone produkčnej štruktúry |
| 47 | `20260916120000_add_company_billing_profile_and_business_partners.sql` | obsiahnutá v klone produkčnej štruktúry |
| 48 | `20260916140000_finance_access_hardening.sql` | obsiahnutá v klone produkčnej štruktúry |
| 49 | `20260916150000_finalize_invoice_category_aware_vat.sql` | obsiahnutá v klone produkčnej štruktúry |
| 50 | `20260917100000_add_invoicing_en16931_p0_fields.sql` | obsiahnutá v klone produkčnej štruktúry |
| 51 | `20260920120000_add_received_invoice_core.sql` | obsiahnutá v klone produkčnej štruktúry |
| 52 | `20260920121000_add_invoice_dedupe.sql` | obsiahnutá v klone produkčnej štruktúry |
| 53 | `20260920122000_add_invoicing_en16931_p1_fields.sql` | obsiahnutá v klone produkčnej štruktúry |
| 54 | `20260920123000_harden_remaining_trigger_execute_grants.sql` | obsiahnutá v klone produkčnej štruktúry |
| 55 | `20260920140000_direction_aware_invoice_finalize.sql` | obsiahnutá v klone produkčnej štruktúry |
| 56 | `20260920150000_harden_finalized_invoice_immutability.sql` | obsiahnutá v klone produkčnej štruktúry |
| 57 | `20260921100000_add_received_invoice_intake.sql` | obsiahnutá v klone produkčnej štruktúry |
| 58 | `20260921120000_finance_document_access_hardening.sql` | obsiahnutá v klone produkčnej štruktúry |
| 59 | `20260921140000_finance_write_integrity_and_quota_lockdown.sql` | obsiahnutá v klone produkčnej štruktúry |
| 60 | `20260921160000_partner_payment_identifiers.sql` | obsiahnutá v klone produkčnej štruktúry |
| 61 | `20260922100000_add_accountant_role_and_scope_gates.sql` | obsiahnutá v klone produkčnej štruktúry |
| 62 | `20260923100000_accountant_least_privilege_entity_resolver.sql` (duplicitný prefix, poradie podľa názvu) | obsiahnutá v klone produkčnej štruktúry |
| 63 | `20260923100000_add_accounting_handoff_lifecycle.sql` (duplicitný prefix, poradie podľa názvu) | obsiahnutá v klone produkčnej štruktúry |
| 64 | `20260923140000_harden_accounting_handoff.sql` | obsiahnutá v klone produkčnej štruktúry |
| 65 | `20260923170000_harden_client_role_privileges.sql` | obsiahnutá v klone produkčnej štruktúry |
| 66 | `20260923190000_canonical_price_mode.sql` | obsiahnutá v klone produkčnej štruktúry |
| 67 | `20260923200000_revoke_anon_execute_on_definer_functions.sql` | obsiahnutá v klone produkčnej štruktúry |
| 68 | `20260923210000_complete_handoff_package.sql` | obsiahnutá v klone produkčnej štruktúry |
| 69 | `20260924100000_add_assistant_conversation_context.sql` | obsiahnutá v klone produkčnej štruktúry |
| 70 | `20260925100000_add_conversation_context_single_use_claim.sql` | obsiahnutá v klone produkčnej štruktúry |
| 71 | `20260926100000_document_folders_and_download_events.sql` | obsiahnutá v klone produkčnej štruktúry |
| 72 | `20260926110000_document_folders_policy_initplan.sql` | obsiahnutá v klone produkčnej štruktúry |
| 73 | `20260926120000_role_scope_voice_hardening.sql` | obsiahnutá v klone produkčnej štruktúry |
| 74 | `20260926130000_inbox_bulk_delete_confirmation.sql` | obsiahnutá v klone produkčnej štruktúry |
| 75 | `20260927100000_assistant_rename_confirmation.sql` | obsiahnutá v klone produkčnej štruktúry |
| 76 | `20260927110000_push_notifications.sql` (v produkcii aplikovaná až po 20260930*) | obsiahnutá v klone produkčnej štruktúry |
| 77 | `20260927120000_beta_gate_allow_oauth_invites.sql` | obsiahnutá v klone produkčnej štruktúry |
| 78 | `20260928100000_company_entitlements_trial.sql` | obsiahnutá v klone produkčnej štruktúry |
| 79 | `20260929100000_closed_beta_p0_hardening.sql` | obsiahnutá v klone produkčnej štruktúry |
| 80 | `20260930100000_m1_authz_review_log_and_chat_reference.sql` | obsiahnutá v klone produkčnej štruktúry |
| 81 | `20260930110000_m1_authz_inbox_categories_insert.sql` | obsiahnutá v klone produkčnej štruktúry |
| 82 | `20260930120000_m1_authz_accountant_document_scope.sql` | obsiahnutá v klone produkčnej štruktúry |
| 83 | `20260930125000_m1_authz_intake_extraction_rpc.sql` | obsiahnutá v klone produkčnej štruktúry |
| 84 | `20260930130000_m1_authz_documents_insert_shape.sql` | obsiahnutá v klone produkčnej štruktúry |
| 85 | `20260930135000_m1_authz_ai_evidence_insert_shape.sql` | obsiahnutá v klone produkčnej štruktúry |
| 86 | `20260930140000_m1_authz_intake_storage_immutable.sql` | obsiahnutá v klone produkčnej štruktúry |
| 87 | `20260930150000_m1_authz_human_chat_membership.sql` | obsiahnutá v klone produkčnej štruktúry |
| 88 | `20261001130000_push_devices_session_binding.sql` | obsiahnutá v klone produkčnej štruktúry |
| 89 | `20261002100000_einvoice_foundation.sql` | **aplikovať** (MCP `apply_migration`, staging) |
| 90 | `20261002110000_einvoice_en16931_fields.sql` | **aplikovať** (MCP `apply_migration`, staging) |
| 91 | `20261002120000_einvoice_outbound_flow.sql` | **aplikovať** (MCP `apply_migration`, staging) |
| 92 | `20261002130000_einvoice_inbound_flow.sql` | **aplikovať** (MCP `apply_migration`, staging) |
| 93 | `20261002140000_einvoice_operations.sql` | **aplikovať** (MCP `apply_migration`, staging) |
| 94 | `20261002150000_einvoice_rollout_gate.sql` | **aplikovať** (MCP `apply_migration`, staging) |
