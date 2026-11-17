-- =============================================================================
-- Verejná registrácia (koniec uzavretej bety) — prepínateľná politika
-- (FORWARD-ONLY, 2026-11-17)
--
-- Doteraz: nový owner (založenie firmy) prešiel iba s e-mailom v
-- public.beta_allowlist — dve nezávislé kontroly:
--   1) Auth hook esblu_before_user_created_beta_gate (pred vznikom auth.users),
--   2) esblu_ensure_my_owner_company (defense-in-depth pri založení firmy).
--
-- Teraz: obe kontroly čítajú JEDEN zdroj pravdy public.registration_policy
-- (singleton, mode = 'open' | 'closed_beta'). Táto migrácia nastaví 'open'.
--
-- Čo sa NEMENÍ:
--   - pozvánky (token aj Google vetva v hooku), ESBLU_PENDING_INVITE_EXISTS,
--     esblu_accept_company_invite, roly a oprávnenia, RLS, tenant izolácia;
--   - trial (iba overený právny subjekt + trial_claims proti opakovanému
--     čerpaniu) — nezávisí od beta_allowlist;
--   - prijímanie VOP / zásad / DPA (LegalAcceptanceGate, CompanyDpaGate);
--   - beta_allowlist ostáva (v režime 'closed_beta' platí presne ako doteraz,
--     v 'open' sa pri založení firmy naďalej zapíše consumed_at, ak riadok existuje).
--
-- Rýchly návrat k uzavretej registrácii (bez deployu, okamžite):
--   update public.registration_policy
--      set mode = 'closed_beta', updated_at = now(), note = '<dôvod>'
--    where id;
-- Opätovné otvorenie: to isté s mode = 'open'. Runbook:
--   docs/open-registration-2026-11-17.md
-- Úplný rollback schémy: supabase/rollback/20261117100000_open_public_registration_rollback.sql
--
-- FAIL CLOSED: chýbajúci riadok politiky alebo neznáma hodnota = 'closed_beta'.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Politika registrácie (singleton). Bez grantov pre klientov, RLS bez
--    policy — spravuje sa iba v SQL Editore / migráciou (rovnako ako
--    beta_allowlist).
-- -----------------------------------------------------------------------------
create table if not exists public.registration_policy (
  id boolean primary key default true,
  mode text not null default 'closed_beta',
  updated_at timestamptz not null default now(),
  note text null,
  constraint registration_policy_singleton_check check (id),
  constraint registration_policy_mode_check check (mode in ('open', 'closed_beta'))
);

comment on table public.registration_policy is
  'Singleton: či sa nový zákazník (owner novej firmy) môže zaregistrovať bez beta_allowlist. '
  'mode = open | closed_beta. Číta hook esblu_before_user_created_beta_gate aj '
  'esblu_ensure_my_owner_company (cez esblu_public_registration_open). Chýbajúci riadok = closed_beta.';

alter table public.registration_policy enable row level security;
revoke all on table public.registration_policy from public, anon, authenticated, service_role;
-- Rovnaký cieľový stav ako beta_allowlist (20261021100000): service_role iba DML.
grant select, insert, update, delete on table public.registration_policy to service_role;

insert into public.registration_policy (id, mode, updated_at, note)
values (true, 'open', now(), 'Verejné spustenie 2026-11-17 — koniec uzavretej bety')
on conflict (id) do update
  set mode = excluded.mode,
      updated_at = excluded.updated_at,
      note = excluded.note;

-- -----------------------------------------------------------------------------
-- 2) Helper — jediný zdroj pravdy pre obe kontroly. Nie je dosiahnuteľný z
--    klienta (žiadny anon/authenticated EXECUTE).
-- -----------------------------------------------------------------------------
create or replace function public.esblu_public_registration_open()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(
    (select rp.mode = 'open' from public.registration_policy rp where rp.id),
    false
  );
$function$;

comment on function public.esblu_public_registration_open() is
  'true = verejná registrácia nových firiem otvorená (registration_policy.mode = open). Fail closed.';

revoke all on function public.esblu_public_registration_open() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3) Auth hook — invite vetvy NEZMENENÉ; nová vetva „registrácia otvorená“
--    pred beta allowlistom; neutrálna hláška v režime closed_beta.
-- -----------------------------------------------------------------------------
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

  -- Pozvaný admin/employee s platným tokenom — NEZMENENÉ.
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

  -- Google OAuth s platnou pozvánkou pre presne tento e-mail — NEZMENENÉ
  -- (poskytovateľa nastavuje Auth server v app_metadata, user_metadata sa
  -- zámerne nečíta; iný poskytovateľ = žiadny obchvat).
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

  -- NOVÉ: verejná registrácia otvorená (registration_policy.mode = 'open').
  -- Účet sám o sebe nedáva prístup k žiadnej firme; firmu založí až
  -- esblu_ensure_my_owner_company (ten odmietne e-mail s čakajúcou pozvánkou).
  if public.esblu_public_registration_open() then
    return '{}'::jsonb;
  end if;

  -- Režim closed_beta — beta allowlist presne ako doteraz.
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

  -- Stabilný marker pre klienta: „registrácia nových firiem je dočasne pozastavená“.
  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Registrácia nových firiem je dočasne pozastavená. Ak máte pozvánku alebo schválený prístup, kontaktujte nás na info@esblu.com.'
    )
  );
end;
$function$;

-- Granty hooku sa pri CREATE OR REPLACE zachovávajú; pre istotu explicitne
-- (rovnaký stav ako 20260816130000 / 20260923200000).
revoke all on function public.esblu_before_user_created_beta_gate(jsonb) from public, anon, authenticated;
grant execute on function public.esblu_before_user_created_beta_gate(jsonb) to supabase_auth_admin;

-- -----------------------------------------------------------------------------
-- 4) esblu_ensure_my_owner_company — beta kontrola iba v režime closed_beta.
--    Zvyšok tela je zhodný s 20261012160000 (produkčná definícia overená
--    2026-11-17 pred migráciou).
-- -----------------------------------------------------------------------------
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

  -- Registrácia otvorená = bez allowlistu. V režime closed_beta platí
  -- allowlist ako doteraz (kód chyby ponechaný kvôli starším klientom).
  if not public.esblu_public_registration_open() then
    select exists (
      select 1 from public.beta_allowlist ba
      where ba.email = v_email and ba.revoked_at is null and ba.consumed_at is null
    ) into v_beta_allowed;

    if not v_beta_allowed then
      raise exception using errcode = '42501', message = 'ESBLU_BETA_ACCESS_REQUIRED';
    end if;
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

  -- Trial NEVZNIKÁ (trigger ho pri INSERT nikdy nenastaví) — iba po overení IČO.
  insert into public.companies (owner_id, name) values (v_uid, v_company_name) returning id into v_company_id;
  insert into public.company_members (company_id, user_id, role, status) values (v_company_id, v_uid, 'owner', 'active');
  insert into public.company_billing_profile (company_id, legal_name) values (v_company_id, v_company_name);

  perform public.esblu_set_session_company_internal(v_uid, v_company_id);

  -- Evidencia využitia beta slotu (ak e-mail na zozname je) — bez vplyvu na prístup.
  update public.beta_allowlist
  set consumed_at = coalesce(consumed_at, now()), consumed_by = v_uid
  where email = v_email;

  return query select v_company_id, 'owner'::text, true;
end;
$function$;
