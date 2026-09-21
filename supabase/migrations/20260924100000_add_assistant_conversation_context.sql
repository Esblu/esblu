-- =============================================================================
-- 20260924100000_add_assistant_conversation_context.sql
--
-- Voice Phase 2 — krátkodobý konverzačný kontext pre viackrokové príkazy.
--
-- PREČO VÔBEC NEJAKÝ STAV
-- -----------------------
-- Doteraz bola každá požiadavka na asistenta bezstavová: jedna veta → jeden
-- intent → jedna odpoveď. To stačí na "otvor sklad", ale nie na "vytvor
-- faktúru pre Tester1", kde chýba suma aj sadzba DPH. Bez pamäte medzi
-- krokmi má asistent iba dve možnosti — odmietnuť, alebo si chýbajúce
-- hodnoty domyslieť. Prvé je neužitočné, druhé je pri fakturácii
-- neprípustné. Preto pribúda pamäť, ktorá drží PRÁVE TOĽKO, koľko treba na
-- doloženie chýbajúceho údaja, a nič navyše.
--
-- ČO SA SEM UKLADÁ A ČO NIE
-- -------------------------
-- Ukladá sa: názov rozpracovaného intentu, už vyriešené IDENTIFIKÁTORY
-- (napr. business_partners.id), štruktúrované kandidátske hodnoty
-- (množstvo, cena, sadzba, kategória DPH, mena, popis položky), zoznam
-- chýbajúcich polí a časové pečiatky.
--
-- Neukladá sa: prepis reči, obsah dokumentov, e-maily, adresy, ani NÁZVY
-- partnerov. Názov sa zakaždým dočíta z `business_partners` podľa uloženého
-- id cez bežnú RLS — kontext teda sám osebe nie je zdrojom osobných údajov
-- a keď používateľ o partnera medzitým príde, otázka sa nepoloží nad
-- neplatným menom.
--
-- Veľkosť `slots` je obmedzená CHECK-om. Nie ako mikrooptimalizácia: je to
-- poistka, aby sa sem v budúcnosti nedal "dočasne" odložiť celý transkript
-- alebo payload dokumentu. Keď to schéma fyzicky neunesie, nikto to
-- neurobí omylom.
--
-- IZOLÁCIA
-- --------
-- Kontext je viazaný na TROJICU user_id + company_id + conversation_id a
-- všetky tri sa kontrolujú vnútri SECURITY DEFINER funkcií, nie u klienta.
-- conversation_id, ktoré si klient vymyslí, teda samo osebe nič
-- neodomkne — bez zhodného auth.uid() AJ aktívnej firmy sa riadok nenájde.
-- Odhlásenie/prepnutie používateľa tým pádom kontext zneviditeľní bez
-- akejkoľvek ďalšej logiky, rovnako ako prepnutie aktívnej firmy.
--
-- ŽIVOTNOSŤ
-- ---------
-- TTL 10 minút a najviac 12 krokov. Dialóg, ktorý sa po dvanástich
-- otázkach nikam nedostal, sa nemá "snažiť ďalej" — má sa vzdať a nechať
-- používateľa začať odznova. Expirovaný riadok sa nikdy nevráti a pri
-- každom zápise sa staré riadky TOHO ISTÉHO používateľa zmažú (žiadna
-- samostatná cron úloha, ktorá by mohla prestať bežať).
--
-- ŽIADNA RLS POLICY — ZÁMERNE
-- ---------------------------
-- Rovnaký vzor ako assistant_action_confirmations (20260915120000):
-- tabuľka nemá pre authenticated/anon ani policy, ani table-level grant.
-- Jediná cesta k nej sú tri úzke SECURITY DEFINER funkcie nižšie. Tabuľka
-- s RLS a bez policy je fail-closed: keby sa granty raz omylom vrátili,
-- priamy SELECT aj tak nevráti nič.
--
-- ROLLBACK
-- --------
-- Plne aditívne. Návrat = drop troch funkcií a tabuľky; žiadne existujúce
-- dáta ani politiky sa nemenia.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Tabuľka
-- -----------------------------------------------------------------------------

