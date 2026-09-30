-- =============================================================================
-- Push notifikácie — natívne zariadenia (Android FCM / iOS APNs), väzba na
-- auth session, jazyk zariadenia a serverové RPC (2026-10-01).
--
-- STAV: NAVRHNUTÉ, NEAPLIKOVANÉ. Aplikovať iba po výslovnom schválení cez
-- Supabase MCP apply_migration (assetpilot / fkpgvgvsmbpieduoatrt), IHNEĎ PO
-- 20260927110000_push_notifications.sql. Nikdy nie `supabase db push`.
-- ZÁVISLOSTI: 20260927110000 (push tabuľky), 20260930150000 (M1 Human Chat
-- membership — direct_user_low/high), esblu_my_active_company_id().
--
-- ČO PRIBÚDA
-- ----------
-- 1. push_subscriptions (web push) + auth_session_id, locale, revoke_reason.
-- 2. push_devices — natívne tokeny (provider fcm|apns, platform android|ios),
--    viazané na používateľa, firmu, inštaláciu appky a auth session.
--    Viac zariadení na používateľa = viac riadkov; jedna inštalácia má
--    najviac jeden aktívny riadok (token refresh nahradí starý token).
-- 3. RPC pre prihláseného používateľa (authenticated, SECURITY DEFINER):
--    registrácia/odhlásenie zariadenia, predvoľby, zoznam vlastných zariadení.
--    Používateľ, firma aj session sa berú VÝHRADNE z JWT (auth.uid(),
--    session_id) a z aktívneho členstva — nikdy z parametrov.
-- 4. RPC iba pre server (service_role): ciele doručenia, príjemcovia
--    chatovej správy podľa M1 modelu, výsledok doručenia, upratanie
--    zariadení po skončenej session / členstve.
--
-- BEZPEČNOSŤ
-- ----------
-- - Tabuľky ostávajú bez priameho prístupu klienta (RLS zapnuté, žiadne
--   politiky, žiadne granty pre anon/authenticated) — rovnako ako 20260927110000.
-- - Zariadenie sa doručuje IBA ak: nie je zrušené, jeho auth session ešte
--   existuje (auth.sessions, not_after), a používateľ je stále AKTÍVNYM
--   členom TEJ ISTEJ firmy. Odhlásenie, „odhlásiť všade", reset hesla aj
--   odobratie z firmy teda doručovanie okamžite zastavia (aj keď appka
--   nestihla token odregistrovať).
-- - Token iného používateľa sa neprevezme (conflict), s jedinou výnimkou:
--   tá istá inštalácia appky (iný používateľ sa prihlásil na tom istom
--   zariadení). Web endpoint iného aktívneho používateľa sa neprevezme nikdy.
-- - Žiadne URL v DB — obsah a cieľ notifikácie skladá server z allowlistu.
--
-- ROLLBACK (dáta sú iba technické tokeny):
--   drop function public.esblu_push_register_device(text, text, text, uuid, text, text);
--   drop function public.esblu_push_unregister_device(uuid, text);
--   drop function public.esblu_push_register_web(text, text, text, text, text);
--   drop function public.esblu_push_unregister_web(text);
--   drop function public.esblu_push_get_my_preferences();
--   drop function public.esblu_push_set_my_preferences(boolean, boolean, boolean, integer[]);
--   drop function public.esblu_push_my_devices();
--   drop function public.esblu_push_delivery_targets(uuid, uuid[]);
--   drop function public.esblu_push_companies_with_targets();
--   drop function public.esblu_push_chat_recipients(uuid);
--   drop function public.esblu_push_record_outcome(text, uuid, text);
--   drop function public.esblu_push_revoke_ended();
--   drop table public.push_devices;
--   alter table public.push_subscriptions drop column auth_session_id,
--     drop column locale, drop column updated_at, drop column revoke_reason;
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.push_subscriptions') is null then
    raise exception 'Najprv aplikuj 20260927110000_push_notifications.sql';
  end if;
end;
$$;

