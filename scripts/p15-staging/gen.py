import hashlib, base64, json
H=lambda b: hashlib.sha256(b).hexdigest()
U={'t1':'f1500000-0000-4000-8000-000000000101','t2':'f1500000-0000-4000-8000-000000000102','iso':'f1500000-0000-4000-8000-000000000103','perf':'f1500000-0000-4000-8000-000000000104','t1admin':'f1500000-0000-4000-8000-000000000105'}
C={'t1':'f1510000-0000-4000-8000-000000000001','t2':'f1510000-0000-4000-8000-000000000002','iso':'f1510000-0000-4000-8000-000000000003','perf':'f1510000-0000-4000-8000-000000000004'}
NAME={'t1':'QA-P15-T1','t2':'QA-P15-T2','iso':'QA-P15-ISO','perf':'QA-P15-PERF'}
def xml(tag, n): return (f'<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>{tag}-{n}</ID><Note>SYNTHETIC QA-P15 test document - not a real invoice</Note><AccountingSupplierParty><Party><PartyName><Name>{tag} Supplier (synthetic)</Name></PartyName></Party></AccountingSupplierParty></Invoice>\n').encode()
def pdf(tag): return (b'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n%' + tag.encode() + b' SYNTHETIC\ntrailer<</Root 1 0 R>>\n%%EOF\n')
IDX={'f1510000-0000-4000-8000-000000000001':'1','f1510000-0000-4000-8000-000000000002':'3','f1510000-0000-4000-8000-000000000003':'5'}
def uid_(c, t, n): return f'f15{IDX[c]}{t}000-0000-4000-8000-{n:012x}'
def iid(c, n): return uid_(c, 'c', n)
files=[]; sql=[]
def F(company_key, bucket, path, content, kind, phase='A', upload=None):
    files.append({'company':company_key,'company_id':C[company_key],'bucket':bucket,'path':path,'sha256':H(content),'bytes':len(content),'kind':kind,'phase':phase,
                  'content_b64':base64.b64encode(upload if upload is not None else content).decode(),'upload_sha256':H(upload if upload is not None else content)})
    return H(content)
q=lambda s: "'"+s.replace("'","''")+"'"
sql.append("-- P1-5 skupina C: syntetické dáta (generované scripts/p15-staging/gen.py). Iba staging esblu-test.")
sql.append("begin;\nset local session_replication_role = replica;")
users=[]
for k,uid in U.items():
    email=f'qa-p15-{k}@esblu-qa.invalid'
    users.append(f"('00000000-0000-0000-0000-000000000000', {q(uid)}, 'authenticated', 'authenticated', {q(email)}, now(), now(), now(), now(), '{{\"provider\":\"email\",\"providers\":[\"email\"],\"qa_p15\":true}}'::jsonb, '{{\"qa_p15\":true}}'::jsonb, false)")
