-- =============================================================================
-- PROD overlay pre scripts/einvoice-pglite-tests.ts — spúšťa sa PO reťazci
-- fakturačných migrácií. Fakturačné migrácie (20260916140000) definujú staršiu
-- verziu esblu_my_finance_* (bez roly accountant); produkčná verzia vznikla
-- neskôr (20260922100000 a nasl.), ktoré tento test nespúšťa. Preto sa tu
-- pomocné funkcie nastavia DOSLOVNE podľa prod (rovnako ako v
-- m1-authz-baseline.sql, pg_get_functiondef 2026-09-28). NIKDY nie Supabase.
-- esblu_my_finance_* = stav po 20261008100002 (explicitná väzba na aktívnu firmu).
-- =============================================================================

create or replace function public.esblu_my_active_company_id() returns uuid language sql stable security definer set search_path to '' as $f$
  select cm.company_id from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
$f$;
create or replace function public.esblu_my_active_role() returns text language sql stable security definer set search_path to '' as $f$
  select cm.role from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1;
$f$;
create or replace function public.esblu_my_finance_manage() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner', 'accountant') then true
    else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
    from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()), false);
$f$;
create or replace function public.esblu_my_finance_view() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner', 'accountant') then true
    else coalesce((cm.permissions -> 'finance' ->> 'view')::boolean, false) or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
    from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()), false);
$f$;
create or replace function public.esblu_role_can_operate() returns boolean language sql stable security definer set search_path to '' as $f$
  select coalesce((select cm.role in ('owner', 'admin', 'employee') from public.company_members cm
    where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false);
$f$;
create or replace function public.esblu_document_requires_finance(p_document_type text, p_status text) returns boolean language sql immutable set search_path to '' as $f$
  select coalesce(p_document_type, '') in ('invoice', 'receipt', 'delivery_note') or coalesce(p_status, '') in ('uploaded', 'processing');
$f$;
create or replace function public.esblu_evidence_is_delivery_note(p_kind text, p_label text) returns boolean language sql immutable set search_path to '' as $f$
  select case when p_kind is not null then p_kind = 'delivery_note'
    else lower(coalesce(p_label, '')) in ('delivery_note', 'dodací list', 'dodaci list', 'lieferschein', 'delivery note') end;
$f$;
