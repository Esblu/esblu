-- =============================================================================
-- Closed-beta P0 hardening (audit docs/closed-beta-product-audit-2026-09-26.md).
--
-- STAV: APLIKOVANÉ do produkcie 2026-09-27 cez Supabase MCP apply_migration
-- na projekt fkpgvgvsmbpieduoatrt (assetpilot). V produkčnej histórii migrácií
-- je zapísaná pod verziou 20260927081034 (closed_beta_p0_hardening), nie pod
-- 20260929100000 z názvu tohto súboru. Súbor NEPREMENÚVAŤ a NEAPLIKOVAŤ znova;
-- produkčnú históriu migrácií nemeniť. NIKDY `supabase db push`.
-- Push migrácia 20260927110000 a OAuth migrácia 20260927120000 ostávajú
-- NEAPLIKOVANÉ. Rollback definície: supabase/rollback/
-- 20260929100000_closed_beta_p0_pre_apply.sql.
--
-- PORADIE NASADENIA (povinné): najprv TÁTO migrácia, AŽ POTOM kód z tej
-- istej dávky. Migrácia je spätne kompatibilná so súčasne nasadeným kódom:
--   - nové RPC dnešný kód nevolá,
--   - zúžené politiky/strážcovia odmietajú iba to, čo je podľa zadania
--     neoprávnené (accountant pozvánka od admina, zmena IBAN ne-ownerom,
--     zápis strojov zamestnancom, tvrdé zmazanie účtovného dokladu).
-- Nový kód BEZ migrácie by pri uložení draftu faktúry a skene TP zlyhal
-- (volá nové RPC) — preto poradie.
--
-- ČO ROBÍ
--   P0-1  Pozvánka s rolou 'accountant' (rola s finančným prístupom) iba od
--         OWNERA — pri vytvorení aj pri prijatí (staré pozvánky od admina
--         sa už neprijmú). Admin bez financií nesmie udeliť finančnú autoritu.
--   P0-2  Bootstrap vlastnej firmy sa odmietne, kým má používateľ platnú
--         nevybavenú pozvánku (overenie e-mailu nesmie pozvaného poslať do
--         owner onboardingu a založiť mu cudziu firmu).
--   P0-4  Atomické uloženie draftu faktúry (hlavička + riadky v JEDNEJ
--         transakcii, SECURITY INVOKER = pod RLS volajúceho) s kontrolou
--         súbežnej zmeny.
--   P0-5  Zlúčenie skenu technického preukazu do EXISTUJÚCEHO vozidla na
--         serveri: chýbajúca/prázdna hodnota nikdy nič neprepíše, user_id sa
--         nemení (SECURITY INVOKER = RLS owner/admin).
--   P0-6  Účtovné doklady (faktúra, bloček, dodací list) sa z klienta
--         nedajú tvrdo zmazať — iba archivovať (deleted_at). Doklad naviazaný
--         na faktúru sa nedá zmazať vôbec. ai_evidence dostane deleted_at.
--   Rozhodnutie 2  IBAN/BIC firmy mení iba owner; vydaná faktúra ne-ownera smie
--                  niesť IBAN iba presne podľa nastavení firmy (bez podvrhu účtu).
--   Rozhodnutie 1  Zamestnanec nemení kmeňové dáta strojov (stroje, servisné
--                  záznamy, fotky strojov) — čítanie ostáva.
--   P0-9  Operátorská funkcia (iba service_role) na beta nárok členov tímu;
--         verejný trial (1 používateľ) sa NEMENÍ.
--
-- ČO SA NEMENÍ: izolácia firiem, finance RPC (esblu_my_finance_view/manage),
-- verejné trial limity a cenník, push/OAuth migrácie (ostávajú neaplikované),
-- existujúce dáta (nič sa nemaže ani neprepisuje).
--
-- ROLLBACK (bez straty dát):
--   - esblu_create_company_invite / esblu_accept_company_invite /
--     esblu_ensure_my_owner_company vrátiť na definície pred touto migráciou
--     (PRED aplikovaním uložiť cez pg_get_functiondef),
--   - drop function esblu_save_invoice_draft, esblu_apply_vehicle_registration,
--     esblu_operator_grant_team_allowance,
--   - drop trigger esblu_retain_finance_documents / esblu_retain_delivery_notes /
--     esblu_guard_company_bank_details / esblu_guard_issued_invoice_iban
--     (a ich funkcie) + drop function esblu_normalize_iban(text),
--   - politiky machines/machine_services/machine_photos vrátiť na
--     esblu_role_can_operate() (definície v 20260922100000),
--   - stĺpec ai_evidence.deleted_at môže ostať (neškodný).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- P0-1 — accountant pozvánka iba od ownera (vytvorenie)
-- -----------------------------------------------------------------------------
create or replace function public.esblu_create_company_invite(p_email text, p_role text)
returns table(invite_id uuid, token text, expires_at timestamp with time zone, email text, role text)
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
  v_seats_used bigint;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  v_role := lower(btrim(coalesce(p_role, '')));

  if v_role not in ('admin', 'accountant', 'employee') then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_INVITE_ROLE:' || coalesce(p_role, '');
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));

  if v_email = '' or v_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_INVITE_EMAIL';
  end if;

  select m.company_id, m.role into v_company_id, v_caller_role
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active'
  limit 1;

  if v_company_id is null or v_caller_role not in ('owner', 'admin') then
    raise exception using errcode = '42501', message = 'ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN';
  end if;

  -- Rola 'accountant' nesie finančný prístup (esblu_my_finance_view/manage).
  -- Udeliť ho smie iba owner — admin nemá finančnú autoritu implicitne,
  -- takže ju nesmie ani odovzdať (inak by pozval vlastnú druhú schránku).
  if v_role = 'accountant' and v_caller_role <> 'owner' then
    raise exception using errcode = '42501', message = 'ESBLU_INVITE_ROLE_NOT_PERMITTED';
  end if;

  select count(*) into v_existing_member_count
  from public.company_members m
  join auth.users u on u.id = m.user_id
  where m.company_id = v_company_id and m.status = 'active' and lower(u.email) = v_email;

  if v_existing_member_count > 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_ALREADY_MEMBER';
  end if;

  select count(*) into v_existing_pending_count
  from public.company_invites ci
  where ci.company_id = v_company_id and ci.email = v_email
    and ci.status = 'pending' and ci.expires_at > now();

  if v_existing_pending_count > 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_ALREADY_PENDING';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':team_members', 0));

  select
    (select count(*) from public.company_members m
      where m.company_id = v_company_id and m.status = 'active')
    + (select count(*) from public.company_invites ci
      where ci.company_id = v_company_id and ci.status = 'pending' and ci.expires_at > now())
  into v_seats_used;

  perform public.esblu_require_entitlement_capacity(v_company_id, 'team_members', v_seats_used);

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');
  v_expires_at := now() + interval '7 days';

  insert into public.company_invites (company_id, email, role, invited_by, token_hash, status, expires_at)
  values (v_company_id, v_email, v_role, v_uid, v_token_hash, 'pending', v_expires_at)
  returning id into v_invite_id;

  return query select v_invite_id, v_raw_token, v_expires_at, v_email, v_role;
