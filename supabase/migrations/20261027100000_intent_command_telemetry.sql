-- =============================================================================
-- Intent command telemetry (J8 intent fallback cost optimization) — 2026-10-27
--
-- Cieľ: merať, koľko príkazov asistenta vyrieši deterministický parser a
-- koľko ide na platený AI fallback — na FIRMU a MESIAC — v EXISTUJÚCEJ
-- tabuľke ai_usage_monthly (20261025100000). Žiadna nová tabuľka, žiadna
-- zmena produktu, žiadny limit.
--
-- Tvar: flow_type = 'intent_command', model = trieda spracovania:
--   deterministic  — parser / rozpracovaná úloha, bez AI
--   ai-fallback    — zavolaný AI klasifikátor (outcome = či niečo rozpoznal)
--   unsupported    — odmietnuté / nerozpoznané BEZ AI (zápor, mimo domény,
--                    nepodporovaný zápis)
--   ambiguous      — výsledkom je otázka na upresnenie
-- outcome = success (rozpoznané) | failure. requests = počet príkazov.
-- intent_commands_total = súčet requests pre flow 'intent_command'.
--
-- GDPR: ACCESS / COST TELEMETRY ONLY — NO CONTENT LOGGING. Neukladá sa text
-- príkazu, prepis, prompt, odpoveď modelu, entita, ŠPZ ani user_id
-- (p_user_id slúži iba na overenie členstva).
--
-- Prístup: service-only (trieda D) ako zvyšok ai_usage_monthly.
-- =============================================================================

alter table public.ai_usage_monthly drop constraint if exists ai_usage_monthly_flow_check;
alter table public.ai_usage_monthly add constraint ai_usage_monthly_flow_check check (flow_type in (
  'document_scan',
  'document_scan_plate_fallback',
  'vehicle_document_scan',
  'vehicle_document_plate_fallback',
  'vehicle_registration_scan',
  'voice_transcription',
  'intent_classification_fallback',
  'intent_command'
));

-- Vráti true = započítané, false = odmietnuté (fail closed: neznáma trieda,
-- neznámy výsledok, používateľ nie je aktívny člen danej firmy).
-- esblu_record_ai_usage ostáva bez zmeny — 'intent_command' cezň nejde.
create or replace function public.esblu_record_intent_command(
  p_company_id uuid,
  p_user_id uuid,
  p_route_class text,
  p_outcome text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_month date := (date_trunc('month', now()))::date;
begin
  if p_company_id is null or p_user_id is null then
    return false;
  end if;
  if p_route_class is null or p_route_class not in ('deterministic', 'ai-fallback', 'unsupported', 'ambiguous') then
    return false;
  end if;
  if p_outcome is null or p_outcome not in ('success', 'failure') then
    return false;
  end if;
  if not exists (
    select 1 from public.company_members cm
    where cm.company_id = p_company_id and cm.user_id = p_user_id and cm.status = 'active'
  ) then
    return false;
  end if;

  insert into public.ai_usage_monthly as u (company_id, period_month, flow_type, model, outcome, requests)
  values (p_company_id, v_month, 'intent_command', p_route_class, p_outcome, 1)
  on conflict on constraint ai_usage_monthly_pk do update set
    requests = u.requests + 1,
    last_recorded_at = now();

  return true;
end
$function$;
revoke all on function public.esblu_record_intent_command(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.esblu_record_intent_command(uuid, uuid, text, text) to service_role;
