// =============================================================================
// Pricing + entitlements (20261026100000) — SKUTOČNÝ PostgreSQL (PGlite),
// čistý replay všetkých migrácií. Nikdy Supabase / staging / produkcia.
//
//   - parita TS engine (lib/pricing.ts entitlementTargets) == SQL
//     esblu_plan_entitlement_targets pre maticu plánov / modulov / add-onov,
//   - Komplet / moduly / ďalšia firma (tier) / add-ony → nároky firmy,
//   - trial (14 dní, 10 AI, 15 min, 1 GB, 25 používateľov, bez eFaktúry),
//   - hard stop AI / hlas / používatelia / úložisko, dáta ostávajú,
//   - downgrade bez mazania, multi-company izolácia, owner-only billing,
//   - staging mock iba service_role + allow_mock_plans; klient nič nezapíše.
//
//   npm run test:pricing-entitlements-db
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
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 4).join("\n       ") : String(error)}`);
  }
}

await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
for (const f of replayOrder(readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith(".sql")))) {
  await db.exec(read(`${MIGRATIONS}/${f}`));
}

// ----------------------------------------------------------------------------- Data API simulácia
type Who = { role: "authenticated" | "service_role" | "anon"; uid?: string; session?: string };
const as = (uid: string, session: string): Who => ({ role: "authenticated", uid, session });
type Outcome = { layer: "ok" | "privilege" | "rls" | "error"; rows: number; message: string; data: Row[] };
async function run(who: Who, sql: string, params: unknown[] = [], commit = false): Promise<Outcome> {
  await db.exec("begin");
  let ok = false;
  try {
    const claims = who.role === "authenticated" ? { sub: who.uid, role: "authenticated", session_id: who.session } : { role: who.role };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query<Row>(sql, params);
    ok = true;
    const affected = (r as { affectedRows?: number }).affectedRows;
    return { layer: "ok", rows: r.rows.length || affected || 0, message: "", data: r.rows };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const message = e.message ?? String(error);
    if (e.code === "42501" && /permission denied/.test(message)) return { layer: "privilege", rows: 0, message, data: [] };
    if (e.code === "42501" && /row-level security/.test(message)) return { layer: "rls", rows: 0, message, data: [] };
    return { layer: "error", rows: 0, message: `${e.code ?? "?"} ${message}`, data: [] };
  } finally {
    await db.exec(commit && ok ? "commit" : "rollback");
  }
}
const attempt = (who: Who, sql: string, params: unknown[] = []) => run(who, sql, params, false);
const commitAs = (who: Who, sql: string, params: unknown[] = []) => run(who, sql, params, true);
async function expect(who: Who, sql: string, layer: Outcome["layer"], rows?: number, params: unknown[] = []) {
  const o = await attempt(who, sql, params);
  assert.equal(o.layer, layer, `${who.uid?.slice(-2) ?? who.role}: ${sql} → ${o.layer} ${o.message}`);
  if (rows !== undefined) assert.equal(o.rows, rows, `${sql} → ${o.rows} riadkov, čakalo sa ${rows}`);
  return o;
}
const su = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const P = await import("../lib/pricing.ts");

// ----------------------------------------------------------------------------- fixtures
const U = {
  ownerA: "c6000000-0000-4000-8000-0000000000a1", adminA: "c6000000-0000-4000-8000-0000000000a2",
  accountantA: "c6000000-0000-4000-8000-0000000000a3", employeeA: "c6000000-0000-4000-8000-0000000000a4",
  ownerB: "c6000000-0000-4000-8000-0000000000b1", ownerT: "c6000000-0000-4000-8000-0000000000e1",
};
const C = {
  a: "c7000000-0000-4000-8000-00000000000a", a2: "c7000000-0000-4000-8000-0000000000a2",
  b: "c7000000-0000-4000-8000-00000000000b", t: "c7000000-0000-4000-8000-00000000000e",
};
const S = {
  ownerA: "c8000000-0000-4000-8000-0000000000a1", ownerA2: "c8000000-0000-4000-8000-0000000000a9",
  adminA: "c8000000-0000-4000-8000-0000000000a2", accountantA: "c8000000-0000-4000-8000-0000000000a3",
  employeeA: "c8000000-0000-4000-8000-0000000000a4", ownerB: "c8000000-0000-4000-8000-0000000000b1",
  ownerT: "c8000000-0000-4000-8000-0000000000e1",
};
await db.exec(`
  insert into auth.users (id, email) values
    ('${U.ownerA}', 'pa@example.invalid'), ('${U.adminA}', 'pad@example.invalid'), ('${U.accountantA}', 'pac@example.invalid'),
    ('${U.employeeA}', 'pe@example.invalid'), ('${U.ownerB}', 'pb@example.invalid'), ('${U.ownerT}', 'pt@example.invalid');
  insert into auth.sessions (id, user_id) values
    ('${S.ownerA}', '${U.ownerA}'), ('${S.ownerA2}', '${U.ownerA}'), ('${S.adminA}', '${U.adminA}'),
    ('${S.accountantA}', '${U.accountantA}'), ('${S.employeeA}', '${U.employeeA}'), ('${S.ownerB}', '${U.ownerB}'),
    ('${S.ownerT}', '${U.ownerT}');
  set session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values
    ('${C.a}', '${U.ownerA}', 'Firma A'), ('${C.a2}', '${U.ownerA}', 'Firma A2'), ('${C.b}', '${U.ownerB}', 'Firma B');
  insert into public.companies (id, owner_id, name, trial_started_at, trial_ends_at) values
    ('${C.t}', '${U.ownerT}', 'Trial s.r.o.', now() - interval '1 day', now() + interval '13 days');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.a}', '${U.ownerA}', 'owner', 'active', '{}'), ('${C.a}', '${U.adminA}', 'admin', 'active', '{"billing":{"manage":true}}'),
    ('${C.a}', '${U.accountantA}', 'accountant', 'active', '{}'), ('${C.a}', '${U.employeeA}', 'employee', 'active', '{}'),
    ('${C.a2}', '${U.ownerA}', 'owner', 'active', '{}'),
    ('${C.b}', '${U.ownerB}', 'owner', 'active', '{}'),
    ('${C.t}', '${U.ownerT}', 'owner', 'active', '{}');
  insert into public.session_active_company (session_id, user_id, company_id) values
    ('${S.ownerA}', '${U.ownerA}', '${C.a}'), ('${S.ownerA2}', '${U.ownerA}', '${C.a2}');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method)
    select co, d.version, own, 'company_dpa_gate'
    from (values ('${C.a}'::uuid, '${U.ownerA}'::uuid), ('${C.a2}'::uuid, '${U.ownerA}'::uuid), ('${C.b}'::uuid, '${U.ownerB}'::uuid), ('${C.t}'::uuid, '${U.ownerT}'::uuid)) v(co, own),
         (select version from public.legal_documents where type = 'dpa' order by effective_at desc limit 1) d;
  set session_replication_role = origin;
