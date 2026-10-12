-- =============================================================================
-- Zrušenie účtu — DB NAJPRV, súbory AŽ PO COMMITE (FORWARD-ONLY, 2026-10-12)
--
-- Medzera: route mazala Storage objekty PRED DB transakciou. Keď DB odmietla
-- zrušenie (napr. poistka 20261012120000 pri súbehu s aktiváciou predplatného),
-- firma ostala, ale jej súbory boli nenávratne preč.
--
-- Nový model:
--   A. server: auth + archivácia + owner_id + predplatné (route)
--   B. esblu_account_deletion_commit() — JEDNA transakcia:
--        zamkne riadok firmy (FOR UPDATE → nové súbory/checkouty/predplatné
--        firmy čakajú a po commite zlyhajú na FK), zozbiera Storage cesty
--        z DB riadkov, zavolá esblu_owner_delete_company / esblu_member_delete_self
--        a zapíše cleanup job (tombstone) s cestami.
--   C. commit (alebo celý rollback — vtedy sa žiadny súbor nezmaže)
--   D. route zmaže Storage podľa jobu
--   E. route zmaže auth používateľa
--   F. nedokončený D/E ostane v jobe ako pending → /api/cron/account-deletion-cleanup
--      opakuje (idempotentné: remove() chýbajúcej cesty ani deleteUser
--      neexistujúceho používateľa nie je chyba).
--
-- Nemaže ani nemení existujúce dáta. Nevolá žiadne provider API.
-- Rollback: supabase/rollback/20261012130000_account_deletion_post_commit_cleanup_rollback.sql
-- =============================================================================

create table if not exists public.account_deletion_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  user_id uuid not null,
  company_id uuid null,
  -- [{ "bucket": "...", "path": "..." }]; po úspešnom vyčistení sa vyprázdni (minimalizácia).
  storage_targets jsonb not null default '[]'::jsonb,
  storage_target_count integer not null default 0,
  storage_status text not null default 'pending',
  auth_status text not null default 'pending',
  attempts integer not null default 0,
  last_error_code text null,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint account_deletion_cleanup_jobs_kind_check check (kind in ('owner', 'member')),
  constraint account_deletion_cleanup_jobs_targets_check check (jsonb_typeof(storage_targets) = 'array'),
  constraint account_deletion_cleanup_jobs_storage_status_check check (storage_status in ('pending', 'done')),
  constraint account_deletion_cleanup_jobs_auth_status_check check (auth_status in ('pending', 'done')),
  constraint account_deletion_cleanup_jobs_error_check check (last_error_code is null or last_error_code ~ '^[A-Za-z0-9_:.-]{1,120}$')
);

create index if not exists account_deletion_cleanup_jobs_pending_idx
  on public.account_deletion_cleanup_jobs (next_attempt_at)
  where storage_status = 'pending' or auth_status = 'pending';

comment on table public.account_deletion_cleanup_jobs is
  'Post-commit cleanup po zrušení účtu/firmy (Storage + auth). Vzniká IBA v esblu_account_deletion_commit '
  'v tej istej transakcii ako DB zrušenie. Service role only.';

alter table public.account_deletion_cleanup_jobs enable row level security;
revoke all on table public.account_deletion_cleanup_jobs from public, anon, authenticated;
grant select, insert, update on table public.account_deletion_cleanup_jobs to service_role;

create or replace function public.esblu_account_deletion_commit(p_kind text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_targets jsonb := '[]'::jsonb;
  v_summary jsonb;
  v_job_id uuid;
begin
  if p_user_id is null or p_kind is null or p_kind not in ('owner', 'member') then
    raise exception using errcode = 'P0001', message = 'ESBLU_ACCOUNT_DELETION_INVALID_REQUEST';
  end if;

  if p_kind = 'owner' then
    select cm.company_id into v_company_id
    from public.company_members cm
    where cm.user_id = p_user_id and cm.status = 'active' and cm.role = 'owner'
    limit 1;
    if v_company_id is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_NOT_ACTIVE_OWNER';
    end if;

    -- Zámok firmy: súbežné vloženie súboru / checkoutu / predplatného tejto
    -- firmy (FK → companies) počká a po zrušení zlyhá. Cesty nižšie sú preto úplné.
    perform 1 from public.companies c where c.id = v_company_id for update;

    select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', t.bucket, 'path', t.path)), '[]'::jsonb)
    into v_targets
    from (
      select d.storage_bucket as bucket, d.storage_path as path from public.documents d
        where d.company_id = v_company_id and d.storage_bucket is not null and d.storage_path is not null
      union all
      select a.storage_bucket, a.storage_path from public.document_attachments a
        where a.company_id = v_company_id and a.storage_bucket is not null and a.storage_path is not null
      union all
      select 'ai-evidence-documents', e.photo_url from public.ai_evidence e
        where e.company_id = v_company_id and e.photo_url is not null
      union all
      select 'machine-photos', m.file_path from public.machine_photos m
        where m.company_id = v_company_id and m.file_path is not null
      union all
      select 'inventory-photos', i.file_path from public.inventory_photos i
        where i.company_id = v_company_id and i.file_path is not null
      union all
      select 'vehicle-photos', v.storage_path from public.vehicle_photos v
        where v.company_id = v_company_id and v.storage_path is not null
      union all
      select 'company-logos', s.logo_path from public.settings s
        where s.user_id = p_user_id and s.logo_path is not null
      union all
      select 'company-logos', b.logo_path from public.company_billing_profile b
        where b.company_id = v_company_id and b.logo_path is not null
    ) t;

    -- Archivácia, owner_id, predplatné (poistka 20261012120000) — chyba = rollback celej transakcie.
    v_summary := public.esblu_owner_delete_company(p_user_id);
  else
    select cm.company_id into v_company_id
    from public.company_members cm
    where cm.user_id = p_user_id and cm.status = 'active'
    limit 1;

    select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', 'company-logos', 'path', s.logo_path)), '[]'::jsonb)
    into v_targets
    from public.settings s
    where s.user_id = p_user_id and s.logo_path is not null;

    v_summary := public.esblu_member_delete_self(p_user_id);
  end if;

  insert into public.account_deletion_cleanup_jobs (kind, user_id, company_id, storage_targets, storage_target_count, storage_status)
  values (p_kind, p_user_id, v_company_id, v_targets, jsonb_array_length(v_targets),
          case when jsonb_array_length(v_targets) = 0 then 'done' else 'pending' end)
  returning id into v_job_id;

  return jsonb_build_object('job_id', v_job_id, 'storage_targets', v_targets, 'summary', v_summary);
end
$function$;

comment on function public.esblu_account_deletion_commit(text, uuid) is
  'Zrušenie účtu: DB časť + cleanup job v JEDNEJ transakcii. Storage sa maže až po commite (route / cron).';

revoke all on function public.esblu_account_deletion_commit(text, uuid) from public, anon, authenticated;
grant execute on function public.esblu_account_deletion_commit(text, uuid) to service_role;
