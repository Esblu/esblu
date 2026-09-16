begin;

-- =============================================================================
-- Esblu — Fakturačné jadro (FÁZA 2), migrácia A: tabuľky + constraints +
-- indexy + RLS
-- =============================================================================
-- Nadväzuje na Fázu 0 (docs/invoicing-efaktura-architecture-2026-09-15.md,
-- podmienečne schválená používateľom s 13 korekciami) a na Finance Access
-- Hardening (20260916090827). Kanonický, syntax-neutrálny fakturačný model —
-- BEZ PDF, BEZ Peppol/eFaktúra, BEZ provider integrácie. Tie idú do
-- neskorších fáz (5-7 podľa Fázy 0).
--
-- ZÁVÄZNÉ ARCHITEKTONICKÉ ROZHODNUTIA (z Fázy 0 + zadania Fázy 2):
--   1. company_billing_profile a business_partners sú MUTABLE MASTER DATA.
--      Finalizovaná faktúra sa na ne nikdy neopiera priamo — právne záväzné
--      údaje strán žijú v `invoice_parties`, ktorá je IMMUTABLE SNAPSHOT
--      vytvorený PRESNE RAZ, atomicky, pri finalizácii (migrácia B).
--   2. `invoices.customer_business_partner_id` je iba UI/master-data
--      referencia (predvyplnenie, "ukáž mi faktúry pre firmu X") — nikdy nie
--      je zdrojom pravdy pre finalizovanú faktúru.
--   3. `document_status` má iba 'draft'→'finalized' (jednosmerne). Žiadne
--      'cancelled'/'corrected' — storno/oprava je vždy samostatný
--      `credit_note`/`debit_note` záznam s `corrects_invoice_id`, pôvodná
--      faktúra zostáva navždy 'finalized'.
--   4. `payment_status` a (v budúcnosti) `delivery_status` sú samostatné
--      dimenzie od `document_status` — faktúra môže byť súčasne finalized +
--      overdue (odvodené, nie uložené: `due_date < today AND payment_status
--      <> 'paid'`).
--   5. VAT breakdown je normalizovaná tabuľka (`invoice_tax_breakdowns`), nie
--      jsonb — umožňuje priame SQL agregovanie/reportovanie.
--   6. Peňažné súčty `numeric(18,2)` (explicitná voľba zadania Fázy 2, vyššia
--      než Fázy 0 pôvodných `numeric(14,2)` — "Neber numeric(14,2)
--      automaticky"). `quantity`/`unit_price` `numeric(18,6)` — vyššia
--      presnosť pre stavebný materiál/služby s necelými jednotkovými cenami.
--   7. VAT engine (aplikačná aj DB validačná vrstva, migrácia B) počíta VAT
--      breakdown podľa EN16931 business rules BR-CO-17/BR-CO-14/BR-CO-15
--      (Peppol BIS Billing 3.0, docs.peppol.eu, overené web-researchom
--      16.9.2026): `vat_amount` per (kategória × sadzba) = ROUND(taxable_
--      amount × rate / 100, 2), kde `taxable_amount` = SÚČET `line_net_
--      amount` riadkov danej kategórie/sadzby (BR-CO-17). NIE súčet už
--      zaokrúhlených per-line VAT súm — to je bežná chyba, ktorá pri
--      viacerých riadkoch tej istej sadzby môže dať iný výsledok než čo
--      EN16931/Peppol validátor akceptuje. `invoice_items.line_vat_amount`
--      preto slúži iba na UI zobrazenie per riadok (rovnaký vzorec na
--      úrovni riadku), nikdy nie je vstupom do `invoice_tax_breakdowns`.
--      `vat_total_amount` = SÚČET `invoice_tax_breakdowns.vat_amount`
--      (BR-CO-14). `total_amount` = `subtotal_amount` + `vat_total_amount`
--      (+ `rounding_amount`, zatiaľ vždy 0 — BT-114 rezerva na budúce
--      hotovostné zaokrúhlenie, nepoužíva sa v Fáze 2).
--   8. Reverse charge (`vat_category_code='AE'`) je v dátovom modeli
--      podporený (stavebníctvo), ALE interakcia s eFaktúrou zostáva
--      nepotvrdená (Fáza 0, bod 1/C) — eFaktúra-špecifické mapovanie sa
--      nerobí v tejto fáze, AI nikdy neurčuje VAT kategóriu (iba používateľ).
--   9. Číselné rady: `invoice_number_sequences` je company+year+series_key
--      scoped. Predvolený, explicitne zdôvodnený (nie hádaný) default:
--      `regular_invoice`/`payment_received_invoice` zdieľajú `series_key=
--      'regular'`, `credit_note` má vlastný `'credit_note'`, `debit_note`
--      vlastný `'debit_note'` — bežná slovenská účtovná prax (opravné
--      doklady oddelene číslované), stĺpec `series_key` je voľne
--      konfigurovateľný, takže firma môže v budúcnosti zdieľať rad, ak to
--      účtovník/CLIA potvrdí ako vyhovujúce. Toto NIE JE právne prehlásenie,
--      iba technický predvolený default — presné potvrdenie nechať
--      účtovníkovi (neblokuje implementáciu, keďže zákon o účtovníctve
--      vyžaduje neprerušenú, chronologickú, jednoznačnú postupnosť čísel
--      per rad, nie konkrétnu schému zdieľania radov). `esblu_finalize_
--      invoice()` (migrácia B) pri PRVOM vzniku radu pre danú company+rok
--      nastavuje aj predvolený `prefix` odlíšený per séria ('FA'/'DO'/'ID')
--      — bez toho by 'regular' aj 'credit_note'/'debit_note' rad pri prvom
--      čísle vyprodukovali identický reťazec (rok+lpad(1,padding,'0')) a
--      narazili by na `invoices_company_invoice_number_key` UNIQUE
--      constraint (company_id, invoice_number).
--  10. Multi-tenant izolácia + finance-permission RLS model (owner vždy,
--      inak `esblu_my_finance_view()`/`esblu_my_finance_manage()` z
--      20260916090827) na KAŽDEJ novej tabuľke, žiadny anon prístup.
--  11. Immutabilita finalizovanej faktúry je DB-level (triggery, migrácia
--      B), nie iba UI/RLS.
--
-- Expand-only — žiadne mazanie/zmena existujúcich dát alebo tabuliek.
-- =============================================================================


-- =============================================================================
-- 1. invoice_number_sequences — company+year+series_key scoped counter
-- =============================================================================
-- Concurrency-safe pridelenie rieši migrácia B (pg_advisory_xact_lock +
-- UPDATE ... RETURNING, rovnaký vzor ako esblu_enforce_plan_limit). Táto
-- tabuľka sama osebe nemá žiadnu client-facing write RLS politiku — zapisuje
-- do nej výhradne esblu_finalize_invoice() ako SECURITY DEFINER.
create table public.invoice_number_sequences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  year integer not null,
  -- Default 'regular' — pozri bod 9 v hlavičke migrácie pre presné
  -- priradenie kind→series_key použité v esblu_finalize_invoice().
  series_key text not null default 'regular',
  prefix text,
  suffix text,
  padding integer not null default 4,
  next_number integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (company_id, year, series_key)
);

