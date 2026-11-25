-- P1-5 skupina C: syntetické dáta (generované scripts/p15-staging/gen.py). Iba staging esblu-test.
begin;
set local session_replication_role = replica;
-- 2026-11-25: tokenové stĺpce musia byť '' (nie NULL) — inak GoTrue vráti 500 "converting NULL to string" (D-T1).
insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, last_sign_in_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change) values
  ('00000000-0000-0000-0000-000000000000', 'f1500000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'qa-p15-t1@esblu-qa.invalid', now(), now(), now(), now(), '{"provider":"email","providers":["email"],"qa_p15":true}'::jsonb, '{"qa_p15":true}'::jsonb, false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1500000-0000-4000-8000-000000000102', 'authenticated', 'authenticated', 'qa-p15-t2@esblu-qa.invalid', now(), now(), now(), now(), '{"provider":"email","providers":["email"],"qa_p15":true}'::jsonb, '{"qa_p15":true}'::jsonb, false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1500000-0000-4000-8000-000000000103', 'authenticated', 'authenticated', 'qa-p15-iso@esblu-qa.invalid', now(), now(), now(), now(), '{"provider":"email","providers":["email"],"qa_p15":true}'::jsonb, '{"qa_p15":true}'::jsonb, false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1500000-0000-4000-8000-000000000104', 'authenticated', 'authenticated', 'qa-p15-perf@esblu-qa.invalid', now(), now(), now(), now(), '{"provider":"email","providers":["email"],"qa_p15":true}'::jsonb, '{"qa_p15":true}'::jsonb, false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1500000-0000-4000-8000-000000000105', 'authenticated', 'authenticated', 'qa-p15-t1admin@esblu-qa.invalid', now(), now(), now(), now(), '{"provider":"email","providers":["email"],"qa_p15":true}'::jsonb, '{"qa_p15":true}'::jsonb, false, '', '', '', '');
insert into public.companies (id, owner_id, name) values
  ('f1510000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000101', 'QA-P15-T1'),
  ('f1510000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000102', 'QA-P15-T2'),
  ('f1510000-0000-4000-8000-000000000003', 'f1500000-0000-4000-8000-000000000103', 'QA-P15-ISO'),
  ('f1510000-0000-4000-8000-000000000004', 'f1500000-0000-4000-8000-000000000104', 'QA-P15-PERF');
insert into public.company_members (company_id, user_id, role, status, permissions) values
  ('f1510000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000101', 'owner', 'active', '{}'),
  ('f1510000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000102', 'owner', 'active', '{}'),
  ('f1510000-0000-4000-8000-000000000003', 'f1500000-0000-4000-8000-000000000103', 'owner', 'active', '{}'),
  ('f1510000-0000-4000-8000-000000000004', 'f1500000-0000-4000-8000-000000000104', 'owner', 'active', '{}'),
  ('f1510000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000105', 'admin', 'active', '{}');
insert into public.company_dpa_acceptances (company_id, document_type, version, accepted_by, acceptance_method, accepted_role, authority_confirmed, company_name_snapshot) values
  ('f1510000-0000-4000-8000-000000000001', 'dpa', '1.3', 'f1500000-0000-4000-8000-000000000101', 'company_dpa_gate', 'owner', true, 'QA-P15-T1'),
  ('f1510000-0000-4000-8000-000000000002', 'dpa', '1.3', 'f1500000-0000-4000-8000-000000000102', 'company_dpa_gate', 'owner', true, 'QA-P15-T2'),
  ('f1510000-0000-4000-8000-000000000003', 'dpa', '1.3', 'f1500000-0000-4000-8000-000000000103', 'company_dpa_gate', 'owner', true, 'QA-P15-ISO'),
  ('f1510000-0000-4000-8000-000000000004', 'dpa', '1.3', 'f1500000-0000-4000-8000-000000000104', 'company_dpa_gate', 'owner', true, 'QA-P15-PERF');
insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number, issue_date, currency, subtotal_amount, vat_total_amount, total_amount) values
  ('f151c000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000001', 'issued', 'regular_invoice', 'finalized', now(), 'QA-P15-T1-1', current_date, 'EUR', 100, 23, 123),
  ('f151c000-0000-4000-8000-000000000002', 'f1510000-0000-4000-8000-000000000001', 'issued', 'regular_invoice', 'finalized', now(), 'QA-P15-T1-2', current_date, 'EUR', 100, 23, 123),
  ('f151c000-0000-4000-8000-000000000003', 'f1510000-0000-4000-8000-000000000001', 'issued', 'regular_invoice', 'finalized', now(), 'QA-P15-T1-3', current_date, 'EUR', 100, 23, 123),
  ('f151c000-0000-4000-8000-0000000003e7', 'f1510000-0000-4000-8000-000000000001', 'issued', 'regular_invoice', 'draft', null, null, current_date, 'EUR', 10, 2.3, 12.3);
insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, vat_category_code, vat_rate) values
  ('f151c000-0000-4000-8000-000000000001', 1, 'Syntetická položka QA-P15', 1, 100, 'S', 23),
  ('f151c000-0000-4000-8000-000000000002', 1, 'Syntetická položka QA-P15', 1, 100, 'S', 23),
  ('f151c000-0000-4000-8000-000000000003', 1, 'Syntetická položka QA-P15', 1, 100, 'S', 23);
insert into public.invoice_parties (invoice_id, role, legal_name) values
  ('f151c000-0000-4000-8000-000000000001', 'buyer', 'QA-P15 syntetický odberateľ'),
  ('f151c000-0000-4000-8000-000000000002', 'buyer', 'QA-P15 syntetický odberateľ'),
  ('f151c000-0000-4000-8000-000000000003', 'buyer', 'QA-P15 syntetický odberateľ');
insert into public.invoice_events (invoice_id, event_type) values
  ('f151c000-0000-4000-8000-000000000001', 'finalized'),
  ('f151c000-0000-4000-8000-000000000002', 'finalized'),
  ('f151c000-0000-4000-8000-000000000003', 'finalized');
insert into public.invoice_accounting_state_log (invoice_id, company_id, accounting_status) values ('f151c000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000001', 'accounted');
insert into public.einvoice_outbound (id, company_id, invoice_id, provider, environment, attempt, idempotency_key, ubl_sha256, ubl_storage_path, ubl_size_bytes, state) values ('f151d000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000001', 'f151c000-0000-4000-8000-000000000001', 'efaktura_sk', 'sandbox', 1, 'qa-p15-t1-idem-0000000001', 'def4210a55672f6cfb77c766774ff13ce66e046c89145b2647e3c2a2809d21e9', 'f1510000-0000-4000-8000-000000000001/outbound/f151c000-0000-4000-8000-000000000001/def4210a55672f6cfb77c766774ff13ce66e046c89145b2647e3c2a2809d21e9.xml', 346, 'delivered');
insert into public.einvoice_inbound (id, company_id, provider, environment, provider_received_id, xml_storage_path, xml_sha256, xml_size_bytes, processing_status, last_error_code, quarantined_at, quarantine_reason, is_test) values
  ('f151e000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000001', 'efaktura_sk', 'sandbox', 'qa-p15-t1-ok-1', 'f1510000-0000-4000-8000-000000000001/inbound/efaktura_sk/qa-p15-t1-ok-1/688ccb773c522076d228623c577146abfe4d45d1768b016b170a5db99147cef0.xml', '688ccb773c522076d228623c577146abfe4d45d1768b016b170a5db99147cef0', 344, 'acknowledged', null, null, null, true),
  ('f151e000-0000-4000-8000-000000000002', 'f1510000-0000-4000-8000-000000000001', 'efaktura_sk', 'sandbox', 'qa-p15-t1-quarantine-1', 'f1510000-0000-4000-8000-000000000001/inbound/efaktura_sk/qa-p15-t1-quarantine-1/7aaf77e414ed729d1c2d3e091112cf4f8cf7777458afb8f5e6dcf917c0cada8e.xml', '7aaf77e414ed729d1c2d3e091112cf4f8cf7777458afb8f5e6dcf917c0cada8e', 344, 'failed', 'DRAFT_CREATE_FAILED', now(), 'DRAFT_CREATE_FAILED', true),
  ('f151e000-0000-4000-8000-000000000003', 'f1510000-0000-4000-8000-000000000001', 'efaktura_sk', 'sandbox', 'qa-p15-t1-mismatch-1', 'f1510000-0000-4000-8000-000000000001/inbound/efaktura_sk/qa-p15-t1-mismatch-1/809928eb915949f504c70e0b791ff0cf5d07a6af717f8be585eca7e94b01a582.xml', '809928eb915949f504c70e0b791ff0cf5d07a6af717f8be585eca7e94b01a582', 344, 'failed', 'RECIPIENT_MISMATCH', null, null, true);
