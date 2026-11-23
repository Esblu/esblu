-- =============================================================================
-- P1-5 / GDPR 2.0 (2026-11-23): ukončenie firmy BEZ zákazníckeho retenčného archívu.
-- PRIPRAVENÉ — NEAPLIKOVANÉ (staging aj produkcia iba po samostatnom schválení vlastníka).
--
-- Stanovisko CLIA (23. 11. 2026) a DPA 2.0 čl. X (10.4), 6.3.9, Smernica 11.2: po skončení služby Esblu podľa
-- rozhodnutia Zákazníka údaje vráti (export) alebo vymaže VRÁTANE KÓPIÍ; zákonnú archiváciu účtovných dokladov
-- zabezpečuje Zákazník. Migrácia 20261121100000 (esblu_retention, 10-ročný archív) je s tým v rozpore — táto
-- migrácia ju funkčne nahrádza a je samostatná: funguje bez nej (produkcia) aj po nej (staging; objekty
-- esblu_retention ostávajú nedotknuté a nepoužívané — žiadny deštruktívny zásah).
--
-- 1) company_export_runs: serverový odtlačok dát (data_fingerprint) + počty + SHA-256 manifestu; export zlyhá,
--    ak sa údaje zmenili počas jeho tvorby (ESBLU_EXPORT_DATA_CHANGED).
--    esblu_company_export_fingerprint(company) — SHA-256 nad obsahom účtovných a dokladových tabuliek firmy
--    (bez dokladov adresovaných inému účastníkovi, R3). Počíta DB, nie klient.
-- 2) Brána ukončenia (BEFORE INSERT company_terminations) — nenávratný výmaz IBA ak:
--    - 'waived' (bez exportu) nie je dovolené, ak firma má finalizované doklady alebo e-faktúry (O3 v DB),
--    - 'exported' vyžaduje dokončený beh exportu < 24 h bez chýbajúcich súborov A zhodný odtlačok dát
--      (údaje sa po exporte nezmenili) → inak ESBLU_TERMINATION_EXPORT_STALE,
--    - režim customer_delete vyžaduje potvrdenie oprávnenej osoby: výslovné vyhlásenie o oprávnení konať za
--      firmu, verziu a SHA-256 potvrdeného textu, čas potvrdenia (≤ 15 min) a čerstvé prihlásenie (≤ 30 min).
-- 3) public.esblu_company_termination_execute(user, company, delete_account, export_mode, ack) — výmaz dokladov,
--    e-faktúr a súborov (XML, UBL, PDF prijatých e-faktúr) bez archívu; ostatné údaje cez
--    esblu_account_deletion_commit. Mandáty eFaktúry (dôkaz oprávnenia, append-only) sa nemenia.
--    public.esblu_company_termination_commit (pôvodná 4-arg signatúra) odmietne — vyžaduje sa potvrdenie.
--    public.esblu_company_termination_preflight — rovnaká brána bez zmeny údajov (pred deregistráciou u poskytovateľa).
-- 4) Ochrana účtovných kópií Esblu: cleanup job nikdy nezahrnie bucket billing-documents (trigger platí aj bez
--    20261121100000); vetva „súbory retenčného archívu“ sa ruší.
-- 5) Preukázateľný výmaz: company_terminations.storage_purged_at = čas, keď cleanup job dokončil výmaz súborov.
-- Rollback: supabase/rollback/20261127100000_company_termination_customer_delete_rollback.sql
-- =============================================================================
begin;

-- ----------------------------------------------------------------------------- 1. evidencia
alter table public.company_terminations add column if not exists termination_mode text null;
alter table public.company_terminations add column if not exists ack_text_version text null;
alter table public.company_terminations add column if not exists ack_text_sha256 text null;
alter table public.company_terminations add column if not exists authority_confirmed boolean null;
alter table public.company_terminations add column if not exists confirmed_at timestamptz null;
alter table public.company_terminations add column if not exists request_ip_sha256 text null;
alter table public.company_terminations add column if not exists user_agent_sha256 text null;
alter table public.company_terminations add column if not exists export_fingerprint text null;
alter table public.company_terminations add column if not exists storage_purged_at timestamptz null;

