-- =============================================================================
-- 20260920140000_direction_aware_invoice_finalize.sql
--
-- ARCHITEKTÚRNA OPRAVA: finalizácia faktúry musí byť direction-aware.
--
-- ROOT CAUSE
-- ----------
-- esblu_finalize_invoice() (naposledy 20260916150000) bola napísaná pre
-- issued-only svet a pre KAŽDÝ smer bezpodmienečne:
--   1. alokovala číslo z interného radu (invoice_number_sequences) a zapísala
--      invoice_number + invoice_number_sequence_id,
--   2. vyžadovala customer_business_partner_id ako "protistranu",
--   3. pri direction='received' použila TEN ISTÝ customer_business_partner_id
--      ako zdroj seller snapshotu.
--
-- Po migrácii 20260920120000 (received core) je tento kód navyše mŕtvy pre
-- received: CHECK invoices_customer_only_when_issued vynucuje, že received
-- faktúra má customer_business_partner_id NULL, takže finalize received
-- draftu dnes vždy skončí na ESBLU_MISSING_BUSINESS_PARTNER, a keby aj
-- neskončila, CHECK invoices_received_never_uses_sequence by odmietol zápis
-- invoice_number_sequence_id. Received finalize je teda dnes 100 %
-- nefunkčný (fail-closed, čo je správne — ale je to blocker).
--
-- ZÁVÄZNÉ PRAVIDLO, KTORÉ TÁTO MIGRÁCIA ZAVÁDZA
-- ---------------------------------------------
--   Číslo VYDANEJ faktúry patrí Esblu.     → invoice_number, interný rad.
--   Číslo PRIJATEJ faktúry patrí dodávateľovi. → supplier_invoice_number.
--
-- Prijatej faktúre sa NIKDY neprideľuje interné vydané číslo. Nie je to len
-- kozmetika: každé číslo vytiahnuté z radu pre prijatú faktúru by vyrobilo
-- nenapraviteľnú dieru v číselnom rade vydaných faktúr.
--
-- ROZSAH
-- ------
--   1. Direction-aware nahradenie CHECK invoices_number_required_when_finalized.
--   2. Dva nové CHECK constrainty (received nikdy nedostane interné číslo;
--      finalized received musí mať dodávateľa).
--   3. Partial unique index — deterministická externá identita prijatej
--      faktúry: company + dodávateľ + normalizované číslo dodávateľa + kind,
--      iba pre finalized received riadky.
--   4. Rozšírenie immutability triggeru o received identity / dedupe stĺpce.
--   5. CREATE OR REPLACE esblu_finalize_invoice() — direction-aware validácia,
--      číslovanie, snapshot strán (vrátane EN16931 P1 polí) a preklad unique
--      violation na zrozumiteľný ESBLU_* kód.
--
-- MIMO ROZSAHU (zámerne)
-- ----------------------
--   • Žiadny received UI, žiadny AI Inbox flow, žiadny XML/UBL mapper.
--   • Žiadna zmena VAT logiky — category-aware prepočet z 20260916150000 je
--     prevzatý byte-for-byte.
--   • Žiadne uvoľnenie RLS. Žiadny DROP COLUMN. Žiadny data rewrite,
--     backfill, renumbering ani mazanie.
--   • dedupe_fingerprint sa tu NEPOČÍTA — patrí do normalizačného kroku AI
--     Inboxu (§2.5 docs/received-invoice-dedupe-en16931-design.md). Existujúci
--     partial unique index invoices_dedupe_fingerprint_uniq však už platí a
--     jeho porušenie táto RPC prekladá na ESBLU_DUPLICATE_RECEIVED_INVOICE.
--
-- BEZPEČNOSŤ DÁT: v produkcii je v čase tejto migrácie 1 faktúra
-- (issued/finalized, FA20260001) a 0 prijatých faktúr. Žiadny existujúci
-- riadok neporušuje ani jeden z nových/nahradených constraintov — overené
-- pred aplikovaním.
--
-- ODCHÝLKA OD PÔVODNÉHO NÁVRHU: docs/received-invoice-dedupe-en16931-design.md
-- §1.2 predpokladal, že received faktúra bude mať číslo dodávateľa uložené v
-- invoices.invoice_number. To je nesprávne hneď dvakrát:
--   (a) zlieva interný vydaný rad a externú identitu do jedného stĺpca, takže
--       UNIQUE (company_id, invoice_number) by zakázal dvom RÔZNYM dodávateľom
--       mať rovnaké číslo dokladu — čo je úplne legitímne;
--   (b) RLS politiky invoices_insert_finance_draft / _update_finance_draft
--       vyžadujú invoice_number IS NULL, takže klient toto pole ani nemôže
--       vyplniť. Canonical externá identita je preto supplier_invoice_number.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Direction-aware identita finalizovaného dokladu
-- ---------------------------------------------------------------------------
-- Pôvodný constraint (20260916094000) vyžadoval invoice_number NOT NULL pre
-- KAŽDÚ finalizovanú faktúru — to je presne ten predpoklad, ktorý nútil
-- received faktúru zobrať interné číslo. Nahrádzame ho, nie rušíme: po
-- nahradení je požiadavka na identitu PRÍSNEJŠIA, nie voľnejšia, pretože
-- received vetva vyžaduje supplier_invoice_number.
--
-- DROP + ADD v jednej transakcii: ADD ... CHECK validuje celú tabuľku, takže
-- ak by čo i len jeden existujúci riadok nevyhovoval, celá migrácia sa
-- rollbackne a stará podmienka zostane v platnosti.

