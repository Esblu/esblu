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
-- v produkcii ju exportovať:  select * from public.internal_operator_grants;
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

drop table if exists public.internal_operator_grants;

commit;