alter table public.company_terminations drop constraint if exists company_terminations_mode_check;
alter table public.company_terminations add constraint company_terminations_mode_check check (
  termination_mode is null or termination_mode in ('customer_delete', 'archive', 'synthetic_test_data_purge')
);
alter table public.company_terminations drop constraint if exists company_terminations_ack_check;
alter table public.company_terminations add constraint company_terminations_ack_check check (
  (ack_text_version is null or ack_text_version ~ '^[A-Za-z0-9_.:-]{1,60}$')
  and (ack_text_sha256 is null or ack_text_sha256 ~ '^[0-9a-f]{64}$')
  and (request_ip_sha256 is null or request_ip_sha256 ~ '^[0-9a-f]{64}$')
  and (user_agent_sha256 is null or user_agent_sha256 ~ '^[0-9a-f]{64}$')
  and (export_fingerprint is null or export_fingerprint ~ '^[0-9a-f]{64}$')
) not valid;
alter table public.company_terminations validate constraint company_terminations_ack_check;

alter table public.company_export_runs add column if not exists data_fingerprint text null;
alter table public.company_export_runs add column if not exists counts jsonb null;
alter table public.company_export_runs add column if not exists manifest_sha256 text null;
alter table public.company_export_runs drop constraint if exists company_export_runs_fingerprint_check;
alter table public.company_export_runs add constraint company_export_runs_fingerprint_check check (
  (data_fingerprint is null or data_fingerprint ~ '^[0-9a-f]{64}$')
  and (manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$')
  and (counts is null or jsonb_typeof(counts) = 'object')
) not valid;
alter table public.company_export_runs validate constraint company_export_runs_fingerprint_check;

-- ----------------------------------------------------------------------------- 2. odtlačok dát firmy
-- Obsah (to_jsonb riadku, vrátane updated_at) účtovných a dokladových tabuliek firmy → SHA-256.
-- Doklady adresované inému účastníkovi (RECIPIENT_MISMATCH, R3) nie sú údaje firmy → nezapočítavajú sa
-- (rovnako ich vynecháva export). Chýbajúca tabuľka (staršie prostredie) sa preskočí.
create or replace function public.esblu_company_export_fingerprint(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  r record;
  v_n bigint;
  v_h text;
  v_parts text := '';
  v_counts jsonb := '{}'::jsonb;
  v_where text;
begin
  if p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
  end if;
  for r in
    select * from (values
      (1, 'invoices', 'company'), (2, 'invoice_items', 'invoice'), (3, 'invoice_parties', 'invoice'),
      (4, 'invoice_tax_breakdowns', 'invoice'), (5, 'invoice_payments', 'invoice'), (6, 'invoice_events', 'invoice'),
      (7, 'invoice_advance_deductions', 'invoice'), (8, 'invoice_accounting_state', 'company'),
      (9, 'invoice_accounting_state_log', 'company'), (10, 'received_advance_links', 'company'),
      (11, 'documents', 'company'), (12, 'document_attachments', 'company'),
      (13, 'einvoice_inbound', 'inbound'), (14, 'einvoice_outbound', 'company'), (15, 'einvoice_events', 'events'),
      (16, 'einvoice_mandates', 'company')
    ) t(ord, tbl, scope)
    order by ord
  loop
    if to_regclass('public.' || r.tbl) is null then
      continue;
    end if;
    v_where := case r.scope
      when 'company' then 'x.company_id = $1'
      when 'invoice' then 'x.invoice_id in (select i.id from public.invoices i where i.company_id = $1)'
      when 'inbound' then 'x.company_id = $1 and coalesce(x.last_error_code, '''') <> ''RECIPIENT_MISMATCH'''
      when 'events' then 'x.company_id = $1 and (x.inbound_id is null or exists (select 1 from public.einvoice_inbound i '
                         || 'where i.id = x.inbound_id and coalesce(i.last_error_code, '''') <> ''RECIPIENT_MISMATCH''))'
    end;
    execute format(
      'select count(*), coalesce(string_agg(h, '''' order by h), '''') from (select md5(to_jsonb(x)::text) h from public.%I x where '
      || v_where || ') s', r.tbl)
      into v_n, v_h using p_company_id;
    v_counts := v_counts || jsonb_build_object(r.tbl, v_n);
    v_parts := v_parts || r.tbl || ':' || v_n::text || ':' || md5(v_h) || ';';
  end loop;
  return jsonb_build_object('fingerprint', encode(sha256(convert_to(v_parts, 'UTF8')), 'hex'), 'counts', v_counts);
end;
$function$;
revoke all on function public.esblu_company_export_fingerprint(uuid) from public, anon, authenticated;
grant execute on function public.esblu_company_export_fingerprint(uuid) to service_role;

-- Beh exportu: odtlačok a počty vypočíta DB pri vzniku behu (pôvodná 6-arg signatúra aj nová s manifestom).
-- p_expected_fingerprint = odtlačok, ktorý server získal PRED čítaním údajov; ak sa medzitým zmenil, export
-- nemusí zodpovedať jednému stavu → ESBLU_EXPORT_DATA_CHANGED (klient export zopakuje).
create or replace function public.esblu_company_export_begin(
  p_user_id uuid,
  p_company_id uuid,
  p_schema_version text,
  p_files_total integer,
  p_file_parts integer,
  p_data_sha256 text,
  p_manifest_sha256 text,
  p_expected_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_fp jsonb;
begin
  perform public.esblu_company_export_assert_owner(p_user_id, p_company_id);
  if p_files_total is null or p_files_total < 0 or p_file_parts is null or p_file_parts < 0
     or (p_files_total = 0) <> (p_file_parts = 0)
     or (p_manifest_sha256 is not null and p_manifest_sha256 !~ '^[0-9a-f]{64}$')
     or (p_expected_fingerprint is not null and p_expected_fingerprint !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_INVALID';
  end if;
  v_fp := public.esblu_company_export_fingerprint(p_company_id);
  if p_expected_fingerprint is not null and p_expected_fingerprint <> v_fp->>'fingerprint' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EXPORT_DATA_CHANGED';
  end if;
  insert into public.company_export_runs
    (company_id, requested_by, status, schema_version, files_total, file_parts, data_sha256, completed_at,
     data_fingerprint, counts, manifest_sha256)
  values (p_company_id, p_user_id,
          case when p_file_parts = 0 then 'completed' else 'in_progress' end,
          p_schema_version, p_files_total, p_file_parts, lower(p_data_sha256),
          case when p_file_parts = 0 then now() end,
          v_fp->>'fingerprint', v_fp->'counts', p_manifest_sha256)
  returning id into v_id;
  return v_id;
end;
$function$;
revoke all on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text, text, text) to service_role;

create or replace function public.esblu_company_export_begin(
  p_user_id uuid,
  p_company_id uuid,
  p_schema_version text,
  p_files_total integer,
  p_file_parts integer,
  p_data_sha256 text
)
returns uuid
language sql
security definer
set search_path = ''
as $function$
  select public.esblu_company_export_begin(p_user_id, p_company_id, p_schema_version, p_files_total, p_file_parts, p_data_sha256, null::text, null::text);
$function$;
revoke all on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text) to service_role;

-- ----------------------------------------------------------------------------- 3. brána ukončenia
create or replace function public.esblu_company_termination_export_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run public.company_export_runs;
  v_fp text;
  v_has_documents boolean;
  v_last_sign_in timestamptz;
begin
  if new.status <> 'executing' then
    return new;
  end if;

  -- O3: firma s finalizovanými dokladmi alebo e-faktúrami nesmie byť vymazaná bez overeného exportu.
  v_has_documents :=
       exists (select 1 from public.invoices i where i.company_id = new.company_id and i.document_status <> 'draft')
    or (to_regclass('public.einvoice_inbound') is not null
        and exists (select 1 from public.einvoice_inbound e where e.company_id = new.company_id
                    and coalesce(e.last_error_code, '') <> 'RECIPIENT_MISMATCH'))
    or (to_regclass('public.einvoice_outbound') is not null
        and exists (select 1 from public.einvoice_outbound o where o.company_id = new.company_id));
  if new.export_mode = 'waived' and v_has_documents
     and coalesce(new.termination_mode, '') <> 'synthetic_test_data_purge' then
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_REQUIRED';
  end if;

  if new.export_mode = 'exported' then
    select * into v_run
    from public.company_export_runs r
    where r.company_id = new.company_id
      and r.requested_by = new.requested_by
      and r.status = 'completed'
      and r.missing_files = 0
      and r.completed_at > now() - interval '24 hours'
    order by r.completed_at desc
    limit 1;
    if v_run.id is null then
      raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_NOT_VERIFIED';
    end if;
    v_fp := public.esblu_company_export_fingerprint(new.company_id)->>'fingerprint';
    if v_run.data_fingerprint is null or v_run.data_fingerprint <> v_fp then
      -- Údaje sa po exporte zmenili (alebo beh nemá odtlačok — starší kód) → nový export.
      raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_STALE';
    end if;
    new.export_run_id := v_run.id;
    new.export_fingerprint := v_fp;
  end if;

  if coalesce(new.termination_mode, '') = 'customer_delete' then
    if new.authority_confirmed is distinct from true
       or new.ack_text_version is null or new.ack_text_sha256 is null
       or new.confirmed_at is null
       or new.confirmed_at < now() - interval '15 minutes'
       or new.confirmed_at > now() + interval '1 minute' then
      raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_ACK_REQUIRED';
    end if;
    select u.last_sign_in_at into v_last_sign_in from auth.users u where u.id = new.requested_by;
    if v_last_sign_in is null or v_last_sign_in < now() - interval '30 minutes' then
      raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_REAUTH_REQUIRED';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_company_termination_export_gate() from public, anon, authenticated;

drop trigger if exists esblu_company_termination_export_gate on public.company_terminations;
create trigger esblu_company_termination_export_gate
  before insert on public.company_terminations
  for each row execute function public.esblu_company_termination_export_gate();

-- ----------------------------------------------------------------------------- 4. výmaz bez archívu
create or replace function public.esblu_company_termination_execute(
  p_user_id uuid,
  p_company_id uuid,
  p_delete_account boolean,
  p_export_mode text,
  p_ack jsonb
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
  v_files jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_res jsonb;
  v_job uuid;
  v_targets jsonb;
  v_job_storage text;
begin
  if p_user_id is null or p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_ACCOUNT_DELETION_INVALID_REQUEST';
  end if;
  if p_export_mode is null or p_export_mode not in ('exported', 'waived') then
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_NOT_CONFIRMED';
  end if;
  if p_ack is null or jsonb_typeof(p_ack) <> 'object' then
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_ACK_REQUIRED';
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
        'termination_mode', v_done.termination_mode
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

  -- Brána (trigger) overí export, odtlačok dát, potvrdenie oprávnenej osoby a čerstvé prihlásenie.
  insert into public.company_terminations
    (company_id, requested_by, status, export_mode, termination_mode,
     ack_text_version, ack_text_sha256, authority_confirmed, confirmed_at, request_ip_sha256, user_agent_sha256)
  values (p_company_id, p_user_id, 'executing', p_export_mode, 'customer_delete',
          p_ack->>'text_version', lower(p_ack->>'text_sha256'),
          case when jsonb_typeof(p_ack->'authority_confirmed') = 'boolean' then (p_ack->>'authority_confirmed')::boolean end,
          nullif(p_ack->>'confirmed_at', '')::timestamptz,
          lower(nullif(p_ack->>'ip_sha256', '')), lower(nullif(p_ack->>'user_agent_sha256', '')))
  returning id into v_tid;
  perform set_config('esblu.company_termination_id', v_tid::text, true);

  -- Súbory e-faktúr firmy (vrátane PDF prijatých e-faktúr) idú do výmazu — žiadny archív.
  select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', 'einvoice-documents', 'path', x.p)), '[]'::jsonb)
  into v_files
  from (
    select i.xml_storage_path as p from public.einvoice_inbound i where i.company_id = p_company_id and i.xml_storage_path is not null
    union all
    select i.pdf_storage_path from public.einvoice_inbound i where i.company_id = p_company_id and i.pdf_storage_path is not null
    union all
    select o.ubl_storage_path from public.einvoice_outbound o where o.company_id = p_company_id and o.ubl_storage_path is not null
  ) x;

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

  -- Ciele výmazu: zber firmy + súbory e-faktúr; nikdy účtovné kópie Esblu (billing-documents).
  select coalesce(jsonb_agg(distinct x.value), '[]'::jsonb) into v_targets
  from jsonb_array_elements(coalesce(v_res->'storage_targets', '[]'::jsonb) || v_files) x
  where coalesce(x.value->>'bucket', '') <> 'billing-documents';

  if v_job is not null and v_targets is distinct from coalesce(v_res->'storage_targets', '[]'::jsonb) then
    update public.account_deletion_cleanup_jobs
       set storage_targets = v_targets,
           storage_target_count = jsonb_array_length(v_targets),
           storage_status = case when jsonb_array_length(v_targets) = 0 then 'done' else 'pending' end,
           completed_at = case when jsonb_array_length(v_targets) = 0 and auth_status = 'done'
                               then coalesce(completed_at, now()) end
     where id = v_job;
  end if;
  select j.storage_status into v_job_storage from public.account_deletion_cleanup_jobs j where j.id = v_job;

  update public.company_terminations
     set status = 'completed',
         completed_at = now(),
         cleanup_job_id = v_job,
         storage_target_count = jsonb_array_length(v_targets),
         deleted_counts = v_counts || coalesce(v_res->'summary'->'deleted_counts', '{}'::jsonb),
         storage_purged_at = case when jsonb_array_length(v_targets) = 0 or v_job_storage = 'done' then now() end
   where id = v_tid;

  perform set_config('esblu.company_termination_id', '', true);

  return jsonb_set(v_res, '{storage_targets}', v_targets)
    || jsonb_build_object('termination_id', v_tid, 'termination_mode', 'customer_delete');
end;
$function$;
revoke all on function public.esblu_company_termination_execute(uuid, uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_company_termination_execute(uuid, uuid, boolean, text, jsonb) to service_role;

-- Predbežná kontrola BEZ zmeny údajov (route ju volá PRED nevratnými krokmi mimo DB, napr. deregistráciou
-- u poskytovateľa e-Faktúry). Použije presne tú istú bránu: skúšobný INSERT v podtransakcii, ktorá sa vždy vráti.
-- Vráti null = výmaz by prešiel, inak kód ESBLU_*.
create or replace function public.esblu_company_termination_preflight(
  p_user_id uuid,
  p_company_id uuid,
  p_export_mode text,
  p_ack jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_code text;
begin
  if p_user_id is null or p_company_id is null then
    return 'ESBLU_ACCOUNT_DELETION_INVALID_REQUEST';
  end if;
  if p_export_mode is null or p_export_mode not in ('exported', 'waived') then
    return 'ESBLU_TERMINATION_EXPORT_NOT_CONFIRMED';
  end if;
  if p_ack is null or jsonb_typeof(p_ack) <> 'object' then
    return 'ESBLU_TERMINATION_ACK_REQUIRED';
  end if;
  if not exists (
    select 1 from public.company_members cm join public.companies c on c.id = cm.company_id
    where cm.user_id = p_user_id and cm.company_id = p_company_id and cm.status = 'active' and cm.role = 'owner'
      and c.owner_id = p_user_id
  ) then
    return 'ESBLU_NOT_ACTIVE_OWNER';
  end if;
  begin
    insert into public.company_terminations
      (company_id, requested_by, status, export_mode, termination_mode,
       ack_text_version, ack_text_sha256, authority_confirmed, confirmed_at)
    values (p_company_id, p_user_id, 'executing', p_export_mode, 'customer_delete',
            p_ack->>'text_version', lower(p_ack->>'text_sha256'),
            case when jsonb_typeof(p_ack->'authority_confirmed') = 'boolean' then (p_ack->>'authority_confirmed')::boolean end,
            nullif(p_ack->>'confirmed_at', '')::timestamptz);
    raise exception using errcode = 'P0001', message = 'ESBLU_PREFLIGHT_OK';
  exception
    when others then
      v_code := sqlerrm;
  end;
  if v_code = 'ESBLU_PREFLIGHT_OK' then
    return null;
  end if;
  if v_code like 'ESBLU\_%' then
    return v_code;
  end if;
  return 'ESBLU_TERMINATION_ACK_REQUIRED'; -- napr. neplatný formát potvrdenia (constraint)
end;
$function$;
revoke all on function public.esblu_company_termination_preflight(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_company_termination_preflight(uuid, uuid, text, jsonb) to service_role;

-- Pôvodná cesta bez potvrdenia oprávnenej osoby už nie je dovolená (fail closed počas nasadzovania).
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
  raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_ACK_REQUIRED';
end;
$function$;
revoke all on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) to service_role;
comment on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) is
  'Od 20261127100000 nahradené esblu_company_termination_execute (potvrdenie oprávnenej osoby, bez archívu).';

-- ----------------------------------------------------------------------------- 5. cleanup: iba billing-documents
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
  -- Účtovné kópie Esblu (vlastná zákonná povinnosť Esblu) nikdy nie sú cieľom výmazu zákazníckych údajov.
  select coalesce(jsonb_agg(x.value order by x.ord), '[]'::jsonb) into v_clean
  from jsonb_array_elements(new.storage_targets) with ordinality x(value, ord)
  where coalesce(x.value->>'bucket', '') <> 'billing-documents';
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

-- ----------------------------------------------------------------------------- 6. dôkaz výmazu súborov
create or replace function public.esblu_company_termination_storage_purged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.storage_status = 'done' and old.storage_status is distinct from 'done' then
    update public.company_terminations t
       set storage_purged_at = coalesce(t.storage_purged_at, now())
     where t.cleanup_job_id = new.id;
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_company_termination_storage_purged() from public, anon, authenticated, service_role;

drop trigger if exists esblu_company_termination_storage_purged on public.account_deletion_cleanup_jobs;
create trigger esblu_company_termination_storage_purged
  after update of storage_status on public.account_deletion_cleanup_jobs
  for each row execute function public.esblu_company_termination_storage_purged();

commit;