comment on table public.invoice_number_sequences is
  'Company+rok+rad scoped číselník. next_number = ĎALŠIE voľné číslo. Zápis výhradne cez esblu_finalize_invoice() (SECURITY DEFINER, pg_advisory_xact_lock), nikdy priamy klientský UPDATE.';

alter table public.invoice_number_sequences enable row level security;


-- =============================================================================
-- 2. invoices — identita, stav, sumy, referencie
-- =============================================================================
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  direction text not null check (direction in ('issued', 'received')),
  kind text not null check (kind in (
    'regular_invoice', 'payment_received_invoice', 'credit_note', 'debit_note'
  )),

  document_status text not null default 'draft'
    check (document_status in ('draft', 'finalized')),
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'partially_paid', 'paid')),

  -- Pridelené výhradne pri finalizácii (migrácia B) — nikdy skôr, nikdy
  -- klientom. NULL kým document_status='draft'.
  invoice_number text,
  invoice_number_sequence_id uuid references public.invoice_number_sequences(id),

  issue_date date not null default current_date,
  due_date date,
  delivery_date date,
  tax_point_date date,

  currency text not null default 'EUR',
  subtotal_amount numeric(18, 2) not null default 0,
  vat_total_amount numeric(18, 2) not null default 0,
  total_amount numeric(18, 2) not null default 0,
  -- BT-114 rezerva na budúce hotovostné zaokrúhlenie — v Fáze 2 vždy 0,
  -- VAT engine ho nepoužíva na "vynútenie" rekonciliácie (bod 7 vyššie).
  rounding_amount numeric(18, 2) not null default 0,

  variable_symbol text,
  payment_terms_days integer,
  iban text,

  -- Iba UI/master-data referencia (bod 2 vyššie) — NIKDY zdroj pravdy pre
  -- finalizovanú faktúru (to je invoice_parties, nižšie).
  customer_business_partner_id uuid references public.business_partners(id) on delete set null,
  -- Self-FK pre credit_note/debit_note — musí odkazovať na finalizovanú
  -- faktúru tej istej firmy (vynútené CHECK + RPC validáciou, nie FK samotným).
  corrects_invoice_id uuid references public.invoices(id),

  source text not null default 'manual'
    check (source in ('manual', 'ai_inbox', 'efaktura_peppol')),
  source_document_id uuid references public.documents(id) on delete set null,

  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  finalized_at timestamptz,
  finalized_by uuid references auth.users(id),

  -- Číslo je povinné až po finalizácii, nikdy skôr.
  constraint invoices_number_required_when_finalized check (
    document_status <> 'finalized' or invoice_number is not null
  ),
  constraint invoices_finalized_at_consistency check (
    (document_status = 'finalized') = (finalized_at is not null)
  ),
  -- Opravné doklady MUSIA odkazovať na pôvodnú faktúru; riadne faktúry
  -- NESMÚ (aby sa predišlo nejednoznačnosti "je toto oprava alebo nie").
  constraint invoices_corrects_required_for_notes check (
    (kind in ('credit_note', 'debit_note')) = (corrects_invoice_id is not null)
  ),
  constraint invoices_corrects_not_self check (
    corrects_invoice_id is null or corrects_invoice_id <> id
  )
);

