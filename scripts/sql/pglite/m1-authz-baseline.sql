-- =============================================================================
-- Minimálna, PROD-VERNÁ kostra schémy pre lokálny test v PGlite (PostgreSQL
-- vo WASM) — scripts/m1-authz-pglite-tests.ts. NIKDY sa nespúšťa proti
-- Supabase. Obsahuje iba to, čo migrácie 20260930125000 / 130000 / 135000
-- potrebujú:
--   - Supabase stuby: roly anon/authenticated, auth.uid() z request.jwt.claims,
--     schéma extensions s pgcrypto, vault.decrypted_secrets (tabuľka-stub,
--     bez práv pre authenticated — rovnako ako v Supabase),
--   - tabuľky s produkčnými stĺpcami (overené v prod katalógu 2026-09-28),
--   - pomocné funkcie DOSLOVNE z prod (pg_get_functiondef 2026-09-28),
--   - triggre a PRED-migračné politiky presne ako v prod, aby migrácie
--     reálne nahradili to, čo nahradia v produkcii.
-- Zjednodušenie: esblu_enforce_plan_limit tu nevolá kontrolu nároku modulu
-- (nie je predmetom testu); user_id/company_id logika je z prod.
-- =============================================================================

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create schema extensions;
create schema vault;
create extension pgcrypto schema extensions;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$$;

create table vault.decrypted_secrets (name text primary key, decrypted_secret text);

grant usage on schema public, auth, extensions to anon, authenticated;
grant execute on all functions in schema extensions to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- Tabuľky ---------------------------------------------------------------------
create table public.companies (id uuid primary key, name text not null);

create table public.company_members (
  company_id uuid not null references public.companies(id),
  user_id uuid not null,
  role text not null,
  status text not null default 'active',
  permissions jsonb not null default '{}'
);

create table public.vehicles (id uuid primary key default gen_random_uuid(), company_id uuid not null, spz text);
create table public.machines (id uuid primary key default gen_random_uuid(), company_id uuid not null, name text);

create table public.custom_document_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  name text not null,
  canonical_slug text not null,
  description text,
  created_by uuid,
  created_at timestamptz default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  storage_bucket text not null,
  storage_path text not null,
  original_filename text,
  mime_type text,
  file_size bigint,
  document_type text not null default 'other'
    check (document_type = any (array['weigh_ticket','delivery_note','invoice','receipt','insurance','service_document','vehicle_registration','other'])),
  status text not null default 'uploaded'
    check (status = any (array['uploaded','processing','extracted','needs_review','confirmed','failed'])),
  ai_model text,
  ai_raw_output jsonb,
  extracted_fields jsonb,
  field_confidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  deleted_at timestamptz,
  note text,
  company_id uuid not null,
  archived_from_inbox_at timestamptz,
  custom_category_id uuid references public.custom_document_categories(id) on delete set null,
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  unique (storage_bucket, storage_path)
);

create table public.ai_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  spz text, document_type text, movement_type text, supplier text, document_number text,
  material text, quantity numeric, unit text, brutto numeric, tara numeric, netto numeric,
  construction_site text, customer text, document_date date, document_time text,
  photo_url text, raw_text text, created_at timestamptz default now(),
  material_original text, material_category text, document_language text,
  review_status text default 'pending', confidence_score numeric,
  source_location text, destination_location text,
  machine_id uuid references public.machines(id) on delete set null,
  machine_label text,
  company_id uuid not null references public.companies(id),
  evidence_kind text check (evidence_kind is null or evidence_kind = any (array['weigh_ticket','delivery_note'])),
  deleted_at timestamptz
);

create table public.document_review_log (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents(id) on delete set null,
  document_ref uuid not null,
  user_id uuid,
  action text not null check (action = any (array['created','field_edited','confirmed','linked','unlinked','soft_deleted','restored','hard_deleted'])),
  field_name text,
  old_value jsonb,
  new_value jsonb,
  document_snapshot jsonb,
  created_at timestamptz not null default now(),
  company_id uuid not null
);

grant select, insert, update, delete on all tables in schema public to authenticated;

-- Pomocné funkcie (doslovne z prod) -------------------------------------------
create or replace function public.esblu_my_active_company_id() returns uuid language sql stable security definer set search_path to '' as $f$
  select cm.company_id from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
$f$;
create or replace function public.esblu_my_active_role() returns text language sql stable security definer set search_path to '' as $f$
  select cm.role from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
$f$;
create or replace function public.esblu_my_finance_manage() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner', 'accountant') then true
    else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
    from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
