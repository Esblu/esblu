-- =============================================================================
-- 20260922100000_add_accountant_role_and_scope_gates.sql
--
-- Rola ÚČTOVNÍK (accountant) + tvrdé odopretie financií zamestnancovi
-- + oddelenie prevádzkových modulov od účtovníckych.
--
-- PREČO
-- -----
-- Doterajší model mal dve osi: `role` (owner/admin/employee) riadil
-- prevádzkový zápis a `permissions.finance.{view,manage}` riadil financie.
-- Externý účtovník do toho nezapadal — musel dostať rolu employee plus
-- finance permission, čím zároveň získal plný zápis do strojov, skladu a
-- servisov vozidiel. To je presne to, čo externá osoba mať nemá.
--
-- ČO SA MENÍ
-- ----------
--  1. company_members.role a company_invites.role prijímajú 'accountant'.
--  2. accountant je IMPLICITNE finance-capable (ako owner). Je to jeho
--     jediný dôvod existencie; vyžadovať k tomu ešte permissions by
--     znamenalo, že polovične nastavený účtovník nevidí nič.
--  3. employee má financie ODOPRETÉ TVRDO — aj keby mu niekto zapísal
--     permissions.finance. Doteraz to bolo nedosiahnuteľné iba preto, že
--     company_members nemá write policy; teraz je to pravidlo, nie zhoda
--     okolností. Zadanie: "Nestačí len skryť UI."
--  4. Nová funkcia esblu_role_can_operate() oddeľuje PREVÁDZKOVÉ moduly
--     (stroje, sklad, servisy a fotky vozidiel, vážne lístky) od
--     účtovníckych. accountant cez ňu neprejde.
--  5. accountant SMIE čítať vozidlá a stroje — potrebuje identifikovať
--     entitu na doklade. Nesmie ich meniť ani vidieť prevádzkové denníky
--     ako vlastný modul.
--  6. accountant sa pridáva do rolovej časti write policies nad
--     documents/document_links/document_attachments. Tie sú konjunkcia
--     role AND finance, takže sa tým nikomu inému nič neotvára.
--  7. Opravuje sa esblu_member_delete_self — účtovník by inak nemohol
--     z firmy odísť, jeho rola nezodpovedala filtru povolených rolí.
--     esblu_finalize_vehicle_document sa ZÁMERNE nemení: má vetvu
--     `else raise ESBLU_FORBIDDEN_UNKNOWN_ROLE`, takže účtovníka odmieta
--     sama od seba — a finalizácia dokladu k vozidlu je prevádzkový úkon,
--     ktorý mu nepatrí. Overené proti produkčnej definícii funkcie.
--  8. Allowlist potvrdzovaných hlasových akcií sa rozširuje o zmazanie
--     zložky a presun dokumentov.
--
-- BEZPEČNOSTNÝ SMER
-- -----------------
-- Každá zmena nižšie buď PRIDÁVA prístup role accountant v účtovníckom
-- rozsahu, alebo ODOBERÁ prístup (employee k financiám, accountant k
-- prevádzke). Žiadna existujúca rola nezískava právo, ktoré dnes nemá.
-- owner ostáva nedotknutý.
--
-- ROLLBACK
-- --------
-- Migrácia je aditívna voči dátam — nemení ani jeden riadok v tabuľkách.
-- Návrat = obnoviť predchádzajúce definície funkcií a policies a zúžiť
-- oba CHECK constrainty (možné, pokiaľ neexistuje riadok s rolou
-- 'accountant').
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Rozšírenie povolených rolí
-- -----------------------------------------------------------------------------

alter table public.company_members
  drop constraint if exists company_members_role_check;
alter table public.company_members
  add constraint company_members_role_check
  check (role in ('owner', 'admin', 'accountant', 'employee'));

alter table public.company_invites
  drop constraint if exists company_invites_role_check;
alter table public.company_invites
  add constraint company_invites_role_check
  check (role in ('admin', 'accountant', 'employee'));

