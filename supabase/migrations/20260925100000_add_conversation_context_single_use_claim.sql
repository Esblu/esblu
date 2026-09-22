-- =============================================================================
-- 20260925100000_add_conversation_context_single_use_claim.sql
--
-- Jednorazové uplatnenie rozpracovaného dialógu — ochrana proti duplicitnému
-- dokladu.
--
-- PREČO
-- -----
-- Doterajší tok dialóg po dokončení ZMAZAL, a to až PO vytvorení draftu:
--
--     load  →  vytvor draft  →  clear
--
-- Medzi prvým a tretím krokom je okno. Keď v ňom dorazí druhá požiadavka s
-- tým istým conversationId — klient zopakoval volanie, spadla a obnovila sa
-- sieť, používateľ ťukol dvakrát — obe nájdu kontext ešte nedotknutý a obe
-- vytvoria doklad. Vzniknú dve faktúry na to isté.
--
-- Zamykanie tlačidla v UI to nerieši: opakovanie prichádza zo siete, nie z
-- prsta.
--
-- RIEŠENIE
-- --------
-- Rovnaký vzor, aký appka už používa pri potvrdzovaní rizikových akcií
-- (`esblu_claim_action_confirmation`, migrácia 20260915120000): pribúda
-- `consumed_at` a jedna funkcia, ktorá riadok atomicky označí za
-- spotrebovaný a vráti jeho obsah:
--
--     UPDATE ... WHERE consumed_at IS NULL RETURNING ...
--
-- Pri dvoch súbežných požiadavkách nájde riadok s `consumed_at IS NULL`
-- práve jedna; druhá dostane nula riadkov a doklad nevytvorí. To isté
-- platí pre opakovanie, ktoré príde o minútu neskôr — `consumed_at` je už
-- nastavené.
--
-- Poradie v aplikácii sa tým obracia na:
--
--     claim (atomicky)  →  vytvor draft
--
-- Keď claim neuspeje, nevytvára sa nič.
--
-- PREČO SA RIADOK MAŽE NESKÔR, A NIE HNEĎ
-- ---------------------------------------
-- Zmazanie by fungovalo proti súbežnosti, ale nie proti opakovaniu po
-- čase: prázdne miesto sa nedá odlíšiť od dialógu, ktorý nikdy neexistoval,
-- a upsert by ho jednoducho vytvoril znova. Spotrebovaný riadok si pamätá,
-- že príkaz už bol vybavený. Zmizne sám pri najbližšom upratovaní
-- expirovaných riadkov.
--
-- ROLLBACK
-- --------
-- Aditívne. Návrat = `drop function esblu_claim_conversation_context` a
-- `alter table ... drop column consumed_at`. Žiadne existujúce dáta ani
-- politiky sa nemenia; tabuľka je aj tak krátkodobá.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Stĺpec
-- -----------------------------------------------------------------------------

alter table public.assistant_conversation_contexts
  add column if not exists consumed_at timestamptz;

comment on column public.assistant_conversation_contexts.consumed_at is
  'Kedy bol dialóg uplatnený (vznikol z neho doklad). Nenulová hodnota znamená, že sa už uplatniť nedá — ochrana proti duplicitnému dokladu pri zopakovanej požiadavke.';

-- -----------------------------------------------------------------------------
-- 2. Načítanie ignoruje spotrebované dialógy
-- -----------------------------------------------------------------------------
--
-- Bez tejto úpravy by sa spotrebovaný dialóg naďalej načítal a používateľ
-- by dostával otázky z príkazu, ktorý už bol vybavený.

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
    and c.consumed_at is null
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- 3. Atomické uplatnenie
-- -----------------------------------------------------------------------------

create or replace function public.esblu_claim_conversation_context(
  p_conversation_id text
)
returns table (
  pending_intent text,
  slots jsonb,
  missing_fields text[],
  turn_count integer
)
language sql
volatile
security definer
set search_path to ''
as $$
  update public.assistant_conversation_contexts c
     set consumed_at = now(),
         updated_at = now()
   where c.conversation_id = p_conversation_id
     and c.user_id = auth.uid()
     and c.company_id = public.esblu_my_active_company_id()
     and c.expires_at > now()
     and c.consumed_at is null
  returning c.pending_intent, c.slots, c.missing_fields, c.turn_count;
$$;

comment on function public.esblu_claim_conversation_context(text) is
  'Atomicky označí rozpracovaný dialóg za uplatnený a vráti jeho obsah. Pri dvoch súbežných alebo zopakovaných požiadavkách uspeje práve jedna — ochrana proti duplicitnému dokladu. Rovnaký vzor ako esblu_claim_action_confirmation.';

-- -----------------------------------------------------------------------------
-- 4. Granty
-- -----------------------------------------------------------------------------

revoke all on function public.esblu_claim_conversation_context(text) from public, anon;
grant execute on function public.esblu_claim_conversation_context(text) to authenticated;

commit;