insert into public.einvoice_events (company_id, outbound_id, inbound_id, from_state, to_state, source) values
  ('f1510000-0000-4000-8000-000000000001', 'f151d000-0000-4000-8000-000000000001', null, 'sent', 'delivered', 'system'),
  ('f1510000-0000-4000-8000-000000000001', null, 'f151e000-0000-4000-8000-000000000001', 'received', 'acknowledged', 'system'),
  ('f1510000-0000-4000-8000-000000000001', null, 'f151e000-0000-4000-8000-000000000002', 'received', 'failed', 'system'),
  ('f1510000-0000-4000-8000-000000000001', null, 'f151e000-0000-4000-8000-000000000003', 'received', 'failed', 'system');
insert into public.einvoice_mandates (company_id, provider, environment, scope, granted_by_user_id, granted_by_name, granted_by_email, granted_by_role, statement_version, statement_sha256, statement_locale, authority_confirmed, grant_channel) values ('f1510000-0000-4000-8000-000000000001', 'efaktura_sk', 'sandbox', '{send,receive}', 'f1500000-0000-4000-8000-000000000101', 'QA P15 Synthetic', 'qa-p15-t1@esblu-qa.invalid', 'owner', 'qa-p15-mandate-1', '5943f615b8fba2f6f4948e90dda95961cf004188ffba44476dd85b9be402e51a', 'sk', true, 'enroll');
insert into public.documents (id, company_id, user_id, storage_bucket, storage_path, original_filename, mime_type, file_size, document_type, status, content_sha256) values ('f151f000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000101', 'ai-inbox-documents', 'f1510000-0000-4000-8000-000000000001/p15/doc-1.pdf', 'qa-p15-doc-1.pdf', 'application/pdf', 151, 'invoice', 'confirmed', '847d760b987b8ee35304b02d9b3aebc0f9ecf3e8f4d7ab50a8f0da8f5592bafe');
insert into public.document_attachments (company_id, user_id, document_id, storage_bucket, storage_path, original_filename, mime_type, file_size, attachment_type) values ('f1510000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000101', 'f151f000-0000-4000-8000-000000000001', 'ai-inbox-documents', 'f1510000-0000-4000-8000-000000000001/p15/att-1.pdf', 'qa-p15-att-1.pdf', 'application/pdf', 151, 'other');
insert into public.vehicles (company_id, spz, znacka) values ('f1510000-0000-4000-8000-000000000001', 'QAP15T1', 'QA-P15 syntetické');
insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number, issue_date, currency, subtotal_amount, vat_total_amount, total_amount) values
  ('f153c000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000002', 'issued', 'regular_invoice', 'finalized', now(), 'QA-P15-T2-1', current_date, 'EUR', 100, 23, 123),
  ('f153c000-0000-4000-8000-000000000002', 'f1510000-0000-4000-8000-000000000002', 'issued', 'regular_invoice', 'finalized', now(), 'QA-P15-T2-2', current_date, 'EUR', 100, 23, 123),
  ('f153c000-0000-4000-8000-0000000003e7', 'f1510000-0000-4000-8000-000000000002', 'issued', 'regular_invoice', 'draft', null, null, current_date, 'EUR', 10, 2.3, 12.3);
insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, vat_category_code, vat_rate) values
  ('f153c000-0000-4000-8000-000000000001', 1, 'Syntetická položka QA-P15', 1, 100, 'S', 23),
  ('f153c000-0000-4000-8000-000000000002', 1, 'Syntetická položka QA-P15', 1, 100, 'S', 23);
