-- =============================================================================
-- notification_deliveries — technická retencia CHAT dedupe záznamov — 2026-10-25
--
-- Tabuľka slúži VÝHRADNE na deduplikáciu pushov (unique user_id + dedupe_key).
--   kind = 'chat'     → kľúč „chat:<id správy>“. /api/push/chat-message posiela
--                        iba pre správy ≤ 5 min staré, takže po pár minútach
--                        riadok nemá žiadnu technickú funkciu. Pri veľkej firme
--                        ide o ~1 riadok na správu × príjemcu (najväčší rast).
--   kind = 'deadline' → kľúč „deadline:…:<dátum>:<okno>|overdue“; kľúč
--                        „overdue“ chráni pred opakovaným upozornením počas
--                        celej doby po termíne → tieto riadky sa NEMAŽÚ
--                        (zmazanie by znova spustilo upozornenie).
--
-- Funkcia maže iba 'chat' riadky staršie ako zadaný vek (minimum 1 deň,
-- technický default volajúceho 7 dní) po dávkach. Obsah sa tu neukladá
-- (iba user/firma/druh/kľúč), ide o operatívny cleanup, nie právnu retenciu.
-- 'deadline' retencia: OWNER/CLIA INFORMATIVE NOTE (návrh v docs), nerieši sa tu.
-- =============================================================================

create or replace function public.esblu_purge_chat_notification_deliveries(p_older_than_days integer, p_batch_size integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_days integer := greatest(coalesce(p_older_than_days, 7), 1);
  v_batch integer := least(greatest(coalesce(p_batch_size, 5000), 1), 20000);
  v_deleted integer;
begin
  delete from public.notification_deliveries d
  where d.id in (
    select x.id from public.notification_deliveries x
    where x.kind = 'chat' and x.sent_at < now() - make_interval(days => v_days)
    order by x.sent_at
    limit v_batch
  );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;
revoke all on function public.esblu_purge_chat_notification_deliveries(integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_purge_chat_notification_deliveries(integer, integer) to service_role;
