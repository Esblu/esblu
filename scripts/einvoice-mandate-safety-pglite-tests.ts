// =============================================================================
// E-Faktúra — mandát (poverenie), brána odosielania, deregistrácia, alerty,
// izolácia tenantov a ochrana proti duplicitám. PGlite, čistý replay VŠETKÝCH
// migrácií (vrátane 20261122100000 / 110000 / 120000). Nikdy staging/produkcia.
//
//   npm run test:einvoice-mandate-db
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const MIGRATIONS = "supabase/migrations";
const REPLAY_ORDER_OVERRIDES: Array<[string, string]> = [
  ["20260916120000_add_company_billing_profile_and_business_partners.sql", "20260916094000_add_invoicing_core_schema.sql"],
  ["20260916140000_finance_access_hardening.sql", "20260916094000_add_invoicing_core_schema.sql"],
];
function replayOrder(files: string[]): string[] {
  let out = [...files].sort();
  for (const [file, before] of REPLAY_ORDER_OVERRIDES) {
    out = out.filter((f) => f !== file);
    out.splice(out.indexOf(before), 0, file);
  }
  return out;
}
const NEW = [
  "20261122100000_einvoice_mandates.sql",
  "20261122110000_einvoice_deregistration_jobs.sql",
  "20261122120000_einvoice_ops_alerts.sql",
];

type Row = Record<string, unknown>;
const db = new PGlite({ extensions: { pgcrypto } });
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 5).join("\n       ") : String(error)}`);
  }
}

await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
const files = replayOrder(readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith(".sql")));
for (const f of NEW) assert.ok(files.includes(f), f);
for (const f of files) {
  try {
    await db.exec(read(`${MIGRATIONS}/${f}`));
  } catch (error) {
    console.error(`Migrácia ${f} zlyhala: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

type Who = { role: "authenticated" | "service_role" | "anon"; uid?: string; session?: string };
type Outcome = { layer: "ok" | "privilege" | "error"; message: string; data: Row[] };
async function run(who: Who, sql: string, params: unknown[] = [], commit = false): Promise<Outcome> {
  await db.exec("begin");
  let ok = false;
  try {
    const claims = who.role === "authenticated" ? { sub: who.uid, role: "authenticated", session_id: who.session } : { role: who.role };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    if (who.uid) await db.query("select set_config('request.jwt.claim.sub', $1, true)", [who.uid]);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query<Row>(sql, params);
    ok = true;
    return { layer: "ok", message: "", data: r.rows };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const message = e.message ?? String(error);
    if (e.code === "42501" && /permission denied/.test(message)) return { layer: "privilege", message, data: [] };
    return { layer: "error", message: `${e.code ?? "?"} ${message}`, data: [] };
  } finally {
    await db.exec(commit && ok ? "commit" : "rollback");
  }
}
const su = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const svc: Who = { role: "service_role" };
const svcCommit = (sql: string, params: unknown[] = []) => run(svc, sql, params, true);

// -----------------------------------------------------------------------------
// Seed: firma A (owner, admin bez financií, admin s finance.manage, účtovník,
// zamestnanec) a firma B (owner). Syntetické údaje.
// -----------------------------------------------------------------------------
const U = {
  owner: "f1000000-0000-4000-8000-0000000000a1",
  admin: "f1000000-0000-4000-8000-0000000000a2",
  adminFin: "f1000000-0000-4000-8000-0000000000a3",
  accountant: "f1000000-0000-4000-8000-0000000000a5",
  employee: "f1000000-0000-4000-8000-0000000000a4",
  ownerB: "f1000000-0000-4000-8000-0000000000b1",
};
const S: Record<keyof typeof U, string> = {
  owner: "f2000000-0000-4000-8000-0000000000a1",
  admin: "f2000000-0000-4000-8000-0000000000a2",
  adminFin: "f2000000-0000-4000-8000-0000000000a3",
  accountant: "f2000000-0000-4000-8000-0000000000a5",
  employee: "f2000000-0000-4000-8000-0000000000a4",
  ownerB: "f2000000-0000-4000-8000-0000000000b1",
};
const C = { a: "f3000000-0000-4000-8000-00000000000a", b: "f3000000-0000-4000-8000-00000000000b" };
const INV = { a1: "f4000000-0000-4000-8000-0000000000a1", a2: "f4000000-0000-4000-8000-0000000000a2", a3: "f4000000-0000-4000-8000-0000000000a3", b1: "f4000000-0000-4000-8000-0000000000b1" };
const who = (k: keyof typeof U): Who => ({ role: "authenticated", uid: U[k], session: S[k] });
const SHA = (c: string) => c.repeat(64).slice(0, 64);

