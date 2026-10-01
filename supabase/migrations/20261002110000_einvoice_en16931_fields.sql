-- =============================================================================
-- E-Faktúra — doplnenie EN16931 / Peppol polí do existujúceho modelu (Phase B).
-- NEAPLIKOVANÉ. Iba lokálne / testovací branch. Nikdy `supabase db push`.
-- Pôvodne 20261001110000; prečíslované za 20261002100000_einvoice_foundation
-- (audit 2026-10-01). Obsah bez zmeny.
--
-- Čo sa mení:
--   1. Kategórie DPH K (intrakomunitárne dodanie), G (vývoz mimo EÚ) a
--      O (mimo predmetu DPH — typicky neplatiteľ DPH) na invoice_items aj
--      invoice_tax_breakdowns. Finalizácia ich počíta ako 0 % (esblu_finalize_
--      invoice berie sadzbu iba pre S) — bez zmeny finalizácie.
--      esblu_create_received_invoice_draft ich ZATIAĽ neprijíma (ostáva
--      S/Z/E/AE) — príjem cez Peppol príde samostatne.
--   2. company_billing_profile.vat_payer_status — príznak platiteľa DPH ako
--      ho zadal používateľ. Právnym zdrojom pre UBL ostáva nemenný snapshot
--      faktúry (BT-31 = vat_identifier / ic_dph predávajúceho); príznak slúži
--      na kontrolu a predvyplnenie, nikdy nie na tichú opravu dokladu.
--   3. invoice_items.unit_code — formát UN/ECE Rec 20/21 (NOT VALID: staré
--      riadky sa nekontrolujú, nové áno).
--   4. esblu_save_invoice_draft — zapisuje aj BT-72 (delivery_date), BT-10
--      (buyer_reference), BT-13 (purchase_order_reference), BT-81
--      (payment_means_code), BT-83 (payment_reference) a riadkový unit_code.
--      Stále SECURITY INVOKER (RLS volajúceho) a iba pre draft — finalizovaná
--      faktúra ostáva nemenná (trigger 20260920150000 bez zmeny).
--
-- ROLLBACK: vrátiť CHECK na ('S','Z','E','AE') (iba ak neexistujú riadky K/G/O),
--   drop column company_billing_profile.vat_payer_status,
--   drop constraint invoice_items_unit_code_format,
--   esblu_save_invoice_draft z 20260929100000.
-- =============================================================================

begin;

-- 1) Kategórie DPH ------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass::text as tbl, c.conname
    from pg_constraint c
    where c.conrelid in ('public.invoice_items'::regclass, 'public.invoice_tax_breakdowns'::regclass)
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%vat_category_code%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table public.invoice_items add constraint invoice_items_vat_category_code_check
  check (vat_category_code in ('S', 'Z', 'E', 'AE', 'K', 'G', 'O'));
alter table public.invoice_tax_breakdowns add constraint invoice_tax_breakdowns_vat_category_code_check
  check (vat_category_code in ('S', 'Z', 'E', 'AE', 'K', 'G', 'O'));

-- 2) Príznak platiteľa DPH ------------------------------------------------------
alter table public.company_billing_profile
  add column if not exists vat_payer_status text;
alter table public.company_billing_profile
  drop constraint if exists company_billing_profile_vat_payer_status_check;
alter table public.company_billing_profile
  add constraint company_billing_profile_vat_payer_status_check
  check (vat_payer_status is null or vat_payer_status in ('vat_payer', 'non_vat_payer'));
comment on column public.company_billing_profile.vat_payer_status is
  'Platiteľ DPH podľa používateľa (vat_payer / non_vat_payer). Iba kontrola a predvyplnenie — UBL sa riadi nemenným snapshotom faktúry (BT-31).';

-- 3) unit_code formát -------------------------------------------------------------
alter table public.invoice_items drop constraint if exists invoice_items_unit_code_format;
alter table public.invoice_items add constraint invoice_items_unit_code_format
  check (unit_code is null or unit_code ~ '^[A-Z0-9]{1,3}$') not valid;