alter table public.invoices
  drop constraint if exists invoices_number_required_when_finalized;

alter table public.invoices
  add constraint invoices_number_required_when_finalized
  check (
    document_status <> 'finalized'
    or (direction = 'issued' and invoice_number is not null)
    or (direction = 'received' and supplier_invoice_number is not null)
  );

comment on constraint invoices_number_required_when_finalized on public.invoices is
  'Direction-aware identita finalizovaného dokladu: issued vyžaduje interné invoice_number (náš rad), received vyžaduje supplier_invoice_number (číslo dodávateľa). Draft môže mať obe NULL.';

-- Explicitný zákaz interného čísla na prijatej faktúre. RLS ho klientovi už
-- dnes nedovolí zapísať a RPC ho pre received nikdy nepridelí — tento
-- constraint robí z toho invariant vynútený schémou, nie iba konvenciou
-- dodržiavanú dvoma vrstvami kódu.
alter table public.invoices
  drop constraint if exists invoices_received_never_gets_internal_number;

alter table public.invoices
  add constraint invoices_received_never_gets_internal_number
  check (direction <> 'received' or invoice_number is null);

comment on constraint invoices_received_never_gets_internal_number on public.invoices is
  'Prijatej faktúre sa nikdy neprideľuje interné vydané číslo Esblu. Jej číslo patrí dodávateľovi a žije v supplier_invoice_number.';

-- Finalizovaná prijatá faktúra musí mať známeho dodávateľa — bez neho nie je
-- z čoho urobiť seller snapshot a supplier_invoice_number nemá identitu,
-- voči ktorej by bolo jednoznačné.
alter table public.invoices
  drop constraint if exists invoices_received_supplier_required_when_finalized;

alter table public.invoices
  add constraint invoices_received_supplier_required_when_finalized
  check (
    document_status <> 'finalized'
    or direction <> 'received'
    or supplier_business_partner_id is not null
  );

comment on constraint invoices_received_supplier_required_when_finalized on public.invoices is
  'Finalizovaná prijatá faktúra musí mať supplier_business_partner_id — bez identity dodávateľa nie je supplier_invoice_number jednoznačné a nie je z čoho urobiť seller snapshot.';


-- ---------------------------------------------------------------------------
-- 2. Deterministická externá identita prijatej faktúry
-- ---------------------------------------------------------------------------
-- NIKDY NIE (company_id, supplier_invoice_number) — dvaja rôzni dodávatelia
-- môžu legitímne vystaviť doklad s rovnakým číslom (napr. obaja "2026-001").
-- Identita dodávateľa MUSÍ byť súčasťou kľúča.
--
-- Zložky kľúča a prečo tam sú:
--   company_id                    multi-tenant izolácia
--   supplier_business_partner_id  bez nej by kľúč blokoval legitímny prípad vyššie
--   normalizované číslo           "FA-2026/001" a "FA2026001" je ten istý doklad;
--                                 vedúce nuly sa NEODSTRAŇUJÚ (FA-0001 <> FA-1)
--   kind                          dobropis/ťarchopis smie mať číslo podobné
--                                 alebo zhodné s opravovanou faktúrou
--
-- Predikát je úmyselne úzky — index platí IBA pre finalized received riadky
-- s vyplnenými oboma zložkami identity:
--   • drafty sa môžu počas review legitímne zhodovať,
--   • issued riadky sem nepatria vôbec,
--   • historické riadky majú supplier_* NULL, takže do indexu nevstupujú.
--
-- Vedomý trade-off (zhodný s docs/received-invoice-dedupe-en16931-design.md
-- §2.4): dodávateľov reissue s rovnakým číslom a rovnakým kind je odmietnutý
-- fail-closed. Alternatíva by znamenala tichý prepis už uzavretého účtovného
-- záznamu, čo je horšie. Opravná cesta zostáva otvorená — credit_note /
-- debit_note má iný kind, takže cez tento index prejde.
--
-- Toto je EXACT duplicate vrstva. Near-duplicate (OCR preklep v sume/dátume)
-- sa naďalej rieši varovaním v UI, nikdy blokovaním — na to slúži
-- invoices_near_dup_lookup_idx z 20260920121000.

