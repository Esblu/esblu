-- =============================================================================
-- J10.1 — stanovisko CLIA z 11.11.2026: elektronické uzatvorenie DPA,
-- server-side DPA parita, dôkaz prijatia dokumentov, minimalizácia
-- =============================================================================
-- 1. company_dpa_acceptances — preukázateľnosť podľa CLIA (identita osoby,
--    oprávnenie konať za Zákazníka, verzia, dátum a čas, súhlas oboch strán):
--    nové stĺpce role / vyhlásenie o oprávnení / hash potvrdeného textu /
--    jazyk zobrazenia / identita firmy v čase potvrdenia / označenie
--    elektronického súhlasu Esblu (DPA 1.3 bod 10.1). Staršie riadky ostávajú
--    (stĺpce NULL = prijaté pred J10.1).
-- 2. esblu_accept_company_dpa(p_version, p_authority_confirmed, p_locale) —
--    vyžaduje výslovné vyhlásenie o oprávnení (checkbox), owner-only,
--    iba aktuálna verzia. Starý 1-argumentový podpis sa nahrádza.
-- 3. DPA server-side parita: BEFORE INSERT guard aj na invoices,
--    business_partners, einvoice_organizations (zákaznícky obsah v
--    sprostredkovateľskom režime). Firma/účet/fakturačný profil firmy
--    (údaje potrebné na založenie firmy pred DPA) sa NEblokujú.
-- 4. legal_acceptance_evidence — dôkaz prijatia Podmienok / Zásad / DPA sa
--    pri zrušení účtu alebo firmy NEZMAŽE predčasne: pred výmazom
--    acceptance riadku sa uloží záznam (identita, verzia, čas, metóda);
--    uchováva sa najviac 5 rokov od ukončenia vzťahu (PP CLIA „Správa
--    zmluvného vzťahu“ + LIA zmluvné vzťahy), potom ho maže retenčná purge.
-- 5. user_legal_acceptances — evidencia jazyka zobrazenia (metadata
--    display_locale + source_version); preklad nie je nová právna verzia.
-- 6. Retenčná purge rozšírená o: dôkazy prijatia > 5 r. od archivácie,
--    trial_claims > 5 r. od konca trialu, ai_scan_usage > 90 d (rate-limit
--    okno 24 h), pseudonymizácia user_id v ai_processing_usage > 90 d
--    (počty kvót ostávajú — business pravidlá sa nemenia).
-- Idempotentné. Rollback: supabase/rollback/20261111100000_…_rollback.sql
-- =============================================================================

-- ----------------------------------------------------------------------------- 1
alter table public.company_dpa_acceptances
  add column if not exists accepted_role text null,
  add column if not exists authority_confirmed boolean null,
  add column if not exists document_content_hash text null,
  add column if not exists display_locale text null,
  add column if not exists company_name_snapshot text null,
  add column if not exists company_registration_id_snapshot text null,
  add column if not exists processor_acceptance text null;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'company_dpa_acceptances_j10_1_evidence_check') then
    alter table public.company_dpa_acceptances
      add constraint company_dpa_acceptances_j10_1_evidence_check check (
        (display_locale is null or display_locale in ('sk', 'en', 'de'))
        and (document_content_hash is null or document_content_hash ~ '^[0-9a-f]{64}$')
        and (processor_acceptance is null or processor_acceptance = 'esblu_electronic_offer_dpa_10_1')
      );
  end if;
end
$c$;

comment on column public.company_dpa_acceptances.processor_acceptance is
  'Súhlas Esblu (Sprostredkovateľa) s elektronickým uzatvorením — DPA 1.3 bod 10.1: '
  'Sprostredkovateľ sprístupnením Zmluvy na elektronické potvrdenie vyjadruje súhlas s jej obsahom.';

-- ----------------------------------------------------------------------------- 2
drop function if exists public.esblu_accept_company_dpa(text);

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

  -- CLIA 11.11.2026: musí byť preukázateľné oprávnenie konať za Zákazníka →
  -- rola owner (server) + výslovné vyhlásenie osoby (checkbox v DPA gate).
  if coalesce(p_authority_confirmed, false) is not true then
    raise exception 'ESBLU_DPA_AUTHORITY_NOT_CONFIRMED';
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

