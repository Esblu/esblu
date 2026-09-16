-- =============================================================================
-- Fix: DELETE firemného loga zlyháva s "database error, code: 42883"
-- + rovnaký potvrdený latentný bug v esblu_can_delete_machine_photo_object
-- =============================================================================
-- ROZŠÍRENIE (16.9.2026, pred prvou aplikáciou tejto migrácie kdekoľvek):
-- pôvodný audit company-logo bugu (nižšie) explicitne upozornil, že rovnaký
-- MAX(uuid) root cause existuje aj v `esblu_can_delete_machine_photo_object`
-- (DELETE politika pre bucket `machine-photos`), zatiaľ nenahlásený ako
-- produkčný incident. Používateľ požiadal o jeho opravu v rámci TEJTO ešte
-- neaplikovanej migrácie (bod 2 nižšie) namiesto samostatnej migrácie, keďže
-- ide o rovnaký root cause a migrácia sa nikde ešte neaplikovala. Bod 1 nižšie
-- je pôvodná (nezmenená) oprava company-logo bugu.
--
-- PRODUKČNÝ PREJAV (bod 1 — company logo): v Nastavenia -> Firma -> Firemné
-- logo, pri DELETE loga (Storage.remove()) appka zobrazí "Logo sa nepodarilo
-- vymazať z úložiska: database error, code: 42883".
--
-- ROOT CAUSE (potvrdené priamym testom v produkčnej DB, 16.9.2026):
--   `select max('...'::uuid);` -> ERROR 42883: function max(uuid) does not
--   exist. PostgreSQL nemá vstavaný MAX/MIN agregát pre typ `uuid` (má iba
--   porovnávacie operátory cez btree operator class, nie agregáty).
--
--   Failing expression bola v tele `public.esblu_can_manage_company_logo_object
--   (p_object_name text)`:
--
--     select
--       count(*),
--       max(cm.company_id)          -- <<< tu, cm.company_id je uuid
--     into
--       v_uploader_active_company_count,
--       v_uploader_company_id
--     from public.company_members cm
--     where cm.user_id::text = v_uploader_uid
--       and cm.status = 'active';
--
--   Táto funkcia je qual RLS politiky `company_logos_delete_owner_admin`
--   (cmd=DELETE) na `storage.objects` pre bucket `company-logos` — to je
--   presne dôvod, prečo chyba nastáva IBA pri DELETE: INSERT/UPDATE/SELECT
--   politiky pre `company-logos` používajú inline EXISTS/JOIN výrazy bez
--   MAX(), takže tento konkrétny bug nezasahuje upload ani zobrazenie loga.
--
--   DÔLEŽITÉ: presne tento istý bug (MAX(uuid)) bol v minulosti už nájdený
--   a opravený pre `esblu_can_delete_vehicle_photo_object` a
--   `esblu_can_delete_inventory_photo_object` (obe majú explicitný komentár
--   "Zámerne bez MAX(uuid)") — táto migrácia aplikuje ROVNAKÝ, už overený
--   opravný vzor na `esblu_can_manage_company_logo_object`.
--
--   POZNÁMKA: identický latentný bug (MAX(uuid)) bol pôvodne nájdený aj v
--   `esblu_can_delete_machine_photo_object` (DELETE politika pre bucket
--   `machine-photos`) — v čase pôvodného auditu dnes zatiaľ nenahlásený ako
--   produkčný incident. Na žiadosť používateľa je opravený v BODE 2 tejto
--   istej migrácie (nižšie), tým istým overeným vzorom.
--
-- PRODUKČNÉ DÁTA (read-only audit, 16.9.2026, žiadne mazanie):
--   - 1 aktívny logo_path v `settings` (firma "Anchar Bau", owner
--     9932bb02-926f-47d2-9490-7c8fd827e32a): objekt v Storage EXISTUJE,
--     žiadna dangling DB referencia.
--   - 1 orphaned Storage objekt v `company-logos` (rovnaký uploader,
--     starší, nereferencovaný žiadnym logo_path) — vznikol pri predošlej
--     výmene loga (handleLogoChange odstraňuje staré logo tým istým DELETE
--     policy flow a chybu iba loguje do konzoly bez UI alertu) — teda ide o
--     ten istý root cause, iba tichšie sa prejavujúci. Orphan sa touto
--     migráciou NEODSTRAŇUJE (vyžaduje samostatné schválenie cleanupu).
--
-- OPRAVA: rovnaký "count-then-fetch" vzor ako v
-- esblu_can_delete_vehicle_photo_object/esblu_can_delete_inventory_photo_object
-- — najprv COUNT(*) (bezpečný pre každý typ), a AŽ PO potvrdení, že existuje
-- presne 1 aktívne členstvo, samostatný SELECT ... LIMIT 1 na načítanie tej
-- jednej hodnoty. Bezpečnostná sémantika je IDENTICKÁ s pôvodným zámerom
-- (fail-closed pri 0 alebo >1 aktívnych členstvách uploadera) — mení sa iba
-- SQL implementácia, nie kto smie čo mazať. Signatúra funkcie
-- (esblu_can_manage_company_logo_object(text) returns boolean) aj názov
-- ostávajú identické, takže RLS politika `company_logos_delete_owner_admin`
-- sa nemusí meniť vôbec.
-- =============================================================================