create unique index if not exists invoices_received_supplier_number_uniq
  on public.invoices (
    company_id,
    supplier_business_partner_id,
    upper(regexp_replace(supplier_invoice_number, '[\s\-/]', '', 'g')),
    kind
  )
  where direction = 'received'
    and document_status = 'finalized'
    and supplier_business_partner_id is not null
    and supplier_invoice_number is not null;

comment on index public.invoices_received_supplier_number_uniq is
  'Deterministická externá identita prijatej faktúry: company + dodávateľ + normalizované číslo dodávateľa + kind, iba pre finalized received. Dvaja rôzni dodávatelia smú mať rovnaké číslo dokladu — preto je identita dodávateľa súčasťou kľúča.';


-- ---------------------------------------------------------------------------
-- 3. Immutabilita received identity po finalizácii
-- ---------------------------------------------------------------------------
-- esblu_block_finalized_invoice_mutation() vznikla pred received core a preto
-- nestráži supplier_* / received_at / dedupe / transport stĺpce. Priamy
-- klientský UPDATE finalizovanej faktúry je síce odrezaný už RLS politikou
-- invoices_update_finance_draft (USING vyžaduje document_status='draft'),
-- ale tento trigger je druhá, nezávislá vrstva — a práve tieto stĺpce nesú
-- externú identitu a dedupe kľúč, takže ich zmena po finalizácii by ticho
-- prepísala účtovný záznam alebo obišla dedupe.
--
-- Rozširuje sa výhradne o identity/dedupe stĺpce v rozsahu tejto úlohy.
-- Zvyšok tela je prevzatý bez zmeny.

create or replace function public.esblu_block_finalized_invoice_mutation()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if OLD.document_status = 'finalized' then
    if NEW.document_status is distinct from OLD.document_status
      or NEW.invoice_number is distinct from OLD.invoice_number
      or NEW.invoice_number_sequence_id is distinct from OLD.invoice_number_sequence_id
      or NEW.issue_date is distinct from OLD.issue_date
      or NEW.due_date is distinct from OLD.due_date
      or NEW.delivery_date is distinct from OLD.delivery_date
      or NEW.tax_point_date is distinct from OLD.tax_point_date
      or NEW.currency is distinct from OLD.currency
      or NEW.subtotal_amount is distinct from OLD.subtotal_amount
      or NEW.vat_total_amount is distinct from OLD.vat_total_amount
      or NEW.total_amount is distinct from OLD.total_amount
      or NEW.rounding_amount is distinct from OLD.rounding_amount
      or NEW.variable_symbol is distinct from OLD.variable_symbol
      or NEW.payment_terms_days is distinct from OLD.payment_terms_days
      or NEW.iban is distinct from OLD.iban
      or NEW.customer_business_partner_id is distinct from OLD.customer_business_partner_id
      or NEW.corrects_invoice_id is distinct from OLD.corrects_invoice_id
      or NEW.direction is distinct from OLD.direction
      or NEW.kind is distinct from OLD.kind
      or NEW.company_id is distinct from OLD.company_id
      or NEW.finalized_at is distinct from OLD.finalized_at
      or NEW.finalized_by is distinct from OLD.finalized_by
      or NEW.created_at is distinct from OLD.created_at
      or NEW.created_by is distinct from OLD.created_by
      or NEW.source is distinct from OLD.source
      or NEW.source_document_id is distinct from OLD.source_document_id
      -- Received identity (20260920120000) — externé číslo dokladu a identita
      -- dodávateľa sú pri prijatej faktúre presne to, čím invoice_number je
      -- pri vydanej.
      or NEW.supplier_business_partner_id is distinct from OLD.supplier_business_partner_id
      or NEW.supplier_invoice_number is distinct from OLD.supplier_invoice_number
      or NEW.received_at is distinct from OLD.received_at
      -- Dedupe / transport kľúče (20260920121000) — ich zmena po finalizácii
      -- by umožnila prepašovať duplikát popri unique indexoch.
      or NEW.dedupe_fingerprint is distinct from OLD.dedupe_fingerprint
      or NEW.transport_provider is distinct from OLD.transport_provider
      or NEW.transport_message_id is distinct from OLD.transport_message_id
    then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_INVOICE_FINALIZED_IMMUTABLE',
        hint = 'Finalizovaná faktúra je immutable okrem payment_status (cez esblu_add_invoice_payment/esblu_remove_invoice_payment) a audit metadát.';
    end if;
  end if;
  return NEW;
