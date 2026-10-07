-- =============================================================================
-- 20261008100008 — prijatá faktúra k prijatej platbe (UBL 386) a prijatá konečná faktúra
-- s odpočítanými zálohami (BT-113 PrepaidAmount). Posledné dva technické GAPy príjmu e-faktúry.
--
-- 1) Invoice 386 → samostatný druh `payment_received_invoice` (nikdy bežná faktúra). XML ostáva nemenné;
--    zaznamená sa dodávateľ, sumy a rozpis DPH z XML a BT-7 (dátum prijatia platby → tax_point_date).
--    Duplicita / replay (SHA-256, transport ID, dodávateľ + číslo) nevytvorí druhú zálohu.
--    O nároku na odpočet DPH sa automaticky NEROZHODUJE (iba evidencia).
-- 2) Konečná faktúra s BT-113 > 0 → koncept s `prepaid_amount` a odkazmi BG-3 (`advance_references`).
--    Párovanie na prijaté 386 iba v rámci firmy a dodávateľa; automatický návrh iba pri jednoznačnej
--    zhode a súhlasnej sume, inak review s dôvodom. Žiadny dvojitý odpočet (guard + zámok zálohy).
-- 3) Review (finance.manage): potvrdiť návrh, ručne priradiť / odobrať zálohu, zamietnuť návrh.
--    Finalizácia konečnej faktúry je možná iba so zálohami spárovanými presne na BT-113.
-- 4) Saldo: na úhradu = celková suma dokladu − BT-113; pri zálohe aj spotrebovaná / zostávajúca suma.
-- 5) Súčty z XML: total_amount = BT-112 + BT-114 (= BT-115 + BT-113) — kontrola finalizácie upravená.
--
-- ROLLBACK: supabase/rollback/20261008100008_received_advances_rollback.sql
-- =============================================================================

-- 0) Nový typ udalosti (aditívne) ----------------------------------------------------------------
do $migration$
declare
  v_con record; v_found integer := 0; v_conname text; v_existing text[]; v_all text[]; v_type text; v_after text;
begin
  for v_con in
    select c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c
    where c.conrelid = 'public.invoice_events'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%event_type%'
  loop
    v_found := v_found + 1;
    v_conname := v_con.conname;
    select coalesce(array_agg(x.m[1] order by x.ord), array[]::text[]) into v_existing
    from regexp_matches(v_con.def, '''([^'']+)''', 'g') with ordinality as x(m, ord);
  end loop;
  if v_found <> 1 or cardinality(v_existing) = 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_MIGRATION_INVOICE_EVENTS_CHECK_UNEXPECTED:' || v_found::text;
  end if;
  v_all := v_existing;
  if not ('advance_reviewed' = any (v_all)) then v_all := v_all || 'advance_reviewed'::text; end if;
  execute format('alter table public.invoice_events drop constraint %I', v_conname);
  execute format('alter table public.invoice_events add constraint invoice_events_event_type_check check (event_type in (%s))',
    (select string_agg(quote_literal(t.v), ', ' order by t.ord) from unnest(v_all) with ordinality as t(v, ord)));
  select pg_get_constraintdef(c.oid) into v_after from pg_constraint c
  where c.conrelid = 'public.invoice_events'::regclass and c.conname = 'invoice_events_event_type_check';
  foreach v_type in array v_existing loop
    if position('''' || v_type || '''' in v_after) = 0 then
      raise exception using errcode = 'P0001', message = 'ESBLU_MIGRATION_INVOICE_EVENTS_TYPE_LOST:' || v_type;
    end if;
  end loop;
end
$migration$;

-- 1) Stĺpce konečnej prijatej faktúry --------------------------------------------------------------
alter table public.invoices
  add column if not exists prepaid_amount numeric(18, 2),
  add column if not exists advance_references jsonb,
  add column if not exists advance_review_status text,
  add column if not exists advance_review_reasons text[],
  add column if not exists advance_review_note text,
  add column if not exists advance_reviewed_at timestamptz,
  add column if not exists advance_reviewed_by uuid;
comment on column public.invoices.prepaid_amount is
  'BT-113 z doručeného XML prijatej konečnej faktúry (odpočítané zálohy). Iba received regular_invoice.';
alter table public.invoices drop constraint if exists invoices_prepaid_amount_check;
alter table public.invoices add constraint invoices_prepaid_amount_check
  check (prepaid_amount is null or (prepaid_amount > 0 and direction = 'received' and kind = 'regular_invoice'));
alter table public.invoices drop constraint if exists invoices_advance_review_status_check;
alter table public.invoices add constraint invoices_advance_review_status_check
  check ((advance_review_status is null) = (prepaid_amount is null)
         and (advance_review_status is null or advance_review_status in ('review', 'proposed', 'linked')));
alter table public.invoices drop constraint if exists invoices_advance_review_reasons_check;
alter table public.invoices add constraint invoices_advance_review_reasons_check
  check (advance_review_reasons is null or (cardinality(advance_review_reasons) <= 20
         and (cardinality(advance_review_reasons) = 0 or array_to_string(advance_review_reasons, ',') ~ '^[A-Z0-9_]{1,60}(,[A-Z0-9_]{1,60})*$')));