await db.exec(`
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
    ('${U.owner}', 'owner@example.invalid', now(), '{"full_name":"Olga Ownerová"}'),
    ('${U.admin}', 'admin@example.invalid', now(), '{}'),
    ('${U.adminFin}', 'adminfin@example.invalid', now(), '{"name":"Adam Financie"}'),
    ('${U.accountant}', 'acc@example.invalid', now(), '{}'),
    ('${U.employee}', 'emp@example.invalid', now(), '{}'),
    ('${U.ownerB}', 'ownerb@example.invalid', now(), '{}');
  insert into auth.sessions (id, user_id) values
    ('${S.owner}', '${U.owner}'), ('${S.admin}', '${U.admin}'), ('${S.adminFin}', '${U.adminFin}'),
    ('${S.accountant}', '${U.accountant}'), ('${S.employee}', '${U.employee}'), ('${S.ownerB}', '${U.ownerB}');
  set session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.owner}', 'Firma A s.r.o.'), ('${C.b}', '${U.ownerB}', 'Firma B s.r.o.');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.a}', '${U.owner}', 'owner', 'active', '{}'),
    ('${C.a}', '${U.admin}', 'admin', 'active', '{}'),
    ('${C.a}', '${U.adminFin}', 'admin', 'active', '{"finance":{"view":true,"manage":true}}'),
    ('${C.a}', '${U.accountant}', 'accountant', 'active', '{}'),
    ('${C.a}', '${U.employee}', 'employee', 'active', '{}'),
    ('${C.b}', '${U.ownerB}', 'owner', 'active', '{}');
  insert into public.company_entitlements (company_id, entitlement_key, source, status, limit_value, limit_period) values
    ('${C.a}', 'einvoice', 'manual', 'active', null, null), ('${C.b}', 'einvoice', 'manual', 'active', null, null);
  insert into public.invoices (id, company_id, direction, kind, document_status, finalized_at, invoice_number) values
    ('${INV.a1}', '${C.a}', 'issued', 'regular_invoice', 'finalized', now(), 'A-1'),
    ('${INV.a2}', '${C.a}', 'issued', 'regular_invoice', 'finalized', now(), 'A-2'),
    ('${INV.a3}', '${C.a}', 'issued', 'regular_invoice', 'finalized', now(), 'A-3'),
    ('${INV.b1}', '${C.b}', 'issued', 'regular_invoice', 'finalized', now(), 'B-1');
  insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id, peppol_eligible, reception_status, onboarding_snapshot) values
    ('${C.a}', 'efaktura_sk', 'sandbox', 'org-a', '9915:a0000001', true, 'active', '{"ico":"12345678"}'),
    ('${C.b}', 'efaktura_sk', 'sandbox', 'org-b', '9915:b0000001', true, 'active', '{"ico":"87654321"}');
  insert into public.einvoice_rollout (company_id, environment, stage, changed_by) values
    ('${C.a}', 'sandbox', 'internal', 'test'), ('${C.b}', 'sandbox', 'internal', 'test');
  set session_replication_role = origin;
`);

const grantSql = `select public.esblu_einvoice_mandate_grant($1, $2, 'sandbox', $3::text[], 'efaktura-mandate-2026-11-19', $4, 'sk', true, 'enroll', 'req-1', $5, $6) id`;
const grant = (actor: string, company: string, scope = ["send", "receive"]) =>
  svcCommit(grantSql, [actor, company, `{${scope.join(",")}}`, SHA("a"), SHA("b"), SHA("c")]);
const confirm = (id: string, scope = ["send", "receive"]) =>
  svcCommit(`select (public.esblu_einvoice_mandate_confirm($1, $2::text[], 'enrolled', $3, '9915:a0000001')).id`, [id, `{${scope.join(",")}}`, SHA("d")]);
const effective = async (company: string, scope = "send") =>
  (await su<{ e: boolean }>(`select public.esblu_einvoice_mandate_effective($1, 'sandbox', $2) e`, [company, scope]))[0].e;
let idemSeq = 0;
const insertOutbound = (company: string, invoice: string, attempt = 1, state = "queued") =>
  svcCommit(
    `insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt, idempotency_key, state, next_retry_at, ubl_sha256, ubl_storage_path, ubl_size_bytes, receiver_participant_id)
     values ($1, $2, 'efaktura_sk', 'sandbox', $3, $4, $5, now() - interval '1 minute', $6, $7, 100, '9915:c0000001') returning id`,
    [company, invoice, attempt, `idem-key-test-${String(++idemSeq).padStart(8, "0")}`, state, SHA("e"), `${company}/outbound/${invoice}/${SHA("e")}.xml`]
  );

// ============================================================================= 1. mandát
let mandateA = "";
await check("mandát: grant — employee / admin bez financií / iná firma zamietnutí; owner OK so snapshotom", async () => {
  for (const actor of [U.employee, U.admin, U.ownerB]) {
    const o = await grant(actor, C.a);
    assert.equal(o.layer, "error");
    assert.match(o.message, /ESBLU_FORBIDDEN_FINANCE_MANAGE_REQUIRED/);
  }
  const o = await grant(U.owner, C.a);
  assert.equal(o.layer, "ok", o.message);
  mandateA = String(o.data[0].id);
  const [m] = await su(`select * from public.einvoice_mandates where id = $1`, [mandateA]);
  assert.equal(m.granted_by_email, "owner@example.invalid");
  assert.equal(m.granted_by_name, "Olga Ownerová");
  assert.equal(m.granted_by_role, "owner");
  assert.equal(m.provider_org_id, "org-a");
  assert.equal(m.statement_sha256, SHA("a"));
  assert.equal(m.effective_at, null);
  assert.equal(await effective(C.a), false, "pred potvrdením poskytovateľom nie je účinný");
});

