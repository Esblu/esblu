-- =============================================================================
-- Ukončenie firmy s účtovnými dokladmi — auditovaný termination workflow
-- (VOP 1.2 čl. 20.2 / 20.6, DPA: vrátenie alebo výmaz po skončení služieb)
-- =============================================================================
-- Problém: samoobslužné zrušenie firmy je blokované (ESBLU_ACCOUNTING_RECORDS_
-- BLOCK_DELETION) a ochranné triggery finalizovaných dokladov by výmaz zastavili
-- aj servisne. Riešenie BEZ globálneho bypassu:
--
-- 1. company_terminations — auditný záznam (bez FK, prežije výmaz firmy; iba
--    identifikátory, stav, režim exportu, agregované počty, kód chyby).
-- 2. esblu_company_termination_in_progress() — true IBA vo vnútri transakcie
--    esblu_company_termination_commit: transakčne lokálne nastavenie
--    esblu.company_termination_id + riadok so stavom 'executing', ktorý sa
--    nikdy necommitne (pred koncom transakcie prejde na 'completed'). Iná
--    session ho nevidí → nastavenie GUC zvonka nič neodomkne.
-- 3. Ochranné triggery (7 funkcií) povoľujú DELETE iba počas (2). INSERT /
--    UPDATE finalizovaných dokladov ostávajú zakázané vždy. Retenčné triggery
--    documents / ai_evidence už pustia iba service_role (bez zmeny).
-- 4. esblu_company_termination_commit (service_role only; route overí owner
--    session, potvrdenie a export): JEDNA transakcia — zámok firmy, kontrola
--    owner + owner_id, registrácia u eFaktúra providera = stop, zber ciest XML,
--    výmaz e-faktúr a dokladov v poradí FK, potom existujúci
--    esblu_account_deletion_commit('owner', …) (zber Storage ciest, výmaz
--    firmy, cleanup job). Chyba kdekoľvek = rollback celku (žiadny partial
--    delete). Storage sa maže až PO commite z cleanup jobu (retry/cron).
-- 5. Idempotencia: opakované / súbežné spustenie po úspechu vráti
--    already_completed (zámok riadku firmy serializuje súbežné volania).
-- Žiadny automatický purge, žiadny klientský EXECUTE.
-- Rollback: supabase/rollback/20261112110000_company_termination_workflow_rollback.sql
-- =============================================================================

-- ----------------------------------------------------------------------------- 1
create table if not exists public.company_terminations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  requested_by uuid not null,
  status text not null,
  export_mode text null,
  error_code text null,
  deleted_counts jsonb not null default '{}'::jsonb,
  storage_target_count integer null,
  cleanup_job_id uuid null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint company_terminations_status_check check (status in ('executing', 'completed', 'failed')),
  constraint company_terminations_export_mode_check check (export_mode is null or export_mode in ('exported', 'waived')),
  constraint company_terminations_error_code_check check (error_code is null or error_code ~ '^[A-Za-z0-9_:.-]{1,120}$')
);

create unique index if not exists company_terminations_one_completed
  on public.company_terminations (company_id) where status = 'completed';
create index if not exists company_terminations_company_idx on public.company_terminations (company_id, created_at desc);

comment on table public.company_terminations is
  'VOP 20.6 / DPA: auditný záznam ukončenia firmy s účtovnými dokladmi (bez FK — prežije výmaz firmy). '
  'Iba identifikátory, stav, režim exportu (exported / waived), agregované počty a kód chyby; žiadny obsah. '
  'Zápis iba cez esblu_company_termination_commit / _record_failure (service_role). Retencia: 5 rokov '
  '(ako dôkaz zmluvného vzťahu) — mazanie doplniť do retenčnej purge pri jej aktivácii.';

alter table public.company_terminations enable row level security;
revoke all on table public.company_terminations from public, anon, authenticated;
grant select on table public.company_terminations to service_role;

-- ----------------------------------------------------------------------------- 2
create or replace function public.esblu_company_termination_in_progress()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_raw text := current_setting('esblu.company_termination_id', true);
begin
  if v_raw is null or v_raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1 from public.company_terminations t
    where t.id = v_raw::uuid and t.status = 'executing'
  );
