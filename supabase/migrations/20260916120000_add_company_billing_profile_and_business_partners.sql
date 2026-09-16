begin;

-- =============================================================================
-- Esblu — Fáza 1B: company_billing_profile + business_partners
-- =============================================================================
-- Toto je ČISTO ADITÍVNA (expand) migrácia — nemení, neruší ani nemaže
-- žiadnu existujúcu tabuľku, stĺpec ani dáta. settings.company_name,
-- settings.logo_path a settings.plan ZOSTÁVAJÚ (vestigiálne/legacy), iba
-- appka ich od tejto migrácie ďalej nečíta/nezapisuje pre firemný branding.
--
-- ROZSAH (Fáza 1B, schválené zadanie):
--   1. company_billing_profile — nová tabuľka, 1:1 s companies, jediný
--      living source-of-truth pre firemné/fakturačné údaje (branding +
--      budúci fakturačný základ). NIE právny snapshot faktúry — finalizované
--      faktúry si (vo Fáze 2) tieto údaje nasnapshotujú do vlastných stĺpcov.
--   2. RLS: SELECT pre všetkých aktívnych členov firmy, INSERT/UPDATE iba
--      owner/admin, ŽIADNY klientsky DELETE (iba ON DELETE CASCADE pri
--      zmazaní companies riadku).
--   3. Jednorazový idempotentný backfill z existujúcich settings (owner s
--      najstarším aktívnym membership per firma → legal_name/logo_path),
--      s bezpečným fallbackom (companies.name → 'Moja firma').
--   4. esblu_get_company_profile() — prepísané na company_billing_profile
--      namiesto JOIN cez owner.settings (zároveň opravuje latentnú
--      nekonzistenciu: ak admin, nie owner, doteraz zmenil názov/logo,
--      zapísalo sa to do JEHO VLASTNÉHO settings riadku, ktorý
--      esblu_get_company_profile nikdy nečítala — company-scoped tabuľka
--      tento triedny problém odstraňuje). Návratový tvar (company_name,
--      logo_path) zámerne NEZMENENÝ — zachováva existujúci klientsky
--      kontrakt (lib/company.ts CompanyProfile), mení sa iba zdroj dát.
--      Grant pre `anon` sa odoberá (nepoužívané — RPC volá výhradne
--      Dashboard.tsx po prihlásení).
--   5. business_partners — nová company-scoped master-data tabuľka
--      (zákazníci/dodávatelia). Zámerne ŽIADNE invoices/invoice_items v
--      tejto fáze.
--   6. RLS business_partners: SELECT pre všetkých aktívnych členov firmy,
--      INSERT/UPDATE/DELETE iba owner/admin (zámerné, konzervatívne
--      defaultné rozhodnutie — employee dnes nemá explicitné permissions na
--      túto akciu, viď company_members.permissions, ktorý appka dnes vôbec
--      nepoužíva).
--
-- BEZPEČNOSTNÝ VZOR: RLS politiky nižšie 1:1 kopírujú existujúci, už
-- auditovaný vzor z public.vehicles / public.custom_document_categories —
-- esblu_my_active_company_id() a esblu_my_active_role() sú existujúce
-- SECURITY DEFINER helpery (SET search_path TO ''), žiadne nové
-- privilegované funkcie okrem samotnej esblu_get_company_profile() sa
-- nezavádzajú. Žiadne explicitné GRANT príkazy pre nové tabuľky — presne
-- ako pri každej inej public tabuľke v tejto schéme, RLS je jediná reálna
-- hranica (Supabase default privileges pre anon/authenticated sú
-- neutralizované tým, že esblu_my_active_company_id()/...role() vrátia
-- NULL pre neprihláseného volajúceho → qual nikdy nie je true).
-- =============================================================================


-- =============================================================================
-- 1. company_billing_profile
-- =============================================================================