await check("mandát: grant odmietne chýbajúce potvrdenie oprávnenia a neplatný rozsah / hash", async () => {
  let o = await svcCommit(`select public.esblu_einvoice_mandate_grant($1, $2, 'sandbox', '{send}', 'v1', $3, 'sk', false, 'enroll', null, null, null)`, [U.owner, C.a, SHA("a")]);
  assert.match(o.message, /AUTHORITY_REQUIRED/);
  o = await svcCommit(`select public.esblu_einvoice_mandate_grant($1, $2, 'sandbox', '{send,archive}', 'v1', $3, 'sk', true, 'enroll', null, null, null)`, [U.owner, C.a, SHA("a")]);
  assert.match(o.message, /einvoice_mandates_scope_check/);
  o = await svcCommit(`select public.esblu_einvoice_mandate_grant($1, $2, 'sandbox', '{send}', 'v1', 'nothex', 'sk', true, 'enroll', null, null, null)`, [U.owner, C.a]);
  assert.match(o.message, /check/);
});

await check("mandát: confirm → účinný (send+receive); idempotentný; write-once", async () => {
  let o = await confirm(mandateA);
  assert.equal(o.layer, "ok", o.message);
  assert.equal(await effective(C.a, "send"), true);
  assert.equal(await effective(C.a, "receive"), true);
  assert.equal(await effective(C.b, "send"), false, "iná firma nič");
  o = await confirm(mandateA, ["send"]);
  assert.equal(o.layer, "ok", "opakované potvrdenie = no-op");
  const [m] = await su<{ s: string[] }>(`select effective_scope s from public.einvoice_mandates where id = $1`, [mandateA]);
  assert.deepEqual(m.s, ["send", "receive"]);
  o = await svcCommit(`update public.einvoice_mandates set effective_scope = '{send}' where id = $1`, [mandateA]);
  assert.notEqual(o.layer, "ok");
});

await check("mandát: append-only — DELETE / TRUNCATE / zmena snapshotu zakázané aj pre postgres", async () => {
  for (const sql of [
    `delete from public.einvoice_mandates where id = '${mandateA}'`,
    `update public.einvoice_mandates set granted_by_email = 'x@example.invalid' where id = '${mandateA}'`,
    `update public.einvoice_mandates set statement_sha256 = '${SHA("f")}' where id = '${mandateA}'`,
    `truncate public.einvoice_mandates`,
  ]) {
    await assert.rejects(() => db.exec(sql), /ESBLU_EINVOICE_MANDATE_(APPEND_ONLY|IMMUTABLE)/, sql);
  }
  const o = await run(svc, `delete from public.einvoice_mandates`);
  assert.notEqual(o.layer, "ok");
});

await check("mandát: klient nemá INSERT/UPDATE ani EXECUTE na grant/confirm/revoke", async () => {
  for (const k of ["owner", "adminFin", "employee"] as const) {
    assert.equal((await run(who(k), `insert into public.einvoice_mandates (company_id, provider, environment, scope, granted_by_user_id, granted_by_role, statement_version, statement_sha256, statement_locale, authority_confirmed, grant_channel) values ('${C.a}', 'efaktura_sk', 'sandbox', '{send}', '${U[k]}', 'owner', 'v', '${SHA("a")}', 'sk', true, 'enroll')`)).layer, "privilege");
    assert.equal((await run(who(k), grantSql, [U[k], C.a, "{send}", SHA("a"), null, null])).layer, "privilege");
    assert.equal((await run(who(k), `select public.esblu_einvoice_mandate_revoke($1, 'sandbox', 'user', $2, 'X')`, [C.a, U[k]])).layer, "privilege");
  }
  assert.equal((await run({ role: "anon" }, `select * from public.einvoice_mandates`)).layer, "privilege");
});

// ============================================================================= 3. izolácia
await check("izolácia: einvoice_mandates — owner / finance admin / účtovník vidia A; admin bez financií, employee, owner B nič", async () => {
  const sel = (k: keyof typeof U) => run(who(k), `select company_id from public.einvoice_mandates`);
  for (const k of ["owner", "adminFin", "accountant"] as const) {
    const o = await sel(k);
    assert.equal(o.layer, "ok", o.message);
    assert.ok(o.data.length >= 1 && o.data.every((r) => r.company_id === C.a), k);
  }
  for (const k of ["admin", "employee", "ownerB"] as const) {
    const o = await sel(k);
    assert.equal(o.layer, "ok", o.message);
    assert.equal(o.data.length, 0, k);
  }
});