comment on table public.invoices is
  'Kanonický fakturačný záznam (Fáza 2). draft→finalized jednosmerne (migrácia B trigger). Storno/oprava = samostatný credit_note/debit_note s corrects_invoice_id, pôvodný riadok sa nikdy nemení na "cancelled".';
comment on column public.invoices.customer_business_partner_id is
  'Iba UI/master-data referencia (predvyplnenie, filtrovanie). Po finalizácii je právnym zdrojom pravdy výhradne invoice_parties, nikdy táto FK.';

create index invoices_company_id_idx on public.invoices(company_id);
create index invoices_company_status_idx on public.invoices(company_id, document_status);
create index invoices_company_payment_status_idx on public.invoices(company_id, payment_status);
create index invoices_corrects_invoice_id_idx on public.invoices(corrects_invoice_id) where corrects_invoice_id is not null;
create index invoices_customer_business_partner_id_idx on public.invoices(customer_business_partner_id) where customer_business_partner_id is not null;
create unique index invoices_company_invoice_number_key on public.invoices(company_id, invoice_number) where invoice_number is not null;

alter table public.invoices enable row level security;


-- =============================================================================
-- 3. invoice_items — riadkové položky (mutable kým draft)
-- =============================================================================
create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  position integer not null,
  description text not null,
  -- Vyššia presnosť než peňažné súčty (bod 6 vyššie) — stavebný
  -- materiál/služby bežne potrebujú viac než 2 desatinné miesta.
  quantity numeric(18, 6) not null check (quantity > 0),
  unit text not null default 'ks',
  unit_price numeric(18, 6) not null check (unit_price >= 0),

  vat_category_code text not null check (vat_category_code in ('S', 'Z', 'E', 'AE')),
  vat_rate numeric(7, 4) not null default 0 check (vat_rate >= 0),

  -- Autoritatívne prepočítané vždy pri finalizácii (migrácia B) — draft
  -- hodnoty sú zobrazovacie/priebežné, finalize ich prepočíta nanovo z
  -- quantity/unit_price/vat_rate, nikdy im neverí naslepo.
  line_net_amount numeric(18, 2) not null default 0,
  -- Iba UI zobrazenie per riadok — NIKDY vstup do invoice_tax_breakdowns
  -- (bod 7 v hlavičke migrácie, EN16931 BR-CO-17).
  line_vat_amount numeric(18, 2) not null default 0,
  line_gross_amount numeric(18, 2) not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz,

  unique (invoice_id, position)
);

