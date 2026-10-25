-- Rollback 20261025100000_ai_usage_metering.sql
-- Odstráni usage telemetriu (počítadlá sa tým ZMAŽÚ — iba technická telemetria, žiadne obchodné dáta).
drop function if exists public.esblu_purge_ai_usage_monthly(integer);
drop function if exists public.esblu_record_ai_usage_for_reservation(uuid, text, text, text, bigint, bigint, bigint, integer, integer);
drop function if exists public.esblu_record_ai_usage(uuid, uuid, text, text, text, bigint, bigint, bigint, bigint, numeric, integer, integer);
drop table if exists public.ai_usage_monthly;
