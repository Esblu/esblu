-- 20260920120000_add_received_invoice_core.sql
--
-- Fáza B — canonical received invoice core.
--
-- Expand-only. Všetky nové stĺpce sú NULLABLE.
-- Žiadny backfill. Žiadny destructive rewrite.
-- Existujúce finalized faktúry ostávajú nedotknuté a plne čitateľné.
--
-- POZOR: táto migrácia NEMENÍ esblu_finalize_invoice. Zmena RPC je samostatný
-- krok, ktorý musí prejsť code review — viď docs/received-invoice-dedupe-en16931-design.md §1.2.

begin;

-- ---------------------------------------------------------------------------
-- 1. Dodávateľ pri prijatej faktúre
-- ---------------------------------------------------------------------------
-- invoices.customer_business_partner_id je issued-only pomenovanie.
-- Pri direction='received' je protistranou dodávateľ, nie odberateľ.

alter table public.invoices
  add column if not exists supplier_business_partner_id uuid
    references public.business_partners(id) on delete restrict;

comment on column public.invoices.supplier_business_partner_id is
  'Dodávateľ pri direction=''received''. Pri direction=''issued'' musí byť NULL.';

-- Pôvodné číslo dokladu tak, ako ho uviedol dodávateľ.
-- Audit stopa pre prípad, že invoice_number bol pri review upravený.
alter table public.invoices
  add column if not exists supplier_invoice_number text;

comment on column public.invoices.supplier_invoice_number is
  'Číslo dokladu presne tak, ako bolo extrahované/prijaté od dodávateľa. Audit stopa.';

-- Kedy doklad fyzicky prišiel (nie kedy bol vystavený).
alter table public.invoices
  add column if not exists received_at date;

comment on column public.invoices.received_at is
  'Dátum fyzického prijatia dokladu. Nezamieňať s issue_date ani tax_point_date.';

-- ---------------------------------------------------------------------------
-- 2. Constrainty — aby sa smery nepomiešali
-- ---------------------------------------------------------------------------

-- issued faktúra nesmie mať dodávateľa
alter table public.invoices
  drop constraint if exists invoices_supplier_only_when_received;
alter table public.invoices
  add constraint invoices_supplier_only_when_received
  check (direction <> 'issued' or supplier_business_partner_id is null);

-- received faktúra nesmie mať odberateľa v customer poli
alter table public.invoices
  drop constraint if exists invoices_customer_only_when_issued;
alter table public.invoices
  add constraint invoices_customer_only_when_issued
  check (direction <> 'received' or customer_business_partner_id is null);

-- KRITICKÉ: prijatá faktúra nikdy nesmie zobrať číslo z našej sekvencie.
-- Číslo prijatej faktúry určuje dodávateľ. Ak by received faktúra konzumovala
-- sekvenciu, vznikla by nenapraviteľná diera v číselnom rade vydaných faktúr.
alter table public.invoices
  drop constraint if exists invoices_received_never_uses_sequence;
alter table public.invoices
  add constraint invoices_received_never_uses_sequence
  check (direction <> 'received' or invoice_number_sequence_id is null);

-- supplier_invoice_number a received_at dávajú zmysel len pri received
alter table public.invoices
  drop constraint if exists invoices_received_only_fields;
alter table public.invoices
  add constraint invoices_received_only_fields
  check (
    direction = 'received'
    or (supplier_invoice_number is null and received_at is null)
  );

-- ---------------------------------------------------------------------------
-- 3. Indexy
-- ---------------------------------------------------------------------------

create index if not exists invoices_supplier_partner_idx
  on public.invoices (company_id, supplier_business_partner_id)
  where supplier_business_partner_id is not null;

-- Zoznam prijatých faktúr v UI — filter podľa smeru a stavu úhrady
create index if not exists invoices_direction_status_idx
  on public.invoices (company_id, direction, document_status, payment_status);

-- Dohľadanie faktúry podľa zdrojového dokumentu z AI Inboxu
create index if not exists invoices_source_document_idx
  on public.invoices (company_id, source_document_id)
  where source_document_id is not null;

commit;
