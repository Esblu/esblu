-- Rollback 20261120100000_internal_operator_entitlement (staging/produkcia iba so súhlasom).
--
-- Vráti VŠETKY zmeny migrácie:
--   1) interné nároky (external_ref 'internal_operator_grant:<id>') → status 'revoked'
--      (riadky sa nemažú — história ostáva, resolver ich ignoruje; rovnaký model
--      ako billing downgrade), legacy companies.plan 'admin' → 'free' pre firmy
--      s aktívnym interným grantom,
--   2) triggery esblu_internal_grant_marker_guard / esblu_internal_grant_catalog_sync,
--   3) funkcie esblu_operator_grant_internal_plan, esblu_operator_revoke_internal_plan,
--      esblu_internal_grant_marker_guard, esblu_internal_grant_catalog_sync
--      (ich ACL zaniká s nimi),
--   4) tabuľku internal_operator_grants (index + RLS + granty zaniknú s ňou).
--
-- POZOR: tabuľka internal_operator_grants je auditný záznam. Pred rollbackom
-- v produkcii ju aj tak exportovať:  select * from public.internal_operator_grants;
-- Ochrana auditu (2026-11-19, ops/esblu8-readiness): tabuľka sa ZMAŽE iba vtedy,
-- keď je prázdna. Ak obsahuje riadky, NEmaže sa — presunie sa (aj s indexmi)
-- do neexponovanej schémy esblu_audit_archive pod názvom
-- internal_operator_grants_rb_<UTC timestamp> (bez prístupu anon/authenticated/
-- service_role). Opätovná forward migrácia potom vytvorí novú prázdnu tabuľku
-- v public bez kolízie názvov. Archív sa maže iba samostatným schváleným krokom.
--
-- Stripe/billing migrácie (20261118120000 – 20261119140000) a ich rollbacky sa
-- týchto objektov nedotýkajú; billing pracuje iba so source = 'subscription'.
-- Rollback nemení company_entitlements schému, CHECK-y ani billing funkcie.
-- Idempotentné (if exists / to_regclass) — dá sa spustiť opakovane.
begin;

do $$
begin
  if to_regclass('public.internal_operator_grants') is not null then
    -- Odvolanie počas existencie guard triggera je povolené (status <> 'active').
    update public.company_entitlements e
       set status = 'revoked'
     where e.source = 'manual'
       and e.external_ref like 'internal_operator_grant:%'
       and e.status <> 'revoked';

    update public.companies c
       set plan = 'free'
     where c.plan = 'admin'
       and c.id in (select g.company_id from public.internal_operator_grants g
                    where g.revoked_at is null and g.company_id is not null);
  end if;
end
$$;

drop trigger if exists esblu_internal_grant_catalog_sync on public.entitlement_catalog;
drop trigger if exists esblu_internal_grant_marker_guard on public.company_entitlements;

drop function if exists public.esblu_operator_grant_internal_plan(uuid, uuid, text, text);
drop function if exists public.esblu_operator_revoke_internal_plan(uuid, text);
drop function if exists public.esblu_internal_grant_catalog_sync();
drop function if exists public.esblu_internal_grant_marker_guard();

-- Auditná tabuľka: prázdna → drop; neprázdna → archív (nikdy nemazať audit).
do $$
declare
  v_rows bigint;
  v_name text;
begin
  if to_regclass('public.internal_operator_grants') is null then
    return;
  end if;
  execute 'select count(*) from public.internal_operator_grants' into v_rows;
  if v_rows = 0 then
    execute 'drop table public.internal_operator_grants';
    return;
  end if;
  v_name := 'internal_operator_grants_rb_' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
  execute 'create schema if not exists esblu_audit_archive';
  execute 'revoke all on schema esblu_audit_archive from public, anon, authenticated, service_role';
  execute format('alter table public.internal_operator_grants rename to %I', v_name);
  execute format('alter table public.%I set schema esblu_audit_archive', v_name);
  execute format('revoke all on table esblu_audit_archive.%I from public, anon, authenticated, service_role', v_name);
  raise notice 'internal_operator_grants (% riadkov) archivovaná ako esblu_audit_archive.% (nezmazaná)', v_rows, v_name;
end
$$;

commit;
