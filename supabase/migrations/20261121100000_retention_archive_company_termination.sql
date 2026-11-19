-- =============================================================================
-- Retenčný archív účtovných dokladov pri ukončení firmy (Priorita 2 — ochrana dokladov)
-- =============================================================================
-- Nález (audit 2026-11-19): od 12. 11. 2026 (20261112110000) termination workflow
-- v režime 'exported' aj 'waived' FYZICKY MAŽE finalizované faktúry (+ položky,
-- strany, rozpis DPH, platby, udalosti), e-faktúry (XML v Storage), dôkazy
-- doručenia (einvoice_events) a metadáta odovzdaní účtovníkovi. To je v rozpore
-- s tým, čo dostala CLIA (zrušenie blokované, XML sa nikdy nemaže) a s lehotami
-- uchovávania účtovných dokladov (z. 431/2002 § 35, z. 222/2004 § 76).
--
-- Riešenie (aditívne, reverzibilné):
-- 1. Neexponovaná schéma esblu_retention (nie je v Data API; anon/authenticated
--    nemajú USAGE; tabuľky nemajú grant pre nikoho okrem vlastníka):
--      retention_periods   — konfigurovateľné lehoty po kategóriách (návrh =
--                            PROPOSED; ostrá purge maže IBA schválené APPROVED)
--      archived_companies  — snapshot identity firmy (bez owner_id, e-mailov,
--                            IBAN), väzba na company_terminations, legal hold
--      archived_records    — riadok dokladu ako JSONB (bez odkazov na
--                            používateľov), SHA-256, retention_until, Storage
--                            objekty, ktoré sa NEMAŽÚ (XML, sken prijatej faktúry)
--      access_log          — append-only log každého prístupu / zásahu
--      purge_runs          — append-only audit každého behu purge (aj dry-run)
-- 2. public.esblu_company_termination_commit (rovnaká signatúra aj návratový
--    tvar + archive_id) pred výmazom ARCHIVUJE doklady a dôkazy a z cleanup
--    jobu vyradí Storage cesty archivovaných súborov. Ostatné (osobné) údaje
--    firmy sa mažú ako doteraz.
-- 3. Kontrolovaná výnimka: public.esblu_company_termination_synthetic_purge —
--    pôvodné správanie (výmaz bez archívu) IBA pre syntetické testovacie dáta;
--    povinný príznak + referencia + odôvodnenie, iba postgres (žiadny grant,
--    odmietne JWT kontext Data API), zapísané v company_terminations a access_log.
--    Guard: company_id s už dokončeným ukončením (status = 'completed', aj
--    historické riadky z 2026-11-19 bez termination_mode) sa druhýkrát
--    nepurguje → idempotentné already_completed + access_log
--    'synthetic_test_data_purge_skipped' (všeobecne, bez natvrdo zadaných ID).
-- 4. Operátorské funkcie (security definer, service_role/postgres, mimo Data
--    API): operator_list_archives, export_archive, set_legal_hold,
--    approve_retention_period (iba postgres), purge_expired (dry-run default).
-- 5. esblu_account_deletion_commit a retention blocker sa NEMENIA (bežné
--    zrušenie firmy s dokladmi ostáva blokované).
-- 6. Retenčná bezpečnosť (esblu8, 2026-11-19):
--    - archived_records sa dá zmazať IBA v ostrom behu purge_expired a IBA záznam,
--      ktorého kategória je APPROVED, retention_until < as_of behu (as_of ≤ dnes)
--      a archív nie je pod legal hold — overuje to DB trigger, nie iba purge_expired;
--    - účtovné kópie Esblu (public.billing_invoice_documents + PDF v bucket
--      billing-documents) NIE SÚ zákaznícke dáta: purge, ukončenie firmy ani cleanup
--      joby ich nikdy nezahrnú (vlastná retencia Esblu, PROPOSED 10 r., bez
--      automatického mazania — migrácia 20261123110000);
--    - account_deletion_cleanup_jobs: trigger odstráni zo storage_targets každý cieľ
--      v bucket billing-documents a každý súbor uchovávaný v archíve (archived_records.
--      storage_objects) — bez ohľadu na to, ktorá funkcia job zapísala.
--
-- Nasadenie: produkčné vyčistenie 2026-11-19 beží ešte na PÔVODNÝCH funkciách
-- (táto migrácia nie je nasadená) — riadky company_terminations bez
-- termination_mode = staré správanie (výmaz).
-- Rollback: supabase/rollback/20261121100000_retention_archive_company_termination_rollback.sql
-- (archív a logy sa NIKDY nemažú).
-- =============================================================================

-- ----------------------------------------------------------------------------- 0. schéma
create schema if not exists esblu_retention;
revoke all on schema esblu_retention from public, anon, authenticated;
grant usage on schema esblu_retention to service_role;
comment on schema esblu_retention is
  'Retenčný archív účtovných dokladov ukončených firiem. Nie je v Data API. Prístup iba cez security definer '
  'funkcie (operátor), každý prístup v access_log. Návrh: docs/retention-archive-design-2026-11-19.md';

-- ----------------------------------------------------------------------------- 1. tabuľky
create table if not exists esblu_retention.retention_periods (
  category text primary key,
  retention_years integer not null,
  anchor text not null,
  legal_basis text not null,
  approval_status text not null default 'PROPOSED',
  approved_by text null,
  approved_at timestamptz null,
  note text null,
  updated_at timestamptz not null default now(),
  constraint retention_periods_category_check check (category ~ '^[a-z_]{3,60}$'),
  constraint retention_periods_years_check check (retention_years between 1 and 30),
  constraint retention_periods_anchor_check check (anchor in ('end_of_document_year', 'event_date')),
  constraint retention_periods_status_check check (approval_status in ('PROPOSED', 'APPROVED')),
  constraint retention_periods_approved_check check (
    (approval_status = 'APPROVED') = (approved_at is not null and approved_by is not null))
);

-- PROPOSED = návrh, nie právne stanovisko; ostrá purge ich nevykoná, kým ich operátor neschváli.
insert into esblu_retention.retention_periods (category, retention_years, anchor, legal_basis, note) values
  ('accounting_document', 10, 'end_of_document_year',
   'z. 431/2002 Z. z. § 35 ods. 2 (účtovné záznamy 10 r. po roku, ktorého sa týkajú); z. 222/2004 Z. z. § 76 ods. 1 (faktúry 10 r. po roku vyhotovenia)',
   'PROPOSED — finalizované faktúry, dobropisy/ťarchopisy, položky, strany, rozpis DPH, platby, udalosti, zálohy, stav zaúčtovania'),
  ('accounting_document_source', 10, 'end_of_document_year',
   'ako accounting_document (originál prijatej faktúry — sken/PDF)',
   'PROPOSED — documents riadok + súbor v Storage, na ktorý odkazuje finalizovaná faktúra (source_document_id)'),
  ('einvoice_document', 10, 'end_of_document_year',
   'z. 222/2004 Z. z. § 71, § 76 (elektronická faktúra, autenticita pôvodu a integrita obsahu)',
   'PROPOSED — einvoice_outbound/inbound + XML (UBL/SBDH) v Storage einvoice-documents, SHA-256'),
  ('einvoice_delivery_evidence', 10, 'end_of_document_year',
   'z. 222/2004 Z. z. § 71 (preukázanie doručenia / prijatia e-faktúry); oprávnený záujem — právne nároky',
   'PROPOSED — einvoice_events (história stavov, provider kódy)'),
  ('accounting_handoff', 10, 'end_of_document_year',
   'z. 431/2002 Z. z. § 35 (dôkaz odovzdania účtovných záznamov) — NA POSÚDENIE (alternatíva 5 r. ako dôkaz zmluvného vzťahu)',
   'PROPOSED — accounting_handoff_exports + items (iba metadáta a SHA-256, žiadny obsah balíka)')
