// =============================================================================
// Fakturácia — slovenský súlad (migrácia 20261008100000), offline PGlite so všetkými migráciami.
// Zákon č. 222/2004 Z. z. (§ 19 ods. 4, § 25, § 26, § 27, § 69 ods. 12, § 71–74, § 85o) a
// zákon č. 431/2002 Z. z. (§ 10, § 31–35). Iba syntetické dáta.
// npm run test:invoicing-sk
// =============================================================================
import assert from "node:assert/strict";
import { createPartnerHarness, type Row } from "./einvoice-partner-harness.ts";

let passed = 0;
const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`  ✗ ${label}\n    ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }
}
const h = await createPartnerHarness();
const CO = { A: "c5a00000-0000-4000-8000-00000000000a", B: "c5a00000-0000-4000-8000-00000000000b", N: "c5a00000-0000-4000-8000-00000000000c" };
const U = {
  owner: "a5a00000-0000-4000-8000-000000000001", adminFin: "a5a00000-0000-4000-8000-000000000002", admin: "a5a00000-0000-4000-8000-000000000003",
  employee: "a5a00000-0000-4000-8000-000000000004", accountant: "a5a00000-0000-4000-8000-000000000005", ownerB: "a5a00000-0000-4000-8000-000000000006",
  ownerN: "a5a00000-0000-4000-8000-000000000007",
};
const P = { sk: "b5a00000-0000-4000-8000-000000000001", noVat: "b5a00000-0000-4000-8000-000000000002", nonPayerBuyer: "b5a00000-0000-4000-8000-000000000003" };
await h.exec(`
  insert into auth.users (id) values ${Object.values(U).map((u) => `('${u}')`).join(", ")};
  insert into public.companies (id, name) values ('${CO.A}', 'A'), ('${CO.B}', 'B'), ('${CO.N}', 'Neplatiteľ');
  insert into public.company_members (company_id, user_id, role, permissions) values
    ('${CO.A}', '${U.owner}', 'owner', '{}'), ('${CO.A}', '${U.adminFin}', 'admin', '{"finance":{"view":true,"manage":true}}'),
    ('${CO.A}', '${U.admin}', 'admin', '{}'), ('${CO.A}', '${U.employee}', 'employee', '{"finance":{"view":true,"manage":true}}'),
    ('${CO.A}', '${U.accountant}', 'accountant', '{}'), ('${CO.B}', '${U.ownerB}', 'owner', '{}'), ('${CO.N}', '${U.ownerN}', 'owner', '{}');
  insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code, iban, vat_payer_status)
    values ('${CO.A}', 'Dodávateľ A s.r.o.', '35759500', '2021111111', 'SK2021111111', 'Ulica 1', 'Bratislava', '81101', 'SK', 'SK3112000000198742637541', 'vat_payer'),
           ('${CO.B}', 'Firma B s.r.o.', '36421928', '2022222220', 'SK2022222220', 'Ulica 2', 'Košice', '04001', 'SK', null, 'vat_payer'),
           ('${CO.N}', 'Neplatiteľ s.r.o.', '31411801', '2023333330', null, 'Ulica 3', 'Nitra', '94901', 'SK', null, 'non_vat_payer');
  insert into public.business_partners (id, company_id, kind, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code) values
    ('${P.sk}', '${CO.A}', 'customer', 'Odberateľ SK s.r.o.', '44444444', '2044444444', 'SK2044444444', 'Ulica 4', 'Žilina', '01001', 'SK'),
    ('${P.noVat}', '${CO.A}', 'customer', 'Odberateľ bez IČ DPH s.r.o.', '45555555', '2045555555', null, 'Ulica 5', 'Trnava', '91701', 'SK'),
    ('${P.nonPayerBuyer}', '${CO.N}', 'customer', 'Kupujúci s.r.o.', '46666666', '2046666666', null, 'Ulica 6', 'Poprad', '05801', 'SK');
