-- =============================================================================
-- 20260920150000_harden_finalized_invoice_immutability.sql
--
-- HARDENING: immutabilita finalizovanej faktúry prestáva byť zoznam stĺpcov
-- a stáva sa deny-by-default pravidlom.
--
-- NÁLEZ
-- -----
-- esblu_block_finalized_invoice_mutation() porovnávala OLD/NEW cez ručne
-- vypísaný zoznam stĺpcov. Ten zoznam vznikol v migrácii 20260916095000 a
-- odvtedy zaostal za schémou. Audit všetkých 40 stĺpcov public.invoices
-- ukázal, že po finalizácii boli voľne meniteľné:
--
--   buyer_reference            EN16931 BT-10  (20260920122000)
--   purchase_order_reference   EN16931 BT-13  (20260920122000)
--   payment_means_code         EN16931 BT-81  (20260920122000)
--   payment_reference          EN16931 BT-83  (20260920122000)
--
-- Všetky štyri sú fakturačný obsah, ktorý ide do EN16931/UBL výstupu —
-- payment_reference je dokonca canonical náprotivok variable_symbol, teda
-- údaj, podľa ktorého sa páruje platba. Tichá zmena ktoréhokoľvek z nich na
-- uzavretom účtovnom doklade je presne to, čomu má immutabilita brániť.
--
-- Predchádzajúca migrácia (20260920140000) doplnila supplier_*/received_at/
-- dedupe_fingerprint/transport_* — čiže zoznam driftoval už druhýkrát. To je
-- systémová chyba návrhu, nie jednotlivé opomenutie: allowlist rastie sám,
-- denylist treba pri každom ALTER TABLE ručne dopísať a nič na to neupozorní.
--
-- OPRAVA
-- ------
-- Trigger sa obracia naopak. Namiesto „tieto stĺpce sa nesmú meniť" platí
-- „NIČ sa nesmie meniť okrem výslovne povoleného post-finalization metadata
-- setu". Porovnáva sa to_jsonb(OLD) vs to_jsonb(NEW), takže každý stĺpec
-- pridaný v budúcnosti je automaticky immutable bez ďalšej migrácie.
--
-- POVOLENÉ PO FINALIZÁCII (a prečo)
-- ---------------------------------
--   payment_status  Platby sú samostatný, zámerne oddelený post-finalization
--                   lifecycle (bod 4 hlavičky migrácie 20260916094000).
--                   Prepisuje ho výhradne esblu_add_invoice_payment() /
--                   esblu_remove_invoice_payment() (SECURITY DEFINER) —
--                   klientský UPDATE je odrezaný RLS politikou
--                   invoices_update_finance_draft (USING vyžaduje
--                   document_status='draft'). Payment model sa NEMENÍ.
--   updated_at      Audit metadáta, ktoré tie isté dve payment RPC zapisujú
--   updated_by      v rovnakom UPDATE. Bez nich by platba neprešla.
--
-- Nič iné. id, company_id, sumy, dátumy, strany, čísla dokladu, dedupe/
-- transport kľúče, EN16931 polia, created_*/finalized_* — všetko zamknuté.
--
-- ROZSAH
-- ------
-- Jedna CREATE OR REPLACE FUNCTION. Žiadna zmena schémy, dát, RLS, payment
-- modelu ani ostatných triggerov. Trigger esblu_invoices_immutability_guard
-- sa NEODSTRAŇUJE ani nevytvára nanovo — CREATE OR REPLACE zachová jeho
-- naviazanie, takže neexistuje okno, v ktorom by tabuľka bola nechránená.
--
-- Ostatné vrstvy overené auditom a ponechané bez zmeny:
--   invoice_items            esblu_block_finalized_invoice_items_mutation()
--                            blokuje INSERT/UPDATE/DELETE pri finalized rodičovi
--   invoice_parties          esblu_block_invoice_snapshot_mutation()
--   invoice_tax_breakdowns   blokuje každý UPDATE/DELETE bezpodmienečne
--   invoices DELETE          esblu_block_finalized_invoice_delete()
-- =============================================================================

begin;

create or replace function public.esblu_block_finalized_invoice_mutation()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  -- Jediné stĺpce, ktoré smú po finalizácii zmeniť hodnotu. Rozširovať tento
  -- zoznam znamená rozhodnúť, že daný údaj NIE JE súčasťou uzavretého
  -- účtovného dokladu — to je architektonické rozhodnutie, nie údržba.
  v_allowed constant text[] := array['payment_status', 'updated_at', 'updated_by'];
  v_changed text;
begin
  -- Draft faktúra sa edituje voľne — a táto vetva zároveň znamená, že bežná
  -- práca s konceptom neplatí nič za jsonb porovnanie nižšie.
  if OLD.document_status <> 'finalized' then
    return NEW;
  end if;

  -- Deny-by-default: nájdi KAŽDÝ stĺpec, ktorý zmenil hodnotu a nie je
  -- výslovne povolený. to_jsonb(OLD) a to_jsonb(NEW) majú vždy identickú
  -- množinu kľúčov (ten istý rowtype), takže stačí prejsť OLD a dohľadať
  -- náprotivok v NEW.
  select string_agg(k.key, ', ' order by k.key)
    into v_changed
  from jsonb_each(to_jsonb(OLD)) k
  where not (k.key = any (v_allowed))
    and k.value is distinct from (to_jsonb(NEW) -> k.key);

  if v_changed is not null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVOICE_FINALIZED_IMMUTABLE',
      hint = 'Finalizovaná faktúra je immutable okrem payment_status (cez '
             || 'esblu_add_invoice_payment/esblu_remove_invoice_payment) a audit '
             || 'metadát. Pokus o zmenu: ' || v_changed || '.';
  end if;

  return NEW;
end;
$function$;

comment on function public.esblu_block_finalized_invoice_mutation() is
  'Deny-by-default immutabilita finalizovanej faktúry. Po document_status=''finalized'' smie zmeniť hodnotu VÝHRADNE payment_status + updated_at/updated_by (kontrolovaný payment lifecycle cez esblu_add_invoice_payment/esblu_remove_invoice_payment). Každý iný stĺpec — vrátane stĺpcov pridaných budúcimi migráciami — je automaticky zamknutý, bez nutnosti tento trigger aktualizovať. Nahrádza pôvodný ručný denylist, ktorý dvakrát zaostal za schémou (naposledy EN16931 P1 polia buyer_reference/purchase_order_reference/payment_means_code/payment_reference).';

-- Trigger funkcia nie je určená na priame volanie nikým.
revoke execute on function public.esblu_block_finalized_invoice_mutation() from public;
revoke execute on function public.esblu_block_finalized_invoice_mutation() from anon;
revoke execute on function public.esblu_block_finalized_invoice_mutation() from authenticated;

commit;