alter table public.invoices drop constraint if exists invoices_advance_review_note_check;
alter table public.invoices add constraint invoices_advance_review_note_check
  check (advance_review_note is null or char_length(advance_review_note) between 3 and 500);
alter table public.invoices drop constraint if exists invoices_advance_references_check;
alter table public.invoices add constraint invoices_advance_references_check
  check (advance_references is null or (jsonb_typeof(advance_references) = 'array' and jsonb_array_length(advance_references) <= 20));

-- Polia review záloh nemení klient priamo (iba RPC a triggre).
create or replace function public.esblu_block_client_advance_review_change()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.prepaid_amount is not null or new.advance_references is not null or new.advance_review_status is not null
       or new.advance_review_reasons is not null or new.advance_review_note is not null
       or new.advance_reviewed_at is not null or new.advance_reviewed_by is not null then
      raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_REVIEW_FIELDS_PROTECTED';
    end if;
  elsif new.prepaid_amount is distinct from old.prepaid_amount
     or new.advance_references is distinct from old.advance_references
     or new.advance_review_status is distinct from old.advance_review_status
     or new.advance_review_reasons is distinct from old.advance_review_reasons
     or new.advance_review_note is distinct from old.advance_review_note
     or new.advance_reviewed_at is distinct from old.advance_reviewed_at
     or new.advance_reviewed_by is distinct from old.advance_reviewed_by
     -- Druh prijatej zálohy (386) a konečnej faktúry so zálohami sa nemení z klienta.
     or (old.direction = 'received' and old.source = 'efaktura_peppol' and new.kind is distinct from old.kind) then
    raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_REVIEW_FIELDS_PROTECTED';
  end if;
  return new;
end;
$function$;
revoke execute on function public.esblu_block_client_advance_review_change() from public, anon, authenticated;
drop trigger if exists esblu_block_client_advance_review_change on public.invoices;
create trigger esblu_block_client_advance_review_change before insert or update on public.invoices
  for each row execute function public.esblu_block_client_advance_review_change();

-- 2) Väzby prijatá záloha (386) → prijatá konečná faktúra --------------------------------------------
create table if not exists public.received_advance_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  advance_invoice_id uuid not null references public.invoices(id) on delete cascade,
  amount numeric(18, 2) not null check (amount > 0),
  -- Informatívny rozklad sumy (pomerne podľa zálohy). Nie je to rozhodnutie o odpočte DPH.
  taxable_amount numeric(18, 2) not null,
  vat_amount numeric(18, 2) not null,
  source text not null check (source in ('auto', 'manual')),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (invoice_id, advance_invoice_id),
  check (invoice_id <> advance_invoice_id)
);
create index if not exists received_advance_links_advance_idx on public.received_advance_links (advance_invoice_id);
create index if not exists received_advance_links_company_idx on public.received_advance_links (company_id);
alter table public.received_advance_links enable row level security;
revoke all on table public.received_advance_links from public, anon, authenticated;
grant select on table public.received_advance_links to authenticated;
grant select, insert, update, delete on table public.received_advance_links to service_role;
drop policy if exists received_advance_links_select_finance on public.received_advance_links;
create policy received_advance_links_select_finance on public.received_advance_links
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

create or replace function public.esblu_received_advance_link_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype;
  v_a public.invoices%rowtype;
  v_used numeric(18, 2);
  v_final_sum numeric(18, 2);
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
  if v_f.direction <> 'received' or v_f.kind <> 'regular_invoice' or v_f.prepaid_amount is null then
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
  select coalesce(sum(l.amount), 0) into v_used from public.received_advance_links l
  where l.advance_invoice_id = v_a.id and l.invoice_id <> v_f.id;
  if v_used + new.amount > v_a.total_amount then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_EXCEEDS',
      hint = 'Záloha je už odpočítaná (celá alebo čiastočne) na inej faktúre.';
  end if;
  select coalesce(sum(l.amount), 0) into v_final_sum from public.received_advance_links l
  where l.invoice_id = v_f.id and l.advance_invoice_id <> v_a.id;
  if v_final_sum + new.amount > v_f.prepaid_amount then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_EXCEEDS_PREPAID',
      hint = 'Súčet priradených záloh nesmie prekročiť odpočítanú sumu v XML (BT-113).';
  end if;
  new.vat_amount := case when v_a.total_amount = 0 then 0
                         when new.amount = v_a.total_amount then v_a.vat_total_amount
                         else round(v_a.vat_total_amount * new.amount / v_a.total_amount, 2) end;
  new.taxable_amount := new.amount - new.vat_amount;
  return new;
end;
$function$;
revoke execute on function public.esblu_received_advance_link_guard() from public, anon, authenticated;
drop trigger if exists esblu_received_advance_link_guard on public.received_advance_links;
create trigger esblu_received_advance_link_guard
  before insert or update or delete on public.received_advance_links
  for each row execute function public.esblu_received_advance_link_guard();

-- 3) Párovanie konečnej faktúry na prijaté zálohy (interné; iba koncept v stave review bez väzieb) ----------
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
  v_rems numeric[] := array[]::numeric[];
  v_a public.invoices%rowtype;
  v_rem numeric(18, 2);
  v_reasons text[] := array[]::text[];
  v_status text;
  v_i integer;