`);

type Item = { description?: string; quantity?: number; unit_price?: number; vat_category_code?: string; vat_rate?: number };
const rpc = <T = Row>(uid: string, q: string, p: unknown[] = []) => h.as(uid, () => h.db.query<T>(q, p)).then((r) => r.rows);
const errOf = (p: Promise<unknown>) => p.then(() => "OK", (e) => String((e as Error).message));
async function draft(uid: string, company: string, opts: { kind?: string; partner?: string; corrects?: string | null; currency?: string; header?: Record<string, unknown>; items?: Item[] } = {}) {
  const [r] = await rpc<{ id: string }>(uid,
    "insert into public.invoices (company_id, direction, kind, issue_date, currency, customer_business_partner_id, source, corrects_invoice_id) values ($1, 'issued', $2, '2026-10-06', $3, $4, 'manual', $5) returning id",
    [company, opts.kind ?? "regular_invoice", opts.currency ?? "EUR", opts.partner ?? P.sk, opts.corrects ?? null]);
  const items = (opts.items ?? [{}]).map((i, k) => {
    const quantity = i.quantity ?? 1, unit_price = i.unit_price ?? 100, cat = i.vat_category_code ?? "S", rate = i.vat_rate ?? 23;
    const net = Math.round(quantity * unit_price * 100) / 100;
    const vat = cat === "S" ? Math.round(net * rate) / 100 : 0;
    return { description: i.description ?? `Služba ${k + 1}`, quantity, unit: "ks", unit_code: "H87", unit_price, price_mode: "net", vat_category_code: cat, vat_rate: rate,
      line_net_amount: net, line_vat_amount: vat, line_gross_amount: Math.round((net + vat) * 100) / 100 };
  });
  const header = { issue_date: "2026-10-06", due_date: "2026-10-20", currency: opts.currency ?? "EUR", customer_business_partner_id: opts.partner ?? P.sk, ...(opts.header ?? {}) };
  await rpc(uid, "select id from public.esblu_save_invoice_draft($1, $2::jsonb, $3::jsonb, null)", [r.id, JSON.stringify(header), JSON.stringify(items)]);
  return r.id;
}
const setFields = (uid: string, id: string, f: Record<string, unknown>) => rpc(uid, "select public.esblu_set_invoice_compliance_fields($1, $2::jsonb)", [id, JSON.stringify(f)]);
const finalize = (uid: string, id: string) => rpc(uid, "select public.esblu_finalize_invoice($1)", [id]);
const inv = async (id: string) => (await h.sql<Row>("select * from public.invoices where id = $1", [id])).rows[0];
const svc = (q: string, p: unknown[] = []) => h.asService(() => h.db.query(q, p));
const DELIVERY = { delivery_date: "2026-10-05" };

// --- 1. Povinné údaje faktúry / dátumy -------------------------------------------------
await check("§ 74 ods. 1 písm. d): bez dátumu dodania sa vydaná faktúra nefinalizuje; s dátumom áno (číslo FA, EUR sumy)", async () => {
  const id = await draft(U.owner, CO.A);
  assert.match(await errOf(finalize(U.owner, id)), /ESBLU_DELIVERY_DATE_REQUIRED/);
  const id2 = await draft(U.owner, CO.A, { header: DELIVERY });
  await finalize(U.owner, id2);
  const r = await inv(id2);
  assert.equal(r.document_status, "finalized");
  assert.match(String(r.invoice_number), /^FA2026\d{4}$/);
  assert.equal(Number(r.tax_base_eur), 100);
  assert.equal(Number(r.vat_total_eur), 23);
  const parties = (await h.sql<Row>("select role, legal_name, ic_dph from public.invoice_parties where invoice_id = $1 order by role", [id2])).rows;
  assert.deepEqual(parties.map((p) => [p.role, p.ic_dph]), [["buyer", "SK2044444444"], ["seller", "SK2021111111"]]);
});
await check("§ 27: sadzba S mimo 23 / 19 / 5 % sa neprijme (Esblu nerozhoduje o správnej sadzbe, iba o existujúcej)", async () => {
  const bad = await draft(U.owner, CO.A, { header: DELIVERY, items: [{ vat_rate: 21 }] });
  assert.match(await errOf(finalize(U.owner, bad)), /ESBLU_VAT_RATE_NOT_ALLOWED/);
  const ok = await draft(U.owner, CO.A, { header: DELIVERY, items: [{ vat_rate: 19 }, { vat_rate: 5, unit_price: 10 }] });
  await finalize(U.owner, ok);
  const b = (await h.sql<Row>("select vat_rate, taxable_amount, vat_amount from public.invoice_tax_breakdowns where invoice_id = $1 order by vat_rate", [ok])).rows;
  assert.deepEqual(b.map((x) => [Number(x.vat_rate), Number(x.taxable_amount), Number(x.vat_amount)]), [[5, 10, 0.5], [19, 100, 19]]);
});

// --- 2. Číslovanie a nemennosť ------------------------------------------------------------
let FINAL = "";
await check("číslovanie: súvislá séria FA, proforma má vlastnú sériu PF a nespotrebuje číslo FA", async () => {
  const a = await draft(U.owner, CO.A, { header: DELIVERY });
  await finalize(U.owner, a);
  const pf = await draft(U.owner, CO.A, { kind: "proforma" });
  await finalize(U.owner, pf);
  const b = await draft(U.owner, CO.A, { header: DELIVERY });
  await finalize(U.owner, b);
  const [na, npf, nb] = [(await inv(a)).invoice_number, (await inv(pf)).invoice_number, (await inv(b)).invoice_number].map(String);
  assert.match(npf, /^PF2026\d{4}$/);
  assert.equal(Number(nb.slice(-4)) - Number(na.slice(-4)), 1, `${na} → ${nb}`);
  FINAL = b;
});
await check("nemennosť: finalizovaný doklad nemožno prepísať (suma, číslo, dátum, položky, strany, rozpis) ani ako service_role", async () => {
  for (const q of [
    `update public.invoices set total_amount = 1 where id = '${FINAL}'`,
    `update public.invoices set invoice_number = 'X1' where id = '${FINAL}'`,
    `update public.invoices set issue_date = '2026-01-01' where id = '${FINAL}'`,
    `update public.invoices set correction_reason = 'zmena' where id = '${FINAL}'`,
    `update public.invoice_items set unit_price = 1 where invoice_id = '${FINAL}'`,
    `insert into public.invoice_parties (invoice_id, role, legal_name) values ('${FINAL}', 'buyer', 'Podvrh')`,
    `insert into public.invoice_tax_breakdowns (invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount) values ('${FINAL}', 'S', 5, 1, 0.05)`,
    `delete from public.invoices where id = '${FINAL}'`,
  ]) {
    assert.notEqual(await errOf(svc(q)), "OK", q.slice(0, 60));
  }
  assert.match(await errOf(setFields(U.owner, FINAL, { correction_reason: "nie" })), /ESBLU_INVOICE_NOT_DRAFT/);
});

// --- 3. Opravné doklady --------------------------------------------------------------------
await check("dobropis: bez dôvodu nie; s dôvodom áno (séria DO), originál nemenný, audit correction_created", async () => {
  const before = await inv(FINAL);
  const cn = await draft(U.owner, CO.A, { kind: "credit_note", corrects: FINAL, items: [{ unit_price: 40 }] });
  assert.match(await errOf(finalize(U.owner, cn)), /ESBLU_CORRECTION_REASON_REQUIRED/);
  await setFields(U.owner, cn, { correction_reason: "Zľava za oneskorené dodanie" });
  await finalize(U.owner, cn);
  const c = await inv(cn);
  assert.match(String(c.invoice_number), /^DO2026\d{4}$/);
  assert.equal(c.correction_reason, "Zľava za oneskorené dodanie");
  const after = await inv(FINAL);
  assert.deepEqual({ ...after, updated_at: null }, { ...before, updated_at: null }, "originál sa nezmenil");
  const ev = (await h.sql<Row>("select event_type, payload from public.invoice_events where invoice_id = $1 and event_type = 'correction_created'", [FINAL])).rows;
  assert.equal(ev.length, 1);
  assert.equal((ev[0].payload as Row).kind, "credit_note");
});
await check("dobropisy spolu nesmú prekročiť pôvodnú faktúru (+ ťarchopisy); ťarchopis zvýši strop", async () => {
  const over = await draft(U.owner, CO.A, { kind: "credit_note", corrects: FINAL, items: [{ unit_price: 70 }] });
  await setFields(U.owner, over, { correction_reason: "Vrátenie tovaru" });
  assert.match(await errOf(finalize(U.owner, over)), /ESBLU_CREDIT_EXCEEDS_ORIGINAL/);
  const dn = await draft(U.owner, CO.A, { kind: "debit_note", corrects: FINAL, items: [{ unit_price: 50 }], header: DELIVERY });
  await setFields(U.owner, dn, { correction_reason: "Dodatočné práce" });
  await finalize(U.owner, dn);
  assert.match(String((await inv(dn)).invoice_number), /^ID2026\d{4}$/);
  await finalize(U.owner, over);
});
await check("opravný doklad k proforme a úhrada dobropisu sú zakázané", async () => {
  const pf = await draft(U.owner, CO.A, { kind: "proforma" });
  await finalize(U.owner, pf);
  const cn = await draft(U.owner, CO.A, { kind: "credit_note", corrects: pf });
  await setFields(U.owner, cn, { correction_reason: "Oprava" });
  assert.match(await errOf(finalize(U.owner, cn)), /ESBLU_CORRECTION_OF_PROFORMA/);
  const cnId = (await h.sql<Row>("select id from public.invoices where kind = 'credit_note' and document_status = 'finalized' limit 1")).rows[0].id as string;
  assert.match(await errOf(rpc(U.owner, "select public.esblu_add_invoice_payment($1, 10, '2026-10-06', 'bank_transfer', null)", [cnId])), /ESBLU_PAYMENT_ON_CREDIT_NOTE/);
});

// --- 4. Zálohy ------------------------------------------------------------------------------
let ADV = "";
await check("proforma ≠ daňový doklad; faktúra k prijatej platbe vyžaduje dátum prijatia platby (§ 19 ods. 4)", async () => {
  const adv = await draft(U.owner, CO.A, { kind: "payment_received_invoice", items: [{ unit_price: 200 }] });
  assert.match(await errOf(finalize(U.owner, adv)), /ESBLU_PAYMENT_RECEIVED_DATE_REQUIRED/);
  await setFields(U.owner, adv, { tax_point_date: "2026-10-01" });
  await finalize(U.owner, adv);
  assert.match(String((await inv(adv)).invoice_number), /^FA2026\d{4}$/, "daňová séria");
  ADV = adv;
});
await check("konečná faktúra: odpočet zálohy do výšky zálohy; viac → odmietnuté; po finalizácii nemenný", async () => {
  const fin = await draft(U.owner, CO.A, { header: DELIVERY, items: [{ unit_price: 500 }] });
  await rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [fin, JSON.stringify([{ advance_invoice_id: ADV, vat_category_code: "S", vat_rate: 23, taxable_amount: 250, vat_amount: 57.5 }])]);
  assert.match(await errOf(finalize(U.owner, fin)), /ESBLU_ADVANCE_DEDUCTION_EXCEEDS/);
  await rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [fin, JSON.stringify([{ advance_invoice_id: ADV, vat_category_code: "S", vat_rate: 23, taxable_amount: 200, vat_amount: 46 }])]);
  await finalize(U.owner, fin);
  assert.notEqual(await errOf(svc(`delete from public.invoice_advance_deductions where invoice_id = '${fin}'`)), "OK");
  const second = await draft(U.owner, CO.A, { header: DELIVERY, items: [{ unit_price: 50 }] });
  await rpc(U.owner, "select public.esblu_set_invoice_advance_deductions($1, $2::jsonb)", [second, JSON.stringify([{ advance_invoice_id: ADV, vat_category_code: "S", vat_rate: 23, taxable_amount: 1, vat_amount: 0.23 }])]);
  assert.match(await errOf(finalize(U.owner, second)), /ESBLU_ADVANCE_DEDUCTION_EXCEEDS/, "záloha už celá odpočítaná");
});

// --- 5. DPH režimy ---------------------------------------------------------------------------
await check("prenesenie daňovej povinnosti (AE) vyžaduje IČ DPH odberateľa; rozpis nesie zákonný text (nie 0 % S)", async () => {
  const bad = await draft(U.owner, CO.A, { partner: P.noVat, header: { ...DELIVERY, customer_business_partner_id: P.noVat }, items: [{ vat_category_code: "AE", vat_rate: 0 }] });
  assert.match(await errOf(finalize(U.owner, bad)), /ESBLU_BUYER_VAT_ID_REQUIRED/);
  const ok = await draft(U.owner, CO.A, { header: DELIVERY, items: [{ vat_category_code: "AE", vat_rate: 0 }] });
  await finalize(U.owner, ok);
  const [b] = (await h.sql<Row>("select vat_category_code, vat_rate, vat_amount, vat_exemption_reason_code, vat_exemption_reason_text from public.invoice_tax_breakdowns where invoice_id = $1", [ok])).rows;
  assert.deepEqual([b.vat_category_code, Number(b.vat_rate), Number(b.vat_amount), b.vat_exemption_reason_code, b.vat_exemption_reason_text],
    ["AE", 0, 0, "VATEX-EU-AE", "Prenesenie daňovej povinnosti"]);
});
await check("oslobodenie (E) dostane text „Dodanie je oslobodené od dane“ (§ 74 ods. 1 písm. h)); O ≠ E ≠ S 0 %", async () => {
  const id = await draft(U.owner, CO.A, { header: DELIVERY, items: [{ vat_category_code: "E", vat_rate: 0 }, { vat_category_code: "O", vat_rate: 0, unit_price: 5 }] });
  await finalize(U.owner, id);
  const rows = (await h.sql<Row>("select vat_category_code, vat_exemption_reason_code, vat_exemption_reason_text from public.invoice_tax_breakdowns where invoice_id = $1 order by vat_category_code", [id])).rows;
  assert.deepEqual(rows.map((r) => [r.vat_category_code, r.vat_exemption_reason_code, r.vat_exemption_reason_text]), [
    ["E", null, "Dodanie je oslobodené od dane"], ["O", "VATEX-EU-O", "Plnenie nie je predmetom DPH v tuzemsku"]]);
  const zero = await draft(U.owner, CO.A, { header: DELIVERY, items: [{ vat_category_code: "S", vat_rate: 0 }] });
  assert.match(await errOf(finalize(U.owner, zero)), /ESBLU_VAT_RATE_NOT_ALLOWED/, "0 % so sadzbou S nie je oslobodenie");
});
await check("neplatiteľ DPH: kategória S odmietnutá, O áno", async () => {
  const bad = await draft(U.ownerN, CO.N, { partner: P.nonPayerBuyer, header: { ...DELIVERY, customer_business_partner_id: P.nonPayerBuyer } });
  assert.match(await errOf(finalize(U.ownerN, bad)), /ESBLU_NON_VAT_PAYER_CATEGORY/);
  const ok = await draft(U.ownerN, CO.N, { partner: P.nonPayerBuyer, header: { ...DELIVERY, customer_business_partner_id: P.nonPayerBuyer }, items: [{ vat_category_code: "O", vat_rate: 0 }] });
  await finalize(U.ownerN, ok);
  assert.equal(Number((await inv(ok)).vat_total_amount), 0);
});

// --- 6. Cudzia mena (§ 26) -------------------------------------------------------------------
let USD = "";
await check("cudzia mena: kurz povinný, dátum kurzu = deň pred vznikom daňovej povinnosti; EUR základ a daň sa uložia", async () => {
  const id = await draft(U.owner, CO.A, { currency: "USD", header: DELIVERY, items: [{ unit_price: 108 }] });
  assert.match(await errOf(finalize(U.owner, id)), /ESBLU_FX_RATE_REQUIRED/);
  await setFields(U.owner, id, { fx_rate: 1.08, fx_rate_date: "2026-10-05", fx_rate_source: "ECB" });
  assert.match(await errOf(finalize(U.owner, id)), /ESBLU_FX_RATE_DATE_INVALID/, "kurz v deň vzniku nie je kurz predchádzajúceho dňa");
  await setFields(U.owner, id, { fx_rate_date: "2026-10-04" });
  await finalize(U.owner, id);
  const r = await inv(id);
  assert.deepEqual([Number(r.tax_base_eur), Number(r.vat_total_eur), Number(r.fx_rate), r.fx_rate_source], [100, 23, 1.08, "ECB"]);
  USD = id;
});
await check("kurz po finalizácii nemenný (žiadny prepočet dnešným kurzom); EUR doklad kurz nesmie mať; oprava používa pôvodný kurz", async () => {
  assert.notEqual(await errOf(svc(`update public.invoices set fx_rate = 1.2, tax_base_eur = 90 where id = '${USD}'`)), "OK");
  const eur = await draft(U.owner, CO.A, { header: DELIVERY });
  await setFields(U.owner, eur, { fx_rate: 1, fx_rate_date: "2026-10-04", fx_rate_source: "ECB" });
  assert.match(await errOf(finalize(U.owner, eur)), /ESBLU_FX_RATE_NOT_ALLOWED_FOR_EUR/);
  const cn = await draft(U.owner, CO.A, { kind: "credit_note", corrects: USD, currency: "USD", items: [{ unit_price: 10 }] });
  await setFields(U.owner, cn, { correction_reason: "Zľava", fx_rate: 1.1, fx_rate_date: "2026-10-04", fx_rate_source: "ECB" });
  assert.match(await errOf(finalize(U.owner, cn)), /ESBLU_CORRECTION_FX_RATE_MISMATCH/);
  await setFields(U.owner, cn, { fx_rate: 1.08 });
  await finalize(U.owner, cn);
});

// --- 7. Úhrady -------------------------------------------------------------------------------
await check("úhrady: čiastočná, viacnásobná, preplatok; faktúra sa pri úhrade nemení (okrem stavu úhrady)", async () => {
  const id = await draft(U.owner, CO.A, { header: DELIVERY });
  await finalize(U.owner, id);
  const before = await inv(id);
  const pay = (amt: number) => rpc(U.owner, "select public.esblu_add_invoice_payment($1, $2, '2026-10-07', 'bank_transfer', 'VS')", [id, amt]);
  await pay(23);
  assert.equal((await inv(id)).payment_status, "partially_paid");
  await pay(100);
  assert.equal((await inv(id)).payment_status, "paid");
  await pay(5);
  assert.equal((await inv(id)).payment_status, "paid", "preplatok sa eviduje, stav paid");
  const after = await inv(id);
  for (const k of ["invoice_number", "total_amount", "subtotal_amount", "vat_total_amount", "issue_date", "document_status"]) assert.deepEqual(after[k], before[k], k);
  const n = (await h.sql<{ n: number }>("select count(*)::int n from public.invoice_payments where invoice_id = $1", [id])).rows[0].n;
  assert.equal(n, 3);
});

// --- 8. Audit trail, role, tenant ---------------------------------------------------------------
await check("audit: invoice_events je append-only aj pre service_role", async () => {
  assert.match(await errOf(svc("update public.invoice_events set payload = '{}'::jsonb")), /APPEND_ONLY/);
  assert.match(await errOf(svc("delete from public.invoice_events")), /APPEND_ONLY/);
});
await check("role: employee a admin bez financií nefinalizujú ani nenastavujú polia; accountant a admin-fin áno; iná firma nevidí", async () => {
  const id = await draft(U.owner, CO.A, { header: DELIVERY });
  for (const uid of [U.employee, U.admin]) {
    assert.match(await errOf(finalize(uid, id)), /FORBIDDEN|NOT_FOUND/, uid);
    assert.match(await errOf(setFields(uid, id, { correction_reason: "x y z" })), /FORBIDDEN|NOT_FOUND/, uid);
  }
  assert.match(await errOf(setFields(U.ownerB, id, { tax_point_date: "2026-10-01" })), /NOT_FOUND/);
  await setFields(U.accountant, id, { tax_point_date: "2026-10-05" });
  await finalize(U.adminFin, id);
  const seenByB = (await rpc<{ n: number }>(U.ownerB, "select count(*)::int n from public.invoice_advance_deductions")).at(0)?.n ?? 0;
  assert.equal(seenByB, 0, "odpočty záloh A nevidí firma B");
  const seenByEmp = (await rpc<{ n: number }>(U.employee, "select count(*)::int n from public.invoice_advance_deductions")).at(0)?.n ?? 0;
  assert.equal(seenByEmp, 0, "employee nevidí finančné väzby");
  assert.notEqual(await errOf(rpc(U.owner, "insert into public.invoice_advance_deductions (invoice_id, advance_invoice_id, vat_category_code, vat_rate, taxable_amount, vat_amount) values ($1, $2, 'S', 23, 1, 0.23)", [id, ADV])), "OK", "priamy zápis klientom zakázaný");
});
await check("compliance RPC: iba whitelisted polia (napr. total_amount / kind nie)", async () => {
  const id = await draft(U.owner, CO.A);
  assert.match(await errOf(setFields(U.owner, id, { total_amount: 1 })), /ESBLU_INVALID_FIELD/);
  assert.match(await errOf(setFields(U.owner, id, { kind: "credit_note" })), /ESBLU_INVALID_FIELD/);
});

await check("triggerové funkcie nie sú volateľné cez RPC (20261008100001), triggre ďalej fungujú", async () => {
  for (const f of ["esblu_invoice_finalize_compliance", "esblu_invoice_correction_event", "esblu_block_payment_on_credit_note"]) {
    const r = await h.sql<{ ok: boolean }>(`select has_function_privilege('authenticated', 'public.${f}()', 'execute') or has_function_privilege('anon', 'public.${f}()', 'execute') ok`);
    assert.equal(r.rows[0].ok, false, f);
  }
  const id = await draft(U.owner, CO.A, { header: { delivery_date: "2026-10-01" } });
  await finalize(U.adminFin, id);
  const ev = await h.sql<{ n: number }>("select count(*)::int n from public.invoice_events where invoice_id = $1 and event_type = 'finalized'", [id]);
  assert.equal(ev.rows[0].n, 1);
});

console.log(`\ninvoicing-sk: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
