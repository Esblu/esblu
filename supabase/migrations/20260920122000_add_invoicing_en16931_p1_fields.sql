-- 20260920122000_add_invoicing_en16931_p1_fields.sql
--
-- Fáza D — EN16931 P1 polia potrebné pred UBL rendererom.
--
-- Rozsah je zámerne úzky: pridávame LEN to, čo je reálne potrebné pre
-- Peppol BIS sandbox. NIE celý voliteľný EN16931 set.
--
-- Expand-only. Všetko NULLABLE — historické finalized faktúry tieto dáta
-- mať nemôžu a je správne, že ostanú NULL.
-- ŽIADNY fake backfill. ŽIADNE country defaults.
--
-- Dôsledok, ktorý je zámerný: faktúra finalizovaná pred touto migráciou
-- NEPREJDE EN16931 ani Peppol validáciou. XML export musí v takom prípade
-- zlyhať fail-closed s konkrétnym zoznamom chýbajúcich polí.
-- Nikdy ich nedopĺňať odhadom ani z live master data.
--
-- Mapovanie na UBL: docs/received-invoice-dedupe-en16931-design.md §6

begin;

-- ===========================================================================
-- 1. invoice_parties — SNAPSHOT (source of truth pre XML renderer)
-- ===========================================================================
-- ico / dic / ic_dph ZOSTÁVAJÚ ako country-specific convenience polia.
-- Canonical structured vrstva však na nich NESMIE závisieť.

alter table public.invoice_parties
  add column if not exists electronic_address text,
  add column if not exists electronic_address_scheme_id text,
  add column if not exists legal_registration_id text,
  add column if not exists legal_registration_scheme_id text,
  add column if not exists vat_identifier text,
  add column if not exists generic_identifier text,
  add column if not exists generic_identifier_scheme_id text;

comment on column public.invoice_parties.electronic_address is
  'EN16931 BT-34 (seller) / BT-49 (buyer). UBL cbc:EndpointID.';
comment on column public.invoice_parties.electronic_address_scheme_id is
  'EAS code list, napr. 0088 (GLN), 9931 (SK VAT). UBL cbc:EndpointID/@schemeID. '
  'Bez scheme ID nie je endpoint jednoznačný — preto sa vyžaduje spolu s adresou.';
comment on column public.invoice_parties.legal_registration_id is
  'EN16931 BT-30 (seller) / BT-47 (buyer). UBL cac:PartyLegalEntity/cbc:CompanyID.';
comment on column public.invoice_parties.legal_registration_scheme_id is
  'ICD code list. UBL cac:PartyLegalEntity/cbc:CompanyID/@schemeID.';
comment on column public.invoice_parties.vat_identifier is
  'EN16931 BT-31 (seller) / BT-48 (buyer). UBL cac:PartyTaxScheme/cbc:CompanyID.';
comment on column public.invoice_parties.generic_identifier is
  'EN16931 BT-29. Generický identifikátor strany.';

-- peppol_identifier zostáva pre spätnú kompatibilitu, ale je deprecated
comment on column public.invoice_parties.peppol_identifier is
  'DEPRECATED — nahradené electronic_address + electronic_address_scheme_id. '
  'Voľný text bez scheme ID nestačí pre EN16931 výstup.';

-- Scheme ID nesmie stáť bez hodnoty a naopak.
-- Polovičný pár je horší než žiadny — renderer by z neho vyrobil nevalidný XML.
alter table public.invoice_parties
  drop constraint if exists invoice_parties_electronic_address_pair;
alter table public.invoice_parties
  add constraint invoice_parties_electronic_address_pair
  check (
    (electronic_address is null and electronic_address_scheme_id is null)
    or (electronic_address is not null and electronic_address_scheme_id is not null)
  );

alter table public.invoice_parties
  drop constraint if exists invoice_parties_legal_registration_pair;
alter table public.invoice_parties
  add constraint invoice_parties_legal_registration_pair
  check (
    (legal_registration_id is null and legal_registration_scheme_id is null)
    or (legal_registration_id is not null and legal_registration_scheme_id is not null)
  );

alter table public.invoice_parties
  drop constraint if exists invoice_parties_generic_identifier_pair;
alter table public.invoice_parties
  add constraint invoice_parties_generic_identifier_pair
  check (
    (generic_identifier is null and generic_identifier_scheme_id is null)
    or (generic_identifier is not null and generic_identifier_scheme_id is not null)
  );

-- ===========================================================================
-- 2. business_partners — MASTER DATA
-- ===========================================================================
-- Bez týchto polí nemá finalize čo snapshotovať do invoice_parties.

alter table public.business_partners
  add column if not exists electronic_address text,
  add column if not exists electronic_address_scheme_id text,
  add column if not exists legal_registration_id text,
  add column if not exists legal_registration_scheme_id text,
  add column if not exists vat_identifier text,
  add column if not exists generic_identifier text,
  add column if not exists generic_identifier_scheme_id text;

alter table public.business_partners
  drop constraint if exists business_partners_electronic_address_pair;
alter table public.business_partners
  add constraint business_partners_electronic_address_pair
  check (
    (electronic_address is null and electronic_address_scheme_id is null)
    or (electronic_address is not null and electronic_address_scheme_id is not null)
  );

alter table public.business_partners
  drop constraint if exists business_partners_legal_registration_pair;
alter table public.business_partners
  add constraint business_partners_legal_registration_pair
  check (
    (legal_registration_id is null and legal_registration_scheme_id is null)
    or (legal_registration_id is not null and legal_registration_scheme_id is not null)
  );

alter table public.business_partners
  drop constraint if exists business_partners_generic_identifier_pair;