on conflict (category) do nothing;

create table if not exists esblu_retention.archived_companies (
  id uuid primary key default gen_random_uuid(),
  source_company_id uuid not null,
  termination_id uuid not null,
  archive_reason text not null default 'company_termination',
  company_snapshot jsonb not null,
  record_counts jsonb not null default '{}'::jsonb,
  archived_at timestamptz not null default now(),
  status text not null default 'active',
  legal_hold boolean not null default false,
  legal_hold_reason text null,
  legal_hold_ref text null,
  legal_hold_set_at timestamptz null,
  purged_at timestamptz null,
  constraint archived_companies_termination_unique unique (termination_id),
  constraint archived_companies_reason_check check (archive_reason in ('company_termination')),
  constraint archived_companies_status_check check (status in ('active', 'purged')),
  constraint archived_companies_purged_check check ((status = 'purged') = (purged_at is not null)),
  constraint archived_companies_hold_check check (not legal_hold or (legal_hold_reason is not null and legal_hold_set_at is not null))
);
create index if not exists archived_companies_source_idx on esblu_retention.archived_companies (source_company_id);

create table if not exists esblu_retention.archived_records (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references esblu_retention.archived_companies (id) on delete restrict,
  category text not null references esblu_retention.retention_periods (category) on delete restrict,
  source_table text not null,
  source_id text not null,
  document_date date not null,
  retention_until date not null,
  payload jsonb not null,
  payload_sha256 text not null,
  storage_objects jsonb not null default '[]'::jsonb,
  archived_at timestamptz not null default now(),
  constraint archived_records_unique unique (archive_id, source_table, source_id),
  constraint archived_records_sha_check check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint archived_records_storage_check check (jsonb_typeof(storage_objects) = 'array')
);
create index if not exists archived_records_retention_idx on esblu_retention.archived_records (retention_until);
create index if not exists archived_records_archive_idx on esblu_retention.archived_records (archive_id, category);

create table if not exists esblu_retention.purge_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz null,
  status text not null,
  dry_run boolean not null,
  as_of date not null,
  operator_ref text not null,
  db_session_user text not null default session_user,
  invoker_role text null,
  result jsonb not null default '{}'::jsonb,
  constraint purge_runs_status_check check (status in ('executing', 'completed'))
);

create table if not exists esblu_retention.access_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  action text not null,
  archive_id uuid null,
  source_company_id uuid null,
  operator_ref text null,
  purpose text null,
  db_session_user text not null default session_user,
  invoker_role text null,
  jwt_role text null,
  details jsonb not null default '{}'::jsonb,
  constraint access_log_action_check check (action in (
    'archive_created', 'list', 'export', 'legal_hold_set', 'legal_hold_clear',
    'purge_dry_run', 'purge', 'retention_period_approved', 'synthetic_test_data_purge',
    'synthetic_test_data_purge_skipped'))
);
-- Re-apply na DB s pôvodným zoznamom akcií (create table if not exists ho nezmení) → constraint obnoviť.
alter table esblu_retention.access_log drop constraint if exists access_log_action_check;
alter table esblu_retention.access_log add constraint access_log_action_check check (action in (
  'archive_created', 'list', 'export', 'legal_hold_set', 'legal_hold_clear',
  'purge_dry_run', 'purge', 'retention_period_approved', 'synthetic_test_data_purge',
  'synthetic_test_data_purge_skipped'));
create index if not exists access_log_archive_idx on esblu_retention.access_log (archive_id, at);

-- Žiadne granty na tabuľky (ani service_role) — iba cez funkcie nižšie.
revoke all on table esblu_retention.retention_periods, esblu_retention.archived_companies,
  esblu_retention.archived_records, esblu_retention.purge_runs, esblu_retention.access_log
  from public, anon, authenticated, service_role;
revoke all on sequence esblu_retention.access_log_id_seq from public, anon, authenticated, service_role;
alter table esblu_retention.retention_periods enable row level security;
alter table esblu_retention.archived_companies enable row level security;
alter table esblu_retention.archived_records enable row level security;
alter table esblu_retention.purge_runs enable row level security;
alter table esblu_retention.access_log enable row level security;

-- company_terminations: režim + výnimka + väzba na archív (aditívne).
alter table public.company_terminations add column if not exists termination_mode text null;
alter table public.company_terminations add column if not exists operator_reference text null;
alter table public.company_terminations add column if not exists justification text null;
alter table public.company_terminations add column if not exists archive_id uuid null;
alter table public.company_terminations add column if not exists archived_counts jsonb null;
alter table public.company_terminations drop constraint if exists company_terminations_mode_check;
alter table public.company_terminations add constraint company_terminations_mode_check check (
  termination_mode is null or termination_mode in ('archive', 'synthetic_test_data_purge'));
alter table public.company_terminations drop constraint if exists company_terminations_synthetic_check;
alter table public.company_terminations add constraint company_terminations_synthetic_check check (
  termination_mode is distinct from 'synthetic_test_data_purge'
  or (operator_reference ~ '^[A-Za-z0-9][A-Za-z0-9_:./-]{5,119}$'
      and justification is not null and length(btrim(justification)) between 20 and 1000));
comment on column public.company_terminations.termination_mode is
  'null = pred 20261121100000 (doklady sa mazali); archive = doklady presunuté do esblu_retention; '
  'synthetic_test_data_purge = auditovaná výnimka pre syntetické testovacie dáta (operator_reference + justification).';

-- ----------------------------------------------------------------------------- 2. guardy
create or replace function esblu_retention.purge_in_progress()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_raw text := current_setting('esblu.retention_purge_run', true);
begin
  if v_raw is null or v_raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (select 1 from esblu_retention.purge_runs r
                 where r.id = v_raw::uuid and r.status = 'executing' and not r.dry_run);
end;
$function$;

create or replace function esblu_retention.guard_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_LOG_APPEND_ONLY';
end;
$function$;

create or replace function esblu_retention.guard_purge_runs()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and old.status = 'executing' and new.status = 'completed'
     and new.id = old.id and new.dry_run = old.dry_run and new.as_of = old.as_of
     and new.operator_ref = old.operator_ref and new.started_at = old.started_at then
    return new;
  end if;
  raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_LOG_APPEND_ONLY';
end;
$function$;

create or replace function esblu_retention.guard_archived_records()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_raw text;
  v_as_of date;
