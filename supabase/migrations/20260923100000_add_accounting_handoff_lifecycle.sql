-- =============================================================================
-- Účtovný lifecycle a odovzdanie účtovníkovi (handoff).
--
-- PRODUKTOVÉ ROZHODNUTIE, Z KTORÉHO TO VYCHÁDZA
-- ---------------------------------------------
-- Esblu NIE JE zákonný dlhodobý účtovný archív. Je to prevádzkový systém:
-- doklad sa prijme, spracuje, skontroluje, odovzdá účtovníkovi a po čase
-- sa jeho prevádzková kópia z Esblu odstráni. Dlhodobé uchovávanie podľa
-- zákona prebieha MIMO Esblu — u účtovníka, v účtovnom softvéri alebo vo
-- vlastnom archíve zákazníka.
--
-- Táto migrácia pridáva stavy, ktoré taký postup vôbec umožňujú zachytiť.
-- Nič nemaže, nič nepresúva a na existujúcich dokladoch nemení ani jeden
-- stĺpec.
--
-- PREČO STAV NIE JE NA `invoices`
-- -------------------------------
-- Finalizovaná faktúra je immutable (esblu_block_finalized_invoice_mutation
-- povoľuje len payment_status a audit metadáta). Pridať na ňu
-- `accounting_status` by znamenalo rozšíriť ten allowlist — teda oslabiť
-- invariant, ktorý chráni samotný doklad — a to všetko kvôli údaju, ktorý
-- o doklade NIE JE: „zaúčtované" je stav NÁŠHO procesu, nie vlastnosť
-- daňového dokladu. Preto stojí vedľa, vo vlastnej tabuľke.
--
-- UHRADENÉ ≠ ZAÚČTOVANÉ
-- ---------------------
-- `invoices.payment_status` hovorí o peniazoch, `accounting_status` o
-- spracovaní v účtovníctve. Doklad môže byť uhradený a nezaúčtovaný aj
-- naopak. Dve otázky, dve polia, žiadne odvodzovanie jedného z druhého.
--
-- ČO TÁTO MIGRÁCIA NEROBÍ
-- -----------------------
-- Nemaže doklady, nemá žiadny automatický beh podľa veku a nezavádza
-- mazanie finalizovaných faktúr. Oprávnenosť na odstránenie sa iba POČÍTA
-- (v aplikácii) — samotné odstránenie je samostatné, vysokorizikové
-- rozhodnutie, ktoré tu zámerne nie je.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Stav spracovania v účtovníctve
-- -----------------------------------------------------------------------------
create table if not exists public.invoice_accounting_state (
  invoice_id uuid primary key references public.invoices (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,

  -- Zámerne iba dve hodnoty. Viac stavov by znamenalo modelovať účtovný
  -- proces, ktorý prebieha mimo Esblu a v každej firme inak.
  accounting_status text not null default 'unprocessed'
    check (accounting_status in ('unprocessed', 'accounted')),

  accounted_at timestamptz,
  accounted_by uuid references auth.users (id) on delete set null,

  updated_at timestamptz not null default now(),

  -- Čas a autor dávajú zmysel iba pri zaúčtovanom doklade. Bez tejto
  -- podmienky by sa „nezaúčtované" dalo uložiť s dátumom zaúčtovania a
  -- nikto by nevedel, čo z toho platí.
  constraint invoice_accounting_state_accounted_fields check (
    (accounting_status = 'accounted' and accounted_at is not null)
    or (accounting_status = 'unprocessed' and accounted_at is null and accounted_by is null)
  )
);

create index if not exists invoice_accounting_state_company_idx
  on public.invoice_accounting_state (company_id, accounting_status);

-- -----------------------------------------------------------------------------
-- 2. Odovzdanie účtovníkovi — UDALOSŤ, nie stav
-- -----------------------------------------------------------------------------
--
-- Export je vec, ktorá sa raz stala. Preto sa zapisuje ako riadok, ktorý
-- sa nedá zmeniť ani zmazať: je to doklad o tom, že doklady niekto
-- odovzdal — a po prípadnom odstránení prevádzkovej kópie zostáva jediným
-- dôkazom, že sa tak stalo.
create table if not exists public.accounting_handoff_exports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,

  -- Za aké obdobie a aký smer sa odovzdávalo. NULL = bez obmedzenia.
  period_from date,
  period_to date,
  direction text check (direction in ('issued', 'received')),

  invoice_count integer not null check (invoice_count >= 0),

  -- Odtlačok obsahu exportu. Slúži na neskoršie overenie, že odovzdaný
  -- súbor je ten, o ktorom hovorí tento záznam.
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),

  note text,

  constraint accounting_handoff_exports_period check (
    period_from is null or period_to is null or period_from <= period_to
  )
);

create index if not exists accounting_handoff_exports_company_idx
  on public.accounting_handoff_exports (company_id, created_at desc);