`);
const ownerA = as(U.ownerA, S.ownerA), ownerAinA2 = as(U.ownerA, S.ownerA2), adminA = as(U.adminA, S.adminA),
  accountantA = as(U.accountantA, S.accountantA), employeeA = as(U.employeeA, S.employeeA), ownerB = as(U.ownerB, S.ownerB),
  ownerT = as(U.ownerT, S.ownerT);
const service: Who = { role: "service_role" };
const anon: Who = { role: "anon" };

const MOCK = "select public.esblu_staging_mock_set_plan($1, $2, $3, $4, $5, $6, $7, $8, $9) r";
async function mock(company: string, kind: "complete" | "modular", modules: string[] = [], packs: number[] = [0, 0, 0, 0, 0], active = true) {
  const o = await commitAs(service, MOCK, [company, kind, modules, ...packs, active]);
  if (o.layer !== "ok") throw new Error(o.message);
  return o.data[0].r as { company_id: string; plan_code: string; tier: string };
}
const ents = async (company: string) =>
  Object.fromEntries((await su<{ k: string; a: boolean; l: number | null }>(
    `select k.key k, coalesce((public.esblu_resolve_entitlement($1, k.key) ->> 'active')::boolean, false) a,
            (public.esblu_resolve_entitlement($1, k.key) ->> 'limit')::int l
     from public.entitlement_catalog k order by k.key`, [company])).map((r) => [r.k, r.a ? r.l : "off"])) as Record<string, number | null | "off">;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const overview = async (who: Who) => {
  const o = await attempt(who, "select public.esblu_my_plan_overview() v");
  if (o.layer !== "ok") throw new Error(o.message);
  return o.data[0].v as Json;
};

// ----------------------------------------------------------------------------- parita TS ↔ SQL
await check("parita: TS entitlementTargets == SQL esblu_plan_entitlement_targets (matica plánov × modulov × add-onov × eFaktúra)", async () => {
  const moduleSets: string[][] = [[], ["vehicles"], ["vehicles", "machines"], ["invoicing", "documents"], ["documents", "einvoice"],
    ["vehicles", "machines", "inventory", "invoicing"], [...P.BASE_MODULE_IDS]];
  const packSets = [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0], [0, 2, 0, 0, 0], [0, 0, 1, 0, 0], [0, 0, 0, 1, 1], [3, 3, 3, 3, 3], [99, 0, 0, 0, 0]];
  let n = 0;
  for (const plan of ["complete", "modular"] as const) for (const modules of moduleSets) for (const p of packSets) for (const einv of [false, true]) {
    const ts = P.entitlementTargets({ plan, modules: modules as never, einvoiceAvailable: einv,
      addons: { ai_40: p[0], voice_60: p[1], users_25: p[2], einvoice_40: p[3], einvoice_100: p[4] } })
      .map((t) => `${t.key}:${t.limit}:${t.period}`);
    const sql = (await su<{ k: string; l: number | null; p: string | null }>(
      `select entitlement_key k, limit_value l, limit_period p from public.esblu_plan_entitlement_targets($1, $2, $3, $4, $5, $6, $7, $8) order by 1`,
      [plan, modules, ...p, einv])).map((r) => `${r.k}:${r.l}:${r.p}`);
    assert.deepEqual(sql, ts, `${plan} ${modules.join("+")} ${p.join(",")} einv=${einv}`);
    n++;
  }
  assert.ok(n >= 190);
});

// ----------------------------------------------------------------------------- staging mock guard
await check("mock: bez allow_mock_plans = ESBLU_MOCK_PLANS_DISABLED; klienti (owner/admin/employee/accountant/anon) nemajú EXECUTE", async () => {
  const off = await attempt(service, MOCK, [C.a, "complete", [], 0, 0, 0, 0, 0, true]);
  assert.match(off.message, /ESBLU_MOCK_PLANS_DISABLED/);
  for (const who of [ownerA, adminA, employeeA, accountantA, anon]) {
    assert.equal((await attempt(who, MOCK, [C.a, "complete", [], 0, 0, 0, 0, 0, true])).layer, "privilege");
  }
  await su("update public.billing_runtime_config set allow_mock_plans = true");
});

// ----------------------------------------------------------------------------- pricing → nároky
await check("Komplet (prvá firma): všetky predajné moduly, 40 AI, 60 min, 25 users, 5 GB; eFaktúra NIE (nie je live)", async () => {
  const r = await mock(C.a, "complete");
  assert.equal(r.plan_code, "esblu_complete");
  assert.equal(r.tier, "primary");
  const e = await ents(C.a);
  for (const k of ["vehicles", "machines", "inventory", "invoicing", "voice"]) assert.equal(e[k], null, k);
  assert.equal(e.ai_documents, 40);
  assert.equal(e.voice_minutes, 60);
  assert.equal(e.team_members, 25);
  assert.equal(e.storage_mb, 5120);
  assert.equal(e.einvoice, "off");
  assert.equal(e.einvoice_transactions, "off");
});

await check("ďalšia firma toho istého ownera = secondary tier (12,90), VLASTNÉ limity (nezdieľané)", async () => {
  const r = await mock(C.a2, "complete");
  assert.equal(r.plan_code, "esblu_complete_secondary");
  assert.equal(r.tier, "secondary");
  const e = await ents(C.a2);
  assert.equal(e.ai_documents, 40);
  assert.equal(e.team_members, 25);
  assert.equal(P.quote({ modules: ["vehicles", "machines", "inventory", "invoicing"], tier: "secondary" }).totalCents, 1290);
  assert.equal(P.quote({ modules: ["vehicles", "machines", "inventory"], tier: "secondary" }).totalCents, 1170);
});

await check("add-ony: AI +40, hlas +60, users +25 sa sčítajú; eFaktúra add-on bez live eFaktúry nič neaktivuje", async () => {
  await mock(C.a, "complete", [], [1, 2, 1, 1, 1]);
  const e = await ents(C.a);
  assert.equal(e.ai_documents, 80);
  assert.equal(e.voice_minutes, 180);
  assert.equal(e.team_members, 50);
  assert.equal(e.einvoice_transactions, "off");
  assert.equal(P.quote({ modules: [], complete: true, tier: "primary", addons: { ai_40: 1 } }).totalCents, 1980, "Komplet + AI = 19,80");
});

await check("eFaktúra readiness: po einvoice_sellable=true Komplet dostane eFaktúru + 20 tx (+40/+100); live tok sa tým nezapína", async () => {
  await su("update public.billing_runtime_config set einvoice_sellable = true");
  await mock(C.a, "complete", [], [0, 0, 0, 1, 1]);
  const e = await ents(C.a);
  assert.equal(e.einvoice, null);
  assert.equal(e.einvoice_transactions, 160);
  assert.equal((await attempt(service, "select public.esblu_require_einvoice_tx_capacity($1, 1) s", [C.a])).layer, "ok");
  await su("update public.billing_runtime_config set einvoice_sellable = false");
  await mock(C.a, "complete");
  assert.equal((await ents(C.a)).einvoice, "off");
});

await check("moduly: 2 moduly = iba tie nároky (+ firemné 25 users / 5 GB), AI iba s modulom Dokumenty (10), hlas iba s add-onom", async () => {
  await mock(C.b, "modular", ["vehicles", "invoicing"]);
  let e = await ents(C.b);
  assert.equal(e.vehicles, null);
  assert.equal(e.invoicing, null);
  assert.equal(e.machines, "off");
  assert.equal(e.ai_documents, "off");
  assert.equal(e.voice, "off");
  assert.equal(e.team_members, 25);
  assert.equal(e.storage_mb, 5120);
  await mock(C.b, "modular", ["documents"], [0, 1, 0, 0, 0]);
  e = await ents(C.b);
  assert.equal(e.ai_documents, 10, "samostatný modul Dokumenty = 10 AI");
  assert.equal(e.voice_minutes, 60);
  assert.equal(e.vehicles, "off", "downgrade: modul odvolaný");
});

await check("downgrade bez mazania: vozidlá ostávajú čitateľné, nový zápis odmietnutý; opätovná aktivácia vráti zápis", async () => {
  await mock(C.b, "modular", ["vehicles"]);
  await db.exec(`set session_replication_role = replica;
    insert into public.vehicles (spz, user_id, company_id) values ('BB-1', '${U.ownerB}', '${C.b}');
    set session_replication_role = origin;`);
  await mock(C.b, "modular", ["invoicing"]);
  const read1 = await attempt(ownerB, `select count(*)::int n from public.vehicles where company_id = '${C.b}'`);
  assert.equal(read1.data[0].n, 1, "dáta ostávajú a sú čitateľné");
  const ins = await attempt(ownerB, `insert into public.vehicles (spz, user_id, company_id) values ('BB-2', '${U.ownerB}', '${C.b}')`);
  assert.notEqual(ins.layer, "ok");
  assert.match(ins.message, /ENTITLEMENT_DENIED:(ENTITLEMENT_REQUIRED|TRIAL_EXPIRED):vehicles/);
  await mock(C.b, "modular", ["vehicles", "invoicing"]);
  const ok = await commitAs(ownerB, `insert into public.vehicles (spz, user_id, company_id) values ('BB-2', '${U.ownerB}', '${C.b}')`);
  assert.equal(ok.layer, "ok", ok.message);
  assert.equal((await su<{ n: number }>(`select count(*)::int n from public.vehicles where company_id = '${C.b}'`))[0].n, 2);
});

await check("koniec predplatného: nároky odvolané, dáta ostávajú (nič sa nemaže)", async () => {
  await mock(C.b, "modular", ["vehicles"], [0, 0, 0, 0, 0], false);
  const e = await ents(C.b);
  assert.equal(e.vehicles, "off");
  assert.equal((await su<{ n: number }>(`select count(*)::int n from public.vehicles where company_id = '${C.b}'`))[0].n, 2);
  await mock(C.b, "modular", ["vehicles", "invoicing"]);
});

// ----------------------------------------------------------------------------- trial
await check("trial: všetky moduly, 25 users, 10 AI, voice 15 min, 1 GB, bez eFaktúry; bez kusových limitov modulov", async () => {
  const e = await ents(C.t);
  for (const k of ["vehicles", "machines", "inventory", "invoicing", "voice"]) assert.equal(e[k], null, k);
  assert.equal(e.ai_documents, 10);
  assert.equal(e.voice_minutes, 15);
  assert.equal(e.team_members, 25);
  assert.equal(e.storage_mb, 1024);
  assert.equal(e.einvoice, "off");
  const ov = await overview(ownerT);
  assert.equal(ov.trial.active, true);
});

await check("trial skončil: nároky neaktívne (TRIAL_EXPIRED), dáta ostávajú", async () => {
  await db.exec(`set session_replication_role = replica;
    insert into public.vehicles (spz, user_id, company_id) values ('TT-1', '${U.ownerT}', '${C.t}');
    update public.companies set trial_started_at = now() - interval '20 days', trial_ends_at = now() - interval '6 days' where id = '${C.t}';
    set session_replication_role = origin;`);
  const r = (await su<{ v: Json }>(`select public.esblu_resolve_entitlement('${C.t}', 'vehicles') v`))[0].v;
  assert.equal(r.active, false);
  assert.equal(r.reason, "TRIAL_EXPIRED");
  assert.equal((await su<{ n: number }>(`select count(*)::int n from public.vehicles where company_id = '${C.t}'`))[0].n, 1);
  await db.exec(`set session_replication_role = replica;
    update public.companies set trial_started_at = now() - interval '1 day', trial_ends_at = now() + interval '13 days' where id = '${C.t}';
    set session_replication_role = origin;`);
});

// ----------------------------------------------------------------------------- hard stops
await check("AI hard stop: Komplet 40 / obdobie → ďalšia rezervácia AI_PROCESSING_LIMIT_REACHED", async () => {
  await mock(C.a, "complete");
  await su(`insert into public.ai_processing_usage (company_id, user_id, endpoint, idempotency_key, content_sha256, entitlement_source, entitlement_id, status)
    select '${C.a}', '${U.ownerA}', 'scan-document', 'aikey_fill_' || lpad(g::text, 8, '0'), repeat('c', 64), 'subscription',
           (select e.id from public.company_entitlements e where e.company_id = '${C.a}' and e.entitlement_key = 'ai_documents' and e.source = 'subscription'),
           'succeeded'
    from generate_series(1, 40) g`);
  const o = await attempt(ownerA, "select public.esblu_reserve_ai_processing('scan-document', 'aikey_over_limit_0001', repeat('d', 64))");
  assert.notEqual(o.layer, "ok");
  assert.match(o.message, /ENTITLEMENT_DENIED:AI_PROCESSING_LIMIT_REACHED:ai_documents/);
});

await check("AI izolácia: limit firmy A neovplyvní firmu A2 toho istého ownera (A2 má vlastných 40)", async () => {
  const o = await attempt(ownerAinA2, "select public.esblu_reserve_ai_processing('scan-document', 'aikey_other_company_01', repeat('e', 64)) r");
  assert.equal(o.layer, "ok", o.message);
});

await check("hlas hard stop: 60 min vyčerpaných → VOICE_LIMIT_REACHED; iná firma nezasiahnutá; cudzia firma sa nezapíše", async () => {
  assert.equal((await attempt(ownerA, "select public.esblu_require_my_voice_capacity() v")).layer, "ok");
  const rec = await commitAs(service, "select public.esblu_record_voice_usage($1, $2, 600) r", [C.a, U.ownerA]);
  assert.equal(rec.data[0].r, true);
  for (let i = 0; i < 5; i++) await commitAs(service, "select public.esblu_record_voice_usage($1, $2, 600) r", [C.a, U.ownerA]);
  const o = await attempt(ownerA, "select public.esblu_require_my_voice_capacity() v");
  assert.match(o.message, /ENTITLEMENT_DENIED:VOICE_LIMIT_REACHED:voice_minutes/);
  assert.equal((await attempt(ownerAinA2, "select public.esblu_require_my_voice_capacity() v")).layer, "ok");
  assert.equal((await commitAs(service, "select public.esblu_record_voice_usage($1, $2, 10) r", [C.b, U.ownerA])).data[0].r, false, "nie je člen B");
});

await check("používatelia hard stop: 25 aktívnych → 26. USER_LIMIT_REACHED; existujúci členovia ostávajú", async () => {
  // interná brána (volajú ju invite/accept RPC) — volá sa ako vlastník funkcií
  await assert.rejects(su("select public.esblu_require_entitlement_capacity($1, 'team_members', 25)", [C.a]), /ENTITLEMENT_DENIED:USER_LIMIT_REACHED:team_members/);
  await su("select public.esblu_require_entitlement_capacity($1, 'team_members', 24)", [C.a]);
  assert.equal((await su<{ n: number }>(`select count(*)::int n from public.company_members where company_id = '${C.a}' and status = 'active'`))[0].n, 4);
});

await check("úložisko hard stop: firemné objekty ≥ 5 GB → upload zakázaný (RESTRICTIVE politika), existujúce súbory ostávajú", async () => {
  await db.exec(`set session_replication_role = replica;
    insert into public.vehicles (id, spz, user_id, company_id) values ('c9000000-0000-4000-8000-0000000000aa', 'AA-9', '${U.ownerA}', '${C.a}');
    insert into storage.objects (bucket_id, name, metadata) values ('vehicle-photos', '${U.ownerA}/c9000000-0000-4000-8000-0000000000aa/big.webp', '{"size": 5368709120}');
    insert into public.vehicle_photos (company_id, vehicle_id, user_id, storage_path) values ('${C.a}', 'c9000000-0000-4000-8000-0000000000aa', '${U.ownerA}', '${U.ownerA}/c9000000-0000-4000-8000-0000000000aa/big.webp');
    set session_replication_role = origin;`);
  const st = await attempt(ownerA, "select public.esblu_require_my_storage_capacity() v");
  assert.match(st.message, /ENTITLEMENT_DENIED:STORAGE_LIMIT_REACHED:storage_mb/);
  const allowed = await attempt(ownerA, "select public.esblu_storage_upload_allowed('vehicle-photos') v");
  assert.equal(allowed.data[0].v, false);
  const up = await attempt(ownerA, `insert into storage.objects (bucket_id, name, metadata) values ('vehicle-photos', '${U.ownerA}/c9000000-0000-4000-8000-0000000000aa/new.webp', '{"size": 10}')`);
  assert.notEqual(up.layer, "ok", "upload nad limit musí zlyhať");
  assert.equal((await su<{ n: number }>("select count(*)::int n from storage.objects where name like '%/big.webp'"))[0].n, 1, "existujúci súbor ostáva");
  assert.equal((await attempt(ownerAinA2, "select public.esblu_require_my_storage_capacity() v")).layer, "ok", "firma A2 má vlastné úložisko");
  const policy = await su<{ permissive: string }>("select permissive from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'esblu_storage_company_capacity'");
  assert.equal(policy[0]?.permissive, "RESTRICTIVE");
});

// ----------------------------------------------------------------------------- roly / billing authority / izolácia
await check("billing authority: iba owner (manage); admin s billing.manage, accountant, employee nie", async () => {
  const access = async (who: Who) => (await attempt(who, "select public.esblu_billing_my_access() v")).data[0].v as { can_manage: boolean };
  assert.equal((await access(ownerA)).can_manage, true);
  for (const who of [adminA, accountantA, employeeA]) assert.equal((await access(who)).can_manage, false);
});

await check("prehľad: owner vidí plán + tier; admin/accountant/employee iba čerpanie (bez plánu a add-onov); vždy aktívna firma", async () => {
  const o = await overview(ownerA);
  assert.equal(o.plan.kind, "complete");
  assert.equal(o.price_tier, "primary");
  assert.equal(o.usage.ai_processings.used, 40);
  for (const who of [adminA, accountantA, employeeA]) {
    const v = await overview(who);
    assert.equal(v.plan, undefined);
    assert.equal(v.price_tier, undefined);
    assert.equal(v.usage.ai_processings.limit, 40);
  }
  const a2 = await overview(ownerAinA2);
  assert.equal(a2.price_tier, "secondary");
  assert.equal(a2.company_id, C.a2);
});

await check("klient nevie čítať ani zapísať plán, add-ony ani počítadlá; nevie volať sync / service RPC", async () => {
  for (const who of [ownerA, adminA, employeeA, accountantA, ownerB, anon]) {
    for (const sql of [
      "select * from public.company_plan_selection",
      "update public.company_plan_selection set ai_packs = 50",
      `insert into public.company_usage_counters (company_id, metric, period_start, used) values ('${C.a}', 'voice_seconds', now(), 0)`,
      "delete from public.company_usage_counters",
      `select public.esblu_billing_sync_entitlements('${C.a}')`,
      `select public.esblu_record_voice_usage('${C.a}', '${U.ownerA}', 1)`,
      "select * from public.esblu_plan_entitlement_targets('complete', '{}', 50, 50, 50, 50, 50, true)",
    ]) {
      const o = await attempt(who, sql);
      assert.equal(o.layer, "privilege", `${who.role} ${who.uid ?? ""}: ${sql} → ${o.layer} ${o.message}`);
    }
  }
});

await check("anon: žiadny prístup k prehľadu ani kapacitám", async () => {
  for (const sql of ["select public.esblu_my_plan_overview()", "select public.esblu_require_my_voice_capacity()", "select public.esblu_require_my_storage_capacity()"]) {
    assert.equal((await attempt(anon, sql)).layer, "privilege", sql);
  }
});

// ============================================================================= J7 corrections (2026-10-26)
// ----------------------------------------------------------------------------- AI allowance
await check("AI: Dokumenty samostatne = 10; Dokumenty + 1 balík = 50; Komplet = 40; Komplet + balík = 80; modul bez Dokumentov = 0 (bez nároku)", async () => {
  await mock(C.b, "modular", ["documents"]);
  assert.equal((await ents(C.b)).ai_documents, 10);
  await mock(C.b, "modular", ["documents"], [1, 0, 0, 0, 0]);
  assert.equal((await ents(C.b)).ai_documents, 50);
  await mock(C.b, "modular", ["vehicles", "invoicing"]);
  assert.equal((await ents(C.b)).ai_documents, "off");
  await mock(C.b, "complete");
  assert.equal((await ents(C.b)).ai_documents, 40);
  await mock(C.b, "complete", [], [1, 0, 0, 0, 0]);
  assert.equal((await ents(C.b)).ai_documents, 80);
  assert.equal((await ents(C.t)).ai_documents, 10, "trial");
});

await check("AI hard stop pri module Dokumenty: 10 rezervácií OK, 11. AI_PROCESSING_LIMIT_REACHED; firma A nezasiahnutá", async () => {
  await mock(C.b, "modular", ["documents"]);
  for (let i = 1; i <= 10; i++) {
    const o = await commitAs(ownerB, "select public.esblu_reserve_ai_processing('scan-document', $1, $2) r",
      [`docs_only_key_${String(i).padStart(6, "0")}`, "f".repeat(63) + (i % 10)]);
    assert.equal(o.layer, "ok", `${i}: ${o.message}`);
  }
  const over = await attempt(ownerB, "select public.esblu_reserve_ai_processing('scan-document', 'docs_only_key_000011', repeat('a', 64))");
  assert.match(over.message, /ENTITLEMENT_DENIED:AI_PROCESSING_LIMIT_REACHED:ai_documents/);
  const ov = await overview(ownerB);
  assert.equal(ov.usage.ai_processings.used, 10);
  assert.equal(ov.usage.ai_processings.limit, 10);
});

// ----------------------------------------------------------------------------- voice
await check("hlas: modulárny plán bez add-onu = žiadny hlas (aj s Dokumentmi); s add-onom 60 min; Komplet 60; trial 15", async () => {
  await mock(C.b, "modular", ["documents", "vehicles", "machines", "inventory"]);
  let e = await ents(C.b);
  assert.equal(e.voice, "off");
  assert.equal(e.voice_minutes, "off");
  const denied = await attempt(ownerB, "select public.esblu_require_my_voice_capacity()");
  assert.match(denied.message, /ENTITLEMENT_DENIED:VOICE_ENTITLEMENT_REQUIRED:voice/);
  await mock(C.b, "modular", ["documents"], [0, 1, 0, 0, 0]);
  e = await ents(C.b);
  assert.equal(e.voice_minutes, 60);
  await mock(C.b, "complete");
  assert.equal((await ents(C.b)).voice_minutes, 60);
  assert.equal((await ents(C.t)).voice_minutes, 15);
});

// ----------------------------------------------------------------------------- users / pending invites
const extraUser = (i: number) => `ca000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
await db.exec(`insert into auth.users (id, email) select ('ca000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'seat' || g || '@example.invalid' from generate_series(1, 40) g`);
const setActiveMembersB = async (n: number) => {
  // owner B + (n - 1) zamestnancov
  await db.exec(`set session_replication_role = replica;
    delete from public.company_members where company_id = '${C.b}' and user_id <> '${U.ownerB}';
    insert into public.company_members (company_id, user_id, role, status, permissions)
      select '${C.b}', ('ca000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'employee', 'active', '{}' from generate_series(1, ${n - 1}) g;
    delete from public.company_invites where company_id = '${C.b}';
    set session_replication_role = origin;`);
};
let inviteSeq = 0;
const invite = (who: Who) => attempt(who, "select * from public.esblu_create_company_invite($1, 'employee')", [`invitee${++inviteSeq}@example.invalid`]);
const inviteCommit = (who: Who) => commitAs(who, "select * from public.esblu_create_company_invite($1, 'employee')", [`invitee${++inviteSeq}@example.invalid`]);