await check("izolácia: esblu_einvoice_my_mandate — iba vlastná aktívna firma, employee 42501", async () => {
  let o = await run(who("owner"), `select public.esblu_einvoice_my_mandate('sandbox') m`);
  assert.deepEqual((o.data[0].m as { effective_scope: string[] }).effective_scope, ["receive", "send"]);
  o = await run(who("ownerB"), `select public.esblu_einvoice_my_mandate('sandbox') m`);
  assert.deepEqual((o.data[0].m as { effective_scope: string[] }).effective_scope, []);
  o = await run(who("employee"), `select public.esblu_einvoice_my_mandate('sandbox') m`);
  assert.match(o.message, /ESBLU_FORBIDDEN/);
});

// ============================================================================= 2. brána odosielania
await check("brána: INSERT pokusu bez účinného mandátu → ESBLU_EINVOICE_MANDATE_REQUIRED (firma B)", async () => {
  const o = await insertOutbound(C.b, INV.b1);
  assert.equal(o.layer, "error");
  assert.match(o.message, /ESBLU_EINVOICE_MANDATE_REQUIRED/);
});

let outA1 = "";
await check("brána: s účinným mandátom 'send' sa pokus založí; claim ho zoberie", async () => {
  const o = await insertOutbound(C.a, INV.a1);
  assert.equal(o.layer, "ok", o.message);
  outA1 = String(o.data[0].id);
  const c = await svcCommit(`select id from public.esblu_einvoice_claim_outbound('send', 5, 60)`);
  assert.equal(c.layer, "ok", c.message);
  assert.deepEqual(c.data.map((r) => r.id), [outA1]);
  // výsledok pokusu: retry bez neistého výsledku (napr. 503 pred odoslaním) → späť do frontu
  await svcCommit(`update public.einvoice_outbound set send_in_flight = false, locked_until = null, next_retry_at = now() - interval '1 second' where id = $1`, [outA1]);
});

await check("brána: mandát iba 'receive' nestačí na odoslanie", async () => {
  const g = await grant(U.ownerB, C.b, ["receive"]);
  assert.equal(g.layer, "ok", g.message);
  await confirm(String(g.data[0].id), ["receive"]);
  assert.equal(await effective(C.b, "receive"), true);
  const o = await insertOutbound(C.b, INV.b1);
  assert.match(o.message, /ESBLU_EINVOICE_MANDATE_REQUIRED/);
});

let outA2 = "";
await check("odvolanie: po revoke sa čerstvý pokus nezoberie (claim) ani nezaloží; neistý výsledok smie replay toho istého kľúča", async () => {
  const o2 = await insertOutbound(C.a, INV.a2);
  assert.equal(o2.layer, "ok", o2.message);
  outA2 = String(o2.data[0].id);
  // A2 má neistý výsledok (už mohol odísť)
  await svcCommit(`update public.einvoice_outbound set state = 'sending', send_in_flight = true, retry_count = 1 where id = $1`, [outA2]);
  await svcCommit(`update public.einvoice_outbound set send_in_flight = false, send_outcome_unknown = true, locked_until = null, next_retry_at = now() - interval '1 second' where id = $1`, [outA2]);

  const r = await svcCommit(`select public.esblu_einvoice_mandate_revoke($1, 'sandbox', 'user', $2, 'USER_REVOKED') n`, [C.a, U.owner]);
  assert.equal(r.layer, "ok", r.message);
  assert.equal(Number(r.data[0].n), 1);
  assert.equal(await effective(C.a), false);
  const again = await svcCommit(`select public.esblu_einvoice_mandate_revoke($1, 'sandbox', 'user', $2, 'USER_REVOKED') n`, [C.a, U.owner]);
  assert.equal(Number(again.data[0].n), 0, "idempotentné");

  const c = await svcCommit(`select id from public.esblu_einvoice_claim_outbound('send', 10, 60)`);
  assert.deepEqual(c.data.map((x) => x.id), [outA2], "iba replay neistého výsledku, A1 (čerstvé) nie");
  const ins = await insertOutbound(C.a, INV.a3);
  assert.match(ins.message, /ESBLU_EINVOICE_MANDATE_REQUIRED/);
  // obranná vrstva: priamy prechod čerstvého riadku do in-flight bez mandátu
  const direct = await svcCommit(`update public.einvoice_outbound set state = 'sending', send_in_flight = true where id = $1`, [outA1]);
  assert.match(direct.message, /ESBLU_EINVOICE_MANDATE_REQUIRED/);
  const [m] = await su(`select revoked_by_kind, revoked_by_user_id, revocation_reason_code from public.einvoice_mandates where id = $1`, [mandateA]);
  assert.deepEqual(m, { revoked_by_kind: "user", revoked_by_user_id: U.owner, revocation_reason_code: "USER_REVOKED" });
  const conf = await confirm(mandateA);
  assert.match(conf.message, /ESBLU_EINVOICE_MANDATE_REVOKED/, "odvolaný mandát sa nedá znova aktivovať");
});

