// =============================================================================
// E-Faktúra — SKUTOČNÝ PostgreSQL test (PGlite = PostgreSQL vo WASM) pre
//   20261001100000_einvoice_foundation.sql   (tabuľky, RLS, guardy, RPC)
//   20261001110000_einvoice_en16931_fields.sql (K/G/O, vat_payer_status,
//                                                unit_code, save draft)
// nad DOSLOVNÝM fakturačným reťazcom migrácií z repa.
//
// NIKDY sa nepripája na Supabase. Žiadne reálne dáta, žiadne volanie
// eFaktura.sk. Záver testu: snapshot finalizovanej faktúry sa načíta
// skutočným loaderom (lib/einvoice/load-finalized-invoice.ts) pod RLS
// daného používateľa a vygeneruje sa z neho UBL.
//
// SPUSTENIE (PGlite nie je závislosť projektu — nainštaluje sa bez uloženia):
//   npm i --no-save @electric-sql/pglite@0.5.8
//   npm run test:einvoice-db
// Inde nainštalovaný PGlite: PGLITE_DIR=/cesta/k/node_modules/@electric-sql/pglite
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFinalizedIssuedInvoiceSnapshot } from "../lib/einvoice/load-finalized-invoice.ts";
import { generateUbl } from "../lib/einvoice/ubl/generate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