await check("users: 24 aktívnych + 1 čakajúca = plno (owner sa počíta); 25. miesto nemožno rezervovať", async () => {
  await mock(C.b, "complete");
  await setActiveMembersB(24);
  assert.equal((await inviteCommit(ownerB)).layer, "ok");
  const full = await invite(ownerB);
  assert.match(full.message, /ENTITLEMENT_DENIED:USER_LIMIT_REACHED:team_members/);
  const ov = await overview(ownerB);
  assert.deepEqual([ov.usage.users.used, ov.usage.users.pending, ov.usage.users.reserved, ov.usage.users.limit], [24, 1, 25, 25]);
});

await check("users: zrušená (revoked) pozvánka uvoľní miesto; expirovaná pozvánka uvoľní miesto", async () => {
  await su(`update public.company_invites set status = 'revoked' where company_id = '${C.b}' and status = 'pending'`);
  assert.equal((await inviteCommit(ownerB)).layer, "ok", "po zrušení");
  await su(`update public.company_invites set created_at = now() - interval '8 days', expires_at = now() - interval '1 minute' where company_id = '${C.b}' and status = 'pending'`);
  assert.equal((await inviteCommit(ownerB)).layer, "ok", "po expirácii");
});

await check("users: 23 aktívnych + 2 čakajúce = plno; 25 aktívnych = žiadna nová pozvánka", async () => {
  await setActiveMembersB(23);
  assert.equal((await inviteCommit(ownerB)).layer, "ok");
  assert.equal((await inviteCommit(ownerB)).layer, "ok");
  assert.match((await invite(ownerB)).message, /USER_LIMIT_REACHED/);
  await setActiveMembersB(25);
  assert.match((await invite(ownerB)).message, /USER_LIMIT_REACHED/);
});