-- 4) Uloženie draftu s EN16931 poliami ----------------------------------------------
create or replace function public.esblu_save_invoice_draft(
  p_invoice_id uuid,
  p_header jsonb,
  p_items jsonb,
  p_expected_updated_at timestamptz default null
)
returns setof public.invoices
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_invoice public.invoices%rowtype;
  v_item jsonb;
  v_position integer := 0;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if p_invoice_id is null or p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception using errcode = 'P0001', message = 'ESBLU_DRAFT_INVALID_INPUT';
  end if;

  if jsonb_array_length(p_items) > 500 then
    raise exception using errcode = 'P0001', message = 'ESBLU_DRAFT_TOO_MANY_ITEMS';
  end if;

  -- Zámok riadku (pod RLS — cudzí/finalizovaný doklad sa nenájde).
  select * into v_invoice
  from public.invoices i
  where i.id = p_invoice_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_DRAFT_NOT_FOUND';
  end if;

  if v_invoice.document_status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_FINALIZED_IMMUTABLE';
  end if;

  -- Súbežná zmena (iná karta / iný používateľ) — nič neprepísať potichu.
  if p_expected_updated_at is not null and v_invoice.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = 'P0001', message = 'ESBLU_DRAFT_STALE';
  end if;

  update public.invoices i
  set
    issue_date = case when p_header ? 'issue_date' then (p_header->>'issue_date')::date else i.issue_date end,
    due_date = case when p_header ? 'due_date' then nullif(p_header->>'due_date', '')::date else i.due_date end,
    delivery_date = case when p_header ? 'delivery_date' then nullif(p_header->>'delivery_date', '')::date else i.delivery_date end,
    variable_symbol = case when p_header ? 'variable_symbol' then nullif(btrim(p_header->>'variable_symbol'), '') else i.variable_symbol end,
    payment_terms_days = case when p_header ? 'payment_terms_days' then (p_header->>'payment_terms_days')::integer else i.payment_terms_days end,
    currency = case when p_header ? 'currency' then upper(btrim(p_header->>'currency')) else i.currency end,
    customer_business_partner_id = case when p_header ? 'customer_business_partner_id'
      then nullif(p_header->>'customer_business_partner_id', '')::uuid else i.customer_business_partner_id end,
    supplier_business_partner_id = case when p_header ? 'supplier_business_partner_id'
      then nullif(p_header->>'supplier_business_partner_id', '')::uuid else i.supplier_business_partner_id end,
    supplier_invoice_number = case when p_header ? 'supplier_invoice_number'
      then nullif(btrim(p_header->>'supplier_invoice_number'), '') else i.supplier_invoice_number end,
    buyer_reference = case when p_header ? 'buyer_reference'
      then nullif(btrim(p_header->>'buyer_reference'), '') else i.buyer_reference end,
    purchase_order_reference = case when p_header ? 'purchase_order_reference'
      then nullif(btrim(p_header->>'purchase_order_reference'), '') else i.purchase_order_reference end,
    payment_means_code = case when p_header ? 'payment_means_code'
      then nullif(btrim(p_header->>'payment_means_code'), '') else i.payment_means_code end,
    payment_reference = case when p_header ? 'payment_reference'
      then nullif(btrim(p_header->>'payment_reference'), '') else i.payment_reference end,
    updated_by = auth.uid(),
    updated_at = now()
  where i.id = p_invoice_id;

  delete from public.invoice_items it where it.invoice_id = p_invoice_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_position := v_position + 1;
    insert into public.invoice_items (
      invoice_id, position, description, quantity, unit, unit_code, unit_price, price_mode,
      vat_category_code, vat_rate, line_net_amount, line_vat_amount, line_gross_amount
    ) values (
      p_invoice_id,
      v_position,
      v_item->>'description',
      (v_item->>'quantity')::numeric,
      v_item->>'unit',
      nullif(upper(btrim(coalesce(v_item->>'unit_code', ''))), ''),
      (v_item->>'unit_price')::numeric,
      coalesce(nullif(v_item->>'price_mode', ''), 'net'),
      v_item->>'vat_category_code',
      (v_item->>'vat_rate')::numeric,
      (v_item->>'line_net_amount')::numeric,
      (v_item->>'line_vat_amount')::numeric,
      (v_item->>'line_gross_amount')::numeric
    );
  end loop;

  return query select * from public.invoices i where i.id = p_invoice_id;
end;
$function$;

revoke all on function public.esblu_save_invoice_draft(uuid, jsonb, jsonb, timestamptz) from public, anon;
grant execute on function public.esblu_save_invoice_draft(uuid, jsonb, jsonb, timestamptz) to authenticated;

commit;
