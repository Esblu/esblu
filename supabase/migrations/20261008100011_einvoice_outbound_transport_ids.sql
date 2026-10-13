-- =============================================================================
-- 20261008100011 — dohľadateľnosť odoslaného podania pri incidente (eFaktura.sk, odpoveď 8. 10. 2026).
--
-- Webhooky peppol.document.sent / delivered nesú invoiceId, messageId (AS4) a transactionId
-- (= SBDH InstanceIdentifier). Doteraz sa z nich čítal iba invoiceId; SBDH InstanceIdentifier sa nikde
-- neukladal. Doplnené:
--   - einvoice_outbound.sbdh_instance_identifier, einvoice_outbound.as4_message_id
--     (iba identifikátory, tlačiteľné ASCII ≤ 200, žiadny obsah UBL);
--   - zápis IBA cez service_role RPC, raz (write-once: prvá hodnota sa už neprepíše).
-- Väzba podania: company_id + provider_submission_id (invoice_id poskytovateľa) + document_id.
--
-- ROLLBACK: supabase/rollback/20261008100011_einvoice_outbound_transport_ids_rollback.sql
-- =============================================================================

alter table public.einvoice_outbound
  add column if not exists sbdh_instance_identifier text,
  add column if not exists as4_message_id text;

alter table public.einvoice_outbound drop constraint if exists einvoice_outbound_sbdh_instance_identifier_check;
alter table public.einvoice_outbound add constraint einvoice_outbound_sbdh_instance_identifier_check
  check (sbdh_instance_identifier is null or sbdh_instance_identifier ~ '^[!-~]{1,200}$');
alter table public.einvoice_outbound drop constraint if exists einvoice_outbound_as4_message_id_check;
alter table public.einvoice_outbound add constraint einvoice_outbound_as4_message_id_check
  check (as4_message_id is null or as4_message_id ~ '^[!-~]{1,200}$');

create index if not exists einvoice_outbound_sbdh_idx
  on public.einvoice_outbound (company_id, sbdh_instance_identifier) where sbdh_instance_identifier is not null;
create index if not exists einvoice_outbound_document_idx
  on public.einvoice_outbound (company_id, document_id) where document_id is not null;

-- Zápis identifikátorov prenosu z webhooku / partnerského feedu. Vracia počet dotknutých riadkov.
create or replace function public.esblu_einvoice_outbound_record_transport(
  p_company_id uuid,
  p_provider_submission_id text,
  p_as4_message_id text,
  p_sbdh_instance_identifier text
)
returns integer
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_msg text := nullif(btrim(coalesce(p_as4_message_id, '')), '');
  v_sbdh text := nullif(btrim(coalesce(p_sbdh_instance_identifier, '')), '');
  v_n integer;
begin
  if p_company_id is null or p_provider_submission_id is null or p_provider_submission_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TRANSPORT_IDS_INVALID';
  end if;
  if (v_msg is not null and v_msg !~ '^[!-~]{1,200}$') or (v_sbdh is not null and v_sbdh !~ '^[!-~]{1,200}$') then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TRANSPORT_IDS_INVALID';
  end if;
  if v_msg is null and v_sbdh is null then
    return 0;
  end if;
  -- Write-once: prvá hodnota od poskytovateľa ostáva (replay / neskorší event ju neprepíše).
  update public.einvoice_outbound o
  set as4_message_id = coalesce(o.as4_message_id, v_msg),
      sbdh_instance_identifier = coalesce(o.sbdh_instance_identifier, v_sbdh),
      updated_at = now()
  where o.company_id = p_company_id and o.provider_submission_id = p_provider_submission_id
    and ((o.as4_message_id is null and v_msg is not null) or (o.sbdh_instance_identifier is null and v_sbdh is not null));
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
revoke all on function public.esblu_einvoice_outbound_record_transport(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_outbound_record_transport(uuid, text, text, text) to service_role;
