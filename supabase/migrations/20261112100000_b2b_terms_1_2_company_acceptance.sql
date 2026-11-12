-- =============================================================================
-- B2B VOP 1.2 — Všeobecné obchodné podmienky (B2B) + firemné prijatie
-- (revízia po audite 2026-11-12: 30-dňová lehota, potvrdenie uzatvorenia)
-- =============================================================================
-- 1. legal_documents: terms 1.2 + reaccept_notice_days (VOP 39.2, 44.5).
--    company_terms_notices: preukázateľné in-app oznámenie Vlastníkovi
--    (company_id, terms_version, notified_at, effective_at, grace_until);
--    30-dňová lehota beží OD OZNÁMENIA, nie od migrácie. Nové firmy
--    (založené po zverejnení) prijímajú hneď. required = false — zmluvné prijatie
--    je owner-only na úrovni firmy (VOP 8.1); osobný LegalAcceptanceGate
--    preto existujúcich používateľov neblokuje. Registrácia naďalej
--    zaznamenáva oboznámenie s aktuálnou verziou.
-- 2. company_dpa_acceptances rozšírená o 'terms' (žiadny paralelný systém).
-- 3. esblu_company_terms_requirement (interné) + esblu_accept_company_terms.
-- 4. esblu_get_my_company_terms_status: verzia, prijatie, grace_until,
--    required_now, údaje firmy na kontrolu pred odoslaním (22/2004 § 5).
-- 5. esblu_accept_company_dpa: VOP pred DPA iba ak je VOP pre firmu už povinné.
-- 6. Archivácia dôkazu (scope company_terms).
-- 7. esblu_get_my_pending_required_acceptances: novšia prijatá verzia
--    (napr. VOP 1.2 pri registrácii) spĺňa staršiu required verziu.
-- (VOP 20.6 — výmaz firmy s finalizovanými dokladmi po exporte — NIE je
--  súčasťou tejto migrácie: vyžaduje samostatne auditovanú zmenu immutability
--  triggerov; dovtedy riadený servisný postup, docs/b2b-vop-1-2-audit-2026-11-12.md.)
-- Nič nemaže, neblokuje existujúce dáta. Idempotentné.
-- Rollback: supabase/rollback/20261112100000_b2b_terms_1_2_company_acceptance_rollback.sql
-- =============================================================================

-- ----------------------------------------------------------------------------- 1
alter table public.legal_documents
  add column if not exists reaccept_notice_days integer null;

comment on column public.legal_documents.reaccept_notice_days is
  'VOP 39.2 / 44.5: lehota (dni) od preukázateľného oznámenia existujúcej firme, počas ktorej nová verzia '
  'nie je povinná (dobrovoľné skoršie prijatie možné). NULL = povinné hneď.';

insert into public.legal_documents (type, version, effective_at, required, content_hash, canonical_path, reaccept_notice_days)
values ('terms', '1.2', now(), false, 'ed0ce390f5022516d9175a074ed94455413e13c95578f612ec54bb553bde5ee7', '/podmienky-pouzivania', 30)
on conflict (type, version) do nothing;

create table if not exists public.company_terms_notices (
  company_id uuid not null references public.companies(id) on delete cascade,
  terms_version text not null,
  notified_at timestamptz not null default now(),
  notified_user_id uuid not null,
  notice_method text not null default 'in_app_owner_notice',
  effective_at timestamptz not null,
  grace_until timestamptz not null,
  primary key (company_id, terms_version),
  constraint company_terms_notices_method_check check (notice_method in ('in_app_owner_notice')),
  constraint company_terms_notices_dates_check check (grace_until >= notified_at and effective_at = grace_until)
);

comment on table public.company_terms_notices is
  'VOP 39.2 / 44.5: preukázateľné elektronické oznámenie novej verzie VOP Vlastníkovi existujúcej firmy '
  '(in-app). effective_at = grace_until = notified_at + reaccept_notice_days: do tohto dňa platia pre firmu '
  'doterajšie podmienky, ak Vlastník novú verziu neprijme skôr. Append-only, zápis iba cez '
  'esblu_record_company_terms_notice.';

alter table public.company_terms_notices enable row level security;
revoke all on table public.company_terms_notices from public, anon, authenticated;
grant select on table public.company_terms_notices to authenticated;
grant select, insert, update, delete on table public.company_terms_notices to service_role;

drop policy if exists company_terms_notices_select_member on public.company_terms_notices;
create policy company_terms_notices_select_member on public.company_terms_notices
  for select to authenticated
  using (company_id in (
    select cm.company_id from public.company_members cm
    where cm.user_id = auth.uid() and cm.status = 'active'
  ));

