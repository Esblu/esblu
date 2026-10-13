-- Rollback 20261008100011 (identifikátory prenosu odoslaného podania). Iba staging / po výslovnom schválení.
-- Stratia sa uložené SBDH InstanceIdentifier / AS4 message id (dohľadateľné aj v exporte GET /v1/agent/peppol/events).
begin;
drop function if exists public.esblu_einvoice_outbound_record_transport(uuid, text, text, text);
drop index if exists public.einvoice_outbound_sbdh_idx;
drop index if exists public.einvoice_outbound_document_idx;
alter table public.einvoice_outbound drop constraint if exists einvoice_outbound_sbdh_instance_identifier_check;
alter table public.einvoice_outbound drop constraint if exists einvoice_outbound_as4_message_id_check;
alter table public.einvoice_outbound drop column if exists sbdh_instance_identifier, drop column if exists as4_message_id;
commit;