begin
  select * into v_f from public.invoices f where f.id = p_invoice_id for update;
  if v_f.id is null or v_f.direction <> 'received' or v_f.kind <> 'regular_invoice' or v_f.document_status <> 'draft'
     or v_f.prepaid_amount is null or v_f.advance_review_status <> 'review'
     or exists (select 1 from public.received_advance_links l where l.invoice_id = v_f.id) then
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
          select v_a.total_amount - coalesce(sum(l.amount), 0) into v_rem
          from public.received_advance_links l where l.advance_invoice_id = v_a.id and l.invoice_id <> v_f.id;
          if v_rem <= 0 then
            v_reasons := array_append(v_reasons, 'ADVANCE_ALREADY_DEDUCTED');
          else
            v_found := array_append(v_found, v_a.id);
            v_rems := array_append(v_rems, v_rem);
          end if;
        end if;
      end if;
    end loop;
    if cardinality(v_found) = 0 and cardinality(v_reasons) = 0 then
      v_reasons := array_append(v_reasons, 'ADVANCE_REFERENCE_MISSING');
    end if;
  end if;

  if cardinality(v_reasons) = 0 then
    if cardinality(v_found) = 1 then
      if v_f.prepaid_amount > v_rems[1] then
        v_reasons := array_append(v_reasons, 'ADVANCE_AMOUNT_MISMATCH');
      end if;
    elsif (select sum(x) from unnest(v_rems) x) <> v_f.prepaid_amount then
      -- Viac záloh: automaticky iba ak sa spotrebujú celé a súčet = BT-113 (inak rozdelenie rozhodne človek).
      v_reasons := array_append(v_reasons, 'ADVANCE_AMOUNT_MISMATCH');
    end if;
  end if;

  -- Distinct, poradie zachované.
  v_reasons := array(select r from unnest(v_reasons) with ordinality u(r, o) group by r order by min(o));

  if cardinality(v_reasons) = 0 then
    for v_i in 1 .. cardinality(v_found) loop
      insert into public.received_advance_links (company_id, invoice_id, advance_invoice_id, amount, taxable_amount, vat_amount, source, created_by)
      values (v_f.company_id, v_f.id, v_found[v_i],
              case when cardinality(v_found) = 1 then v_f.prepaid_amount else v_rems[v_i] end, 0, 0, 'auto', null);
    end loop;
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

-- 4) Finalizácia prijatej konečnej faktúry: zálohy musia byť spárované presne na BT-113 ----------------
-- Beží pred esblu_einvoice_received_finalize_guard aj esblu_invoice_finalize_compliance (abecedne).
create or replace function public.esblu_a_received_advance_finalize()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_sum numeric(18, 2);
begin
  if new.advance_review_status is null or new.advance_review_status not in ('proposed', 'linked') then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_REVIEW_REQUIRED',
      hint = 'Najprv priraďte prijaté zálohy (faktúry k prijatej platbe), ktoré dodávateľ odpočítal.';
  end if;
  perform 1 from public.invoices a
  where a.id in (select l.advance_invoice_id from public.received_advance_links l where l.invoice_id = new.id)
  order by a.id for update;
  select coalesce(sum(l.amount), 0) into v_sum from public.received_advance_links l where l.invoice_id = new.id;
  if v_sum <> new.prepaid_amount then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_AMOUNT_MISMATCH';
  end if;
  if exists (select 1 from public.received_advance_links l join public.invoices a on a.id = l.advance_invoice_id
             where l.invoice_id = new.id and a.document_status <> 'finalized') then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_NOT_FINALIZED',
      hint = 'Najprv finalizujte prijatú faktúru k prijatej platbe.';
  end if;
  if new.advance_review_status = 'proposed' then
    new.advance_review_status := 'linked';
    new.advance_reviewed_at := now();
    new.advance_reviewed_by := auth.uid();
  end if;
  return new;
end;
$function$;
revoke execute on function public.esblu_a_received_advance_finalize() from public, anon, authenticated;
drop trigger if exists esblu_a_received_advance_finalize on public.invoices;
create trigger esblu_a_received_advance_finalize
  before update of document_status on public.invoices
  for each row
  when (old.document_status = 'draft' and new.document_status = 'finalized' and new.direction = 'received'
        and new.kind = 'regular_invoice' and new.prepaid_amount is not null)
  execute function public.esblu_a_received_advance_finalize();

-- 5) Review akcie (finance.manage, aktívna firma, iba koncept prijatej konečnej faktúry) -----------------
create or replace function public.esblu_received_advance_target(p_invoice_id uuid)
returns public.invoices
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype;
begin
  if not public.esblu_my_finance_manage() then
    raise exception using errcode = 'P0001', message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED';
  end if;
  select * into v_f from public.invoices i where i.id = p_invoice_id for update;
  if v_f.id is null or v_f.company_id is distinct from public.esblu_my_active_company_id() then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  if v_f.prepaid_amount is null or v_f.direction <> 'received' or v_f.kind <> 'regular_invoice' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_TARGET_INVALID';
  end if;
  if v_f.document_status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_LINK_LOCKED';
  end if;
  return v_f;
end;
$function$;
revoke all on function public.esblu_received_advance_target(uuid) from public, anon, authenticated;

