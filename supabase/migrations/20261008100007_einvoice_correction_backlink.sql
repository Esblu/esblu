-- 20261008100007 — prijatá oprava doručená/spracovaná PRED originálom (staging E2E 6. 10. 2026, reálny
-- sandbox eFaktura.sk: dobropis a ťarchopis sa spracovali skôr než faktúra → ORIGINAL_NOT_FOUND).
-- Pri vzniku konceptu prijatej faktúry sa dodatočne prepoja čakajúce opravy v review: iba tá istá firma,
-- ten istý dodávateľ, BT-25 = číslo faktúry dodávateľa (a BT-26 = dátum, ak ho oprava uvádza). Oprava
-- ostáva v review (nič sa neprijíma automaticky); udalosť correction_reviewed / auto_linked.
create or replace function public.esblu_einvoice_inbound_create_draft(p_inbound_id uuid, p_draft jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_in public.einvoice_inbound;
  v_dup record;
  v_partner uuid;
  v_result jsonb;
  v_status text;
  v_totals jsonb;
begin
  select * into v_in from public.einvoice_inbound i where i.id = p_inbound_id for update;
  if v_in.id is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_NOT_FOUND';
  end if;
  if v_in.processing_status <> 'parsed' or v_in.xml_sha256 is null or v_in.xml_storage_path is null then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_INBOUND_STATE';
  end if;
  if p_draft is null or jsonb_typeof(p_draft -> 'totals') is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_TOTALS_REQUIRED';
  end if;

  perform set_config('esblu.einvoice_event_source', 'job', true);

  -- Dedupe 1: rovnaké XML (SHA-256) už vo FIRME spracované → prepojiť existujúci koncept (aj pri opravách).
  select i.id, i.invoice_id into v_dup
  from public.einvoice_inbound i
  where i.company_id = v_in.company_id and i.xml_sha256 = v_in.xml_sha256
    and i.id <> v_in.id and i.invoice_id is not null
  order by i.received_at
  limit 1;
  if v_dup.id is not null then
    update public.einvoice_inbound i
    set processing_status = 'duplicate', invoice_id = v_dup.invoice_id, dedupe_matched_on = 'xml_sha256',
        last_error_code = null, next_retry_at = now() + interval '2 minutes'
    where i.id = v_in.id;
    perform set_config('esblu.einvoice_event_source', '', true);
    return jsonb_build_object('status', 'duplicate', 'invoice_id', v_dup.invoice_id, 'matched_on', 'xml_sha256');
  end if;

  if coalesce(p_draft ->> 'document_kind', 'regular_invoice') in ('credit_note', 'debit_note') then
    perform set_config('esblu.einvoice_event_source', '', true);
    return public.esblu_einvoice_inbound_create_correction(p_inbound_id, p_draft);
  end if;

  v_partner := public.esblu_einvoice_resolve_supplier(v_in.company_id, coalesce(p_draft -> 'supplier', '{}'::jsonb));

  v_result := public.esblu_received_invoice_draft_core(
    v_in.company_id, null, 'efaktura_peppol', v_in.provider, v_in.provider_received_id,
    v_partner,
    p_draft ->> 'invoice_number',
    nullif(p_draft ->> 'issue_date', '')::date,
    p_draft -> 'items',
    nullif(p_draft ->> 'due_date', '')::date,
    nullif(p_draft ->> 'delivery_date', '')::date,
    null,
    p_draft ->> 'currency',
    p_draft ->> 'iban',
    p_draft ->> 'bic',
    p_draft ->> 'payment_reference',
    null,
    p_draft ->> 'buyer_reference',
    p_draft ->> 'purchase_order_reference',
    (v_in.received_at at time zone 'UTC')::date,
    null,
    null
  );

  v_status := case when v_result ->> 'status' = 'created' then 'draft_created' else 'duplicate' end;
  if v_status = 'draft_created' then
    v_totals := public.esblu_einvoice_apply_xml_totals((v_result ->> 'invoice_id')::uuid, p_draft -> 'totals', p_draft ->> 'payment_means_code');
    -- 20261008100007: oprava mohla prísť (alebo sa spracovať) SKÔR než originál → dodatočné prepojenie
    -- čakajúcich opráv v review: tá istá firma, ten istý dodávateľ, BT-25 = číslo tejto faktúry (a BT-26, ak je).
    with linked as (
      update public.invoices c
      set corrects_invoice_id = (v_result ->> 'invoice_id')::uuid,
          correction_review_reasons = array_append(
            array(select r from unnest(coalesce(c.correction_review_reasons, array[]::text[])) r
                  where r not in ('ORIGINAL_REFERENCE_MISSING', 'ORIGINAL_NOT_FOUND', 'ORIGINAL_AMBIGUOUS', 'ORIGINAL_NOT_FINALIZED')),
            'ORIGINAL_NOT_FINALIZED'),
          updated_at = now()
      where c.company_id = v_in.company_id and c.direction = 'received' and c.kind in ('credit_note', 'debit_note')
        and c.document_status = 'draft' and c.correction_review_status = 'review' and c.corrects_invoice_id is null
        and c.supplier_business_partner_id = v_partner
        and upper(regexp_replace(coalesce(c.corrected_document_reference, ''), '[\s\-/]', '', 'g'))
            = upper(regexp_replace(coalesce(p_draft ->> 'invoice_number', ''), '[\s\-/]', '', 'g'))
        and (c.corrected_document_issue_date is null or c.corrected_document_issue_date = nullif(p_draft ->> 'issue_date', '')::date)
      returning c.id
    )
    insert into public.invoice_events (invoice_id, event_type, actor_user_id, actor_source, payload)
    select l.id, 'correction_reviewed', null, 'system',
           jsonb_build_object('action', 'auto_linked', 'original_invoice_id', (v_result ->> 'invoice_id')::uuid)
    from linked l;
  end if;

  update public.einvoice_inbound i
  set processing_status = v_status,
      invoice_id = coalesce((v_result ->> 'invoice_id')::uuid, (v_result ->> 'existing_invoice_id')::uuid),
      dedupe_matched_on = case when v_status = 'duplicate' then v_result ->> 'matched_on' end,
      draft_created_at = case when v_status = 'draft_created' then now() else i.draft_created_at end,
      xml_totals = case when v_status = 'draft_created' then v_totals else i.xml_totals end,
      last_error_code = null,
      next_retry_at = now() + interval '2 minutes'
  where i.id = v_in.id;
  perform set_config('esblu.einvoice_event_source', '', true);

  return jsonb_build_object(
    'status', case when v_status = 'draft_created' then 'created' else 'duplicate' end,
    'invoice_id', coalesce(v_result ->> 'invoice_id', v_result ->> 'existing_invoice_id'),
    'matched_on', v_result ->> 'matched_on'
  );
end;
$function$;
revoke all on function public.esblu_einvoice_inbound_create_draft(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.esblu_einvoice_inbound_create_draft(uuid, jsonb) to service_role;