await check("users: čakajúce pozvánky inej firmy sa nezapočítajú; +25 add-on → limit 50", async () => {
  // B je plná (25 aktívnych); firma A2 (owner A) má vlastné miesta
  assert.equal((await inviteCommit(ownerAinA2)).layer, "ok", "A2 nie je ovplyvnená plnou firmou B");
  await mock(C.b, "complete", [], [0, 0, 1, 0, 0]);
  assert.equal((await ents(C.b)).team_members, 50);
  assert.equal((await inviteCommit(ownerB)).layer, "ok", "s add-onom je miesto");
  await setActiveMembersB(1);
});

await check("users: aktivácia členstva ostáva chránená (accept počíta aktívnych voči limitu)", async () => {
  const src = (await su<{ s: string }>("select prosrc s from pg_proc where proname = 'esblu_accept_company_invite'"))[0].s;
  assert.match(src, /esblu_require_entitlement_capacity\(v_invite\.company_id, 'team_members', v_active_members\)/);
  const create = (await su<{ s: string }>("select prosrc s from pg_proc where proname = 'esblu_create_company_invite'"))[0].s;
  assert.match(create, /ci\.status = 'pending' and ci\.expires_at > now\(\)/);
});

// ----------------------------------------------------------------------------- storage
const storageOf = async (company: string) => (await su<{ v: Json }>(`select public.esblu_company_storage_status('${company}') v`))[0].v;
await check("storage: trial 1 GB; platený 1 modul 5 GB; Komplet 5 GB; ďalšia firma 5 GB", async () => {
  assert.equal((await storageOf(C.t)).limit_mb, 1024);
  assert.equal((await attempt(ownerT, "select public.esblu_storage_upload_allowed('vehicle-photos') v")).data[0].v, true);
  await mock(C.b, "modular", ["invoicing"]);
  assert.equal((await storageOf(C.b)).limit_mb, 5120);
  assert.equal((await attempt(ownerB, "select public.esblu_storage_upload_allowed('chat-attachments') v")).data[0].v, true);
  await mock(C.a2, "complete");
  assert.equal((await storageOf(C.a2)).limit_mb, 5120);
  await mock(C.b, "complete");
  assert.equal((await storageOf(C.b)).limit_mb, 5120);
});