create table public.company_billing_profile (
  company_id uuid primary key references public.companies(id) on delete cascade,

  legal_name text,
  ico text,
  dic text,
  ic_dph text,

  address_line1 text,
  address_line2 text,
  city text,
  postal_code text,
  country_code text,

  iban text,
  bic text,
  contact_email text,

  default_due_days integer,
  default_currency text,
  default_vat_rate numeric(5, 2),
  invoice_numbering_prefix text,

  logo_path text,

  created_at timestamptz not null default now(),
  updated_at timestamptz,
  -- Kto naposledy upravil zdieľaný firemný záznam (owner AJ admin ho môžu
  -- meniť) — čisto informačné pre podporu/audit, nie bezpečnostný
  -- mechanizmus (ten je RLS nižšie). ON DELETE SET NULL: zmazanie
  -- používateľa (napr. odchod z firmy) nikdy nezablokuje/nezruší samotný
  -- profil.
  updated_by uuid references auth.users(id) on delete set null,

  constraint company_billing_profile_country_code_format check (
    country_code is null or country_code ~ '^[A-Z]{2}$'
  ),
  constraint company_billing_profile_currency_format check (
    default_currency is null or default_currency ~ '^[A-Z]{3}$'
  ),
  constraint company_billing_profile_due_days_range check (
    default_due_days is null or (default_due_days >= 0 and default_due_days <= 365)
  ),
  constraint company_billing_profile_vat_rate_range check (
    default_vat_rate is null or (default_vat_rate >= 0 and default_vat_rate <= 100)
  ),
  -- "Prázdna hodnota = null" + "ukladaj normalizovane bez zbytočných
  -- medzier" (zadanie bod 3) vynútené na DB úrovni ako posledná poistka —
  -- appka normalizuje/trimuje PRED zápisom, toto iba odmietne očividne
  -- nenormalizovaný vstup (obchádzajúci appku, napr. priamy API call).
  constraint company_billing_profile_legal_name_trimmed check (
    legal_name is null or (legal_name = btrim(legal_name) and length(legal_name) > 0)
  ),
  constraint company_billing_profile_ico_trimmed check (
    ico is null or (ico = btrim(ico) and length(ico) > 0)
  ),
  constraint company_billing_profile_dic_trimmed check (
    dic is null or (dic = btrim(dic) and length(dic) > 0)
  ),
  constraint company_billing_profile_ic_dph_trimmed check (
    ic_dph is null or (ic_dph = btrim(ic_dph) and length(ic_dph) > 0)
  ),
  constraint company_billing_profile_iban_trimmed check (
    iban is null or (iban = btrim(iban) and length(iban) > 0)
  ),
  constraint company_billing_profile_bic_trimmed check (
    bic is null or (bic = btrim(bic) and length(bic) > 0)
  ),
  constraint company_billing_profile_contact_email_trimmed check (
    contact_email is null or (contact_email = btrim(contact_email) and length(contact_email) > 0)
  ),
  constraint company_billing_profile_prefix_trimmed check (
    invoice_numbering_prefix is null
    or (invoice_numbering_prefix = btrim(invoice_numbering_prefix) and length(invoice_numbering_prefix) > 0)
  )
);

comment on table public.company_billing_profile is
  'Jediný living source-of-truth pre firemné/fakturačné údaje firmy (1:1 s companies). NAHRÁDZA settings.company_name/settings.logo_path ako zdroj brandingu (tie ostávajú v DB ako legacy, appka ich už nečíta/nezapisuje). Mutable master data — NIE právny snapshot faktúry (ten príde vo Fáze 2 ako samostatné invoice_parties stĺpce). Žiadny právny status (platiteľ DPH a pod.) sa z týchto polí NEODVODZUJE appkou.';

comment on column public.company_billing_profile.ic_dph is
  'IČ DPH podľa toho, čo používateľ sám zadal — appka z jeho (ne)vyplnenia NIKDY netvrdí/neodvodzuje, že firma JE/NIE JE platiteľom DPH.';

comment on column public.company_billing_profile.updated_by is
  'Posledný owner/admin, ktorý záznam upravil — informačné pre podporu/audit. Bezpečnostné vynútenie je výhradne cez RLS (company_billing_profile_update_owner_admin), toto nie je autorizačný mechanizmus.';

alter table public.company_billing_profile enable row level security;

create policy company_billing_profile_select_company
  on public.company_billing_profile
  for select
  using (company_id = public.esblu_my_active_company_id());

create policy company_billing_profile_insert_owner_admin
  on public.company_billing_profile
  for insert
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and (updated_by is null or updated_by = auth.uid())
  );

create policy company_billing_profile_update_owner_admin
  on public.company_billing_profile
  for update
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and (updated_by is null or updated_by = auth.uid())
  );

-- Zámerne ŽIADNA DELETE politika — priamy klientský DELETE nie je nikdy
-- povolený (bod 7 zadania). Profil zaniká VÝHRADNE cez
-- "on delete cascade" pri zmazaní public.companies riadku
-- (esblu_owner_delete_company, 20260816100000) — service_role transakcia,
-- nie klientská RLS cesta.