create or replace function public.esblu_received_advance_refresh_status(p_invoice_id uuid, p_action text, p_extra jsonb)
returns text
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_prepaid numeric(18, 2);
  v_sum numeric(18, 2);
  v_n integer;
  v_status text;
  v_reasons text[];
begin
  select i.prepaid_amount into v_prepaid from public.invoices i where i.id = p_invoice_id;
  select coalesce(sum(l.amount), 0), count(*) into v_sum, v_n from public.received_advance_links l where l.invoice_id = p_invoice_id;
  if v_sum = v_prepaid then
    v_status := 'linked'; v_reasons := array[]::text[];
  else
    v_status := 'review';
    v_reasons := case when v_n = 0 then array['ADVANCE_NOT_ASSIGNED'] else array['ADVANCE_PARTIALLY_ASSIGNED'] end;
  end if;
  update public.invoices i
  set advance_review_status = v_status, advance_review_reasons = v_reasons,
      advance_reviewed_at = case when v_status = 'linked' then now() else null end,
      advance_reviewed_by = case when v_status = 'linked' then auth.uid() else null end,
      updated_at = now(), updated_by = auth.uid()
  where i.id = p_invoice_id;
  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (p_invoice_id, 'advance_reviewed', auth.uid(), 'user', jsonb_build_object('action', p_action, 'status', v_status) || coalesce(p_extra, '{}'::jsonb));
  return v_status;