end;
$function$;

comment on function public.esblu_company_termination_in_progress() is
  'True iba vo vnútri transakcie esblu_company_termination_commit (GUC + necommitnutý riadok executing). '
  'Ochranné triggery finalizovaných dokladov podľa toho povolia DELETE — žiadny globálny bypass.';

revoke all on function public.esblu_company_termination_in_progress() from public, anon;
grant execute on function public.esblu_company_termination_in_progress() to authenticated, service_role;

-- ----------------------------------------------------------------------------- 3
create or replace function public.esblu_block_finalized_invoice_delete()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  -- Termination workflow (20261112110000): iba vo vnútri auditovanej transakcie.
  if public.esblu_company_termination_in_progress() then
    return OLD;
  end if;
  if OLD.document_status = 'finalized' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_FINALIZED_NO_DELETE',
      hint = 'Finalizovaná faktúra sa nikdy nemaže — oprava ide výhradne cez credit_note/debit_note.';
  end if;
  return OLD;
end;
$function$;

create or replace function public.esblu_block_finalized_invoice_items_mutation()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_invoice_id uuid;
  v_status text;
begin
  if TG_OP = 'DELETE' and public.esblu_company_termination_in_progress() then
    return OLD;
  end if;

  v_invoice_id := coalesce(NEW.invoice_id, OLD.invoice_id);

  select i.document_status into v_status
  from public.invoices i
  where i.id = v_invoice_id;

  if v_status = 'finalized' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_ITEMS_FINALIZED_IMMUTABLE',
      hint = 'Riadky finalizovanej faktúry sa nedajú meniť — oprava ide cez samostatný credit_note/debit_note.';
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$function$;

