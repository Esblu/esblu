-- =============================================================================
-- LOKÁLNY TESTOVACÍ BASELINE (iba pre scripts/sql/plan-entitlements-matrix.sql)
--
-- Podmnožina produkčnej schémy fkpgvgvsmbpieduoatrt prečítaná READ-ONLY
-- (Supabase MCP, 26. 9. 2026): stĺpce, RLS politiky, triggery a definície
-- funkcií relevantných tabuliek sú prevzaté 1:1. Supabase špecifiká (roly,
-- auth.uid(), auth.role(), extensions.digest) sú nahradené minimálnymi
-- stubmi. Slúži na lokálne overenie migrácie 20260928100000 na čistom
-- PostgreSQL 16 — NIKDY sa nespúšťa proti produkcii.
--
-- Použitie (lokálne):
--   psql -f scripts/sql/entitlements-local-baseline.sql
--   psql -f supabase/migrations/20260928100000_company_entitlements_trial.sql
--   psql -f scripts/sql/plan-entitlements-matrix.sql
-- =============================================================================

-- ---------------------------------------------------------------- Supabase stubs
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end $$;

create schema if not exists extensions;
-- pgcrypto nemusí byť lokálne k dispozícii → rovnaké signatúry cez vstavané funkcie.
create or replace function extensions.digest(p_data text, p_type text) returns bytea language sql immutable as $$
  select case when lower(p_type) = 'sha256' then sha256(convert_to(p_data, 'UTF8')) end
$$;
create or replace function extensions.gen_random_bytes(p_len integer) returns bytea language sql volatile as $$
  select substring(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex') from 1 for p_len)
$$;
grant execute on all functions in schema extensions to anon, authenticated, service_role;
create schema if not exists auth;
create schema if not exists storage;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  aud text,
  role text,
  instance_id uuid,
  raw_user_meta_data jsonb default '{}'::jsonb
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')
$$;

create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);

grant usage on schema public, auth, extensions, storage to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- ---------------------------------------------------------------- tables (prod columns)
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  plan text not null default 'free',
  constraint companies_plan_check check (plan = any (array['free','pro','admin']))
);

create table public.company_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role = any (array['owner','admin','accountant','employee'])),
  status text not null check (status = any (array['active','invited','disabled'])),
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  constraint company_members_unique_company_user unique (company_id, user_id)
);
create unique index company_members_one_active_per_user_idx on public.company_members (user_id) where status = 'active';

create table public.company_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  email text not null,
  role text not null,
  invited_by uuid,
  token_hash text not null unique,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at timestamptz
);

create table public.beta_allowlist (
  email text primary key,
  added_at timestamptz not null default now(),
  added_by uuid,
  note text,
  revoked_at timestamptz,
  consumed_at timestamptz,
  consumed_by uuid
);

create table public.settings (
  id uuid primary key default gen_random_uuid(),
  company_name text,
  created_at timestamptz not null default now(),
  user_id uuid unique,
  logo_path text,
  plan text not null default 'free',
  locale text
);

create table public.plan_limits (
  plan text primary key,
  ai_evidence integer, vehicles integer, inventory_items integer, machines integer
);
insert into public.plan_limits values ('free',5,2,5,2), ('pro',null,null,null,null), ('admin',null,null,null,null);

create table public.ai_scan_limits (endpoint text primary key, max_per_hour integer not null, max_per_day integer not null, updated_at timestamptz not null default now());
insert into public.ai_scan_limits (endpoint, max_per_hour, max_per_day) values ('scan-document', 60, 240);
create table public.company_billing_profile (company_id uuid primary key references public.companies(id) on delete cascade, legal_name text);

create table public.legal_documents (
  id uuid primary key default gen_random_uuid(), type text not null, version text not null,
  effective_at timestamptz not null, required boolean not null default true,
  content_hash text not null, canonical_path text not null, created_at timestamptz not null default now()
);
insert into public.legal_documents (type, version, effective_at, content_hash, canonical_path)
values ('dpa', 'dpa-local-1', now() - interval '1 year', 'x', '/dpa');