await check("storage: trial skončil bez plánu → 0 nových uploadov (každý firemný bucket), existujúce objekty ostávajú", async () => {
  await db.exec(`set session_replication_role = replica;
    insert into public.vehicles (id, spz, user_id, company_id) values ('cb000000-0000-4000-8000-0000000000e1', 'TE-1', '${U.ownerT}', '${C.t}');
    insert into storage.objects (bucket_id, name, metadata) values ('vehicle-photos', '${U.ownerT}/cb000000-0000-4000-8000-0000000000e1/old.webp', '{"size": 1000}');
    insert into public.vehicle_photos (company_id, vehicle_id, user_id, storage_path) values ('${C.t}', 'cb000000-0000-4000-8000-0000000000e1', '${U.ownerT}', '${U.ownerT}/cb000000-0000-4000-8000-0000000000e1/old.webp');
    update public.companies set trial_started_at = now() - interval '20 days', trial_ends_at = now() - interval '6 days' where id = '${C.t}';
    set session_replication_role = origin;`);
  const st = await storageOf(C.t);
  assert.equal(st.limit_mb, 0);
  assert.equal(st.exhausted, true);
  for (const b of ["vehicle-photos", "machine-photos", "inventory-photos", "company-logos", "ai-inbox-documents", "ai-evidence-documents", "chat-attachments"]) {
    assert.equal((await attempt(ownerT, "select public.esblu_storage_upload_allowed($1) v", [b])).data[0].v, false, b);
  }
  assert.match((await attempt(ownerT, "select public.esblu_require_my_storage_capacity()")).message, /STORAGE_LIMIT_REACHED:storage_mb/);
  const up = await attempt(ownerT, `insert into storage.objects (bucket_id, name, metadata) values ('vehicle-photos', '${U.ownerT}/cb000000-0000-4000-8000-0000000000e1/new.webp', '{"size": 1}')`);
  assert.notEqual(up.layer, "ok");
  const ow = await attempt(ownerT, `update storage.objects set metadata = '{"size": 2}' where name = '${U.ownerT}/cb000000-0000-4000-8000-0000000000e1/old.webp'`);
  assert.notEqual(ow.layer === "ok" && ow.rows > 0, true, "prepis existujúceho objektu tiež zablokovaný");
  assert.equal((await su<{ n: number }>("select count(*)::int n from storage.objects where name like '%/old.webp'"))[0].n, 1, "existujúci súbor ostáva");
  await db.exec(`set session_replication_role = replica;
    update public.companies set trial_started_at = now() - interval '1 day', trial_ends_at = now() + interval '13 days' where id = '${C.t}';
    set session_replication_role = origin;`);
});