-- =============================================================================
-- 2. Backfill z existujúcich settings (jednorazový, idempotentný)
-- =============================================================================
-- Deterministický výber ownera: NAJSTARŠIE aktívne company_members
-- membership s role='owner' pre danú firmu (ORDER BY created_at ASC LIMIT 1
-- na firmu, cez LATERAL JOIN — nie cross-company, každá firma sa rieši
-- nezávisle vo vlastnom riadku).
--
-- Fallback reťazec pre legal_name presne podľa zadania:
--   owner.settings.company_name (ak nie je prázdny) → companies.name
--   (NOT NULL, vždy existuje — pozri esblu_ensure_my_owner_company, ktorá
--   ho už dnes defaultuje na 'Moja firma') → 'Moja firma' (poistka, v praxi
--   nedosiahnuteľná vetva, keďže companies.name je NOT NULL).
--
-- logo_path môže ostať NULL (firma bez loga). "on conflict do nothing"
-- robí INSERT bezpečne opakovateľný — druhé spustenie tejto migrácie (alebo
-- prípadný budúci re-run) by NIKDY neprepísalo už existujúci riadok.
insert into public.company_billing_profile (company_id, legal_name, logo_path)
select
  c.id,
  coalesce(nullif(btrim(owner_settings.company_name), ''), nullif(btrim(c.name), ''), 'Moja firma'),
  owner_settings.logo_path
from public.companies c
left join lateral (
  select cm.user_id
  from public.company_members cm
  where cm.company_id = c.id
    and cm.status = 'active'
    and cm.role = 'owner'
  order by cm.created_at asc
  limit 1
) owner_cm on true
left join public.settings owner_settings
  on owner_settings.user_id = owner_cm.user_id
on conflict (company_id) do nothing;


-- =============================================================================
-- 3. esblu_get_company_profile() — prepis na company_billing_profile
-- =============================================================================
create or replace function public.esblu_get_company_profile()
returns table(company_name text, logo_path text)
language sql
stable security definer
set search_path to ''
as $function$
  select bp.legal_name, bp.logo_path
  from public.company_members my_cm
  join public.company_billing_profile bp
    on bp.company_id = my_cm.company_id
  where my_cm.user_id = auth.uid()
    and my_cm.status = 'active'
  limit 1;
$function$;

comment on function public.esblu_get_company_profile() is
  'Firemný branding (legal_name/logo_path z company_billing_profile) pre AKTÍVNEHO PRIHLÁSENÉHO ČLENA firmy, bez ohľadu na rolu. OPRAVA 16.9.2026 (Fáza 1B): predtým JOIN-ovala cez owner.settings — ak admin (nie owner) zmenil firemný názov/logo, zapísalo sa to do jeho vlastného settings riadku, ktorý táto funkcia nikdy nečítala (branding admin zmeny sa nikdy neprejavili). company_billing_profile je company-scoped, nie user-scoped, takže tento problém odstraňuje. Návratový tvar (company_name, logo_path) zámerne nezmenený pre kompatibilitu s existujúcim klientom (lib/company.ts).';

-- anon grant sa odoberá — nepoužívané (RPC volá výhradne Dashboard.tsx po
-- prihlásení, viď lib/company.ts getCompanyProfile()). authenticated
-- zostáva, keďže klient ho reálne potrebuje.
revoke execute on function public.esblu_get_company_profile() from public;
revoke execute on function public.esblu_get_company_profile() from anon;
grant execute on function public.esblu_get_company_profile() to authenticated;


-- =============================================================================
-- 4. esblu_ensure_my_owner_company() — nová firma dostane billing profile
--    riadok atomicky pri vzniku (rovnaká transakcia ako companies/
--    company_members insert nižšie)
-- =============================================================================
-- Jediná zmena oproti pôvodnej definícii: jeden nový INSERT do
-- company_billing_profile hneď po založení companies/company_members
-- riadkov, v tom istom exception-guarded bloku (unique_violation race
-- handling ostáva bezo zmeny — ak druhé súbežné volanie firmu už založilo,
-- tento INSERT sa vôbec nevykoná, vykoná ho VÍŤAZNÉ volanie). Bez tejto
-- zmeny by novozaložená firma nemala company_billing_profile riadok až do
-- prvého uloženia v Nastaveniach — branding by dovtedy zostal prázdny.
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

    -- NOVÉ (Fáza 1B) — pozri komentár nad funkciou.
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


-- =============================================================================
-- 5. business_partners
-- =============================================================================