create or replace function public.esblu_block_invoice_snapshot_mutation()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' and public.esblu_company_termination_in_progress() then
    return old;
  end if;
  -- Nemenné, keď patria FINALIZOVANEJ faktúre. Koncept (napr. prijatá e-faktúra
  -- s rozpisom DPH z XML) ich smie mať a finalizácia ich prepíše; pri kaskádovom
  -- zmazaní konceptu už rodič neexistuje. Klient nemá na tieto tabuľky DML.
  if exists (
    select 1 from public.invoices i
    where i.id = old.invoice_id and i.document_status = 'finalized'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_SNAPSHOT_IMMUTABLE',
      hint = 'invoice_parties/invoice_tax_breakdowns finalizovanej faktúry sa nikdy needitujú ani nemažú.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

create or replace function public.esblu_block_finalized_advance_deductions()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare
  v_status text;
begin
  if tg_op = 'DELETE' and public.esblu_company_termination_in_progress() then
    return old;
  end if;
  select i.document_status into v_status from public.invoices i where i.id = coalesce(new.invoice_id, old.invoice_id);
  if v_status = 'finalized' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_FINALIZED_IMMUTABLE';
  end if;
  return coalesce(new, old);
end;
$function$;

create or replace function public.esblu_invoice_events_append_only()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' and public.esblu_company_termination_in_progress() then
    return old;
  end if;
  raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_EVENTS_APPEND_ONLY';
end;
$function$;

create or replace function public.esblu_einvoice_events_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.outbound_id is not null and not exists (
      select 1 from public.einvoice_outbound o where o.id = new.outbound_id and o.company_id = new.company_id
    ) then
      raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_COMPANY_MISMATCH';
    end if;
    if new.inbound_id is not null and not exists (
      select 1 from public.einvoice_inbound i where i.id = new.inbound_id and i.company_id = new.company_id
    ) then
      raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_COMPANY_MISMATCH';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' and (pg_trigger_depth() > 1 or public.esblu_company_termination_in_progress()) then
    return old;
  end if;

  raise exception using errcode = '42501', message = 'ESBLU_EINVOICE_EVENTS_APPEND_ONLY';
end;
$function$;

create or replace function public.esblu_received_advance_link_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype;
  v_a public.invoices%rowtype;
  v_b record;
  v_ded numeric;
  v_used_t numeric;
  v_used_v numeric;
  v_final_t numeric;
begin
  if tg_op = 'DELETE' then
    if public.esblu_company_termination_in_progress() then
      return old;
    end if;
    if exists (select 1 from public.invoices f where f.id = old.invoice_id and f.document_status = 'finalized') then
      raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_LINK_LOCKED';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_LINK_LOCKED',
      hint = 'Väzba sa nemení — odoberie sa a priradí znova.';
  end if;

  select * into v_f from public.invoices f where f.id = new.invoice_id for update;
  if v_f.id is null or v_f.company_id <> new.company_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_f.direction <> 'received' or v_f.kind <> 'regular_invoice' or v_f.advance_review_status is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_TARGET_INVALID';
  end if;
  if v_f.document_status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_LINK_LOCKED';
  end if;
  -- Zámok zálohy: súbežné priradenie tej istej zálohy dvom faktúram sa serializuje.
  select * into v_a from public.invoices a where a.id = new.advance_invoice_id for update;
  -- Iná firma = „neexistuje“ (žiadny únik existencie cudzieho dokladu).
  if v_a.id is null or v_a.company_id <> v_f.company_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_NOT_FOUND';
  end if;
  if v_a.direction <> 'received' or v_a.kind <> 'payment_received_invoice' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_KIND_INVALID';
  end if;
  if v_a.supplier_business_partner_id is distinct from v_f.supplier_business_partner_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_SUPPLIER_MISMATCH';
  end if;
  if v_a.currency <> v_f.currency then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_CURRENCY_MISMATCH';
  end if;
  if new.vat_category_code is null or new.vat_rate is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_RATE_MISMATCH';
  end if;
  -- Sadzba musí byť na zálohe aj na mínusovom riadku konečnej faktúry.
  select b.taxable_amount, b.vat_amount into v_b from public.invoice_tax_breakdowns b
  where b.invoice_id = v_a.id and b.vat_category_code = new.vat_category_code and b.vat_rate = new.vat_rate;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_RATE_MISMATCH';
  end if;
  select g.taxable into v_ded from public.esblu_received_deduction_groups(v_f.id) g
  where g.vat_category_code = new.vat_category_code and g.vat_rate = new.vat_rate;
  if v_ded is null or v_ded <= 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_RATE_MISMATCH';
  end if;
  if new.taxable_amount is null or new.taxable_amount <= 0 or new.taxable_amount <> round(new.taxable_amount, 2) then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_AMOUNT_INVALID';
  end if;
  if new.vat_amount is null then
    new.vat_amount := case when new.taxable_amount = v_b.taxable_amount then v_b.vat_amount
                           else round(v_b.vat_amount * new.taxable_amount / v_b.taxable_amount, 2) end;
  end if;
  -- Dvojitý odpočet: súčet na zálohe (po sadzbe) nesmie prekročiť základ ani DPH zálohy.
  select coalesce(sum(l.taxable_amount), 0), coalesce(sum(l.vat_amount), 0) into v_used_t, v_used_v
  from public.received_advance_links l
  where l.advance_invoice_id = v_a.id and l.id is distinct from new.id
    and (l.vat_category_code is null or (l.vat_category_code = new.vat_category_code and l.vat_rate = new.vat_rate));
  if v_used_t + new.taxable_amount > v_b.taxable_amount or v_used_v + new.vat_amount > v_b.vat_amount then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_EXCEEDS',
      hint = 'Záloha je už odpočítaná (celá alebo čiastočne) na inej faktúre.';
  end if;
  select coalesce(sum(l.taxable_amount), 0) into v_final_t from public.received_advance_links l
  where l.invoice_id = v_f.id and l.vat_category_code = new.vat_category_code and l.vat_rate = new.vat_rate
    and l.advance_invoice_id <> v_a.id;
  if v_final_t + new.taxable_amount > v_ded then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_EXCEEDS_PREPAID',
      hint = 'Súčet priradených záloh nesmie prekročiť odpočet v mínusových riadkoch faktúry.';
  end if;
  new.amount := new.taxable_amount + new.vat_amount;
  return new;
end;
$function$;

-- Triggerové funkcie: žiadny klientský EXECUTE (trigger ho nepotrebuje) — rovnako ako hardening 20260916100000 / 20260920123000.
revoke all on function public.esblu_block_finalized_invoice_delete() from public, anon, authenticated;
revoke all on function public.esblu_block_finalized_invoice_items_mutation() from public, anon, authenticated;
revoke all on function public.esblu_block_invoice_snapshot_mutation() from public, anon, authenticated;
revoke all on function public.esblu_block_finalized_advance_deductions() from public, anon, authenticated;
revoke all on function public.esblu_invoice_events_append_only() from public, anon, authenticated;
revoke all on function public.esblu_einvoice_events_guard() from public, anon, authenticated;
revoke all on function public.esblu_received_advance_link_guard() from public, anon, authenticated;

-- ----------------------------------------------------------------------------- 4
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
begin
  if p_user_id is null or p_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_ACCOUNT_DELETION_INVALID_REQUEST';
  end if;
  if p_export_mode is null or p_export_mode not in ('exported', 'waived') then
    raise exception using errcode = 'P0001', message = 'ESBLU_TERMINATION_EXPORT_NOT_CONFIRMED';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    select * into v_done from public.company_terminations t
    where t.company_id = p_company_id and t.requested_by = p_user_id and t.status = 'completed'
    order by t.completed_at desc limit 1;
    if v_done.id is not null then
      return jsonb_build_object(
        'already_completed', true, 'termination_id', v_done.id, 'job_id', v_done.cleanup_job_id,
        'storage_targets', '[]'::jsonb, 'summary', null, 'delete_account', false
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

  insert into public.company_terminations (company_id, requested_by, status, export_mode)
  values (p_company_id, p_user_id, 'executing', p_export_mode)
  returning id into v_tid;
  perform set_config('esblu.company_termination_id', v_tid::text, true);

  select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', 'einvoice-documents', 'path', x.p)), '[]'::jsonb)
  into v_xml
  from (
    select i.xml_storage_path as p from public.einvoice_inbound i where i.company_id = p_company_id and i.xml_storage_path is not null
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

  select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into v_targets
  from jsonb_array_elements(coalesce(v_res->'storage_targets', '[]'::jsonb) || v_xml) x;

  if jsonb_array_length(v_xml) > 0 and v_job is not null then
    update public.account_deletion_cleanup_jobs
       set storage_targets = v_targets,
           storage_target_count = jsonb_array_length(v_targets),
           storage_status = 'pending',
           completed_at = null
     where id = v_job;
  end if;

  update public.company_terminations
     set status = 'completed',
         completed_at = now(),
         cleanup_job_id = v_job,
         storage_target_count = jsonb_array_length(v_targets),
         deleted_counts = v_counts || coalesce(v_res->'summary'->'deleted_counts', '{}'::jsonb)
   where id = v_tid;

  perform set_config('esblu.company_termination_id', '', true);

  return jsonb_set(v_res, '{storage_targets}', v_targets) || jsonb_build_object('termination_id', v_tid);
end;
$function$;

comment on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) is
  'VOP 20.6 / DPA (service_role only): ukončenie firmy vrátane finalizovaných dokladov a e-faktúr v JEDNEJ '
  'transakcii po potvrdení Vlastníka a exporte (exported) alebo výslovnom vzdaní sa exportu (waived). '
  'Storage sa maže až po commite z cleanup jobu. Idempotentné (already_completed).';

revoke all on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.esblu_company_termination_commit(uuid, uuid, boolean, text) to service_role;

create or replace function public.esblu_company_termination_record_failure(
  p_user_id uuid,
  p_company_id uuid,
  p_export_mode text,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_user_id is null or p_company_id is null then
    return;
  end if;
  insert into public.company_terminations (company_id, requested_by, status, export_mode, error_code, completed_at)
  values (
    p_company_id, p_user_id, 'failed',
    case when p_export_mode in ('exported', 'waived') then p_export_mode end,
    case when p_error_code ~ '^[A-Za-z0-9_:.-]{1,120}$' then p_error_code else 'ESBLU_TERMINATION_FAILED' end,
    now()
  );
end;
$function$;

revoke all on function public.esblu_company_termination_record_failure(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.esblu_company_termination_record_failure(uuid, uuid, text, text) to service_role;
