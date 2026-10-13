-- =============================================================================
-- 20261013100000 — eInvoice ↔ zrušenie firmy (reconciliation guard)
--
-- Zdroj: docs/einvoice-rc-integration-audit-2026-10-13.md §5.
-- FK einvoice_* → companies sú ON DELETE CASCADE. Firma iba ENROLLNUTÁ
-- u providera (einvoice_organizations.provider_org_id, bez dokladov) by sa
-- kaskádou zmazala a identita u providera by osirotela; e-faktúry (XML v
-- privátnom bucket einvoice-documents) sú nemenná evidencia.
--
-- Zmena (aditívna, idempotentná):
--   1) esblu_company_deletion_retention_blocker(company) — iba čítanie.
--   2) esblu_account_deletion_commit('owner', …) — fail closed
--      ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION pred zberom ciest aj mazaním.
--      Telo = 20261012140000 + jeden blok (nič iné sa nemení).
-- Retenčná doba ani deaktivácia u providera sa NEVYMÝŠĽAJÚ (LEGAL/CLIA).
-- Rollback: supabase/rollback/20261013100000_einvoice_company_deletion_guard_rollback.sql
-- Nevyžaduje eInvoice tabuľky (to_regclass) → bezpečné v akomkoľvek poradí po 20261012140000.
-- =============================================================================