comment on table public.invoice_items is
  'Riadkové položky faktúry. Mutable iba kým rodičovská invoices.document_status=draft (migrácia B trigger vynucuje immutabilitu po finalizácii). line_vat_amount je iba UI hodnota, autoritatívny VAT breakdown je invoice_tax_breakdowns.';

create index invoice_items_invoice_id_idx on public.invoice_items(invoice_id);

alter table public.invoice_items enable row level security;


-- =============================================================================
-- 4. invoice_tax_breakdowns — normalizovaný VAT súhrn (BR-CO-17/BR-CO-14)
-- =============================================================================
create table public.invoice_tax_breakdowns (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  vat_category_code text not null check (vat_category_code in ('S', 'Z', 'E', 'AE')),
  vat_rate numeric(7, 4) not null,
  -- BT-116 — súčet line_net_amount riadkov tejto kategórie/sadzby.
  taxable_amount numeric(18, 2) not null,
  -- BT-117 — ROUND(taxable_amount * vat_rate / 100, 2), EN16931 BR-CO-17.
  vat_amount numeric(18, 2) not null,
  unique (invoice_id, vat_category_code, vat_rate)
);

comment on table public.invoice_tax_breakdowns is
  'Autoritatívny VAT súhrn per (kategória × sadzba), deterministicky odvodený z invoice_items pri finalizácii (EN16931 BR-CO-17: vat_amount = ROUND(taxable_amount × rate/100, 2), NIE súčet už zaokrúhlených per-line súm). Zapisuje výhradne esblu_finalize_invoice().';

create index invoice_tax_breakdowns_invoice_id_idx on public.invoice_tax_breakdowns(invoice_id);

alter table public.invoice_tax_breakdowns enable row level security;