comment on column public.company_members.role is
  'owner = zakladateľ firmy, plný rozsah. admin = prevádzkový správca; financie mu rola sama NEDÁVA, musí dostať permissions.finance. accountant = účtovník; financie má implicitne, prevádzkové moduly (stroje, sklad, servis vozidiel) NEMÁ. employee = prevádzkový používateľ; financie má ODOPRETÉ tvrdo, bez ohľadu na permissions.';

-- -----------------------------------------------------------------------------
-- 2. Finančné helpery — accountant áno, employee nikdy
-- -----------------------------------------------------------------------------
-- Poradie vetiev je zámerné: employee sa odmieta PRED čítaním permissions,
-- takže ani chybný zápis do permissions mu financie neotvorí.

create or replace function public.esblu_my_finance_view()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (
      select
        case
          when cm.role = 'employee' then false
          when cm.role in ('owner', 'accountant') then true
          else coalesce((cm.permissions -> 'finance' ->> 'view')::boolean, false)
            or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
        end
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
      limit 1
    ),
    false
  );
$$;

comment on function public.esblu_my_finance_view() is
  'Smie aktuálny používateľ ČÍTAŤ finančné údaje? owner a accountant áno z titulu roly, employee nikdy (ani s permissions), admin iba s permissions.finance.view alebo .manage.';

create or replace function public.esblu_my_finance_manage()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (
      select
        case
          when cm.role = 'employee' then false
          when cm.role in ('owner', 'accountant') then true
          else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
        end
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
      limit 1
    ),
    false
  );
$$;

comment on function public.esblu_my_finance_manage() is
  'Smie aktuálny používateľ MENIŤ finančné údaje? owner a accountant áno, employee nikdy, admin iba s permissions.finance.manage.';

create or replace function public.esblu_has_finance_view_in_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (
      select
        case
          when cm.role = 'employee' then false
          when cm.role in ('owner', 'accountant') then true
          else coalesce((cm.permissions -> 'finance' ->> 'view')::boolean, false)
            or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
        end
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
        and cm.company_id = p_company_id
      limit 1
    ),
    false
  );
$$;

create or replace function public.esblu_has_finance_manage_in_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (
      select
        case
          when cm.role = 'employee' then false
          when cm.role in ('owner', 'accountant') then true
          else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
        end
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
        and cm.company_id = p_company_id
      limit 1
    ),
    false
  );
$$;

-- -----------------------------------------------------------------------------
-- 3. Prevádzkový gate
-- -----------------------------------------------------------------------------
-- Pozitívna enumerácia, nie "nie je accountant". Ďalšia nová rola tak
-- prevádzkový zápis nedostane omylom — presne tá chyba, ktorú by spravilo
-- `role <> 'accountant'`.

create or replace function public.esblu_role_can_operate()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (
      select cm.role in ('owner', 'admin', 'employee')
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
      limit 1
    ),
    false
  );
$$;

comment on function public.esblu_role_can_operate() is
  'Patrí aktuálna rola do PREVÁDZKY (stroje, sklad, servis a fotky vozidiel, vážne lístky)? Účtovník nie — ten pracuje s dokladmi, nie s majetkom firmy. Zámerne pozitívny výpočet rolí, aby žiadna budúca rola nezískala prevádzkový zápis mlčky.';

