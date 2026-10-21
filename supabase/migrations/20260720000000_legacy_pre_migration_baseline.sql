-- =============================================================================
-- LEGACY BASELINE — tabuľky, ktoré v produkcii vznikli cez Supabase Dashboard
-- PRED prvou repo migráciou (20260721000100) a žiadna migrácia ich nevytvára.
--
-- PREČO
-- -----
-- Bez tohto súboru čistý replay (`supabase db reset`, nový preview/staging
-- projekt, lokálny reset) zlyhá hneď na prvej migrácii:
--   relation "public.settings" does not exist
-- Supabase od 2026-10-30 navyše nové tabuľky v `public` automaticky
-- neudeľuje Data API rolám — čistý replay preto musí vedieť postaviť schému
-- od nuly a oprávnenia nastaviť výslovne (20261021100000_explicit_data_api_grants).
--
-- ČO ROBÍ
-- -------
-- Vytvorí 9 legacy tabuliek v tvare PRED repo migráciami (bez stĺpcov,
-- obmedzení a FK, ktoré pridávajú neskoršie migrácie — tie by inak zlyhali
-- na duplicite) a ich pôvodné vlastnícke ALL politiky, ktoré neskoršie
-- migrácie menovite nahrádzajú (20260814160000). Tvar je overený
-- read-only proti produkčnému katalógu (fkpgvgvsmbpieduoatrt, 2026-10-21).
--
-- NA EXISTUJÚCICH DATABÁZACH (produkcia, staging) JE TO NO-OP
-- ----------------------------------------------------------
-- Každý objekt je chránený `if not exists` / existenciou tabuľky. Nemení
-- dáta, politiky, ani oprávnenia existujúcich tabuliek. Nemusí sa aplikovať
-- na produkciu — existuje kvôli replayu.
--
-- OPRÁVNENIA
-- ----------
-- Zámerne ŽIADNE granty pre anon / authenticated / service_role. Výsledný
-- stav určuje až 20261021100000_explicit_data_api_grants.sql.
-- grants: none (baseline — final ACL set by 20261021100000_explicit_data_api_grants)
-- =============================================================================

do $baseline$
begin
  if to_regclass('public.settings') is null then
    create table public.settings (
      id uuid primary key default gen_random_uuid(),
      company_name text,
      created_at timestamptz not null default now(),
      user_id uuid,
      logo_path text
    );
    alter table public.settings enable row level security;
    create policy "Users can manage own settings" on public.settings
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if to_regclass('public.vehicles') is null then
    create table public.vehicles (
      id uuid primary key default gen_random_uuid(),
      spz text not null,
      vin text,
      znacka text,
      model text,
      rok_vyroby bigint,
      palivo text,
      objem numeric,
      vykon text,
      farba text,
      hmotnost numeric,
      pocet_miest bigint,
      datum_prvej_evidencie date,
      stk date,
      ek date,
      user_id uuid
    );
    alter table public.vehicles enable row level security;
    create policy "Users can manage own vehicles" on public.vehicles
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if to_regclass('public.vehicle_services') is null then
    create table public.vehicle_services (
      id uuid primary key default gen_random_uuid(),
      vehicle_id uuid not null,
      service_date date,
      mileage bigint,
      title text,
      description text,
      cost numeric,
      technician text,
      next_service_date date,
      created_at timestamptz default now(),
      user_id uuid
    );
    alter table public.vehicle_services enable row level security;
    create policy "Users can manage own vehicle services" on public.vehicle_services
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if to_regclass('public.machines') is null then
    create table public.machines (
      id uuid primary key default gen_random_uuid(),
      name text,
      category text,
      manufacturer text,
      model text,
      serial_number text,
      year bigint,
      purchase_date date,
      status text,
      notes text,
      created_at timestamptz not null default now(),
      user_id uuid
    );
    alter table public.machines enable row level security;
    create policy "Users can manage own machines" on public.machines
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if to_regclass('public.machine_services') is null then
    create table public.machine_services (
      id uuid primary key default gen_random_uuid(),
      machine_id uuid,
      service_date date,
      mileage bigint,
      title text,
      description text,
      cost numeric,
      technician text,
      next_service_date date,
      created_at timestamptz not null default now(),
      user_id uuid
    );
    alter table public.machine_services enable row level security;
    create policy "Users can manage own machine services" on public.machine_services
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if to_regclass('public.machine_photos') is null then
    create table public.machine_photos (
      id uuid primary key default gen_random_uuid(),
      user_id uuid,
      machine_id uuid,
      file_path text,
      created_at timestamptz not null default now()
    );
    alter table public.machine_photos enable row level security;
    create policy "Users can manage own machine photos" on public.machine_photos
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if to_regclass('public.inventory_items') is null then
    create table public.inventory_items (
      id uuid not null default gen_random_uuid(),
      name text,
      category text,
      quantity numeric,
      unit text,
      min_quantity numeric,
      location text,
      notes text,
      created_at timestamptz not null default now(),
      user_id uuid,
      constraint invetory_items_pkey primary key (id)
    );
    alter table public.inventory_items enable row level security;
    create policy "Users can manage own inventory items" on public.inventory_items
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if to_regclass('public.inventory_photos') is null then
    create table public.inventory_photos (
      id uuid primary key default gen_random_uuid(),
      inventory_item_id uuid not null
        references public.inventory_items(id) on delete cascade,
      user_id uuid references auth.users(id) on delete set null,
      file_path text not null,
      created_at timestamptz not null default now()
    );
    alter table public.inventory_photos enable row level security;
    create policy "Users can manage own inventory photos" on public.inventory_photos
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if to_regclass('public.ai_evidence') is null then
    create table public.ai_evidence (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null,
      vehicle_id uuid,
      spz text,
      document_type text,
      movement_type text,
      supplier text,
      document_number text,
      material text,
      quantity numeric,
      unit text,
      brutto numeric,
      tara numeric,
      netto numeric,
      construction_site text,
      customer text,
      document_date date,
      document_time text,
      photo_url text,
      raw_text text,
      created_at timestamptz default now(),
      material_original text,
      material_category text,
      document_language text,
      review_status text default 'pending'::text,
      confidence_score numeric,
      source_location text,
      destination_location text
    );
    alter table public.ai_evidence enable row level security;
    create policy "Users can manage own ai evidence" on public.ai_evidence
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end
$baseline$;
