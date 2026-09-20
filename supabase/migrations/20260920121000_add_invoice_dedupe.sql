-- 20260920121000_add_invoice_dedupe.sql
--
-- Fáza C — deterministický dedupe model pre prijaté doklady.
--
-- Štyri vrstvy:
--   A. exact source hash          → documents.content_sha256
--   B. structured fingerprint     → invoices.dedupe_fingerprint
--   C. transport ID               → invoices.transport_message_id
--   D. vzťah k zdrojovému dokumentu → document_links.invoice_id
--
-- Expand-only. Všetko NULLABLE. Žiadny backfill.
-- Unique indexy sú PARTIAL — platia len tam, kde je hodnota vyplnená,
-- takže existujúce riadky s NULL nikdy nekolidujú.
--
-- Návrh a edge cases: docs/received-invoice-dedupe-en16931-design.md §2

begin;

-- ---------------------------------------------------------------------------
-- Vrstva A — exact source hash
-- ---------------------------------------------------------------------------
-- SHA-256 celého binárneho obsahu nahratého súboru.
-- Chytí: dvakrát nahratý ten istý súbor.
-- Nechytí: tá istá faktúra ako iný sken / foto / formát.

alter table public.documents
  add column if not exists content_sha256 text;

comment on column public.documents.content_sha256 is
  'SHA-256 hex digest binárneho obsahu súboru. Dedupe vrstva A.';

alter table public.documents
  drop constraint if exists documents_content_sha256_format;
alter table public.documents
  add constraint documents_content_sha256_format
  check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');

-- Partial unique: v rámci firmy, len pre nezmazané dokumenty s vyplneným hashom.
-- deleted_at je v predikáte zámerne — soft-deleted dokument nesmie blokovať
-- opätovné nahratie toho istého súboru.
create unique index if not exists documents_company_content_sha256_uniq
  on public.documents (company_id, content_sha256)
  where content_sha256 is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- Vrstva B — structured invoice fingerprint
-- ---------------------------------------------------------------------------
-- Deterministický hash z normalizovanej identity dokladu:
--   normalize_party_identity(seller) | invoice_number | issue_date
--   | total_amount | currency | kind
--
-- DÔLEŽITÉ: ak dodávateľ nemá žiadny spoľahlivý identifikátor
-- (vat_identifier / legal_registration_id / ico), fingerprint sa NEPOČÍTA
-- a zostáva NULL. Porovnávať faktúry podľa mena firmy je heuristika,
-- ktorá spôsobí buď falošnú zhodu, alebo falošné odmietnutie.

alter table public.invoices
  add column if not exists dedupe_fingerprint text;

comment on column public.invoices.dedupe_fingerprint is
  'SHA-256 hex digest normalizovanej identity dokladu. Dedupe vrstva B. '
  'NULL ak dodávateľ nemá spoľahlivý identifikátor — vtedy dedupe nebeží.';

alter table public.invoices
  drop constraint if exists invoices_dedupe_fingerprint_format;
alter table public.invoices
  add constraint invoices_dedupe_fingerprint_format
  check (dedupe_fingerprint is null or dedupe_fingerprint ~ '^[0-9a-f]{64}$');

-- Partial unique LEN NA FINALIZED.
-- Rozpracované drafty sa môžu legitímne zhodovať, kým ich používateľ upravuje;
-- blokovať ich by znemožnilo bežnú prácu.
create unique index if not exists invoices_dedupe_fingerprint_uniq
  on public.invoices (company_id, direction, dedupe_fingerprint)
  where dedupe_fingerprint is not null and document_status = 'finalized';

-- ---------------------------------------------------------------------------
-- Vrstva C — provider / eInvoice transport ID
-- ---------------------------------------------------------------------------
-- Najspoľahlivejšia vrstva, ale funguje až od reálnej Peppol prevádzky.

alter table public.invoices
  add column if not exists transport_provider text;

alter table public.invoices
  add column if not exists transport_message_id text;

comment on column public.invoices.transport_provider is
  'Identifikátor providera, ktorý doklad doručil (pluggable adapter). '
  'Canonical model nesmie byť viazaný na konkrétneho providera.';

comment on column public.invoices.transport_message_id is
  'Message ID priradené providerom / Peppol sieťou. Dedupe vrstva C.';

alter table public.invoices
  drop constraint if exists invoices_transport_pair_consistency;
alter table public.invoices
  add constraint invoices_transport_pair_consistency
  check (
    (transport_provider is null and transport_message_id is null)
    or (transport_provider is not null and transport_message_id is not null)
  );

create unique index if not exists invoices_transport_message_uniq
  on public.invoices (company_id, transport_provider, transport_message_id)
  where transport_message_id is not null;

-- ---------------------------------------------------------------------------
-- Vrstva D — vzťah faktúry k zdrojovým dokumentom
-- ---------------------------------------------------------------------------
-- invoices.source_document_id je jednosmerné (1 faktúra → 1 zdrojový dokument).
-- document_links.invoice_id umožní opačný smer a viac dokumentov na faktúru,
-- konzistentne so vzorom, ktorý tabuľka už používa pre vozidlá a stroje.

alter table public.document_links
  add column if not exists invoice_id uuid
    references public.invoices(id) on delete cascade;

comment on column public.document_links.invoice_id is
  'Prepojenie zdrojového dokumentu na canonical faktúru. Dedupe vrstva D.';

create index if not exists document_links_invoice_idx
  on public.document_links (company_id, invoice_id)
  where invoice_id is not null;

-- Jeden dokument nemá byť na tú istú faktúru naviazaný dvakrát rovnakým typom
create unique index if not exists document_links_invoice_document_uniq
  on public.document_links (document_id, invoice_id, link_type)
  where invoice_id is not null;

-- ---------------------------------------------------------------------------
-- Near-duplicate podpora
-- ---------------------------------------------------------------------------
-- Near-duplicate NIKDY neblokuje, len varuje. Index urýchľuje vyhľadanie
-- kandidátov: rovnaký dodávateľ + podobná suma + blízky dátum.

create index if not exists invoices_near_dup_lookup_idx
  on public.invoices (company_id, direction, supplier_business_partner_id, issue_date, total_amount)
  where direction = 'received';

commit;