end;
$function$;

revoke execute on function public.esblu_block_finalized_invoice_mutation() from public;
revoke execute on function public.esblu_block_finalized_invoice_mutation() from anon;
revoke execute on function public.esblu_block_finalized_invoice_mutation() from authenticated;


-- ---------------------------------------------------------------------------
-- 4. esblu_finalize_invoice() — direction-aware
-- ---------------------------------------------------------------------------
-- Zachované bez zmeny z 20260916150000: SECURITY DEFINER, SET search_path TO '',
-- plne kvalifikované názvy, autorizácia cez esblu_my_finance_manage(),
-- SELECT ... FOR UPDATE zámok, atomická transakcia, category-aware VAT
-- prepočet (S vs Z/E/AE), EN16931 BR-CO-17/14/15, invoice_events audit,
-- jednosmerný draft→finalized prechod, explicit revoke/grant.
--
-- Zmenené:
--   • validácia protistrany je direction-aware (customer vs supplier),
--   • received vyžaduje supplier_invoice_number a NEALOKUJE interný rad,
--   • alokácia čísla beží výhradne pre issued (vrátane pg_advisory_xact_lock),
--   • snapshot strán čerpá zo správneho zdroja podľa direction a po novom
--     zahŕňa aj EN16931 P1 polia (20260920122000),
--   • opravný doklad musí mať rovnaký direction ako opravovaný,
--   • billing profile musí mať legal_name (invoice_parties.legal_name je NOT
--     NULL — bez tejto kontroly by finalize spadol na surovú NOT NULL chybu),
--   • unique violation sa prekladá na zrozumiteľný ESBLU_* kód.

create or replace function public.esblu_finalize_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_role text;

  v_inv_company_id uuid;
  v_direction text;
  v_kind text;
  v_document_status text;
  v_issue_date date;
  v_customer_business_partner_id uuid;
  v_supplier_business_partner_id uuid;
  v_supplier_invoice_number text;
  v_corrects_invoice_id uuid;
  v_rounding_amount numeric(18, 2);

  v_item_count integer;
  v_invalid_s_rate_count integer;

  -- Protistrana pre daný smer: issued → odberateľ, received → dodávateľ.
  v_counterparty_id uuid;

  v_series_key text;
  v_year integer;
  v_seq_id uuid;
  v_prefix text;
  v_suffix text;
  v_padding integer;
  v_allocated_number integer;
  v_invoice_number text;

  v_billing_company_id uuid;
  v_billing_legal_name text;
  v_bp_id uuid;
  v_bp_company_id uuid;

  v_corrected_company_id uuid;
  v_corrected_status text;
  v_corrected_direction text;

  v_subtotal numeric(18, 2);
  v_vat_total numeric(18, 2);
  v_total numeric(18, 2);
  v_finalized_at timestamptz;

  v_conflict_constraint text;
