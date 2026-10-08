-- =============================================================================
-- Idempotentné vytváranie záznamov (Mobile Platform, 2026-10-08).
--
-- STAV: STAGING ONLY. Aplikovať na esblu-test (cjbdijbbcujvmrzezusd); na
-- produkciu fkpgvgvsmbpieduoatrt IBA s výslovným súhlasom.
-- Rollback: supabase/rollback/20261008130000_client_mutation_idempotency_rollback.sql
--
-- PROBLÉM: mobilná sieť stratí odpoveď → klient zopakuje insert → druhý záznam
-- (faktúra, partner, vozidlo, stroj, sklad, priečinok, chat správa).
--
-- RIEŠENIE (server-side, tenant-scoped):
--   - klient pošle `client_mutation_id` (UUID vygenerovaný pre JEDEN logický
--     pokus o vytvorenie; pri retry rovnaký, pri inom obsahu nový —
--     lib/idempotent-insert.ts),
--   - čiastočný UNIQUE index (company_id, client_mutation_id) — druhý insert
--     s tým istým kľúčom v tej istej firme zlyhá 23505 (aj pri súbehu: druhá
--     transakcia čaká na prvú a potom dostane 23505), klient si existujúci
--     záznam prečíta cez RLS a vráti ho ako úspech (replay),
--   - iná firma s rovnakým UUID nekoliduje (company_id v indexe), takže kľúč
--     nedokáže nič prezradiť ani zablokovať naprieč tenantmi,
--   - NULL = staré klienty / server cesty bez kľúča → správanie nezmenené.
--
-- ČISTO ADITÍVNE: nový nullable stĺpec + index. RLS, politiky, granty
-- (tabuľkové INSERT/UPDATE pre authenticated už stĺpec pokrývajú), triggre
-- a business pravidlá sa NEMENIA — RLS ostáva jediná autorita.
-- Idempotentné (if not exists).
-- =============================================================================

do $migration$
declare
  t text;
begin
  foreach t in array array['invoices', 'business_partners', 'vehicles', 'machines', 'inventory_items', 'document_folders', 'chat_messages']
  loop
    if to_regclass('public.' || t) is null then
      raise exception 'client_mutation_idempotency: chýba tabuľka public.%', t;
    end if;
    execute format('alter table public.%I add column if not exists client_mutation_id uuid null', t);
    execute format(
      'create unique index if not exists %I on public.%I (company_id, client_mutation_id) where client_mutation_id is not null',
      t || '_client_mutation_uidx', t);
    execute format(
      'comment on column public.%I.client_mutation_id is %L', t,
      'Idempotency kľúč klienta (UUID jedného logického vytvorenia). Unikátny v rámci firmy; retry s tým istým kľúčom nevytvorí druhý záznam.');
  end loop;
end
$migration$;
