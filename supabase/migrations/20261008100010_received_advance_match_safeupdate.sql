-- =============================================================================
-- 20261008100010 — oprava esblu_received_advance_match: DELETE nad dočasnými tabuľkami s WHERE.
--
-- Supabase načítava pre spojenia PostgREST rozšírenie pg_safeupdate, ktoré odmietne DELETE bez WHERE
-- („DELETE requires a WHERE clause“, SQLSTATE 21000). V PGlite ani pod rolou postgres sa to neprejaví.
-- Zistené v reálnom sandbox E2E (7. 10. 2026): faktúra k prijatej platbe doručená PO konečnej faktúre
-- spustila dodatočné párovanie → create_draft zlyhal (DRAFT_CREATE_FAILED). Zmena: iba dva riadky
-- „delete from pg_temp.… where true“; logika párovania je totožná s 20261008100009.
--
-- ROLLBACK: supabase/rollback/20261008100010_received_advance_match_safeupdate_rollback.sql
-- =============================================================================

-- Párovanie mínusových riadkov na prijaté 386 (iba koncept v review bez väzieb).
create or replace function public.esblu_received_advance_match(p_invoice_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype;
  v_ref jsonb;
  v_num text;
  v_date date;
  v_cands uuid[];
  v_found uuid[] := array[]::uuid[];
  v_reasons text[] := array[]::text[];
  v_line record;
  v_pick uuid;
  v_n integer;
  v_exact integer;
  v_has_rate boolean;
  v_vat numeric;
  v_status text;
  v_a public.invoices%rowtype;
begin
  select * into v_f from public.invoices f where f.id = p_invoice_id for update;
  if v_f.id is null or v_f.direction <> 'received' or v_f.kind <> 'regular_invoice' or v_f.document_status <> 'draft'
     or v_f.advance_review_status is distinct from 'review'
     or exists (select 1 from public.received_advance_links l where l.invoice_id = v_f.id)
     or not exists (select 1 from public.invoice_items it where it.invoice_id = v_f.id and it.is_advance_deduction) then
    return v_f.advance_review_status;
  end if;

  if v_f.advance_references is null or jsonb_array_length(v_f.advance_references) = 0 then
    v_reasons := array_append(v_reasons, 'ADVANCE_REFERENCE_MISSING');
  else
    for v_ref in select r from jsonb_array_elements(v_f.advance_references) r
    loop
      v_num := upper(regexp_replace(coalesce(v_ref ->> 'number', ''), '[\s\-/]', '', 'g'));
      v_date := case when coalesce(v_ref ->> 'issue_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then (v_ref ->> 'issue_date')::date end;
      if v_num = '' then
        continue;
      end if;
      select coalesce(array_agg(a.id order by a.created_at), array[]::uuid[]) into v_cands
      from public.invoices a
      where a.company_id = v_f.company_id and a.direction = 'received' and a.kind = 'payment_received_invoice'
        and a.supplier_business_partner_id = v_f.supplier_business_partner_id
        and upper(regexp_replace(coalesce(a.supplier_invoice_number, ''), '[\s\-/]', '', 'g')) = v_num
        and (v_date is null or a.issue_date = v_date);
      if cardinality(v_cands) = 0 then
        if exists (select 1 from public.invoices a
                   where a.company_id = v_f.company_id and a.direction = 'received' and a.kind = 'payment_received_invoice'
                     and a.supplier_business_partner_id is distinct from v_f.supplier_business_partner_id
                     and upper(regexp_replace(coalesce(a.supplier_invoice_number, ''), '[\s\-/]', '', 'g')) = v_num) then
          v_reasons := array_append(v_reasons, 'ADVANCE_SUPPLIER_MISMATCH');
        else
          v_reasons := array_append(v_reasons, 'ADVANCE_NOT_FOUND');
        end if;
      elsif cardinality(v_cands) > 1 then
        v_reasons := array_append(v_reasons, 'ADVANCE_AMBIGUOUS');
      elsif not (v_cands[1] = any (v_found)) then
        select * into v_a from public.invoices a where a.id = v_cands[1];
        if v_a.currency <> v_f.currency then
          v_reasons := array_append(v_reasons, 'ADVANCE_CURRENCY_MISMATCH');
        else
          v_found := array_append(v_found, v_a.id);
        end if;
      end if;
    end loop;
    if cardinality(v_found) = 0 and cardinality(v_reasons) = 0 then
      v_reasons := array_append(v_reasons, 'ADVANCE_REFERENCE_MISSING');
    end if;
  end if;

  if cardinality(v_reasons) = 0 then
    -- Zostatok základu každej nájdenej zálohy po (kategória, sadzba); väzby iných faktúr sa odpočítajú.
    create temporary table if not exists esblu_adv_rem (
      advance_id uuid, cat text, rate numeric, taxable numeric, vat numeric, remaining numeric
    ) on commit drop;
    delete from pg_temp.esblu_adv_rem where true;  -- pg_safeupdate (PostgREST): DELETE vyžaduje WHERE
    create temporary table if not exists esblu_adv_pick (
      advance_id uuid, cat text, rate numeric, taxable numeric, vat numeric
    ) on commit drop;
    delete from pg_temp.esblu_adv_pick where true;
    insert into pg_temp.esblu_adv_rem
    select b.invoice_id, b.vat_category_code, b.vat_rate, b.taxable_amount, b.vat_amount,
           b.taxable_amount - coalesce((select sum(l.taxable_amount) from public.received_advance_links l
                                        where l.advance_invoice_id = b.invoice_id and l.invoice_id <> v_f.id
                                          and (l.vat_category_code is null
                                               or (l.vat_category_code = b.vat_category_code and l.vat_rate = b.vat_rate))), 0)
    from public.invoice_tax_breakdowns b where b.invoice_id = any (v_found);

    for v_line in
      select it.position, it.vat_category_code as cat,
             (case when it.vat_category_code = 'S' then it.vat_rate else 0 end)::numeric as rate,
             -it.line_net_amount as base, -it.line_vat_amount as line_vat
      from public.invoice_items it
      where it.invoice_id = v_f.id and it.is_advance_deduction
      order by it.position
    loop
      select count(*), count(*) filter (where r.remaining = v_line.base) into v_n, v_exact
      from pg_temp.esblu_adv_rem r where r.cat = v_line.cat and r.rate = v_line.rate and r.remaining >= v_line.base;
      if v_exact = 1 then
        select r.advance_id into v_pick from pg_temp.esblu_adv_rem r
        where r.cat = v_line.cat and r.rate = v_line.rate and r.remaining = v_line.base;
      elsif v_n = 1 then
        select r.advance_id into v_pick from pg_temp.esblu_adv_rem r
        where r.cat = v_line.cat and r.rate = v_line.rate and r.remaining >= v_line.base;
      elsif v_n = 0 then
        select exists (select 1 from pg_temp.esblu_adv_rem r where r.cat = v_line.cat and r.rate = v_line.rate) into v_has_rate;
        v_reasons := array_append(v_reasons, case when v_has_rate then 'ADVANCE_ALREADY_DEDUCTED' else 'ADVANCE_RATE_MISMATCH' end);
        continue;
      else
        v_reasons := array_append(v_reasons, 'ADVANCE_AMBIGUOUS');
        continue;
      end if;
      -- DPH odpočtu: celá záloha v tejto sadzbe → DPH zálohy; inak pomerne. Musí sedieť s DPH riadka (± 0,01).
      select case when r.remaining = r.taxable and v_line.base = r.taxable then r.vat
                  else round(r.vat * v_line.base / r.taxable, 2) end
        into v_vat
      from pg_temp.esblu_adv_rem r where r.advance_id = v_pick and r.cat = v_line.cat and r.rate = v_line.rate;
      if abs(v_vat - v_line.line_vat) > 0.01 then
        v_reasons := array_append(v_reasons, 'ADVANCE_VAT_MISMATCH');
      end if;
      update pg_temp.esblu_adv_rem r set remaining = r.remaining - v_line.base
      where r.advance_id = v_pick and r.cat = v_line.cat and r.rate = v_line.rate;
      insert into pg_temp.esblu_adv_pick values (v_pick, v_line.cat, v_line.rate, v_line.base, v_vat);
    end loop;
  end if;

  v_reasons := array(select r from unnest(v_reasons) with ordinality u(r, o) group by r order by min(o));

  if cardinality(v_reasons) = 0 then
    insert into public.received_advance_links (company_id, invoice_id, advance_invoice_id, vat_category_code, vat_rate,
                                               amount, taxable_amount, vat_amount, source, created_by)
    select v_f.company_id, v_f.id, p.advance_id, p.cat, p.rate, 0, sum(p.taxable), sum(p.vat), 'auto', null
    from pg_temp.esblu_adv_pick p group by p.advance_id, p.cat, p.rate;
    v_status := 'proposed';
  else
    v_status := 'review';
  end if;
  update public.invoices i
  set advance_review_status = v_status, advance_review_reasons = v_reasons, updated_at = now()
  where i.id = v_f.id;
  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (v_f.id, 'advance_reviewed', null, 'system',
          jsonb_build_object('action', case when v_status = 'proposed' then 'auto_proposed' else 'needs_review' end,
                             'reasons', to_jsonb(v_reasons), 'advance_invoice_ids', to_jsonb(v_found)));
  return v_status;
end;
$function$;
revoke all on function public.esblu_received_advance_match(uuid) from public, anon, authenticated;