insert into public.invoice_parties (invoice_id, role, legal_name) values
  ('f153c000-0000-4000-8000-000000000001', 'buyer', 'QA-P15 syntetický odberateľ'),
  ('f153c000-0000-4000-8000-000000000002', 'buyer', 'QA-P15 syntetický odberateľ');
insert into public.invoice_events (invoice_id, event_type) values
  ('f153c000-0000-4000-8000-000000000001', 'finalized'),
  ('f153c000-0000-4000-8000-000000000002', 'finalized');
insert into public.invoice_accounting_state_log (invoice_id, company_id, accounting_status) values ('f153c000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000002', 'accounted');
insert into public.einvoice_outbound (id, company_id, invoice_id, provider, environment, attempt, idempotency_key, ubl_sha256, ubl_storage_path, ubl_size_bytes, state) values ('f153d000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000002', 'f153c000-0000-4000-8000-000000000001', 'efaktura_sk', 'sandbox', 1, 'qa-p15-t2-idem-0000000001', 'd3831284c7dc977bc3d478665d0fe4b889cb37a55b208f44a7752321bdd81380', 'f1510000-0000-4000-8000-000000000002/outbound/f153c000-0000-4000-8000-000000000001/d3831284c7dc977bc3d478665d0fe4b889cb37a55b208f44a7752321bdd81380.xml', 346, 'delivered');
insert into public.einvoice_inbound (id, company_id, provider, environment, provider_received_id, xml_storage_path, xml_sha256, xml_size_bytes, processing_status, last_error_code, quarantined_at, quarantine_reason, is_test) values
  ('f153e000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000002', 'efaktura_sk', 'sandbox', 'qa-p15-t2-ok-1', 'f1510000-0000-4000-8000-000000000002/inbound/efaktura_sk/qa-p15-t2-ok-1/9ecc3aa8905d0c56a7a33662cb2fa029cc0e33b21a0dba28e8e1e2d28baec347.xml', '9ecc3aa8905d0c56a7a33662cb2fa029cc0e33b21a0dba28e8e1e2d28baec347', 344, 'acknowledged', null, null, null, true),
  ('f153e000-0000-4000-8000-000000000002', 'f1510000-0000-4000-8000-000000000002', 'efaktura_sk', 'sandbox', 'qa-p15-t2-quarantine-1', 'f1510000-0000-4000-8000-000000000002/inbound/efaktura_sk/qa-p15-t2-quarantine-1/de520753b30e5c205564966c8543af9735f786997e5a9f1258c4c190ff7f8613.xml', 'de520753b30e5c205564966c8543af9735f786997e5a9f1258c4c190ff7f8613', 344, 'failed', 'DRAFT_CREATE_FAILED', now(), 'DRAFT_CREATE_FAILED', true),
  ('f153e000-0000-4000-8000-000000000003', 'f1510000-0000-4000-8000-000000000002', 'efaktura_sk', 'sandbox', 'qa-p15-t2-mismatch-1', 'f1510000-0000-4000-8000-000000000002/inbound/efaktura_sk/qa-p15-t2-mismatch-1/bd725d630cbf3cf1c8f582f8e4e95b954b257c8519bff73e07e18a37a0b23b95.xml', 'bd725d630cbf3cf1c8f582f8e4e95b954b257c8519bff73e07e18a37a0b23b95', 344, 'failed', 'RECIPIENT_MISMATCH', null, null, true),
  ('f153e000-0000-4000-8000-000000000004', 'f1510000-0000-4000-8000-000000000002', 'efaktura_sk', 'sandbox', 'qa-p15-t2-corrupt-1', 'f1510000-0000-4000-8000-000000000002/inbound/efaktura_sk/qa-p15-t2-corrupt-1/a7704e08824aa71276507fe1b6be3922d58af3ea6a05dc8a845717fe11c4ec7b.xml', 'a7704e08824aa71276507fe1b6be3922d58af3ea6a05dc8a845717fe11c4ec7b', 344, 'acknowledged', null, null, null, true);
