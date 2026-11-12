-- Rollback 20261112110000_company_termination_workflow.sql
-- Ochranné triggery sa vrátia do pôvodného stavu (bez termination výnimky).
-- Auditné záznamy ukončenia sa NEMAŽÚ: ak existujú, tabuľka ostáva (fail closed).

create or replace function public.esblu_block_finalized_invoice_delete()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
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

  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
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

drop function if exists public.esblu_company_termination_commit(uuid, uuid, boolean, text);
drop function if exists public.esblu_company_termination_record_failure(uuid, uuid, text, text);
drop function if exists public.esblu_company_termination_in_progress();

do $$
begin
  if exists (select 1 from public.company_terminations) then
    raise notice 'company_terminations obsahuje auditné záznamy — tabuľka sa ponecháva';
  else
    drop table public.company_terminations;
  end if;
end $$;
