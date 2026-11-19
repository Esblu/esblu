-- Rollback 20261122100000_einvoice_mandates (staging/produkcia iba so súhlasom).
-- Poradie rollbacku: 20261122120000 → 20261122110000 → 20261122100000 (deregistrácia volá esblu_einvoice_mandate_revoke).
-- POZOR: po rollbacku sa odosielanie e-faktúr opäť NEVIAŽE na mandát (stav pred 20261122100000).
-- Ochrana dôkazov: einvoice_mandates s riadkami sa NEMAŽE — presunie sa do neexponovanej schémy
-- esblu_audit_archive (einvoice_mandates_rb_<UTC timestamp>) vrátane append-only triggerov.
-- Prázdna tabuľka sa zmaže. Žiadne iné dáta sa nemenia.
begin;
drop trigger if exists esblu_einvoice_outbound_mandate_gate on public.einvoice_outbound;
drop function if exists public.esblu_einvoice_outbound_mandate_gate();
drop trigger if exists esblu_einvoice_org_deactivated_revokes_mandates on public.einvoice_organizations;
drop function if exists public.esblu_einvoice_org_deactivated_revokes_mandates();

-- Claim odosielania späť na 20261002150000 (rollout + nárok, bez mandátu).
create or replace function public.esblu_einvoice_claim_outbound(
  p_mode text,
  p_limit integer,
  p_lease_seconds integer,
  p_reconcile_after_seconds integer default 300
)
returns setof public.einvoice_outbound
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 10);
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900));
  v_after interval := make_interval(secs => greatest(coalesce(p_reconcile_after_seconds, 300), 0));
begin
  if p_mode = 'send' then
    perform set_config('esblu.einvoice_event_source', 'job', true);
    return query
    with c as (
      select e.id from public.einvoice_outbound e
      where e.state in ('queued', 'sending')
        and e.provider_submission_id is null
        and e.next_retry_at is not null and e.next_retry_at <= now()
        and (e.locked_until is null or e.locked_until < now())
        and e.retry_count < 8
        and e.ubl_sha256 is not null and e.ubl_storage_path is not null
        -- Phase 6: rollout allowlist (kill switch) — bez povolenia sa nič neodošle.
        and public.esblu_einvoice_rollout_allowed(e.company_id, e.environment)
        -- Phase 6: po strate nároku sa NEODOŠLE nič, čo ešte neodišlo. Riadok s
        -- neistým výsledkom (už mohol odísť) smie iba zopakovať TEN ISTÝ
        -- Idempotency-Key — poskytovateľ vráti uloženú odpoveď, druhé odoslanie
        -- nevznikne (docs connector: "never sends twice").
        and (
          e.send_in_flight or e.send_outcome_unknown
          or coalesce((public.esblu_resolve_entitlement(e.company_id, 'einvoice') ->> 'active')::boolean, false)
        )
      order by e.next_retry_at, e.created_at
      limit v_limit
      for update skip locked
    )
    update public.einvoice_outbound o
    set state = 'sending',
        retry_count = o.retry_count + 1,
        last_attempt_at = now(),
        locked_until = now() + v_lease,
        -- Pád workera počas pokusu → riadok sa po lease znovu zoberie.
        next_retry_at = now() + v_lease,
        send_outcome_unknown = o.send_outcome_unknown or o.send_in_flight,
        send_in_flight = true
    from c where o.id = c.id
    returning o.*;
    perform set_config('esblu.einvoice_event_source', '', true);
    return;
  end if;

  if p_mode = 'reconcile' then
    perform set_config('esblu.einvoice_event_source', 'reconcile', true);
    return query
    with c as (
      select e.id from public.einvoice_outbound e
      where (e.locked_until is null or e.locked_until < now())
        and (
          (e.provider_submission_id is not null and e.state in ('sending', 'sent', 'deferred')
            and e.updated_at <= now() - v_after)
          or (e.provider_submission_id is null and e.state = 'sending' and e.retry_count >= 8
            and e.next_retry_at is not null)
        )
      order by e.updated_at
      limit v_limit
      for update skip locked
    )
    update public.einvoice_outbound o
    set locked_until = now() + v_lease
    from c where o.id = c.id
    returning o.*;
    perform set_config('esblu.einvoice_event_source', '', true);
    return;
  end if;

  raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INVALID_CLAIM_MODE';
end;
$function$;

revoke all on function public.esblu_einvoice_claim_outbound(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_claim_outbound(text, integer, integer, integer) to service_role;

drop function if exists public.esblu_einvoice_mandate_revoke(uuid, text, text, uuid, text, uuid);
drop function if exists public.esblu_einvoice_mandate_confirm(uuid, text[], text, text, text);
drop function if exists public.esblu_einvoice_mandate_grant(uuid, uuid, text, text[], text, text, text, boolean, text, text, text, text);
drop function if exists public.esblu_einvoice_my_mandate(text);
drop function if exists public.esblu_einvoice_mandate_effective(uuid, text, text);
drop function if exists public.esblu_einvoice_member_finance_manage(uuid, uuid);
-- Prázdna tabuľka: triggery idú preč spolu s ňou. Neprázdna: triggery (append-only) ostávajú pri archíve.
do $$
declare
  v_rows bigint;
  v_name text;
begin
  if to_regclass('public.einvoice_mandates') is null then
    return;
  end if;
  execute 'select count(*) from public.einvoice_mandates' into v_rows;
  if v_rows = 0 then
    execute 'drop table public.einvoice_mandates';
    return;
  end if;
  v_name := 'einvoice_mandates_rb_' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
  execute 'create schema if not exists esblu_audit_archive';
  execute 'revoke all on schema esblu_audit_archive from public, anon, authenticated, service_role';
  execute format('drop policy if exists %I on public.einvoice_mandates', 'einvoice_mandates_select_finance_manage');
  execute format('drop policy if exists %I on public.einvoice_mandates', 'einvoice_mandates_select_finance');
  execute format('alter table public.einvoice_mandates rename to %I', v_name);
  execute format('alter table public.%I set schema esblu_audit_archive', v_name);
  execute format('revoke all on table esblu_audit_archive.%I from public, anon, authenticated, service_role', v_name);
  raise notice 'einvoice_mandates (% riadkov) archivovaná ako esblu_audit_archive.% (nezmazaná)', v_rows, v_name;
end
$$;

-- Guard funkcie sa zmažú iba ak už nie sú použité (prázdna tabuľka bola zmazaná).
do $$
begin
  if to_regclass('public.einvoice_mandates') is null and not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname in ('esblu_einvoice_mandates_guard', 'esblu_einvoice_mandates_no_truncate')
  ) then
    drop function if exists public.esblu_einvoice_mandates_guard();
    drop function if exists public.esblu_einvoice_mandates_no_truncate();
  end if;
end
$$;
commit;