$f$;
create or replace function public.esblu_my_finance_view() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner', 'accountant') then true
    else coalesce((cm.permissions -> 'finance' ->> 'view')::boolean, false) or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
    from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
$f$;
create or replace function public.esblu_role_can_operate() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select cm.role in ('owner', 'admin', 'employee') from public.company_members cm
    where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
$f$;
create or replace function public.esblu_document_requires_finance(p_document_type text, p_status text) returns boolean language sql immutable set search_path to '' as $f$
  select coalesce(p_document_type, '') in ('invoice', 'receipt', 'delivery_note') or coalesce(p_status, '') in ('uploaded', 'processing');
$f$;
create or replace function public.esblu_evidence_is_delivery_note(p_kind text, p_label text) returns boolean language sql immutable set search_path to '' as $f$
  select case when p_kind is not null then p_kind = 'delivery_note'
    else lower(coalesce(p_label, '')) in ('delivery_note', 'dodací list', 'dodaci list', 'lieferschein', 'delivery note') end;
$f$;

-- Triggre (prod logika) ---------------------------------------------------------
create or replace function public.esblu_assign_company_id() returns trigger language plpgsql security definer set search_path to '' as $f$
declare v_company_id uuid;
begin
  select cm.company_id into v_company_id from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
  if v_company_id is null then raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY_MEMBERSHIP:' || tg_table_schema || '.' || tg_table_name; end if;
  new.company_id := v_company_id;
  return new;
end;
$f$;
create or replace function public.esblu_lock_company_id_on_update() returns trigger language plpgsql security definer set search_path to '' as $f$
begin new.company_id := old.company_id; return new; end;
$f$;
-- esblu_enforce_plan_limit — user_id/company_id časť z prod (bez nároku modulu).
create or replace function public.esblu_enforce_plan_limit() returns trigger language plpgsql security definer set search_path to '' as $f$
declare authenticated_user_id uuid := auth.uid(); is_privileged boolean; v_company_id uuid;
begin
  if new.user_id is null then raise exception using errcode = '23502', message = 'PLAN_LIMIT_USER_MISSING'; end if;
  -- Prod: session_user in ('postgres','service_role',…) — v PGlite je session_user
  -- vždy postgres, preto sa privilegovaný kontext emuluje ako „bez JWT".
  is_privileged := authenticated_user_id is null;
  if not is_privileged and (authenticated_user_id is null or new.user_id is distinct from authenticated_user_id) then
    raise exception using errcode = '42501', message = 'PLAN_LIMIT_USER_MISMATCH';
  end if;
  if is_privileged and new.company_id is not null then v_company_id := new.company_id;
  else select cm.company_id into v_company_id from public.company_members cm where cm.user_id = authenticated_user_id and cm.status = 'active' limit 1; end if;
  if v_company_id is null then raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY_MEMBERSHIP'; end if;
  new.company_id := v_company_id;
  return new;
end;
$f$;

create trigger esblu_assign_company_id_before_insert before insert on public.documents for each row execute function public.esblu_assign_company_id();
create trigger esblu_lock_company_id_before_update before update on public.documents for each row execute function public.esblu_lock_company_id_on_update();
create trigger esblu_assign_company_id_before_insert before insert on public.document_review_log for each row execute function public.esblu_assign_company_id();
alter table public.document_review_log enable row level security;
create trigger esblu_plan_limit_before_insert before insert on public.ai_evidence for each row execute function public.esblu_enforce_plan_limit();
create trigger esblu_lock_company_id_before_update before update on public.ai_evidence for each row execute function public.esblu_lock_company_id_on_update();

-- RLS + PRED-migračné politiky (presne prod 2026-09-28) --------------------------
alter table public.documents enable row level security;
alter table public.ai_evidence enable row level security;
alter table public.vehicles enable row level security;
alter table public.machines enable row level security;
alter table public.custom_document_categories enable row level security;

create policy vehicles_select_operational on public.vehicles for select
  using (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
create policy machines_select_operational on public.machines for select
  using (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
create policy custom_document_categories_select_company on public.custom_document_categories for select
  using (company_id = public.esblu_my_active_company_id());

create policy documents_insert_company on public.documents for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id());
create policy documents_select_company on public.documents for select
  using (company_id = public.esblu_my_active_company_id()
    and ((not public.esblu_document_requires_finance(document_type, status)) or public.esblu_my_finance_view()
      or (status = any (array['uploaded'::text, 'processing'::text]) and user_id = (select auth.uid()))));
create policy documents_update_finance_manager on public.documents for update to authenticated
  using (company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text, 'accountant'::text])
    and ((not public.esblu_document_requires_finance(document_type, status)) or public.esblu_my_finance_manage()))
  with check (company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text, 'accountant'::text])
    and ((not public.esblu_document_requires_finance(document_type, status)) or public.esblu_my_finance_manage()));

