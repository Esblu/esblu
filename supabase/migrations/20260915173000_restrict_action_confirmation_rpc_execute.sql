begin;

-- =============================================================================
-- Esblu — nápravná migrácia: odstránenie EXECUTE práva role `anon` na
-- assistant_action_confirmations RPC funkciách (esblu_create_action_confirmation/
-- esblu_claim_action_confirmation).
-- =============================================================================
-- KONTEXT: migrácia 20260915120000_add_assistant_action_confirmations (už
-- aplikovaná produkčne, preto sa neupravuje spätne — táto je samostatná,
-- nová, čisto nápravná migrácia) obsahovala pre obe RPC funkcie:
--
--   revoke all on function ... from public;
--   grant execute on function ... to authenticated;
--
-- Po produkčnej aplikácii sa cez `aclexplode(proacl)` zistilo, že `anon`
-- napriek tomu EXECUTE MÁ. Príčina: tento Supabase projekt má na schéme
-- `public` nastavené `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON
-- FUNCTIONS TO anon, authenticated, service_role, postgres` — pri
-- `CREATE FUNCTION` teda `anon`/`authenticated` dostanú EXECUTE AUTOMATICKY,
-- priamym grantom na tieto konkrétne role (nie cez pseudo-rolu `PUBLIC`).
-- `revoke all ... from public` odoberie iba oprávnenie viazané na `PUBLIC`
-- — nedotkne sa priameho grantu, ktorý `anon`/`authenticated` už majú
-- z default privileges. Presne to isté správanie majú v tomto projekte aj
-- iné RPC (napr. esblu_accept_company_invite/esblu_my_active_company_id) —
-- `esblu_member_delete_self` je výnimka, lebo jeho revoke explicitne menuje
-- `anon, authenticated`, nie iba `public`.
--
-- REÁLNY BEZPEČNOSTNÝ DOPAD pôvodného stavu bol nízky (`auth.uid()` číta
-- `sub` z JWT, nie z Postgres role — anonymný request má `auth.uid() IS
-- NULL` bez ohľadu na rolu, takže obe RPC by aj tak zlyhali na
-- NOT_AUTHENTICATED), ale je to odchýlka od "least privilege" cieľa
-- (write-akcie WÝHRADNE pre authenticated) — táto migrácia ho opravuje.
--
-- ROZSAH (zámerne minimálny — iba privileges, nič iné):
--   - NEVYTVÁRA žiadnu novú funkciu, NEMENÍ telo/signatúru existujúcich RPC.
--   - NEMENÍ tabuľku public.assistant_action_confirmations ani jej RLS.
--   - NEMENÍ HMAC proof flow (lib/intents/action-confirmation-proof.ts,
--     lib/intents/actions.ts) — čisto DB-side privilege oprava.
--   - NEMENÍ service_role/postgres grants (tie ostávajú tak, ako boli —
--     nie sú súčasťou tohto bezpečnostného cieľa, ktorý sa týka výhradne
--     verejného/anon aplikačného prístupu).
--
-- Cieľový, deterministický finálny stav EXECUTE pre obe RPC:
--   PUBLIC        -> bez EXECUTE
--   anon          -> bez EXECUTE
--   authenticated -> MÁ EXECUTE
--   service_role/postgres -> nedotknuté (administratívne, mimo rozsahu)
-- =============================================================================

-- esblu_create_action_confirmation ------------------------------------------

-- Explicitný revoke od `anon` — TOTO je samotná oprava (predchádzajúci
-- `revoke ... from public` ho nezasiahol, pozri komentár vyššie).
revoke execute on function public.esblu_create_action_confirmation(
  text, jsonb, integer, text, text, bigint
) from anon;

-- Defense-in-depth — znovu explicitne revoke od PUBLIC (no-op, ak už bolo
-- odobraté pôvodnou migráciou, ale deterministicky garantuje rovnaký
-- výsledný stav bez ohľadu na poradie/históriu predchádzajúcich migrácií)
-- a potvrdenie GRANT pre authenticated (idempotentné — authenticated toto
-- právo už mal, tento GRANT ho iba znovu explicitne potvrdzuje).
revoke execute on function public.esblu_create_action_confirmation(
  text, jsonb, integer, text, text, bigint
) from public;

grant execute on function public.esblu_create_action_confirmation(
  text, jsonb, integer, text, text, bigint
) to authenticated;

-- esblu_claim_action_confirmation --------------------------------------------

revoke execute on function public.esblu_claim_action_confirmation(uuid)
  from anon;

revoke execute on function public.esblu_claim_action_confirmation(uuid)
  from public;

grant execute on function public.esblu_claim_action_confirmation(uuid)
  to authenticated;

commit;