create table public.company_dpa_acceptances (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  document_type text not null default 'dpa', version text not null, accepted_by uuid not null,
  accepted_at timestamptz not null default now(), acceptance_method text not null
);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(), spz text not null, vin text, znacka text, model text,
  user_id uuid, company_id uuid not null references public.companies(id)
);
create table public.machines (
  id uuid primary key default gen_random_uuid(), name text, model text, notes text,
  created_at timestamptz not null default now(), user_id uuid, company_id uuid not null references public.companies(id)
);
create table public.inventory_items (
  id uuid primary key default gen_random_uuid(), name text, quantity numeric, unit text,
  created_at timestamptz not null default now(), user_id uuid, company_id uuid not null references public.companies(id)
);
create table public.ai_evidence (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, document_type text, photo_url text,
  created_at timestamptz default now(), company_id uuid not null references public.companies(id), evidence_kind text
);
create table public.documents (
  id uuid primary key default gen_random_uuid(), user_id uuid, storage_bucket text not null, storage_path text not null,
  document_type text not null default 'other', status text not null default 'uploaded',
  created_at timestamptz not null default now(), company_id uuid not null references public.companies(id)
);
create table public.invoices (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
  direction text not null check (direction = any (array['issued','received'])), kind text not null,
  document_status text not null default 'draft' check (document_status = any (array['draft','finalized'])),
  payment_status text not null default 'unpaid', invoice_number text,
  finalized_at timestamptz, created_by uuid, updated_by uuid, updated_at timestamptz,
  constraint invoices_finalized_at_check check ((document_status = 'finalized') = (finalized_at is not null))
);

-- ---------------------------------------------------------------- helper functions (prod)
create or replace function public.esblu_my_active_company_id() returns uuid language sql stable security definer set search_path to '' as $f$
  select cm.company_id from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
$f$;
create or replace function public.esblu_my_active_role() returns text language sql stable security definer set search_path to '' as $f$
  select cm.role from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
$f$;
create or replace function public.esblu_role_can_operate() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select cm.role in ('owner','admin','employee') from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
$f$;
create or replace function public.esblu_my_finance_view() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner','accountant') then true
    else coalesce((cm.permissions -> 'finance' ->> 'view')::boolean, false) or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
    from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
$f$;
create or replace function public.esblu_my_finance_manage() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner','accountant') then true
    else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
    from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
$f$;
create or replace function public.esblu_evidence_is_delivery_note(p_kind text, p_label text) returns boolean language sql immutable set search_path to '' as $f$
  select case when p_kind is not null then p_kind = 'delivery_note'
    else lower(coalesce(p_label, '')) in ('delivery_note','dodací list','dodaci list','lieferschein','delivery note') end;
$f$;
create or replace function public.esblu_document_requires_finance(p_document_type text, p_status text) returns boolean language sql immutable set search_path to '' as $f$
  select coalesce(p_document_type, '') in ('invoice','receipt','delivery_note') or coalesce(p_status, '') in ('uploaded','processing');
$f$;

create or replace function public.esblu_assign_company_id() returns trigger language plpgsql security definer set search_path to '' as $f$
declare v_company_id uuid;
begin
  select cm.company_id into v_company_id from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY_MEMBERSHIP:' || tg_table_schema || '.' || tg_table_name;
  end if;
  new.company_id := v_company_id;
  return new;
end; $f$;
create or replace function public.esblu_lock_company_id_on_update() returns trigger language plpgsql security definer set search_path to '' as $f$
begin new.company_id := old.company_id; return new; end; $f$;
create or replace function public.esblu_require_company_dpa_current() returns trigger language plpgsql security definer set search_path to '' as $f$
declare v_current_version text; v_has_acceptance boolean;
begin
  select ld.version into v_current_version from public.legal_documents ld where ld.type = 'dpa' and ld.effective_at <= now()
  order by ld.effective_at desc, ld.created_at desc, ld.version desc limit 1;
  if v_current_version is null then raise exception 'ESBLU_NO_CURRENT_DPA'; end if;
  select exists (select 1 from public.company_dpa_acceptances cda where cda.company_id = new.company_id and cda.document_type = 'dpa' and cda.version = v_current_version) into v_has_acceptance;
  if not v_has_acceptance then raise exception 'ESBLU_COMPANY_DPA_NOT_ACCEPTED'; end if;
  return new;