-- 1) Web push: session, jazyk, dôvod zrušenia ---------------------------------------
alter table public.push_subscriptions add column if not exists auth_session_id uuid;
alter table public.push_subscriptions add column if not exists locale text not null default 'sk';
alter table public.push_subscriptions add column if not exists updated_at timestamptz not null default now();
alter table public.push_subscriptions add column if not exists revoke_reason text;

alter table public.push_subscriptions drop constraint if exists push_subscriptions_locale_check;
alter table public.push_subscriptions add constraint push_subscriptions_locale_check check (locale in ('sk', 'de', 'en'));
alter table public.push_subscriptions drop constraint if exists push_subscriptions_revoke_reason_check;
alter table public.push_subscriptions add constraint push_subscriptions_revoke_reason_check check (
  revoke_reason is null or revoke_reason in ('unregistered', 'invalid_token', 'replaced', 'session_ended', 'membership_ended', 'taken_over')
);

create index if not exists push_subscriptions_session_idx
  on public.push_subscriptions (auth_session_id) where revoked_at is null;

-- 2) Natívne zariadenia -------------------------------------------------------------
create table if not exists public.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null,
  platform text not null,
  token text not null,
  -- Náhodné UUID inštalácie appky (generuje appka, lokálne úložisko).
  installation_id uuid not null,
  auth_session_id uuid,
  locale text not null default 'sk',
  app_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_success_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  constraint push_devices_provider_check check (provider in ('fcm', 'apns')),
  constraint push_devices_platform_check check (platform in ('android', 'ios')),
  constraint push_devices_provider_platform check (
    (provider = 'fcm' and platform in ('android', 'ios')) or (provider = 'apns' and platform = 'ios')
  ),
  constraint push_devices_token_shape check (length(token) between 32 and 4096 and token ~ '^[A-Za-z0-9:_.-]+$'),
  constraint push_devices_locale_check check (locale in ('sk', 'de', 'en')),
  constraint push_devices_app_version_shape check (app_version is null or app_version ~ '^[A-Za-z0-9._+-]{1,40}$'),
  constraint push_devices_revoke_reason_check check (
    revoke_reason is null or revoke_reason in ('unregistered', 'invalid_token', 'replaced', 'session_ended', 'membership_ended', 'taken_over')
  ),
  constraint push_devices_token_unique unique (provider, token)
);

create unique index if not exists push_devices_active_installation_idx
  on public.push_devices (installation_id) where revoked_at is null;
create index if not exists push_devices_company_user_idx
  on public.push_devices (company_id, user_id) where revoked_at is null;
create index if not exists push_devices_session_idx
  on public.push_devices (auth_session_id) where revoked_at is null;

alter table public.push_devices enable row level security;
revoke all on public.push_devices from public, anon, authenticated;
grant select, insert, update, delete on public.push_devices to service_role;

-- 3) Pomocník: session z JWT (nikdy z parametra) ------------------------------------
create or replace function public.esblu_push_current_session_id()
returns uuid
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_raw text := nullif(auth.jwt() ->> 'session_id', '');
begin
  if v_raw is null or v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v_raw::uuid;
end;
$function$;
revoke all on function public.esblu_push_current_session_id() from public, anon, authenticated;