end;
$function$;
revoke all on function public.esblu_received_advance_refresh_status(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.esblu_received_advance_confirm(p_invoice_id uuid)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype := public.esblu_received_advance_target(p_invoice_id);
begin
  if v_f.advance_review_status <> 'proposed' then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_NOT_PROPOSED';
  end if;
  return public.esblu_received_advance_refresh_status(p_invoice_id, 'confirmed', null);
end;
$function$;
revoke all on function public.esblu_received_advance_confirm(uuid) from public, anon;
grant execute on function public.esblu_received_advance_confirm(uuid) to authenticated;

create or replace function public.esblu_received_advance_link(p_invoice_id uuid, p_advance_invoice_id uuid, p_amount numeric default null)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype := public.esblu_received_advance_target(p_invoice_id);
  v_a record;
  v_amount numeric(18, 2);
begin
  if exists (select 1 from public.received_advance_links l where l.invoice_id = v_f.id and l.advance_invoice_id = p_advance_invoice_id) then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_ALREADY_LINKED';
  end if;
  select a.id, a.company_id, a.total_amount into v_a from public.invoices a where a.id = p_advance_invoice_id;
  if v_a.id is null or v_a.company_id <> v_f.company_id then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_NOT_FOUND';
  end if;
  if p_amount is null then
    -- Predvolene: zvyšok zálohy, najviac do zostatku BT-113.
    v_amount := least(
      v_a.total_amount - coalesce((select sum(l.amount) from public.received_advance_links l where l.advance_invoice_id = v_a.id), 0),
      v_f.prepaid_amount - coalesce((select sum(l.amount) from public.received_advance_links l where l.invoice_id = v_f.id), 0));
  else
    v_amount := p_amount;
  end if;
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_AMOUNT_INVALID';
  end if;
  -- Guard vynúti firmu, smer, druh, dodávateľa, menu a limity (záloha aj BT-113).
  insert into public.received_advance_links (company_id, invoice_id, advance_invoice_id, amount, taxable_amount, vat_amount, source, created_by)
  values (v_f.company_id, v_f.id, p_advance_invoice_id, v_amount, 0, 0, 'manual', auth.uid());
  return public.esblu_received_advance_refresh_status(p_invoice_id, 'manual_linked',
    jsonb_build_object('advance_invoice_id', p_advance_invoice_id, 'amount', v_amount));
end;
$function$;
revoke all on function public.esblu_received_advance_link(uuid, uuid, numeric) from public, anon;
grant execute on function public.esblu_received_advance_link(uuid, uuid, numeric) to authenticated;

create or replace function public.esblu_received_advance_unlink(p_invoice_id uuid, p_advance_invoice_id uuid)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype := public.esblu_received_advance_target(p_invoice_id);
begin
  delete from public.received_advance_links l where l.invoice_id = v_f.id and l.advance_invoice_id = p_advance_invoice_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_LINK_NOT_FOUND';
  end if;
  return public.esblu_received_advance_refresh_status(p_invoice_id, 'unlinked', jsonb_build_object('advance_invoice_id', p_advance_invoice_id));
end;
$function$;
revoke all on function public.esblu_received_advance_unlink(uuid, uuid) from public, anon;
grant execute on function public.esblu_received_advance_unlink(uuid, uuid) to authenticated;

create or replace function public.esblu_received_advance_reject(p_invoice_id uuid, p_note text)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_f public.invoices%rowtype;
begin
  v_f := public.esblu_received_advance_target(p_invoice_id);
  if v_note is null or char_length(v_note) not between 3 and 500 then
    raise exception using errcode = 'P0001', message = 'ESBLU_ADVANCE_REVIEW_NOTE_REQUIRED';
  end if;
  if v_f.advance_review_status not in ('proposed', 'linked') then
    raise exception using errcode = 'P0001', message = 'ESBLU_RECEIVED_ADVANCE_NOT_PROPOSED';
  end if;
  delete from public.received_advance_links l where l.invoice_id = v_f.id;
  update public.invoices i
  set advance_review_status = 'review', advance_review_reasons = array['ADVANCE_LINK_REJECTED'],
      advance_review_note = v_note, advance_reviewed_at = null, advance_reviewed_by = null,
      updated_at = now(), updated_by = auth.uid()
  where i.id = v_f.id;
  insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
  values (v_f.id, 'advance_reviewed', auth.uid(), 'user', jsonb_build_object('action', 'rejected', 'status', 'review'));
  return 'review';
end;
$function$;
revoke all on function public.esblu_received_advance_reject(uuid, text) from public, anon;
grant execute on function public.esblu_received_advance_reject(uuid, text) to authenticated;

-- Kandidáti na ručné priradenie: iba tá istá firma, dodávateľ a mena (finance.view).
create or replace function public.esblu_received_advance_candidates(p_invoice_id uuid)
returns table (advance_invoice_id uuid, supplier_invoice_number text, issue_date date, tax_point_date date, currency text,
               total_amount numeric, vat_total_amount numeric, used_amount numeric, remaining_amount numeric, document_status text)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_f public.invoices%rowtype;
begin
  if not public.esblu_my_finance_view() then
    raise exception using errcode = 'P0001', message = 'ESBLU_FORBIDDEN_FINANCE_VIEW_REQUIRED';
  end if;
  select * into v_f from public.invoices i where i.id = p_invoice_id;
  if v_f.id is null or v_f.company_id is distinct from public.esblu_my_active_company_id() then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;
  return query
  select a.id, a.supplier_invoice_number, a.issue_date, a.tax_point_date, a.currency,
         a.total_amount::numeric, a.vat_total_amount::numeric,
         coalesce(u.used, 0)::numeric, (a.total_amount - coalesce(u.used, 0))::numeric, a.document_status
  from public.invoices a
  left join lateral (select sum(l.amount) used from public.received_advance_links l
                     where l.advance_invoice_id = a.id and l.invoice_id <> v_f.id) u on true
  where a.company_id = v_f.company_id and a.direction = 'received' and a.kind = 'payment_received_invoice'
    and a.supplier_business_partner_id is not distinct from v_f.supplier_business_partner_id
    and a.currency = v_f.currency and a.total_amount - coalesce(u.used, 0) > 0
  order by a.issue_date, a.supplier_invoice_number;
end;
$function$;
revoke all on function public.esblu_received_advance_candidates(uuid) from public, anon;
grant execute on function public.esblu_received_advance_candidates(uuid) to authenticated;

-- 6) Saldo: odpočítané zálohy aj na prijatej konečnej faktúre; spotreba zálohy -----------------------------
create or replace function public.esblu_invoice_settlement_core(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_inv public.invoices%rowtype;
  v_root public.invoices%rowtype;
  v_prepaid numeric(18, 2);
  v_linked numeric(18, 2) := 0;
  v_consumed numeric(18, 2) := null;
  v_credits numeric(18, 2);
  v_debits numeric(18, 2);
  v_paid numeric(18, 2);
  v_refunded numeric(18, 2);
  v_due numeric(18, 2);
  v_balance numeric(18, 2);
  v_status text;
begin
  select * into v_inv from public.invoices i where i.id = p_invoice_id;
  if v_inv.id is null then return null; end if;
  if v_inv.kind in ('credit_note', 'debit_note') and v_inv.corrects_invoice_id is not null then
    select * into v_root from public.invoices i where i.id = v_inv.corrects_invoice_id;
  else
    v_root := v_inv;
  end if;
  select coalesce(sum(d.taxable_amount + d.vat_amount), 0) into v_prepaid from public.invoice_advance_deductions d where d.invoice_id = v_root.id;
  -- 20261008100008: prijatá konečná faktúra — odpočítané zálohy podľa XML (BT-113).
  if v_root.direction = 'received' then
    v_prepaid := v_prepaid + coalesce(v_root.prepaid_amount, 0);
    select coalesce(sum(l.amount), 0) into v_linked from public.received_advance_links l where l.invoice_id = v_root.id;
  end if;
  if v_root.kind = 'payment_received_invoice' then
    if v_root.direction = 'received' then
      select coalesce(sum(l.amount), 0) into v_consumed from public.received_advance_links l
      join public.invoices f on f.id = l.invoice_id where l.advance_invoice_id = v_root.id and f.document_status = 'finalized';
    else
      select coalesce(sum(d.taxable_amount + d.vat_amount), 0) into v_consumed from public.invoice_advance_deductions d
      join public.invoices f on f.id = d.invoice_id where d.advance_invoice_id = v_root.id and f.document_status = 'finalized';
    end if;
  end if;
  select coalesce(sum(c.total_amount) filter (where c.kind = 'credit_note'), 0), coalesce(sum(c.total_amount) filter (where c.kind = 'debit_note'), 0)
    into v_credits, v_debits
  from public.invoices c where c.corrects_invoice_id = v_root.id and c.document_status = 'finalized';
  select coalesce(sum(p.paid_amount) filter (where p.entry_type = 'payment'), 0), coalesce(sum(p.paid_amount) filter (where p.entry_type = 'refund'), 0)
    into v_paid, v_refunded
  from public.invoice_payments p
  where p.invoice_id = v_root.id
     or p.invoice_id in (select c.id from public.invoices c where c.corrects_invoice_id = v_root.id and c.document_status = 'finalized');
  v_due := v_root.total_amount - v_prepaid + v_debits - v_credits;
  v_balance := v_due - (v_paid - v_refunded);
  v_status := case
    when v_balance < 0 then 'overpaid'
    when v_balance = 0 then 'paid'
    when v_paid - v_refunded > 0 then 'partially_paid'
    else 'unpaid' end;
  return jsonb_build_object(
    'root_invoice_id', v_root.id, 'currency', v_root.currency,
    'original_total', v_root.total_amount, 'advances_deducted', v_prepaid,
    'advances_linked', v_linked,
    'advance_consumed', v_consumed,
    'advance_remaining', case when v_consumed is null then null else v_root.total_amount - v_consumed end,
    'credit_notes_total', v_credits, 'debit_notes_total', v_debits,
    'amount_due', v_due, 'paid', v_paid, 'refunded', v_refunded,
    'balance', v_balance, 'payment_status', v_status);
end;
$function$;
revoke all on function public.esblu_invoice_settlement_core(uuid) from public, anon, authenticated;

-- 7) Kontrola finalizácie prijatej e-faktúry: total_amount = BT-115 + BT-113 (= BT-112 + BT-114) -------------
create or replace function public.esblu_einvoice_received_finalize_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_x jsonb;
begin
  select i.xml_totals into v_x
  from public.einvoice_inbound i
  where i.invoice_id = new.id and i.company_id = new.company_id and i.xml_totals is not null
  order by i.received_at
  limit 1;
  if v_x is null then
    return new; -- koncept bez záznamu súčtov z XML (vznikol pred 20261003100000)
  end if;

  if new.subtotal_amount <> (v_x ->> 'tax_exclusive')::numeric
     or new.vat_total_amount <> (v_x ->> 'vat_total')::numeric
     or new.rounding_amount <> (v_x ->> 'rounding')::numeric
     or new.total_amount <> (v_x ->> 'payable')::numeric + coalesce((v_x ->> 'prepaid')::numeric, 0)
     or coalesce(new.prepaid_amount, 0) <> coalesce((v_x ->> 'prepaid')::numeric, 0)
     or exists (
       (select b ->> 'category', (b ->> 'rate')::numeric, (b ->> 'taxable')::numeric, (b ->> 'vat')::numeric
          from jsonb_array_elements(v_x -> 'breakdown') b)
       except
       (select t.vat_category_code, t.vat_rate::numeric, t.taxable_amount::numeric, t.vat_amount::numeric
          from public.invoice_tax_breakdowns t where t.invoice_id = new.id)
     )
     or exists (
       (select t.vat_category_code, t.vat_rate::numeric, t.taxable_amount::numeric, t.vat_amount::numeric
          from public.invoice_tax_breakdowns t where t.invoice_id = new.id)
       except
       (select b ->> 'category', (b ->> 'rate')::numeric, (b ->> 'taxable')::numeric, (b ->> 'vat')::numeric
          from jsonb_array_elements(v_x -> 'breakdown') b)
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_EINVOICE_FINALIZE_TOTALS_MISMATCH',
      hint = 'Súčty prijatej e-faktúry sa musia zhodovať s doručeným XML — položky konceptu boli zmenené.';
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_einvoice_received_finalize_guard() from public, anon, authenticated;

-- 8) Súčty z XML: BT-113 > 0 povolené (iba nezáporné a najviac do BT-112 + BT-114) -----------------------
-- Server-side úprava aktuálnej definície (iba podmienka BT-113, zvyšok tela bez zmeny). Idempotentné.
do $patch$
declare
  r record;
  d text;
  v_new text;
  v_seen integer := 0;
  v_found integer := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'esblu_einvoice_apply_xml_totals'
  loop
    v_found := v_found + 1;
    d := pg_get_functiondef(r.oid);
    v_new := regexp_replace(d,
      '-- Dátový model Esblu nemá zálohy ani zľavy/prirážky dokladu\.(\r?\n)([ ]*)if v_prepaid <> 0 or v_tax_excl <> v_line_ext then',
      '-- Dátový model Esblu nemá zľavy/prirážky dokladu; BT-113 (20261008100008) nezáporné, najviac BT-112 + BT-114.\1\2if v_prepaid < 0 or v_prepaid > v_tax_incl + v_rounding or v_tax_excl <> v_line_ext then');
    if v_new <> d then
      execute v_new;
      v_seen := v_seen + 1;
    elsif position('if v_prepaid < 0 or v_prepaid > v_tax_incl + v_rounding or v_tax_excl <> v_line_ext then' in d) > 0 then
      v_seen := v_seen + 1;
    end if;
  end loop;
  -- Reťazec bez 20261003100000 (testy iba základu) funkciu nemá → nič na úpravu.
  if v_found > 0 and v_seen <> v_found then
    raise exception 'APPLY_XML_TOTALS_ANCHOR_MISSING';
  end if;