type Row = Record<string, unknown>;
type Db = {
  exec: (sql: string) => Promise<unknown>;
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

async function loadPglite(): Promise<Db> {
  const dir = process.env.PGLITE_DIR;
  const main = dir ? pathToFileURL(path.join(dir, "dist/index.js")).href : "@electric-sql/pglite";
  const crypto = dir ? pathToFileURL(path.join(dir, "dist/contrib/pgcrypto.js")).href : "@electric-sql/pglite/contrib/pgcrypto";
  try {
    const { PGlite } = await import(main);
    const { pgcrypto } = await import(crypto);
    return new PGlite({ extensions: { pgcrypto } }) as Db;
  } catch (error) {
    console.error("PGlite nie je nainštalovaný: npm i --no-save @electric-sql/pglite@0.5.8  (alebo PGLITE_DIR=…)");
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

const db = await loadPglite();
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

// -----------------------------------------------------------------------------
// Schéma: kostra + skutočné fakturačné migrácie + migrácie E-Faktúry
// -----------------------------------------------------------------------------
await db.exec(read("scripts/sql/pglite/einvoice-baseline.sql"));
for (const migration of [
  "20260916120000_add_company_billing_profile_and_business_partners.sql",
  "20260916094000_add_invoicing_core_schema.sql",
  "20260916095000_add_invoicing_core_rpc.sql",
  "20260916100000_harden_invoice_trigger_execute_grants.sql",
  "20260916140000_finance_access_hardening.sql",
  "20260916150000_finalize_invoice_category_aware_vat.sql",
  "20260917100000_add_invoicing_en16931_p0_fields.sql",
  "20260920120000_add_received_invoice_core.sql",
  "20260920121000_add_invoice_dedupe.sql",
  "20260920122000_add_invoicing_en16931_p1_fields.sql",
  "20260920140000_direction_aware_invoice_finalize.sql",
  "20260920150000_harden_finalized_invoice_immutability.sql",
  "20260921100000_add_received_invoice_intake.sql",
  "20260921120000_finance_document_access_hardening.sql",
  "20260921160000_partner_payment_identifiers.sql",
  "20260923100000_add_accounting_handoff_lifecycle.sql",
  "20260923140000_harden_accounting_handoff.sql",
  "20260923170000_harden_client_role_privileges.sql",
  "20260923190000_canonical_price_mode.sql",
  "20260923210000_complete_handoff_package.sql",
  "20260929100000_closed_beta_p0_hardening.sql",
  // --- predmet testu ---
  "20261001100000_einvoice_foundation.sql",
  "20261001110000_einvoice_en16931_fields.sql",
]) {
  try {
    await db.exec(read(`supabase/migrations/${migration}`));
  } catch (error) {
    console.error(`Migrácia ${migration} zlyhala: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
// Produkčné verzie esblu_my_finance_* (accountant) — viď súbor.
await db.exec(read("scripts/sql/pglite/einvoice-prod-helpers.sql"));

// -----------------------------------------------------------------------------
// Syntetické firmy a roly (žiadne reálne údaje)
// -----------------------------------------------------------------------------
const CA = "a0000000-0000-4000-8000-000000000001";
const CB = "b0000000-0000-4000-8000-000000000002";
const U = {
  owner: "10000000-0000-4000-8000-000000000001",
  acc: "10000000-0000-4000-8000-000000000002",
  adminFin: "10000000-0000-4000-8000-000000000003",
  adminView: "10000000-0000-4000-8000-000000000004",
  admin: "10000000-0000-4000-8000-000000000005",
  emp: "10000000-0000-4000-8000-000000000006",
  empFlag: "10000000-0000-4000-8000-000000000007",
  b: "20000000-0000-4000-8000-000000000001",
};
const PARTNER_A = "d0000000-0000-4000-8000-00000000000a";
const PARTNER_B = "d0000000-0000-4000-8000-00000000000b";

await db.exec(`
  insert into auth.users (id) values ${Object.values(U).map((u) => `('${u}')`).join(", ")};
  insert into public.companies (id, name) values ('${CA}', 'Syntetická A s.r.o.'), ('${CB}', 'Syntetická B s.r.o.');
  insert into public.company_members (company_id, user_id, role, permissions) values
    ('${CA}', '${U.owner}', 'owner', '{}'),
    ('${CA}', '${U.acc}', 'accountant', '{}'),
    ('${CA}', '${U.adminFin}', 'admin', '{"finance":{"view":true,"manage":true}}'),
    ('${CA}', '${U.adminView}', 'admin', '{"finance":{"view":true}}'),
    ('${CA}', '${U.admin}', 'admin', '{}'),
    ('${CA}', '${U.emp}', 'employee', '{}'),
    ('${CA}', '${U.empFlag}', 'employee', '{"finance":{"view":true,"manage":true}}'),
    ('${CB}', '${U.b}', 'owner', '{}');
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code,
      country_code, iban, contact_email, electronic_address, electronic_address_scheme_id)
    values ('${CA}', 'Syntetická A s.r.o.', '11111111', '2020000000', 'SK2020000000', 'Testovacia 1', 'Bratislava', '81101',
      'SK', 'SK3112000000198742637541', 'fakturacia@example.test', '2020000000', '9950'),
           ('${CB}', 'Syntetická B s.r.o.', '22222222', '2030000000', 'SK2030000000', 'Skúšobná 2', 'Košice', '04001',
      'SK', null, null, null, null);
  insert into public.business_partners (id, company_id, kind, legal_name, ico, dic, ic_dph, address_line1, city,
      postal_code, country_code, electronic_address, electronic_address_scheme_id)
    values ('${PARTNER_A}', '${CA}', 'customer', 'Odberateľ & Syn <test>', '33333333', '2040000000', 'SK2040000000',
      'Príkladná 3', 'Žilina', '01001', 'SK', '2040000000', '9950'),
           ('${PARTNER_B}', '${CB}', 'customer', 'Odberateľ B', '44444444', null, null, 'Iná 4', 'Nitra', '94901', 'SK', null, null);
`);

/** Spustí fn ako `authenticated` s JWT daného používateľa, v transakcii s rollbackom pri chybe. */
async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await db.exec("set local role authenticated");
    const result = await fn();
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
/** Serverová cesta (service_role, obchádza RLS — ako Next.js server so service kľúčom). */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.exec("set local role service_role");
    const result = await fn();
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
async function allowed(uid: string, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    await as(uid, () => db.query(sql, params));
    return true;
  } catch {
    return false;
  }
}
async function errorOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
async function count(uid: string, table: string): Promise<number> {
  const { rows } = await as(uid, () => db.query<{ n: number }>(`select count(*)::int n from public.${table}`));
  return rows[0].n;
}

// -----------------------------------------------------------------------------
// Fixtúry faktúr cez SKUTOČNÉ RPC (save draft + finalize)
// -----------------------------------------------------------------------------
async function createDraft(uid: string, company: string, partner: string): Promise<string> {
  const { rows } = await as(uid, () =>
    db.query<{ id: string }>(
      `insert into public.invoices (company_id, direction, kind, issue_date, currency, customer_business_partner_id, source)
       values ($1, 'issued', 'regular_invoice', '2026-10-01', 'EUR', $2, 'manual') returning id`,
      [company, partner]
    )
  );
  return rows[0].id;
}
const ITEMS = [
  { description: "Práca <hodiny> & réžia", quantity: 2, unit: "hod", unit_code: "hur", unit_price: 50, price_mode: "net",
    vat_category_code: "S", vat_rate: 23, line_net_amount: 100, line_vat_amount: 23, line_gross_amount: 123 },
  { description: "Materiál", quantity: 1, unit: "ks", unit_code: "H87", unit_price: 10, price_mode: "net",
    vat_category_code: "S", vat_rate: 19, line_net_amount: 10, line_vat_amount: 1.9, line_gross_amount: 11.9 },
];
const HEADER = {
  issue_date: "2026-10-01", due_date: "2026-10-15", delivery_date: "2026-09-30", variable_symbol: "2026001",
  currency: "EUR", customer_business_partner_id: PARTNER_A, buyer_reference: "OBJ-REF-1",
  purchase_order_reference: "PO-77", payment_means_code: "30", payment_reference: "2026001",
};
async function saveDraft(uid: string, id: string, header: Row = HEADER, items: Row[] = ITEMS) {
  return as(uid, () =>
    db.query("select id from public.esblu_save_invoice_draft($1, $2::jsonb, $3::jsonb, null)", [id, JSON.stringify(header), JSON.stringify(items)])
  );
}
async function finalize(uid: string, id: string) {
  return as(uid, () => db.query("select public.esblu_finalize_invoice($1)", [id]));
}

const DRAFT_ONLY = await createDraft(U.owner, CA, PARTNER_A);
await saveDraft(U.owner, DRAFT_ONLY);
const INV = await createDraft(U.owner, CA, PARTNER_A);
await saveDraft(U.owner, INV);
await finalize(U.owner, INV);
const INV_B = await createDraft(U.b, CB, PARTNER_B);
await saveDraft(U.b, INV_B, { ...HEADER, customer_business_partner_id: PARTNER_B }, [ITEMS[0]]);
await finalize(U.b, INV_B);

// =============================================================================
// Phase B — EN16931 polia v existujúcom modeli
// =============================================================================
await check("save draft zapisuje BT-72/10/13/81/83 a unit_code (upper)", async () => {
  const { rows } = await db.query<Row>(
    "select delivery_date::text d, buyer_reference, purchase_order_reference, payment_means_code, payment_reference from public.invoices where id = $1",
    [DRAFT_ONLY]
  );
  assert.deepEqual(rows[0], { d: "2026-09-30", buyer_reference: "OBJ-REF-1", purchase_order_reference: "PO-77", payment_means_code: "30", payment_reference: "2026001" });
  const items = await db.query<{ unit_code: string }>("select unit_code from public.invoice_items where invoice_id = $1 order by position", [DRAFT_ONLY]);
  assert.deepEqual(items.rows.map((r) => r.unit_code), ["HUR", "H87"]);
});

await check("unit_code mimo formátu UN/ECE je odmietnutý", async () => {
  const msg = await errorOf(() => saveDraft(U.owner, DRAFT_ONLY, HEADER, [{ ...ITEMS[0], unit_code: "hodina" }]));
  assert.match(msg, /invoice_items_unit_code_format/);
});

await check("kategórie K/G/O sa dajú uložiť, neznáma kategória nie", async () => {
  for (const code of ["K", "G", "O"]) {
    await saveDraft(U.owner, DRAFT_ONLY, HEADER, [{ ...ITEMS[0], vat_category_code: code, vat_rate: 0, line_vat_amount: 0, line_gross_amount: 100 }]);
  }
  const msg = await errorOf(() => saveDraft(U.owner, DRAFT_ONLY, HEADER, [{ ...ITEMS[0], vat_category_code: "X" }]));
  assert.match(msg, /vat_category_code/);
  await saveDraft(U.owner, DRAFT_ONLY); // späť na S
});

await check("finalizácia K položky počíta 0 % DPH (bez zmeny finalizácie)", async () => {
  const id = await createDraft(U.owner, CA, PARTNER_A);
  await saveDraft(U.owner, id, HEADER, [{ ...ITEMS[0], vat_category_code: "K", vat_rate: 0, line_vat_amount: 0, line_gross_amount: 100 }]);
  await finalize(U.owner, id);
  const { rows } = await db.query<{ v: string; c: string }>(
    "select vat_amount::text v, vat_category_code c from public.invoice_tax_breakdowns where invoice_id = $1",
    [id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].c, "K");
  assert.equal(Number(rows[0].v), 0);
});

await check("vat_payer_status: vat_payer/non_vat_payer/null áno, iná hodnota nie", async () => {
  for (const v of ["vat_payer", "non_vat_payer", null]) {
    await db.query("update public.company_billing_profile set vat_payer_status = $1 where company_id = $2", [v, CB]);
  }
  const msg = await errorOf(() => db.query("update public.company_billing_profile set vat_payer_status = 'maybe' where company_id = $1", [CB]));
  assert.match(msg, /vat_payer_status/);
});

await check("finalizovaná faktúra ostáva nemenná (hlavička, položky, draft RPC)", async () => {
  // klient: RLS (iba draft) + trigger — zápis buď zlyhá, alebo nezasiahne nič
  await allowed(U.owner, "update public.invoices set buyer_reference = 'X' where id = $1", [INV]);
  await allowed(U.owner, "update public.invoice_items set unit_code = 'KGM' where invoice_id = $1", [INV]);
  assert.match(await errorOf(() => saveDraft(U.owner, INV)), /ESBLU_(DRAFT_NOT_FOUND|INVOICE_FINALIZED_IMMUTABLE)/);
  // ani service_role (server) nesmie meniť finalizovaný doklad — trigger
  assert.match(await errorOf(() => asService(() => db.query("update public.invoices set buyer_reference = 'X' where id = $1", [INV]))), /./);
  assert.match(await errorOf(() => asService(() => db.query("update public.invoice_items set unit_code = 'KGM' where invoice_id = $1", [INV]))), /./);
  const { rows } = await db.query<{ b: string }>("select buyer_reference b from public.invoices where id = $1", [INV]);
  assert.equal(rows[0].b, "OBJ-REF-1");
  const items = await db.query<{ u: string }>("select unit_code u from public.invoice_items where invoice_id = $1 order by position", [INV]);
  assert.deepEqual(items.rows.map((r) => r.u), ["HUR", "H87"]);
});

// =============================================================================
// Phase A — RLS matica, klientské zápisy, guardy, RPC
// =============================================================================
const ORG_A = "efk-org-a-synthetic";
await asService(() =>
  db.query(
    `insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id, org_status, peppol_eligible)
     values ($1, 'efaktura_sk', 'sandbox', $2, '9915:2020000000', 'active', true),
            ($3, 'efaktura_sk', 'sandbox', 'efk-org-b-synthetic', '9915:2030000000', 'active', true)`,
    [CA, ORG_A, CB]
  )
);

const TABLES = ["einvoice_organizations", "einvoice_outbound", "einvoice_inbound", "einvoice_webhook_events"] as const;

let outboundId = "";
let outboundKey = "";
await check("RPC: owner vytvorí pokus 1 (pending, deterministický idempotency key)", async () => {
  const { rows } = await as(U.owner, () =>
    db.query<Row>("select id, attempt, state, idempotency_key, provider, environment, company_id from public.esblu_einvoice_request_outbound($1, 'sandbox')", [INV])
  );
  const r = rows[0];
  assert.equal(r.attempt, 1);
  assert.equal(r.state, "pending");
  assert.equal(r.provider, "efaktura_sk");
  assert.equal(r.company_id, CA);
  assert.equal(r.idempotency_key, `esblu-out-${INV.replace(/-/g, "")}-1`);
  outboundId = r.id as string;
  outboundKey = r.idempotency_key as string;
});

await check("RPC idempotentné: druhé volanie (owner aj accountant) vráti ten istý pokus", async () => {
  const again = await as(U.owner, () => db.query<{ id: string }>("select id from public.esblu_einvoice_request_outbound($1, 'sandbox')", [INV]));
  const acc = await as(U.acc, () => db.query<{ id: string }>("select id from public.esblu_einvoice_request_outbound($1, 'sandbox')", [INV]));
  const adminFin = await as(U.adminFin, () => db.query<{ id: string }>("select id from public.esblu_einvoice_request_outbound($1, 'sandbox')", [INV]));
  assert.equal(again.rows[0].id, outboundId);
  assert.equal(acc.rows[0].id, outboundId);
  assert.equal(adminFin.rows[0].id, outboundId);
  const { rows } = await db.query<{ n: number }>("select count(*)::int n from public.einvoice_outbound where invoice_id = $1", [INV]);
  assert.equal(rows[0].n, 1);
});

await check("RPC zapíše invoice_events einvoice_send_requested (bez PII)", async () => {
  const { rows } = await as(U.owner, () =>
    db.query<{ payload: Row }>("select payload from public.invoice_events where invoice_id = $1 and event_type = 'einvoice_send_requested'", [INV])
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0].payload).sort(), ["attempt", "environment", "provider"]);
});

await check("RPC odmietne: admin bez financií, admin iba view, employee (aj s finance flagom)", async () => {
  for (const uid of [U.admin, U.adminView, U.emp, U.empFlag]) {
    assert.match(
      await errorOf(() => as(uid, () => db.query("select public.esblu_einvoice_request_outbound($1, 'sandbox')", [INV]))),
      /ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED/,
      uid
    );
  }
});

await check("RPC odmietne: cudzia firma, draft, chýbajúca org pre live, zlé prostredie", async () => {
  assert.match(await errorOf(() => as(U.b, () => db.query("select public.esblu_einvoice_request_outbound($1, 'sandbox')", [INV]))), /ESBLU_INVOICE_NOT_FOUND/);
  assert.match(await errorOf(() => as(U.owner, () => db.query("select public.esblu_einvoice_request_outbound($1, 'sandbox')", [INV_B]))), /ESBLU_INVOICE_NOT_FOUND/);
  assert.match(
    await errorOf(() => as(U.owner, () => db.query("select public.esblu_einvoice_request_outbound($1, 'sandbox')", [DRAFT_ONLY]))),
    /ESBLU_EINVOICE_INVOICE_NOT_FINALIZED_ISSUED/
  );
  assert.match(await errorOf(() => as(U.owner, () => db.query("select public.esblu_einvoice_request_outbound($1, 'live')", [INV]))), /ESBLU_EINVOICE_ORGANIZATION_NOT_READY/);
  assert.match(await errorOf(() => as(U.owner, () => db.query("select public.esblu_einvoice_request_outbound($1, 'prod')", [INV]))), /ESBLU_EINVOICE_INVALID_ENVIRONMENT/);
});

await check("RPC odmietne firmu bez peppol_eligible", async () => {
  await asService(() => db.query("update public.einvoice_organizations set peppol_eligible = false where company_id = $1", [CB]));
  assert.match(await errorOf(() => as(U.b, () => db.query("select public.esblu_einvoice_request_outbound($1, 'sandbox')", [INV_B]))), /ESBLU_EINVOICE_ORGANIZATION_NOT_READY/);
  await asService(() => db.query("update public.einvoice_organizations set peppol_eligible = true where company_id = $1", [CB]));
});

await check("RPC nie je spustiteľné pre anon", async () => {
  await db.exec("begin");
  try {
    await db.exec("set local role anon");
    await assert.rejects(db.query("select public.esblu_einvoice_request_outbound($1, 'sandbox')", [INV]), /permission denied/);
  } finally {
    await db.exec("rollback");
  }
});

// Serverové zápisy (service_role) — inbound + webhook
const INBOUND_A = uuidLike("e1");
await asService(() =>
  db.query(
    `insert into public.einvoice_inbound (id, company_id, provider, environment, provider_received_id, sender_participant_id, document_number, xml_sha256, xml_storage_path, is_test)
     values ($1, $2, 'efaktura_sk', 'sandbox', 'rcv-1', '9915:2040000000', 'FA-IN-1', $3, $4, true)`,
    [INBOUND_A, CA, "a".repeat(64), `${CA}/inbound/rcv-1.xml`]
  )
);
await asService(() =>
  db.query(
    `insert into public.einvoice_webhook_events (provider, environment, delivery_id, provider_org_id, company_id, event, body_sha256)
     values ('efaktura_sk', 'sandbox', 'whk-1', $1, $2, 'document.received', $3),
            ('efaktura_sk', 'sandbox', 'whk-unresolved', 'unknown-org', null, 'document.received', $3)`,
    [ORG_A, CA, "b".repeat(64)]
  )
);

await check("RLS čítanie: owner / accountant / admin s financiami / admin iba view vidia svoju firmu", async () => {
  for (const uid of [U.owner, U.acc, U.adminFin, U.adminView]) {
    assert.equal(await count(uid, "einvoice_organizations"), 1, `org ${uid}`);
    assert.equal(await count(uid, "einvoice_outbound"), 1, `out ${uid}`);
    assert.equal(await count(uid, "einvoice_inbound"), 1, `in ${uid}`);
    assert.equal(await count(uid, "einvoice_webhook_events"), 1, `whk ${uid}`); // nevyriešený (company_id null) nikdy
  }
});

await check("RLS čítanie: admin bez financií a employee (aj s finance flagom) nevidia nič", async () => {
  for (const uid of [U.admin, U.emp, U.empFlag]) {
    for (const table of TABLES) assert.equal(await count(uid, table), 0, `${table} ${uid}`);
  }
});

await check("RLS čítanie: iná firma nevidí dáta firmy A (žiadny cross-company leak)", async () => {
  const { rows } = await as(U.b, () =>
    db.query<{ n: number }>(
      `select (select count(*) from public.einvoice_outbound where company_id = '${CA}')
            + (select count(*) from public.einvoice_inbound where company_id = '${CA}')
            + (select count(*) from public.einvoice_organizations where company_id = '${CA}')
            + (select count(*) from public.einvoice_webhook_events where company_id = '${CA}' or company_id is null) n`
    )
  );
  assert.equal(Number(rows[0].n), 0);
  assert.equal(await count(U.b, "einvoice_organizations"), 1);
});

await check("klient (aj owner) nemôže do einvoice_* tabuliek zapisovať — ani insert, update, delete", async () => {
  const attempts: Array<[string, string, unknown[]]> = [
    ["org insert", "insert into public.einvoice_organizations (company_id, provider, environment) values ($1, 'mock', 'live')", [CA]],
    ["org update", "update public.einvoice_organizations set peppol_eligible = true where company_id = $1", [CA]],
    ["org delete", "delete from public.einvoice_organizations where company_id = $1", [CA]],
    ["out insert", "insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt, idempotency_key) values ($1, $2, 'efaktura_sk', 'sandbox', 9, 'client-forged-key-0001')", [CA, INV]],
    ["out update", "update public.einvoice_outbound set state = 'delivered' where id = $1", [outboundId]],
    ["out delete", "delete from public.einvoice_outbound where id = $1", [outboundId]],
    ["in insert", "insert into public.einvoice_inbound (company_id, provider, environment, provider_received_id) values ($1, 'efaktura_sk', 'sandbox', 'forged')", [CA]],
    ["in update", "update public.einvoice_inbound set processing_status = 'parsed' where id = $1", [INBOUND_A]],
    ["whk insert", "insert into public.einvoice_webhook_events (provider, environment, delivery_id, event, body_sha256) values ('efaktura_sk', 'sandbox', 'forged', 'x', $1)", ["c".repeat(64)]],
    ["whk update", "update public.einvoice_webhook_events set processing_status = 'processed'", []],
  ];
  for (const uid of [U.owner, U.acc, U.adminFin]) {
    for (const [label, sql, params] of attempts) {
      assert.equal(await allowed(uid, sql, params), false, `${label} ${uid}`);
    }
  }
  const { rows } = await db.query<{ state: string }>("select state from public.einvoice_outbound where id = $1", [outboundId]);
  assert.equal(rows[0].state, "pending");
});

await check("guard: server nemôže vložiť pokus s cudzou firmou ani pre draft", async () => {
  assert.match(
    await errorOf(() => asService(() => db.query(
      "insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt, idempotency_key) values ($1, $2, 'efaktura_sk', 'sandbox', 5, 'srv-mismatch-key-000001')",
      [CB, INV]
    ))),
    /ESBLU_EINVOICE_COMPANY_MISMATCH/
  );
  assert.match(
    await errorOf(() => asService(() => db.query(
      "insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt, idempotency_key) values ($1, $2, 'efaktura_sk', 'sandbox', 1, 'srv-draft-key-00000001')",
      [CA, DRAFT_ONLY]
    ))),
    /ESBLU_EINVOICE_INVOICE_NOT_FINALIZED_ISSUED/
  );
});

await check("duplicita: druhý aktívny pokus a duplicitný idempotency key sú odmietnuté", async () => {
  assert.match(
    await errorOf(() => asService(() => db.query(
      "insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt, idempotency_key) values ($1, $2, 'efaktura_sk', 'sandbox', 2, 'srv-second-active-00001')",
      [CA, INV]
    ))),
    /einvoice_outbound_one_active_per_invoice/
  );
  const other = await createDraft(U.owner, CA, PARTNER_A);
  await saveDraft(U.owner, other);
  await finalize(U.owner, other);
  assert.match(
    await errorOf(() => asService(() => db.query(
      "insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt, idempotency_key) values ($1, $2, 'efaktura_sk', 'sandbox', 1, $3)",
      [CA, other, outboundKey]
    ))),
    /idempotency_key/
  );
});

await check("guard: identita pokusu je nemenná, hash sa po zápise nemení", async () => {
  await asService(() => db.query("update public.einvoice_outbound set ubl_sha256 = $1, state = 'validated' where id = $2", ["d".repeat(64), outboundId]));
  for (const [label, sql] of [
    ["invoice_id", `update public.einvoice_outbound set invoice_id = '${DRAFT_ONLY}' where id = $1`],
    ["company_id", `update public.einvoice_outbound set company_id = '${CB}' where id = $1`],
    ["idempotency_key", "update public.einvoice_outbound set idempotency_key = 'changed-key-0000000001' where id = $1"],
    ["ubl_sha256", `update public.einvoice_outbound set ubl_sha256 = '${"e".repeat(64)}' where id = $1`],
    ["environment", "update public.einvoice_outbound set environment = 'live' where id = $1"],
  ]) {
    assert.match(await errorOf(() => asService(() => db.query(sql, [outboundId]))), /ESBLU_EINVOICE_OUTBOUND_IDENTITY_IMMUTABLE/, label);
  }
});

await check("terminálny stav: failed sa nemení; nový pokus = attempt 2 s novým kľúčom", async () => {
  await asService(() => db.query("update public.einvoice_outbound set state = 'failed', error_message = 'synthetic' where id = $1", [outboundId]));
  assert.match(
    await errorOf(() => asService(() => db.query("update public.einvoice_outbound set state = 'sent' where id = $1", [outboundId]))),
    /ESBLU_EINVOICE_OUTBOUND_TERMINAL/
  );
  const { rows } = await as(U.owner, () =>
    db.query<{ id: string; attempt: number; idempotency_key: string }>("select id, attempt, idempotency_key from public.esblu_einvoice_request_outbound($1, 'sandbox')", [INV])
  );
  assert.notEqual(rows[0].id, outboundId);
  assert.equal(rows[0].attempt, 2);
  assert.equal(rows[0].idempotency_key, `esblu-out-${INV.replace(/-/g, "")}-2`);
});

await check("finalizovaná faktúra s aktívnym pokusom sa nedá zmazať (FK restrict + immutability)", async () => {
  assert.match(await errorOf(() => asService(() => db.query("delete from public.invoices where id = $1", [INV]))), /./);
});

await check("inbound: duplicita provider_received_id, cudzí koncept a zmena hashu sú odmietnuté", async () => {
  assert.match(
    await errorOf(() => asService(() => db.query(
      "insert into public.einvoice_inbound (company_id, provider, environment, provider_received_id) values ($1, 'efaktura_sk', 'sandbox', 'rcv-1')",
      [CA]
    ))),
    /duplicate key/
  );
  assert.match(
    await errorOf(() => asService(() => db.query("update public.einvoice_inbound set invoice_id = $1 where id = $2", [INV_B, INBOUND_A]))),
    /ESBLU_EINVOICE_COMPANY_MISMATCH/
  );
  assert.match(
    await errorOf(() => asService(() => db.query("update public.einvoice_inbound set xml_sha256 = $1 where id = $2", ["f".repeat(64), INBOUND_A]))),
    /ESBLU_EINVOICE_INBOUND_IDENTITY_IMMUTABLE/
  );
  await asService(() => db.query("update public.einvoice_inbound set processing_status = 'acknowledged', acknowledged_at = now() where id = $1", [INBOUND_A]));
});

await check("webhook: duplicitný delivery_id je odmietnutý (dedupe), neplatný hash tiež", async () => {
  assert.match(
    await errorOf(() => asService(() => db.query(
      "insert into public.einvoice_webhook_events (provider, environment, delivery_id, event, body_sha256) values ('efaktura_sk', 'sandbox', 'whk-1', 'document.received', $1)",
      ["b".repeat(64)]
    ))),
    /duplicate key/
  );
  assert.match(
    await errorOf(() => asService(() => db.query(
      "insert into public.einvoice_webhook_events (provider, environment, delivery_id, event, body_sha256) values ('efaktura_sk', 'sandbox', 'whk-2', 'x', 'not-a-hash')"
    ))),
    /check/
  );
});

await check("organizácia: company_id/provider/environment/provider_org_id sú nemenné, jedna na firmu a prostredie", async () => {
  assert.match(
    await errorOf(() => asService(() => db.query("update public.einvoice_organizations set company_id = $1 where company_id = $2", [CB, CA]))),
    /ESBLU_EINVOICE_ORGANIZATION_IDENTITY_IMMUTABLE|duplicate key/
  );
  assert.match(
    await errorOf(() => asService(() => db.query("update public.einvoice_organizations set provider_org_id = 'other' where company_id = $1", [CA]))),
    /ESBLU_EINVOICE_ORGANIZATION_IDENTITY_IMMUTABLE/
  );
  assert.match(
    await errorOf(() => asService(() => db.query(
      "insert into public.einvoice_organizations (company_id, provider, environment) values ($1, 'mock', 'sandbox')",
      [CA]
    ))),
    /duplicate key/
  );
});

await check("storage bucket einvoice-documents je privátny a bez klientských politík", async () => {
  const { rows } = await db.query<{ public: boolean; file_size_limit: number }>("select public, file_size_limit from storage.buckets where id = 'einvoice-documents'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].public, false);
  const pol = await db.query<{ n: number }>("select count(*)::int n from pg_policies where schemaname = 'storage' and (qual like '%einvoice-documents%' or with_check like '%einvoice-documents%')");
  assert.equal(pol.rows[0].n, 0);
});

await check("guard/trigger funkcie nie sú spustiteľné klientom", async () => {
  const { rows } = await db.query<{ f: string; can: boolean }>(
    `select p.proname f, has_function_privilege('authenticated', p.oid, 'execute') can
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('esblu_einvoice_outbound_guard', 'esblu_einvoice_inbound_guard', 'esblu_einvoice_organization_guard')`
  );
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(r.can, false, r.f);
});

// =============================================================================
// E2E: skutočný loader pod RLS používateľa → UBL
// =============================================================================
/** Minimálny adaptér supabase-js → PGlite (iba to, čo loader používa). */
function pgliteClient(uid: string) {
  type Filter = { column: string; value: unknown };
  function builder(table: string) {
    let columns = "*";
    const filters: Filter[] = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    const run = async (single: boolean) => {
      const where = filters.map((f, i) => `${f.column} = $${i + 1}`).join(" and ");
      // to_jsonb = rovnaká serializácia ako PostgREST (dátumy ako text, numeric ako číslo)
      const inner = `select ${columns} from public.${table}${where ? ` where ${where}` : ""}${orderBy ? ` order by ${orderBy.column} ${orderBy.ascending ? "asc" : "desc"}` : ""}`;
      const sql = `select to_jsonb(t) j from (${inner}) t`;
      try {
        const res = await as(uid, () => db.query<{ j: Row }>(sql, filters.map((f) => f.value)));
        const rows = res.rows.map((r) => r.j);
        if (single) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      } catch (error) {
        return { data: null, error };
      }
    };
    const api = {
      select(cols: string) { columns = cols; return api; },
      eq(column: string, value: unknown) { filters.push({ column, value }); return api; },
      order(column: string, opts: { ascending: boolean }) { orderBy = { column, ascending: opts.ascending }; return api; },
      maybeSingle() { return run(true); },
      returns() { return run(false); },
    };
    return api;
  }
  return { from: builder } as unknown as Parameters<typeof loadFinalizedIssuedInvoiceSnapshot>[0];
}

await check("E2E: owner načíta snapshot finalizovanej faktúry pod RLS a vygeneruje UBL (deterministicky)", async () => {
  const loaded = await loadFinalizedIssuedInvoiceSnapshot(pgliteClient(U.owner), INV, CA);
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  if (!loaded.ok) return;
  const a = generateUbl(loaded.snapshot);
  const b = generateUbl(loaded.snapshot);
  assert.equal(a.ok, true, JSON.stringify(a.ok ? null : a.issues));
  if (!a.ok || !b.ok) return;
  assert.equal(a.sha256, b.sha256);
  assert.match(a.xml, /<cbc:BuyerReference>OBJ-REF-1<\/cbc:BuyerReference>/);
  assert.match(a.xml, /<cbc:RegistrationName>Odberateľ &amp; Syn &lt;test&gt;<\/cbc:RegistrationName>/);
  assert.match(a.xml, /unitCode="HUR"/);
  assert.match(a.xml, /<cbc:EndpointID schemeID="9950">2020000000<\/cbc:EndpointID>/);
  assert.match(a.xml, /<cbc:PayableAmount currencyID="EUR">134\.90<\/cbc:PayableAmount>/);
});

await check("E2E: accountant a admin s financiami načítajú, employee / admin bez financií / cudzia firma nie", async () => {
  for (const uid of [U.acc, U.adminFin]) {
    const r = await loadFinalizedIssuedInvoiceSnapshot(pgliteClient(uid), INV, CA);
    assert.equal(r.ok, true, uid);
  }
  for (const uid of [U.emp, U.empFlag, U.admin]) {
    const r = await loadFinalizedIssuedInvoiceSnapshot(pgliteClient(uid), INV, CA);
    assert.equal(r.ok ? "ok" : r.reason, "NOT_FOUND", uid);
  }
  const foreign = await loadFinalizedIssuedInvoiceSnapshot(pgliteClient(U.b), INV, CB);
  assert.equal(foreign.ok ? "ok" : foreign.reason, "NOT_FOUND");
  // podvrhnuté activeCompanyId: RLS aj tak nič nevráti
  const forged = await loadFinalizedIssuedInvoiceSnapshot(pgliteClient(U.b), INV, CA);
  assert.equal(forged.ok ? "ok" : forged.reason, "NOT_FOUND");
});

await check("E2E: draft sa neexportuje (NOT_FINALIZED)", async () => {
  const r = await loadFinalizedIssuedInvoiceSnapshot(pgliteClient(U.owner), DRAFT_ONLY, CA);
  assert.equal(r.ok ? "ok" : r.reason, "NOT_FINALIZED");
});

function uuidLike(prefix: string): string {
  return `${prefix.padEnd(8, "0")}-0000-4000-8000-000000000001`;
}

console.log(`\neinvoice-pglite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