begin
  if p_invoice_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_ARGUMENT';
  end if;

  v_company_id := public.esblu_my_active_company_id();
  v_role := public.esblu_my_active_role();

  if v_company_id is null or v_role is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  if not public.esblu_my_finance_manage() then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED',
      hint = 'Finalizácia vyžaduje owner alebo permissions.finance.manage=true.';
  end if;

  -- SELECT ... FOR UPDATE — zamyká riadok faktúry na dĺžku transakcie, aby
  -- dve súbežné finalize volania nad tou istou faktúrou neprešli obe
  -- kontrolou document_status='draft'.
  select i.company_id, i.direction, i.kind, i.document_status, i.issue_date,
         i.customer_business_partner_id, i.supplier_business_partner_id,
         i.supplier_invoice_number, i.corrects_invoice_id, i.rounding_amount
    into v_inv_company_id, v_direction, v_kind, v_document_status, v_issue_date,
         v_customer_business_partner_id, v_supplier_business_partner_id,
         v_supplier_invoice_number, v_corrects_invoice_id, v_rounding_amount
  from public.invoices i
  where i.id = p_invoice_id
  for update;

  if v_inv_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NOT_FOUND';
  end if;

  if v_inv_company_id <> v_company_id then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NOT_FOUND',
      hint = 'Faktúra nepatrí do aktívnej firmy volajúceho.';
  end if;

  if v_document_status <> 'draft' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NOT_DRAFT',
      hint = 'Iba draft faktúra sa dá finalizovať — jednosmerný prechod.';
  end if;

  -- Povinné polia spoločné pre oba smery.
  if v_issue_date is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_ISSUE_DATE';
  end if;

  select count(*) into v_item_count
  from public.invoice_items
  where invoice_id = p_invoice_id;

  if v_item_count = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_NO_ITEMS',
      hint = 'Faktúra musí mať aspoň jednu riadkovú položku.';
  end if;

  -- ---------------------------------------------------------------------
  -- Direction-aware validácia protistrany.
  --
  -- issued:   protistranou je ODBERATEĽ (customer_business_partner_id).
  -- received: protistranou je DODÁVATEĽ (supplier_business_partner_id) a
  --           navyše je povinné číslo dokladu tak, ako ho pridelil dodávateľ.
  --
  -- Pre received sa customer_business_partner_id NIKDY nepoužije ako seller —
  -- CHECK invoices_customer_only_when_issued ho aj tak drží na NULL.
  --
  -- due_date sa zámerne nevyžaduje ani v jednom smere — prijatá faktúra
  -- nemusí mať splatnosť a vymýšľať si ju by bolo horšie než ju nemať.
  -- ---------------------------------------------------------------------
  if v_direction = 'issued' then
    if v_customer_business_partner_id is null then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_MISSING_BUSINESS_PARTNER';
    end if;
    v_counterparty_id := v_customer_business_partner_id;
  else
    if v_supplier_business_partner_id is null then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_MISSING_SUPPLIER',
        hint = 'Prijatá faktúra musí mať priradeného dodávateľa (supplier_business_partner_id).';
    end if;

    if v_supplier_invoice_number is null
       or btrim(v_supplier_invoice_number) = '' then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_MISSING_SUPPLIER_INVOICE_NUMBER',
        hint = 'Prijatá faktúra musí mať číslo dokladu dodávateľa — Esblu jej nikdy neprideľuje vlastné číslo.';
    end if;

    v_counterparty_id := v_supplier_business_partner_id;
  end if;

  -- Protistrana musí patriť aktívnej firme volajúceho (FK garantuje iba
  -- existenciu, nie tenant izoláciu).
  select bp.id, bp.company_id into v_bp_id, v_bp_company_id
  from public.business_partners bp
  where bp.id = v_counterparty_id;

  if v_bp_id is null or v_bp_company_id <> v_company_id then
    if v_direction = 'issued' then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_BUSINESS_PARTNER_NOT_FOUND',
        hint = 'Obchodný partner neexistuje alebo nepatrí do aktívnej firmy volajúceho.';
    else
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_SUPPLIER_NOT_FOUND',
        hint = 'Dodávateľ neexistuje alebo nepatrí do aktívnej firmy volajúceho.';
    end if;
  end if;

  -- Company billing profile — vyžadovaný v oboch smeroch (pri issued je
  -- sellerom, pri received buyerom, vždy jedna zo strán). legal_name musí byť
  -- vyplnené, lebo invoice_parties.legal_name je NOT NULL.
  select cbp.company_id, cbp.legal_name
    into v_billing_company_id, v_billing_legal_name
  from public.company_billing_profile cbp
  where cbp.company_id = v_company_id;

  if v_billing_company_id is null
     or v_billing_legal_name is null
     or btrim(v_billing_legal_name) = '' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_BILLING_PROFILE',
      hint = 'Firma nemá vyplnený company_billing_profile (vrátane obchodného mena) — doplňte v Nastaveniach pred finalizáciou.';
  end if;

  -- ---------------------------------------------------------------------
  -- Opravné doklady. Okrem pôvodných kontrol (existencia, tá istá firma,
  -- opravovaný doklad musí byť finalized) pribúda direction equality:
  -- dobropis k prijatej faktúre je prijatý doklad, dobropis k vydanej je
  -- vydaný. Krížiť smery by znamenalo, že doklad tvrdí "opravujem X", kde X
  -- je z opačnej strany účtovného vzťahu.
  -- ---------------------------------------------------------------------
  if v_kind in ('credit_note', 'debit_note') then
    select c.company_id, c.document_status, c.direction
      into v_corrected_company_id, v_corrected_status, v_corrected_direction
    from public.invoices c
    where c.id = v_corrects_invoice_id;

    if v_corrected_company_id is null then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_CORRECTED_INVOICE_NOT_FOUND';
    end if;

    if v_corrected_company_id <> v_company_id then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_CORRECTED_INVOICE_FOREIGN_COMPANY';
    end if;

    if v_corrected_status <> 'finalized' then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_CORRECTED_INVOICE_NOT_FINALIZED',
        hint = 'Opravný doklad môže odkazovať iba na už finalizovanú faktúru.';
    end if;

    if v_corrected_direction is distinct from v_direction then
      raise exception using
        errcode = 'P0001',
        message = 'ESBLU_CORRECTED_INVOICE_DIRECTION_MISMATCH',
        hint = 'Opravný doklad musí mať rovnaký smer (issued/received) ako opravovaná faktúra.';
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- VAT category semantics fail-closed check — prevzaté bez zmeny z
  -- 20260916150000. S je jediná kategória, kde má vat_rate percentuálny
  -- význam. Defense-in-depth nad stĺpcovým CHECK na invoice_items.vat_rate.
  -- ---------------------------------------------------------------------
  select count(*) into v_invalid_s_rate_count
  from public.invoice_items
  where invoice_id = p_invoice_id
    and vat_category_code = 'S'
    and (vat_rate is null or vat_rate < 0);

  if v_invalid_s_rate_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_S_VAT_RATE',
      hint = 'Kategória S (taxable/standard-rated) vyžaduje platnú nezápornú sadzbu DPH na každej položke.';
  end if;

  -- ---------------------------------------------------------------------
  -- Autoritatívny prepočet — IDENTICKÝ pre oba smery. Prijatá faktúra sa
  -- počíta tým istým canonical engine ako vydaná; klientom poslaným sumám sa
  -- nikdy neverí. Prevzaté bez zmeny z 20260916150000.
  -- ---------------------------------------------------------------------
  update public.invoice_items
  set
    line_net_amount = round(quantity * unit_price, 2),
    line_vat_amount = case
      when vat_category_code = 'S'
        then round(round(quantity * unit_price, 2) * vat_rate / 100, 2)
      else 0
    end,
    line_gross_amount = round(quantity * unit_price, 2)
      + case
          when vat_category_code = 'S'
            then round(round(quantity * unit_price, 2) * vat_rate / 100, 2)
          else 0
        end,
    updated_at = now()
  where invoice_id = p_invoice_id;

  delete from public.invoice_tax_breakdowns where invoice_id = p_invoice_id;

  insert into public.invoice_tax_breakdowns (
    invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount
  )
  select
    p_invoice_id,
    normalized.vat_category_code,
    normalized.effective_rate,
    sum(normalized.line_net_amount) as taxable_amount,
    case
      when normalized.vat_category_code = 'S'
        then round(sum(normalized.line_net_amount) * normalized.effective_rate / 100, 2)
      else 0
    end as vat_amount
  from (
    select
      vat_category_code,
      case when vat_category_code = 'S' then vat_rate else 0 end as effective_rate,
      line_net_amount
    from public.invoice_items
    where invoice_id = p_invoice_id
  ) normalized
  group by normalized.vat_category_code, normalized.effective_rate;

  select coalesce(sum(line_net_amount), 0) into v_subtotal
  from public.invoice_items
  where invoice_id = p_invoice_id;

  select coalesce(sum(vat_amount), 0) into v_vat_total
  from public.invoice_tax_breakdowns
  where invoice_id = p_invoice_id;

  v_total := v_subtotal + v_vat_total + coalesce(v_rounding_amount, 0);

  -- ---------------------------------------------------------------------
  -- Číslovanie — VÝHRADNE pre issued.
  --
  -- Toto je jadro celej opravy. Pre received sa nealokuje nič: žiadny
  -- advisory lock nad naším radom, žiadny INSERT do invoice_number_sequences,
  -- žiadny UPDATE next_number. Interný rad vydaných faktúr sa prijatou
  -- faktúrou nikdy ani nedotkne, takže v ňom nemôže vzniknúť diera.
  --
  -- v_invoice_number a v_seq_id zostávajú pre received NULL — CHECK
  -- invoices_received_never_gets_internal_number a
  -- invoices_received_never_uses_sequence to zároveň vynucujú schémou.
  -- ---------------------------------------------------------------------
  if v_direction = 'issued' then
    v_series_key := case v_kind
      when 'credit_note' then 'credit_note'
      when 'debit_note' then 'debit_note'
      else 'regular'
    end;
    v_year := extract(year from v_issue_date)::integer;

    perform pg_advisory_xact_lock(
      hashtextextended(v_company_id::text || ':' || v_year::text || ':' || v_series_key, 0)
    );

    -- Predvolený prefix per séria pri PRVOM vzniku radu (ON CONFLICT DO
    -- NOTHING nikdy neprepíše existujúci, prípadne ručne upravený riadok).
    -- Bez neho by 'regular' aj 'credit_note'/'debit_note' rad pri prvom čísle
    -- vyprodukovali identický reťazec a narazili na
    -- invoices_company_invoice_number_key.
    insert into public.invoice_number_sequences (company_id, year, series_key, prefix)
    values (
      v_company_id, v_year, v_series_key,
      case v_series_key
        when 'credit_note' then 'DO'
        when 'debit_note' then 'ID'
        else 'FA'
      end
    )
    on conflict (company_id, year, series_key) do nothing;

    update public.invoice_number_sequences
    set next_number = next_number + 1,
        updated_at = now()
    where company_id = v_company_id
      and year = v_year
      and series_key = v_series_key
    returning id, prefix, suffix, padding, next_number - 1
      into v_seq_id, v_prefix, v_suffix, v_padding, v_allocated_number;

    v_invoice_number := coalesce(v_prefix, '') || v_year::text
      || lpad(v_allocated_number::text, v_padding, '0') || coalesce(v_suffix, '');
  end if;

  -- ---------------------------------------------------------------------
  -- Immutable snapshot strán — vzniká presne raz, tu. Mení sa VÝHRADNE zdroj
  -- snapshotu podľa smeru; invoice_parties.role ostáva seller/buyer.
  --
  --   issued:   seller = naša firma (company_billing_profile),
  --             buyer  = ODBERATEĽ (business_partners).
  --   received: seller = DODÁVATEĽ (business_partners),
  --             buyer  = naša firma (company_billing_profile).
  --
  -- Snapshot zahŕňa aj EN16931 P1 identifikátory (20260920122000), aby
  -- finalizovaná faktúra nikdy nemusela siahnuť na live master data.
  -- Párové CHECK constrainty (hodnota + scheme_id) sú zhodné na zdrojovej aj
  -- cieľovej tabuľke, takže kopírovanie 1:1 nemôže vyrobiť nevalidný pár.
  --
  -- company_billing_profile nemá peppol_identifier ani (pri received sellerovi)
  -- business_partners nemá iban/bic — tieto stĺpce preto zostávajú NULL.
  -- Nevymýšľajú sa.
  -- ---------------------------------------------------------------------
  if v_direction = 'issued' then
    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      iban, bic, email, source_business_partner_id,
      electronic_address, electronic_address_scheme_id,
      legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id
    )
    select
      p_invoice_id, 'seller', cbp.legal_name, cbp.ico, cbp.dic, cbp.ic_dph,
      cbp.address_line1, cbp.address_line2, cbp.city, cbp.postal_code, cbp.country_code,
      cbp.iban, cbp.bic, cbp.contact_email, null,
      cbp.electronic_address, cbp.electronic_address_scheme_id,
      cbp.legal_registration_id, cbp.legal_registration_scheme_id,
      cbp.vat_identifier, cbp.generic_identifier, cbp.generic_identifier_scheme_id
    from public.company_billing_profile cbp
    where cbp.company_id = v_company_id;

    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      email, peppol_identifier, source_business_partner_id,
      electronic_address, electronic_address_scheme_id,
      legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id
    )
    select
      p_invoice_id, 'buyer', bp.legal_name, bp.ico, bp.dic, bp.ic_dph,
      bp.address_line1, bp.address_line2, bp.city, bp.postal_code, bp.country_code,
      bp.email, bp.peppol_identifier, bp.id,
      bp.electronic_address, bp.electronic_address_scheme_id,
      bp.legal_registration_id, bp.legal_registration_scheme_id,
      bp.vat_identifier, bp.generic_identifier, bp.generic_identifier_scheme_id
    from public.business_partners bp
    where bp.id = v_counterparty_id;
  else
    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      email, peppol_identifier, source_business_partner_id,
      electronic_address, electronic_address_scheme_id,
      legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id
    )
    select
      p_invoice_id, 'seller', bp.legal_name, bp.ico, bp.dic, bp.ic_dph,
      bp.address_line1, bp.address_line2, bp.city, bp.postal_code, bp.country_code,
      bp.email, bp.peppol_identifier, bp.id,
      bp.electronic_address, bp.electronic_address_scheme_id,
      bp.legal_registration_id, bp.legal_registration_scheme_id,
      bp.vat_identifier, bp.generic_identifier, bp.generic_identifier_scheme_id
    from public.business_partners bp
    where bp.id = v_counterparty_id;

    insert into public.invoice_parties (
      invoice_id, role, legal_name, ico, dic, ic_dph,
      address_line1, address_line2, city, postal_code, country_code,
      iban, bic, email, source_business_partner_id,
      electronic_address, electronic_address_scheme_id,
      legal_registration_id, legal_registration_scheme_id,
      vat_identifier, generic_identifier, generic_identifier_scheme_id
    )
    select
      p_invoice_id, 'buyer', cbp.legal_name, cbp.ico, cbp.dic, cbp.ic_dph,
      cbp.address_line1, cbp.address_line2, cbp.city, cbp.postal_code, cbp.country_code,
      cbp.iban, cbp.bic, cbp.contact_email, null,
      cbp.electronic_address, cbp.electronic_address_scheme_id,
      cbp.legal_registration_id, cbp.legal_registration_scheme_id,
      cbp.vat_identifier, cbp.generic_identifier, cbp.generic_identifier_scheme_id
    from public.company_billing_profile cbp
    where cbp.company_id = v_company_id;
  end if;

  -- ---------------------------------------------------------------------
  -- Finálny zápis. Až tento UPDATE prepne faktúru na 'finalized' — všetko
  -- vyššie prebehlo nad ešte draft faktúrou, takže immutability triggery to
  -- neobmedzili.
  --
  -- Práve tu riadok vstupuje do partial unique indexov (received identity,
  -- dedupe fingerprint, transport ID), ktoré platia len pre finalized.
  -- Unique index je jediná skutočná záruka proti race condition medzi dvoma
  -- súbežnými finalize volaniami nad rovnakým dokladom — aplikačný pre-check
  -- by ju nedal. RPC ho preto len prekladá na zrozumiteľný kód.
  -- ---------------------------------------------------------------------
  begin
    update public.invoices
    set
      invoice_number = v_invoice_number,
      invoice_number_sequence_id = v_seq_id,
      subtotal_amount = v_subtotal,
      vat_total_amount = v_vat_total,
      total_amount = v_total,
      document_status = 'finalized',
      finalized_at = now(),
      finalized_by = auth.uid(),
      updated_at = now(),
      updated_by = auth.uid()
    where id = p_invoice_id
    returning finalized_at into v_finalized_at;
  exception
    when unique_violation then
      get stacked diagnostics v_conflict_constraint = constraint_name;

      if v_conflict_constraint in (
        'invoices_received_supplier_number_uniq',
        'invoices_dedupe_fingerprint_uniq',
        'invoices_transport_message_uniq'
      ) then
        raise exception using
          errcode = 'P0001',
          message = 'ESBLU_DUPLICATE_RECEIVED_INVOICE',
          hint = 'Doklad s rovnakou identitou (dodávateľ + číslo dokladu + typ) už je vo firme finalizovaný.';
      end if;

      raise;
  end;

  insert into public.invoice_events (
    invoice_id, event_type, actor_user_id, actor_source, payload
  )
  values (
    p_invoice_id, 'finalized', auth.uid(), 'user',
    jsonb_build_object(
      'direction', v_direction,
      'invoice_number', v_invoice_number,
      'supplier_invoice_number', v_supplier_invoice_number,
      'total_amount', v_total,
      'currency', null
    )
  );

  return jsonb_build_object(
    'invoice_id', p_invoice_id,
    'direction', v_direction,
    'invoice_number', v_invoice_number,
    'supplier_invoice_number', v_supplier_invoice_number,
    'subtotal_amount', v_subtotal,
    'vat_total_amount', v_vat_total,
    'total_amount', v_total,
    'finalized_at', v_finalized_at
  );