create table if not exists public.assistant_conversation_contexts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,

  -- Opaque identifikátor jedného dialógu, generovaný klientom. Tvar je
  -- vynútený, aby sa doň nedal vložiť ľubovoľný reťazec.
  conversation_id text not null,

  -- Allowlist — rovnaký princíp ako intent CHECK pri potvrdeniach. Nový
  -- viackrokový príkaz musí byť dopísaný SEM, nie iba do aplikácie.
  pending_intent text not null
    check (pending_intent in ('CREATE_INVOICE_DRAFT')),

  -- Štruktúrované, aplikáciou už zvalidované kandidátske hodnoty.
  slots jsonb not null default '{}'::jsonb,

  -- Ktoré polia ešte chýbajú; poradie určuje, na čo sa asistent spýta.
  missing_fields text[] not null default '{}'::text[],

  turn_count integer not null default 0,

  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint assistant_conversation_contexts_conversation_shape
    check (conversation_id ~ '^[0-9a-f]{16,64}$'),
  constraint assistant_conversation_contexts_slots_object
    check (jsonb_typeof(slots) = 'object'),
  -- Poistka proti "odložím si sem celý transkript" (viď hlavička).
  constraint assistant_conversation_contexts_slots_bounded
    check (pg_column_size(slots) <= 4096),
  constraint assistant_conversation_contexts_missing_bounded
    check (array_length(missing_fields, 1) is null or array_length(missing_fields, 1) <= 16),
  constraint assistant_conversation_contexts_turns_bounded
    check (turn_count >= 0 and turn_count <= 12),
  constraint assistant_conversation_contexts_expires_after_created
    check (expires_at > created_at),

  -- Jeden dialóg = jeden riadok. Druhý krok ten istý riadok prepíše, takže
  -- sa nedá "nazbierať" viacero polorozpracovaných stavov jedného dialógu.
  constraint assistant_conversation_contexts_unique_dialog
    unique (user_id, company_id, conversation_id)
);

comment on table public.assistant_conversation_contexts is
  'Krátkodobý stav viackrokového hlasového/textového príkazu. Drží iba identifikátory a štruktúrované kandidátske hodnoty — nikdy transkript, obsah dokumentov ani mená osôb. Prístupný výhradne cez esblu_load/upsert/clear_conversation_context.';

create index if not exists assistant_conversation_contexts_expiry_idx
  on public.assistant_conversation_contexts (user_id, expires_at);

alter table public.assistant_conversation_contexts enable row level security;
alter table public.assistant_conversation_contexts force row level security;

revoke all on table public.assistant_conversation_contexts from authenticated, anon;

-- -----------------------------------------------------------------------------
-- 2. Načítanie
-- -----------------------------------------------------------------------------

create or replace function public.esblu_load_conversation_context(
  p_conversation_id text
)
returns table (
  pending_intent text,
  slots jsonb,
  missing_fields text[],
  turn_count integer
)
language sql
stable
security definer
set search_path to ''
as $$
  select c.pending_intent, c.slots, c.missing_fields, c.turn_count
  from public.assistant_conversation_contexts c
  where c.conversation_id = p_conversation_id
    and c.user_id = auth.uid()
    -- Aktívna firma, nie firma uložená v riadku: keď používateľ medzitým
    -- prepne firmu, rozpracovaný príkaz z tej predchádzajúcej sa nesmie
    -- dokončiť v novej.
    and c.company_id = public.esblu_my_active_company_id()
    and c.expires_at > now()
  limit 1;
$$;

comment on function public.esblu_load_conversation_context(text) is
  'Načíta rozpracovaný dialóg volajúceho. Vracia riadok iba pri zhode user_id, AKTÍVNEJ firmy aj conversation_id a iba kým neexpiroval.';