await check("storage: zrušený platený plán → nové uploady zablokované, existujúce objekty ostávajú; RESTRICTIVE INSERT aj UPDATE", async () => {
  await mock(C.b, "modular", ["invoicing"], [0, 0, 0, 0, 0], false);
  const st = await storageOf(C.b);
  assert.equal(st.limit_mb, 0);
  assert.equal((await attempt(ownerB, "select public.esblu_storage_upload_allowed('chat-attachments') v")).data[0].v, false);
  const pol = (await su<{ n: string; c: string; p: string }>(
    "select policyname n, cmd c, permissive p from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'esblu_storage_company_capacity%' order by 1"));
  assert.deepEqual(pol.map((r) => `${r.n}:${r.c}:${r.p}`), ["esblu_storage_company_capacity:INSERT:RESTRICTIVE", "esblu_storage_company_capacity_update:UPDATE:RESTRICTIVE"]);
  await mock(C.b, "complete");
});

// ----------------------------------------------------------------------------- eInvoice accounting (half-units)
const einv = {
  reset: () => su(`delete from public.company_usage_counters where company_id = '${C.a}' and metric = 'einvoice_half_units'`),
  rec: async (units: number, times = 1) => {
    for (let i = 0; i < times; i++) {
      const o = await commitAs(service, "select public.esblu_record_einvoice_tx($1, $2::numeric) r", [C.a, String(units)]);
      assert.equal(o.data[0].r, true, o.message);
    }
  },
  half: async () => Number((await su<{ v: Json }>(`select public.esblu_einvoice_tx_status('${C.a}') v`))[0].v.used_half_units),
  can: async (units: number) => attempt(service, "select public.esblu_require_einvoice_tx_capacity($1, $2::numeric) s", [C.a, String(units)]),
};
await check("eFaktúra: odoslaná 1,0 tx (2 half), prijatá 0,5 tx (1 half), 2 prijaté = 1,0 tx; integer half-units", async () => {
  await su("update public.billing_runtime_config set einvoice_sellable = true");
  await mock(C.a, "complete");
  await einv.reset();
  await einv.rec(1);
  assert.equal(await einv.half(), 2);
  await einv.reset(); await einv.rec(0.5);
  assert.equal(await einv.half(), 1);
  await einv.rec(0.5);
  assert.equal(await einv.half(), 2);
  const cols = await su<{ t: string }>("select data_type t from information_schema.columns where table_name = 'company_usage_counters' and column_name = 'used'");
  assert.equal(cols[0].t, "numeric");
  assert.equal(P.einvoiceHalfUnits(1, 0), 2);
  assert.equal(P.einvoiceHalfUnits(0, 1), 1);
  assert.equal(P.formatEinvoiceTx(39, "sk"), "19,5");
});