-- ----------------------------------------------------------------------------- 2
alter table public.company_dpa_acceptances
  drop constraint if exists company_dpa_acceptances_document_type_check;
alter table public.company_dpa_acceptances
  add constraint company_dpa_acceptances_document_type_check
  check (document_type in ('dpa', 'terms'));

alter table public.company_dpa_acceptances
  drop constraint if exists company_dpa_acceptances_acceptance_method_check;
alter table public.company_dpa_acceptances
  add constraint company_dpa_acceptances_acceptance_method_check
  check (
    (document_type = 'dpa' and acceptance_method = 'company_dpa_gate')
    or (document_type = 'terms' and acceptance_method = 'company_terms_gate')
  );

alter table public.company_dpa_acceptances
  add column if not exists b2b_confirmed boolean null;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'company_dpa_acceptances_terms_evidence_check') then
    alter table public.company_dpa_acceptances
      add constraint company_dpa_acceptances_terms_evidence_check check (
        document_type <> 'terms'
        or (b2b_confirmed is true and authority_confirmed is true and processor_acceptance is null)
      );
  end if;
end
$c$;

comment on column public.company_dpa_acceptances.b2b_confirmed is
  'VOP 1.2 čl. 4.3: vyhlásenie Vlastníka, že Zákazník je podnikateľ a Aplikáciu využíva na podnikateľské '
  'alebo profesijné účely. Iba document_type = ''terms''.';

comment on table public.company_dpa_acceptances is
  'Firemné (company-level) prijatie právnych dokumentov aktívnym OWNEROM v mene firmy: '
  'document_type = ''dpa'' (Zmluva o spracúvaní OÚ) alebo ''terms'' (B2B VOP, od verzie 1.2). '
  'Eviduje osobu, rolu, vyhlásenia (oprávnenie, B2B), verziu + hash textu, čas (DB), jazyk, identitu firmy. '
  'Append-only; zápis iba cez esblu_accept_company_dpa / esblu_accept_company_terms.';

-- ----------------------------------------------------------------------------- 3
-- Interný výpočet (volajú ho iba SECURITY DEFINER funkcie): aktuálna účinná
-- verzia VOP s firemným prijatím (od 1.2), či ju firma prijala, do kedy plynie
-- lehota a či je prijatie už povinné.
drop function if exists public.esblu_company_terms_requirement(uuid);

