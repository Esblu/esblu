-- =============================================================================
-- ROLLBACK pre 20261021100000_explicit_data_api_grants.sql
--
-- Vráti ACL presne do stavu PRED migráciou (overené na stagingu
-- cjbdijbbcujvmrzezusd a read-only na produkcii fkpgvgvsmbpieduoatrt
-- 2026-10-21) — VRÁTANE historicky príliš širokých grantov. Použiť iba ako
-- núdzový krok, ak by explicitné granty rozbili produkčnú cestu; správna
-- oprava je doplniť chýbajúci grant do manifestu a novej migrácie.
--
-- Nemení politiky, RLS, funkcie ani dáta. Idempotentný.
-- Po 2026-10-30 obnova default privileges (sekcia 4) nemusí mať na Supabase
-- trvalý efekt — platforma môže auto-granty vypnúť znova.
-- =============================================================================

-- 1. authenticated: práva, ktoré migrácia odobrala (RLS ich aj tak zamietala).
grant select, insert, update, delete on table public.ai_scan_limits to authenticated;
grant select, insert, update, delete on table public.ai_scan_usage to authenticated;
grant delete on table public.company_billing_profile to authenticated;
grant insert, update, delete on table public.invoice_events to authenticated;
grant insert, update, delete on table public.invoice_number_sequences to authenticated;
grant insert, update, delete on table public.invoice_parties to authenticated;
grant insert, update, delete on table public.invoice_payments to authenticated;
grant insert, update, delete on table public.invoice_tax_breakdowns to authenticated;
grant delete on table public.settings to authenticated;

-- 2. service_role: pôvodne arwdDxtm na každej tabuľke okrem append-only einvoice_events (ar).
do $rollback$
declare
  t record;
begin
  for t in
    select c.oid::regclass as ident, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    if t.relname = 'einvoice_events' then
      execute format('grant select, insert on table %s to service_role', t.ident);
    else
      execute format('grant all on table %s to service_role', t.ident);
    end if;
  end loop;
end
$rollback$;

-- 3. service_role EXECUTE: pôvodne na všetkých funkciách okrem 4 zámerne odobratých.
grant execute on all functions in schema public to service_role;
revoke execute on function public.esblu_einvoice_actor_context(uuid) from service_role;
revoke execute on function public.esblu_einvoice_org_company(text, text, text) from service_role;
revoke execute on function public.esblu_einvoice_outbound_rollout_gate() from service_role;
revoke execute on function public.esblu_received_invoice_draft_core(uuid, uuid, text, text, text, uuid, text, date, jsonb, date, date, date, text, text, text, text, text, text, text, date, uuid, text) from service_role;

-- 4. Default privileges pre rolu postgres v public (stav pred migráciou).
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges for role postgres in schema public
  grant all on tables to service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;
alter default privileges for role postgres in schema public
  grant usage, select, update on sequences to anon, authenticated, service_role;

comment on schema public is
  'Klientske role maju minimalne prava: authenticated DML podla RLS, anon iba SELECT na legal_documents. TRUNCATE/TRIGGER/REFERENCES/MAINTAIN odobrate — TRUNCATE sa RLS nepyta.';