await check("eFaktúra: 10 odoslaných + 20 prijatých = 20 tx = plno; ďalšia prijatá fail closed", async () => {
  await einv.reset();
  await einv.rec(1, 10); await einv.rec(0.5, 20);
  assert.equal(await einv.half(), 40);
  assert.match((await einv.can(0.5)).message, /ENTITLEMENT_DENIED:EINVOICE_LIMIT_REACHED:einvoice_transactions/);
});

await check("eFaktúra: 20 odoslaných = plno; 40 prijatých = plno; 19 odoslaných + 1 prijatá → ešte 0,5 tx voľné", async () => {
  await einv.reset(); await einv.rec(1, 20);
  assert.match((await einv.can(1)).message, /EINVOICE_LIMIT_REACHED/);
  assert.match((await einv.can(0.5)).message, /EINVOICE_LIMIT_REACHED/);
  await einv.reset(); await einv.rec(0.5, 40);
  assert.match((await einv.can(0.5)).message, /EINVOICE_LIMIT_REACHED/);
  await einv.reset(); await einv.rec(1, 19); await einv.rec(0.5, 1);
  assert.equal((await einv.can(0.5)).layer, "ok");
  assert.match((await einv.can(1)).message, /EINVOICE_LIMIT_REACHED/);
});

await check("eFaktúra add-ony: 20 + 40 = 60 tx (120 half); 20 + 100 = 120 tx (240 half); neplatná váha odmietnutá", async () => {
  await mock(C.a, "complete", [], [0, 0, 0, 1, 0]);
  let s = (await su<{ v: Json }>(`select public.esblu_einvoice_tx_status('${C.a}') v`))[0].v;
  assert.equal(s.limit_half_units, 120);
  await mock(C.a, "complete", [], [0, 0, 0, 0, 1]);
  s = (await su<{ v: Json }>(`select public.esblu_einvoice_tx_status('${C.a}') v`))[0].v;
  assert.equal(s.limit_half_units, 240);
  const bad = await commitAs(service, "select public.esblu_record_einvoice_tx($1, 0.3) r", [C.a]);
  assert.equal(bad.data[0].r, false);
  assert.match((await einv.can(0.3)).message, /ESBLU_EINVOICE_UNITS_INVALID/);
  await einv.reset();
  await su("update public.billing_runtime_config set einvoice_sellable = false");
  await mock(C.a, "complete");
  assert.equal((await ents(C.a)).einvoice_transactions, "off", "eFaktúra späť nedostupná (nie je live)");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