insert into public.einvoice_events (company_id, outbound_id, inbound_id, from_state, to_state, source) values
  ('f1510000-0000-4000-8000-000000000002', 'f153d000-0000-4000-8000-000000000001', null, 'sent', 'delivered', 'system'),
  ('f1510000-0000-4000-8000-000000000002', null, 'f153e000-0000-4000-8000-000000000001', 'received', 'acknowledged', 'system'),
  ('f1510000-0000-4000-8000-000000000002', null, 'f153e000-0000-4000-8000-000000000002', 'received', 'failed', 'system'),
  ('f1510000-0000-4000-8000-000000000002', null, 'f153e000-0000-4000-8000-000000000003', 'received', 'failed', 'system'),
  ('f1510000-0000-4000-8000-000000000002', null, 'f153e000-0000-4000-8000-000000000004', 'received', 'acknowledged', 'system');
insert into public.einvoice_mandates (company_id, provider, environment, scope, granted_by_user_id, granted_by_name, granted_by_email, granted_by_role, statement_version, statement_sha256, statement_locale, authority_confirmed, grant_channel) values ('f1510000-0000-4000-8000-000000000002', 'efaktura_sk', 'sandbox', '{send,receive}', 'f1500000-0000-4000-8000-000000000102', 'QA P15 Synthetic', 'qa-p15-t2@esblu-qa.invalid', 'owner', 'qa-p15-mandate-1', '5943f615b8fba2f6f4948e90dda95961cf004188ffba44476dd85b9be402e51a', 'sk', true, 'enroll');
insert into public.documents (id, company_id, user_id, storage_bucket, storage_path, original_filename, mime_type, file_size, document_type, status, content_sha256) values ('f153f000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000102', 'ai-inbox-documents', 'f1510000-0000-4000-8000-000000000002/p15/doc-1.pdf', 'qa-p15-doc-1.pdf', 'application/pdf', 151, 'invoice', 'confirmed', 'eb372d738e9790e12cd0c3cc194b89b8bcabd4b8b0e68dfdf521832323da3dec');
insert into public.document_attachments (company_id, user_id, document_id, storage_bucket, storage_path, original_filename, mime_type, file_size, attachment_type) values ('f1510000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000102', 'f153f000-0000-4000-8000-000000000001', 'ai-inbox-documents', 'f1510000-0000-4000-8000-000000000002/p15/att-1.pdf', 'qa-p15-att-1.pdf', 'application/pdf', 151, 'other');
insert into public.documents (company_id, user_id, storage_bucket, storage_path, original_filename, mime_type, file_size, document_type, status, content_sha256) values ('f1510000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000102', 'ai-inbox-documents', 'f1510000-0000-4000-8000-000000000002/p15/doc-late.pdf', 'qa-p15-doc-late.pdf', 'application/pdf', 151, 'invoice', 'confirmed', '48ec2884af92f7cfd459d92189be7c4fe57623ba96488a0d61191cd8ec9452e4');
insert into public.vehicles (company_id, spz, znacka) values ('f1510000-0000-4000-8000-000000000002', 'QAP15T2', 'QA-P15 syntetické');
insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number, issue_date, currency, subtotal_amount, vat_total_amount, total_amount) values
  ('f155c000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000003', 'issued', 'regular_invoice', 'finalized', now(), 'QA-P15-ISO-1', current_date, 'EUR', 100, 23, 123),
  ('f155c000-0000-4000-8000-000000000002', 'f1510000-0000-4000-8000-000000000003', 'issued', 'regular_invoice', 'finalized', now(), 'QA-P15-ISO-2', current_date, 'EUR', 100, 23, 123),
  ('f155c000-0000-4000-8000-0000000003e7', 'f1510000-0000-4000-8000-000000000003', 'issued', 'regular_invoice', 'draft', null, null, current_date, 'EUR', 10, 2.3, 12.3);
insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, vat_category_code, vat_rate) values
  ('f155c000-0000-4000-8000-000000000001', 1, 'Syntetická položka QA-P15', 1, 100, 'S', 23),
  ('f155c000-0000-4000-8000-000000000002', 1, 'Syntetická položka QA-P15', 1, 100, 'S', 23);
