-- =============================================================================
-- ROLLBACK 20261117100000_open_public_registration
--
-- POZOR: na bežný návrat k uzavretej registrácii tento súbor NETREBA —
-- stačí prepnúť politiku (okamžite, bez deployu):
--   update public.registration_policy
--      set mode = 'closed_beta', updated_at = now(), note = '<dôvod>'
--    where id;
--
-- Tento súbor vráti SCHÉMU do stavu pred migráciou: obe funkcie na presné
-- produkčné definície overené 2026-11-17 (hook vrátane Google invite vetvy
-- z 20260927120000; ensure_my_owner_company z 20261012160000) a odstráni
-- registration_policy + helper. Bez vplyvu na dáta zákazníkov.
-- Pozn.: produkčný hook mal pred migráciou Google vetvu; staging ju nemal
-- (drift) — po rollbacku majú obe prostredia produkčnú verziu.
-- =============================================================================
begin;

create or replace function public.esblu_before_user_created_beta_gate(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_email text;
  v_invite_token text;
  v_token_hash text;
  v_invite_valid boolean;
  v_beta_allowed boolean;
  v_provider text;
begin
  v_email := lower(btrim(coalesce(event->'user'->>'email', '')));

  if v_email = '' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 400,
        'message', 'Chýba e-mailová adresa.'
      )
    );
  end if;

  v_invite_token := btrim(coalesce(
    event #>> '{user,user_metadata,esblu_invite_token}', ''
  ));

  if v_invite_token <> '' then
    v_token_hash := encode(extensions.digest(v_invite_token, 'sha256'), 'hex');

    select exists (
      select 1
      from public.company_invites ci
      where ci.token_hash = v_token_hash
        and ci.status = 'pending'
        and ci.expires_at > now()
        and ci.email = v_email
    ) into v_invite_valid;

    if v_invite_valid then
      return '{}'::jsonb;
    end if;
  end if;

  v_provider := lower(btrim(coalesce(event #>> '{user,app_metadata,provider}', '')));

  if v_provider = 'google' then
    select exists (
      select 1
      from public.company_invites ci
      where ci.status = 'pending'
        and ci.expires_at > now()
        and ci.email = v_email
    ) into v_invite_valid;

    if v_invite_valid then
      return '{}'::jsonb;
    end if;
  end if;

  select exists (
    select 1
    from public.beta_allowlist ba
    where ba.email = v_email
      and ba.revoked_at is null
      and ba.consumed_at is null
  ) into v_beta_allowed;

  if v_beta_allowed then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Esblu je momentálne v uzavretej beta verzii. Ak máte schválený beta prístup, kontaktujte nás na info@esblu.com.'
    )
  );
end;
$function$;

revoke all on function public.esblu_before_user_created_beta_gate(jsonb) from public, anon, authenticated;
grant execute on function public.esblu_before_user_created_beta_gate(jsonb) to supabase_auth_admin;

create or replace function public.esblu_ensure_my_owner_company()
returns table(company_id uuid, role text, created boolean)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_email text;
  v_existing record;
  v_company_id uuid;
  v_company_name text;
  v_beta_allowed boolean;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  select m.company_id, m.role into v_existing
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active'
  order by (m.company_id = public.esblu_my_active_company_id()) desc nulls last, m.created_at, m.company_id
  limit 1;

  if found then
    return query select v_existing.company_id, v_existing.role, false;
    return;
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;
  if v_email is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_AUTH_USER_EMAIL_NOT_FOUND';
  end if;
  v_email := lower(btrim(v_email));

  if exists (
    select 1 from public.company_invites ci
    where ci.email = v_email and ci.status = 'pending' and ci.expires_at > now()
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_PENDING_INVITE_EXISTS';
  end if;

  select exists (
    select 1 from public.beta_allowlist ba
    where ba.email = v_email and ba.revoked_at is null and ba.consumed_at is null
  ) into v_beta_allowed;

  if not v_beta_allowed then
    raise exception using errcode = '42501', message = 'ESBLU_BETA_ACCESS_REQUIRED';
  end if;

  select coalesce(nullif(btrim(s.company_name), ''), 'Moja firma') into v_company_name
  from public.settings s where s.user_id = v_uid;
  v_company_name := coalesce(v_company_name, 'Moja firma');

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':create_company', 0));

  select m.company_id, m.role into v_existing
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active'
  order by m.created_at, m.company_id
  limit 1;
  if found then
    return query select v_existing.company_id, v_existing.role, false;
    return;
  end if;

  insert into public.companies (owner_id, name) values (v_uid, v_company_name) returning id into v_company_id;
  insert into public.company_members (company_id, user_id, role, status) values (v_company_id, v_uid, 'owner', 'active');
  insert into public.company_billing_profile (company_id, legal_name) values (v_company_id, v_company_name);

  perform public.esblu_set_session_company_internal(v_uid, v_company_id);

  update public.beta_allowlist
  set consumed_at = coalesce(consumed_at, now()), consumed_by = v_uid
  where email = v_email;

  return query select v_company_id, 'owner'::text, true;
end;
$function$;

drop function if exists public.esblu_public_registration_open();
drop table if exists public.registration_policy;

commit;
