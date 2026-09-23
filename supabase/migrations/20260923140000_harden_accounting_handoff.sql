-- =============================================================================
-- Spevnenie účtovného handoffu: čo je export údajov a čo je odovzdanie.
--
-- DÔVOD
-- -----
-- Predchádzajúca verzia hovorila „odovzdané účtovníkovi" vtedy, keď sa
-- stiahol zošit s údajmi. To nie je pravda a nie je to maličkosť: z takého
-- tvrdenia by sa časom odvodilo, že doklad môže z Esblu zmiznúť, hoci
-- originál faktúry nikam neodišiel. Stiahnutie súboru nie je dôkaz, že
-- účtovník doklady dostal — a už vôbec nie, že ich archivuje.
--
-- Táto migrácia preto:
--   1. rozlišuje DRUH exportu (údaje vs. úplný balík vrátane originálov),
--   2. zavádza nemenný denník zmien účtovného stavu,
--   3. doťahuje práva, ktoré Supabase dáva novým tabuľkám automaticky.
--
-- Naďalej sa nič nemaže a mazanie sa nezavádza.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Druh exportu
-- -----------------------------------------------------------------------------
--
-- `metadata_xlsx` je to, čo appka vie dnes: zošit s údajmi o dokladoch.
-- `complete_package` je budúci úplný balík — originály prijatých dokladov,
-- PDF vydaných faktúr, prílohy a manifest. Zatiaľ ho nič nevytvára a
-- hodnota existuje preto, aby sa oprávnenosť na odstránenie dala naviazať
-- na NIEČO KONKRÉTNE, nie na „veď sa niečo exportovalo".
--
-- Existujúce riadky dostanú `metadata_xlsx`, čo je presne to, čím sú.
alter table public.accounting_handoff_exports
  add column if not exists export_kind text not null default 'metadata_xlsx';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.accounting_handoff_exports'::regclass
      and conname = 'accounting_handoff_exports_kind_check'
  ) then
    alter table public.accounting_handoff_exports
      add constraint accounting_handoff_exports_kind_check
      check (export_kind in ('metadata_xlsx', 'complete_package'));
  end if;
end $$;

comment on column public.accounting_handoff_exports.export_kind is
  'metadata_xlsx = zosit s udajmi (nie je odovzdanie dokladov). complete_package = uplny balik vratane originalov; zatial ho nic nevytvara.';

-- -----------------------------------------------------------------------------
-- 2. Denník účtovného stavu
-- -----------------------------------------------------------------------------
--
-- Označenie „zaúčtované" sa dá odvolať — a má sa dať, lebo ho robí človek.
-- Odvolanie však nesmie zmazať stopu: predtým sa `accounted_at` a
-- `accounted_by` prepísali na NULL a informácia, že doklad BOL označený,
-- zanikla bez zvyšku.
--
-- Denník je append-only a píše doň VÝHRADNE trigger. Používateľ doň nemá
-- ani INSERT — inak by dôkaz o zmene vyrábal ten, koho sa týka.
create table if not exists public.invoice_accounting_state_log (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  accounting_status text not null check (accounting_status in ('unprocessed', 'accounted')),
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users (id) on delete set null
);

create index if not exists invoice_accounting_state_log_invoice_idx
  on public.invoice_accounting_state_log (invoice_id, changed_at desc);

create or replace function public.esblu_log_invoice_accounting_state()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- Zapisuje sa KAŽDÁ zmena stavu vrátane prvého nastavenia. Autor sa
  -- berie z auth.uid(), nie z riadka: `accounted_by` je pri odvolaní NULL
  -- a práve vtedy je najdôležitejšie vedieť, kto odvolával.
  if TG_OP = 'INSERT' or NEW.accounting_status is distinct from OLD.accounting_status then
    insert into public.invoice_accounting_state_log
      (invoice_id, company_id, accounting_status, changed_by)
    values (NEW.invoice_id, NEW.company_id, NEW.accounting_status, auth.uid());
  end if;

  return NEW;
end;
$function$;

