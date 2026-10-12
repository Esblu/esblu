-- =============================================================================
-- Zrušenie účtu × aktívne predplatné — DB poistka (FORWARD-ONLY, 2026-10-12)
--
-- Medzera: public.esblu_owner_delete_company zmaže firmu a kaskádou
-- (ON DELETE CASCADE) aj subscription_accounts, billing_provider_links a
-- billing_checkout_sessions. Ak predplatné u Stripe / Google Play / App Store
-- stále beží, provider by ďalej účtoval a Esblu by stratilo väzbu.
--
-- Primárne pravidlo vynucuje server PRED mazaním súborov aj DB
-- (lib/billing/deletion-guard.ts, /api/account/preflight + /api/account/delete).
-- Táto migrácia je poistka pre súbeh (nákup medzi precheckom a transakciou)
-- a pre akékoľvek iné mazanie: BEFORE DELETE trigger odmietne zmazať
--   - subscription_accounts riadok, ktorý sa ešte obnovuje / čaká na platbu,
--   - otvorený (created/open, neexpirovaný) checkout,
-- čím sa vráti CELÁ transakcia (vrátane kaskády z companies).
--
-- Predikát = zrkadlo TS classifySubscriptionForDeletion (parita testovaná
-- v scripts/account-deletion-subscription-pglite-tests.ts).
-- Údržba (iba service_role / superuser, vedome):
--   select set_config('esblu.allow_subscription_delete', 'on', true);
-- Nevolá žiadne provider API. Nemaže ani nemení dáta.
-- Rollback: supabase/rollback/20261012120000_account_deletion_subscription_guard_rollback.sql
-- =============================================================================

create or replace function public.esblu_billing_blocks_account_deletion(
  p_status text,
  p_provider text,
  p_cancel_at_period_end boolean
)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select case
    when p_status is null or p_status = 'none' then false
    -- manuálny grant / bez providera = žiadne externé účtovanie
    when p_provider is null or p_provider = 'manual' then false
    when p_provider not in ('stripe', 'google', 'apple', 'fake') then true
    when p_status in ('canceled', 'expired', 'refunded', 'revoked') then false
    -- zaplatené obdobie bez obnovy = provider už neúčtuje
    when p_status in ('active', 'trialing') then not coalesce(p_cancel_at_period_end, false)
    -- pending / incomplete / grace_period / past_due / account_hold / unpaid / paused / neznámy
    else true
  end
$function$;

comment on function public.esblu_billing_blocks_account_deletion(text, text, boolean) is
  'TRUE = externé predplatné sa obnovuje alebo čaká na platbu → firmu/účet nemožno zrušiť. '
  'Zrkadlo lib/billing/deletion-guard.ts (classifySubscriptionForDeletion).';

revoke all on function public.esblu_billing_blocks_account_deletion(text, text, boolean) from public, anon, authenticated;
grant execute on function public.esblu_billing_blocks_account_deletion(text, text, boolean) to service_role;

create or replace function public.esblu_subscription_account_delete_guard()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if public.esblu_billing_blocks_account_deletion(old.status, old.billing_provider, old.cancel_at_period_end)
     and coalesce(current_setting('esblu.allow_subscription_delete', true), '') <> 'on' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_ACTIVE_SUBSCRIPTION_BLOCKS_DELETION',
      hint = 'Predplatné firmy sa obnovuje alebo čaká na platbu u providera — najprv ho treba ukončiť (Stripe / Google Play / App Store).';
  end if;
  return old;
end
$function$;

create or replace function public.esblu_checkout_session_delete_guard()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if old.status in ('created', 'open')
     and old.expires_at > now()
     and coalesce(current_setting('esblu.allow_subscription_delete', true), '') <> 'on' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_CHECKOUT_IN_PROGRESS_BLOCKS_DELETION',
      hint = 'Prebieha nákup predplatného — platba by mohla prebehnúť po zmazaní firmy.';
  end if;
  return old;
end
$function$;

revoke all on function public.esblu_subscription_account_delete_guard() from public, anon, authenticated;
revoke all on function public.esblu_checkout_session_delete_guard() from public, anon, authenticated;

drop trigger if exists subscription_accounts_delete_guard on public.subscription_accounts;
create trigger subscription_accounts_delete_guard
  before delete on public.subscription_accounts
  for each row execute function public.esblu_subscription_account_delete_guard();

drop trigger if exists billing_checkout_sessions_delete_guard on public.billing_checkout_sessions;
create trigger billing_checkout_sessions_delete_guard
  before delete on public.billing_checkout_sessions
  for each row execute function public.esblu_checkout_session_delete_guard();