alter table public.business_partners
  add constraint business_partners_generic_identifier_pair
  check (
    (generic_identifier is null and generic_identifier_scheme_id is null)
    or (generic_identifier is not null and generic_identifier_scheme_id is not null)
  );

-- Partner matching podľa deterministických identifikátorov (priorita 1–3).
-- NIE unique — ten istý identifikátor môže legitímne patriť partnerovi
-- vedenému ako customer aj ako supplier, a duplicitu rieši matching flow,
-- nie tvrdý constraint.
create index if not exists business_partners_vat_identifier_idx
  on public.business_partners (company_id, vat_identifier)
  where vat_identifier is not null;

create index if not exists business_partners_legal_registration_idx
  on public.business_partners (company_id, legal_registration_scheme_id, legal_registration_id)
  where legal_registration_id is not null;

create index if not exists business_partners_electronic_address_idx
  on public.business_partners (company_id, electronic_address_scheme_id, electronic_address)
  where electronic_address is not null;

-- ico sa pri matchingu používa ako priorita 4 (scheme-závislá)
create index if not exists business_partners_ico_idx
  on public.business_partners (company_id, ico)
  where ico is not null;

-- ===========================================================================
-- 3. company_billing_profile — MASTER DATA našej firmy
-- ===========================================================================
-- Tabuľka dnes nemá ani peppol_identifier — dopĺňame celý set.

alter table public.company_billing_profile
  add column if not exists electronic_address text,
  add column if not exists electronic_address_scheme_id text,
  add column if not exists legal_registration_id text,
  add column if not exists legal_registration_scheme_id text,
  add column if not exists vat_identifier text,
  add column if not exists generic_identifier text,
  add column if not exists generic_identifier_scheme_id text;

alter table public.company_billing_profile
  drop constraint if exists company_billing_profile_electronic_address_pair;
alter table public.company_billing_profile
  add constraint company_billing_profile_electronic_address_pair
  check (
    (electronic_address is null and electronic_address_scheme_id is null)
    or (electronic_address is not null and electronic_address_scheme_id is not null)
  );

alter table public.company_billing_profile
  drop constraint if exists company_billing_profile_legal_registration_pair;
alter table public.company_billing_profile
  add constraint company_billing_profile_legal_registration_pair
  check (
    (legal_registration_id is null and legal_registration_scheme_id is null)
    or (legal_registration_id is not null and legal_registration_scheme_id is not null)
  );

alter table public.company_billing_profile
  drop constraint if exists company_billing_profile_generic_identifier_pair;
alter table public.company_billing_profile
  add constraint company_billing_profile_generic_identifier_pair
  check (
    (generic_identifier is null and generic_identifier_scheme_id is null)
    or (generic_identifier is not null and generic_identifier_scheme_id is not null)
  );

-- ===========================================================================
-- 4. invoices — referencie a platobné údaje
-- ===========================================================================

alter table public.invoices
  add column if not exists buyer_reference text,
  add column if not exists purchase_order_reference text,
  add column if not exists payment_means_code text,
  add column if not exists payment_reference text;

comment on column public.invoices.buyer_reference is
  'EN16931 BT-10. UBL cbc:BuyerReference. V Peppol BIS je často mandatory — '
  'presná požiadavka pre SK profil je OPEN do publikovania SK CIUS.';
comment on column public.invoices.purchase_order_reference is
  'EN16931 BT-13. UBL cac:OrderReference/cbc:ID.';
comment on column public.invoices.payment_means_code is
  'EN16931 BT-81, UNTDID 4461. Napr. 30 = credit transfer, 58 = SEPA credit transfer.';
comment on column public.invoices.payment_reference is
  'EN16931 BT-83. UBL cac:PaymentMeans/cbc:PaymentID. '
  'Canonical náprotivok variable_symbol — renderer musí čítať toto pole.';

comment on column public.invoices.variable_symbol is
  'SK/CZ convenience pole. Pre EN16931 výstup sa používa payment_reference.';

-- payment_means_code je numerický UNTDID kód
alter table public.invoices
  drop constraint if exists invoices_payment_means_code_format;
alter table public.invoices
  add constraint invoices_payment_means_code_format
  check (payment_means_code is null or payment_means_code ~ '^[0-9]{1,3}$');

-- ===========================================================================
-- 5. POZNÁMKY K TOMU, ČO SA VEDOME NEROBÍ
-- ===========================================================================
--
-- VAT kategórie: zostávajú {S, Z, E, AE}.
--   Peppol BIS pozná aj G, K, O, L, M. Jediná reálne pravdepodobná pre cieľový
--   segment je K (dodanie do iného členského štátu). Nepridáva sa, kým nie je
--   jasne definovaná sémantika a validácia (K vyžaduje IČ DPH oboch strán
--   a nulovú sadzbu). OPEN — závisí od publikovanej SK CIUS. NEHÁDA SA.
--
-- unit_code: stĺpec existuje od P0 migrácie. Mapovanie label → kód
--   (ks→H87, deň→DAY, hodina→HUR, m→MTR, m²→MTK, m³→MTQ, kg→KGM, t→TNE,
--    l→LTR, km→KMT, bal→XPK) je PREFILL SUGGESTION v UI, nie DB constraint
--   a nie authority. Kód sa nikdy neodvodzuje z voľného textu bez potvrdenia.
--
-- vat_exemption_reason_code / _text: existujú od P0. Validácia správneho
--   reason code pre E a AE patrí do TARGET PROFILE validácie (vrstva 3),
--   nie do DB constraintu — požiadavky sa líšia podľa cieľového profilu
--   a krajiny. Slovenský text sa NEGENERUJE automaticky pre všetky krajiny.
--
-- Žiadny backfill existujúcich riadkov. Historické finalized faktúry majú
--   tieto polia NULL a to je správne.

commit;