-- 4) Registrácia natívneho zariadenia (authenticated) --------------------------------
--    Výsledok: 'registered' (nové), 'refreshed' (to isté/obnovené),
--    'conflict' (aktívny token iného používateľa z inej inštalácie).
create or replace function public.esblu_push_register_device(
  p_provider text,
  p_platform text,
  p_token text,
  p_installation_id uuid,
  p_locale text,
  p_app_version text default null
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_session_id uuid;
  v_existing public.push_devices;
  v_locale text := case when p_locale in ('sk', 'de', 'en') then p_locale else 'sk' end;
  v_version text := nullif(btrim(coalesce(p_app_version, '')), '');
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  v_session_id := public.esblu_push_current_session_id();
  if v_session_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_PUSH_SESSION_REQUIRED';
  end if;
  if p_provider is null or p_platform is null or p_token is null or p_installation_id is null
     or p_provider not in ('fcm', 'apns') or p_platform not in ('android', 'ios')
     or not ((p_provider = 'fcm' and p_platform in ('android', 'ios')) or (p_provider = 'apns' and p_platform = 'ios'))
     or length(p_token) not between 32 and 4096 or p_token !~ '^[A-Za-z0-9:_.-]+$'
     or (v_version is not null and v_version !~ '^[A-Za-z0-9._+-]{1,40}$') then
    raise exception using errcode = '22023', message = 'ESBLU_PUSH_INVALID_DEVICE';
  end if;

  -- Serializácia súbehov na ten istý token a tú istú inštaláciu.
  perform pg_advisory_xact_lock(hashtextextended('esblu_push_token:' || p_provider || ':' || p_token, 0));
  perform pg_advisory_xact_lock(hashtextextended('esblu_push_install:' || p_installation_id::text, 0));

  select * into v_existing
  from public.push_devices d
  where d.provider = p_provider and d.token = p_token
  for update;

  if v_existing.id is not null and v_existing.user_id <> v_uid and v_existing.revoked_at is null
     and v_existing.installation_id <> p_installation_id then
    -- Cudzí aktívny token z inej inštalácie: neprevezme sa, bez prezradenia vlastníka.
    return 'conflict';
  end if;

  -- Token refresh / nový token tej istej inštalácie: starý aktívny riadok zaniká.
  update public.push_devices d
     set revoked_at = now(), revoke_reason = 'replaced', updated_at = now()
   where d.installation_id = p_installation_id
     and d.revoked_at is null
     and (v_existing.id is null or d.id <> v_existing.id);

  if v_existing.id is not null then
    update public.push_devices d
       set user_id = v_uid,
           company_id = v_company_id,
           platform = p_platform,
           installation_id = p_installation_id,
           auth_session_id = v_session_id,
           locale = v_locale,
           app_version = v_version,
           updated_at = now(),
           last_seen_at = now(),
           revoked_at = null,
           revoke_reason = null
     where d.id = v_existing.id;
    return 'refreshed';
  end if;

  insert into public.push_devices (user_id, company_id, provider, platform, token, installation_id, auth_session_id, locale, app_version)
  values (v_uid, v_company_id, p_provider, p_platform, p_token, p_installation_id, v_session_id, v_locale, v_version);
  return 'registered';
end;
$function$;
revoke all on function public.esblu_push_register_device(text, text, text, uuid, text, text) from public, anon;
grant execute on function public.esblu_push_register_device(text, text, text, uuid, text, text) to authenticated;

-- 5) Odhlásenie natívneho zariadenia (iba vlastné riadky) ----------------------------
create or replace function public.esblu_push_unregister_device(p_installation_id uuid, p_token text default null)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  if p_installation_id is null and p_token is null then
    return 0;
  end if;
  update public.push_devices d
     set revoked_at = now(), revoke_reason = 'unregistered', updated_at = now()
   where d.user_id = v_uid
     and d.revoked_at is null
     and (d.installation_id = p_installation_id or (p_token is not null and d.token = p_token));
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
revoke all on function public.esblu_push_unregister_device(uuid, text) from public, anon;
grant execute on function public.esblu_push_unregister_device(uuid, text) to authenticated;

