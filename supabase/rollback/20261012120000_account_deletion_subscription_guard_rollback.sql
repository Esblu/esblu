-- Rollback 20261012120000 (iba staging / po schválení): odstráni DB poistku
-- zrušenia účtu pri aktívnom predplatnom. Dáta sa nemenia. Serverový precheck
-- (lib/billing/deletion-guard.ts) ostáva v kóde.
drop trigger if exists subscription_accounts_delete_guard on public.subscription_accounts;
drop trigger if exists billing_checkout_sessions_delete_guard on public.billing_checkout_sessions;
drop function if exists public.esblu_subscription_account_delete_guard();
drop function if exists public.esblu_checkout_session_delete_guard();
drop function if exists public.esblu_billing_blocks_account_deletion(text, text, boolean);
