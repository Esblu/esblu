-- =============================================================================
-- PRIEČINKY DOKLADOV NAPRIEČ MODULMI + EVIDENCIA STIAHNUTÍ
--
-- ČO JE PRIEČINOK
-- ---------------
-- Organizačná zbierka ODKAZOV na kanonické záznamy. Faktúra zostáva vo
-- Faktúrach, bloček zostáva v Inboxe (public.documents), doklad vozidla
-- zostáva pri vozidle. Priečinok „August 2026" iba hovorí „tieto doklady
-- patria spolu" — nič nepresúva, nič nekopíruje, v Storage sa nič nehýbe.
--
-- Zmazanie priečinka zmaže VÝHRADNE priečinok a jeho členstvá. Faktúra,
-- dokument, príloha ani originál sa ho netýkajú — FK smerujú z členstva na
-- doklad, nikdy naopak.
--
-- PREČO NIE VOĽNÝ POLYMORFNÝ ODKAZ
-- --------------------------------
-- `entity_type` + `entity_id` bez cudzieho kľúča by bol odkaz na čokoľvek,
-- čo si klient vymyslí. Tu má každý typ vlastný stĺpec so skutočným FK a
-- CHECK vynúti, že je vyplnený práve ten jeden, ktorý typ hovorí:
--
--   invoice  → invoices.id        (vydaná aj prijatá faktúra)
--   document → documents.id       (bloček, naskenovaný doklad, …)
--
-- Prijatá faktúra sa do priečinka pridáva ako `invoice`, nie ako jej
-- zdrojový dokument. Originál sa pri exporte berie z
-- invoices.source_document_id — rovnaké pravidlo ako v úplnom balíku.
--
-- KTO
-- ---
-- Priečinky sú finančná/účtovná vec: owner a accountant áno, admin iba s
-- výslovným finance.manage, employee nikdy (esblu_my_finance_manage() pre
-- employee vracia false bez ohľadu na permissions JSON). Rovnaká funkcia
-- stráži čítanie aj zápis.
--
-- STIAHNUTIE
-- ----------
-- `document_download_events` je nemenná história, nie zámok. Doklad je po
-- stiahnutí ďalej plne stiahnuteľný; každé ďalšie úspešné stiahnutie pridá
-- nový riadok. „Stiahnuté" znamená: bajty balíka úspešne dorazili k
-- prihlásenému klientovi, ktorý spočítal ich SHA-256 a ten sa zhodoval so
-- serverom. NEZNAMENÁ to archiváciu, prevzatie účtovníkom ani doručenie
-- tretej osobe. Pozri lib/invoicing/document-package.ts.
--
-- Udalosti nevie klient zapísať priamo (žiadny INSERT grant ani politika).
-- Jediná cesta je esblu_confirm_package_download(), ktorá overí vlastníka
-- balíka, firmu, finance.manage a zhodu odtlačku, a zapíše udalosti
-- VÝHRADNE pre doklady, ktoré v balíku naozaj boli.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Priečinky
-- -----------------------------------------------------------------------------

create table if not exists public.document_folders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_folders_name_shape
    check (char_length(name) between 1 and 120 and name = btrim(name)),
  constraint document_folders_description_len
    check (description is null or char_length(description) <= 500)
);

create unique index if not exists document_folders_company_name_uniq
  on public.document_folders (company_id, lower(name));

comment on table public.document_folders is
  'Organizačný priečinok dokladov naprieč modulmi. Obsahuje iba odkazy (document_folder_items); zmazanie priečinka nezmaže žiadny doklad ani súbor.';

-- -----------------------------------------------------------------------------
-- 2. Členstvo v priečinku
-- -----------------------------------------------------------------------------