end;
$function$;

revoke all on function public.esblu_create_company_invite(text, text) from public, anon;
grant execute on function public.esblu_create_company_invite(text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- P0-1 — accountant pozvánka iba od ownera (prijatie — aj staré pozvánky)
-- -----------------------------------------------------------------------------
create or replace function public.esblu_accept_company_invite(p_token text)
returns table(company_id uuid, role text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_email text;
  v_token_hash text;
  v_invite record;
  v_existing_active_count integer;
  v_active_members bigint;
  v_inviter_is_owner boolean;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_TOKEN';
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;

  if v_email is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_AUTH_USER_EMAIL_NOT_FOUND';
  end if;

  v_email := lower(btrim(v_email));
  v_token_hash := encode(extensions.digest(btrim(p_token), 'sha256'), 'hex');

  select ci.* into v_invite
  from public.company_invites ci
  where ci.token_hash = v_token_hash
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_TOKEN';
  end if;

  if v_invite.status = 'accepted' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_ALREADY_ACCEPTED';
  end if;

  if v_invite.status = 'revoked' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_REVOKED';
  end if;

  if v_invite.status = 'expired' or v_invite.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVITE_EXPIRED';
  end if;

  if v_invite.email <> v_email then
    raise exception using errcode = '42501', message = 'ESBLU_INVITE_EMAIL_MISMATCH';
  end if;

  -- Finančnú rolu musí udeliť AKTUÁLNY owner tej istej firmy. Pozvánka,
  -- ktorú vytvoril admin (pred touto opravou) alebo owner, ktorý už nie je
  -- ownerom, sa neprijme — pozvaný nedostane finančný prístup od niekoho,
  -- kto ho nemá.
  if v_invite.role = 'accountant' then
    select exists (
      select 1 from public.company_members m
      where m.company_id = v_invite.company_id
        and m.user_id = v_invite.invited_by
        and m.status = 'active'
        and m.role = 'owner'
    ) into v_inviter_is_owner;

    if not v_inviter_is_owner then
      raise exception using errcode = '42501', message = 'ESBLU_INVITE_ROLE_NOT_PERMITTED';
    end if;
  end if;

  select count(*) into v_existing_active_count
  from public.company_members m
  where m.user_id = v_uid and m.status = 'active';

  if v_existing_active_count > 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_ALREADY_HAS_ACTIVE_MEMBERSHIP';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_invite.company_id::text || ':team_members', 0));

  select count(*) into v_active_members
  from public.company_members m
  where m.company_id = v_invite.company_id and m.status = 'active';

  perform public.esblu_require_entitlement_capacity(v_invite.company_id, 'team_members', v_active_members);

  begin
    insert into public.company_members (company_id, user_id, role, status)
    values (v_invite.company_id, v_uid, v_invite.role, 'active');
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'ESBLU_ALREADY_HAS_ACTIVE_MEMBERSHIP';
  end;

  update public.company_invites
  set status = 'accepted', accepted_at = now(), accepted_by = v_uid
  where id = v_invite.id;

  return query select v_invite.company_id, v_invite.role;
end;
$function$;

revoke all on function public.esblu_accept_company_invite(text) from public, anon;
grant execute on function public.esblu_accept_company_invite(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- P0-2 — žiadna vlastná firma, kým čaká platná pozvánka
-- (definícia = produkcia pred touto migráciou + jedna kontrola)
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
    raise exception using
      errcode = '28000',
      message = 'NOT_AUTHENTICATED';
  end if;

  select m.company_id, m.role
  into v_existing
  from public.company_members m
  where m.user_id = v_uid
    and m.status = 'active'
  limit 1;

  if found then
    return query select v_existing.company_id, v_existing.role, false;
    return;
  end if;

  select u.email into v_email
  from auth.users u
  where u.id = v_uid;

  if v_email is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_AUTH_USER_EMAIL_NOT_FOUND';
  end if;

  v_email := lower(btrim(v_email));

  -- Pozvaný používateľ (napr. po overení e-mailu, ktoré ho vrátilo inam
  -- než na pozvánku) si NESMIE založiť vlastnú firmu — tým by pozvánku už
  -- nikdy neprijal (jedno aktívne členstvo na používateľa). Klient ho
  -- nasmeruje späť na pozvánku.
  if exists (
    select 1 from public.company_invites ci
    where ci.email = v_email
      and ci.status = 'pending'
      and ci.expires_at > now()
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_PENDING_INVITE_EXISTS';
  end if;

  select exists (
    select 1
    from public.beta_allowlist ba
    where ba.email = v_email
      and ba.revoked_at is null
      and ba.consumed_at is null
  ) into v_beta_allowed;

  if not v_beta_allowed then
    raise exception using
      errcode = '42501',
      message = 'ESBLU_BETA_ACCESS_REQUIRED';
  end if;

  select coalesce(nullif(btrim(s.company_name), ''), 'Moja firma')
  into v_company_name
  from public.settings s
  where s.user_id = v_uid
  limit 1;

  v_company_name := coalesce(v_company_name, 'Moja firma');

  begin
    insert into public.companies (owner_id, name)
    values (v_uid, v_company_name)
    returning id into v_company_id;

    insert into public.company_members (company_id, user_id, role, status)
    values (v_company_id, v_uid, 'owner', 'active');

    insert into public.company_billing_profile (company_id, legal_name)
    values (v_company_id, v_company_name);
  exception
    when unique_violation then
      select m.company_id, m.role
      into v_existing
      from public.company_members m
      where m.user_id = v_uid
        and m.status = 'active'
      limit 1;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = 'ESBLU_OWNER_BOOTSTRAP_RACE_UNRESOLVED';
      end if;

      return query select v_existing.company_id, v_existing.role, false;
      return;
  end;

  update public.beta_allowlist
  set consumed_at = coalesce(consumed_at, now()),
      consumed_by = v_uid
  where email = v_email;

  return query select v_company_id, 'owner'::text, true;
end;
$function$;

revoke all on function public.esblu_ensure_my_owner_company() from public, anon;
grant execute on function public.esblu_ensure_my_owner_company() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- P0-4 — atomické uloženie draftu faktúry
--
-- SECURITY INVOKER: zápis ide pod RLS volajúceho (invoices_update_finance_draft,
-- invoice_items_*_finance_draft) — funkcia nerozširuje žiadne oprávnenie.
-- Celé telo je jedna transakcia: ak zlyhá čokoľvek (CHECK na riadku, RLS,
-- súbežná zmena), pôvodná hlavička AJ pôvodné riadky ostanú nedotknuté.
-- Sumy riadkov počíta klient (VAT engine) ako náhľad; autoritatívny prepočet
-- robí esblu_finalize_invoice (nezmenené).
-- -----------------------------------------------------------------------------
create or replace function public.esblu_save_invoice_draft(
  p_invoice_id uuid,
  p_header jsonb,
  p_items jsonb,
  p_expected_updated_at timestamptz default null
)
returns setof public.invoices
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_invoice public.invoices%rowtype;
  v_item jsonb;
  v_position integer := 0;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if p_invoice_id is null or p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception using errcode = 'P0001', message = 'ESBLU_DRAFT_INVALID_INPUT';
  end if;

  if jsonb_array_length(p_items) > 500 then
    raise exception using errcode = 'P0001', message = 'ESBLU_DRAFT_TOO_MANY_ITEMS';
  end if;

  -- Zámok riadku (pod RLS — cudzí/finalizovaný doklad sa nenájde).
  select * into v_invoice
  from public.invoices i
  where i.id = p_invoice_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_DRAFT_NOT_FOUND';
  end if;

  if v_invoice.document_status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_FINALIZED_IMMUTABLE';
  end if;

  -- Súbežná zmena (iná karta / iný používateľ) — nič neprepísať potichu.
  if p_expected_updated_at is not null and v_invoice.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = 'P0001', message = 'ESBLU_DRAFT_STALE';
  end if;

  update public.invoices i
  set
    issue_date = case when p_header ? 'issue_date' then (p_header->>'issue_date')::date else i.issue_date end,
    due_date = case when p_header ? 'due_date' then nullif(p_header->>'due_date', '')::date else i.due_date end,
    variable_symbol = case when p_header ? 'variable_symbol' then nullif(btrim(p_header->>'variable_symbol'), '') else i.variable_symbol end,
    payment_terms_days = case when p_header ? 'payment_terms_days' then (p_header->>'payment_terms_days')::integer else i.payment_terms_days end,
    currency = case when p_header ? 'currency' then upper(btrim(p_header->>'currency')) else i.currency end,
    customer_business_partner_id = case when p_header ? 'customer_business_partner_id'
      then nullif(p_header->>'customer_business_partner_id', '')::uuid else i.customer_business_partner_id end,
    supplier_business_partner_id = case when p_header ? 'supplier_business_partner_id'
      then nullif(p_header->>'supplier_business_partner_id', '')::uuid else i.supplier_business_partner_id end,
    supplier_invoice_number = case when p_header ? 'supplier_invoice_number'
      then nullif(btrim(p_header->>'supplier_invoice_number'), '') else i.supplier_invoice_number end,
    updated_by = auth.uid(),
    updated_at = now()
  where i.id = p_invoice_id;

  delete from public.invoice_items it where it.invoice_id = p_invoice_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_position := v_position + 1;
    insert into public.invoice_items (
      invoice_id, position, description, quantity, unit, unit_price, price_mode,
      vat_category_code, vat_rate, line_net_amount, line_vat_amount, line_gross_amount
    ) values (
      p_invoice_id,
      v_position,
      v_item->>'description',
      (v_item->>'quantity')::numeric,
      v_item->>'unit',
      (v_item->>'unit_price')::numeric,
      coalesce(nullif(v_item->>'price_mode', ''), 'net'),
      v_item->>'vat_category_code',
      (v_item->>'vat_rate')::numeric,
      (v_item->>'line_net_amount')::numeric,
      (v_item->>'line_vat_amount')::numeric,
      (v_item->>'line_gross_amount')::numeric
    );
  end loop;

  return query select * from public.invoices i where i.id = p_invoice_id;
end;
$function$;

revoke all on function public.esblu_save_invoice_draft(uuid, jsonb, jsonb, timestamptz) from public, anon;
grant execute on function public.esblu_save_invoice_draft(uuid, jsonb, jsonb, timestamptz) to authenticated;

-- -----------------------------------------------------------------------------
-- P0-5 — sken technického preukazu do EXISTUJÚCEHO vozidla (zlúčenie)
--
-- Kľúč, ktorý v p_fields chýba, je null alebo prázdny reťazec, nič nemení.
-- Čísla a dátumy sa prijmú iba v platnom tvare (inak sa ignorujú, nič sa
-- nevymaže). user_id a company_id sa nikdy nemenia. SECURITY INVOKER →
-- RLS vehicles_update_owner_admin.
-- -----------------------------------------------------------------------------
create or replace function public.esblu_apply_vehicle_registration(p_vehicle_id uuid, p_fields jsonb)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id uuid;
  v_first_registration date;
  f jsonb := coalesce(p_fields, '{}'::jsonb);
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if p_vehicle_id is null or jsonb_typeof(f) <> 'object' then
    raise exception using errcode = 'P0001', message = 'ESBLU_VEHICLE_SCAN_INVALID_INPUT';
  end if;

  -- Dátum v tvare RRRR-MM-DD, ktorý neexistuje (2019-02-30, 0000-01-01),
  -- sa ignoruje — nikdy nezhodí celé uloženie skenu.
  if coalesce(f->>'datum_prvej_evidencie', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    begin
      v_first_registration := (f->>'datum_prvej_evidencie')::date;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        v_first_registration := null;
    end;
  end if;

  update public.vehicles v
  set
    spz = coalesce(nullif(btrim(f->>'spz'), ''), v.spz),
    vin = coalesce(nullif(btrim(f->>'vin'), ''), v.vin),
    znacka = coalesce(nullif(btrim(f->>'znacka'), ''), v.znacka),
    model = coalesce(nullif(btrim(f->>'model'), ''), v.model),
    palivo = coalesce(nullif(btrim(f->>'palivo'), ''), v.palivo),
    vykon = coalesce(nullif(btrim(f->>'vykon'), ''), v.vykon),
    farba = coalesce(nullif(btrim(f->>'farba'), ''), v.farba),
    rok_vyroby = case when coalesce(f->>'rok_vyroby', '') ~ '^[0-9]{4}$' then (f->>'rok_vyroby')::integer else v.rok_vyroby end,
    objem = case when coalesce(f->>'objem', '') ~ '^[0-9]{1,6}(\.[0-9]{1,3})?$' then (f->>'objem')::numeric else v.objem end,
    hmotnost = case when coalesce(f->>'hmotnost', '') ~ '^[0-9]{1,6}(\.[0-9]{1,3})?$' then (f->>'hmotnost')::numeric else v.hmotnost end,
    pocet_miest = case when coalesce(f->>'pocet_miest', '') ~ '^[0-9]{1,3}$' then (f->>'pocet_miest')::integer else v.pocet_miest end,
    datum_prvej_evidencie = coalesce(v_first_registration, v.datum_prvej_evidencie)
  where v.id = p_vehicle_id
  returning v.id into v_id;

  if v_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_VEHICLE_NOT_FOUND';
  end if;

  return v_id;
end;
$function$;

revoke all on function public.esblu_apply_vehicle_registration(uuid, jsonb) from public, anon;
grant execute on function public.esblu_apply_vehicle_registration(uuid, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- P0-6 — účtovné doklady sa z klienta tvrdo nemažú (iba archív deleted_at)
-- -----------------------------------------------------------------------------
alter table public.ai_evidence add column if not exists deleted_at timestamptz null;

comment on column public.ai_evidence.deleted_at is
  'Archivované z aktívneho zobrazenia (dodací list je účtovný doklad — tvrdé zmazanie z klienta je blokované). '
  'Súbor aj riadok ostávajú.';

create or replace function public.esblu_retain_finance_documents()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_privileged boolean;
begin
  -- Operátor, service_role (napr. zrušenie firmy) a kaskáda z nich sa
  -- nebránia — ide o výslovné, auditované cesty mimo bežného produktu.
  v_privileged := coalesce(auth.role(), '') = 'service_role'
    or session_user in ('postgres', 'service_role', 'supabase_admin');

  if v_privileged then
    return old;
  end if;

  if coalesce(old.document_type, '') in ('invoice', 'receipt', 'delivery_note') then
    raise exception using errcode = '42501', message = 'ESBLU_FINANCE_DOCUMENT_RETAINED';
  end if;

  if exists (select 1 from public.invoices i where i.source_document_id = old.id) then
    raise exception using errcode = '42501', message = 'ESBLU_FINANCE_DOCUMENT_RETAINED';
  end if;

  return old;
end;
$function$;

revoke all on function public.esblu_retain_finance_documents() from public, anon, authenticated;

drop trigger if exists esblu_retain_finance_documents on public.documents;
create trigger esblu_retain_finance_documents
before delete on public.documents
for each row execute function public.esblu_retain_finance_documents();

create or replace function public.esblu_retain_delivery_notes()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or session_user in ('postgres', 'service_role', 'supabase_admin') then
    return old;
  end if;

  if public.esblu_evidence_is_delivery_note(old.evidence_kind, old.document_type) then
    raise exception using errcode = '42501', message = 'ESBLU_FINANCE_DOCUMENT_RETAINED';
  end if;

  return old;
end;
$function$;

revoke all on function public.esblu_retain_delivery_notes() from public, anon, authenticated;

drop trigger if exists esblu_retain_delivery_notes on public.ai_evidence;
create trigger esblu_retain_delivery_notes
before delete on public.ai_evidence
for each row execute function public.esblu_retain_delivery_notes();

-- -----------------------------------------------------------------------------
-- Rozhodnutie 2 — IBAN/BIC firmy mení iba owner
-- (ani accountant, ani admin s finance.manage — finančný prístup to neimplikuje)
-- -----------------------------------------------------------------------------
create or replace function public.esblu_guard_company_bank_details()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or session_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Cudzia firma: rozhodne RLS (rovnaké odmietnutie bez ohľadu na to, či
    -- profil existuje — žiadny orákulum na cudzie company_id).
    if new.company_id is distinct from public.esblu_my_active_company_id() then
      return new;
    end if;
    -- UPSERT (insert … on conflict do update) spúšťa najprv BEFORE INSERT:
    -- ak riadok firmy už existuje, rozhodne vetva UPDATE nižšie (porovná
    -- skutočnú zmenu voči uloženej hodnote).
    if exists (select 1 from public.company_billing_profile p where p.company_id = new.company_id) then
      return new;
    end if;
    if (new.iban is not null or new.bic is not null)
       and coalesce(public.esblu_my_active_role(), '') <> 'owner' then
      raise exception using errcode = '42501', message = 'ESBLU_BANK_DETAILS_OWNER_ONLY';
    end if;
    return new;
  end if;

  if (new.iban is distinct from old.iban or new.bic is distinct from old.bic)
     and coalesce(public.esblu_my_active_role(), '') <> 'owner' then
    raise exception using errcode = '42501', message = 'ESBLU_BANK_DETAILS_OWNER_ONLY';
  end if;

  return new;
end;
$function$;

revoke all on function public.esblu_guard_company_bank_details() from public, anon, authenticated;

drop trigger if exists esblu_guard_company_bank_details on public.company_billing_profile;
create trigger esblu_guard_company_bank_details
before insert or update on public.company_billing_profile
for each row execute function public.esblu_guard_company_bank_details();

-- IBAN VYDANEJ faktúry — nie „iba owner", ale „iba nakonfigurovaný účet firmy".
--
-- Pravidlo (P0 review 2026-09-27):
--   - vydaná faktúra smie niesť IBAN firmy ako snapshot platobných údajov;
--     vytvárať/upravovať ju smie každý, koho pustí existujúca RLS
--     (esblu_my_finance_manage — owner, accountant, admin s financiami),
--   - ne-owner NESMIE podstrčiť iný účet: zadaný IBAN sa musí zhodovať s
--     IBAN v company_billing_profile tej istej (aktívnej) firmy,
--   - UPDATE, ktorý IBAN nemení (ani po normalizácii), sa nekontroluje →
--     bežná úprava konceptu funguje aj po neskoršej zmene IBAN firmy,
--   - vymazanie IBAN (NULL) nie je podvrh účtu → povolené,
--   - owner smie výslovne zadať iný účet; kedy je faktúra ešte upraviteľná,
--     rozhoduje NEZMENENÁ RLS (iba draft) a esblu_prevent_finalized_invoice_
--     mutation — tento trigger nič z toho neoslabuje ani neobchádza,
--   - prijatá faktúra (IBAN dodávateľa) sa nekontroluje; prepnutie smeru
--     received → issued sa kontroluje (trigger sleduje aj stĺpec direction),
--   - trigger NEROZŠIRUJE oprávnenia: iba odmieta, nikdy nepovoľuje nič,
--     čo by RLS nepovolila (admin bez financií / zamestnanec ostávajú
--     odmietnutí RLS),
--   - IBAN firmy sa číta iba pre AKTÍVNU firmu volajúceho — pre cudziu
--     company_id sa vždy odmietne rovnako (žiadny orákulum na cudzí IBAN).
create or replace function public.esblu_normalize_iban(p_iban text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select nullif(upper(regexp_replace(coalesce(p_iban, ''), '\s', '', 'g')), '');
$function$;

revoke all on function public.esblu_normalize_iban(text) from public, anon, authenticated;

create or replace function public.esblu_guard_issued_invoice_iban()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_new_iban text;
  v_company_iban text;
begin
  if coalesce(auth.role(), '') = 'service_role'
     or session_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;

  -- Prijatá faktúra: IBAN dodávateľa, mimo tohto pravidla.
  if new.direction is distinct from 'issued' then
    return new;
  end if;

  v_new_iban := public.esblu_normalize_iban(new.iban);

  -- Bez IBAN nie je čo podvrhnúť.
  if v_new_iban is null then
    return new;
  end if;

  -- UPDATE vydanej faktúry bez zmeny IBAN (napr. úprava riadkov/dátumov).
  if tg_op = 'UPDATE'
     and old.direction = 'issued'
     and v_new_iban is not distinct from public.esblu_normalize_iban(old.iban) then
    return new;
  end if;

  -- Owner smie výslovne zadať/zmeniť účet (upraviteľnosť stráži RLS +
  -- trigger nemennosti finalizovanej faktúry).
  if coalesce(public.esblu_my_active_role(), '') = 'owner' then
    return new;
  end if;

  -- Ostatní (už pustení RLS): iba presne nakonfigurovaný IBAN vlastnej firmy.
  if new.company_id is not distinct from public.esblu_my_active_company_id() then
    select public.esblu_normalize_iban(p.iban)
      into v_company_iban
      from public.company_billing_profile p
     where p.company_id = new.company_id;

    if v_company_iban is not null and v_new_iban = v_company_iban then
      return new;
    end if;
  end if;

  raise exception using errcode = '42501', message = 'ESBLU_INVOICE_IBAN_NOT_COMPANY_ACCOUNT';
end;
$function$;

revoke all on function public.esblu_guard_issued_invoice_iban() from public, anon, authenticated;

drop trigger if exists esblu_guard_issued_invoice_iban on public.invoices;
create trigger esblu_guard_issued_invoice_iban
before insert or update of iban, direction, company_id on public.invoices
for each row execute function public.esblu_guard_issued_invoice_iban();

-- -----------------------------------------------------------------------------
-- Rozhodnutie 1 — kmeňové dáta strojov iba owner/admin
-- (čítanie ostáva pre prevádzkové roly vrátane zamestnanca)
-- -----------------------------------------------------------------------------
drop policy if exists machines_insert_operational on public.machines;
drop policy if exists machines_update_operational on public.machines;
drop policy if exists machines_delete_operational on public.machines;
create policy machines_insert_manager on public.machines for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));
create policy machines_update_manager on public.machines for update to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'))
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));
create policy machines_delete_manager on public.machines for delete to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));

drop policy if exists machine_services_insert_operational on public.machine_services;
drop policy if exists machine_services_update_operational on public.machine_services;
drop policy if exists machine_services_delete_operational on public.machine_services;
create policy machine_services_insert_manager on public.machine_services for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));
create policy machine_services_update_manager on public.machine_services for update to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'))
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));
create policy machine_services_delete_manager on public.machine_services for delete to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));