begin
  if tg_op = 'DELETE' then
    if esblu_retention.purge_in_progress() then
      -- Aj počas ostrého behu: iba záznam po APPROVED lehote, bez legal hold (obrana do hĺbky —
      -- chyba v purge_expired ani priamy DELETE v jeho transakcii nezmaže doklad pred lehotou).
      v_raw := current_setting('esblu.retention_purge_run', true);
      select r.as_of into v_as_of from esblu_retention.purge_runs r where r.id = v_raw::uuid;
      if v_as_of is not null and v_as_of <= current_date
         and old.retention_until < v_as_of
         and exists (select 1 from esblu_retention.retention_periods p
                     where p.category = old.category and p.approval_status = 'APPROVED')
         and old.retention_until >= esblu_retention.compute_retention_until(old.category, old.document_date)
         and not exists (select 1 from esblu_retention.archived_companies a
                         where a.id = old.archive_id and a.legal_hold) then
        return old;
      end if;
      raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_NOT_EXPIRED',
        hint = 'Záznam nie je po schválenej (APPROVED) lehote alebo je pod legal hold.';
    end if;
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_ARCHIVE_IMMUTABLE',
      hint = 'Archív sa maže iba cez esblu_retention.purge_expired po uplynutí retention_until (bez legal hold).';
  end if;
  -- UPDATE: iba prepočet retention_until (schválenie lehoty); obsah je nemenný.
  if (to_jsonb(new) - 'retention_until') = (to_jsonb(old) - 'retention_until') then
    return new;
  end if;
  raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_ARCHIVE_IMMUTABLE';
end;
$function$;

create or replace function esblu_retention.guard_archived_companies()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_ARCHIVE_IMMUTABLE',
      hint = 'Záznam archívu firmy sa nemaže; po purge ostáva minimalizovaný (status purged).';
  end if;
  if new.id <> old.id or new.source_company_id <> old.source_company_id or new.termination_id <> old.termination_id
     or new.archived_at <> old.archived_at or new.archive_reason <> old.archive_reason
     or (old.status = 'purged' and new.status <> 'purged') then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_ARCHIVE_IMMUTABLE';
  end if;
  if new.company_snapshot is distinct from old.company_snapshot and new.status <> 'purged' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_ARCHIVE_IMMUTABLE';
  end if;
  return new;
end;
$function$;

revoke all on function esblu_retention.purge_in_progress() from public, anon, authenticated, service_role;
revoke all on function esblu_retention.guard_append_only() from public, anon, authenticated, service_role;
revoke all on function esblu_retention.guard_purge_runs() from public, anon, authenticated, service_role;
revoke all on function esblu_retention.guard_archived_records() from public, anon, authenticated, service_role;
revoke all on function esblu_retention.guard_archived_companies() from public, anon, authenticated, service_role;

drop trigger if exists esblu_retention_access_log_append_only on esblu_retention.access_log;
create trigger esblu_retention_access_log_append_only before update or delete on esblu_retention.access_log
  for each row execute function esblu_retention.guard_append_only();
drop trigger if exists esblu_retention_access_log_no_truncate on esblu_retention.access_log;
create trigger esblu_retention_access_log_no_truncate before truncate on esblu_retention.access_log
  for each statement execute function esblu_retention.guard_append_only();
drop trigger if exists esblu_retention_purge_runs_guard on esblu_retention.purge_runs;
create trigger esblu_retention_purge_runs_guard before update or delete on esblu_retention.purge_runs
  for each row execute function esblu_retention.guard_purge_runs();
drop trigger if exists esblu_retention_purge_runs_no_truncate on esblu_retention.purge_runs;
create trigger esblu_retention_purge_runs_no_truncate before truncate on esblu_retention.purge_runs
  for each statement execute function esblu_retention.guard_append_only();
drop trigger if exists esblu_retention_archived_records_guard on esblu_retention.archived_records;
create trigger esblu_retention_archived_records_guard before update or delete on esblu_retention.archived_records
  for each row execute function esblu_retention.guard_archived_records();
drop trigger if exists esblu_retention_archived_records_no_truncate on esblu_retention.archived_records;
create trigger esblu_retention_archived_records_no_truncate before truncate on esblu_retention.archived_records
  for each statement execute function esblu_retention.guard_append_only();
drop trigger if exists esblu_retention_archived_companies_guard on esblu_retention.archived_companies;
create trigger esblu_retention_archived_companies_guard before update or delete on esblu_retention.archived_companies
  for each row execute function esblu_retention.guard_archived_companies();
drop trigger if exists esblu_retention_archived_companies_no_truncate on esblu_retention.archived_companies;
create trigger esblu_retention_archived_companies_no_truncate before truncate on esblu_retention.archived_companies
  for each statement execute function esblu_retention.guard_append_only();

