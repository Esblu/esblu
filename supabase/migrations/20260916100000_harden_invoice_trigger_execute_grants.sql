-- Fáza 2 — Fakturačné jadro: defense-in-depth hardening
--
-- Supabase security advisor (po aplikovaní migrácií add_invoicing_core_schema
-- a add_invoicing_core_rpc) nahlásil, že štyri nové trigger funkcie sú
-- vystavené ako priamo volateľné RPC pre `anon`/`authenticated`
-- (anon_security_definer_function_executable /
-- authenticated_security_definer_function_executable), pretože Postgres
-- pri SECURITY DEFINER funkciách štandardne udeľuje EXECUTE rolke PUBLIC,
-- ak nie je explicitne odvolané.
--
-- Tieto štyri funkcie sú výhradne trigger funkcie (majú fungovať iba
-- v kontexte trigger volania cez OLD/NEW/TG_OP) a nikdy nemajú byť
-- volané priamo cez PostgREST RPC. Priame volanie by dnes bolo neškodné
-- (funkcie by len vyhodili svoju hardkódovanú výnimku, keďže mimo
-- trigger kontextu TG_OP neexistuje), ale v súlade s existujúcim
-- bezpečnostným vzorom tohto kódu (viď esblu_finalize_invoice,
-- esblu_add_invoice_payment, esblu_remove_invoice_payment vyššie v
-- add_invoicing_core_rpc.sql) im explicitne odoberáme EXECUTE od
-- public/anon/authenticated. Postgres nedovoľuje odobrať EXECUTE trigger
-- funkcii, ktorá by tým prestala fungovať ako trigger — triggery
-- pristupujú k funkcii cez vlastníka/systémový mechanizmus, nie cez
-- rolku volajúceho, takže toto odobratie nijako neovplyvní existujúce
-- triggery zadefinované v add_invoicing_core_schema.sql.

revoke execute on function public.esblu_block_finalized_invoice_mutation() from public;
revoke execute on function public.esblu_block_finalized_invoice_mutation() from anon;
revoke execute on function public.esblu_block_finalized_invoice_mutation() from authenticated;

revoke execute on function public.esblu_block_finalized_invoice_delete() from public;
revoke execute on function public.esblu_block_finalized_invoice_delete() from anon;
revoke execute on function public.esblu_block_finalized_invoice_delete() from authenticated;

revoke execute on function public.esblu_block_finalized_invoice_items_mutation() from public;
revoke execute on function public.esblu_block_finalized_invoice_items_mutation() from anon;
revoke execute on function public.esblu_block_finalized_invoice_items_mutation() from authenticated;

revoke execute on function public.esblu_block_invoice_snapshot_mutation() from public;
revoke execute on function public.esblu_block_invoice_snapshot_mutation() from anon;
revoke execute on function public.esblu_block_invoice_snapshot_mutation() from authenticated;