create table if not exists public.document_folder_items (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.document_folders(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  entity_type text not null,
  invoice_id uuid references public.invoices(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  position integer,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint document_folder_items_entity_type_check
    check (entity_type in ('invoice', 'document')),
  -- Práve jeden odkaz, a to ten, ktorý hovorí typ.
  constraint document_folder_items_one_reference
    check (
      (entity_type = 'invoice' and invoice_id is not null and document_id is null)
      or (entity_type = 'document' and document_id is not null and invoice_id is null)
    )
);

create unique index if not exists document_folder_items_invoice_uniq
  on public.document_folder_items (folder_id, invoice_id) where invoice_id is not null;
create unique index if not exists document_folder_items_document_uniq
  on public.document_folder_items (folder_id, document_id) where document_id is not null;
create index if not exists document_folder_items_company_idx
  on public.document_folder_items (company_id);
create index if not exists document_folder_items_invoice_idx
  on public.document_folder_items (invoice_id) where invoice_id is not null;
create index if not exists document_folder_items_document_idx
  on public.document_folder_items (document_id) where document_id is not null;

comment on table public.document_folder_items is
  'Odkaz priečinka na kanonický záznam (invoices / documents). Zmazanie riadku odstráni iba zaradenie; doklad zostáva tam, kde bol.';

-- -----------------------------------------------------------------------------
-- 3. Vytvorené balíky (čo v ktorom balíku naozaj bolo)
-- -----------------------------------------------------------------------------

create table if not exists public.document_export_packages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  export_kind text not null,
  folder_id uuid references public.document_folders(id) on delete set null,
  folder_name_snapshot text,
  item_count integer not null,
  file_count integer not null,
  package_bytes bigint not null,
  package_sha256 text not null,
  manifest_sha256 text not null,
  package_filename text not null,
  manifest_schema_version text not null,
  app_commit text,
  constraint document_export_packages_kind_check
    check (export_kind in ('folder', 'selection', 'inbox_selection', 'accounting_handoff')),
  constraint document_export_packages_counts_check
    check (item_count >= 0 and file_count >= 0 and package_bytes >= 0),
  constraint document_export_packages_sha_check
    check (package_sha256 ~ '^[0-9a-f]{64}$' and manifest_sha256 ~ '^[0-9a-f]{64}$')
);

create index if not exists document_export_packages_company_idx
  on public.document_export_packages (company_id, created_at desc);

comment on table public.document_export_packages is
  'Balík, ktorý server zložil a overil. Existencia riadku NEZNAMENÁ stiahnutie — to zapisuje až esblu_confirm_package_download() po potvrdení klienta.';

create table if not exists public.document_export_package_items (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.document_export_packages(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  entity_type text not null,
  entity_ref uuid not null,
  invoice_id uuid references public.invoices(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  label_snapshot text,
  constraint document_export_package_items_entity_type_check
    check (entity_type in ('invoice', 'document')),
  constraint document_export_package_items_uniq unique (package_id, entity_type, entity_ref)
);

create index if not exists document_export_package_items_company_idx
  on public.document_export_package_items (company_id);

-- -----------------------------------------------------------------------------
-- 4. Udalosti stiahnutia — nemenná história
-- -----------------------------------------------------------------------------

create table if not exists public.document_download_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  package_id uuid not null references public.document_export_packages(id) on delete cascade,
  entity_type text not null,
  -- Kópia identifikátora bez FK: história prežije aj zmazanie dokladu.
  entity_ref uuid not null,
  invoice_id uuid references public.invoices(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  folder_id uuid references public.document_folders(id) on delete set null,
  download_kind text not null,
  downloaded_by uuid references auth.users(id) on delete set null,
  -- Rola v čase stiahnutia („koľko ešte účtovníčka nestiahla").
  downloader_role text,
  downloaded_at timestamptz not null default now(),
  constraint document_download_events_entity_type_check
    check (entity_type in ('invoice', 'document')),
  constraint document_download_events_kind_check
    check (download_kind in ('folder', 'selection', 'inbox_selection', 'accounting_handoff')),
  -- Jeden balík = najviac jedna udalosť na doklad. Opakované potvrdenie
  -- toho istého balíka nič nepripočíta; nové stiahnutie = nový balík.
  constraint document_download_events_uniq unique (package_id, entity_type, entity_ref)
);

create index if not exists document_download_events_entity_idx
  on public.document_download_events (company_id, entity_type, entity_ref, downloaded_at desc);

comment on table public.document_download_events is
  'Nemenná história stiahnutí. „Stiahnuté" = bajty balíka úspešne dorazili k prihlásenému klientovi a odtlačok sa zhodoval. Nie je to zámok — doklad zostáva stiahnuteľný.';

-- -----------------------------------------------------------------------------
-- 5. updated_at priečinka
-- -----------------------------------------------------------------------------

create or replace function public.esblu_document_folders_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  -- Firma priečinka sa nemení nikdy.
  new.company_id := old.company_id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists document_folders_touch on public.document_folders;
create trigger document_folders_touch
  before update on public.document_folders
  for each row execute function public.esblu_document_folders_touch();

revoke all on function public.esblu_document_folders_touch() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Privilégiá — explicitne, nič z predvolieb
-- -----------------------------------------------------------------------------

revoke all on public.document_folders from public, anon, authenticated;
revoke all on public.document_folder_items from public, anon, authenticated;
revoke all on public.document_export_packages from public, anon, authenticated;
revoke all on public.document_export_package_items from public, anon, authenticated;
revoke all on public.document_download_events from public, anon, authenticated;

grant select, insert, update, delete on public.document_folders to authenticated;
grant select, insert, delete on public.document_folder_items to authenticated;
grant select, insert on public.document_export_packages to authenticated;
grant select, insert on public.document_export_package_items to authenticated;
grant select on public.document_download_events to authenticated;

alter table public.document_folders enable row level security;
alter table public.document_folder_items enable row level security;
alter table public.document_export_packages enable row level security;
alter table public.document_export_package_items enable row level security;
alter table public.document_download_events enable row level security;

-- -----------------------------------------------------------------------------
-- 7. Politiky
-- -----------------------------------------------------------------------------

-- Priečinky -------------------------------------------------------------------
drop policy if exists document_folders_select on public.document_folders;
create policy document_folders_select on public.document_folders
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage());

drop policy if exists document_folders_insert on public.document_folders;
create policy document_folders_insert on public.document_folders
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and created_by = auth.uid()
  );

drop policy if exists document_folders_update on public.document_folders;
create policy document_folders_update on public.document_folders
  for update to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage())
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage());