revoke all on function public.esblu_role_can_operate() from public, anon;
grant execute on function public.esblu_role_can_operate() to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Prevádzkové tabuľky — zápis iba pre prevádzkové role
-- -----------------------------------------------------------------------------
-- SELECT ostáva firemný: účtovník musí vedieť identifikovať stroj alebo
-- vozidlo, na ktoré sa odvoláva doklad. Zmeniť ich nesmie.

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'machines', 'machine_services', 'machine_photos',
    'inventory_items', 'inventory_photos'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', v_table || '_insert_company', v_table);
    execute format('drop policy if exists %I on public.%I', v_table || '_update_company', v_table);
    execute format('drop policy if exists %I on public.%I', v_table || '_delete_company', v_table);

    execute format($f$
      create policy %I on public.%I
        for insert to authenticated
        with check (
          company_id = public.esblu_my_active_company_id()
          and public.esblu_role_can_operate()
        )
    $f$, v_table || '_insert_operational', v_table);

    execute format($f$
      create policy %I on public.%I
        for update to authenticated
        using (
          company_id = public.esblu_my_active_company_id()
          and public.esblu_role_can_operate()
        )
        with check (
          company_id = public.esblu_my_active_company_id()
          and public.esblu_role_can_operate()
        )
    $f$, v_table || '_update_operational', v_table);

    execute format($f$
      create policy %I on public.%I
        for delete to authenticated
        using (
          company_id = public.esblu_my_active_company_id()
          and public.esblu_role_can_operate()
        )
    $f$, v_table || '_delete_operational', v_table);
  end loop;
end $$;

-- Servisy vozidiel a vážne lístky mali INSERT/UPDATE otvorené celej firme.
drop policy if exists vehicle_services_insert_company on public.vehicle_services;
create policy vehicle_services_insert_operational
  on public.vehicle_services
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_role_can_operate()
  );

drop policy if exists vehicle_services_update_company on public.vehicle_services;
create policy vehicle_services_update_operational
  on public.vehicle_services
  for update to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_role_can_operate()
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_role_can_operate()
  );

drop policy if exists ai_evidence_insert_company on public.ai_evidence;
create policy ai_evidence_insert_operational
  on public.ai_evidence
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_role_can_operate()
  );

drop policy if exists vehicle_photos_insert_active_member on public.vehicle_photos;
create policy vehicle_photos_insert_operational
  on public.vehicle_photos
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_role_can_operate()
    and exists (
      select 1
      from public.vehicles v
      where v.id = vehicle_photos.vehicle_id
        and v.company_id = public.esblu_my_active_company_id()
    )
  );

-- -----------------------------------------------------------------------------
-- 5. Dokladové write policies — doplnenie role accountant
-- -----------------------------------------------------------------------------
-- Všetky sú konjunkcia ROLA ∧ FINANCIE, takže pridanie accountanta do
-- rolovej časti nemení nič pre nikoho iného.

drop policy if exists documents_update_owner_admin on public.documents;
create policy documents_update_finance_manager
  on public.documents
  for update to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
    and (
      not public.esblu_document_requires_finance(document_type, status)
      or public.esblu_my_finance_manage()
    )
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
    and (
      not public.esblu_document_requires_finance(document_type, status)
      or public.esblu_my_finance_manage()
    )
  );

drop policy if exists documents_delete_owner_admin on public.documents;
create policy documents_delete_finance_manager
  on public.documents
  for delete to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
    and (
      not public.esblu_document_requires_finance(document_type, status)
      or public.esblu_my_finance_manage()
    )
  );

drop policy if exists document_links_update_owner_admin on public.document_links;
create policy document_links_update_manager
  on public.document_links
  for update to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
    and public.esblu_can_manage_document(document_id)
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
    and public.esblu_can_manage_document(document_id)
  );

drop policy if exists document_links_delete_owner_admin on public.document_links;
create policy document_links_delete_manager
  on public.document_links
  for delete to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
    and public.esblu_can_manage_document(document_id)
  );

drop policy if exists document_attachments_update_owner_admin on public.document_attachments;
create policy document_attachments_update_manager
  on public.document_attachments
  for update to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
    and public.esblu_can_manage_document(document_id)
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
    and public.esblu_can_manage_document(document_id)
  );

drop policy if exists document_attachments_delete_owner_admin on public.document_attachments;
create policy document_attachments_delete_manager
  on public.document_attachments
  for delete to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
    and public.esblu_can_manage_document(document_id)
  );

-- Vlastné zložky dokladov spravuje aj účtovník — je to jeho triedenie.
drop policy if exists custom_document_categories_update_owner_admin on public.custom_document_categories;
create policy custom_document_categories_update_manager
  on public.custom_document_categories
  for update to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
  );