sql.append("insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, last_sign_in_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous) values\n  "+",\n  ".join(users)+";")
sql.append("insert into public.companies (id, owner_id, name) values\n  "+",\n  ".join(f"({q(C[k])}, {q(U[k])}, {q(NAME[k])})" for k in C)+";")
mem=[f"({q(C[k])}, {q(U[k])}, 'owner', 'active', '{{}}')" for k in C]+[f"({q(C['t1'])}, {q(U['t1admin'])}, 'admin', 'active', '{{}}')"]
sql.append("insert into public.company_members (company_id, user_id, role, status, permissions) values\n  "+",\n  ".join(mem)+";")
sql.append("insert into public.company_dpa_acceptances (company_id, document_type, version, accepted_by, acceptance_method, accepted_role, authority_confirmed, company_name_snapshot) values\n  "+",\n  ".join(f"({q(C[k])}, 'dpa', '1.3', {q(U[k])}, 'company_dpa_gate', 'owner', true, {q(NAME[k])})" for k in C)+";")
def company_set(k, n_inv, extra_corrupt=False, orphan=True, late=False):
    c=C[k]; tag=NAME[k]
    inv=[iid(c,i) for i in range(1,n_inv+1)]
    rows=[]
    for i,x in enumerate(inv,1):
        rows.append(f"({q(x)}, {q(c)}, 'issued', 'regular_invoice', 'finalized', now(), {q(f'{tag}-{i}')}, current_date, 'EUR', 100, 23, 123)")
    rows.append(f"({q(iid(c,999))}, {q(c)}, 'issued', 'regular_invoice', 'draft', null, null, current_date, 'EUR', 10, 2.3, 12.3)")
    sql.append("insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number, issue_date, currency, subtotal_amount, vat_total_amount, total_amount) values\n  "+",\n  ".join(rows)+";")
    sql.append("insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, vat_category_code, vat_rate) values\n  "+",\n  ".join(f"({q(x)}, 1, 'Syntetická položka QA-P15', 1, 100, 'S', 23)" for x in inv)+";")
    sql.append("insert into public.invoice_parties (invoice_id, role, legal_name) values\n  "+",\n  ".join(f"({q(x)}, 'buyer', 'QA-P15 syntetický odberateľ')" for x in inv)+";")
    sql.append("insert into public.invoice_events (invoice_id, event_type) values\n  "+",\n  ".join(f"({q(x)}, 'finalized')" for x in inv)+";")
    sql.append(f"insert into public.invoice_accounting_state_log (invoice_id, company_id, accounting_status) values ({q(inv[0])}, {q(c)}, 'accounted');")
    # outbound UBL
    ubl=xml(tag+'-UBL',1); sh=H(ubl); p=f"{c}/outbound/{inv[0]}/{sh}.xml"; F(k,'einvoice-documents',p,ubl,'ubl')
    ob=uid_(c,'d',1)
    sql.append(f"insert into public.einvoice_outbound (id, company_id, invoice_id, provider, environment, attempt, idempotency_key, ubl_sha256, ubl_storage_path, ubl_size_bytes, state) values ({q(ob)}, {q(c)}, {q(inv[0])}, 'efaktura_sk', 'sandbox', 1, {q('qa-p15-'+k+'-idem-0000000001')}, {q(sh)}, {q(p)}, {len(ubl)}, 'delivered');")
    ev=[f"({q(c)}, {q(ob)}, null, 'sent', 'delivered', 'system')"]
    inb=[]
    def inbound(n, rid, status, err=None, quarantine=False, content=None, upload=None, phase='A', kind='xml'):
        content=content or xml(tag+'-IN',n); sh=H(content); p=f"{c}/inbound/efaktura_sk/{rid}/{sh}.xml"
        F(k,'einvoice-documents',p,content,kind,phase,upload)
        iid_=uid_(c,'e',n)
        inb.append(f"({q(iid_)}, {q(c)}, 'efaktura_sk', 'sandbox', {q(rid)}, {q(p)}, {q(sh)}, {len(content)}, {q(status)}, {('null' if err is None else q(err))}, {('now()' if quarantine else 'null')}, {(q('DRAFT_CREATE_FAILED') if quarantine else 'null')}, true)")
        ev.append(f"({q(c)}, null, {q(iid_)}, 'received', {q(status)}, 'system')")
    inbound(1, f'qa-p15-{k}-ok-1', 'acknowledged')
    inbound(2, f'qa-p15-{k}-quarantine-1', 'failed', 'DRAFT_CREATE_FAILED', quarantine=True, kind='xml_quarantine')
    inbound(3, f'qa-p15-{k}-mismatch-1', 'failed', 'RECIPIENT_MISMATCH', kind='xml_recipient_mismatch')
    if extra_corrupt:
        good=xml(tag+'-IN',4); bad=good.replace(b'SYNTHETIC', b'CORRUPTED')
        inbound(4, f'qa-p15-{k}-corrupt-1', 'acknowledged', content=good, upload=bad, phase='T2_CORRUPT', kind='xml_corrupt_target')
    sql.append("insert into public.einvoice_inbound (id, company_id, provider, environment, provider_received_id, xml_storage_path, xml_sha256, xml_size_bytes, processing_status, last_error_code, quarantined_at, quarantine_reason, is_test) values\n  "+",\n  ".join(inb)+";")
    sql.append("insert into public.einvoice_events (company_id, outbound_id, inbound_id, from_state, to_state, source) values\n  "+",\n  ".join(ev)+";")
    sql.append(f"insert into public.einvoice_mandates (company_id, provider, environment, scope, granted_by_user_id, granted_by_name, granted_by_email, granted_by_role, statement_version, statement_sha256, statement_locale, authority_confirmed, grant_channel) values ({q(c)}, 'efaktura_sk', 'sandbox', '{{send,receive}}', {q(U[k])}, 'QA P15 Synthetic', {q(f'qa-p15-{k}@esblu-qa.invalid')}, 'owner', 'qa-p15-mandate-1', {q(H(b'qa-p15-mandate'))}, 'sk', true, 'enroll');")
    d1=pdf(tag+'-doc1'); p1=f"{c}/p15/doc-1.pdf"; F(k,'ai-inbox-documents',p1,d1,'pdf_document')
    did=uid_(c,'f',1)
    sql.append(f"insert into public.documents (id, company_id, user_id, storage_bucket, storage_path, original_filename, mime_type, file_size, document_type, status, content_sha256) values ({q(did)}, {q(c)}, {q(U[k])}, 'ai-inbox-documents', {q(p1)}, 'qa-p15-doc-1.pdf', 'application/pdf', {len(d1)}, 'invoice', 'confirmed', {q(H(d1))});")
    a1=pdf(tag+'-att1'); pa=f"{c}/p15/att-1.pdf"; F(k,'ai-inbox-documents',pa,a1,'attachment')
    sql.append(f"insert into public.document_attachments (company_id, user_id, document_id, storage_bucket, storage_path, original_filename, mime_type, file_size, attachment_type) values ({q(c)}, {q(U[k])}, {q(did)}, 'ai-inbox-documents', {q(pa)}, 'qa-p15-att-1.pdf', 'application/pdf', {len(a1)}, 'other');")
    if late:
        d2=pdf(tag+'-late'); p2=f"{c}/p15/doc-late.pdf"; F(k,'ai-inbox-documents',p2,d2,'pdf_document_late','T2_LATE')
        sql.append(f"insert into public.documents (company_id, user_id, storage_bucket, storage_path, original_filename, mime_type, file_size, document_type, status, content_sha256) values ({q(c)}, {q(U[k])}, 'ai-inbox-documents', {q(p2)}, 'qa-p15-doc-late.pdf', 'application/pdf', {len(d2)}, 'invoice', 'confirmed', {q(H(d2))});")
    sql.append(f"insert into public.vehicles (company_id, spz, znacka) values ({q(c)}, {q('QAP15'+k.upper()[:3])}, 'QA-P15 syntetické');")
    if orphan:
        o=xml(tag+'-ORPHAN',1); F(k,'einvoice-documents',f"{c}/orphan/qa-p15-orphan.xml",o,'orphan','ORPHAN')
