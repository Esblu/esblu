-- Rollback 20261027100000_intent_command_telemetry.sql
-- Odstráni počítadlá príkazov asistenta (iba technická telemetria, žiadne obchodné dáta).
drop function if exists public.esblu_record_intent_command(uuid, uuid, text, text);
delete from public.ai_usage_monthly where flow_type = 'intent_command';
alter table public.ai_usage_monthly drop constraint if exists ai_usage_monthly_flow_check;
alter table public.ai_usage_monthly add constraint ai_usage_monthly_flow_check check (flow_type in (
  'document_scan',
  'document_scan_plate_fallback',
  'vehicle_document_scan',
  'vehicle_document_plate_fallback',
  'vehicle_registration_scan',
  'voice_transcription',
  'intent_classification_fallback'
));