end; $f$;
create or replace function public.esblu_block_finalized_invoice_mutation() returns trigger language plpgsql security definer set search_path to '' as $f$
declare v_allowed constant text[] := array['payment_status','updated_at','updated_by']; v_changed text;
begin
  if OLD.document_status <> 'finalized' then return NEW; end if;
  select string_agg(k.key, ', ' order by k.key) into v_changed from jsonb_each(to_jsonb(OLD)) k
  where not (k.key = any (v_allowed)) and k.value is distinct from (to_jsonb(NEW) -> k.key);
  if v_changed is not null then raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_FINALIZED_IMMUTABLE'; end if;
  return NEW;
end; $f$;

-- Prod verzie PRED migráciou 20260928100000 (migrácia ich nahradí).
create or replace function public.esblu_company_plan(p_company_id uuid) returns text language sql stable security definer set search_path to '' as $f$
  select coalesce(c.plan, 'free') from public.companies c where c.id = p_company_id;
$f$;

create or replace function public.esblu_enforce_plan_limit() returns trigger language plpgsql security definer set search_path to '' as $f$
declare
  authenticated_user_id uuid := auth.uid(); request_role text := coalesce(auth.role(), ''); is_privileged boolean := false;
  v_company_id uuid; account_plan text := 'free'; resource_limit integer; current_usage bigint;
begin
  if new.user_id is null then raise exception using errcode = '23502', message = 'PLAN_LIMIT_USER_MISSING'; end if;
  is_privileged := request_role = 'service_role' or session_user in ('postgres','service_role','supabase_admin','supabase_auth_admin');
  if not is_privileged and (authenticated_user_id is null or new.user_id is distinct from authenticated_user_id) then
    raise exception using errcode = '42501', message = 'PLAN_LIMIT_USER_MISMATCH'; end if;
  if is_privileged and new.company_id is not null then v_company_id := new.company_id;
  else select cm.company_id into v_company_id from public.company_members cm where cm.user_id = authenticated_user_id and cm.status = 'active' limit 1; end if;
  if v_company_id is null then raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY_MEMBERSHIP'; end if;
  new.company_id := v_company_id;
  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':' || tg_table_name, 0));
  account_plan := public.esblu_company_plan(v_company_id);
  select case tg_table_name when 'ai_evidence' then l.ai_evidence when 'vehicles' then l.vehicles
    when 'inventory_items' then l.inventory_items when 'machines' then l.machines end
  into resource_limit from public.plan_limits l where l.plan = account_plan;
  if resource_limit is null then return new; end if;
  execute format('select count(*) from public.%I where company_id = $1', tg_table_name) into current_usage using v_company_id;
  if current_usage >= resource_limit then raise exception using errcode = 'P0001', message = 'PLAN_LIMIT_REACHED:' || tg_table_name; end if;
  return new;
end $f$;

create or replace function public.esblu_ensure_my_owner_company() returns table(company_id uuid, role text, created boolean)
language plpgsql security definer set search_path to '' as $f$
declare v_uid uuid; v_email text; v_existing record; v_company_id uuid; v_company_name text; v_beta_allowed boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED'; end if;
  select m.company_id, m.role into v_existing from public.company_members m where m.user_id = v_uid and m.status = 'active' limit 1;
  if found then return query select v_existing.company_id, v_existing.role, false; return; end if;
  select u.email into v_email from auth.users u where u.id = v_uid;
  v_email := lower(btrim(v_email));
  select exists (select 1 from public.beta_allowlist ba where ba.email = v_email and ba.revoked_at is null and ba.consumed_at is null) into v_beta_allowed;
  if not v_beta_allowed then raise exception using errcode = '42501', message = 'ESBLU_BETA_ACCESS_REQUIRED'; end if;
  v_company_name := 'Moja firma';
  insert into public.companies (owner_id, name) values (v_uid, v_company_name) returning id into v_company_id;
  insert into public.company_members (company_id, user_id, role, status) values (v_company_id, v_uid, 'owner', 'active');
  insert into public.company_billing_profile (company_id, legal_name) values (v_company_id, v_company_name);
  update public.beta_allowlist set consumed_at = coalesce(consumed_at, now()), consumed_by = v_uid where email = v_email;
  return query select v_company_id, 'owner'::text, true;
