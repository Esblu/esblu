-- Rollback 20261008100003 (+ 20261008100002). Iba staging / po výslovnom schválení.
-- 1) esblu_invoice_finalize_compliance: znovu spustiť definíciu z 20261008100000 (10-dňové okno — nepresné, viď audit).
-- 2) Kalendár kurzov:
drop function if exists public.esblu_fx_reference_rate_date(date, text);
drop function if exists public.esblu_fx_is_publication_day(date, text);
drop function if exists public.esblu_easter_sunday(integer);
drop table if exists public.fx_rate_publication_exceptions;
-- 3) 20261008100002: esblu_my_finance_manage / esblu_my_finance_view obnoviť z 20260922100000
--    (bez väzby na aktívnu firmu; bezpečné iba vďaka indexu company_members_one_active_per_user_idx).