end
$patch$;

-- 9) create_draft: 386 → payment_received_invoice; konečná faktúra s BT-113 → párovanie záloh -------------
create or replace function public.esblu_einvoice_inbound_create_draft(p_inbound_id uuid, p_draft jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_in public.einvoice_inbound;
  v_dup record;
  v_partner uuid;
  v_result jsonb;
  v_status text;
  v_totals jsonb;
  v_kind text := coalesce(p_draft ->> 'document_kind', 'regular_invoice');
  v_prepaid numeric;
  v_invoice_id uuid;
  v_existing uuid;
  v_final record;
begin
  select * into v_in from public.einvoice_inbound i where i.id = p_inbound_id for update;
  if v_in.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_NOT_FOUND';
  end if;
  if v_in.processing_status <> 'parsed' or v_in.xml_sha256 is null or v_in.xml_storage_path is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_STATE';
  end if;
  if p_draft is null or jsonb_typeof(p_draft -> 'totals') is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TOTALS_REQUIRED';
  end if;
  if v_kind not in ('regular_invoice', 'payment_received_invoice', 'credit_note', 'debit_note') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_KIND_UNSUPPORTED';
  end if;
  begin
    v_prepaid := coalesce(nullif(p_draft -> 'totals' ->> 'prepaid', ''), '0')::numeric;
  exception when others then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TOTALS_INCONSISTENT', hint = 'NUMBER';
  end;
  -- BT-113 iba na konečnej (bežnej) faktúre.
  if v_prepaid <> 0 and v_kind <> 'regular_invoice' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TOTALS_INCONSISTENT', hint = 'UNSUPPORTED_AMOUNTS';
  end if;

  perform set_config('esblu.einvoice_event_source', 'job', true);

  -- Dedupe 1: rovnaké XML (SHA-256) už vo FIRME spracované → prepojiť existujúci koncept (aj pri opravách).
  select i.id, i.invoice_id into v_dup
  from public.einvoice_inbound i
  where i.company_id = v_in.company_id and i.xml_sha256 = v_in.xml_sha256
    and i.id <> v_in.id and i.invoice_id is not null
  order by i.received_at
  limit 1;
  if v_dup.id is not null then
    update public.einvoice_inbound i
    set processing_status = 'duplicate', invoice_id = v_dup.invoice_id, dedupe_matched_on = 'xml_sha256',
        last_error_code = null, next_retry_at = now() + interval '2 minutes'
    where i.id = v_in.id;
    perform set_config('esblu.einvoice_event_source', '', true);
    return jsonb_build_object('status', 'duplicate', 'invoice_id', v_dup.invoice_id, 'matched_on', 'xml_sha256');
  end if;

  if v_kind in ('credit_note', 'debit_note') then
    perform set_config('esblu.einvoice_event_source', '', true);
    return public.esblu_einvoice_inbound_create_correction(p_inbound_id, p_draft);
  end if;

  v_partner := public.esblu_einvoice_resolve_supplier(v_in.company_id, coalesce(p_draft -> 'supplier', '{}'::jsonb));

  -- 20261008100008: faktúra k prijatej platbe — duplicita podľa (dodávateľ, druh, číslo) PRED vznikom konceptu
  -- (jadro konceptu porovnáva iba bežné faktúry; transport ID a odtlačok kontroluje jadro).
  if v_kind = 'payment_received_invoice' then
    select i.id into v_existing
    from public.invoices i
    where i.company_id = v_in.company_id and i.direction = 'received' and i.kind = 'payment_received_invoice'
      and i.supplier_business_partner_id = v_partner
      and upper(regexp_replace(coalesce(i.supplier_invoice_number, ''), '[\s\-/]', '', 'g'))
          = upper(regexp_replace(btrim(coalesce(p_draft ->> 'invoice_number', '')), '[\s\-/]', '', 'g'))
    order by i.created_at
    limit 1;
  end if;

  if v_existing is not null then
    v_result := jsonb_build_object('status', 'duplicate', 'existing_invoice_id', v_existing, 'matched_on', 'supplier_invoice_number');
  else
    v_result := public.esblu_received_invoice_draft_core(
      v_in.company_id, null, 'efaktura_peppol', v_in.provider, v_in.provider_received_id,
      v_partner,
      p_draft ->> 'invoice_number',
      nullif(p_draft ->> 'issue_date', '')::date,
      p_draft -> 'items',
      nullif(p_draft ->> 'due_date', '')::date,
      nullif(p_draft ->> 'delivery_date', '')::date,
      null,
      p_draft ->> 'currency',
      p_draft ->> 'iban',
      p_draft ->> 'bic',
      p_draft ->> 'payment_reference',
      null,
      p_draft ->> 'buyer_reference',
      p_draft ->> 'purchase_order_reference',
      (v_in.received_at at time zone 'UTC')::date,
      null,
      null
    );
  end if;

  v_status := case when v_result ->> 'status' = 'created' then 'draft_created' else 'duplicate' end;
  if v_status = 'draft_created' then
    v_invoice_id := (v_result ->> 'invoice_id')::uuid;
    if v_kind = 'payment_received_invoice' then
      -- Samostatný druh (UBL 386), BT-7 = dátum prijatia platby. O odpočte DPH sa nerozhoduje.
      update public.invoices i
      set kind = 'payment_received_invoice',
          tax_point_date = case when coalesce(p_draft ->> 'tax_point_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
                                then (p_draft ->> 'tax_point_date')::date end,
          updated_at = now()
      where i.id = v_invoice_id;
    end if;
    v_totals := public.esblu_einvoice_apply_xml_totals(v_invoice_id, p_draft -> 'totals', p_draft ->> 'payment_means_code');

    if v_kind = 'regular_invoice' and v_prepaid > 0 then
      update public.invoices i
      set prepaid_amount = v_prepaid,
          advance_references = coalesce(
            (select jsonb_agg(jsonb_build_object('number', left(btrim(r ->> 'number'), 200),
                                                 'issue_date', case when coalesce(r ->> 'issue_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then r ->> 'issue_date' end))
               from (select r from jsonb_array_elements(case when jsonb_typeof(p_draft -> 'advance' -> 'references') = 'array'
                                                             then p_draft -> 'advance' -> 'references' else '[]'::jsonb end) r
                     where jsonb_typeof(r) = 'object' and btrim(coalesce(r ->> 'number', '')) <> '' limit 20) x),
            '[]'::jsonb),
          advance_review_status = 'review',
          advance_review_reasons = array[]::text[],
          updated_at = now()
      where i.id = v_invoice_id;
      perform public.esblu_received_advance_match(v_invoice_id);
    end if;

    if v_kind = 'payment_received_invoice' then
      -- Záloha prišla PO konečnej faktúre → dodatočné párovanie konceptov v review toho istého dodávateľa.
      for v_final in
        select f.id from public.invoices f
        where f.company_id = v_in.company_id and f.direction = 'received' and f.kind = 'regular_invoice'
          and f.document_status = 'draft' and f.advance_review_status = 'review'
          and f.supplier_business_partner_id = v_partner
          and not exists (select 1 from public.received_advance_links l where l.invoice_id = f.id)
          and exists (select 1 from jsonb_array_elements(coalesce(f.advance_references, '[]'::jsonb)) r
                      where upper(regexp_replace(coalesce(r ->> 'number', ''), '[\s\-/]', '', 'g'))
                            = upper(regexp_replace(btrim(coalesce(p_draft ->> 'invoice_number', '')), '[\s\-/]', '', 'g')))
        order by f.created_at
      loop
        perform public.esblu_received_advance_match(v_final.id);
      end loop;
    end if;

    if v_kind = 'regular_invoice' then
      -- 20261008100007: oprava mohla prísť (alebo sa spracovať) SKÔR než originál → dodatočné prepojenie
      -- čakajúcich opráv v review: tá istá firma, ten istý dodávateľ, BT-25 = číslo tejto faktúry (a BT-26, ak je).
      with linked as (
        update public.invoices c
        set corrects_invoice_id = v_invoice_id,
            correction_review_reasons = array_append(
              array(select r from unnest(coalesce(c.correction_review_reasons, array[]::text[])) r
                    where r not in ('ORIGINAL_REFERENCE_MISSING', 'ORIGINAL_NOT_FOUND', 'ORIGINAL_AMBIGUOUS', 'ORIGINAL_NOT_FINALIZED')),
              'ORIGINAL_NOT_FINALIZED'),
            updated_at = now()
        where c.company_id = v_in.company_id and c.direction = 'received' and c.kind in ('credit_note', 'debit_note')
          and c.document_status = 'draft' and c.correction_review_status = 'review' and c.corrects_invoice_id is null
          and c.supplier_business_partner_id = v_partner
          and upper(regexp_replace(coalesce(c.corrected_document_reference, ''), '[\s\-/]', '', 'g'))
              = upper(regexp_replace(coalesce(p_draft ->> 'invoice_number', ''), '[\s\-/]', '', 'g'))
          and (c.corrected_document_issue_date is null or c.corrected_document_issue_date = nullif(p_draft ->> 'issue_date', '')::date)
        returning c.id
      )
      insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
      select l.id, 'correction_reviewed', null, 'system',
             jsonb_build_object('action', 'auto_linked', 'original_invoice_id', v_invoice_id)
      from linked l;
    end if;
  end if;

  update public.einvoice_inbound i
  set processing_status = v_status,
      invoice_id = coalesce((v_result ->> 'invoice_id')::uuid, (v_result ->> 'existing_invoice_id')::uuid),
      dedupe_matched_on = case when v_status = 'duplicate' then v_result ->> 'matched_on' end,
      draft_created_at = case when v_status = 'draft_created' then now() else i.draft_created_at end,
      xml_totals = case when v_status = 'draft_created' then v_totals else i.xml_totals end,
      last_error_code = null,
      next_retry_at = now() + interval '2 minutes'
  where i.id = v_in.id;
  perform set_config('esblu.einvoice_event_source', '', true);

  return jsonb_build_object(
    'status', case when v_status = 'draft_created' then 'created' else 'duplicate' end,
    'invoice_id', coalesce(v_result ->> 'invoice_id', v_result ->> 'existing_invoice_id'),
    'matched_on', v_result ->> 'matched_on',
    'document_kind', v_kind
  );
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_create_draft(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_inbound_create_draft(uuid, jsonb) to service_role;