-- 6) Web push registrácia (nahrádza priamy service-role zápis v route) -----------------
create or replace function public.esblu_push_register_web(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_locale text,
  p_user_agent text default null
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_session_id uuid;
  v_existing public.push_subscriptions;
  v_locale text := case when p_locale in ('sk', 'de', 'en') then p_locale else 'sk' end;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  v_session_id := public.esblu_push_current_session_id();
  if v_session_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_PUSH_SESSION_REQUIRED';
  end if;
  if p_endpoint is null or p_endpoint !~ '^https://[^[:space:]]+$' or length(p_endpoint) > 2048
     or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{40,200}$'
     or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{10,100}$' then
    raise exception using errcode = '22023', message = 'ESBLU_PUSH_INVALID_DEVICE';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('esblu_push_endpoint:' || p_endpoint, 0));

  select * into v_existing from public.push_subscriptions s where s.endpoint = p_endpoint for update;

  if found and v_existing.user_id <> v_uid and v_existing.revoked_at is null then
    return 'conflict';
  end if;

  if found then
    update public.push_subscriptions s
       set user_id = v_uid,
           company_id = v_company_id,
           p256dh = p_p256dh,
           auth_secret = p_auth,
           auth_session_id = v_session_id,
           locale = v_locale,
           user_agent = left(coalesce(p_user_agent, ''), 300),
           updated_at = now(),
           revoked_at = null,
           revoke_reason = null
     where s.id = v_existing.id;
    return 'refreshed';
  end if;

  insert into public.push_subscriptions (user_id, company_id, endpoint, p256dh, auth_secret, user_agent, auth_session_id, locale)
  values (v_uid, v_company_id, p_endpoint, p_p256dh, p_auth, left(coalesce(p_user_agent, ''), 300), v_session_id, v_locale);
  return 'registered';
end;
$function$;
revoke all on function public.esblu_push_register_web(text, text, text, text, text) from public, anon;
grant execute on function public.esblu_push_register_web(text, text, text, text, text) to authenticated;

create or replace function public.esblu_push_unregister_web(p_endpoint text)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  update public.push_subscriptions s
     set revoked_at = now(), revoke_reason = 'unregistered', updated_at = now()
   where s.endpoint = p_endpoint and s.user_id = v_uid and s.revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
revoke all on function public.esblu_push_unregister_web(text) from public, anon;
grant execute on function public.esblu_push_unregister_web(text) to authenticated;

-- 7) Predvoľby (vlastné, v aktívnej firme) -------------------------------------------
create or replace function public.esblu_push_get_my_preferences()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid := public.esblu_my_active_company_id();
  v_row public.notification_preferences;
begin
  if v_uid is null or v_company_id is null then
    return null;
  end if;
  select * into v_row from public.notification_preferences p where p.user_id = v_uid and p.company_id = v_company_id;
  if not found then
    return jsonb_build_object('chat_enabled', true, 'deadlines_enabled', true, 'show_message_preview', false, 'deadline_days', jsonb_build_array(30, 7, 1, 0));
  end if;
  return jsonb_build_object(
    'chat_enabled', v_row.chat_enabled,
    'deadlines_enabled', v_row.deadlines_enabled,
    'show_message_preview', v_row.show_message_preview,
    'deadline_days', to_jsonb(v_row.deadline_days)
  );
end;
$function$;
revoke all on function public.esblu_push_get_my_preferences() from public, anon;
grant execute on function public.esblu_push_get_my_preferences() to authenticated;

create or replace function public.esblu_push_set_my_preferences(
  p_chat_enabled boolean,
  p_deadlines_enabled boolean,
  p_show_message_preview boolean,
  p_deadline_days integer[]
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_days integer[];
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;
  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;
  -- NULL prvky sa zahodia: CHECK notification_preferences_days_range by ich
  -- prepustil (0 <= all (array[null]) je NULL, nie false).
  select coalesce(array_agg(distinct d order by d desc), array[]::integer[]) into v_days
  from unnest(coalesce(p_deadline_days, array[30, 7, 1, 0])) d
  where d is not null;
  insert into public.notification_preferences (user_id, company_id, chat_enabled, deadlines_enabled, show_message_preview, deadline_days, updated_at)
  values (v_uid, v_company_id, coalesce(p_chat_enabled, true), coalesce(p_deadlines_enabled, true), coalesce(p_show_message_preview, false), v_days, now())
  on conflict (user_id, company_id) do update
    set chat_enabled = excluded.chat_enabled,
        deadlines_enabled = excluded.deadlines_enabled,
        show_message_preview = excluded.show_message_preview,
        deadline_days = excluded.deadline_days,
        updated_at = now();
end;
$function$;
revoke all on function public.esblu_push_set_my_preferences(boolean, boolean, boolean, integer[]) from public, anon;
grant execute on function public.esblu_push_set_my_preferences(boolean, boolean, boolean, integer[]) to authenticated;

-- 8) Vlastné zariadenia (bez tokenov/endpointov) -------------------------------------
create or replace function public.esblu_push_my_devices()
returns table(device_id uuid, kind text, platform text, created_at timestamptz, last_seen_at timestamptz, current_session boolean)
language sql
stable
security definer
set search_path to ''
as $function$
  select d.id, d.provider, d.platform, d.created_at, d.last_seen_at,
         d.auth_session_id is not distinct from public.esblu_push_current_session_id()
  from public.push_devices d
  where d.user_id = auth.uid() and d.company_id = public.esblu_my_active_company_id() and d.revoked_at is null
  union all
  select s.id, 'webpush', 'web', s.created_at, s.updated_at,
         s.auth_session_id is not distinct from public.esblu_push_current_session_id()
  from public.push_subscriptions s
  where s.user_id = auth.uid() and s.company_id = public.esblu_my_active_company_id() and s.revoked_at is null