insert into public.invoice_parties (invoice_id, role, legal_name) values
  ('f155c000-0000-4000-8000-000000000001', 'buyer', 'QA-P15 syntetický odberateľ'),
  ('f155c000-0000-4000-8000-000000000002', 'buyer', 'QA-P15 syntetický odberateľ');
insert into public.invoice_events (invoice_id, event_type) values
  ('f155c000-0000-4000-8000-000000000001', 'finalized'),
  ('f155c000-0000-4000-8000-000000000002', 'finalized');
insert into public.invoice_accounting_state_log (invoice_id, company_id, accounting_status) values ('f155c000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000003', 'accounted');
insert into public.einvoice_outbound (id, company_id, invoice_id, provider, environment, attempt, idempotency_key, ubl_sha256, ubl_storage_path, ubl_size_bytes, state) values ('f155d000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000003', 'f155c000-0000-4000-8000-000000000001', 'efaktura_sk', 'sandbox', 1, 'qa-p15-iso-idem-0000000001', '8320fa2a24acb5f1124fc661b7b8d9f8122b0001010d2335987089ce07eb558d', 'f1510000-0000-4000-8000-000000000003/outbound/f155c000-0000-4000-8000-000000000001/8320fa2a24acb5f1124fc661b7b8d9f8122b0001010d2335987089ce07eb558d.xml', 348, 'delivered');
insert into public.einvoice_inbound (id, company_id, provider, environment, provider_received_id, xml_storage_path, xml_sha256, xml_size_bytes, processing_status, last_error_code, quarantined_at, quarantine_reason, is_test) values
  ('f155e000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000003', 'efaktura_sk', 'sandbox', 'qa-p15-iso-ok-1', 'f1510000-0000-4000-8000-000000000003/inbound/efaktura_sk/qa-p15-iso-ok-1/e0299d6d7a5432adc5338e4e6648f2a18de35527bd2e707ae4981f8512a066a2.xml', 'e0299d6d7a5432adc5338e4e6648f2a18de35527bd2e707ae4981f8512a066a2', 346, 'acknowledged', null, null, null, true),
  ('f155e000-0000-4000-8000-000000000002', 'f1510000-0000-4000-8000-000000000003', 'efaktura_sk', 'sandbox', 'qa-p15-iso-quarantine-1', 'f1510000-0000-4000-8000-000000000003/inbound/efaktura_sk/qa-p15-iso-quarantine-1/dd08b44a4ab0226bce9b9f7d6efcdf9a0dee773c73357bedc2061ed047ea82af.xml', 'dd08b44a4ab0226bce9b9f7d6efcdf9a0dee773c73357bedc2061ed047ea82af', 346, 'failed', 'DRAFT_CREATE_FAILED', now(), 'DRAFT_CREATE_FAILED', true),
  ('f155e000-0000-4000-8000-000000000003', 'f1510000-0000-4000-8000-000000000003', 'efaktura_sk', 'sandbox', 'qa-p15-iso-mismatch-1', 'f1510000-0000-4000-8000-000000000003/inbound/efaktura_sk/qa-p15-iso-mismatch-1/a9bbc37a2694fd1863aee4841d6f901a803eeeb19600dfd09f26fe0df66a0442.xml', 'a9bbc37a2694fd1863aee4841d6f901a803eeeb19600dfd09f26fe0df66a0442', 346, 'failed', 'RECIPIENT_MISMATCH', null, null, true);
insert into public.einvoice_events (company_id, outbound_id, inbound_id, from_state, to_state, source) values
  ('f1510000-0000-4000-8000-000000000003', 'f155d000-0000-4000-8000-000000000001', null, 'sent', 'delivered', 'system'),
  ('f1510000-0000-4000-8000-000000000003', null, 'f155e000-0000-4000-8000-000000000001', 'received', 'acknowledged', 'system'),
  ('f1510000-0000-4000-8000-000000000003', null, 'f155e000-0000-4000-8000-000000000002', 'received', 'failed', 'system'),
  ('f1510000-0000-4000-8000-000000000003', null, 'f155e000-0000-4000-8000-000000000003', 'received', 'failed', 'system');