comment on function public.esblu_accept_company_dpa(text, boolean, text) is
  'J10.1 (CLIA 11.11.2026): elektronické uzatvorenie DPA. Owner aktívnej firmy, výslovné vyhlásenie '
  'o oprávnení (p_authority_confirmed = true), iba aktuálna účinná verzia. Eviduje osobu, rolu, '
  'vyhlásenie, verziu + hash textu, dátum a čas (DB), jazyk zobrazenia, identitu firmy a súhlas Esblu '
  '(bod 10.1). Append-only (ON CONFLICT DO NOTHING).';

revoke all on function public.esblu_accept_company_dpa(text, boolean, text) from public, anon;
grant execute on function public.esblu_accept_company_dpa(text, boolean, text) to authenticated;

-- ----------------------------------------------------------------------------- 3
do $enforce$
declare
  t text;
begin
  foreach t in array array['invoices', 'business_partners', 'einvoice_organizations']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists esblu_require_company_dpa_before_insert on public.%I', t);
      execute format(
        'create trigger esblu_require_company_dpa_before_insert before insert on public.%I for each row execute function public.esblu_require_company_dpa_current()',
        t
      );
    end if;
  end loop;
end
$enforce$;

-- 3b. Storage: nový zákaznícky súbor (dokumenty, AI evidencia, chat prílohy,
-- fotky majetku) iba s prijatou aktuálnou DPA aktívnej firmy. Logo firmy
-- (company-logos) = nastavenie firmy pred DPA → povolené. eFaktúra bucket
-- zapisuje iba server (registrácia firmy u providera už vyžaduje DPA).
create or replace function public.esblu_storage_dpa_allowed(p_bucket text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
  v_current text;
begin
  if p_bucket is null or p_bucket not in ('vehicle-photos', 'machine-photos', 'inventory-photos',
      'ai-inbox-documents', 'ai-evidence-documents', 'chat-attachments') then
    return true;
  end if;
  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    return false;
  end if;
  select ld.version into v_current
  from public.legal_documents ld
  where ld.type = 'dpa' and ld.effective_at <= now()
  order by ld.effective_at desc, ld.created_at desc, ld.version desc
  limit 1;
  if v_current is null then
    return false;
  end if;
  return exists (
    select 1 from public.company_dpa_acceptances cda
    where cda.company_id = v_company_id and cda.document_type = 'dpa' and cda.version = v_current
  );
end
$function$;
revoke all on function public.esblu_storage_dpa_allowed(text) from public, anon;
grant execute on function public.esblu_storage_dpa_allowed(text) to authenticated, service_role;

drop policy if exists esblu_storage_company_dpa on storage.objects;
create policy esblu_storage_company_dpa on storage.objects
  as restrictive
  for insert to authenticated
  with check (public.esblu_storage_dpa_allowed(bucket_id));

-- ----------------------------------------------------------------------------- 4
create table if not exists public.legal_acceptance_evidence (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  user_id uuid null,
  user_email text null,
  company_id uuid null,
  company_name text null,
  company_registration_id text null,
  document_type text not null,
  version text not null,
  accepted_at timestamptz not null,
  acceptance_method text null,
  accepted_role text null,
  details jsonb not null default '{}'::jsonb,
  archived_at timestamptz not null default now(),
  constraint legal_acceptance_evidence_scope_check check (scope in ('user', 'company_dpa'))
);

create index if not exists legal_acceptance_evidence_archived_idx on public.legal_acceptance_evidence (archived_at);

comment on table public.legal_acceptance_evidence is
  'J10.1: dôkaz prijatia Podmienok / Zásad / DPA po zrušení účtu alebo firmy (CLIA: zmluvné záznamy '
  'vrátane prijatia dokumentov najviac 5 rokov od ukončenia vzťahu). Service role only; maže '
  'esblu_purge_gdpr_technical_retention po 5 rokoch od archivácie.';

alter table public.legal_acceptance_evidence enable row level security;
revoke all on table public.legal_acceptance_evidence from public, anon, authenticated;
grant select on table public.legal_acceptance_evidence to service_role;

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
      'company_dpa', old.accepted_by,
      (select u.email from auth.users u where u.id = old.accepted_by),
      old.company_id,
      coalesce(old.company_name_snapshot, (select c.name from public.companies c where c.id = old.company_id)),
      old.company_registration_id_snapshot,
      old.document_type, old.version, old.accepted_at, old.acceptance_method, old.accepted_role,
      jsonb_strip_nulls(jsonb_build_object(
        'authority_confirmed', old.authority_confirmed,
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

drop trigger if exists esblu_archive_legal_acceptance_before_delete on public.user_legal_acceptances;
create trigger esblu_archive_legal_acceptance_before_delete
  before delete on public.user_legal_acceptances
  for each row execute function public.esblu_archive_legal_acceptance();

drop trigger if exists esblu_archive_legal_acceptance_before_delete on public.company_dpa_acceptances;
create trigger esblu_archive_legal_acceptance_before_delete
  before delete on public.company_dpa_acceptances
  for each row execute function public.esblu_archive_legal_acceptance();

-- ----------------------------------------------------------------------------- 5
drop function if exists public.esblu_accept_legal_document_registration(text, text);
drop function if exists public.esblu_accept_legal_document_at_gate(text, text);

create or replace function public.esblu_accept_legal_document_registration(
  p_document_type text,
  p_version text,
  p_locale text default null
)
returns public.user_legal_acceptances
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.user_legal_acceptances;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if not exists (
    select 1 from public.legal_documents ld
    where ld.type = p_document_type and ld.version = p_version
  ) then
    raise exception 'ESBLU_UNKNOWN_LEGAL_DOCUMENT_VERSION';
  end if;

  insert into public.user_legal_acceptances (user_id, document_type, version, acceptance_method, metadata)
  values (
    v_uid, p_document_type, p_version, 'registration',
    case when p_locale in ('sk', 'en', 'de')
      then jsonb_build_object('display_locale', p_locale, 'source_version', p_version)
      else '{}'::jsonb end
  )
  on conflict (user_id, document_type, version) do nothing;

  select * into v_row from public.user_legal_acceptances
  where user_id = v_uid and document_type = p_document_type and version = p_version;

  return v_row;
end;
$function$;

create or replace function public.esblu_accept_legal_document_at_gate(
  p_document_type text,
  p_version text,
  p_locale text default null
)
returns public.user_legal_acceptances
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.user_legal_acceptances;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if not exists (
    select 1 from public.legal_documents ld
    where ld.type = p_document_type and ld.version = p_version
  ) then
    raise exception 'ESBLU_UNKNOWN_LEGAL_DOCUMENT_VERSION';
  end if;

  insert into public.user_legal_acceptances (user_id, document_type, version, acceptance_method, metadata)
  values (
    v_uid, p_document_type, p_version, 'legal_gate',
    case when p_locale in ('sk', 'en', 'de')
      then jsonb_build_object('display_locale', p_locale, 'source_version', p_version)
      else '{}'::jsonb end
  )
  on conflict (user_id, document_type, version) do nothing;

  select * into v_row from public.user_legal_acceptances
  where user_id = v_uid and document_type = p_document_type and version = p_version;

  return v_row;
end;
$function$;

comment on function public.esblu_accept_legal_document_registration(text, text, text) is
  'Registračné potvrdenie (append-only). J10.1: metadata.display_locale = jazyk zobrazenia, '
  'source_version = SK právna verzia (preklad nie je nová verzia).';
comment on function public.esblu_accept_legal_document_at_gate(text, text, text) is
  'Potvrdenie v LegalAcceptanceGate (append-only). J10.1: metadata.display_locale + source_version.';

revoke all on function public.esblu_accept_legal_document_registration(text, text, text) from public, anon;
grant execute on function public.esblu_accept_legal_document_registration(text, text, text) to authenticated;
revoke all on function public.esblu_accept_legal_document_at_gate(text, text, text) from public, anon;
grant execute on function public.esblu_accept_legal_document_at_gate(text, text, text) to authenticated;

-- ----------------------------------------------------------------------------- 6
create or replace function public.esblu_purge_gdpr_technical_retention(p_batch_size integer default 5000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_batch integer := least(greatest(coalesce(p_batch_size, 5000), 1), 20000);
  v_push_devices integer := 0;
  v_push_subscriptions integer := 0;
  v_deliveries integer := 0;
  v_invites integer := 0;
  v_jobs integer := 0;
  v_confirmations integer := 0;
  v_contexts integer := 0;
  v_media_queue integer := 0;
  v_evidence integer := 0;
  v_trial_claims integer := 0;
  v_scan_usage integer := 0;
  v_processing_pseudonymized integer := 0;
begin
  delete from public.push_devices d
  where d.id in (
    select x.id from public.push_devices x
    where x.revoked_at is not null and x.revoked_at < now() - interval '30 days'
    order by x.revoked_at limit v_batch
  );
  get diagnostics v_push_devices = row_count;

  delete from public.push_subscriptions s
  where s.id in (
    select x.id from public.push_subscriptions x
    where x.revoked_at is not null and x.revoked_at < now() - interval '30 days'
    order by x.revoked_at limit v_batch
  );
  get diagnostics v_push_subscriptions = row_count;

  delete from public.notification_deliveries n
  where n.id in (
    select x.id from public.notification_deliveries x
    where x.sent_at < now() - interval '90 days'
    order by x.sent_at limit v_batch
  );
  get diagnostics v_deliveries = row_count;

  delete from public.company_invites i
  where i.id in (
    select x.id from public.company_invites x
    where x.accepted_at is null
      and (
        (x.status in ('pending', 'expired') and x.expires_at < now() - interval '30 days')
        or (x.status = 'revoked' and coalesce(x.revoked_at, x.expires_at) < now() - interval '30 days')
      )
    order by x.expires_at limit v_batch
  );
  get diagnostics v_invites = row_count;

  delete from public.account_deletion_cleanup_jobs j
  where j.id in (
    select x.id from public.account_deletion_cleanup_jobs x
    where x.storage_status = 'done' and x.auth_status = 'done'
      and coalesce(x.completed_at, x.updated_at) < now() - interval '90 days'
    order by x.created_at limit v_batch
  );
  get diagnostics v_jobs = row_count;

  delete from public.assistant_action_confirmations c
  where c.id in (
    select x.id from public.assistant_action_confirmations x
    where x.expires_at < now() - interval '1 day'
    order by x.expires_at limit v_batch
  );
  get diagnostics v_confirmations = row_count;

  delete from public.assistant_conversation_contexts c
  where c.expires_at < now() - interval '1 day';
  get diagnostics v_contexts = row_count;

  delete from public.media_deletion_queue q
  where q.id in (
    select x.id from public.media_deletion_queue x
    where x.completed_at is not null and x.completed_at < now() - interval '90 days'
    order by x.completed_at limit v_batch
  );
  get diagnostics v_media_queue = row_count;

  -- J10.1: dôkaz prijatia dokumentov najviac 5 rokov od ukončenia vzťahu.
  delete from public.legal_acceptance_evidence e
  where e.id in (
    select x.id from public.legal_acceptance_evidence x
    where x.archived_at < now() - interval '5 years'
    order by x.archived_at limit v_batch
  );
  get diagnostics v_evidence = row_count;

  -- J10.1: trial claim (hash IČO, anti-abuse) — evidencia skúšobného obdobia ≤ 5 r.
  delete from public.trial_claims t
  where t.claim_key in (
    select x.claim_key from public.trial_claims x
    where coalesce(x.trial_ends_at, x.created_at) < now() - interval '5 years'
    limit v_batch
  );
  get diagnostics v_trial_claims = row_count;

  -- J10.1: technický abuse log AI (okno 1 h / 24 h) → 90 dní.
  delete from public.ai_scan_usage u
  where u.id in (
    select x.id from public.ai_scan_usage x
    where x.created_at < now() - interval '90 days'
    order by x.created_at limit v_batch
  );
  get diagnostics v_scan_usage = row_count;

  -- J10.1: kvótové záznamy AI ostávajú (počty = business pravidlá), osoba sa
  -- po 90 dňoch pseudonymizuje (user_id slúži iba na finalize rezervácie).
  update public.ai_processing_usage p
     set user_id = '00000000-0000-0000-0000-000000000000'::uuid
   where p.id in (
     select x.id from public.ai_processing_usage x
     where x.status <> 'reserved'
       and x.user_id <> '00000000-0000-0000-0000-000000000000'::uuid
       and coalesce(x.finalized_at, x.reserved_at) < now() - interval '90 days'
     order by x.reserved_at limit v_batch
   );
  get diagnostics v_processing_pseudonymized = row_count;

  return jsonb_build_object(
    'push_devices', v_push_devices,
    'push_subscriptions', v_push_subscriptions,
    'notification_deliveries', v_deliveries,
    'company_invites', v_invites,
    'account_deletion_jobs', v_jobs,
    'assistant_action_confirmations', v_confirmations,
    'assistant_conversation_contexts', v_contexts,
    'media_deletion_queue', v_media_queue,
    'legal_acceptance_evidence', v_evidence,
    'trial_claims', v_trial_claims,
    'ai_scan_usage', v_scan_usage,
    'ai_processing_usage_pseudonymized', v_processing_pseudonymized
  );
end
$function$;

revoke all on function public.esblu_purge_gdpr_technical_retention(integer) from public, anon, authenticated;
grant execute on function public.esblu_purge_gdpr_technical_retention(integer) to service_role;
