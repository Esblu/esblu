-- =============================================================================
-- J10 CLIA GDPR reconciliation — technická retencia podľa CLIA (09.11.2026)
-- =============================================================================
-- Zdroj lehôt: Zásady spracúvania osobných údajov (CLIA 09.11.2026) a interná
-- Smernica, čl. 11.3. Táto migrácia rieši IBA prípady, kde dnešný stav
-- JEDNOZNAČNE prekračuje maximum CLIA a neexistuje iný právny dôvod:
--
--   1. push_devices / push_subscriptions — zneplatnené (revoked) identifikátory
--      sa doteraz nemazali nikdy. CLIA: „zneplatnia a vymažú najneskôr do 30 dní“
--      po deaktivácii / odhlásení / ukončení prístupu.
--   2. notification_deliveries — 'deadline' riadky sa nemazali nikdy.
--      CLIA: technické záznamy o odoslaní a doručení notifikácií „najviac 90 dní“.
--      ('chat' riadky ostávajú na existujúcej 7-dňovej purge.) Vedľajší účinok:
--      termín, ktorý je > 90 dní po splatnosti a stále nevyriešený, sa môže
--      pripomenúť znova najviac raz za ~90 dní (OWNER INFORMATIVE NOTE).
--   3. company_invites — neprijaté pozvánky (pending/expired po expirácii,
--      revoked) sa nemazali nikdy. CLIA: „vymažú najneskôr do 30 dní od
--      uplynutia ich platnosti alebo ich zrušenia“. Prijaté pozvánky sa
--      NEMAŽÚ (viazané na účet, lehota účtu).
--   4. account_deletion_cleanup_jobs — dokončené joby (user_id, company_id,
--      kód chyby) ostávali navždy. Ide o technický prevádzkový záznam →
--      CLIA „najviac 90 dní“. Nedokončené (pending) joby sa NEMAŽÚ.
--   5. assistant_action_confirmations / assistant_conversation_contexts —
--      expirované technické záznamy (TTL minúty) → mažú sa po 1 dni.
--   6. media_deletion_queue — dokončené riadky (cesty k zmazaným súborom)
--      → 90 dní (technický záznam).
--   7. Neúspešné registrácie — nepotvrdené auth účty bez členstva staršie
--      ako 30 dní. CLIA: „najviac 30 dní od ukončenia registračného procesu“.
--      SQL iba VYBERIE kandidátov (service_role); mazanie robí server cez
--      auth.admin.deleteUser (rovnaká cesta ako zrušenie účtu).
--   8. esblu_account_deletion_commit — pri zrušení firmy sa doteraz nezbierali
--      súbory chat príloh (bucket chat-attachments) → ostávali v Storage ako
--      siroty. Doplnené do zberu ciest (CLIA manuál 7.2 — výmaz príloh).
--
-- NEMENÍ: účtovné/eFaktúra retenčné guardy, ai_processing_usage (počíta
-- trial/obdobia — business rule), trial_claims, legal acceptance záznamy,
-- billing_events, chat správy (obsah Zákazníka — lehotu určuje Zákazník).
--
-- Všetky funkcie: SECURITY DEFINER, search_path = '', iba service_role.
-- Idempotentné (create or replace). Rollback: pozri koniec súboru.
-- =============================================================================