drop policy if exists machine_photos_insert_operational on public.machine_photos;
drop policy if exists machine_photos_update_operational on public.machine_photos;
drop policy if exists machine_photos_delete_operational on public.machine_photos;
create policy machine_photos_insert_manager on public.machine_photos for insert to authenticated
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));
create policy machine_photos_update_manager on public.machine_photos for update to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'))
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));
create policy machine_photos_delete_manager on public.machine_photos for delete to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_active_role() in ('owner', 'admin'));

-- -----------------------------------------------------------------------------
-- P0-9 — beta nárok členov tímu (operátor, iba service_role)
--
-- Verejný 14-dňový trial ostáva team_members = 1 (entitlement_catalog sa
-- nemení). Uzavretá beta firma dostane výslovný, auditovateľný grant
-- source='manual'. Grant nerozširuje rolu ani finančné oprávnenie; jeho
-- odobratie nič nemaže (limity sa kontrolujú iba pri vzniku člena/pozvánky).
--
-- DETERMINISTICKÝ MODEL (company_entitlements nemá unique index; resolver
-- esblu_resolve_entitlement vyberá: bez limitu > najvyšší limit > id):
--   - firma s platným grantom BEZ limitu (napr. beta_compat) → odmietne sa
--     (ESBLU_TEAM_ALLOWANCE_ALREADY_UNLIMITED) — manuálny limit by tam bol
--     iba mätúci záznam a nikdy nesmie pôsobiť ako zníženie,
--   - firma s platným grantom source='subscription' → odmietne sa
--     (ESBLU_TEAM_ALLOWANCE_SUBSCRIPTION_MANAGED) — predplatné sa nemieša,
--   - inak: všetky aktívne MANUÁLNE team_members granty firmy sa označia
--     'revoked' a vloží sa JEDEN nový → po volaní existuje práve jeden
--     aktívny manuálny grant s požadovaným limitom (opakované volanie =
--     výslovná zmena limitu, nie hromadenie riadkov),
--   - rovnaký advisory lock ako vytváranie/prijímanie pozvánok → zmena
--     limitu je serializovaná s kontrolou kapacity.
-- -----------------------------------------------------------------------------
create or replace function public.esblu_operator_grant_team_allowance(
  p_company_id uuid,
  p_limit integer default 5,
  p_note text default 'closed beta: multi-role testing'
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
  v_source text;
begin
  if p_company_id is null or p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_TEAM_ALLOWANCE';
  end if;

  if not exists (select 1 from public.companies c where c.id = p_company_id) then
    raise exception using errcode = 'P0001', message = 'ESBLU_COMPANY_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':team_members', 0));

  select e.source into v_source
  from public.company_entitlements e
  where e.company_id = p_company_id
    and e.entitlement_key = 'team_members'
    and e.status = 'active'
    and e.valid_from <= now()
    and (e.valid_until is null or e.valid_until > now())
    and e.limit_value is null
  order by e.id
  limit 1;

  if found then
    raise exception using errcode = 'P0001', message = 'ESBLU_TEAM_ALLOWANCE_ALREADY_UNLIMITED:' || v_source;
  end if;

  if exists (
    select 1 from public.company_entitlements e
    where e.company_id = p_company_id
      and e.entitlement_key = 'team_members'
      and e.source = 'subscription'
      and e.status = 'active'
      and (e.valid_until is null or e.valid_until > now())
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_TEAM_ALLOWANCE_SUBSCRIPTION_MANAGED';
  end if;

  update public.company_entitlements e
  set status = 'revoked',
      note = left(coalesce(e.note, '') || ' [nahradené ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || ']', 1000)
  where e.company_id = p_company_id
    and e.entitlement_key = 'team_members'
    and e.source = 'manual'
    and e.status = 'active';

  insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, note)
  values (p_company_id, 'team_members', 'manual', 'active', p_limit, left(coalesce(p_note, ''), 500))
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.esblu_operator_grant_team_allowance(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.esblu_operator_grant_team_allowance(uuid, integer, text) to service_role;