company_set('t1', 3)
company_set('t2', 2, extra_corrupt=True, late=True, orphan=False)
company_set('iso', 2)
# PERF
c=C['perf']; tag='QA-P15-PERF'
sql.append(f"""-- PERF: 25 000 faktúr, 100 000 položiek, 25 000 udalostí, 5 000 prijatých (300 so súborom)
insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number, issue_date, currency, subtotal_amount, vat_total_amount, total_amount)
  select ('f1520000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, {q(c)}, 'issued', 'regular_invoice', 'finalized', now(), 'QA-P15-PERF-' || g, current_date, 'EUR', 100, 23, 123 from generate_series(1, 25000) g;
insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, vat_category_code, vat_rate)
  select ('f1520000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, p, 'Syntetická položka PERF', 1, 25, 'S', 23 from generate_series(1, 25000) g, generate_series(1, 4) p;
insert into public.invoice_events (invoice_id, event_type)
  select ('f1520000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'finalized' from generate_series(1, 25000) g;
insert into public.einvoice_inbound (company_id, provider, environment, provider_received_id, processing_status, is_test)
  select {q(c)}, 'efaktura_sk', 'sandbox', 'qa-p15-perf-nofile-' || g, 'acknowledged', true from generate_series(1, 4700) g;""")
perf=[]
for n in range(1,301):
    content=xml(tag,n); sh=H(content); rid=f'qa-p15-perf-{n}'; p=f"{c}/inbound/efaktura_sk/{rid}/{sh}.xml"
    F('perf','einvoice-documents',p,content,'perf_xml')
    perf.append(f"({q(c)}, 'efaktura_sk', 'sandbox', {q(rid)}, {q(p)}, {q(sh)}, {len(content)}, 'acknowledged', true)")
sql.append("insert into public.einvoice_inbound (company_id, provider, environment, provider_received_id, xml_storage_path, xml_sha256, xml_size_bytes, processing_status, is_test) values\n  "+",\n  ".join(perf)+";")
sql.append("commit;")
open('/tmp/p15c/seed.sql','w').write("\n".join(sql)+"\n")
man={'generated':'2026-11-24','users':U,'companies':C,'names':NAME,'files':files}
open('/tmp/p15c/manifest.json','w').write(json.dumps(man, indent=1))
from collections import Counter
print(len(files), Counter((f['company'],f['phase']) for f in files))
print(len(open('/tmp/p15c/seed.sql').read()))