drop trigger if exists esblu_invoice_accounting_state_log on public.invoice_accounting_state;
create trigger esblu_invoice_accounting_state_log
  after insert or update on public.invoice_accounting_state
  for each row execute function public.esblu_log_invoice_accounting_state();

alter table public.invoice_accounting_state_log enable row level security;

drop policy if exists invoice_accounting_state_log_select on public.invoice_accounting_state_log;
create policy invoice_accounting_state_log_select
  on public.invoice_accounting_state_log for select
  to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

-- Žiadna insert/update/delete politika. Do denníka píše iba trigger, ktorý
-- beží ako definer a politikám nepodlieha.

-- -----------------------------------------------------------------------------
-- 3. Politiky výslovne pre `authenticated`
-- -----------------------------------------------------------------------------
--
-- Pôvodné politiky platili pre PUBLIC. Bezpečné to bolo iba vďaka tomu, že
-- `anon` nemá na tieto tabuľky žiadne práva — teda vďaka druhej vrstve, nie
-- vďaka politike samotnej. Rola sa preto uvádza priamo.
drop policy if exists invoice_accounting_state_select on public.invoice_accounting_state;
create policy invoice_accounting_state_select
  on public.invoice_accounting_state for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

drop policy if exists invoice_accounting_state_insert on public.invoice_accounting_state;
create policy invoice_accounting_state_insert
  on public.invoice_accounting_state for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and exists (
      select 1 from public.invoices i
      where i.id = invoice_id and i.company_id = public.esblu_my_active_company_id()
    )
  );

drop policy if exists invoice_accounting_state_update on public.invoice_accounting_state;
create policy invoice_accounting_state_update
  on public.invoice_accounting_state for update to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage())
  with check (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_manage());

drop policy if exists accounting_handoff_exports_select on public.accounting_handoff_exports;
create policy accounting_handoff_exports_select
  on public.accounting_handoff_exports for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

drop policy if exists accounting_handoff_exports_insert on public.accounting_handoff_exports;
create policy accounting_handoff_exports_insert
  on public.accounting_handoff_exports for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and (created_by is null or created_by = auth.uid())
  );

drop policy if exists accounting_handoff_export_items_select on public.accounting_handoff_export_items;
create policy accounting_handoff_export_items_select
  on public.accounting_handoff_export_items for select to authenticated
  using (company_id = public.esblu_my_active_company_id() and public.esblu_my_finance_view());

drop policy if exists accounting_handoff_export_items_insert on public.accounting_handoff_export_items;
create policy accounting_handoff_export_items_insert
  on public.accounting_handoff_export_items for insert to authenticated
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
-- 4. TRUNCATE, TRIGGER, REFERENCES
-- -----------------------------------------------------------------------------
--
-- Supabase udeľuje novým tabuľkám v `public` ALL privileges pre
-- `authenticated`. Medzi nimi je TRUNCATE — a ten sa RLS NEPÝTA: politiky
-- sa na neho nevzťahujú vôbec. Cesta k jeho zneužitiu je dnes zatvorená
-- (PostgREST TRUNCATE nevystavuje a `authenticated` nemá CREATE v schéme,
-- takže si nevyrobí ani funkciu, ktorá by ho zavolala), ale právo, ktoré
-- nikto nepotrebuje, nemá dôvod existovať.
--
-- Rovnako TRIGGER a REFERENCES: obe sú dnes nepoužiteľné bez CREATE, obe
-- sú zbytočné.
revoke truncate, trigger, references on public.invoice_accounting_state from authenticated;
revoke truncate, trigger, references on public.accounting_handoff_exports from authenticated;
revoke truncate, trigger, references on public.accounting_handoff_export_items from authenticated;

revoke all on public.invoice_accounting_state_log from public, anon;
revoke all on public.invoice_accounting_state_log from authenticated;
grant select on public.invoice_accounting_state_log to authenticated;

comment on table public.invoice_accounting_state_log is
  'Append-only dennik zmien uctovneho stavu. Pise don vyhradne trigger; pouzivatel ma iba SELECT.';