await check("odvolanie: employee revoke zamietnutý; nový grant + confirm znova povolí odosielanie", async () => {
  const e = await svcCommit(`select public.esblu_einvoice_mandate_revoke($1, 'sandbox', 'user', $2, 'X')`, [C.a, U.employee]);
  assert.match(e.message, /FINANCE_MANAGE_REQUIRED/);
  const g = await grant(U.adminFin, C.a, ["send"]);
  assert.equal(g.layer, "ok", g.message);
  await confirm(String(g.data[0].id), ["send"]);
  assert.equal(await effective(C.a), true);
  const [m] = await su(`select granted_by_role, granted_by_name from public.einvoice_mandates where id = $1`, [g.data[0].id]);
  assert.deepEqual(m, { granted_by_role: "admin", granted_by_name: "Adam Financie" });
});

await check("participant.deactivated (reception_status → deactivated) odvolá mandáty firmy (D-M3)", async () => {
  const ev = await svcCommit(`select applied from public.esblu_einvoice_org_participant_event('efaktura_sk', 'sandbox', 'org-b', 'participant.deactivated', null, null, now())`);
  assert.equal(ev.layer, "ok", ev.message);
  assert.equal(ev.data[0].applied, true);
  const [m] = await su(`select count(*)::int n from public.einvoice_mandates where company_id = $1 and revoked_at is null`, [C.b]);
  assert.equal(m.n, 0);
  const [k] = await su(`select distinct revoked_by_kind k, revocation_reason_code r from public.einvoice_mandates where company_id = $1`, [C.b]);
  assert.deepEqual(k, { k: "provider_event", r: "PARTICIPANT_DEACTIVATED" });
});

// ============================================================================= 7. duplicity
await check("duplicity: druhý aktívny pokus na faktúru → unikátny index; rovnaký Idempotency-Key → unikát", async () => {
  const dup = await insertOutbound(C.a, INV.a1, 2);
  assert.match(dup.message, /einvoice_outbound_one_active_per_invoice/);
  const [row] = await su<{ k: string }>(`select idempotency_key k from public.einvoice_outbound where id = $1`, [outA1]);
  const sameKey = await svcCommit(
    `insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt, idempotency_key, state) values ($1, $2, 'efaktura_sk', 'sandbox', 1, $3, 'queued')`,
    [C.a, INV.a3, row.k]
  );
  assert.match(sameKey.message, /einvoice_outbound_idempotency_key|duplicate key/);
  const sameAttempt = await svcCommit(
    `insert into public.einvoice_outbound (company_id, invoice_id, provider, environment, attempt, idempotency_key, state) values ($1, $2, 'efaktura_sk', 'sandbox', 1, 'idem-key-unique-000000001', 'failed')`,
    [C.a, INV.a1]
  );
  assert.match(sameAttempt.message, /einvoice_outbound_invoice_attempt_key|duplicate key/);
});

await check("duplicity: Idempotency-Key a väzba na faktúru sú nemenné", async () => {
  const o = await svcCommit(`update public.einvoice_outbound set idempotency_key = 'idem-key-changed-0000001' where id = $1`, [outA1]);
  assert.match(o.message, /OUTBOUND_IDENTITY_IMMUTABLE/);
  const p = await svcCommit(`update public.einvoice_outbound set invoice_id = $2 where id = $1`, [outA1, INV.a3]);
  assert.match(p.message, /OUTBOUND_IDENTITY_IMMUTABLE/);
});

await check("izolácia: einvoice_outbound / organizations — owner, účtovník, finance admin iba A; admin bez financií, employee 0; owner B iba B", async () => {
  for (const t of ["einvoice_outbound", "einvoice_organizations", "einvoice_events"]) {
    for (const k of ["owner", "accountant", "adminFin"] as const) {
      const o = await run(who(k), `select company_id from public.${t}`);
      assert.equal(o.layer, "ok", `${t} ${k} ${o.message}`);
      assert.ok(o.data.length > 0 && o.data.every((r) => r.company_id === C.a), `${t} ${k}`);
    }
    for (const k of ["admin", "employee"] as const) {
      const o = await run(who(k), `select company_id from public.${t}`);
      assert.equal(o.data.length, 0, `${t} ${k}`);
    }
    const b = await run(who("ownerB"), `select company_id from public.${t}`);
    assert.ok(b.data.every((r) => r.company_id === C.b), `${t} ownerB`);
  }
});

await check("izolácia: companies a invoices (doklady) — žiadny používateľ nevidí cudziu firmu; zápis do cudzej firmy nemožný", async () => {
  for (const k of Object.keys(U) as (keyof typeof U)[]) {
    const own = k === "ownerB" ? C.b : C.a;
    const c = await run(who(k), `select id from public.companies`);
    assert.equal(c.layer, "ok", c.message);
    assert.ok(c.data.every((r) => r.id === own), `companies ${k}`);
    const i = await run(who(k), `select company_id from public.invoices`);
    if (i.layer === "ok") assert.ok(i.data.every((r) => r.company_id === own), `invoices ${k}`);
    const other = own === C.a ? C.b : C.a;
    const u = await run(who(k), `update public.companies set name = 'X' where id = $1 returning id`, [other]);
    assert.ok(u.layer !== "ok" || u.data.length === 0, `update cudzej firmy ${k}`);
  }
  // employee nevidí finančné doklady vlastnej firmy (finance.view = false)
  const e = await run(who("employee"), `select id from public.invoices`);
  assert.ok(e.layer !== "ok" || e.data.length === 0);
});