drop policy if exists document_folders_delete on public.document_folders;
create policy document_folders_delete on public.document_folders
  for delete to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage());

-- Členstvo --------------------------------------------------------------------
drop policy if exists document_folder_items_select on public.document_folder_items;
create policy document_folder_items_select on public.document_folder_items
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage());

-- Pridať smie iba doklad vlastnej firmy, ktorý volajúci smie čítať, do
-- priečinka vlastnej firmy. Typy dokumentov sú uzavretý zoznam účtovných
-- podkladov — PZP, technický preukaz ani iné prevádzkové doklady sem
-- nepatria.
drop policy if exists document_folder_items_insert on public.document_folder_items;
create policy document_folder_items_insert on public.document_folder_items
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and created_by = auth.uid()
    and exists (
      select 1 from public.document_folders f
      where f.id = document_folder_items.folder_id
        and f.company_id = public.esblu_my_active_company_id()
    )
    and (
      (
        entity_type = 'invoice'
        and exists (
          select 1 from public.invoices i
          where i.id = document_folder_items.invoice_id
            and i.company_id = public.esblu_my_active_company_id()
        )
      )
      or (
        entity_type = 'document'
        and exists (
          select 1 from public.documents d
          where d.id = document_folder_items.document_id
            and d.company_id = public.esblu_my_active_company_id()
            and d.deleted_at is null
            and d.document_type in ('receipt', 'invoice', 'delivery_note', 'service_document', 'other')
            and public.esblu_can_read_document(d.id)
        )
      )
    )
  );

drop policy if exists document_folder_items_delete on public.document_folder_items;
create policy document_folder_items_delete on public.document_folder_items
  for delete to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage());

-- Balíky ----------------------------------------------------------------------
drop policy if exists document_export_packages_select on public.document_export_packages;
create policy document_export_packages_select on public.document_export_packages
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