drop policy if exists custom_document_categories_delete_owner_admin on public.custom_document_categories;
create policy custom_document_categories_delete_manager
  on public.custom_document_categories
  for delete to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin', 'accountant'])
  );

-- -----------------------------------------------------------------------------
-- 6. RPC, kde by nová rola prepadla medzi vetvami
-- -----------------------------------------------------------------------------
-- Obe funkcie sú prebrané DOSLOVA z produkcie a mení sa v nich JEDINÝ
-- riadok — zoznam povolených rolí. Prepisovať ich po pamäti by znamenalo
-- ticho zahodiť kontroly, ktoré v nich sú (duplicitná pozvánka, mazanie
-- settings/legal acceptances, návratový tvar).

-- esblu_member_delete_self: bez tejto opravy by účtovník nemohol z firmy
-- odísť — jeho rola nezodpovedala ani jednej hodnote vo filtri.
create or replace function public.esblu_member_delete_self(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
begin
  if p_user_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_USER_ID';
  end if;

  select cm.company_id into v_company_id
  from public.company_members cm
  where cm.user_id = p_user_id
    and cm.status = 'active'
    and cm.role in ('admin', 'accountant', 'employee')
  limit 1;

  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NOT_ACTIVE_MEMBER',
      hint = 'Volajúci nemá aktívny company_members riadok s rolou admin/accountant/employee (owner musí použiť esblu_owner_delete_company).';
  end if;

  -- Firemné dáta (documents/vehicles/... company_id-scoped) sa VÔBEC
  -- nemažú — zostávajú firme.
  delete from public.settings where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('settings', v_n);

  delete from public.user_legal_acceptances where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('user_legal_acceptances', v_n);

  delete from public.company_members where user_id = p_user_id and company_id = v_company_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('company_members', v_n);

  return jsonb_build_object(
    'company_id', v_company_id,
    'deleted_counts', v_counts
  );
end;
$function$;

-- esblu_create_company_invite: povoliť pozvanie účtovníka. Zvyšok tela je
-- nezmenený vrátane kontrol na už existujúceho člena a čakajúcu pozvánku.
create or replace function public.esblu_create_company_invite(p_email text, p_role text)
returns table(invite_id uuid, token text, expires_at timestamptz, email text, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_company_id uuid;
  v_caller_role text;
  v_email text;
  v_role text;
  v_raw_token text;
  v_token_hash text;
  v_invite_id uuid;
  v_expires_at timestamptz;
  v_existing_member_count integer;
  v_existing_pending_count integer;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using
      errcode = '28000',
      message = 'NOT_AUTHENTICATED';
  end if;

  v_role := lower(btrim(coalesce(p_role, '')));

  if v_role not in ('admin', 'accountant', 'employee') then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_INVITE_ROLE:' || coalesce(p_role, '');
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));

  if v_email = '' or v_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_INVITE_EMAIL';
  end if;

  -- Volajúci musí byť aktívny owner ALEBO admin. Účtovník ani zamestnanec
  -- pozývať nesmie — správa členov firmy nie je účtovnícky úkon.
  select m.company_id, m.role into v_company_id, v_caller_role
  from public.company_members m
  where m.user_id = v_uid
    and m.status = 'active'
  limit 1;

  if v_company_id is null or v_caller_role not in ('owner', 'admin') then
    raise exception using
      errcode = '42501',
      message = 'ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN';
  end if;

  select count(*) into v_existing_member_count
  from public.company_members m
  join auth.users u on u.id = m.user_id
  where m.company_id = v_company_id
    and m.status = 'active'
    and lower(u.email) = v_email;

  if v_existing_member_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVITE_ALREADY_MEMBER';
  end if;

  select count(*) into v_existing_pending_count
  from public.company_invites ci
  where ci.company_id = v_company_id
    and ci.email = v_email
    and ci.status = 'pending'
    and ci.expires_at > now();

  if v_existing_pending_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVITE_ALREADY_PENDING';
  end if;

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');
  v_expires_at := now() + interval '7 days';

  insert into public.company_invites (
    company_id, email, role, invited_by, token_hash, status, expires_at
  )
  values (
    v_company_id, v_email, v_role, v_uid, v_token_hash, 'pending', v_expires_at
  )
  returning id into v_invite_id;

  return query select v_invite_id, v_raw_token, v_expires_at, v_email, v_role;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 7. Allowlist potvrdzovaných akcií asistenta
