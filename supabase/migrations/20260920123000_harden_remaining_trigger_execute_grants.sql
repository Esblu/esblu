-- 20260920123000_harden_remaining_trigger_execute_grants.sql
--
-- Hardening: odobratie EXECUTE práv na trigger funkciách, ktoré sú dnes
-- volateľné ako REST RPC pre anon a authenticated.
--
-- Nadväzuje na už existujúcu migráciu 20260916101800_harden_invoice_trigger_execute_grants,
-- ktorá to isté spravila pre štyri fakturačné blokovacie triggery.
-- Táto migrácia dokončuje rovnaký vzor pre zvyšných sedem.
--
-- ---------------------------------------------------------------------------
-- KONTEXT
-- ---------------------------------------------------------------------------
-- Supabase security advisor hlási `anon_security_definer_function_executable`
-- a `authenticated_security_definer_function_executable`.
--
-- Overené na produkcii 2026-09-20 dotazom nad pg_proc + has_function_privilege:
--
--   funkcia                                        anon   authenticated
--   esblu_assign_company_id                        true   true     <-- rieši táto migrácia
--   esblu_block_legal_documents_mutation           true   true     <-- rieši táto migrácia
--   esblu_create_settings_for_new_user             true   true     <-- rieši táto migrácia
--   esblu_enforce_plan_limit                       true   true     <-- rieši táto migrácia
--   esblu_lock_chat_message_identity_before_update true   true     <-- rieši táto migrácia
--   esblu_lock_company_id_on_update                true   true     <-- rieši táto migrácia
--   esblu_require_company_dpa_current              true   true     <-- rieši táto migrácia
--   esblu_block_finalized_invoice_delete           false  false    (už hardened)
--   esblu_block_finalized_invoice_items_mutation   false  false    (už hardened)
--   esblu_block_finalized_invoice_mutation         false  false    (už hardened)
--   esblu_block_invoice_snapshot_mutation          false  false    (už hardened)
--
-- ---------------------------------------------------------------------------
-- PREČO SA REVOKUJE AJ OD `public`
-- ---------------------------------------------------------------------------
-- Postgres dáva novej funkcii EXECUTE roli PUBLIC automaticky. Odobratie práva
-- len od anon a authenticated by preto v niektorých prípadoch NEMALO ŽIADNY
-- ÚČINOK — funkcia by zostala volateľná cez dedené PUBLIC právo.
--
-- Overené na produkcii 2026-09-20 (pg_proc.proacl):
--
--   esblu_block_legal_documents_mutation            "=X/postgres | ..."  <-- PUBLIC MÁ EXECUTE
--   esblu_lock_chat_message_identity_before_update  "=X/postgres | ..."  <-- PUBLIC MÁ EXECUTE
--   ostatných 5                                     PUBLIC už revokované
--
-- Cieľový stav = presne ten, ktorý majú už hardenované fakturačné triggery:
--   "postgres=X/postgres | service_role=X/postgres"
--
-- ---------------------------------------------------------------------------
-- PREČO JE TO BEZPEČNÉ
-- ---------------------------------------------------------------------------
-- Trigger funkcie NEPOTREBUJÚ EXECUTE grant pre aplikačné role. Postgres ich
-- volá v kontexte vlastníka tabuľky, nie volajúcej role. Odobratie grantu
-- teda NEROZBIJE žiadny existujúci trigger.
--
-- service_role a postgres si EXECUTE ponechávajú — zhodne s existujúcim
-- vzorom z migrácie 20260916101800.
--
-- ---------------------------------------------------------------------------
-- KLASIFIKÁCIA: hardening, NIE incident
-- ---------------------------------------------------------------------------
-- Volané mimo trigger kontextu tieto funkcie takmer isto zlyhajú (TG_OP a NEW
-- nie sú definované). Nejde teda o potvrdenú zraniteľnosť — ide o zbytočnú
-- attack surface v REST API.
--
-- Táto migrácia je zámerne SAMOSTATNÁ a nesúvisí s received-invoice blokom,
-- aby bola auditovateľná nezávisle.

begin;

revoke execute on function public.esblu_assign_company_id()
  from public, anon, authenticated;

revoke execute on function public.esblu_block_legal_documents_mutation()
  from public, anon, authenticated;

revoke execute on function public.esblu_create_settings_for_new_user()
  from public, anon, authenticated;

revoke execute on function public.esblu_enforce_plan_limit()
  from public, anon, authenticated;

revoke execute on function public.esblu_lock_chat_message_identity_before_update()
  from public, anon, authenticated;

revoke execute on function public.esblu_lock_company_id_on_update()
  from public, anon, authenticated;

revoke execute on function public.esblu_require_company_dpa_current()
  from public, anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
-- OVEROVACÍ DOTAZ (spustiť po aplikovaní — očakávaný výsledok: 0 riadkov)
-- ---------------------------------------------------------------------------
-- select p.proname,
--        has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- join pg_type t on t.oid = p.prorettype
-- where n.nspname = 'public'
--   and t.typname = 'trigger'
--   and (has_function_privilege('anon', p.oid, 'EXECUTE')
--     or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
--
-- ---------------------------------------------------------------------------
-- MIMO ROZSAH TEJTO MIGRÁCIE — vyžaduje overenie v repe
-- ---------------------------------------------------------------------------
-- Advisor hlási ako anon-executable aj tieto NE-trigger SECURITY DEFINER funkcie:
--
--   esblu_ensure_my_owner_company()
--   esblu_create_company_invite(p_email text, p_role text)
--   esblu_ensure_company_chat_channel()
--
-- Tie sa v tejto migrácii ZÁMERNE NEMENIA, pretože bez prečítania ich tela
-- nevieme potvrdiť, či už fail-closed kontrolu `auth.uid() IS NULL` obsahujú,
-- a či niektorá z nich nie je volaná legitímne pred prihlásením.
--
-- TODO pri najbližšom prístupe k repu: overiť, že každá z nich začína
-- kontrolou auth.uid() a ak áno, odobrať anon EXECUTE samostatnou migráciou.