// ============================================================================= 5. deregistrácia
let jobA = "";
await check("deregistrácia: iba owner (admin / employee / owner B zamietnutí), operátor potrebuje identitu", async () => {
  for (const actor of [U.adminFin, U.employee, U.ownerB]) {
    const o = await svcCommit(`select public.esblu_einvoice_deregistration_request($1, 'sandbox', 'company_termination', $2) r`, [C.a, actor]);
    assert.match(o.message, /ESBLU_NOT_ACTIVE_OWNER/);
  }
  const op = await svcCommit(`select public.esblu_einvoice_deregistration_request($1, 'sandbox', 'operator', null, null) r`, [C.a]);
  assert.match(op.message, /OPERATOR_REQUIRED/);
});

await check("deregistrácia: požiadavka je idempotentná a odvolá mandáty (deregistration)", async () => {
  const o = await svcCommit(`select public.esblu_einvoice_deregistration_request($1, 'sandbox', 'company_termination', $2) r`, [C.a, U.owner]);
  assert.equal(o.layer, "ok", o.message);
  const r = o.data[0].r as { job_id: string; state: string; created: boolean };
  assert.equal(r.created, true);
  assert.equal(r.state, "requested");
  jobA = r.job_id;
  const again = await svcCommit(`select public.esblu_einvoice_deregistration_request($1, 'sandbox', 'owner_request', $2) r`, [C.a, U.owner]);
  assert.deepEqual(again.data[0].r, { job_id: jobA, state: "requested", created: false });
  assert.equal(await effective(C.a), false);
  const [m] = await su(`select count(*)::int n from public.einvoice_mandates where company_id = $1 and revoked_by_kind = 'deregistration' and revocation_reason_code = 'COMPANY_TERMINATION'`, [C.a]);
  assert.equal(m.n, 1);
});

await check("deregistrácia: stavový automat — neplatné prechody a DELETE zakázané", async () => {
  for (const sql of [
    `update public.einvoice_deregistrations set state = 'completed', completed_at = now() where id = '${jobA}'`,
    `update public.einvoice_deregistrations set provider_org_id = 'other' where id = '${jobA}'`,
    `delete from public.einvoice_deregistrations where id = '${jobA}'`,
    `truncate public.einvoice_deregistrations`,
  ]) {
    await assert.rejects(() => db.exec(sql), /ESBLU_EINVOICE_DEREGISTRATION_/, sql);
  }
  const fin = await svcCommit(`select public.esblu_einvoice_deregistration_finish($1, 'completed', null, 'ok', null)`, [jobA]);
  assert.match(fin.message, /NOT_IN_PROGRESS/);
});

await check("deregistrácia: claim → retry (409 v behu) s backoffom; lease zabráni dvojitému claimu", async () => {
  const c = await svcCommit(`select id, attempts from public.esblu_einvoice_deregistration_claim('efaktura_sk', 'sandbox', 5, 60)`);
  assert.deepEqual(c.data, [{ id: jobA, attempts: 1 }]);
  const c2 = await svcCommit(`select id from public.esblu_einvoice_deregistration_claim('efaktura_sk', 'sandbox', 5, 60)`);
  assert.equal(c2.data.length, 0, "počas lease nikto iný");
  const f = await svcCommit(`select (public.esblu_einvoice_deregistration_finish($1, 'retry', 'EINVOICE_PROVIDER_CONFLICT', null, null, 30)).state s`, [jobA]);
  assert.equal(f.data[0].s, "retry_wait");
  const [j] = await su<{ ok: boolean }>(`select next_attempt_at > now() + interval '100 seconds' ok from public.einvoice_deregistrations where id = $1`, [jobA]);
  assert.ok(j.ok, "backoff ≥ 2 min");
  const c3 = await svcCommit(`select id from public.esblu_einvoice_deregistration_claim('efaktura_sk', 'sandbox', 5, 60)`);
  assert.equal(c3.data.length, 0, "pred termínom sa nezoberie");
  await db.exec(`update public.einvoice_deregistrations set next_attempt_at = now() - interval '1 second' where id = '${jobA}'`);
  const other = await svcCommit(`select id from public.esblu_einvoice_deregistration_claim('efaktura_sk', 'live', 5, 60)`);
  assert.equal(other.data.length, 0, "iné prostredie nasadenia job nezoberie");
  const otherProvider = await svcCommit(`select id from public.esblu_einvoice_deregistration_claim('mock', 'sandbox', 5, 60)`);
  assert.equal(otherProvider.data.length, 0, "iný poskytovateľ job nezoberie");
  await db.exec(`update public.einvoice_deregistrations set next_attempt_at = now() + interval '1 hour' where id = '${jobA}'`);
});