create table public.business_partners (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  kind text not null check (kind in ('customer', 'supplier', 'both')),
  legal_name text not null check (legal_name = btrim(legal_name) and length(legal_name) > 0),

  ico text,
  dic text,
  ic_dph text,

  address_line1 text,
  address_line2 text,
  city text,
  postal_code text,
  country_code text,

  email text,
  phone text,
  peppol_identifier text,

  default_payment_terms_days integer,
  default_currency text,

  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,

  constraint business_partners_country_code_format check (
    country_code is null or country_code ~ '^[A-Z]{2}$'
  ),
  constraint business_partners_currency_format check (
    default_currency is null or default_currency ~ '^[A-Z]{3}$'
  ),
  constraint business_partners_payment_terms_range check (
    default_payment_terms_days is null
    or (default_payment_terms_days >= 0 and default_payment_terms_days <= 365)
  ),
  constraint business_partners_ico_trimmed check (
    ico is null or (ico = btrim(ico) and length(ico) > 0)
  ),
  constraint business_partners_dic_trimmed check (
    dic is null or (dic = btrim(dic) and length(dic) > 0)
  ),
  constraint business_partners_ic_dph_trimmed check (
    ic_dph is null or (ic_dph = btrim(ic_dph) and length(ic_dph) > 0)
  ),
  constraint business_partners_email_trimmed check (
    email is null or (email = btrim(email) and length(email) > 0)
  ),
  constraint business_partners_phone_trimmed check (
    phone is null or (phone = btrim(phone) and length(phone) > 0)
  ),
  constraint business_partners_peppol_trimmed check (
    peppol_identifier is null or (peppol_identifier = btrim(peppol_identifier) and length(peppol_identifier) > 0)
  )
);

comment on table public.business_partners is
  'Company-scoped master data pre obchodných partnerov (zákazník/dodávateľ/oboje). Mutable master data — NIE právny snapshot faktúry (Fáza 2 si tieto údaje nasnapshotuje do invoice_parties). Môže obsahovať osobné údaje (SZČO/fyzická osoba podnikateľ) — zbierajú sa VÝHRADNE fakturačne/obchodne potrebné polia, žiadne dátumy narodenia/rodné čísla/osobné poznámky (viď report, GDPR impact pre CLIA).';

comment on column public.business_partners.kind is
  'customer | supplier | both — filter v UI, žiadna ďalšia business logika v tejto fáze.';

comment on column public.business_partners.peppol_identifier is
  'Voliteľný Peppol identifikátor partnera — pripravené pre budúcu eFaktúra fázu, appka ho v tejto fáze nijako nevaliduje/nepoužíva mimo unique indexu nižšie.';

-- Dedup (bod 11 zadania): ŽIADEN globálny/per-company unique na legal_name
-- (bežné a legitímne mať viac partnerov s podobným/rovnakým názvom, najmä
-- fyzické osoby). IČO a peppol_identifier majú per-company partial unique
-- index IBA keď nie sú null — viacero partnerov bez IČO (napr. zahraniční
-- bez lokálneho registračného čísla) je validný use-case a musí byť možný.
create unique index business_partners_company_ico_unique
  on public.business_partners (company_id, ico)
  where ico is not null;

create unique index business_partners_company_peppol_unique
  on public.business_partners (company_id, peppol_identifier)
  where peppol_identifier is not null;

create index business_partners_company_id_idx
  on public.business_partners (company_id);

create index business_partners_company_kind_idx
  on public.business_partners (company_id, kind);

alter table public.business_partners enable row level security;

-- SELECT: všetci aktívni členovia firmy (owner/admin/employee).
create policy business_partners_select_company
  on public.business_partners
  for select
  using (company_id = public.esblu_my_active_company_id());

-- INSERT/UPDATE/DELETE: iba owner/admin — DEFAULT konzervatívne
-- rozhodnutie (bod 12 zadania: "DEFAULT TERAZ: employee nech nemá
-- create/edit/delete, ak audit neukáže explicitné permissions na toto" —
-- audit potvrdil, že company_members.permissions jsonb je dnes v appke
-- nepoužívaný stĺpec, žiadny existujúci permission model na toto
-- neexistuje, takže sa nezavádza nový komplikovaný systém, iba jednoduchý
-- owner/admin gate zhodný s public.vehicles).
create policy business_partners_insert_owner_admin
  on public.business_partners
  for insert
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and (created_by is null or created_by = auth.uid())
    and (updated_by is null or updated_by = auth.uid())
  );

create policy business_partners_update_owner_admin
  on public.business_partners
  for update
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and (updated_by is null or updated_by = auth.uid())
  );

create policy business_partners_delete_owner_admin
  on public.business_partners
  for delete
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
  );

commit;