end; $f$;

create or replace function public.esblu_before_user_created_beta_gate(event jsonb) returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_email text; v_invite_token text; v_token_hash text; v_invite_valid boolean; v_beta_allowed boolean;
begin
  v_email := lower(btrim(coalesce(event->'user'->>'email', '')));
  if v_email = '' then return jsonb_build_object('error', jsonb_build_object('http_code', 400, 'message', 'x')); end if;
  v_invite_token := btrim(coalesce(event #>> '{user,user_metadata,esblu_invite_token}', ''));
  if v_invite_token <> '' then
    v_token_hash := encode(extensions.digest(v_invite_token, 'sha256'), 'hex');
    select exists (select 1 from public.company_invites ci where ci.token_hash = v_token_hash and ci.status = 'pending' and ci.expires_at > now() and ci.email = v_email) into v_invite_valid;
    if v_invite_valid then return '{}'::jsonb; end if;
  end if;
  select exists (select 1 from public.beta_allowlist ba where ba.email = v_email and ba.revoked_at is null and ba.consumed_at is null) into v_beta_allowed;
  if v_beta_allowed then return '{}'::jsonb; end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'closed beta'));
end; $f$;

-- Pozvánky: prod verzie pred migráciou (migrácia ich nahradí úplnou verziou).
create or replace function public.esblu_create_company_invite(p_email text, p_role text)
returns table(invite_id uuid, token text, expires_at timestamptz, email text, role text) language plpgsql security definer set search_path to '' as $f$
begin raise exception 'baseline stub — migration 20260928100000 must replace this'; end; $f$;
create or replace function public.esblu_accept_company_invite(p_token text)
returns table(company_id uuid, role text) language plpgsql security definer set search_path to '' as $f$
begin raise exception 'baseline stub — migration 20260928100000 must replace this'; end; $f$;

-- ---------------------------------------------------------------- triggers (prod)
create trigger esblu_plan_limit_before_insert before insert on public.vehicles for each row execute function public.esblu_enforce_plan_limit();
create trigger esblu_plan_limit_before_insert before insert on public.machines for each row execute function public.esblu_enforce_plan_limit();
create trigger esblu_plan_limit_before_insert before insert on public.inventory_items for each row execute function public.esblu_enforce_plan_limit();
create trigger esblu_plan_limit_before_insert before insert on public.ai_evidence for each row execute function public.esblu_enforce_plan_limit();
create trigger esblu_require_company_dpa_before_insert before insert on public.vehicles for each row execute function public.esblu_require_company_dpa_current();
create trigger esblu_require_company_dpa_before_insert before insert on public.machines for each row execute function public.esblu_require_company_dpa_current();
create trigger esblu_require_company_dpa_before_insert before insert on public.inventory_items for each row execute function public.esblu_require_company_dpa_current();
create trigger esblu_require_company_dpa_before_insert before insert on public.ai_evidence for each row execute function public.esblu_require_company_dpa_current();
create trigger esblu_lock_company_id_before_update before update on public.vehicles for each row execute function public.esblu_lock_company_id_on_update();
create trigger esblu_lock_company_id_before_update before update on public.inventory_items for each row execute function public.esblu_lock_company_id_on_update();
create trigger esblu_assign_company_id_before_insert before insert on public.documents for each row execute function public.esblu_assign_company_id();
create trigger esblu_invoices_immutability_guard before update on public.invoices for each row execute function public.esblu_block_finalized_invoice_mutation();