create policy ai_evidence_insert_operational on public.ai_evidence for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
create policy ai_evidence_select_scoped on public.ai_evidence for select to authenticated
  using (company_id = public.esblu_my_active_company_id()
    and (((not public.esblu_evidence_is_delivery_note(evidence_kind, document_type)) and public.esblu_role_can_operate())
      or (public.esblu_evidence_is_delivery_note(evidence_kind, document_type) and public.esblu_my_finance_view())));
create policy ai_evidence_update_scoped on public.ai_evidence for update to authenticated
  using (company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])
    and ((not public.esblu_evidence_is_delivery_note(evidence_kind, document_type)) or public.esblu_my_finance_manage()))
  with check (company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])
    and ((not public.esblu_evidence_is_delivery_note(evidence_kind, document_type)) or public.esblu_my_finance_manage()));
create policy ai_evidence_delete_scoped on public.ai_evidence for delete to authenticated
  using (company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner'::text, 'admin'::text])
    and ((not public.esblu_evidence_is_delivery_note(evidence_kind, document_type)) or public.esblu_my_finance_manage()));

-- =============================================================================
-- Doplnok pre 20260930120000 / 20260930140000 (Storage + rozsah účtovníka)
-- =============================================================================
create or replace function public.esblu_has_finance_view_in_company(p_company_id uuid) returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner', 'accountant') then true
    else coalesce((cm.permissions -> 'finance' ->> 'view')::boolean, false) or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
    from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' and cm.company_id = p_company_id limit 1), false);
$f$;
create or replace function public.esblu_has_finance_manage_in_company(p_company_id uuid) returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner', 'accountant') then true
    else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
    from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' and cm.company_id = p_company_id limit 1), false);
$f$;

create table public.document_attachments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents(id) on delete cascade,
  company_id uuid,
  user_id uuid,
  storage_bucket text not null,
  storage_path text not null,
  unique (storage_bucket, storage_path)
);
grant select, insert, update, delete on public.document_attachments to authenticated;
alter table public.document_attachments enable row level security;

-- Storage stub (Supabase storage.objects + storage.foldername)
create schema storage;
grant usage on schema storage to anon, authenticated;
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null,
  owner uuid default auth.uid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (bucket_id, name)
);
create function storage.foldername(name text) returns text[] language sql immutable as $f$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$f$;
grant execute on function storage.foldername(text) to anon, authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
alter table storage.objects enable row level security;

-- Prod read funkcia ai-evidence-documents (pred 20260930140000) + stuby delete funkcií.
create or replace function public.esblu_can_read_ai_evidence_object(p_object_name text) returns boolean language plpgsql stable security definer set search_path to '' as $f$
declare v_uid uuid := auth.uid(); v_uploader_uid text; v_referenced_row_count integer; v_null_company_count integer; v_distinct_company_count integer; v_company_id uuid; v_is_delivery_note boolean;
begin
  if v_uid is null then return false; end if;
  v_uploader_uid := (storage.foldername(p_object_name))[1];
  select count(*), count(*) filter (where ae.company_id is null), count(distinct ae.company_id) into v_referenced_row_count, v_null_company_count, v_distinct_company_count from public.ai_evidence ae where ae.photo_url = p_object_name;
  if v_referenced_row_count = 0 then return v_uploader_uid = v_uid::text; end if;
  if v_null_company_count > 0 or v_distinct_company_count <> 1 then return false; end if;
  select ae.company_id, bool_or(public.esblu_evidence_is_delivery_note(ae.evidence_kind, ae.document_type)) into v_company_id, v_is_delivery_note from public.ai_evidence ae where ae.photo_url = p_object_name and ae.company_id is not null group by ae.company_id;
  if v_is_delivery_note then return public.esblu_has_finance_view_in_company(v_company_id); end if;
  return exists (select 1 from public.company_members cm where cm.user_id = v_uid and cm.status = 'active' and cm.role in ('owner', 'admin', 'employee') and cm.company_id = v_company_id);