-- =============================================================================
-- 5. invoice_parties — immutable snapshot predávajúceho/kupujúceho
-- =============================================================================
create table public.invoice_parties (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  role text not null check (role in ('seller', 'buyer')),

  legal_name text not null,
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
  email text,
  peppol_identifier text,

  -- Iba spätná dohľadateľnosť ("z akého master-data záznamu to bolo
  -- predvyplnené") — NIKDY sa nečíta späť ako zdroj pravdy.
  source_business_partner_id uuid references public.business_partners(id) on delete set null,
  snapshotted_at timestamptz not null default now(),

  unique (invoice_id, role)
);

comment on table public.invoice_parties is
  'Immutable snapshot predávajúceho/kupujúceho, vytvorený PRESNE RAZ pri finalizácii (esblu_finalize_invoice). Po vzniku sa nikdy needituje ani nemaže (migrácia B trigger) — aj keby sa business_partners/company_billing_profile neskôr zmenili, historická faktúra zostáva nezmenená.';

create index invoice_parties_invoice_id_idx on public.invoice_parties(invoice_id);

alter table public.invoice_parties enable row level security;


-- =============================================================================
-- 6. invoice_payments — ručné záznamy platieb (Fáza 2: bez open bankingu)
-- =============================================================================
create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  paid_amount numeric(18, 2) not null check (paid_amount > 0),
  paid_at date not null default current_date,
  payment_method text,
  note text,
  recorded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

comment on table public.invoice_payments is
  'Ručné záznamy platieb. Zapisuje/maže výhradne cez esblu_add_invoice_payment()/esblu_remove_invoice_payment() (SECURITY DEFINER) — nikdy priamy klientský INSERT/DELETE, aby invoices.payment_status ostal vždy deterministicky prepočítaný v tej istej transakcii.';

create index invoice_payments_invoice_id_idx on public.invoice_payments(invoice_id);

alter table public.invoice_payments enable row level security;


-- =============================================================================
-- 7. invoice_events — ľahký audit log (BEZ plného snapshotu/PII)
-- =============================================================================
create table public.invoice_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  event_type text not null check (event_type in (
    'created', 'draft_updated', 'finalized',
    'payment_recorded', 'payment_removed', 'correction_created'
  )),
  actor_user_id uuid references auth.users(id),
  actor_source text not null default 'user' check (actor_source in ('user', 'system')),
  -- Iba malé, event-špecifické metadáta (napr. {"invoice_number":"...",
  -- "total_amount":123.45}) — NIKDY celý invoice snapshot, IBAN, party dáta,
  -- secrets. Finalizovaná faktúra už žije nezmenená v invoices/invoice_items/
  -- invoice_parties, netreba ju duplikovať aj sem.
  payload jsonb,
  created_at timestamptz not null default now()
);

comment on table public.invoice_events is
  'Ľahký, nemenný audit log (kto/čo/kedy). payload nikdy nesmie obsahovať plný snapshot faktúry, IBAN, adresy strán ani secrets — iba malé metadáta pre danú udalosť. Insert výhradne cez trusted server/RPC cestu.';

create index invoice_events_invoice_id_idx on public.invoice_events(invoice_id);

alter table public.invoice_events enable row level security;


-- =============================================================================
-- 8. RLS — finance-permission model (owner vždy, inak esblu_my_finance_*())
-- =============================================================================
-- Rovnaký model ako company_billing_profile/business_partners
-- (20260916090827): SELECT = finance view alebo manage; write (kde vôbec
-- klientský write existuje) = finance manage. Draft-only zápis na invoices/
-- invoice_items je vynútený priamo v RLS predikáte (dokument_status='draft'),
-- finalizovaná faktúra je navyše chránená DB triggerom (migrácia B) ako
-- druhá, nezávislá vrstva.

-- --- invoices ---------------------------------------------------------------
create policy invoices_select_finance
  on public.invoices
  for select
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_view()
  );

create policy invoices_insert_finance_draft
  on public.invoices
  for insert
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and document_status = 'draft'
    and invoice_number is null
    and (created_by is null or created_by = auth.uid())
    and (updated_by is null or updated_by = auth.uid())
  );

-- Priamy klientský UPDATE je povolený VÝHRADNE kým je faktúra draft (editácia
-- konceptu). Po finalizácii ide každá povolená zmena (payment_status)
-- výhradne cez esblu_add_invoice_payment()/esblu_remove_invoice_payment()
-- (SECURITY DEFINER, obchádza RLS) — priamy klientský UPDATE finalizovanej
-- faktúry je touto politikou úplne odrezaný (using aj with_check vyžadujú
-- document_status='draft'), immutability trigger (migrácia B) je druhá,
-- nezávislá poistka.
create policy invoices_update_finance_draft
  on public.invoices
  for update
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and document_status = 'draft'
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and document_status = 'draft'
    and invoice_number is null
    and (updated_by is null or updated_by = auth.uid())
  );

