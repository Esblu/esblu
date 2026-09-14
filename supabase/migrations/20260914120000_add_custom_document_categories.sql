begin;

-- =============================================================================
-- Esblu — custom_document_categories (základ pre "Dynamický Document Router",
-- Fáza 2/4 zadania "Inteligentný Inbox + Univerzálne AI dokumenty").
-- =============================================================================
-- Kontext: documents.document_type je dnes CHECK-om obmedzený na presne 8
-- pevných hodnôt (documents_document_type_check — weigh_ticket, delivery_note,
-- invoice, receipt, insurance, service_document, vehicle_registration, other).
-- Zadanie požaduje, aby Esblu vedelo reagovať aj na dokument, ktorý dnes
-- nepoznáme (napr. "Protokol o kontrole zdvíhacieho zariadenia"), a aby si
-- používateľ mohol takúto NOVÚ kategóriu po potvrdení založiť — bez toho, aby
-- AI mohla natvrdo meniť documentType (zostáva 'other', dôkazný CHECK
-- ostáva nezmenený, žiadne rozvoľnenie existujúceho enumu).
--
-- Táto migrácia je ČISTO ADITÍVNA: nová tabuľka + jeden nullable FK stĺpec na
-- documents. Nemení, neruší ani neoslabuje žiadnu existujúcu tabuľku, CHECK,
-- RLS politiku ani dáta. Bezpečne sa dá aplikovať bez rizika straty dát.
--
-- Duplicitná-kategória ochrana (zadanie: "Nedovoľ AI vytvárať stovky
-- duplicitných kategórií"): canonical_slug je normalizovaná verzia name
-- (aplikačná vrstva normalizuje rovnako ako normalizeSpz — lowercase, bez
-- diakritiky, jedna medzera), UNIQUE (company_id, canonical_slug) fyzicky
-- zabráni dvom kategóriám s rovnakým významom v tej istej firme. Aplikačná
-- vrstva PRED založením novej kategórie musí: 1) skúsiť namapovať na
-- canonical known types (documentType enum), 2) fuzzy-matchnúť voči
-- existujúcim custom_document_categories danej firmy, 3) až potom (po
-- potvrdení používateľom) sem vložiť nový riadok.
-- =============================================================================

create table public.custom_document_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- Názov kategórie presne tak, ako ho potvrdil používateľ (napr. AI návrh
  -- "Protokol o kontrole zdvíhacieho zariadenia", ktorý si mohol pred
  -- potvrdením upraviť — pozri zadanie "POTVRDIŤ / UPRAVIŤ / ZRUŠIŤ").
  name text not null check (char_length(btrim(name)) between 1 and 200),
  -- Normalizovaný kľúč na fuzzy-match/duplicate-check (aplikačná vrstva,
  -- rovnaký princíp ako lib/normalize-spz.ts): lowercase, bez diakritiky,
  -- interpunkcie zredukovanej na medzery, kolabované whitespace. CHECK tu
  -- iba chráni pred očividne nenormalizovaným vstupom (nikdy sa nespolieha
  -- iba naň — skutočnú normalizáciu robí appka pred INSERT-om).
  canonical_slug text not null check (canonical_slug ~ '^[a-z0-9]+( [a-z0-9]+)*$'),
  -- Krátky AI-generovaný popis kategórie v čase návrhu (napr. "Záznam z
  -- pravidelnej kontroly žeriavu/zdvíhacieho zariadenia revíznym technikom.")
  -- — iba informačné, nikdy autoritatívny zdroj dát.
  description text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (company_id, canonical_slug)
);

comment on table public.custom_document_categories is
  'Firmou potvrdené vlastné kategórie AI dokumentov nad rámec pevného documentType enumu (dokumenty s documentType=''other''). Založená VÝHRADNE po explicitnom potvrdení používateľom (POTVRDIŤ/UPRAVIŤ/ZRUŠIŤ flow) — appka/AI sem nikdy nezapisuje automaticky bez potvrdenia. canonical_slug + UNIQUE (company_id, canonical_slug) zabraňuje duplicitným kategóriám s rovnakým významom.';

alter table public.documents
  add column custom_category_id uuid references public.custom_document_categories(id) on delete set null;

comment on column public.documents.custom_category_id is
  'Voliteľné priradenie k firemnej vlastnej kategórii (custom_document_categories) — vyplnené IBA keď document_type=''other'' a používateľ potvrdil konkrétnu vlastnú kategóriu. ON DELETE SET NULL: zrušenie/premenovanie kategórie nikdy nezmaže samotný dokument.';

create index custom_document_categories_company_id_idx
  on public.custom_document_categories (company_id);

create index documents_custom_category_id_idx
  on public.documents (custom_category_id)
  where custom_category_id is not null;

alter table public.custom_document_categories enable row level security;

-- RLS presne zrkadlí existujúci vzor z public.documents (20260814160000) —
-- esblu_my_active_company_id()/esblu_my_active_role() sú už existujúce
-- SECURITY DEFINER helpery, žiadne nové privilegované funkcie netreba.
-- Čítanie/vytváranie kategórie smie ktokoľvek z aktívnych členov firmy
-- (rovnaká úroveň ako vytvorenie samotného dokumentu); premenovanie/zmazanie
-- iba owner/admin (rovnaká úroveň ako documents_update_owner_admin).
create policy custom_document_categories_select_company
  on public.custom_document_categories
  for select
  using (company_id = public.esblu_my_active_company_id());

create policy custom_document_categories_insert_company
  on public.custom_document_categories
  for insert
  with check (
    company_id = public.esblu_my_active_company_id()
    and created_by = auth.uid()
  );

create policy custom_document_categories_update_owner_admin
  on public.custom_document_categories
  for update
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
  );

create policy custom_document_categories_delete_owner_admin
  on public.custom_document_categories
  for delete
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
  );

commit;