$function$;
revoke all on function public.esblu_push_my_devices() from public, anon;
grant execute on function public.esblu_push_my_devices() to authenticated;

-- 9) SERVER (service_role): ciele doručenia ------------------------------------------
--    Iba nezrušené zariadenia so ŽIVOU session a AKTÍVNYM členstvom v tej istej firme.
create or replace function public.esblu_push_delivery_targets(p_company_id uuid, p_user_ids uuid[])
returns table(target_kind text, target_id uuid, user_id uuid, platform text, locale text, endpoint text, p256dh text, auth_secret text, token text)
language sql
stable
security definer
set search_path to ''
as $function$
  with live as (
    select cm.user_id
    from public.company_members cm
    where cm.company_id = p_company_id and cm.status = 'active' and cm.user_id = any (p_user_ids)
  )
  select 'webpush'::text, s.id, s.user_id, 'web'::text, s.locale, s.endpoint, s.p256dh, s.auth_secret, null::text
  from public.push_subscriptions s
  join live on live.user_id = s.user_id
  where s.company_id = p_company_id
    and s.revoked_at is null
    and s.auth_session_id is not null
    and exists (
      select 1 from auth.sessions a
      where a.id = s.auth_session_id and a.user_id = s.user_id and (a.not_after is null or a.not_after > now())
    )
  union all
  select d.provider, d.id, d.user_id, d.platform, d.locale, null, null, null, d.token
  from public.push_devices d
  join live on live.user_id = d.user_id
  where d.company_id = p_company_id
    and d.revoked_at is null
    and d.auth_session_id is not null
    and exists (
      select 1 from auth.sessions a
      where a.id = d.auth_session_id and a.user_id = d.user_id and (a.not_after is null or a.not_after > now())
    )