-- ----------------------------------------------------------------------------- 3. pomocné funkcie
-- Volajúci: nikdy anon/authenticated (ani cez JWT), povinná referencia (tiket / schválenie).
create or replace function esblu_retention.assert_operator(p_operator_ref text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_jwt_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  v_role text := current_setting('role', true);
begin
  if coalesce(v_jwt_role, '') in ('anon', 'authenticated') or coalesce(v_role, '') in ('anon', 'authenticated') then
    raise exception using errcode = '42501', message = 'ESBLU_RETENTION_OPERATOR_ONLY';
  end if;
  if p_operator_ref is null or p_operator_ref !~ '^[A-Za-z0-9][A-Za-z0-9_:./-]{5,119}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_OPERATOR_REF_REQUIRED';
  end if;
end;
$function$;

create or replace function esblu_retention.log_access(
  p_action text, p_archive_id uuid, p_company_id uuid, p_operator_ref text, p_purpose text, p_details jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into esblu_retention.access_log (action, archive_id, source_company_id, operator_ref, purpose, invoker_role, jwt_role, details)
  values (p_action, p_archive_id, p_company_id, p_operator_ref, left(p_purpose, 500),
          nullif(current_setting('role', true), 'none'),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
          coalesce(p_details, '{}'::jsonb));
end;
$function$;

create or replace function esblu_retention.compute_retention_until(p_category text, p_date date)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_p esblu_retention.retention_periods;
begin
  select * into v_p from esblu_retention.retention_periods p where p.category = p_category;
  if v_p.category is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_CATEGORY_UNKNOWN';
  end if;
  if v_p.anchor = 'end_of_document_year' then
    return make_date(extract(year from coalesce(p_date, current_date))::int + v_p.retention_years, 12, 31);
  end if;
  return (coalesce(p_date, current_date) + make_interval(years => v_p.retention_years))::date;
end;
$function$;

-- Minimalizácia: preč odkazy na používateľov a AI/pracovné polia, ktoré nie sú súčasťou dokladu.
create or replace function esblu_retention.minimise(p_table text, p_row jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select p_row
    - array['created_by', 'updated_by', 'finalized_by', 'recorded_by', 'actor_user_id', 'accounted_by',
            'changed_by', 'requested_by', 'correction_reviewed_by', 'advance_reviewed_by', 'user_id',
            'client_mutation_id', 'locked_until']
    - case p_table
        when 'documents' then array['ai_raw_output', 'extracted_fields', 'field_confidence', 'ai_model', 'note',
                                    'custom_category_id', 'deleted_at', 'archived_from_inbox_at', 'status']
        else array[]::text[]
      end
$function$;

create or replace function esblu_retention.invoice_document_date(p_invoice_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(i.issue_date, i.received_at, i.finalized_at::date, i.created_at::date)
  from public.invoices i where i.id = p_invoice_id
$function$;

create or replace function esblu_retention.storage_list(p_bucket text, variadic p_paths text[])
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('bucket', p_bucket, 'path', s.x) order by s.x), '[]'::jsonb)
  from (select distinct u.x from unnest(p_paths) u(x) where p_bucket is not null and u.x is not null and u.x <> '') s
$function$;

-- Jedna tabuľka → archív. Výrazy sú konštanty z archive_company_documents (žiadny vstup klienta).
create or replace function esblu_retention.archive_rows(
  p_archive uuid, p_category text, p_table text, p_where text, p_key text, p_date text, p_storage text,
  p_company uuid, p_inv uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_n integer;
begin
  if to_regclass('public.' || p_table) is null then
    return 0;
  end if;
  execute format($q$
    insert into esblu_retention.archived_records
      (archive_id, category, source_table, source_id, document_date, retention_until, payload, payload_sha256, storage_objects)
    select $1, $2, %L, s.k, s.d, esblu_retention.compute_retention_until($2, s.d), s.p,
           encode(sha256(convert_to(s.p::text, 'UTF8')), 'hex'), s.so
    from (
      select (%s)::text k, coalesce((%s)::date, current_date) d, esblu_retention.minimise(%L, to_jsonb(t)) p, (%s)::jsonb so
      from public.%I t
      where %s
    ) s
    on conflict (archive_id, source_table, source_id) do nothing
  $q$, p_table, p_key, p_date, p_table, coalesce(p_storage, '''[]''::jsonb'), p_table, p_where)
  using p_archive, p_category, p_company, p_inv;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

revoke all on function esblu_retention.assert_operator(text) from public, anon, authenticated, service_role;
revoke all on function esblu_retention.log_access(text, uuid, uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function esblu_retention.compute_retention_until(text, date) from public, anon, authenticated, service_role;
revoke all on function esblu_retention.minimise(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function esblu_retention.invoice_document_date(uuid) from public, anon, authenticated, service_role;
revoke all on function esblu_retention.storage_list(text, text[]) from public, anon, authenticated, service_role;
revoke all on function esblu_retention.archive_rows(uuid, text, text, text, text, text, text, uuid, uuid[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------- 4. archivácia firmy
-- Volá sa IBA z termination_execute (v tej istej transakcii, PRED výmazom).
-- Vráti archive_id alebo null (firma nemá nič, čo treba uchovať).
create or replace function esblu_retention.archive_company_documents(p_company_id uuid, p_termination_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_inv uuid[];
  v_archive uuid;
  v_snapshot jsonb;
  v_counts jsonb;
  v_date constant text := 'esblu_retention.invoice_document_date(t.invoice_id)';
begin
  if p_company_id is null or p_termination_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_ARCHIVE_INVALID';
  end if;

  select coalesce(array_agg(i.id), '{}') into v_inv
  from public.invoices i where i.company_id = p_company_id and i.document_status = 'finalized';

  if cardinality(v_inv) = 0
     and not exists (select 1 from public.einvoice_outbound x where x.company_id = p_company_id)
     and not exists (select 1 from public.einvoice_inbound x where x.company_id = p_company_id)
     and not exists (select 1 from public.einvoice_events x where x.company_id = p_company_id)
     and not exists (select 1 from public.accounting_handoff_exports x where x.company_id = p_company_id) then
    return null;
  end if;

  -- Identita firmy potrebná na doklady (bez owner_id, e-mailov, IBAN, loga).
  select jsonb_build_object(
    'company_name', c.name,
    'company_created_at', c.created_at,
    'legal_identity', (select jsonb_build_object('country_code', l.country_code, 'registration_id', l.registration_id,
                         'legal_entity_key', l.legal_entity_key, 'verification_status', l.verification_status,
                         'verified_source', l.verified_source)
                       from public.company_legal_identities l where l.company_id = c.id),
    'billing_profile', (select jsonb_build_object('legal_name', b.legal_name, 'ico', b.ico, 'dic', b.dic, 'ic_dph', b.ic_dph,
                          'address_line1', b.address_line1, 'address_line2', b.address_line2, 'city', b.city,
                          'postal_code', b.postal_code, 'country_code', b.country_code, 'vat_payer_status', b.vat_payer_status,
                          'vat_identifier', b.vat_identifier, 'legal_registration_id', b.legal_registration_id)
                        from public.company_billing_profile b where b.company_id = c.id),
    'snapshot_at', now())
  into v_snapshot
  from public.companies c where c.id = p_company_id;

  insert into esblu_retention.archived_companies (source_company_id, termination_id, company_snapshot)
  values (p_company_id, p_termination_id, coalesce(v_snapshot, '{}'::jsonb))
  on conflict (termination_id) do nothing
  returning id into v_archive;
  if v_archive is null then
    select a.id into v_archive from esblu_retention.archived_companies a where a.termination_id = p_termination_id;
  end if;

  -- Účtovné doklady (iba finalizované; koncepty nie sú doklady a mažú sa ako doteraz).
  perform esblu_retention.archive_rows(v_archive, 'accounting_document', 'invoices', 't.id = any($4)', 't.id',
    'esblu_retention.invoice_document_date(t.id)', null, p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'accounting_document', 'invoice_items', 't.invoice_id = any($4)', 't.id', v_date, null, p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'accounting_document', 'invoice_parties', 't.invoice_id = any($4)', 't.id', v_date, null, p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'accounting_document', 'invoice_tax_breakdowns', 't.invoice_id = any($4)', 't.id', v_date, null, p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'accounting_document', 'invoice_payments', 't.invoice_id = any($4)', 't.id', v_date, null, p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'accounting_document', 'invoice_events', 't.invoice_id = any($4)', 't.id', v_date, null, p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'accounting_document', 'invoice_advance_deductions',
    't.invoice_id = any($4) or t.advance_invoice_id = any($4)', 't.id',
    'coalesce(esblu_retention.invoice_document_date(t.invoice_id), esblu_retention.invoice_document_date(t.advance_invoice_id))', null, p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'accounting_document', 'received_advance_links',
    't.company_id = $3 and (t.invoice_id = any($4) or t.advance_invoice_id = any($4))', 't.id', v_date, null, p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'accounting_document', 'invoice_accounting_state', 't.invoice_id = any($4)', 't.invoice_id', v_date, null, p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'accounting_document', 'invoice_accounting_state_log', 't.invoice_id = any($4)', 't.id', v_date, null, p_company_id, v_inv);

  -- Originál prijatej faktúry (sken / PDF), na ktorý odkazuje finalizovaná faktúra — súbor ostáva v Storage.
  perform esblu_retention.archive_rows(v_archive, 'accounting_document_source', 'documents',
    't.company_id = $3 and t.id in (select i.source_document_id from public.invoices i where i.id = any($4) and i.source_document_id is not null)',
    't.id',
    '(select min(esblu_retention.invoice_document_date(i.id)) from public.invoices i where i.source_document_id = t.id and i.id = any($4))',
    'esblu_retention.storage_list(t.storage_bucket, t.storage_path)', p_company_id, v_inv);

  -- e-faktúry (všetky, aj ku konceptom — XML je originál dokladu) + dôkazy doručenia.
  perform esblu_retention.archive_rows(v_archive, 'einvoice_document', 'einvoice_outbound', 't.company_id = $3', 't.id',
    'coalesce(esblu_retention.invoice_document_date(t.invoice_id), t.created_at::date)',
    'esblu_retention.storage_list(''einvoice-documents'', t.ubl_storage_path)', p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'einvoice_document', 'einvoice_inbound', 't.company_id = $3', 't.id',
    'coalesce(t.issue_date, t.received_at::date, t.created_at::date)',
    'esblu_retention.storage_list(''einvoice-documents'', t.xml_storage_path, t.pdf_storage_path)', p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'einvoice_delivery_evidence', 'einvoice_events', 't.company_id = $3', 't.id',
    't.created_at::date', null, p_company_id, v_inv);

  -- Odovzdania účtovníkovi (iba metadáta a SHA-256).
  perform esblu_retention.archive_rows(v_archive, 'accounting_handoff', 'accounting_handoff_exports', 't.company_id = $3', 't.id',
    't.created_at::date', null, p_company_id, v_inv);
  perform esblu_retention.archive_rows(v_archive, 'accounting_handoff', 'accounting_handoff_export_items', 't.company_id = $3',
    't.export_id::text || '':'' || t.invoice_id::text',
    '(select e.created_at::date from public.accounting_handoff_exports e where e.id = t.export_id)', null, p_company_id, v_inv);

  select coalesce(jsonb_object_agg(x.k, x.n), '{}'::jsonb) into v_counts
  from (select r.category || ':' || r.source_table k, count(*) n
        from esblu_retention.archived_records r where r.archive_id = v_archive group by 1) x;
  update esblu_retention.archived_companies set record_counts = v_counts where id = v_archive;

  perform esblu_retention.log_access('archive_created', v_archive, p_company_id, 'termination:' || p_termination_id::text,
    'company_termination', jsonb_build_object('termination_id', p_termination_id, 'record_counts', v_counts));
  return v_archive;
end;
$function$;

revoke all on function esblu_retention.archive_company_documents(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------- 5. termination (spoločné jadro)
create or replace function esblu_retention.termination_execute(
  p_user_id uuid,
  p_company_id uuid,
  p_delete_account boolean,
  p_export_mode text,
  p_mode text,
  p_reference text,
  p_justification text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tid uuid;
  v_done public.company_terminations;
  v_inv uuid[];
  v_xml jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_res jsonb;
  v_job uuid;
  v_targets jsonb;
  v_archive uuid;
  v_archived jsonb := null;
  v_keep jsonb := '[]'::jsonb;
begin
  if p_user_id is null or p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_ACCOUNT_DELETION_INVALID_REQUEST';
  end if;
  if p_export_mode is null or p_export_mode not in ('exported', 'waived') then
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_NOT_CONFIRMED';
  end if;
  if p_mode is null or p_mode not in ('archive', 'synthetic_test_data_purge') then
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_MODE_INVALID';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    select * into v_done from public.company_terminations t
    where t.company_id = p_company_id and t.requested_by = p_user_id and t.status = 'completed'
    order by t.completed_at desc limit 1;
    if v_done.id is not null then
      return jsonb_build_object(
        'already_completed', true, 'termination_id', v_done.id, 'job_id', v_done.cleanup_job_id,
        'storage_targets', '[]'::jsonb, 'summary', null, 'delete_account', false,
        'archive_id', v_done.archive_id, 'termination_mode', v_done.termination_mode
      );
    end if;
    raise exception using errcode = 'P0001', message = 'ESBLU_NOT_ACTIVE_OWNER';
  end if;

  if not exists (
    select 1 from public.company_members cm
    where cm.user_id = p_user_id and cm.company_id = p_company_id and cm.status = 'active' and cm.role = 'owner'
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_NOT_ACTIVE_OWNER';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id and c.owner_id = p_user_id) then
    raise exception using errcode = 'P0001', message = 'ESBLU_OWNER_MISMATCH';
  end if;

  if to_regclass('public.einvoice_organizations') is not null and exists (
    select 1 from public.einvoice_organizations o where o.company_id = p_company_id and o.provider_org_id is not null
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_PROVIDER_ENROLLED';
  end if;

  insert into public.company_terminations
    (company_id, requested_by, status, export_mode, termination_mode, operator_reference, justification)
  values (p_company_id, p_user_id, 'executing', p_export_mode, p_mode,
          case when p_mode = 'synthetic_test_data_purge' then p_reference end,
          case when p_mode = 'synthetic_test_data_purge' then p_justification end)
  returning id into v_tid;
  perform set_config('esblu.company_termination_id', v_tid::text, true);

  if p_mode = 'archive' then
    -- Doklady a dôkazy → archív (PRED výmazom); ich Storage súbory sa NEMAŽÚ.
    v_archive := esblu_retention.archive_company_documents(p_company_id, v_tid);
    if v_archive is not null then
      select coalesce(jsonb_object_agg(x.category, x.n), '{}'::jsonb) into v_archived
      from (select r.category, count(*) n from esblu_retention.archived_records r
            where r.archive_id = v_archive group by 1) x;
      select coalesce(jsonb_agg(distinct o.value), '[]'::jsonb) into v_keep
      from esblu_retention.archived_records r, jsonb_array_elements(r.storage_objects) o
      where r.archive_id = v_archive;
    end if;
  else
    -- Výnimka (syntetické testovacie dáta): pôvodné správanie — aj XML e-faktúr ide do cleanupu.
    select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', 'einvoice-documents', 'path', x.p)), '[]'::jsonb)
    into v_xml
    from (
      select i.xml_storage_path as p from public.einvoice_inbound i where i.company_id = p_company_id and i.xml_storage_path is not null
      union all
      select o.ubl_storage_path from public.einvoice_outbound o where o.company_id = p_company_id and o.ubl_storage_path is not null
    ) x;
  end if;

  select coalesce(array_agg(i.id), '{}') into v_inv from public.invoices i where i.company_id = p_company_id;

  delete from public.einvoice_events where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('einvoice_events', v_n);
  delete from public.einvoice_outbound where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('einvoice_outbound', v_n);
  delete from public.einvoice_inbound where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('einvoice_inbound', v_n);
  delete from public.received_advance_links where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('received_advance_links', v_n);
  delete from public.invoice_advance_deductions where invoice_id = any(v_inv) or advance_invoice_id = any(v_inv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoice_advance_deductions', v_n);
  delete from public.invoice_items where invoice_id = any(v_inv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoice_items', v_n);
  delete from public.invoice_events where invoice_id = any(v_inv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoice_events', v_n);
  delete from public.invoice_parties where invoice_id = any(v_inv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoice_parties', v_n);
  delete from public.invoice_tax_breakdowns where invoice_id = any(v_inv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoice_tax_breakdowns', v_n);
  delete from public.invoices where company_id = p_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoices', v_n);

  v_res := public.esblu_account_deletion_commit('owner', p_user_id, p_company_id, coalesce(p_delete_account, false));
  v_job := nullif(v_res->>'job_id', '')::uuid;

  -- Storage ciele: (zber firmy + XML pri výnimke) MÍNUS súbory archivovaných dokladov a MÍNUS
  -- účtovné kópie Esblu (bucket billing-documents — nikdy nie sú cieľom ukončenia firmy).
  select coalesce(jsonb_agg(distinct x.value), '[]'::jsonb) into v_targets
  from jsonb_array_elements(coalesce(v_res->'storage_targets', '[]'::jsonb) || v_xml) x
  where coalesce(x.value->>'bucket', '') <> 'billing-documents'
    and not exists (select 1 from jsonb_array_elements(v_keep) k
                    where k.value->>'bucket' = x.value->>'bucket' and k.value->>'path' = x.value->>'path');

  if v_job is not null and v_targets is distinct from coalesce(v_res->'storage_targets', '[]'::jsonb) then
    update public.account_deletion_cleanup_jobs
       set storage_targets = v_targets,
           storage_target_count = jsonb_array_length(v_targets),
           storage_status = case when jsonb_array_length(v_targets) = 0 then 'done' else 'pending' end,
           completed_at = case when jsonb_array_length(v_targets) = 0 and auth_status = 'done'
                               then coalesce(completed_at, now()) end
     where id = v_job;
  end if;

  update public.company_terminations
     set status = 'completed',
         completed_at = now(),
         cleanup_job_id = v_job,
         storage_target_count = jsonb_array_length(v_targets),
         deleted_counts = v_counts || coalesce(v_res->'summary'->'deleted_counts', '{}'::jsonb),
         archive_id = v_archive,
         archived_counts = v_archived
   where id = v_tid;

  if p_mode = 'synthetic_test_data_purge' then
    perform esblu_retention.log_access('synthetic_test_data_purge', null, p_company_id, p_reference, p_justification,
      jsonb_build_object('termination_id', v_tid, 'deleted_counts', v_counts));
  end if;

  perform set_config('esblu.company_termination_id', '', true);

  return jsonb_set(v_res, '{storage_targets}', v_targets)
    || jsonb_build_object('termination_id', v_tid, 'archive_id', v_archive, 'termination_mode', p_mode,
                          'archived_counts', coalesce(v_archived, '{}'::jsonb));
end;
$function$;

revoke all on function esblu_retention.termination_execute(uuid, uuid, boolean, text, text, text, text)
  from public, anon, authenticated, service_role;

-- Bežná cesta (route /api/account/delete → company termination, service_role): VŽDY archív.
create or replace function public.esblu_company_termination_commit(
  p_user_id uuid,
  p_company_id uuid,
  p_delete_account boolean,
  p_export_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return esblu_retention.termination_execute(p_user_id, p_company_id, p_delete_account, p_export_mode, 'archive', null, null);
end;
$function$;

comment on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) is
  'VOP 20.6 / DPA (service_role only): ukončenie firmy po potvrdení Vlastníka a exporte (exported) alebo vzdaní sa '
  'exportu (waived). Od 20261121100000: finalizované doklady, e-faktúry (vrátane XML), dôkazy doručenia a metadáta '
  'odovzdaní sa PRESUNÚ do esblu_retention (retenčný archív), ostatné údaje firmy sa zmažú. Idempotentné.';

revoke all on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) to service_role;

-- Kontrolovaná výnimka: IBA syntetické testovacie dáta, IBA postgres (SQL editor / priama DB rola bez JWT).
create or replace function public.esblu_company_termination_synthetic_purge(
  p_user_id uuid,
  p_company_id uuid,
  p_delete_account boolean,
  p_export_mode text,
  p_synthetic_test_data_purge boolean,
  p_reference text,
  p_justification text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_claims_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  v_done public.company_terminations;
begin
  if v_claims_role is not null then
    raise exception using errcode = '42501', message = 'ESBLU_OPERATOR_ONLY';
  end if;
  if p_synthetic_test_data_purge is distinct from true then
    raise exception using errcode = 'P0001', message = 'ESBLU_SYNTHETIC_PURGE_FLAG_REQUIRED';
  end if;
  if p_reference is null or p_reference !~ '^[A-Za-z0-9][A-Za-z0-9_:./-]{5,119}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_SYNTHETIC_PURGE_REFERENCE_REQUIRED';
  end if;
  if p_justification is null or length(btrim(p_justification)) not between 20 and 1000 then
    raise exception using errcode = 'P0001', message = 'ESBLU_SYNTHETIC_PURGE_JUSTIFICATION_REQUIRED';
  end if;
  if p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_ACCOUNT_DELETION_INVALID_REQUEST';
  end if;

  -- Guard proti opakovanému purge: firma, ktorá už má DOKONČENÉ ukončenie (akýmkoľvek režimom,
  -- akýmkoľvek žiadateľom, vrátane historických riadkov bez termination_mode), sa druhýkrát
  -- nepurguje. Vráti idempotentné already_completed, nič nemaže, pokus zapíše do access_log.
  -- Zámok serializuje súbežné volania pre to isté company_id.
  perform pg_advisory_xact_lock(hashtextextended('esblu_synthetic_purge:' || p_company_id::text, 0));
  select * into v_done from public.company_terminations t
  where t.company_id = p_company_id and t.status = 'completed'
  order by t.completed_at desc nulls last limit 1;
  if v_done.id is not null then
    perform esblu_retention.log_access('synthetic_test_data_purge_skipped', v_done.archive_id, p_company_id,
      p_reference, btrim(p_justification),
      jsonb_build_object('reason', 'already_completed', 'termination_id', v_done.id,
                         'termination_mode', v_done.termination_mode));
    return jsonb_build_object(
      'already_completed', true, 'skipped', true, 'termination_id', v_done.id, 'job_id', v_done.cleanup_job_id,
      'storage_targets', '[]'::jsonb, 'summary', null, 'delete_account', false,
      'archive_id', v_done.archive_id, 'termination_mode', v_done.termination_mode
    );
  end if;

  return esblu_retention.termination_execute(p_user_id, p_company_id, p_delete_account, p_export_mode,
    'synthetic_test_data_purge', p_reference, btrim(p_justification));
end;
$function$;

comment on function public.esblu_company_termination_synthetic_purge(uuid, uuid, boolean, text, boolean, text, text) is
  'Auditovaná výnimka (postgres only, nie Data API): výmaz firmy so SYNTETICKÝMI testovacími dokladmi bez archívu. '
  'Povinné p_synthetic_test_data_purge = true, referencia (schválenie) a odôvodnenie; zapísané v company_terminations '
  '(termination_mode, operator_reference, justification) a esblu_retention.access_log. Nikdy pre skutočné doklady. '
  'Firma s už dokončeným ukončením (company_terminations.status = completed) sa znova nepurguje → already_completed '
  '+ access_log synthetic_test_data_purge_skipped.';

revoke all on function public.esblu_company_termination_synthetic_purge(uuid, uuid, boolean, text, boolean, text, text)
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------- 5b. ochrana Storage v cleanup jobe
-- Žiadny cleanup job (zrušenie účtu / ukončenie firmy / budúci kolektor) nesmie zmazať účtovnú kópiu
-- Esblu (bucket billing-documents) ani súbor dokladu uchovávaný v retenčnom archíve.
create or replace function public.esblu_cleanup_jobs_protect_retained_storage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_clean jsonb;
begin
  if new.storage_targets is null or jsonb_typeof(new.storage_targets) <> 'array' then
    return new;
  end if;
  select coalesce(jsonb_agg(x.value order by x.ord), '[]'::jsonb) into v_clean
  from jsonb_array_elements(new.storage_targets) with ordinality x(value, ord)
  where coalesce(x.value->>'bucket', '') <> 'billing-documents'
    and not exists (select 1 from esblu_retention.archived_records r, jsonb_array_elements(r.storage_objects) o
                    where o.value->>'bucket' = x.value->>'bucket' and o.value->>'path' = x.value->>'path');
  if v_clean is distinct from new.storage_targets then
    new.storage_targets := v_clean;
    new.storage_target_count := jsonb_array_length(v_clean);
    if jsonb_array_length(v_clean) = 0 then
      new.storage_status := 'done';
      if new.auth_status = 'done' then
        new.completed_at := coalesce(new.completed_at, now());
      end if;
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function public.esblu_cleanup_jobs_protect_retained_storage() from public, anon, authenticated, service_role;

drop trigger if exists esblu_cleanup_jobs_protect_retained_storage on public.account_deletion_cleanup_jobs;
create trigger esblu_cleanup_jobs_protect_retained_storage
  before insert or update of storage_targets on public.account_deletion_cleanup_jobs
  for each row execute function public.esblu_cleanup_jobs_protect_retained_storage();

-- ----------------------------------------------------------------------------- 6. operátorský prístup
create or replace function esblu_retention.operator_list_archives(p_operator_ref text, p_purpose text, p_source_company_id uuid default null)
returns table (
  archive_id uuid, source_company_id uuid, termination_id uuid, archived_at timestamptz, status text,
  legal_hold boolean, record_counts jsonb, earliest_retention_until date, latest_retention_until date
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform esblu_retention.assert_operator(p_operator_ref);
  if p_purpose is null or length(btrim(p_purpose)) < 10 then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_PURPOSE_REQUIRED';
  end if;
  perform esblu_retention.log_access('list', null, p_source_company_id, p_operator_ref, p_purpose, '{}'::jsonb);
  return query
    select a.id, a.source_company_id, a.termination_id, a.archived_at, a.status, a.legal_hold, a.record_counts,
           min(r.retention_until), max(r.retention_until)
    from esblu_retention.archived_companies a
    left join esblu_retention.archived_records r on r.archive_id = a.id
    where p_source_company_id is null or a.source_company_id = p_source_company_id
    group by a.id
    order by a.archived_at;
end;
$function$;

-- Export dokladov archivovanej firmy (žiadosť úradu / účtovníka): JSON so snapshotom firmy,
-- záznamami po kategóriách, SHA-256 a zoznamom Storage objektov (súbory stiahne operátor zvlášť).
create or replace function esblu_retention.export_archive(p_archive_id uuid, p_operator_ref text, p_purpose text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_a esblu_retention.archived_companies;
  v_out jsonb;
begin
  perform esblu_retention.assert_operator(p_operator_ref);
  if p_purpose is null or length(btrim(p_purpose)) < 10 then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_PURPOSE_REQUIRED';
  end if;
  select * into v_a from esblu_retention.archived_companies a where a.id = p_archive_id;
  if v_a.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_ARCHIVE_NOT_FOUND';
  end if;
  select jsonb_build_object(
    'schema', 'esblu.retention_archive_export.v1',
    'exported_at', now(),
    'archive_id', v_a.id,
    'source_company_id', v_a.source_company_id,
    'termination_id', v_a.termination_id,
    'archived_at', v_a.archived_at,
    'status', v_a.status,
    'legal_hold', v_a.legal_hold,
    'company', v_a.company_snapshot,
    'records', coalesce((
      select jsonb_object_agg(c.category, c.rows) from (
        select r.category, jsonb_agg(jsonb_build_object(
                 'source_table', r.source_table, 'source_id', r.source_id, 'document_date', r.document_date,
                 'retention_until', r.retention_until, 'sha256', r.payload_sha256,
                 'storage_objects', r.storage_objects, 'data', r.payload)
               order by r.source_table, r.document_date, r.source_id) rows
        from esblu_retention.archived_records r where r.archive_id = v_a.id group by r.category) c), '{}'::jsonb))
  into v_out;
  perform esblu_retention.log_access('export', v_a.id, v_a.source_company_id, p_operator_ref, p_purpose,
    jsonb_build_object('export_sha256', encode(sha256(convert_to(v_out::text, 'UTF8')), 'hex'),
                       'records', (select count(*) from esblu_retention.archived_records r where r.archive_id = v_a.id)));
  return v_out;
end;
$function$;

create or replace function esblu_retention.set_legal_hold(p_archive_id uuid, p_hold boolean, p_reason text, p_operator_ref text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_a esblu_retention.archived_companies;
begin
  perform esblu_retention.assert_operator(p_operator_ref);
  if p_hold is null or p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_LEGAL_HOLD_REASON_REQUIRED';
  end if;
  select * into v_a from esblu_retention.archived_companies a where a.id = p_archive_id for update;
  if v_a.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_ARCHIVE_NOT_FOUND';
  end if;
  update esblu_retention.archived_companies
     set legal_hold = p_hold,
         legal_hold_reason = case when p_hold then left(btrim(p_reason), 500) end,
         legal_hold_ref = case when p_hold then p_operator_ref end,
         legal_hold_set_at = case when p_hold then now() end
   where id = v_a.id;
  perform esblu_retention.log_access(case when p_hold then 'legal_hold_set' else 'legal_hold_clear' end,
    v_a.id, v_a.source_company_id, p_operator_ref, p_reason, jsonb_build_object('previous', v_a.legal_hold));
  return jsonb_build_object('archive_id', v_a.id, 'legal_hold', p_hold);
end;
$function$;

-- Schválenie lehoty (IBA postgres — rozhodnutie prevádzkovateľa). Prepočíta retention_until uchovaných záznamov.
create or replace function esblu_retention.approve_retention_period(
  p_category text, p_retention_years integer, p_approved_by text, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_claims_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  v_old esblu_retention.retention_periods;
  v_n integer;
begin
  if v_claims_role is not null then
    raise exception using errcode = '42501', message = 'ESBLU_OPERATOR_ONLY';
  end if;
  perform esblu_retention.assert_operator(p_approved_by);
  if p_note is null or length(btrim(p_note)) < 10 then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_PURPOSE_REQUIRED';
  end if;
  select * into v_old from esblu_retention.retention_periods p where p.category = p_category for update;
  if v_old.category is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_CATEGORY_UNKNOWN';
  end if;
  update esblu_retention.retention_periods
     set retention_years = p_retention_years, approval_status = 'APPROVED', approved_by = p_approved_by,
         approved_at = now(), note = left(btrim(p_note), 1000), updated_at = now()
   where category = p_category;
  update esblu_retention.archived_records r
     set retention_until = esblu_retention.compute_retention_until(r.category, r.document_date)
   where r.category = p_category;
  get diagnostics v_n = row_count;
  perform esblu_retention.log_access('retention_period_approved', null, null, p_approved_by, p_note,
    jsonb_build_object('category', p_category, 'old_years', v_old.retention_years, 'new_years', p_retention_years,
                       'old_status', v_old.approval_status, 'recomputed_records', v_n));
  return jsonb_build_object('category', p_category, 'retention_years', p_retention_years, 'recomputed_records', v_n);
end;
$function$;

-- ----------------------------------------------------------------------------- 7. automatická retencia
-- Dry-run (default) iba vyčísli. Ostrý beh: maže záznamy s retention_until < p_as_of, IBA schválené
-- (APPROVED) kategórie, nikdy archív pod legal hold. Po poslednom zázname firmy minimalizuje snapshot.
-- Výsledok obsahuje Storage objekty na výmaz (volajúci ich zmaže zo Storage) a zapíše sa do purge_runs.
-- NIE JE naplánovaná (žiadny cron) — pozri docs/retention-archive-design-2026-11-19.md.
create or replace function esblu_retention.purge_expired(
  p_operator_ref text,
  p_dry_run boolean default true,
  p_as_of date default null,
  p_batch integer default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_as_of date := coalesce(p_as_of, current_date);
  v_dry boolean := coalesce(p_dry_run, true);
  v_batch integer := least(greatest(coalesce(p_batch, 1000), 1), 10000);
  v_run uuid;
  v_ids uuid[];
  v_by_cat jsonb;
  v_storage jsonb;
  v_skip_hold integer;
  v_skip_unapproved integer;
  v_archives uuid[];
  v_closed integer := 0;
  v_result jsonb;
begin
  perform esblu_retention.assert_operator(p_operator_ref);
  if not v_dry and v_as_of > current_date then
    raise exception using errcode = 'P0001', message = 'ESBLU_RETENTION_PURGE_FUTURE_DATE',
      hint = 'Ostrý beh iba k dnešnému dátumu; budúci dátum len pre dry-run.';
  end if;

  insert into esblu_retention.purge_runs (status, dry_run, as_of, operator_ref, invoker_role)
  values ('executing', v_dry, v_as_of, p_operator_ref, nullif(current_setting('role', true), 'none'))
  returning id into v_run;
  perform set_config('esblu.retention_purge_run', v_run::text, true);

  select count(*) into v_skip_hold
  from esblu_retention.archived_records r join esblu_retention.archived_companies a on a.id = r.archive_id
  where r.retention_until < v_as_of and a.legal_hold;

  select count(*) into v_skip_unapproved
  from esblu_retention.archived_records r
  join esblu_retention.archived_companies a on a.id = r.archive_id
  join esblu_retention.retention_periods p on p.category = r.category
  where r.retention_until < v_as_of and not a.legal_hold and p.approval_status <> 'APPROVED';

  select coalesce(array_agg(x.id), '{}') into v_ids from (
    select r.id
    from esblu_retention.archived_records r
    join esblu_retention.archived_companies a on a.id = r.archive_id
    join esblu_retention.retention_periods p on p.category = r.category
    where r.retention_until < v_as_of and not a.legal_hold and p.approval_status = 'APPROVED'
    order by r.retention_until, r.id
    limit v_batch) x;

  select coalesce(jsonb_object_agg(c.category, c.n), '{}'::jsonb) into v_by_cat
  from (select r.category, count(*) n from esblu_retention.archived_records r where r.id = any(v_ids) group by 1) c;
  -- Účtovné kópie Esblu (billing-documents) nie sú súčasťou zákazníckeho archívu → nikdy na výmaz.
  select coalesce(jsonb_agg(distinct o.value), '[]'::jsonb) into v_storage
  from esblu_retention.archived_records r, jsonb_array_elements(r.storage_objects) o
  where r.id = any(v_ids) and coalesce(o.value->>'bucket', '') <> 'billing-documents';
  select coalesce(array_agg(distinct r.archive_id), '{}') into v_archives
  from esblu_retention.archived_records r where r.id = any(v_ids);

  if not v_dry and cardinality(v_ids) > 0 then
    delete from esblu_retention.archived_records r where r.id = any(v_ids);
    -- Firma bez zostávajúcich záznamov → minimalizovaný snapshot (iba krajina), status purged.
    update esblu_retention.archived_companies a
       set status = 'purged', purged_at = now(),
           company_snapshot = jsonb_build_object('country_code', a.company_snapshot->'legal_identity'->>'country_code', 'purged', true)
     where a.id = any(v_archives) and a.status = 'active'
       and not exists (select 1 from esblu_retention.archived_records r where r.archive_id = a.id);
    get diagnostics v_closed = row_count;
  end if;

  v_result := jsonb_build_object(
    'run_id', v_run, 'dry_run', v_dry, 'as_of', v_as_of,
    'eligible', cardinality(v_ids), 'purged', case when v_dry then 0 else cardinality(v_ids) end,
    'by_category', v_by_cat, 'archives_touched', cardinality(v_archives), 'archives_closed', v_closed,
    'skipped_legal_hold', v_skip_hold, 'skipped_unapproved_period', v_skip_unapproved,
    'storage_objects', v_storage);

  update esblu_retention.purge_runs set status = 'completed', finished_at = clock_timestamp(), result = v_result where id = v_run;
  perform set_config('esblu.retention_purge_run', '', true);
  perform esblu_retention.log_access(case when v_dry then 'purge_dry_run' else 'purge' end, null, null, p_operator_ref,
    'retention purge', v_result - 'storage_objects');
  return v_result;
end;
$function$;

revoke all on function esblu_retention.operator_list_archives(text, text, uuid) from public, anon, authenticated;
revoke all on function esblu_retention.export_archive(uuid, text, text) from public, anon, authenticated;
revoke all on function esblu_retention.set_legal_hold(uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function esblu_retention.purge_expired(text, boolean, date, integer) from public, anon, authenticated;
revoke all on function esblu_retention.approve_retention_period(text, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function esblu_retention.operator_list_archives(text, text, uuid) to service_role;
grant execute on function esblu_retention.export_archive(uuid, text, text) to service_role;
grant execute on function esblu_retention.set_legal_hold(uuid, boolean, text, text) to service_role;
grant execute on function esblu_retention.purge_expired(text, boolean, date, integer) to service_role;
