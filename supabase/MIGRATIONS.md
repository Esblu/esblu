# Esblu — production migration workflow

> ## ⚠️ DO NOT USE `supabase db push` AGAINST ESBLU PRODUCTION WITH THE CURRENT MIGRATION HISTORY.
>
> Production migration history and the repo migration versions do **not** align
> (see below). `db push` would either refuse to run or, after a careless
> "repair", try to re-apply every repo migration from the beginning — most of
> the early files are not idempotent and would fail with duplicate-object
> errors partway through.

## 1. Production project

| Item | Value |
| --- | --- |
| Supabase project | `assetpilot` |
| Project ref | `fkpgvgvsmbpieduoatrt` |

Never run a migration against any other project (`esblu-test`,
`skitze-protokoly`) unless a task explicitly says so. Verify the ref before
every mutation.

## 2. How production migrations are applied today

Production migrations are applied through **Supabase MCP `apply_migration`**
(the `project_id` must be `fkpgvgvsmbpieduoatrt`). The Supabase CLI is not
linked to production in this repo (`supabase/config.toml` does not exist).

## 3. How MCP records migration history

`apply_migration` writes a row to `supabase_migrations.schema_migrations`:

- `version` is the **UTC timestamp of the moment the migration was applied**
  (for example `20260923215522`).
- `version` is **NOT** the local filename prefix (for example `20260926100000`).
- `name` is the name passed to `apply_migration`. Where available it
  identifies the corresponding repo file (for example
  `20260926100000_document_folders_and_download_events`); older rows use the
  bare name without the prefix (for example `complete_handoff_package`).
- `statements` holds the SQL that was actually executed. The table has no
  checksum and no separate `applied_at` column.

Verified in the read-only audit of 24 Sep 2026:

- 38 production history rows, 72 repo migration files.
- **0** repo filename prefixes appear as a production `version`.
- All 38 production versions are apply timestamps.
- The 37 oldest repo files (`20260721000100` … `20260830090000`) have no
  history row at all — they were applied outside the migration tracker.
- 3 production rows have no repo file: `accountant_role_rpc_updates`,
  `harden_accounting_handoff_grants`,
  `harden_client_role_privileges_anon_select_default`.

This mismatch is the project's normal historical state, not damage from a
single operation.

## 4. Supabase CLI

Because the CLI matches migrations **only** by version, it would see every repo
file as pending and every production row as remote-only.

**Never run `supabase db push` against production** unless a dedicated
migration-history reconciliation has first been completed and verified
(section 10).

## 5. Do not rename applied migrations

Do not rename already-applied repo migration files to match remote version
timestamps. Production never recorded a filename prefix, so renaming fixes
nothing and breaks the link between the repo file and the `name` in history.

## 6. Versions for new migrations

- Current highest reserved repo migration version: **`20260926110000`**.
- New repo migrations must use a unique, monotonically higher version,
  starting at **`20260926120000`** or later.
- Do not rely on `supabase migration new` for the prefix — it stamps the
  current time, which may be lower than the highest reserved version.

## 7. No duplicate prefixes

Every repo migration must have a unique version prefix. There is one historical
duplicate (`20260923100000` — `accountant_least_privilege_entity_resolver` and
`add_accounting_handoff_lifecycle`); leave it as is and do not create new ones.

## 8. Rules for every new migration

New migrations should be **additive and idempotent where practical**
(`create … if not exists`, `drop policy if exists` + `create policy`,
`create or replace function`, guarded `do $$ … $$` blocks). In addition they
must:

- **verify the exact production project** (`fkpgvgvsmbpieduoatrt`) before any
  mutation;
- be **committed to the repo first** (the repo file is the source of record);
- **audit RLS**: RLS enabled, explicit `to authenticated` policies, company
  isolation via `esblu_my_active_company_id()`, finance gating via
  `esblu_my_finance_view()` / `esblu_my_finance_manage()` where relevant;
- **audit grants**: explicit `revoke … from public, anon, authenticated`
  followed by only the grants the app needs;
- **preserve client privilege hardening** (migration
  `20260923170000_harden_client_role_privileges.sql`): no `TRUNCATE`,
  `TRIGGER`, `REFERENCES` or `MAINTAIN` for client roles, no access for `anon`;
- **preserve anon SECURITY DEFINER hardening** (migration
  `20260923200000_revoke_anon_execute_on_definer_functions.sql`): every
  `SECURITY DEFINER` function has `set search_path = ''`, fails closed, and
  has `execute` revoked from `public` and `anon`;
- never rewrite finalized financial data or delete audit/handoff evidence.

## 9. Production deployment procedure

1. **Repo migration** — write `supabase/migrations/<version>_<name>.sql`
   (version per section 6) and commit it.
2. **Verify project ref** — the target must be `fkpgvgvsmbpieduoatrt`.
3. **MCP `apply_migration`** — `project_id = fkpgvgvsmbpieduoatrt`,
   `name = <version>_<name>` (the full repo filename without `.sql`), and the
   SQL of the repo file.
4. **Verify the resulting schema** — tables, columns, constraints, policies,
   grants and function privileges match the repo file.
5. **Role/RLS regression** — at minimum owner, accountant, admin with and
   without finance, employee (also with forged `permissions.finance`), another
   tenant and anon. Run synthetic tests inside a transaction that is rolled
   back (see `scripts/sql/document-folders-rls-matrix.sql` for the pattern).
6. **Advisors** — Supabase security and performance advisors; fix new
   findings on the objects you created.
7. **Record/report the remote history entry** — read
   `supabase_migrations.schema_migrations` and report the recorded `version`
   (apply timestamp) and `name` next to the repo filename:

   ```sql
   select version, name
   from supabase_migrations.schema_migrations
   order by version desc
   limit 5;
   ```

## 10. Future reconciliation

If Esblu later adopts Supabase CLI branching or `db push`, aligning the
migration history is a **separate, planned maintenance task**. It is not part
of normal feature work. It would involve at least:

- backing up `supabase_migrations.schema_migrations`;
- resolving the duplicate `20260923100000` prefix and the 3 production-only
  history rows;
- linking the CLI and using `supabase migration repair` to mark remote-only
  rows reverted and every repo version applied — metadata only, no SQL
  executed against the schema;
- verifying with `supabase migration list --linked` before any `db push`.

Until that task is completed and verified, section 4 applies.