-- 1–6: jedna údržbová funkcia, volaná z /api/cron/telemetry-maintenance.
create or replace function public.esblu_purge_gdpr_technical_retention(p_batch_size integer default 5000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_batch integer := least(greatest(coalesce(p_batch_size, 5000), 1), 20000);
  v_push_devices integer := 0;
  v_push_subscriptions integer := 0;
  v_deliveries integer := 0;
  v_invites integer := 0;
  v_jobs integer := 0;
  v_confirmations integer := 0;
  v_contexts integer := 0;
  v_media_queue integer := 0;
begin
  delete from public.push_devices d
  where d.id in (
    select x.id from public.push_devices x
    where x.revoked_at is not null and x.revoked_at < now() - interval '30 days'
    order by x.revoked_at limit v_batch
  );
  get diagnostics v_push_devices = row_count;

  delete from public.push_subscriptions s
  where s.id in (
    select x.id from public.push_subscriptions x
    where x.revoked_at is not null and x.revoked_at < now() - interval '30 days'
    order by x.revoked_at limit v_batch
  );
  get diagnostics v_push_subscriptions = row_count;

  delete from public.notification_deliveries n
  where n.id in (
    select x.id from public.notification_deliveries x
    where x.sent_at < now() - interval '90 days'
    order by x.sent_at limit v_batch
  );
  get diagnostics v_deliveries = row_count;

  delete from public.company_invites i
  where i.id in (
    select x.id from public.company_invites x
    where x.accepted_at is null
      and (
        (x.status in ('pending', 'expired') and x.expires_at < now() - interval '30 days')
        or (x.status = 'revoked' and coalesce(x.revoked_at, x.expires_at) < now() - interval '30 days')
      )
    order by x.expires_at limit v_batch
  );
  get diagnostics v_invites = row_count;

  delete from public.account_deletion_cleanup_jobs j
  where j.id in (
    select x.id from public.account_deletion_cleanup_jobs x
    where x.storage_status = 'done' and x.auth_status = 'done'
      and coalesce(x.completed_at, x.updated_at) < now() - interval '90 days'
    order by x.created_at limit v_batch
  );
  get diagnostics v_jobs = row_count;

  delete from public.assistant_action_confirmations c
  where c.id in (
    select x.id from public.assistant_action_confirmations x
    where x.expires_at < now() - interval '1 day'
    order by x.expires_at limit v_batch
  );
  get diagnostics v_confirmations = row_count;

  delete from public.assistant_conversation_contexts c
  where c.expires_at < now() - interval '1 day';
  get diagnostics v_contexts = row_count;

  delete from public.media_deletion_queue q
  where q.id in (
    select x.id from public.media_deletion_queue x
    where x.completed_at is not null and x.completed_at < now() - interval '90 days'
    order by x.completed_at limit v_batch
  );
  get diagnostics v_media_queue = row_count;

  return jsonb_build_object(
    'push_devices', v_push_devices,
    'push_subscriptions', v_push_subscriptions,
    'notification_deliveries', v_deliveries,
    'company_invites', v_invites,
    'account_deletion_jobs', v_jobs,
    'assistant_action_confirmations', v_confirmations,
    'assistant_conversation_contexts', v_contexts,
    'media_deletion_queue', v_media_queue
  );
end
$function$;

comment on function public.esblu_purge_gdpr_technical_retention(integer) is
  'J10 CLIA (09.11.2026): technická retencia — revoked push identifikátory 30 d, doručenia notifikácií 90 d, '
  'neprijaté pozvánky 30 d po expirácii/zrušení, dokončené deletion joby 90 d, expirované asistent záznamy 1 d, '
  'dokončená media fronta 90 d. Service role only.';

revoke all on function public.esblu_purge_gdpr_technical_retention(integer) from public, anon, authenticated;
grant execute on function public.esblu_purge_gdpr_technical_retention(integer) to service_role;

-- 7: kandidáti na výmaz neúspešnej registrácie (iba výber, nič nemaže).
create or replace function public.esblu_list_stale_unconfirmed_auth_users(p_older_than_days integer default 30, p_limit integer default 50)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select u.id
  from auth.users u
  where u.email_confirmed_at is null
    and u.phone_confirmed_at is null
    and u.last_sign_in_at is null
    and u.created_at < now() - make_interval(days => greatest(coalesce(p_older_than_days, 30), 30))
    and not exists (select 1 from public.company_members cm where cm.user_id = u.id)
    and not exists (select 1 from public.companies c where c.owner_id = u.id)
  order by u.created_at
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$function$;

comment on function public.esblu_list_stale_unconfirmed_auth_users(integer, integer) is
  'J10 CLIA: nepotvrdené registrácie bez členstva/firmy staršie ako N (min. 30) dní. Iba výber; '
  'mazanie robí /api/cron/telemetry-maintenance cez auth.admin.deleteUser. Service role only.';

revoke all on function public.esblu_list_stale_unconfirmed_auth_users(integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_list_stale_unconfirmed_auth_users(integer, integer) to service_role;

-- 8: esblu_account_deletion_commit — doplnený zber chat príloh. Telo je
-- identické s 20261013100000_einvoice_company_deletion_guard.sql okrem
-- jedného UNION ALL bloku (chat_attachments).
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
      union all
      -- J10 (20261110100000): chat prílohy firmy (predtým ostávali v Storage).
      select ca.storage_bucket, ca.storage_path from public.chat_attachments ca
        where ca.company_id = p_company_id and ca.storage_bucket is not null and ca.storage_path is not null
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
  'Owner: blokované účtovnými dokladmi / e-faktúrami / registráciou u providera (20261013100000). '
  'J10 (20261110100000): zber ciest zahŕňa aj chat-attachments.';

revoke all on function public.esblu_account_deletion_commit(text, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.esblu_account_deletion_commit(text, uuid, uuid, boolean) to service_role;

-- =============================================================================
-- ROLLBACK (manuálne, staging):
--   drop function if exists public.esblu_purge_gdpr_technical_retention(integer);
--   drop function if exists public.esblu_list_stale_unconfirmed_auth_users(integer, integer);
--   -- esblu_account_deletion_commit: znovu aplikovať definíciu z
--   -- 20261013100000_einvoice_company_deletion_guard.sql (bez chat_attachments).
-- Zmazané retenčné riadky sa rollbackom neobnovujú (zámer migrácie).
-- =============================================================================
