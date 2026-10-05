-- Rollback 20261005100000_einvoice_partner_onboarding.sql (spúšťať ručne, nie ako migráciu).
drop function if exists public.esblu_einvoice_org_participant_event(text, text, text, text, text, text, timestamptz);
drop function if exists public.esblu_einvoice_org_apply_enroll(text, text, text, text, text, text, text);
drop function if exists public.esblu_einvoice_org_upsert_provisioned(uuid, text, text, text, text, text, text, text, boolean, jsonb);
alter table public.einvoice_organizations drop constraint if exists einvoice_organizations_reception_error_code_check;
alter table public.einvoice_organizations drop constraint if exists einvoice_organizations_reception_held_by_check;
alter table public.einvoice_organizations drop constraint if exists einvoice_organizations_reception_status_check;
alter table public.einvoice_organizations
  drop column if exists participant_event_at,
  drop column if exists enrolled_at,
  drop column if exists reception_error_code,
  drop column if exists reception_held_by,
  drop column if exists reception_status;