await check("deregistrácia: blokuje termination kým nie je completed; completed → snapshot, mapovanie preč, blocker null, idempotentné", async () => {
  const [b] = await su<{ b: string | null }>(`select public.esblu_company_deletion_retention_blocker($1) b`, [C.a]);
  assert.equal(b.b, "FINALIZED_ACCOUNTING_DOCUMENTS");
  const [enrolled] = await su<{ n: number }>(`select count(*)::int n from public.einvoice_organizations where company_id = $1 and provider_org_id is not null`, [C.a]);
  assert.equal(enrolled.n, 1);
  await db.exec(`update public.einvoice_deregistrations set next_attempt_at = now() - interval '1 second' where id = '${jobA}'`);
  const c = await svcCommit(`select id from public.esblu_einvoice_deregistration_claim('efaktura_sk', 'sandbox', 1, 60, $1)`, [jobA]);
  assert.equal(c.data.length, 1);
  const f = await svcCommit(`select (public.esblu_einvoice_deregistration_finish($1, 'completed', null, 'deactivated', $2)).state s`, [jobA, SHA("9")]);
  assert.equal(f.data[0].s, "completed", f.message);
  const [job] = await su<{ org_snapshot: Record<string, unknown>; completed_at: string }>(`select org_snapshot, completed_at from public.einvoice_deregistrations where id = $1`, [jobA]);
  assert.equal(job.org_snapshot.provider_org_id, "org-a");
  assert.equal(job.org_snapshot.participant_id, "9915:a0000001");
  assert.deepEqual(job.org_snapshot.onboarding_snapshot, { ico: "12345678" });
  const [gone] = await su<{ n: number }>(`select count(*)::int n from public.einvoice_organizations where company_id = $1`, [C.a]);
  assert.equal(gone.n, 0);
  const again = await svcCommit(`select public.esblu_einvoice_deregistration_request($1, 'sandbox', 'company_termination', $2) r`, [C.a, U.owner]);
  assert.deepEqual(again.data[0].r, { job_id: jobA, state: "completed", created: false });
  const st = await svcCommit(`select public.esblu_einvoice_deregistration_status($1, 'sandbox') s`, [C.a]);
  assert.equal((st.data[0].s as { registered: boolean }).registered, false);
  await assert.rejects(() => db.exec(`update public.einvoice_deregistrations set state = 'requested' where id = '${jobA}'`), /TERMINAL/);
  // dôkazy (mandáty) ostávajú
  const [m] = await su<{ n: number }>(`select count(*)::int n from public.einvoice_mandates where company_id = $1`, [C.a]);
  assert.equal(m.n, 2);
});

await check("deregistrácia: permanentná chyba → failed; vyčerpané pokusy → failed; operátor requeue s identitou", async () => {
  const r = await svcCommit(`select public.esblu_einvoice_deregistration_request($1, 'sandbox', 'operator', null, 'ops:ticket-1') r`, [C.b]);
  const job = (r.data[0].r as { job_id: string }).job_id;
  await svcCommit(`select 1 from public.esblu_einvoice_deregistration_claim('efaktura_sk', 'sandbox', 1, 60, $1)`, [job]);
  const f = await svcCommit(`select (public.esblu_einvoice_deregistration_finish($1, 'failed', 'EINVOICE_PROVIDER_REJECTED', null, null)).state s`, [job]);
  assert.equal(f.data[0].s, "failed");
  const nope = await svcCommit(`select public.esblu_einvoice_deregistration_requeue($1, '')`, [job]);
  assert.match(nope.message, /OPERATOR_REQUIRED/);
  const rq = await svcCommit(`select (public.esblu_einvoice_deregistration_requeue($1, 'ops:ticket-2')).state s`, [job]);
  assert.equal(rq.data[0].s, "requested");
  await db.exec(`update public.einvoice_deregistrations set max_attempts = 2 where id = '${job}'`);
  await svcCommit(`select 1 from public.esblu_einvoice_deregistration_claim('efaktura_sk', 'sandbox', 1, 60, $1)`, [job]);
  const ex = await svcCommit(`select (public.esblu_einvoice_deregistration_finish($1, 'retry', 'EINVOICE_PROVIDER_UNAVAILABLE', null, null)).last_error_code c`, [job]);
  assert.equal(ex.data[0].c, "EINVOICE_DEREGISTRATION_RETRY_EXHAUSTED");
});

await check("deregistrácia: RLS — owner A vidí iba svoje joby, employee a owner B nič z A", async () => {
  const o = await run(who("owner"), `select company_id from public.einvoice_deregistrations`);
  assert.ok(o.data.length >= 1 && o.data.every((r) => r.company_id === C.a));
  for (const k of ["employee", "admin"] as const) assert.equal((await run(who(k), `select 1 from public.einvoice_deregistrations`)).data.length, 0, k);
  assert.ok((await run(who("ownerB"), `select company_id from public.einvoice_deregistrations`)).data.every((r) => r.company_id === C.b));
});