create or replace function public.esblu_can_manage_company_logo_object(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_uploader_uid text;
  v_uploader_active_company_count integer;
  v_uploader_company_id uuid;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  -- Krok 1: iba COUNT(*) (bez MAX(uuid), ktoré v PostgreSQL pre typ uuid
  -- neexistuje ako agregát -> pôvodná príčina 42883). Porovnanie cez ::text,
  -- aby malformovaný/neuuid segment cesty nespôsobil cast chybu namiesto
  -- bezpečného "0 riadkov".
  select count(*)
  into v_uploader_active_company_count
  from public.company_members cm
  where cm.user_id::text = v_uploader_uid
    and cm.status = 'active';

  if v_uploader_active_company_count <> 1 then
    -- Pôvodný nahrávateľ dnes nie je aktívny člen presne jednej firmy
    -- (0 = odišiel z firmy alebo neplatný segment cesty; >1 teoreticky
    -- nekonzistentné dáta) -> fail-closed, nikdy neautorizovať.
    return false;
  end if;

  -- Krok 2: presne 1 riadok potvrdený vyššie -> bezpečné načítať jeho
  -- company_id samostatným SELECTom (žiadny MAX potrebný).
  select cm.company_id
  into v_uploader_company_id
  from public.company_members cm
  where cm.user_id::text = v_uploader_uid
    and cm.status = 'active'
  limit 1;

  -- Caller musí byť aktívny owner/admin TEJ ISTEJ firmy ako pôvodný
  -- nahrávateľ. Pokrýva aj self-cleanup vlastného draftu — v tom prípade je
  -- caller == uploader a podmienka je triviálne splnená, keďže INSERT do
  -- tohto bucketu už dnes vyžaduje rolu owner/admin.
  return exists (
    select 1
    from public.company_members cm
    where cm.user_id = v_uid
      and cm.status = 'active'
      and cm.role in ('owner', 'admin')
      and cm.company_id = v_uploader_company_id
  );
end;
$function$;

comment on function public.esblu_can_manage_company_logo_object(text) is
  'RLS helper pre storage.objects politiku company_logos_delete_owner_admin '
  '(bucket company-logos). Autorizuje DELETE iba pre aktívneho owner/admin '
  'TEJ ISTEJ firmy, ktorej aktívnym členom je pôvodný nahrávateľ (prvý '
  'segment cesty). OPRAVA 16.9.2026: predtým používala MAX(uuid), ktorý v '
  'PostgreSQL neexistuje ako agregát pre typ uuid -> spôsobovalo produkčnú '
  'chybu 42883 pri každom pokuse o DELETE loga. Nahradené bezpečným '
  'count-then-fetch vzorom (rovnaký, aký už používajú '
  'esblu_can_delete_vehicle_photo_object a '
  'esblu_can_delete_inventory_photo_object) — bezpečnostná sémantika '
  '(fail-closed pri 0 alebo >1 aktívnych členstvách uploadera) je '
  'nezmenená. Rovnaký MAX(uuid) bug bol v tej istej migrácii opravený aj v '
  'esblu_can_delete_machine_photo_object (viď nižšie).';

-- =============================================================================
-- Fix (bod 2, doplnené na žiadosť používateľa po schválení opravy company
-- loga): identický potvrdený latentný bug v
-- public.esblu_can_delete_machine_photo_object (DELETE politika
-- machine_photos_delete_company, bucket machine-photos).
-- =============================================================================
-- AUDIT PRED OPRAVOU (16.9.2026, priamo z produkčnej DB, žiadny predpoklad):
--   Aktuálne telo obsahovalo:
--     select
--       count(*),
--       count(*) filter (where mp.company_id is null),
--       count(distinct mp.company_id),
--       max(mp.company_id)            -- <<< rovnaký root cause ako logo bug
--     into ...
--     from public.machine_photos mp
--     where mp.file_path = p_object_name;
--   Reprodukované end-to-end na reálnom produkčnom riadku
--   (machine_photos.file_path pre firmu Anchar Bau) -> identická
--   `ERROR 42883: function max(uuid) does not exist`. Keďže "function does
--   not exist" je chyba plánovača (rozlíšenie preťaženej funkcie podľa typu
--   argumentu pri parsovaní), nastáva VŽDY pri pokuse o DELETE ľubovoľnej
--   machine-photos fotky, nezávisle od počtu zhodných riadkov — teda ide o
--   rovnako všeobecný produkčný bug ako pri company-logu, iba zatiaľ
--   nenahlásený.
--
-- BEZPEČNOSTNÝ MODEL — ZACHOVANÝ BEZO ZMENY (dôležitý rozdiel oproti
-- company-logu): funkcia dnes NEKONTROLUJE rolu — ktorýkoľvek aktívny člen
-- firmy (owner/admin/employee), nie iba owner/admin, smie zmazať
-- machine-photos fotku patriacu jeho firme (zrkadlí názov politiky
-- `machine_photos_delete_company`, nie `..._owner_admin`, a existujúci
-- komentár vo funkcii "plný prístup, nie iba owner/admin"). Oprava nižšie
-- mení VÝHRADNE odstránenie MAX(uuid) — podmienka `cm.company_id = v_company_id`
-- ostáva bez akéhokoľvek `role in (...)` filtra, presne ako dnes.
--
-- Signatúra (esblu_can_delete_machine_photo_object(text) returns boolean),
-- názov aj RLS politika `machine_photos_delete_company` ostávajú identické
-- — politika sa nemusí meniť vôbec. Grants (authenticated/postgres/
-- service_role, žiadny anon/PUBLIC) sa touto migráciou nemenia — CREATE OR
-- REPLACE zachováva existujúce grants nedotknuté.
-- =============================================================================