drop policy if exists document_export_packages_insert on public.document_export_packages;
create policy document_export_packages_insert on public.document_export_packages
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and created_by = auth.uid()
    and (
      folder_id is null
      or exists (
        select 1 from public.document_folders f
        where f.id = document_export_packages.folder_id
          and f.company_id = public.esblu_my_active_company_id()
      )
    )
  );

drop policy if exists document_export_package_items_select on public.document_export_package_items;
create policy document_export_package_items_select on public.document_export_package_items
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

drop policy if exists document_export_package_items_insert on public.document_export_package_items;
create policy document_export_package_items_insert on public.document_export_package_items
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and exists (
      select 1 from public.document_export_packages p
      where p.id = document_export_package_items.package_id
        and p.company_id = public.esblu_my_active_company_id()
        and p.created_by = auth.uid()
        and p.created_at > now() - interval '15 minutes'
    )
    and (
      (
        entity_type = 'invoice'
        and invoice_id = entity_ref
        and document_id is null
        and exists (
          select 1 from public.invoices i
          where i.id = document_export_package_items.invoice_id
            and i.company_id = public.esblu_my_active_company_id()
        )
      )
      or (
        entity_type = 'document'
        and document_id = entity_ref
        and invoice_id is null
        and exists (
          select 1 from public.documents d
          where d.id = document_export_package_items.document_id
            and d.company_id = public.esblu_my_active_company_id()
            and public.esblu_can_read_document(d.id)
        )
      )
    )
  );

-- Udalosti: iba čítanie. Zápis výhradne cez esblu_confirm_package_download().
drop policy if exists document_download_events_select on public.document_download_events;
create policy document_download_events_select on public.document_download_events
  for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

-- -----------------------------------------------------------------------------
-- 8. Potvrdenie stiahnutia
--
-- Klient zavolá AŽ keď má celý balík v pamäti a spočítal jeho SHA-256.
-- Funkcia je SECURITY DEFINER, pretože zapisuje do tabuľky, do ktorej
-- klient zapisovať nesmie. Preto je fail-closed: každá podmienka, ktorá
-- nesedí, končí výnimkou a nič sa nezapíše.
-- -----------------------------------------------------------------------------