end;
$f$;
create or replace function public.esblu_can_read_ai_inbox_object(p_object_name text) returns boolean language sql stable security definer set search_path to '' as $f$ select false $f$;
-- Prod delete funkcie (doslovne, pg_get_functiondef 2026-09-29).
create or replace function public.esblu_can_delete_ai_inbox_object(p_object_name text) returns boolean language plpgsql stable security definer set search_path to '' as $f$
declare v_uid uuid := auth.uid(); v_uploader_uid text; v_document_id uuid; v_document_company_id uuid; v_document_type text; v_document_status text; v_attachment_document_id uuid; v_attachment_company_id uuid;
begin
  if v_uid is null then return false; end if;
  v_uploader_uid := (storage.foldername(p_object_name))[1];
  select d.id, d.company_id, d.document_type, d.status into v_document_id, v_document_company_id, v_document_type, v_document_status from public.documents d where d.storage_bucket = 'ai-inbox-documents' and d.storage_path = p_object_name limit 1;
  if v_document_id is not null then
    if not exists (select 1 from public.company_members cm where cm.user_id = v_uid and cm.status = 'active' and cm.role in ('owner', 'admin') and cm.company_id = v_document_company_id) then return false; end if;
    if not public.esblu_document_requires_finance(v_document_type, v_document_status) then return true; end if;
    return public.esblu_has_finance_manage_in_company(v_document_company_id);
  end if;
  select da.document_id, da.company_id into v_attachment_document_id, v_attachment_company_id from public.document_attachments da where da.storage_bucket = 'ai-inbox-documents' and da.storage_path = p_object_name limit 1;
  if v_attachment_document_id is not null then
    if not exists (select 1 from public.company_members cm where cm.user_id = v_uid and cm.status = 'active' and cm.role in ('owner', 'admin') and cm.company_id = v_attachment_company_id) then return false; end if;
    return public.esblu_can_manage_document(v_attachment_document_id);
  end if;
  return v_uploader_uid = v_uid::text;
end;
$f$;
create or replace function public.esblu_can_delete_ai_evidence_object(p_object_name text) returns boolean language plpgsql stable security definer set search_path to '' as $f$
declare v_uid uuid := auth.uid(); v_uploader_uid text; v_referenced_row_count integer; v_null_company_count integer; v_distinct_company_count integer; v_company_id uuid;
begin
  if v_uid is null then return false; end if;
  v_uploader_uid := (storage.foldername(p_object_name))[1];
  select count(*), count(*) filter (where ae.company_id is null), count(distinct ae.company_id) into v_referenced_row_count, v_null_company_count, v_distinct_company_count from public.ai_evidence ae where ae.photo_url = p_object_name;
  if v_referenced_row_count = 0 then return v_uploader_uid = v_uid::text; end if;
  if v_null_company_count > 0 or v_distinct_company_count <> 1 then return false; end if;
  select ae.company_id into v_company_id from public.ai_evidence ae where ae.photo_url = p_object_name and ae.company_id is not null limit 1;
  return exists (select 1 from public.company_members cm where cm.user_id = v_uid and cm.status = 'active' and cm.role in ('owner', 'admin') and cm.company_id = v_company_id);
end;
$f$;

-- Prod politiky storage.objects pre tieto dva buckety (2026-09-28).
create policy "AI documents - upload own files" on storage.objects for insert to authenticated
  with check ((bucket_id = 'ai-evidence-documents') and ((storage.foldername(name))[1] = (select (auth.uid())::text)));
create policy ai_evidence_documents_delete_company on storage.objects for delete to authenticated
  using ((bucket_id = 'ai-evidence-documents') and public.esblu_can_delete_ai_evidence_object(name));
create policy ai_evidence_documents_select_company on storage.objects for select to authenticated
  using ((bucket_id = 'ai-evidence-documents') and public.esblu_can_read_ai_evidence_object(name));
create policy ai_inbox_documents_delete_company on storage.objects for delete to authenticated
  using ((bucket_id = 'ai-inbox-documents') and public.esblu_can_delete_ai_inbox_object(name));
create policy ai_inbox_documents_insert_own on storage.objects for insert to authenticated
  with check ((bucket_id = 'ai-inbox-documents') and ((storage.foldername(name))[1] = (auth.uid())::text));
create policy ai_inbox_documents_select_company on storage.objects for select to authenticated
  using ((bucket_id = 'ai-inbox-documents') and public.esblu_can_read_ai_inbox_object(name));
create policy ai_inbox_documents_update_own on storage.objects for update to authenticated
  using ((bucket_id = 'ai-inbox-documents') and ((storage.foldername(name))[1] = (auth.uid())::text))
  with check ((bucket_id = 'ai-inbox-documents') and ((storage.foldername(name))[1] = (auth.uid())::text));
