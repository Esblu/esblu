-- =============================================================================
-- S15b (2026-11-19): prvé LIVE nákupy iba pre výslovne povolené (interné) firmy.
-- Iba staging; produkcia čaká na súhlas. Rollback: supabase/rollback/…_rollback.sql
--
--   billing_runtime_config.live_purchase_scope: 'allowlist' (DEFAULT, fail closed) | 'all'
--   billing_live_purchase_allowlist: firmy, ktoré smú vytvoriť LIVE nákupný zámer / Checkout
--   trigger na billing_checkout_sessions (INSERT a priradenie Stripe relácie): LIVE zámer firmy mimo
--     allowlistu → ESBLU_BILLING_LIVE_NOT_ALLOWED. Platí pre KAŽDÚ cestu (RPC aj priame API),
--     lebo zámer vzniká a reláciu priraďuje iba DB.
--   esblu_billing_my_live_purchase_allowed(): pre UI (ponuka kanálov) — iba aktívna firma volajúceho.
-- Test prostredie sa nemení. Existujúce predplatné (obnovy, webhooky, reconciliation, správa) zámer
-- nevytvárajú → nie sú dotknuté.
-- =============================================================================

alter table public.billing_runtime_config add column if not exists live_purchase_scope text not null default 'allowlist';
alter table public.billing_runtime_config drop constraint if exists billing_runtime_config_live_scope_check;
alter table public.billing_runtime_config add constraint billing_runtime_config_live_scope_check
  check (live_purchase_scope in ('allowlist', 'all'));

create table if not exists public.billing_live_purchase_allowlist (
  company_id uuid primary key references public.companies(id) on delete cascade,
  note text null,
  added_at timestamptz not null default now(),
  constraint billing_live_purchase_allowlist_note_check check (note is null or length(note) <= 200)
);
comment on table public.billing_live_purchase_allowlist is
  'S15b: firmy, ktoré smú pri billing_runtime_config.live_purchase_scope = allowlist vytvoriť LIVE nákup. Service-only.';
alter table public.billing_live_purchase_allowlist enable row level security;
revoke all on table public.billing_live_purchase_allowlist from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.billing_live_purchase_allowlist to service_role;

create or replace function public.esblu_billing_live_purchase_allowed(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select case
    when c.environment <> 'live' then true
    when c.live_purchase_scope = 'all' then true
    else exists (select 1 from public.billing_live_purchase_allowlist l where l.company_id = p_company_id)
  end
  from public.billing_runtime_config c where c.id
$function$;
revoke all on function public.esblu_billing_live_purchase_allowed(uuid) from public, anon, authenticated;
grant execute on function public.esblu_billing_live_purchase_allowed(uuid) to service_role;

create or replace function public.esblu_billing_my_live_purchase_allowed()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(public.esblu_billing_live_purchase_allowed(nullif(public.esblu_billing_my_access() ->> 'company_id', '')::uuid), false)
$function$;
revoke all on function public.esblu_billing_my_live_purchase_allowed() from public, anon;
grant execute on function public.esblu_billing_my_live_purchase_allowed() to authenticated, service_role;

create or replace function public.esblu_billing_checkout_live_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.environment = 'live'
     and (tg_op = 'INSERT' or new.provider_session_id is distinct from old.provider_session_id)
     and not coalesce(public.esblu_billing_live_purchase_allowed(new.company_id), false) then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_LIVE_NOT_ALLOWED';
  end if;
  return new;
end
$function$;
revoke all on function public.esblu_billing_checkout_live_guard() from public, anon, authenticated, service_role;

drop trigger if exists esblu_billing_checkout_live_guard on public.billing_checkout_sessions;
create trigger esblu_billing_checkout_live_guard
  before insert or update of provider_session_id on public.billing_checkout_sessions
  for each row execute function public.esblu_billing_checkout_live_guard();
