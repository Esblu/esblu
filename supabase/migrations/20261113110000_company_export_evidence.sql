-- =============================================================================
-- Server-side dôkaz úspešného exportu firmy pred ukončením (VOP 1.2 čl. 20.6, DPA)
-- =============================================================================
-- Problém: esblu_company_termination_commit(…, 'exported') prijal „exported“ iba ako
-- vyhlásenie klienta — server nevedel, či export naozaj prebehol.
--
-- Riešenie (najmenšia zmena, commit funkcia sa NEMENÍ):
-- 1. company_export_runs — dôkaz exportu: firma, owner, čas, stav, verzia schémy,
--    počty, SHA-256 data ZIP a každej dávky súborov. Iba metadáta (žiadny obsah,
--    žiadne ZIP). Bez FK na firmu (ako company_terminations) — dôkaz prežije výmaz.
-- 2. Zápis IBA cez service_role RPC volané z /api/company/export PO vygenerovaní
--    dávky (begin → part → completed). Klient nemá žiadny grant ani EXECUTE —
--    dôkaz nevie vytvoriť payloadom.
-- 3. BEFORE INSERT trigger na company_terminations: riadok 'executing' s
--    export_mode = 'exported' vyžaduje dokončený (completed, bez chýbajúcich
--    súborov) export TEJ ISTEJ firmy od TOHO ISTÉHO ownera za posledných 24 h.
--    Inak ESBLU_TERMINATION_EXPORT_NOT_VERIFIED → rollback celej transakcie
--    (executing záznam vzniká PRED akýmkoľvek výmazom → nič sa nezmaže).
--    ID exportu sa zapíše do company_terminations.export_run_id (audit).
-- 4. 'waived' (výslovné vzdanie sa exportu) a záznamy 'failed' sa nemenia.
-- Rollback: supabase/rollback/20261113110000_company_export_evidence_rollback.sql
-- =============================================================================

create table if not exists public.company_export_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  requested_by uuid not null,
  status text not null,
  schema_version text not null,
  files_total integer not null,
  file_parts integer not null,
  parts_done integer[] not null default '{}',
  data_sha256 text not null,
  part_sha256 jsonb not null default '{}'::jsonb,
  missing_files integer not null default 0,
  error_code text null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint company_export_runs_status_check check (status in ('in_progress', 'completed', 'failed')),
  constraint company_export_runs_counts_check check (files_total >= 0 and file_parts >= 0 and missing_files >= 0),
  constraint company_export_runs_sha_check check (data_sha256 ~ '^[0-9a-f]{64}$'),
  constraint company_export_runs_schema_check check (schema_version ~ '^[A-Za-z0-9_.:-]{1,40}$'),
  constraint company_export_runs_error_check check (error_code is null or error_code ~ '^[A-Z0-9_]{1,80}$'),
  constraint company_export_runs_completed_check check ((status = 'completed') = (completed_at is not null))
);

create index if not exists company_export_runs_company_idx
  on public.company_export_runs (company_id, requested_by, completed_at desc);

comment on table public.company_export_runs is
  'VOP 20.6 / DPA: server-side dôkaz, že export údajov firmy bol vygenerovaný a odovzdaný (data ZIP + všetky dávky súborov). '
  'Iba metadáta a SHA-256, žiadny obsah. Zápis iba service_role RPC z /api/company/export. Podmienka pre ukončenie firmy v režime exported.';

alter table public.company_export_runs enable row level security;
revoke all on table public.company_export_runs from public, anon, authenticated;
grant select on table public.company_export_runs to service_role;

alter table public.company_terminations add column if not exists export_run_id uuid null;

