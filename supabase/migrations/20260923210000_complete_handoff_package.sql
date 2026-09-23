-- =============================================================================
-- ÚPLNÝ BALÍK PRE ÚČTOVNÍKA: evidencia, ktorá prežije aj zmazanie dokladu
--
-- ČO TU BOLO
-- ----------
-- `accounting_handoff_exports` vedelo zaznamenať, že si niekto stiahol zošit
-- s údajmi: kto, kedy, koľko dokladov, odtlačok súboru. `export_kind` už
-- pozná hodnotu 'complete_package', ale nič ju nikdy nezapísalo — úplný balík
-- neexistoval.
--
-- Chýbali aj polia, bez ktorých sa úplný balík nedá evidovať poctivo: stav
-- (podarilo sa / nepodarilo), názov a veľkosť balíka, počet súborov, verzia
-- schémy manifestu, čas dokončenia, dôvod zlyhania.
--
-- DRUHÁ VEC, HORŠIA
-- -----------------
-- `accounting_handoff_export_items.invoice_id` malo FOREIGN KEY ... ON DELETE
-- CASCADE. Zmazanie faktúry by teda ticho zmazalo aj riadok, ktorý hovorí, že
-- tá faktúra bola odovzdaná účtovníkovi.
--
-- To je presne naopak, než ako má evidencia fungovať. Dôkaz o odovzdaní má
-- zmysel práve vtedy, keď prevádzková kópia dokladu už v Esblu nie je — to
-- je celý dôvod, prečo sa vedie. Keby zmiznul spolu s dokladom, nedokazoval
-- by nič.
--
-- Riešenie je najmenšie možné: riadok dostane vlastný kľúč, odkaz na faktúru
-- sa pri jej zmazaní vynuluje namiesto zmazania riadku, a to podstatné —
-- číslo dokladu, smer, dátum, suma, mena — sa do riadku odpíše ako snímka.
-- Po zmazaní faktúry teda zostane veta „doklad FA20260001 zo 16. 9. 2026 na
-- 369,00 EUR bol súčasťou balíka X", aj keď samotná faktúra už neexistuje.
--
-- MAZANIE SA TU NEZAVÁDZA. Táto migrácia iba zaisťuje, že keby sa raz
-- zavádzalo, dôkaz o odovzdaní to prežije.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Záznam o exporte: polia pre úplný balík
--
-- Všetko nullable alebo s predvolenou hodnotou — existujúci riadok o exporte
-- údajov zostáva platný a nič sa v ňom neprepisuje.
-- -----------------------------------------------------------------------------

alter table public.accounting_handoff_exports
  add column if not exists status text not null default 'completed',
  add column if not exists package_filename text,
  add column if not exists package_bytes bigint,
  add column if not exists package_sha256 text,
  add column if not exists file_count integer,
  add column if not exists manifest_schema_version text,
  add column if not exists completed_at timestamptz,
  add column if not exists failure_reason text,
  add column if not exists app_commit text;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid='public.accounting_handoff_exports'::regclass
                   and conname='accounting_handoff_exports_status_check') then
    alter table public.accounting_handoff_exports
      add constraint accounting_handoff_exports_status_check
      check (status in ('completed','failed'));
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid='public.accounting_handoff_exports'::regclass
                   and conname='accounting_handoff_exports_package_sha_check') then
    alter table public.accounting_handoff_exports
      add constraint accounting_handoff_exports_package_sha_check
      check (package_sha256 is null or package_sha256 ~ '^[0-9a-f]{64}$');
  end if;

  -- Úplný balík sa nesmie zaznamenať ako úspešný bez toho, čo ho robí
  -- overiteľným. Buď je tam odtlačok, názov, veľkosť a čas dokončenia,
  -- alebo to nie je hotový balík. Databáza to drží nezávisle od appky.
  if not exists (select 1 from pg_constraint
                 where conrelid='public.accounting_handoff_exports'::regclass
                   and conname='accounting_handoff_exports_complete_package_fields') then
    alter table public.accounting_handoff_exports
      add constraint accounting_handoff_exports_complete_package_fields
      check (
        export_kind <> 'complete_package'
        or status <> 'completed'
        or (package_sha256 is not null
            and package_filename is not null
            and package_bytes is not null
            and file_count is not null
            and manifest_schema_version is not null
            and completed_at is not null)
      );
  end if;

  -- Neúspešný pokus musí povedať prečo.
  if not exists (select 1 from pg_constraint
                 where conrelid='public.accounting_handoff_exports'::regclass
                   and conname='accounting_handoff_exports_failure_reason') then
    alter table public.accounting_handoff_exports
      add constraint accounting_handoff_exports_failure_reason
      check (status <> 'failed' or failure_reason is not null);
  end if;
end $$;