create or replace function public.esblu_confirm_package_download(
  p_package_id uuid,
  p_package_sha256 text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_package public.document_export_packages%rowtype;
  v_inserted integer := 0;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  if not public.esblu_my_finance_manage() then
    raise exception using errcode = '42501', message = 'ESBLU_FORBIDDEN';
  end if;

  if p_package_id is null or p_package_sha256 is null
     or lower(p_package_sha256) !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_INPUT';
  end if;

  select * into v_package
  from public.document_export_packages p
  where p.id = p_package_id
    and p.company_id = v_company_id
    and p.created_by = v_uid;

  if not found then
    raise exception using errcode = 'P0001', message = 'ESBLU_PACKAGE_NOT_FOUND';
  end if;

  -- Bajty, ktoré má klient, musia byť presne tie, ktoré server zložil.
  if v_package.package_sha256 <> lower(p_package_sha256) then
    raise exception using errcode = 'P0001', message = 'ESBLU_PACKAGE_HASH_MISMATCH';
  end if;

  -- Potvrdenie patrí k čerstvo stiahnutému balíku, nie k starému záznamu.
  if v_package.created_at < now() - interval '1 hour' then
    raise exception using errcode = 'P0001', message = 'ESBLU_PACKAGE_EXPIRED';
  end if;

  v_role := public.esblu_my_active_role();

  insert into public.document_download_events (
    company_id, package_id, entity_type, entity_ref, invoice_id, document_id,
    folder_id, download_kind, downloaded_by, downloader_role
  )
  select
    v_company_id, v_package.id, i.entity_type, i.entity_ref, i.invoice_id, i.document_id,
    v_package.folder_id, v_package.export_kind, v_uid, v_role
  from public.document_export_package_items i
  where i.package_id = v_package.id
    and i.company_id = v_company_id
  on conflict (package_id, entity_type, entity_ref) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function public.esblu_confirm_package_download(uuid, text) from public, anon;
grant execute on function public.esblu_confirm_package_download(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 9. Súhrn stavu stiahnutia
--
-- SECURITY INVOKER: RLS na document_download_events rozhoduje, čo sa
-- započíta. Zamestnanec dostane prázdny výsledok, cudzia firma tiež.
-- -----------------------------------------------------------------------------

create or replace function public.esblu_document_download_summary()
returns table (
  entity_type text,
  entity_ref uuid,
  download_count bigint,
  accountant_download_count bigint,
  last_downloaded_at timestamptz,
  last_downloaded_by uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    e.entity_type,
    e.entity_ref,
    count(*) as download_count,
    count(*) filter (where e.downloader_role = 'accountant') as accountant_download_count,
    max(e.downloaded_at) as last_downloaded_at,
    (array_agg(e.downloaded_by order by e.downloaded_at desc))[1] as last_downloaded_by
  from public.document_download_events e
  where e.company_id = public.esblu_my_active_company_id()
  group by e.entity_type, e.entity_ref;
$$;

revoke all on function public.esblu_document_download_summary() from public, anon;
grant execute on function public.esblu_document_download_summary() to authenticated;

-- -----------------------------------------------------------------------------
-- 10. Hlasové potvrdenia pre priečinky
--
-- Zápisy do priečinkov z Intent Engine idú cez ten istý HMAC potvrdzovací
-- tok ako zložky. Rozširuje sa iba allowlist; telo funkcie je inak
-- totožné s 20260915120000 (vrátane limitu 20 čakajúcich potvrdení).
-- -----------------------------------------------------------------------------

alter table public.assistant_action_confirmations
  drop constraint if exists assistant_action_confirmations_intent_check;
alter table public.assistant_action_confirmations
  add constraint assistant_action_confirmations_intent_check
  check (intent in (
    'CREATE_DOCUMENT_CATEGORY',
    'RENAME_DOCUMENT_CATEGORY',
    'ASSIGN_DOCUMENTS_TO_CATEGORY',
    'DELETE_DOCUMENT_CATEGORY',
    'MOVE_DOCUMENTS_TO_CATEGORY',
    'FOLDER_CREATE',
    'FOLDER_ADD_ITEMS',
    'FOLDER_REMOVE_ITEMS'
  ));

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
set search_path = ''
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
    raise exception using errcode = '28000', message = 'NOT_AUTHENTICATED';
  end if;

  if p_intent is null or p_intent not in (
    'CREATE_DOCUMENT_CATEGORY',
    'RENAME_DOCUMENT_CATEGORY',
    'ASSIGN_DOCUMENTS_TO_CATEGORY',
    'DELETE_DOCUMENT_CATEGORY',
    'MOVE_DOCUMENTS_TO_CATEGORY',
    'FOLDER_CREATE',
    'FOLDER_ADD_ITEMS',
    'FOLDER_REMOVE_ITEMS'
  ) then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_ACTION_INTENT';
  end if;

  if p_canonical_args is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_MISSING_CANONICAL_ARGS';
  end if;

  if p_expected_count is not null and p_expected_count < 0 then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_EXPECTED_COUNT';
  end if;

  if p_nonce is null or p_nonce !~ '^[0-9a-f]{16,128}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_NONCE';
  end if;

  if p_server_proof is null or p_server_proof !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_SERVER_PROOF';
  end if;

  if p_expires_at_epoch is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_EXPIRY';
  end if;

  v_expires_at := to_timestamp(p_expires_at_epoch);
  if v_expires_at <= now() or v_expires_at > now() + interval '6 minutes' then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVALID_EXPIRY';
  end if;

  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  select count(*) into v_pending_count
  from public.assistant_action_confirmations
  where user_id = v_uid
    and consumed_at is null
    and expires_at > now();

  if v_pending_count >= 20 then
    raise exception using errcode = 'P0001', message = 'ESBLU_TOO_MANY_PENDING_CONFIRMATIONS';
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