insert into public.einvoice_mandates (company_id, provider, environment, scope, granted_by_user_id, granted_by_name, granted_by_email, granted_by_role, statement_version, statement_sha256, statement_locale, authority_confirmed, grant_channel) values ('f1510000-0000-4000-8000-000000000003', 'efaktura_sk', 'sandbox', '{send,receive}', 'f1500000-0000-4000-8000-000000000103', 'QA P15 Synthetic', 'qa-p15-iso@esblu-qa.invalid', 'owner', 'qa-p15-mandate-1', '5943f615b8fba2f6f4948e90dda95961cf004188ffba44476dd85b9be402e51a', 'sk', true, 'enroll');
insert into public.documents (id, company_id, user_id, storage_bucket, storage_path, original_filename, mime_type, file_size, document_type, status, content_sha256) values ('f155f000-0000-4000-8000-000000000001', 'f1510000-0000-4000-8000-000000000003', 'f1500000-0000-4000-8000-000000000103', 'ai-inbox-documents', 'f1510000-0000-4000-8000-000000000003/p15/doc-1.pdf', 'qa-p15-doc-1.pdf', 'application/pdf', 152, 'invoice', 'confirmed', '9fe7381760e45bf822bcb0a3340424e8a5b2874de59ffcc6b7347fb80df33e99');
insert into public.document_attachments (company_id, user_id, document_id, storage_bucket, storage_path, original_filename, mime_type, file_size, attachment_type) values ('f1510000-0000-4000-8000-000000000003', 'f1500000-0000-4000-8000-000000000103', 'f155f000-0000-4000-8000-000000000001', 'ai-inbox-documents', 'f1510000-0000-4000-8000-000000000003/p15/att-1.pdf', 'qa-p15-att-1.pdf', 'application/pdf', 152, 'other');
insert into public.vehicles (company_id, spz, znacka) values ('f1510000-0000-4000-8000-000000000003', 'QAP15ISO', 'QA-P15 syntetické');
-- PERF: 25 000 faktúr, 100 000 položiek, 25 000 udalostí, 5 000 prijatých (300 so súborom)
insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number, issue_date, currency, subtotal_amount, vat_total_amount, total_amount)
  select ('f1520000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'f1510000-0000-4000-8000-000000000004', 'issued', 'regular_invoice', 'finalized', now(), 'QA-P15-PERF-' || g, current_date, 'EUR', 100, 23, 123 from generate_series(1, 25000) g;
insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, vat_category_code, vat_rate)
  select ('f1520000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, p, 'Syntetická položka PERF', 1, 25, 'S', 23 from generate_series(1, 25000) g, generate_series(1, 4) p;
insert into public.invoice_events (invoice_id, event_type)
  select ('f1520000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'finalized' from generate_series(1, 25000) g;
insert into public.einvoice_inbound (company_id, provider, environment, provider_received_id, processing_status, is_test)
  select 'f1510000-0000-4000-8000-000000000004', 'efaktura_sk', 'sandbox', 'qa-p15-perf-nofile-' || g, 'acknowledged', true from generate_series(1, 4700) g;
insert into public.einvoice_inbound (company_id, provider, environment, provider_received_id, xml_storage_path, xml_sha256, xml_size_bytes, processing_status, is_test)
  select 'f1510000-0000-4000-8000-000000000004', 'efaktura_sk', 'sandbox', 'qa-p15-perf-' || g,
         'f1510000-0000-4000-8000-000000000004/inbound/efaktura_sk/qa-p15-perf-' || g || '/' || encode(sha256(b), 'hex') || '.xml',
         encode(sha256(b), 'hex'), octet_length(b), 'acknowledged', true
  from generate_series(1, 300) g,
  lateral (select convert_to(format(E'<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>QA-P15-PERF-%s</ID><Note>SYNTHETIC QA-P15 test document - not a real invoice</Note><AccountingSupplierParty><Party><PartyName><Name>QA-P15-PERF Supplier (synthetic)</Name></PartyName></Party></AccountingSupplierParty></Invoice>\n', g), 'UTF8') b) x;
commit;