$function$;
revoke all on function public.esblu_push_delivery_targets(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.esblu_push_delivery_targets(uuid, uuid[]) to service_role;

create or replace function public.esblu_push_companies_with_targets()
returns setof uuid
language sql
stable
security definer
set search_path to ''
as $function$
  select distinct s.company_id from public.push_subscriptions s where s.revoked_at is null and s.auth_session_id is not null
  union
  select distinct d.company_id from public.push_devices d where d.revoked_at is null and d.auth_session_id is not null
$function$;
revoke all on function public.esblu_push_companies_with_targets() from public, anon, authenticated;
grant execute on function public.esblu_push_companies_with_targets() to service_role;

-- 10) SERVER: príjemcovia chatovej správy podľa M1 membership modelu -------------------
--     Rovnaké pravidlá ako esblu_chat_can_access_conversation, ale pre každého
--     aktívneho člena firmy (nie pre volajúceho): firemný kanál → všetci
--     aktívni členovia; direct → iba direct_user_low/high s riadkom členstva
--     v tej istej firme. Bez autora. AI oprávnenia sa neberú do úvahy.
create or replace function public.esblu_push_chat_recipients(p_message_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path to ''
as $function$
  select cm.user_id
  from public.chat_messages m
  join public.chat_conversations c on c.id = m.conversation_id and c.company_id = m.company_id
  join public.company_members cm on cm.company_id = m.company_id and cm.status = 'active'
  where m.id = p_message_id
    and m.deleted_at is null
    and cm.user_id is distinct from m.author_id
    and (
      c.type = 'company'
      or (
        c.type = 'direct'
        and cm.user_id in (c.direct_user_low, c.direct_user_high)
        and exists (
          select 1 from public.chat_conversation_members ccm
          where ccm.conversation_id = c.id and ccm.user_id = cm.user_id and ccm.company_id = c.company_id
        )
      )
    )
$function$;
revoke all on function public.esblu_push_chat_recipients(uuid) from public, anon, authenticated;
grant execute on function public.esblu_push_chat_recipients(uuid) to service_role;

-- 11) SERVER: výsledok doručenia --------------------------------------------------------
create or replace function public.esblu_push_record_outcome(p_kind text, p_target_id uuid, p_outcome text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_outcome not in ('sent', 'invalid') then
    return;
  end if;
  if p_kind = 'webpush' then
    if p_outcome = 'sent' then
      update public.push_subscriptions set last_success_at = now() where id = p_target_id;
    else
      update public.push_subscriptions set revoked_at = now(), revoke_reason = 'invalid_token', updated_at = now()
       where id = p_target_id and revoked_at is null;
    end if;
  elsif p_kind in ('fcm', 'apns') then
    if p_outcome = 'sent' then
      update public.push_devices set last_success_at = now() where id = p_target_id;
    else
      update public.push_devices set revoked_at = now(), revoke_reason = 'invalid_token', updated_at = now()
       where id = p_target_id and revoked_at is null;
    end if;
  end if;
end;
$function$;
revoke all on function public.esblu_push_record_outcome(text, uuid, text) from public, anon, authenticated;
grant execute on function public.esblu_push_record_outcome(text, uuid, text) to service_role;

-- 12) SERVER: upratanie po skončenej session / členstve (cron) -------------------------
create or replace function public.esblu_push_revoke_ended()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_total integer := 0;
  v_count integer;
begin
  update public.push_devices d
     set revoked_at = now(), revoke_reason = 'membership_ended', updated_at = now()
   where d.revoked_at is null
     and not exists (select 1 from public.company_members cm where cm.company_id = d.company_id and cm.user_id = d.user_id and cm.status = 'active');
  get diagnostics v_count = row_count; v_total := v_total + v_count;

  update public.push_devices d
     set revoked_at = now(), revoke_reason = 'session_ended', updated_at = now()
   where d.revoked_at is null
     and (d.auth_session_id is null or not exists (
       select 1 from auth.sessions a where a.id = d.auth_session_id and a.user_id = d.user_id and (a.not_after is null or a.not_after > now())
     ));
  get diagnostics v_count = row_count; v_total := v_total + v_count;

  update public.push_subscriptions s
     set revoked_at = now(), revoke_reason = 'membership_ended', updated_at = now()
   where s.revoked_at is null
     and not exists (select 1 from public.company_members cm where cm.company_id = s.company_id and cm.user_id = s.user_id and cm.status = 'active');
  get diagnostics v_count = row_count; v_total := v_total + v_count;

  update public.push_subscriptions s
     set revoked_at = now(), revoke_reason = 'session_ended', updated_at = now()
   where s.revoked_at is null
     and (s.auth_session_id is null or not exists (
       select 1 from auth.sessions a where a.id = s.auth_session_id and a.user_id = s.user_id and (a.not_after is null or a.not_after > now())
     ));
  get diagnostics v_count = row_count; v_total := v_total + v_count;

  return v_total;
end;
$function$;
revoke all on function public.esblu_push_revoke_ended() from public, anon, authenticated;
grant execute on function public.esblu_push_revoke_ended() to service_role;

commit;
