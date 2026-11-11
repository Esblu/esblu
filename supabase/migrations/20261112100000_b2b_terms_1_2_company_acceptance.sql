-- =============================================================================
-- B2B VOP 1.2 — Všeobecné obchodné podmienky (B2B) + firemné prijatie
-- =============================================================================
-- 1. legal_documents: terms 1.2 (SK originál legal/terms/1.2.md; EN/DE =
--    preklady tej istej verzie). required = true → existujúci
--    LegalAcceptanceGate si od každého Používateľa vyžiada osobné potvrdenie
--    pravidiel používania (VOP 8.5).
-- 2. Firemné prijatie VOP (zmluva so Zákazníkom, VOP 8.1–8.3) — ŽIADNY nový
--    paralelný systém: rozširuje company_dpa_acceptances (append-only, owner-
--    only RPC, archivácia do legal_acceptance_evidence) o document_type
--    'terms', acceptance_method 'company_terms_gate' a stĺpec b2b_confirmed.
-- 3. esblu_accept_company_terms(p_version, p_b2b_confirmed,
--    p_authority_confirmed, p_locale) — owner aktívnej firmy, obe vyhlásenia
--    povinné, iba aktuálna účinná verzia. Zároveň zapíše osobné potvrdenie
--    ownera (user_legal_acceptances, metadata.via = company_terms_gate), aby
--    owner nepotvrdzoval tú istú verziu dvakrát.
-- 4. esblu_get_my_company_terms_status() — read-only stav pre člena firmy.
-- 5. esblu_accept_company_dpa: DPA sa potvrdzuje až po VOP aktuálnej verzie
--    (poradie VOP → DPA). Existujúce DPA prijatia ostávajú platné.
-- 6. Archivácia dôkazu: scope 'company_terms' + b2b_confirmed v details.
-- Neblokuje existujúce dáta, nič nemaže. Idempotentné.
-- Rollback: supabase/rollback/20261112100000_b2b_terms_1_2_company_acceptance_rollback.sql
-- =============================================================================

-- ----------------------------------------------------------------------------- 1
insert into public.legal_documents (type, version, effective_at, required, content_hash, canonical_path)
values ('terms', '1.2', now(), true, '9dbbbb56ce4ade59fb36bee8b2c169fbe9cb4658256345e74a784eab3898bd1b', '/podmienky-pouzivania')
on conflict (type, version) do nothing;

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

  -- Osobné potvrdenie ownera tej istej verzie (LegalAcceptanceGate ho už
  -- nebude pýtať druhýkrát). Append-only, existujúci riadok sa neprepíše.
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
create or replace function public.esblu_get_my_company_terms_status()
returns table (
  company_id uuid,
  current_terms_version text,
  has_current_acceptance boolean,
  accepted_at timestamptz,
  my_role text
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
  ),
  current_terms as (
    select ld.version
    from public.legal_documents ld
    where ld.type = 'terms'
      and ld.effective_at <= now()
    order by ld.effective_at desc, ld.created_at desc, ld.version desc
    limit 1
  )
  select
    mm.company_id,
    ct.version,
    (cta.id is not null),
    cta.accepted_at,
    mm.role
  from my_membership mm
  cross join current_terms ct
  left join public.company_dpa_acceptances cta
    on cta.company_id = mm.company_id
   and cta.document_type = 'terms'
   and cta.version = ct.version;
$function$;

comment on function public.esblu_get_my_company_terms_status() is
  'Read-only stav firemného prijatia aktuálnych VOP pre aktívnu firmu volajúceho (každý aktívny člen).';

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
  v_terms_version text;
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

  -- B2B VOP 1.2: poradie VOP → DPA. Vyžaduje sa iba vtedy, ak existuje účinná
  -- verzia VOP s firemným prijatím (od 1.2); staršie verzie (1.0/1.1) firemné
  -- prijatie nemali.
  select ld.version into v_terms_version
  from public.legal_documents ld
  where ld.type = 'terms' and ld.effective_at <= now()
  order by ld.effective_at desc, ld.created_at desc, ld.version desc
  limit 1;

  if v_terms_version is not null
     and v_terms_version not in ('1.0', '1.1')
     and not exists (
       select 1 from public.company_dpa_acceptances t
       where t.company_id = v_company_id and t.document_type = 'terms' and t.version = v_terms_version
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