create or replace function public.esblu_company_terms_requirement(p_company_id uuid)
returns table (
  current_terms_version text,
  effective_at timestamptz,
  grace_until timestamptz,
  has_current_acceptance boolean,
  required_now boolean,
  needs_notice boolean,
  notified_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  with cur as (
    select ld.version, ld.effective_at, ld.reaccept_notice_days
    from public.legal_documents ld
    where ld.type = 'terms'
      and ld.effective_at <= now()
      and ld.version not in ('1.0', '1.1')
    order by ld.effective_at desc, ld.created_at desc, ld.version desc
    limit 1
  ),
  st as (
    select
      cur.version,
      cur.effective_at,
      (c.created_at < cur.effective_at and cur.reaccept_notice_days is not null) as needs_notice,
      n.notified_at,
      n.grace_until,
      exists (
        select 1 from public.company_dpa_acceptances a
        where a.company_id = c.id and a.document_type = 'terms' and a.version = cur.version
      ) as accepted
    from cur
    join public.companies c on c.id = p_company_id
    left join public.company_terms_notices n on n.company_id = c.id and n.terms_version = cur.version
  )
  select
    st.version,
    st.effective_at,
    case when st.needs_notice then st.grace_until end,
    st.accepted,
    (not st.accepted) and (
      not st.needs_notice
      or (st.grace_until is not null and now() >= st.grace_until)
    ),
    st.needs_notice,
    st.notified_at
  from st;
$function$;

comment on function public.esblu_company_terms_requirement(uuid) is
  'Interné (bez klientského EXECUTE): stav povinnosti firemného prijatia VOP. Nová firma (created_at >= effective_at) '
  '→ povinné hneď; existujúca firma → povinné až 30 dní po preukázateľnom oznámení (company_terms_notices; VOP 39.2, 44.5). '
  'Bez oznámenia nie je nová verzia pre existujúcu firmu povinná.';

revoke all on function public.esblu_company_terms_requirement(uuid) from public, anon, authenticated;

create or replace function public.esblu_record_company_terms_notice()
returns public.company_terms_notices
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_req record;
  v_days integer;
  v_row public.company_terms_notices;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  select cm.company_id, cm.role into v_company_id, v_role
  from public.company_members cm
  where cm.user_id = v_uid and cm.status = 'active'
    and cm.company_id = public.esblu_my_active_company_id()
  limit 1;
  if v_company_id is null then
    raise exception 'ESBLU_NO_ACTIVE_MEMBERSHIP';
  end if;
  if v_role <> 'owner' then
    raise exception 'ESBLU_NOT_ACTIVE_OWNER';
  end if;

  select * into v_req from public.esblu_company_terms_requirement(v_company_id);
  if v_req.current_terms_version is null or not v_req.needs_notice or v_req.has_current_acceptance then
    return null;
  end if;

  select ld.reaccept_notice_days into v_days from public.legal_documents ld
  where ld.type = 'terms' and ld.version = v_req.current_terms_version;

  insert into public.company_terms_notices (company_id, terms_version, notified_user_id, effective_at, grace_until, notified_at)
  values (
    v_company_id, v_req.current_terms_version, v_uid,
    now() + make_interval(days => v_days), now() + make_interval(days => v_days), now()
  )
  on conflict (company_id, terms_version) do nothing;

  select * into v_row from public.company_terms_notices
  where company_id = v_company_id and terms_version = v_req.current_terms_version;
  return v_row;
end;
$function$;

comment on function public.esblu_record_company_terms_notice() is
  'VOP 39.2 / 44.5: zaznamená preukázateľné in-app oznámenie novej verzie VOP Vlastníkovi aktívnej existujúcej firmy '
  '(prvé zobrazenie oznámenia). Lehota 30 dní beží od notified_at. Append-only (ON CONFLICT DO NOTHING).';

revoke all on function public.esblu_record_company_terms_notice() from public, anon;
grant execute on function public.esblu_record_company_terms_notice() to authenticated;

create or replace function public.esblu_accept_company_terms(
  p_version text,
  p_b2b_confirmed boolean default false,
  p_authority_confirmed boolean default false,
  p_locale text default null
)
returns public.company_dpa_acceptances
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_current_version text;
  v_hash text;
  v_name text;
  v_reg text;
  v_locale text := case when p_locale in ('sk', 'en', 'de') then p_locale end;
  v_row public.company_dpa_acceptances;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select cm.company_id, cm.role
  into v_company_id, v_role
  from public.company_members cm
  where cm.user_id = v_uid
    and cm.status = 'active'
    and cm.company_id = public.esblu_my_active_company_id()
  limit 1;

  if v_company_id is null then
    raise exception 'ESBLU_NO_ACTIVE_MEMBERSHIP';
  end if;

  if v_role <> 'owner' then
    raise exception 'ESBLU_NOT_ACTIVE_OWNER';
  end if;

  if coalesce(p_b2b_confirmed, false) is not true then
    raise exception 'ESBLU_TERMS_B2B_NOT_CONFIRMED';
  end if;

  if coalesce(p_authority_confirmed, false) is not true then
    raise exception 'ESBLU_TERMS_AUTHORITY_NOT_CONFIRMED';
  end if;

  select ld.version, ld.content_hash
  into v_current_version, v_hash
  from public.legal_documents ld
  where ld.type = 'terms'
    and ld.effective_at <= now()
    and ld.version not in ('1.0', '1.1')
  order by ld.effective_at desc, ld.created_at desc, ld.version desc
  limit 1;

  if v_current_version is null then
    raise exception 'ESBLU_NO_CURRENT_TERMS';
  end if;

  if p_version is distinct from v_current_version then
    raise exception 'ESBLU_NOT_CURRENT_TERMS_VERSION';
  end if;

  select c.name into v_name from public.companies c where c.id = v_company_id;
  select coalesce(
           (select li.registration_id from public.company_legal_identities li where li.company_id = v_company_id),
           (select bp.ico from public.company_billing_profile bp where bp.company_id = v_company_id)
         )
  into v_reg;

  insert into public.company_dpa_acceptances (
    company_id, document_type, version, accepted_by, acceptance_method,
    accepted_role, authority_confirmed, b2b_confirmed, document_content_hash, display_locale,
    company_name_snapshot, company_registration_id_snapshot, processor_acceptance
  )
  values (
    v_company_id, 'terms', v_current_version, v_uid, 'company_terms_gate',
    v_role, true, true, v_hash, v_locale,
    v_name, v_reg, null
  )
  on conflict (company_id, document_type, version) do nothing;

  insert into public.user_legal_acceptances (user_id, document_type, version, acceptance_method, metadata)
  values (
    v_uid, 'terms', v_current_version, 'legal_gate',
    jsonb_strip_nulls(jsonb_build_object(
      'display_locale', v_locale,
      'source_version', v_current_version,
      'via', 'company_terms_gate',
      'company_id', v_company_id
    ))
  )
  on conflict (user_id, document_type, version) do nothing;

  select *
  into v_row
  from public.company_dpa_acceptances
  where company_id = v_company_id
    and document_type = 'terms'
    and version = v_current_version;

  return v_row;
end;
$function$;

comment on function public.esblu_accept_company_terms(text, boolean, boolean, text) is
  'B2B VOP 1.2 čl. 8: elektronické uzatvorenie Zmluvy za firmu. Owner aktívnej firmy, výslovné vyhlásenia '
  'o B2B charaktere (čl. 4.3) a o oprávnení konať za Zákazníka (čl. 6.1), iba aktuálna účinná verzia. '
  'Eviduje osobu, rolu, vyhlásenia, verziu + hash, čas (DB), jazyk zobrazenia, identitu firmy. Append-only.';

revoke all on function public.esblu_accept_company_terms(text, boolean, boolean, text) from public, anon;
grant execute on function public.esblu_accept_company_terms(text, boolean, boolean, text) to authenticated;

-- ----------------------------------------------------------------------------- 4
drop function if exists public.esblu_get_my_company_terms_status();

create or replace function public.esblu_get_my_company_terms_status()
returns table (
  company_id uuid,
  current_terms_version text,
  has_current_acceptance boolean,
  accepted_at timestamptz,
  my_role text,
  grace_until timestamptz,
  required_now boolean,
  company_name text,
  company_registration_id text,
  needs_notice boolean,
  notified_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  with my_membership as (
    select cm.company_id, cm.role
    from public.company_members cm
    where cm.user_id = auth.uid()
      and cm.status = 'active'
      and cm.company_id = public.esblu_my_active_company_id()
    limit 1
  )
  select
    mm.company_id,
    req.current_terms_version,
    req.has_current_acceptance,
    cta.accepted_at,
    mm.role,
    req.grace_until,
    req.required_now,
    c.name,
    coalesce(
      (select li.registration_id from public.company_legal_identities li where li.company_id = mm.company_id),
      (select bp.ico from public.company_billing_profile bp where bp.company_id = mm.company_id)
    ),
    req.needs_notice,
    req.notified_at
  from my_membership mm
  join public.companies c on c.id = mm.company_id
  cross join lateral public.esblu_company_terms_requirement(mm.company_id) req
  left join public.company_dpa_acceptances cta
    on cta.company_id = mm.company_id
   and cta.document_type = 'terms'
   and cta.version = req.current_terms_version;
$function$;

comment on function public.esblu_get_my_company_terms_status() is
  'Read-only stav firemného prijatia aktuálnych VOP pre aktívnu firmu volajúceho (každý aktívny člen): '
  'verzia, prijatie, lehota (grace_until), povinnosť (required_now) a údaje firmy na kontrolu pred odoslaním.';

revoke all on function public.esblu_get_my_company_terms_status() from public, anon;
grant execute on function public.esblu_get_my_company_terms_status() to authenticated;

-- ----------------------------------------------------------------------------- 5
create or replace function public.esblu_accept_company_dpa(
  p_version text,
  p_authority_confirmed boolean default false,
  p_locale text default null
)
returns public.company_dpa_acceptances
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_current_version text;
  v_hash text;
  v_name text;
  v_reg text;
  v_row public.company_dpa_acceptances;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select cm.company_id, cm.role
  into v_company_id, v_role
  from public.company_members cm
  where cm.user_id = v_uid
    and cm.status = 'active'
    and cm.company_id = public.esblu_my_active_company_id()
  limit 1;

  if v_company_id is null then
    raise exception 'ESBLU_NO_ACTIVE_MEMBERSHIP';
  end if;

  if v_role <> 'owner' then
    raise exception 'ESBLU_NOT_ACTIVE_OWNER';
  end if;

  if coalesce(p_authority_confirmed, false) is not true then
    raise exception 'ESBLU_DPA_AUTHORITY_NOT_CONFIRMED';
  end if;

  if exists (
    select 1 from public.esblu_company_terms_requirement(v_company_id) req where req.required_now
  ) then
    raise exception 'ESBLU_COMPANY_TERMS_NOT_ACCEPTED';
  end if;

  select ld.version, ld.content_hash
  into v_current_version, v_hash
  from public.legal_documents ld
  where ld.type = 'dpa'
    and ld.effective_at <= now()
  order by ld.effective_at desc, ld.created_at desc, ld.version desc
  limit 1;

  if v_current_version is null then
    raise exception 'ESBLU_NO_CURRENT_DPA';
  end if;

  if p_version <> v_current_version then
    raise exception 'ESBLU_NOT_CURRENT_DPA_VERSION';
  end if;

  select c.name into v_name from public.companies c where c.id = v_company_id;
  select coalesce(
           (select li.registration_id from public.company_legal_identities li where li.company_id = v_company_id),
           (select bp.ico from public.company_billing_profile bp where bp.company_id = v_company_id)
         )
  into v_reg;

  insert into public.company_dpa_acceptances (
    company_id, document_type, version, accepted_by, acceptance_method,
    accepted_role, authority_confirmed, document_content_hash, display_locale,
    company_name_snapshot, company_registration_id_snapshot, processor_acceptance
  )
  values (
    v_company_id, 'dpa', v_current_version, v_uid, 'company_dpa_gate',
    v_role, true, v_hash,
    case when p_locale in ('sk', 'en', 'de') then p_locale end,
    v_name, v_reg, 'esblu_electronic_offer_dpa_10_1'
  )
  on conflict (company_id, document_type, version) do nothing;

  select *
  into v_row
  from public.company_dpa_acceptances
  where company_id = v_company_id
    and document_type = 'dpa'
    and version = v_current_version;

  return v_row;
end;
$function$;

revoke all on function public.esblu_accept_company_dpa(text, boolean, text) from public, anon;
grant execute on function public.esblu_accept_company_dpa(text, boolean, text) to authenticated;

-- ----------------------------------------------------------------------------- 6
alter table public.legal_acceptance_evidence
  drop constraint if exists legal_acceptance_evidence_scope_check;
alter table public.legal_acceptance_evidence
  add constraint legal_acceptance_evidence_scope_check
  check (scope in ('user', 'company_dpa', 'company_terms'));

create or replace function public.esblu_archive_legal_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_table_name = 'user_legal_acceptances' then
    insert into public.legal_acceptance_evidence
      (scope, user_id, user_email, document_type, version, accepted_at, acceptance_method, details)
    values (
      'user', old.user_id,
      (select u.email from auth.users u where u.id = old.user_id),
      old.document_type, old.version, old.accepted_at, old.acceptance_method,
      coalesce(old.metadata, '{}'::jsonb)
    );
  else
    insert into public.legal_acceptance_evidence
      (scope, user_id, user_email, company_id, company_name, company_registration_id,
       document_type, version, accepted_at, acceptance_method, accepted_role, details)
    values (
      case when old.document_type = 'terms' then 'company_terms' else 'company_dpa' end,
      old.accepted_by,
      (select u.email from auth.users u where u.id = old.accepted_by),
      old.company_id,
      coalesce(old.company_name_snapshot, (select c.name from public.companies c where c.id = old.company_id)),
      old.company_registration_id_snapshot,
      old.document_type, old.version, old.accepted_at, old.acceptance_method, old.accepted_role,
      jsonb_strip_nulls(jsonb_build_object(
        'authority_confirmed', old.authority_confirmed,
        'b2b_confirmed', old.b2b_confirmed,
        'document_content_hash', old.document_content_hash,
        'display_locale', old.display_locale,
        'processor_acceptance', old.processor_acceptance
      ))
    );
  end if;
  return old;
end
$function$;

revoke all on function public.esblu_archive_legal_acceptance() from public, anon, authenticated;

-- ----------------------------------------------------------------------------- 7
create or replace function public.esblu_get_my_pending_required_acceptances()
returns table (document_type text, version text, effective_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $function$
  select ld.type, ld.version, ld.effective_at
  from public.legal_documents ld
  where ld.required = true
    and ld.id in (
      select distinct on (type) id
      from public.legal_documents
      where required = true
      order by type, effective_at desc, created_at desc, version desc
    )
    and auth.uid() is not null
    and not exists (
      select 1
      from public.user_legal_acceptances ula
      join public.legal_documents acc
        on acc.type = ula.document_type and acc.version = ula.version
      where ula.user_id = auth.uid()
        and ula.document_type = ld.type
        and (ula.version = ld.version or acc.effective_at > ld.effective_at)
    );
$function$;

comment on function public.esblu_get_my_pending_required_acceptances() is
  'Read-only: najnovšie required verzie (terms/privacy_policy), ktoré používateľ nepotvrdil. B2B VOP 1.2: '
  'potvrdenie NOVŠEJ verzie toho istého typu (napr. VOP 1.2 pri registrácii) spĺňa staršiu required verziu.';

revoke all on function public.esblu_get_my_pending_required_acceptances() from public, anon;
grant execute on function public.esblu_get_my_pending_required_acceptances() to authenticated;