-- -----------------------------------------------------------------------------
-- Zmazanie zložky a presun dokumentov sú rizikové operácie, takže musia
-- prejsť rovnakým HMAC-podpísaným potvrdením ako doterajšie tri. Allowlist
-- je zámerne na DVOCH nezávislých miestach — CHECK na stĺpci aj vnútri RPC.

alter table public.assistant_action_confirmations
  drop constraint if exists assistant_action_confirmations_intent_check;
alter table public.assistant_action_confirmations
  add constraint assistant_action_confirmations_intent_check
  check (
    intent in (
      'CREATE_DOCUMENT_CATEGORY',
      'RENAME_DOCUMENT_CATEGORY',
      'ASSIGN_DOCUMENTS_TO_CATEGORY',
      'DELETE_DOCUMENT_CATEGORY',
      'MOVE_DOCUMENTS_TO_CATEGORY'
    )
  );

create or replace function public.esblu_create_action_confirmation(
  p_intent text,
  p_canonical_args jsonb,
  p_expected_count integer,
  p_nonce text,
  p_server_proof text,
  p_expires_at_epoch bigint
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_company_id uuid;
  v_id uuid;
  v_expires_at timestamptz;
  v_pending_count integer;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception using
      errcode = '28000',
      message = 'NOT_AUTHENTICATED';
  end if;

  -- Nezávislý allowlist check — RPC parameter `p_intent` NEDÔVERUJE ani
  -- appke, ktorá ho volá.
  if p_intent is null or p_intent not in (
    'CREATE_DOCUMENT_CATEGORY',
    'RENAME_DOCUMENT_CATEGORY',
    'ASSIGN_DOCUMENTS_TO_CATEGORY',
    'DELETE_DOCUMENT_CATEGORY',
    'MOVE_DOCUMENTS_TO_CATEGORY'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_ACTION_INTENT';
  end if;

  if p_canonical_args is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_CANONICAL_ARGS';
  end if;

  if p_expected_count is not null and p_expected_count < 0 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_EXPECTED_COUNT';
  end if;

  if p_nonce is null or p_nonce !~ '^[0-9a-f]{16,128}$' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_NONCE';
  end if;

  if p_server_proof is null or p_server_proof !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_SERVER_PROOF';
  end if;

  if p_expires_at_epoch is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_EXPIRY';
  end if;

  v_expires_at := to_timestamp(p_expires_at_epoch);
  if v_expires_at <= now() or v_expires_at > now() + interval '6 minutes' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_EXPIRY';
  end if;

  -- Company sa VŽDY odvodí zo session — nikdy sa neprijíma ako parameter.
  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  select count(*) into v_pending_count
  from public.assistant_action_confirmations
  where user_id = v_uid
    and consumed_at is null
    and expires_at > now();

  if v_pending_count >= 20 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_TOO_MANY_PENDING_CONFIRMATIONS';
  end if;

  insert into public.assistant_action_confirmations (
    user_id, company_id, intent, canonical_args, expected_count, nonce, server_proof, expires_at
  ) values (
    v_uid, v_company_id, p_intent, p_canonical_args, p_expected_count, p_nonce, p_server_proof, v_expires_at
  )
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.esblu_create_action_confirmation(text, jsonb, integer, text, text, bigint) from public, anon;
grant execute on function public.esblu_create_action_confirmation(text, jsonb, integer, text, text, bigint) to authenticated;

commit;
