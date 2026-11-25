-- =============================================================================
-- P1-5 skupina D — test kritických alertov cleanupu (VŽDY ROLLBACK; spúšťa Claude až po schválení kroku D-A).
-- Spustiť AŽ keď existuje dokončené ukončenie T2 s jobom (po kroku D-T2). Nič sa trvalo nezmení.
--   1. vyčerpané pokusy: job T2 pending + attempts = 30 → esblu_cleanup_health.exhausted = 1 (cron: alert + HTTP 503)
--   2. neoverený výmaz > 24 h: ukončenie T2 completed bez storage_purged_at a completed_at − 25 h → termination_unpurged_24h = 1
--   3. ochrana: zápis „done“ mimo DB overenia → ESBLU_CLEANUP_UNVERIFIED; pridanie cudzieho cieľa → ESBLU_CLEANUP_*
-- =============================================================================
begin;
create temp table _r(k text, v text) on commit drop;
do $$
declare
  v_term public.company_terminations;
  v_job uuid;
  r text;
begin
  select * into v_term from public.company_terminations
   where company_id = 'f1510000-0000-4000-8000-000000000002' and status = 'completed' and termination_mode = 'customer_delete'
   order by completed_at desc limit 1;
  if v_term.id is null then raise exception 'T2 ešte nie je ukončená — test nespúšťať'; end if;
  v_job := v_term.cleanup_job_id;
  insert into _r values ('baseline', (public.esblu_cleanup_health(30))::text);

  -- 1 vyčerpané pokusy (stav storage sa mení IBA cez DB overenie → tu sa mení iba attempts/auth_status)
  update public.account_deletion_cleanup_jobs set attempts = 30, auth_status = 'pending' where id = v_job;
  insert into _r values ('exhausted', (public.esblu_cleanup_health(30)->>'exhausted'));

  -- 2 neoverený výmaz starší ako 24 h
  update public.company_terminations set storage_purged_at = null, completed_at = now() - interval '25 hours' where id = v_term.id;
  insert into _r values ('termination_unpurged_24h', (public.esblu_cleanup_health(30)->>'termination_unpurged_24h'));

  -- 3 poistky jobu ukončenia
  begin
    update public.account_deletion_cleanup_jobs set storage_status = 'pending' where id = v_job;
    update public.account_deletion_cleanup_jobs set storage_status = 'done' where id = v_job;
    r := 'ALLOWED';
  exception when others then r := sqlerrm; end;
  insert into _r values ('manual_done', r);
  begin
    update public.account_deletion_cleanup_jobs
       set storage_targets = coalesce(storage_targets, '[]'::jsonb) || '[{"bucket":"einvoice-documents","path":"f1510000-0000-4000-8000-000000000003/x.xml"}]'::jsonb
     where id = v_job;
    r := 'ALLOWED';
  exception when others then r := sqlerrm; end;
  insert into _r values ('foreign_target', r);
  begin
    update public.account_deletion_cleanup_jobs
       set storage_targets = '[{"bucket":"billing-documents","path":"x.pdf"}]'::jsonb where id = v_job;
    r := 'ALLOWED';
  exception when others then r := sqlerrm; end;
  insert into _r values ('billing_target', r);
end $$;
select * from _r;
rollback;
-- Očakávané: exhausted = 1, termination_unpurged_24h = 1, manual_done = ESBLU_CLEANUP_UNVERIFIED,
-- foreign_target = ESBLU_CLEANUP_TARGET_PROTECTED alebo ESBLU_CLEANUP_TARGETS_IMMUTABLE, billing_target = ESBLU_CLEANUP_TARGET_PROTECTED.
-- Alert v appke: /api/cron/account-deletion-cleanup pri exhausted/unpurged > 0 → [account-deletion-alert] severity critical + HTTP 503
-- (offline test: npm run test:account-deletion-orchestration).
