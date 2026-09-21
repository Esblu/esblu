-- =============================================================================
-- 20260923100000_accountant_least_privilege_entity_resolver.sql
--
-- Sprísnenie rozsahu účtovníka + minimálny resolver identifikátorov entít.
--
-- PREČO
-- -----
-- Migrácia 20260922100000 zobrala účtovníkovi ZÁPIS do prevádzkových modulov,
-- ale ČÍTANIE mu nechala otvorené s odôvodnením "potrebuje identifikovať
-- entitu na doklade". To je príliš široké: na zobrazenie "Vozidlo — BA123AB"
-- pri doklade nepotrebuje VIN, najazdené kilometre, servisné záznamy,
-- fotografie, diaľničné známky ani interné poznámky. Dostával celý
-- prevádzkový denník firmy, hoci mu z neho patrí jeden reťazec.
--
-- ČO SA MENÍ
-- ----------
--  1. SELECT na vehicles, machines, inventory_items, vehicle_services,
--     machine_services, vehicle_photos, machine_photos, inventory_photos,
--     vehicle_vignettes a ai_evidence sa viaže na esblu_role_can_operate().
--     Účtovník cez ňu neprejde — od tejto migrácie nevidí z prevádzky nič.
--  2. Pribúda esblu_document_entity_labels() — jediná cesta, ktorou sa
--     účtovník dostane k označeniu vozidla či stroja, a to VÝHRADNE pre
--     entity, na ktoré sa odvoláva doklad, ktorý smie čítať.
--
-- ČO RESOLVER VRACIA A ČO NIE
-- ---------------------------
-- Vracia: typ entity, jej id a jeden zobraziteľný reťazec.
-- Nevracia: VIN, rok výroby, palivo, výkon, STK/EK, sériové čísla,
-- kategórie, poznámky, ceny, servisy, fotky — teda nič, čo by sa dalo
-- použiť na čokoľvek iné než napísať používateľovi, o ktorú entitu ide.
--
-- Návratová hodnota je zámerne JEDEN text, nie sada stĺpcov. Keby to boli
-- stĺpce, pri najbližšom rozširovaní by do nich niekto pridal "ešte len
-- rok výroby" a rozsah by sa ticho roztiahol späť.
--
-- PREČO SECURITY DEFINER
-- ----------------------
-- Funkcia musí čítať vehicles/machines aj pre volajúceho, ktorému RLS
-- tieto tabuľky práve zavrela. Preto obchádza RLS — a preto si vnútri
-- sama overuje firmu volajúceho aj to, že entita je naozaj naviazaná na
-- doklad, ktorý volajúci smie vidieť. Bez tejto dvojitej kontroly by to
-- bol tunel okolo RLS, nie resolver.
--
-- ROLLBACK
-- --------
-- Aditívne voči dátam. Návrat = obnoviť pôvodné *_select_company policies
-- (company_id = esblu_my_active_company_id()) a zahodiť funkciu.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Prevádzkové tabuľky — čítanie iba pre prevádzkové role
-- -----------------------------------------------------------------------------

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'vehicles', 'machines', 'inventory_items',
    'vehicle_services', 'machine_services',
    'vehicle_photos', 'machine_photos', 'inventory_photos',
    'vehicle_vignettes', 'ai_evidence'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', v_table || '_select_company', v_table);

    execute format($f$
      create policy %I on public.%I
        for select to authenticated
        using (
          company_id = public.esblu_my_active_company_id()
          and public.esblu_role_can_operate()
        )
    $f$, v_table || '_select_operational', v_table);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Minimálny resolver označení entít
-- -----------------------------------------------------------------------------

create or replace function public.esblu_document_entity_labels()
returns table (entity_type text, entity_id uuid, label text)
language sql
stable
security definer
set search_path to ''
as $$
  -- Vozidlá naviazané na doklad, ktorý volajúci smie čítať.
  select
    'vehicle'::text as entity_type,
    v.id as entity_id,
    -- ŠPZ je to, čím sa vozidlo v doklade označuje; značka a model sú iba
    -- doplnok, aby používateľ nepozeral na holý reťazec znakov.
    nullif(
      btrim(
        coalesce(v.spz, '') ||
        case
          when coalesce(v.znacka, '') <> '' or coalesce(v.model, '') <> ''
            then ' — ' || btrim(coalesce(v.znacka, '') || ' ' || coalesce(v.model, ''))
          else ''
        end
      ),
      ''
    ) as label
  from public.vehicles v
  where v.company_id = public.esblu_my_active_company_id()
    and exists (
      select 1
      from public.document_links dl
      where dl.vehicle_id = v.id
        and dl.company_id = public.esblu_my_active_company_id()
        and public.esblu_can_read_document(dl.document_id)
    )

  union all

  select
    'machine'::text,
    m.id,
    nullif(btrim(coalesce(m.name, '')), '')
  from public.machines m
  where m.company_id = public.esblu_my_active_company_id()
    and exists (
      select 1
      from public.document_links dl
      where dl.machine_id = m.id
        and dl.company_id = public.esblu_my_active_company_id()
        and public.esblu_can_read_document(dl.document_id)
    );
$$;

comment on function public.esblu_document_entity_labels() is
  'Minimálne označenia vozidiel a strojov, na ktoré sa odvoláva doklad viditeľný volajúcim. Jediná cesta, ktorou sa účtovník dostane k identifikácii prevádzkovej entity — vracia iba typ, id a jeden zobraziteľný reťazec, nikdy prevádzkový detail. Dvojitá kontrola: firma volajúceho AND existencia čitateľného document_link.';

revoke all on function public.esblu_document_entity_labels() from public, anon;
grant execute on function public.esblu_document_entity_labels() to authenticated;

commit;