comment on column public.accounting_handoff_exports.status is
  'completed = balík/zošit naozaj vznikol a bol overený; failed = pokus, ktorý sa nedokončil. Neúspešný pokus sa zaznamenáva tiež — je to súčasť histórie, nie odpad.';
comment on column public.accounting_handoff_exports.package_sha256 is
  'SHA-256 celého ZIP súboru. manifest_sha256 je odtlačok manifest.json vnútri neho — dva rôzne odtlačky, pozri lib/invoicing/handoff-package.ts.';

-- -----------------------------------------------------------------------------
-- 2. Položky exportu: snímka namiesto závislosti na faktúre
--
-- Postupnosť je zámerná: najprv nový kľúč, potom nový cudzí kľúč, až potom
-- odpísanie snímky. Keby sa to spustilo dvakrát, každý krok sa preskočí.
-- -----------------------------------------------------------------------------

alter table public.accounting_handoff_export_items
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists invoice_number_snapshot text,
  add column if not exists supplier_invoice_number_snapshot text,
  add column if not exists direction_snapshot text,
  add column if not exists issue_date_snapshot date,
  add column if not exists total_amount_snapshot numeric(18,2),
  add column if not exists currency_snapshot text,
  add column if not exists artifact_count integer;

do $$
begin
  -- Vlastný primárny kľúč. Bez neho sa invoice_id nedá vynulovať.
  if exists (select 1 from pg_constraint
             where conrelid='public.accounting_handoff_export_items'::regclass
               and conname='accounting_handoff_export_items_pkey'
               and pg_get_constraintdef(oid) like 'PRIMARY KEY (export_id, invoice_id)%') then
    alter table public.accounting_handoff_export_items
      drop constraint accounting_handoff_export_items_pkey;
    alter table public.accounting_handoff_export_items
      add constraint accounting_handoff_export_items_pkey primary key (id);
  end if;

  -- Jedna faktúra sa v jednom exporte smie objaviť raz. Vynulované odkazy
  -- (po zmazaní faktúry) sa neporovnávajú — preto čiastočný index.
  if not exists (select 1 from pg_class where relname='accounting_handoff_export_items_uniq') then
    create unique index accounting_handoff_export_items_uniq
      on public.accounting_handoff_export_items (export_id, invoice_id)
      where invoice_id is not null;
  end if;

  -- CASCADE → SET NULL. Toto je jadro opravy.
  if exists (select 1 from pg_constraint
             where conrelid='public.accounting_handoff_export_items'::regclass
               and conname='accounting_handoff_export_items_invoice_id_fkey'
               and pg_get_constraintdef(oid) like '%ON DELETE CASCADE%') then
    alter table public.accounting_handoff_export_items
      drop constraint accounting_handoff_export_items_invoice_id_fkey;
    alter table public.accounting_handoff_export_items
      alter column invoice_id drop not null;
    alter table public.accounting_handoff_export_items
      add constraint accounting_handoff_export_items_invoice_id_fkey
      foreign key (invoice_id) references public.invoices(id) on delete set null;
  end if;
end $$;

-- Existujúce riadky snímku nemajú (vznikli pred touto migráciou). Doplní sa
-- z faktúry, ktorá stále existuje — nie je to prepis histórie, iba zapísanie
-- toho, čo v tej chvíli platilo. Riadky bez faktúry sa nedotknú.
update public.accounting_handoff_export_items it
set invoice_number_snapshot = i.invoice_number,
    supplier_invoice_number_snapshot = i.supplier_invoice_number,
    direction_snapshot = i.direction,
    issue_date_snapshot = i.issue_date,
    total_amount_snapshot = i.total_amount,
    currency_snapshot = i.currency
from public.invoices i
where it.invoice_id = i.id
  and it.direction_snapshot is null;

comment on table public.accounting_handoff_export_items is
  'Ktoré doklady boli v ktorom odovzdaní. Riadok prežije zmazanie faktúry: invoice_id sa vynuluje a snímka (číslo, smer, dátum, suma, mena) zostane. Dôkaz o odovzdaní má zmysel práve vtedy, keď doklad v Esblu už nie je.';

-- -----------------------------------------------------------------------------
-- 3. História sa neprepisuje
--
-- Na oboch tabuľkách existuje politika SELECT (finance.view) a INSERT
-- (finance.manage). UPDATE ani DELETE politika neexistuje, takže cez RLS sa
-- záznam o odovzdaní nedá ani zmeniť, ani zmazať — a tak to má zostať.
-- Explicitne odoberáme aj tabuľkové privilégiá, aby to nezáviselo len na
-- neprítomnosti politiky.
-- -----------------------------------------------------------------------------

revoke update, delete on public.accounting_handoff_exports from authenticated;
revoke update, delete on public.accounting_handoff_export_items from authenticated;
