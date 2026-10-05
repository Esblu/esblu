-- =============================================================================
-- E-Faktúra — STAGING E2E cleanup. IBA esblu-test. Idempotentné, nedeštruktívne.
--
-- Finalizované faktúry, odoslané/prijaté UBL a dôkazy doručenia sú v Esblu
-- zámerne nemenné (triggre) — syntetické záznamy E2E ostávajú ako dôkaz testu.
-- Cleanup ich iba „vypne": rollout firiem A/B → paused (worker/route ich
-- nespracujú), beta allowlist syntetických e-mailov → revoked.
-- Driver route sa vypína v Vercel env (ESBLU_STAGING_E2E_ENABLED ≠ true → 404).
-- =============================================================================
begin;
do $guard$
begin
  if to_regclass('esblu_l3.target') is null
     or not exists (select 1 from esblu_l3.target where ref = 'cjbdijbbcujvmrzezusd')
     or exists (select 1 from esblu_l3.target where ref = 'fkpgvgvsmbpieduoatrt') then
    raise exception 'E2E_GUARD_STOP: toto nie je staging esblu-test';
  end if;
end
$guard$;
update public.einvoice_rollout set stage = 'paused', note = 'einvoice staging E2E — cleanup', changed_by = 'staging-e2e-cleanup'
where company_id in ('e2e5a000-0000-4000-8000-00000000000a', 'e2e5a000-0000-4000-8000-00000000000b')
  and environment = 'sandbox' and stage <> 'paused';
update public.beta_allowlist set revoked_at = now()
where email in ('e2e-partner-a@example.com', 'e2e-partner-b@example.com') and revoked_at is null;
commit;
