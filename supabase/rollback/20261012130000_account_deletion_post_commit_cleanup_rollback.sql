-- Rollback 20261012130000 (iba staging / po schválení). Route sa bez funkcie vráti
-- k fallbacku „legacy RPC → potom Storage" (stále DB najprv, bez retry jobu).
-- Pozor: nedokončené pending joby (Storage / auth cleanup) sa týmto stratia —
-- pred rollbackom ich spracuj (/api/cron/account-deletion-cleanup) alebo exportuj.
drop function if exists public.esblu_account_deletion_commit(text, uuid);
drop table if exists public.account_deletion_cleanup_jobs;