await check("4. dôkazy prežijú ukončenie firmy: termination A (waived) po deregistrácii prejde; mandáty a joby ostávajú (bez FK)", async () => {
  const before = await su<{ m: number; d: number }>(`select (select count(*) from public.einvoice_mandates where company_id = $1)::int m, (select count(*) from public.einvoice_deregistrations where company_id = $1)::int d`, [C.a]);
  // pokusy A (outbound) sú súčasť termination výmazu (rozhodnutie D-G1 / archív rieši samostatná úloha)
  const o = await svcCommit(`select public.esblu_company_termination_commit($1, $2, false, 'waived') r`, [U.owner, C.a]);
  assert.equal(o.layer, "ok", o.message);
  const [gone] = await su<{ n: number }>(`select count(*)::int n from public.companies where id = $1`, [C.a]);
  assert.equal(gone.n, 0);
  const after = await su<{ m: number; d: number }>(`select (select count(*) from public.einvoice_mandates where company_id = $1)::int m, (select count(*) from public.einvoice_deregistrations where company_id = $1)::int d`, [C.a]);
  assert.deepEqual(after, before);
  assert.ok(before[0].m > 0 && before[0].d > 0);
});

// ============================================================================= 6. alerty
await check("alerty: dedupe — opakovaný 402 zvýši počítadlo, notifikácia iba raz za okno; resolve; nový výskyt = nový alert", async () => {
  const raise = () => svcCommit(`select * from public.esblu_einvoice_ops_alert_raise('PROVIDER_INSUFFICIENT_CREDIT', 'critical', 'efaktura_sk', 'sandbox', null, 'EINVOICE_PROVIDER_INSUFFICIENT_CREDIT')`);
  const a = await raise();
  assert.equal(a.layer, "ok", a.message);
  assert.equal(a.data[0].created, true);
  assert.equal(a.data[0].notify, true);
  const b = await raise();
  assert.equal(b.data[0].created, false);
  assert.equal(b.data[0].notify, false);
  assert.equal(b.data[0].occurrences, 2);
  const [n] = await su<{ n: number }>(`select count(*)::int n from public.einvoice_ops_alerts where status = 'open'`);
  assert.equal(n.n, 1);
  const open = await svcCommit(`select public.esblu_einvoice_ops_alerts_open() s`);
  assert.equal((open.data[0].s as { critical: number }).critical, 1);
  await db.exec(`update public.einvoice_ops_alerts set notified_at = now() - interval '7 hours'`);
  assert.equal((await raise()).data[0].notify, true, "renotifikácia po okne");
  const res = await svcCommit(`select public.esblu_einvoice_ops_alert_resolve('PROVIDER_INSUFFICIENT_CREDIT', 'sandbox', null, 'ops') n`);
  assert.equal(Number(res.data[0].n), 1);
  const c = await raise();
  assert.equal(c.data[0].created, true);
  await assert.rejects(() => db.exec(`delete from public.einvoice_ops_alerts`), /APPEND_ONLY/);
  for (const k of ["owner", "accountant"] as const) assert.equal((await run(who(k), `select * from public.einvoice_ops_alerts`)).layer, "privilege");
});

// ============================================================================= rollback
await check("rollback 120000 → 110000 → 100000: tabuľky s dôkazmi sa presunú do esblu_audit_archive (nič sa nezmaže); re-apply idempotentné", async () => {
  const before = await su<{ m: number; d: number; a: number }>(`select (select count(*) from public.einvoice_mandates)::int m, (select count(*) from public.einvoice_deregistrations)::int d, (select count(*) from public.einvoice_ops_alerts)::int a`);
  for (const f of [...NEW].reverse()) await db.exec(read(`supabase/rollback/${f.replace(".sql", "_rollback.sql")}`));
  for (const t of ["einvoice_mandates", "einvoice_deregistrations", "einvoice_ops_alerts"]) {
    const [r] = await su<{ x: string | null }>(`select to_regclass('public.${t}')::text x`);
    assert.equal(r.x, null, t);
  }
  const arch = await su<{ t: string }>(`select table_name t from information_schema.tables where table_schema = 'esblu_audit_archive' and table_name ~ '^einvoice_(mandates|deregistrations|ops_alerts)_rb_' order by 1`);
  assert.equal(arch.length, 3);
  const counts = await Promise.all(arch.map(async (r) => Number((await su<{ n: number }>(`select count(*)::int n from esblu_audit_archive.${r.t}`))[0].n)));
  assert.deepEqual(counts.sort(), [before[0].a, before[0].d, before[0].m].sort());
  // archív ostáva append-only
  await assert.rejects(() => db.exec(`delete from esblu_audit_archive.${arch.find((r) => r.t.startsWith("einvoice_mandates"))!.t}`), /APPEND_ONLY/);
  // claim bez mandátu (stav pred migráciou) funguje
  const c = await svcCommit(`select count(*) from public.esblu_einvoice_claim_outbound('reconcile', 1, 60)`);
  assert.equal(c.layer, "ok", c.message);
  for (const f of NEW) await db.exec(read(`${MIGRATIONS}/${f}`));
  for (const f of NEW) await db.exec(read(`${MIGRATIONS}/${f}`));
  assert.equal(await effective(C.b), false, "nová prázdna tabuľka → žiadny mandát → fail closed");
  const ins = await insertOutbound(C.b, INV.b1);
  assert.match(ins.message, /ESBLU_EINVOICE_MANDATE_REQUIRED/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
