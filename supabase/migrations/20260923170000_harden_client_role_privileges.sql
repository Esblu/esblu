-- =============================================================================
-- Minimálne SQL privilégiá pre klientské role.
--
-- ČO SA NAŠLO
-- -----------
-- Roly `anon` a `authenticated` mali na väčšine tabuliek v `public` VŠETKY
-- privilégiá vrátane TRUNCATE, TRIGGER a REFERENCES. Na 24 tabuľkách —
-- medzi nimi `invoices`, `invoice_items` a `documents` — ich mala aj
-- `anon`, teda NEPRIHLÁSENÝ návštevník.
--
-- PREČO TO NIE JE JEDNO, KEĎ MÁME RLS
-- -----------------------------------
-- TRUNCATE sa row-level security NEPÝTA. Politiky sa naň nevzťahujú vôbec:
-- kto má právo TRUNCATE, vyprázdni tabuľku bez ohľadu na to, čo hovoria
-- politiky. RLS teda toto právo nechráni a nikdy nechránila.
--
-- Dnes tá cesta nie je otvorená: PostgREST TRUNCATE nevystavuje a ani
-- `anon`, ani `authenticated` nemá CREATE v schéme, takže si nevyrobí
-- funkciu, ktorá by ho zavolala. Je to však jediná vrstva, ktorá medzi
-- návštevníkom a prázdnou tabuľkou stojí — a je to vrstva, ktorú
-- nevlastníme my, ale PostgREST. Právo, ktoré nikto nepotrebuje, nemá mať
-- kto zneužiť.
--
-- ODKIAĽ SA TO BRALO
-- ------------------
-- ALTER DEFAULT PRIVILEGES pre rolu `postgres` v schéme `public`:
--   anon=arwdDxtm, authenticated=arwdDxtm
-- (a = INSERT, r = SELECT, w = UPDATE, d = DELETE, D = TRUNCATE,
--  x = REFERENCES, t = TRIGGER, m = MAINTAIN)
--
-- Migrácie bežia ako `postgres`, takže KAŽDÁ nová tabuľka tieto práva
-- dostala automaticky. Opraviť iba dnešné tabuľky by znamenalo, že o
-- mesiac je problém späť — preto sa mení aj predvolené nastavenie.
--
-- ČO SA NEMENÍ
-- ------------
-- SELECT/INSERT/UPDATE/DELETE pre `authenticated` zostávajú presne také,
-- aké boli. Táto migrácia nemení ANI JEDNU politiku a nemení správanie
-- žiadnej podporovanej operácie — iba odoberá práva, ktoré appka
-- nepoužíva.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Existujúce tabuľky
-- -----------------------------------------------------------------------------
--
-- Prechádza sa dynamicky, nie zoznamom mien. Zoznam by sa pri ďalšej
-- tabuľke rozišiel so skutočnosťou a nikto by si to nevšimol.
do $$
declare
  t record;
begin
  for t in
    select c.oid::regclass as ident
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by c.relname
  loop
    -- `authenticated`: ponechať DML, odobrať schémové práva.
    execute format(
      'revoke truncate, references, trigger, maintain on %s from authenticated',
      t.ident
    );

    -- `anon`: neprihlásený nemá v tejto aplikácii čo zapisovať. Jediná
    -- politika, ktorá `anon` čokoľvek dovoľuje, je legal_documents_select_all;
    -- všetky ostatné sa opierajú o auth.uid(), ktoré je pre `anon` NULL.
    -- Funkcie, ktoré `anon` volá (pozvánky, právne dokumenty), sú všetky
    -- SECURITY DEFINER so `search_path=''`, takže na tabuľkové práva
    -- volajúceho nesiahajú.
    execute format(
      'revoke insert, update, delete, truncate, references, trigger, maintain on %s from anon',
      t.ident
    );
  end loop;
end $$;

-- Jediné čítanie, ktoré neprihlásený naozaj potrebuje: verejné znenia
-- právnych dokumentov. Má na ne aj vlastnú politiku, takže sa tu nič
-- nevymýšľa — iba sa to nechá tak, ako to bolo zamýšľané.
revoke select on all tables in schema public from anon;
grant select on public.legal_documents to anon;

-- -----------------------------------------------------------------------------
-- 2. Budúce tabuľky
-- -----------------------------------------------------------------------------
--
-- Bez tohto kroku by nasledujúca migrácia vrátila stav do pôvodného bodu.
-- Mení sa predvoľba pre rolu `postgres`, pod ktorou migrácie bežia.
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from authenticated;

alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger, maintain on tables from anon;

-- Ani SELECT. Neprihlásený nemá mať prístup k novej tabuľke len preto, že
-- vznikla; keď ho niekedy potrebovať bude, udelí sa mu výslovne a bude to
-- v migrácii vidieť.
alter default privileges for role postgres in schema public
  revoke select on tables from anon;

-- Poznámka k predvoľbe pre `supabase_admin`: existuje rovnaká a mení sa
-- iba spod tej role, ktorej patrí. `postgres` jej členom nie je, takže sa
-- odtiaľto zmeniť nedá. Tabuľky Esblu vznikajú pod `postgres`, takže na
-- ne nemá vplyv; ak by niekedy vznikla tabuľka pod `supabase_admin`,
-- privilégiá treba nastaviť výslovne.

comment on schema public is
  'Klientske role maju minimalne prava: authenticated DML podla RLS, anon iba SELECT na legal_documents. TRUNCATE/TRIGGER/REFERENCES/MAINTAIN odobrate — TRUNCATE sa RLS nepyta.';