-- Overenie aktívneho ownera (rovnaké pravidlo ako termination commit).
create or replace function public.esblu_company_export_assert_owner(p_user_id uuid, p_company_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_user_id is null or p_company_id is null
     or not exists (select 1 from public.company_members cm
                    where cm.user_id = p_user_id and cm.company_id = p_company_id and cm.status = 'active' and cm.role = 'owner')
     or not exists (select 1 from public.companies c where c.id = p_company_id and c.owner_id = p_user_id) then
    raise exception using errcode = 'P0001', message = 'ESBLU_NOT_ACTIVE_OWNER';
  end if;
end;
$function$;
revoke all on function public.esblu_company_export_assert_owner(uuid, uuid) from public, anon, authenticated;

-- Data ZIP vygenerovaný → nový beh. Bez súborov = hneď completed.
create or replace function public.esblu_company_export_begin(
  p_user_id uuid,
  p_company_id uuid,
  p_schema_version text,
  p_files_total integer,
  p_file_parts integer,
  p_data_sha256 text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
begin
  perform public.esblu_company_export_assert_owner(p_user_id, p_company_id);
  if p_files_total is null or p_files_total < 0 or p_file_parts is null or p_file_parts < 0
     or (p_files_total = 0) <> (p_file_parts = 0) then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
  end if;
  insert into public.company_export_runs (company_id, requested_by, status, schema_version, files_total, file_parts, data_sha256, completed_at)
  values (p_company_id, p_user_id,
          case when p_file_parts = 0 then 'completed' else 'in_progress' end,
          p_schema_version, p_files_total, p_file_parts, lower(p_data_sha256),
          case when p_file_parts = 0 then now() end)
  returning id into v_id;
  return v_id;
end;
$function$;
revoke all on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text) to service_role;

-- Dávka súborov vygenerovaná → zapíše sa; posledná dávka bez chýbajúcich súborov = completed.
-- Iný počet súborov než pri begin (údaje sa zmenili) alebo chýbajúci súbor = failed.
create or replace function public.esblu_company_export_part(
  p_export_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_index integer,
  p_files_total integer,
  p_part_sha256 text,
  p_missing integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run public.company_export_runs;
  v_done integer[];
begin
  perform public.esblu_company_export_assert_owner(p_user_id, p_company_id);
  select * into v_run from public.company_export_runs r where r.id = p_export_id for update;
  if v_run.id is null or v_run.company_id <> p_company_id or v_run.requested_by <> p_user_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_NOT_FOUND';
  end if;
  if v_run.status <> 'in_progress' or v_run.created_at < now() - interval '24 hours' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_NOT_IN_PROGRESS';
  end if;
  if p_index is null or p_index < 0 or p_index >= v_run.file_parts
     or p_part_sha256 is null or p_part_sha256 !~ '^[0-9a-f]{64}$' or p_missing is null or p_missing < 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
  end if;
  if p_files_total is distinct from v_run.files_total then
    update public.company_export_runs set status = 'failed', error_code = 'FILES_CHANGED' where id = v_run.id;
    return 'failed';
  end if;
  if p_missing > 0 then
    update public.company_export_runs
      set status = 'failed', error_code = 'FILES_MISSING', missing_files = missing_files + p_missing,
          part_sha256 = part_sha256 || jsonb_build_object(p_index::text, p_part_sha256)
      where id = v_run.id;
    return 'failed';
  end if;
  v_done := (select array_agg(distinct x order by x) from unnest(v_run.parts_done || p_index) x);
  update public.company_export_runs
    set parts_done = v_done,
        part_sha256 = part_sha256 || jsonb_build_object(p_index::text, p_part_sha256),
        status = case when cardinality(v_done) = v_run.file_parts then 'completed' else 'in_progress' end,
        completed_at = case when cardinality(v_done) = v_run.file_parts then now() end
    where id = v_run.id;
  return case when cardinality(v_done) = v_run.file_parts then 'completed' else 'in_progress' end;
end;
$function$;
revoke all on function public.esblu_company_export_part(uuid, uuid, uuid, integer, integer, text, integer) from public, anon, authenticated;
grant execute on function public.esblu_company_export_part(uuid, uuid, uuid, integer, integer, text, integer) to service_role;

-- Zlyhanie generovania dávky → beh failed (nikdy sa nepočíta ako dôkaz).
create or replace function public.esblu_company_export_fail(p_export_id uuid, p_company_id uuid, p_error_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.company_export_runs
    set status = 'failed',
        error_code = case when p_error_code ~ '^[A-Z0-9_]{1,80}$' then p_error_code else 'EXPORT_FAILED' end,
        completed_at = null
    where id = p_export_id and company_id = p_company_id and status = 'in_progress';
end;
$function$;
revoke all on function public.esblu_company_export_fail(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_company_export_fail(uuid, uuid, text) to service_role;

-- Brána ukončenia: 'exported' iba s overeným dokončeným exportom (fail closed).
create or replace function public.esblu_company_termination_export_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run uuid;
begin
  if new.status = 'executing' and new.export_mode = 'exported' then
    select r.id into v_run
    from public.company_export_runs r
    where r.company_id = new.company_id
      and r.requested_by = new.requested_by
      and r.status = 'completed'
      and r.missing_files = 0
      and r.completed_at > now() - interval '24 hours'
    order by r.completed_at desc
    limit 1;
    if v_run is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_NOT_VERIFIED';
    end if;
    new.export_run_id := v_run;
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_company_termination_export_gate() from public, anon, authenticated;

drop trigger if exists esblu_company_termination_export_gate on public.company_terminations;
create trigger esblu_company_termination_export_gate
  before insert on public.company_terminations
  for each row execute function public.esblu_company_termination_export_gate();