-- ---------------------------------------------------------------- RLS (prod policies)
alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.company_invites enable row level security;
alter table public.beta_allowlist enable row level security;
alter table public.plan_limits enable row level security;
alter table public.vehicles enable row level security;
alter table public.machines enable row level security;
alter table public.inventory_items enable row level security;
alter table public.ai_evidence enable row level security;
alter table public.documents enable row level security;
alter table public.invoices enable row level security;

create policy companies_select_member on public.companies for select to authenticated using (exists (select 1 from public.company_members m where m.company_id = companies.id and m.user_id = auth.uid() and m.status = 'active'));
create policy company_members_select_own on public.company_members for select to authenticated using (user_id = auth.uid());
create policy esblu_authenticated_plan_limits_select on public.plan_limits for select to authenticated using (true);

create policy vehicles_select_operational on public.vehicles for select to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
create policy vehicles_insert_owner_admin on public.vehicles for insert to authenticated with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() = any (array['owner','admin']));
create policy vehicles_update_owner_admin on public.vehicles for update to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() = any (array['owner','admin'])) with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() = any (array['owner','admin']));
create policy vehicles_delete_owner_admin on public.vehicles for delete to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() = any (array['owner','admin']));

create policy machines_select_operational on public.machines for select to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
create policy machines_insert_operational on public.machines for insert to authenticated with check (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
create policy machines_update_operational on public.machines for update to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate()) with check (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
create policy machines_delete_operational on public.machines for delete to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());

create policy inventory_items_select_operational on public.inventory_items for select to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
create policy inventory_items_insert_manager on public.inventory_items for insert to authenticated with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() = any (array['owner','admin']));
create policy inventory_items_update_manager on public.inventory_items for update to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() = any (array['owner','admin'])) with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() = any (array['owner','admin']));
create policy inventory_items_delete_manager on public.inventory_items for delete to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() = any (array['owner','admin']));

create policy ai_evidence_insert_operational on public.ai_evidence for insert to authenticated with check (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
create policy ai_evidence_select_scoped on public.ai_evidence for select to authenticated using (company_id = public.esblu_my_active_company_id() and (((not public.esblu_evidence_is_delivery_note(evidence_kind, document_type)) and public.esblu_role_can_operate()) or (public.esblu_evidence_is_delivery_note(evidence_kind, document_type) and public.esblu_my_finance_view())));

create policy documents_insert_company on public.documents for insert to authenticated with check (company_id = public.esblu_my_active_company_id());
create policy documents_select_company on public.documents for select using (company_id = public.esblu_my_active_company_id() and ((not public.esblu_document_requires_finance(document_type, status)) or public.esblu_my_finance_view() or (status = any (array['uploaded','processing']) and user_id = (select auth.uid()))));
create policy documents_delete_finance_manager on public.documents for delete to authenticated using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() = any (array['owner','admin','accountant']) and ((not public.esblu_document_requires_finance(document_type, status)) or public.esblu_my_finance_manage()));

create policy invoices_select_finance on public.invoices for select using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());
create policy invoices_insert_finance_draft on public.invoices for insert with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage() and document_status = 'draft' and invoice_number is null and (created_by is null or created_by = auth.uid()) and (updated_by is null or updated_by = auth.uid()));
create policy invoices_update_finance_draft on public.invoices for update using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage() and document_status = 'draft') with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage());

-- ---------------------------------------------------------------- grants (prod shape)
grant select on public.companies, public.company_members, public.plan_limits to authenticated;
grant select, insert, update, delete on public.vehicles, public.machines, public.inventory_items, public.ai_evidence, public.documents, public.invoices to authenticated;
revoke all on public.beta_allowlist, public.company_invites from anon, authenticated;
revoke all on function public.esblu_company_plan(uuid) from public, anon, authenticated;
revoke all on function public.esblu_enforce_plan_limit() from public, anon, authenticated;
revoke all on function public.esblu_before_user_created_beta_gate(jsonb) from public, anon, authenticated;