create or replace function public.esblu_company_deletion_retention_blocker(p_company_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_hit boolean;
begin
  if p_company_id is null then
    return null;
  end if;
  -- Tabuľky sa overujú cez to_regclass: prostredie bez eInvoice / fakturácie
  -- (napr. staršia vetva) sa správa, akoby záznamy neexistovali.
  if to_regclass('public.invoices') is not null then
    execute 'select exists (select 1 from public.invoices i where i.company_id = $1 and i.document_status = ''finalized'')'
      into v_hit using p_company_id;
    if v_hit then return 'FINALIZED_ACCOUNTING_DOCUMENTS'; end if;
  end if;
  if to_regclass('public.einvoice_inbound') is not null then
    execute 'select exists (select 1 from public.einvoice_inbound x where x.company_id = $1)' into v_hit using p_company_id;
    if v_hit then return 'EINVOICE_RECORDS'; end if;
  end if;
  if to_regclass('public.einvoice_outbound') is not null then
    execute 'select exists (select 1 from public.einvoice_outbound x where x.company_id = $1)' into v_hit using p_company_id;
    if v_hit then return 'EINVOICE_RECORDS'; end if;
  end if;
  if to_regclass('public.einvoice_organizations') is not null then
    execute 'select exists (select 1 from public.einvoice_organizations o where o.company_id = $1 and o.provider_org_id is not null)'
      into v_hit using p_company_id;
    if v_hit then return 'EINVOICE_PROVIDER_ENROLLED'; end if;
  end if;
  return null;
end;
$function$;

comment on function public.esblu_company_deletion_retention_blocker(uuid) is
  'Dôvod, prečo sa firma nesmie zrušiť (FINALIZED_ACCOUNTING_DOCUMENTS / EINVOICE_RECORDS / EINVOICE_PROVIDER_ENROLLED) alebo null. '
  'Zrkadlí lib/account-deletion-retention.ts. Retenčná doba sa nevymýšľa (CLIA).';

revoke all on function public.esblu_company_deletion_retention_blocker(uuid) from public, anon, authenticated;
grant execute on function public.esblu_company_deletion_retention_blocker(uuid) to service_role;

create or replace function public.esblu_account_deletion_commit(
  p_kind text,
  p_user_id uuid,
  p_company_id uuid,
  p_delete_account boolean
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_targets jsonb := '[]'::jsonb;
  v_user_targets jsonb := '[]'::jsonb;
  v_summary jsonb := '{}'::jsonb;
  v_global jsonb := null;
  v_remaining integer;
  v_delete_account boolean := coalesce(p_delete_account, false) or p_kind = 'global';
  v_job_id uuid;
  v_blocker text;
begin
  if p_user_id is null or p_kind is null or p_kind not in ('owner', 'member', 'global') then
    raise exception using errcode = 'P0001', message = 'ESBLU_ACCOUNT_DELETION_INVALID_REQUEST';
  end if;
  if p_kind in ('owner', 'member') and p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_COMPANY_ID_REQUIRED';
  end if;

  if p_kind = 'owner' then
    if not exists (
      select 1 from public.company_members cm
      where cm.user_id = p_user_id and cm.company_id = p_company_id and cm.status = 'active' and cm.role = 'owner'
    ) then
      raise exception using errcode = 'P0001', message = 'ESBLU_NOT_ACTIVE_OWNER';
    end if;

    -- Zámok firmy: súbežné súbory / checkouty / predplatné tejto firmy počkajú
    -- a po zrušení zlyhajú na FK → zoznam ciest je úplný.
    perform 1 from public.companies c where c.id = p_company_id for update;

    -- eInvoice ↔ zrušenie firmy (20261013100000): účtovné záznamy / e-faktúry /
    -- registrácia u providera → fail closed PRED zberom ciest aj mazaním.
    v_blocker := public.esblu_company_deletion_retention_blocker(p_company_id);
    if v_blocker is not null then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION',
        detail = v_blocker,
        hint = 'Firma má účtovné doklady, e-faktúry alebo aktívnu registráciu u providera e-Faktúry — retencia (CLIA) a deaktivácia u providera nie sú rozhodnuté.';
    end if;

    select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', t.bucket, 'path', t.path)), '[]'::jsonb)
    into v_targets
    from (
      select d.storage_bucket as bucket, d.storage_path as path from public.documents d
        where d.company_id = p_company_id and d.storage_bucket is not null and d.storage_path is not null
      union all
      select a.storage_bucket, a.storage_path from public.document_attachments a
        where a.company_id = p_company_id and a.storage_bucket is not null and a.storage_path is not null
      union all
      select 'ai-evidence-documents', e.photo_url from public.ai_evidence e
        where e.company_id = p_company_id and e.photo_url is not null
      union all
      select 'machine-photos', m.file_path from public.machine_photos m
        where m.company_id = p_company_id and m.file_path is not null
      union all
      select 'inventory-photos', i.file_path from public.inventory_photos i
        where i.company_id = p_company_id and i.file_path is not null
      union all
      select 'vehicle-photos', v.storage_path from public.vehicle_photos v
        where v.company_id = p_company_id and v.storage_path is not null
      union all
      select 'company-logos', b.logo_path from public.company_billing_profile b
        where b.company_id = p_company_id and b.logo_path is not null
    ) t;

    -- archivácia, owner_id, poistka predplatného (20261012120000) → chyba = rollback
    v_summary := public.esblu_owner_delete_company(p_user_id, p_company_id);
  elsif p_kind = 'member' then
    v_summary := public.esblu_member_leave_company(p_user_id, p_company_id);
  end if;

  select count(*) into v_remaining
  from public.company_members cm
  where cm.user_id = p_user_id and cm.status = 'active';

  if v_delete_account then
    if p_kind <> 'global' and v_remaining > 0 then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_ACCOUNT_HAS_OTHER_COMPANIES',
        hint = 'Používateľ je stále členom ďalšej firmy — login sa nezruší.';
    end if;

    select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', 'company-logos', 'path', s.logo_path)), '[]'::jsonb)
    into v_user_targets
    from public.settings s
    where s.user_id = p_user_id and s.logo_path is not null;

    -- vlastní firmu / autor uchovávaných záznamov → výnimka → rollback CELÉHO zrušenia
    v_global := public.esblu_user_global_cleanup(p_user_id);
  end if;

  select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into v_targets
  from jsonb_array_elements(v_targets || v_user_targets) x;

  insert into public.account_deletion_cleanup_jobs
    (kind, user_id, company_id, storage_targets, storage_target_count, storage_status, auth_status, completed_at)
  values (
    p_kind, p_user_id, p_company_id, v_targets, jsonb_array_length(v_targets),
    case when jsonb_array_length(v_targets) = 0 then 'done' else 'pending' end,
    case when v_delete_account then 'pending' else 'done' end,
    case when jsonb_array_length(v_targets) = 0 and not v_delete_account then now() end
  )
  returning id into v_job_id;

  return jsonb_build_object(
    'job_id', v_job_id,
    'storage_targets', v_targets,
    'summary', v_summary,
    'global', v_global,
    'delete_account', v_delete_account,
    'remaining_memberships', v_remaining
  );
end;
$function$;

comment on function public.esblu_account_deletion_commit(text, uuid, uuid, boolean) is
  'Multi-company zrušenie: owner = zruší firmu p_company_id, member = opustí firmu, global = zruší login '
  '(iba bez vlastnených firiem). DB + cleanup job v 1 transakcii; Storage/auth až po commite. '
  'Owner: blokované účtovnými dokladmi / e-faktúrami / registráciou u providera (20261013100000).';

revoke all on function public.esblu_account_deletion_commit(text, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.esblu_account_deletion_commit(text, uuid, uuid, boolean) to service_role;
