// P1-5: offline meranie výkonu odtlačku exportu (PGlite, syntetická firma). N=25000 node --experimental-strip-types scripts/p15-fingerprint-perf-pglite.ts
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
const OV: Array<[string, string]> = [["20260916120000_add_company_billing_profile_and_business_partners.sql", "20260916094000_add_invoicing_core_schema.sql"],["20260916140000_finance_access_hardening.sql", "20260916094000_add_invoicing_core_schema.sql"]];
let o = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
for (const [f, b] of OV) { o = o.filter((x) => x !== f); o.splice(o.indexOf(b), 0, f); }
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(readFileSync("scripts/sql/pglite/supabase-platform-stub.sql", "utf8"));
for (const f of o) await db.exec(readFileSync(`supabase/migrations/${f}`, "utf8"));
const C = "e7000000-0000-4000-8000-00000000000a", U = "e5000000-0000-4000-8000-0000000000a1";
const N = Number(process.env.N ?? 5000);
await db.exec(`insert into auth.users (id, email) values ('${U}', 'p@example.invalid');
 set session_replication_role = replica;
 insert into public.companies (id, owner_id, name) values ('${C}', '${U}', 'QA-P15 PERF');
 insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number)
   select gen_random_uuid(), '${C}', 'issued', 'regular_invoice', 'finalized', now(), 'PERF-'||g from generate_series(1, ${N}) g;
 insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, vat_category_code)
   select i.id, g, 'Položka '||g, 1, 10, 'S' from public.invoices i, generate_series(1,4) g where i.company_id = '${C}';
 insert into public.invoice_events (invoice_id, event_type) select id, 'finalized' from public.invoices where company_id = '${C}';
 insert into public.einvoice_inbound (company_id, provider, environment, provider_received_id, xml_storage_path, xml_sha256)
   select '${C}', 'efaktura_sk', 'sandbox', 'perf-'||g, '${C}/inbound/efaktura_sk/perf-'||g||'/x.xml', encode(sha256(g::text::bytea),'hex') from generate_series(1, ${N / 5}) g;
 insert into public.documents (company_id, storage_bucket, storage_path, document_type)
   select '${C}', 'ai-inbox-documents', '${C}/doc-'||g||'.pdf', 'invoice' from generate_series(1, ${N / 10}) g;
 insert into public.vehicles (company_id, spz) select '${C}', 'PF'||g from generate_series(1, 200) g;
 set session_replication_role = origin;
 insert into storage.buckets (id, name) values ('ai-inbox-documents','ai-inbox-documents') on conflict do nothing;
 insert into storage.objects (bucket_id, name, metadata) select 'einvoice-documents', xml_storage_path, '{"eTag":"x"}' from public.einvoice_inbound where company_id = '${C}';
 insert into storage.objects (bucket_id, name, metadata) select 'ai-inbox-documents', storage_path, '{"eTag":"x"}' from public.documents where company_id = '${C}';`);
const t = async (label: string, sql: string) => { const s = performance.now(); const r = await db.query<Record<string, unknown>>(sql, [C]); console.log(label, Math.round(performance.now() - s), "ms", JSON.stringify(r.rows[0]).slice(0, 120)); };
const rows = await db.query<{ n: number }>(`select (select count(*) from public.invoices) + (select count(*) from public.invoice_items) + (select count(*) from public.invoice_events) + (select count(*) from public.einvoice_inbound) + (select count(*) from public.documents) n`);
console.log("rows", rows.rows[0].n);
await t("fingerprint", "select public.esblu_company_export_fingerprint($1)->'counts'->>'invoices' inv");
await t("file_list", "select count(*) n from public.esblu_company_export_file_list($1)");
await t("storage_fp", "select public.esblu_company_export_storage_fingerprint($1) fp");