create table if not exists public.accounting_handoff_export_items (
  export_id uuid not null references public.accounting_handoff_exports (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  primary key (export_id, invoice_id)
);

create index if not exists accounting_handoff_export_items_invoice_idx
  on public.accounting_handoff_export_items (invoice_id);

-- -----------------------------------------------------------------------------
-- 3. RLS
-- -----------------------------------------------------------------------------
--
-- Rovnaký dvojosový model ako pri faktúrach: firma + finančné oprávnenie.
-- Čítať smie držiteľ finance.view, zapisovať držiteľ finance.manage.
-- Zamestnanec nemá ani jedno, takže tieto tabuľky pre neho neexistujú.

alter table public.invoice_accounting_state enable row level security;
alter table public.accounting_handoff_exports enable row level security;
alter table public.accounting_handoff_export_items enable row level security;

drop policy if exists invoice_accounting_state_select on public.invoice_accounting_state;
create policy invoice_accounting_state_select
  on public.invoice_accounting_state for select
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

drop policy if exists invoice_accounting_state_insert on public.invoice_accounting_state;
create policy invoice_accounting_state_insert
  on public.invoice_accounting_state for insert
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    -- Stav sa smie založiť iba k dokladu, ktorý volajúci naozaj vidí.
    -- Bez tejto podmienky by sa dal pripnúť k cudziemu identifikátoru.
    and exists (
      select 1 from public.invoices i
      where i.id = invoice_id and i.company_id = public.esblu_my_active_company_id()
    )
  );

drop policy if exists invoice_accounting_state_update on public.invoice_accounting_state;
create policy invoice_accounting_state_update
  on public.invoice_accounting_state for update
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage())
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage());

-- Zmazanie stavu sa ZÁMERNE nepovoľuje: „zaúčtované" sa odvoláva zmenou
-- stavu, ktorá je vidieť, nie zmiznutím riadka.

drop policy if exists accounting_handoff_exports_select on public.accounting_handoff_exports;
create policy accounting_handoff_exports_select
  on public.accounting_handoff_exports for select
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

drop policy if exists accounting_handoff_exports_insert on public.accounting_handoff_exports;
create policy accounting_handoff_exports_insert
  on public.accounting_handoff_exports for insert
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and (created_by is null or created_by = auth.uid())
  );

-- ŽIADNE update ani delete: udalosť sa nemení a nemaže.

drop policy if exists accounting_handoff_export_items_select on public.accounting_handoff_export_items;
create policy accounting_handoff_export_items_select
  on public.accounting_handoff_export_items for select
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

drop policy if exists accounting_handoff_export_items_insert on public.accounting_handoff_export_items;
create policy accounting_handoff_export_items_insert
  on public.accounting_handoff_export_items for insert
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and exists (
      select 1 from public.accounting_handoff_exports e
      where e.id = export_id and e.company_id = public.esblu_my_active_company_id()
    )
    and exists (
      select 1 from public.invoices i
      where i.id = invoice_id and i.company_id = public.esblu_my_active_company_id()
    )
  );

-- -----------------------------------------------------------------------------
-- 4. Firma sa NEBERIE od klienta
-- -----------------------------------------------------------------------------
--
-- Predvolená hodnota pochádza zo servera. WITH CHECK ju síce overuje aj
-- tak, ale default znamená, že klient company_id vôbec posielať nemusí —
-- a čo sa neposiela, to sa nedá podvrhnúť.
alter table public.invoice_accounting_state
  alter column company_id set default public.esblu_my_active_company_id();
alter table public.accounting_handoff_exports
  alter column company_id set default public.esblu_my_active_company_id();
alter table public.accounting_handoff_export_items
  alter column company_id set default public.esblu_my_active_company_id();

-- -----------------------------------------------------------------------------
-- 5. Granty
-- -----------------------------------------------------------------------------
revoke all on public.invoice_accounting_state from public, anon;
revoke all on public.accounting_handoff_exports from public, anon;
revoke all on public.accounting_handoff_export_items from public, anon;

grant select, insert, update on public.invoice_accounting_state to authenticated;
grant select, insert on public.accounting_handoff_exports to authenticated;
grant select, insert on public.accounting_handoff_export_items to authenticated;

-- ODOBRANIE PRÁV, KTORÉ NIKTO NEUDELIL.
--
-- Supabase dáva novým tabuľkám ALL privileges pre `authenticated` cez
-- ALTER DEFAULT PRIVILEGES, takže samotný `grant select, insert` vyššie
-- nič neobmedzuje. Bez RLS politiky by taký UPDATE prešiel cez práva a
-- zmenil nula riadkov — teda by zlyhal TICHO. Nemennosť udalosti má byť
-- hlasná: práva sa preto odoberajú výslovne.
--
-- Overené testom: pokus o zmenu aj zmazanie udalosti skončí chybou 42501.
revoke update, delete on public.accounting_handoff_exports from authenticated;
revoke update, delete on public.accounting_handoff_export_items from authenticated;
revoke delete on public.invoice_accounting_state from authenticated;

comment on table public.invoice_accounting_state is
  'Stav spracovania faktúry v účtovníctve. Oddelený od invoices, lebo finalizovaný doklad je immutable a "zaúčtované" je stav nášho procesu, nie vlastnosť dokladu.';
comment on table public.accounting_handoff_exports is
  'Udalosť odovzdania dokladov účtovníkovi. Nemenná a nemazateľná — po odstránení prevádzkovej kópie je jediným dôkazom, že odovzdanie prebehlo.';