end;
$function$;

comment on function public.esblu_finalize_invoice(uuid) is
  'Atomická, DIRECTION-AWARE finalizácia draft faktúry. issued: číslo z interného radu Esblu (pg_advisory_xact_lock), seller = company_billing_profile, buyer = odberateľ. received: ŽIADNA alokácia interného radu, identitu dokladu tvorí supplier_invoice_number dodávateľa, seller = dodávateľ, buyer = naša firma. Spoločné: autorizácia (owner/finance.manage), SELECT...FOR UPDATE, validácia povinných polí/protistrany/billing profilu/opravovaného dokladu (vrátane zhody smeru)/S-kategórie VAT sadzby, autoritatívny category-aware VAT prepočet (EN16931 BR-CO-17/14/15), immutable snapshot strán vrátane EN16931 P1 identifikátorov, jednosmerný prechod draft→finalized, preklad unique violation na ESBLU_DUPLICATE_RECEIVED_INVOICE, audit event. Nikdy čiastočne finalizovaná faktúra — jedna DB transakcia.';

-- Explicit re-grant (CREATE OR REPLACE zachováva existujúce grants, toto je
-- explicitné potvrdenie pre auditovateľnosť tejto migrácie).
revoke execute on function public.esblu_finalize_invoice(uuid) from public;
revoke execute on function public.esblu_finalize_invoice(uuid) from anon;
grant execute on function public.esblu_finalize_invoice(uuid) to authenticated;

commit;