create policy invoices_delete_finance_draft
  on public.invoices
  for delete
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and document_status = 'draft'
  );

-- --- invoice_items ------------------------------------------------------
-- Company scoping cez rodičovskú invoices (JOIN podmienka), presne ako
-- zadanie žiada v bode 22. Zápis iba kým je rodičovská faktúra draft.
create policy invoice_items_select_finance
  on public.invoice_items
  for select
  using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_items.invoice_id
        and i.company_id = public.esblu_my_active_company_id()
        and public.esblu_my_finance_view()
    )
  );

create policy invoice_items_insert_finance_draft
  on public.invoice_items
  for insert
  with check (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_items.invoice_id
        and i.company_id = public.esblu_my_active_company_id()
        and public.esblu_my_finance_manage()
        and i.document_status = 'draft'
    )
  );

create policy invoice_items_update_finance_draft
  on public.invoice_items
  for update
  using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_items.invoice_id
        and i.company_id = public.esblu_my_active_company_id()
        and public.esblu_my_finance_manage()
        and i.document_status = 'draft'
    )
  )
  with check (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_items.invoice_id
        and i.company_id = public.esblu_my_active_company_id()
        and public.esblu_my_finance_manage()
        and i.document_status = 'draft'
    )
  );

create policy invoice_items_delete_finance_draft
  on public.invoice_items
  for delete
  using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_items.invoice_id
        and i.company_id = public.esblu_my_active_company_id()
        and public.esblu_my_finance_manage()
        and i.document_status = 'draft'
    )
  );

-- --- invoice_tax_breakdowns ----------------------------------------------
-- Read-only pre klienta za každých okolností — zapisuje výhradne
-- esblu_finalize_invoice() (SECURITY DEFINER, obchádza RLS).
create policy invoice_tax_breakdowns_select_finance
  on public.invoice_tax_breakdowns
  for select
  using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_tax_breakdowns.invoice_id
        and i.company_id = public.esblu_my_active_company_id()
        and public.esblu_my_finance_view()
    )
  );

-- --- invoice_parties ------------------------------------------------------
-- Read-only pre klienta za každých okolností — zapisuje výhradne
-- esblu_finalize_invoice() (SECURITY DEFINER, obchádza RLS). Žiadna
-- INSERT/UPDATE/DELETE politika = default deny pre authenticated.
create policy invoice_parties_select_finance
  on public.invoice_parties
  for select
  using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_parties.invoice_id
        and i.company_id = public.esblu_my_active_company_id()
        and public.esblu_my_finance_view()
    )
  );

-- --- invoice_payments -----------------------------------------------------
-- Read-only pre klienta — zapisuje/maže výhradne
-- esblu_add_invoice_payment()/esblu_remove_invoice_payment() (SECURITY
-- DEFINER), aby payment_status na invoices ostal vždy atomicky prepočítaný
-- v tej istej transakcii ako samotný záznam platby (zadanie bod 19).
create policy invoice_payments_select_finance
  on public.invoice_payments
  for select
  using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_payments.invoice_id
        and i.company_id = public.esblu_my_active_company_id()
        and public.esblu_my_finance_view()
    )
  );

-- --- invoice_events ---------------------------------------------------------
-- Read-only pre klienta — insert výhradne cez trusted server/RPC cesty
-- (esblu_finalize_invoice, esblu_add_invoice_payment, ...).
create policy invoice_events_select_finance
  on public.invoice_events
  for select
  using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_events.invoice_id
        and i.company_id = public.esblu_my_active_company_id()
        and public.esblu_my_finance_view()
    )
  );

-- --- invoice_number_sequences -----------------------------------------------
-- Read-only pre finance (napr. UI náhľad "ďalšie číslo bude okolo..."), NO
-- write politika vôbec — next_number mení výhradne esblu_finalize_invoice()
-- (SECURITY DEFINER).
create policy invoice_number_sequences_select_finance
  on public.invoice_number_sequences
  for select
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_view()
  );

commit;