-- -----------------------------------------------------------------------------
-- 3. Zápis
-- -----------------------------------------------------------------------------

create or replace function public.esblu_upsert_conversation_context(
  p_conversation_id text,
  p_pending_intent text,
  p_slots jsonb,
  p_missing_fields text[],
  p_expires_at_epoch bigint
)
returns integer
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_company_id uuid;
  v_expires_at timestamptz;
  v_turn integer;
begin
  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null or auth.uid() is null then
    raise exception 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  -- Expirácia sa preberá od aplikácie, ale nikdy sa jej neverí naslepo:
  -- horná hranica je tvrdo 15 minút od teraz, takže ani chyba (ani
  -- priame volanie z konzoly) nevyrobí kontext, ktorý prežije deň.
  v_expires_at := to_timestamp(p_expires_at_epoch);
  if v_expires_at <= now() or v_expires_at > now() + interval '15 minutes' then
    v_expires_at := now() + interval '10 minutes';
  end if;

  -- Upratovanie bez cronu: čo expirovalo tomuto používateľovi, ide preč
  -- pri jeho najbližšom zápise.
  delete from public.assistant_conversation_contexts
  where user_id = auth.uid() and expires_at <= now();

  insert into public.assistant_conversation_contexts as c (
    user_id, company_id, conversation_id, pending_intent,
    slots, missing_fields, turn_count, expires_at
  )
  values (
    auth.uid(), v_company_id, p_conversation_id, p_pending_intent,
    coalesce(p_slots, '{}'::jsonb), coalesce(p_missing_fields, '{}'::text[]),
    1, v_expires_at
  )
  on conflict (user_id, company_id, conversation_id) do update
    set pending_intent = excluded.pending_intent,
        slots = excluded.slots,
        missing_fields = excluded.missing_fields,
        -- Počítadlo krokov riadi DB, nie aplikácia — inak by sa strop dal
        -- obísť tým, že by volajúci posielal stále 1.
        turn_count = least(c.turn_count + 1, 12),
        expires_at = v_expires_at,
        updated_at = now()
  returning c.turn_count into v_turn;

  return v_turn;
end;
$$;

comment on function public.esblu_upsert_conversation_context(text, text, jsonb, text[], bigint) is
  'Založí alebo prepíše rozpracovaný dialóg volajúceho v jeho AKTÍVNEJ firme. Počítadlo krokov a expiráciu riadi databáza, nie volajúci. Vracia aktuálny počet krokov.';

-- -----------------------------------------------------------------------------
-- 4. Zrušenie
-- -----------------------------------------------------------------------------

create or replace function public.esblu_clear_conversation_context(
  p_conversation_id text
)
returns void
language sql
volatile
security definer
set search_path to ''
as $$
  delete from public.assistant_conversation_contexts
  where conversation_id = p_conversation_id
    and user_id = auth.uid()
    and company_id = public.esblu_my_active_company_id();
$$;

comment on function public.esblu_clear_conversation_context(text) is
  'Zruší rozpracovaný dialóg. Volá sa po dokončení príkazu — vďaka tomu sa hotový dialóg nedá zopakovať druhýkrát.';

-- -----------------------------------------------------------------------------
-- 5. Granty
-- -----------------------------------------------------------------------------

revoke all on function public.esblu_load_conversation_context(text) from public, anon;
revoke all on function public.esblu_upsert_conversation_context(text, text, jsonb, text[], bigint) from public, anon;
revoke all on function public.esblu_clear_conversation_context(text) from public, anon;

grant execute on function public.esblu_load_conversation_context(text) to authenticated;
grant execute on function public.esblu_upsert_conversation_context(text, text, jsonb, text[], bigint) to authenticated;
grant execute on function public.esblu_clear_conversation_context(text) to authenticated;

commit;