create or replace function public.esblu_can_delete_machine_photo_object(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_uploader_uid text;
  v_referenced_row_count integer;
  v_null_company_count integer;
  v_distinct_company_count integer;
  v_company_id uuid;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  -- SECURITY DEFINER, beží MIMO machine_photos_select_company RLS —
  -- výsledok je autoritatívny bez ohľadu na to, čo by caller bežne videl.
  -- Krok 1: iba count-agregáty (bez MAX(uuid), ktoré v PostgreSQL pre typ
  -- uuid neexistuje ako agregát -> pôvodná príčina 42883).
  select
    count(*),
    count(*) filter (where mp.company_id is null),
    count(distinct mp.company_id)
  into
    v_referenced_row_count,
    v_null_company_count,
    v_distinct_company_count
  from public.machine_photos mp
  where mp.file_path = p_object_name;

  if v_referenced_row_count = 0 then
    -- Draft/nereferencovaný upload (zlyhaný INSERT) — iba pôvodný
    -- nahrávateľ, bez ohľadu na rolu (nezmenené, tento vetva MAX nikdy
    -- nepoužívala).
    return v_uploader_uid = v_uid::text;
  end if;

  if v_null_company_count > 0 or v_distinct_company_count <> 1 then
    -- Objekt JE referencovaný, ale dáta sú nekonzistentné — fail-closed.
    return false;
  end if;

  -- Krok 2: presne jedna jednoznačná company_id potvrdená vyššie -> bezpečné
  -- načítať ju samostatným SELECTom (žiadny MAX potrebný).
  select mp.company_id
  into v_company_id
  from public.machine_photos mp
  where mp.file_path = p_object_name
    and mp.company_id is not null
  limit 1;

  -- Presne jedna jednoznačná company_id → DELETE pre KTORÉHOKOĽVEK
  -- aktívneho člena tej firmy (zrkadlí machine_photos_delete_company na DB
  -- tabuľke — plný prístup, nie iba owner/admin). Nezmenené oproti pôvodnej
  -- verzii okrem odstránenia MAX(uuid).
  return exists (
    select 1
    from public.company_members cm
    where cm.user_id = v_uid
      and cm.status = 'active'
      and cm.company_id = v_company_id
  );
end;
$function$;

comment on function public.esblu_can_delete_machine_photo_object(text) is
  'RLS helper pre storage.objects politiku machine_photos_delete_company '
  '(bucket machine-photos). Autorizuje DELETE pre KTORÉHOKOĽVEK aktívneho '
  'člena firmy (owner/admin/employee — bez role filtra, zámerne, zrkadlí '
  'plný prístup na DB tabuľke machine_photos), ktorej patrí fotka (podľa '
  'machine_photos.company_id), alebo pôvodného nahrávateľa pre '
  'nereferencovaný draft. OPRAVA 16.9.2026: predtým používala MAX(uuid), '
  'ktorý v PostgreSQL neexistuje ako agregát pre typ uuid -> spôsobovalo '
  'produkčnú chybu 42883 pri KAŽDOM pokuse o DELETE machine-photos fotky '
  '(rovnaký root cause ako esblu_can_manage_company_logo_object, opravené '
  'v tej istej migrácii). Nahradené bezpečným count-then-fetch vzorom — '
  'bezpečnostná sémantika (žiadny role filter, fail-closed pri NULL/>1 '
  'distinct company_id) je nezmenená.';
