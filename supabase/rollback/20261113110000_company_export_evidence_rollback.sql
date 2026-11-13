-- Rollback 20261113110000_company_export_evidence.sql
-- Odstráni bránu ukončenia a RPC. Tabuľka company_export_runs a stĺpec
-- company_terminations.export_run_id sa ZÁMERNE nemažú (auditné dôkazy).
drop trigger if exists esblu_company_termination_export_gate on public.company_terminations;
drop function if exists public.esblu_company_termination_export_gate();
drop function if exists public.esblu_company_export_fail(uuid, uuid, text);
drop function if exists public.esblu_company_export_part(uuid, uuid, uuid, integer, integer, text, integer);
drop function if exists public.esblu_company_export_begin(uuid, uuid, text, integer, integer, text);
drop function if exists public.esblu_company_export_assert_owner(uuid, uuid);
