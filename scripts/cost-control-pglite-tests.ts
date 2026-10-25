// =============================================================================
// Cost control hardening — SKUTOČNÝ PostgreSQL (PGlite), čistý replay migrácií.
//
//   - AI usage telemetria (20261025100000): service-only zápis, company scoping
//     (multi-company), fail closed, žiadny klientsky prístup, žiadne obsahové
//     ani osobné stĺpce, retencia s minimom 13 mesiacov.
//   - notification_deliveries chat retencia (20261025110000): maže iba staré
//     'chat' dedupe riadky po dávkach, 'deadline' nikdy.
// Nikdy Supabase / staging / produkcia.
//
//   npm run test:cost-control-db
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
// ----------------------------------------------------------------------------- fixtures
const U = {
  ownerA: "c2000000-0000-4000-8000-0000000000a1",
  employeeA: "c2000000-0000-4000-8000-0000000000a4",
  disabledA: "c2000000-0000-4000-8000-0000000000a9",
  ownerB: "c2000000-0000-4000-8000-0000000000b1",
  multi: "c2000000-0000-4000-8000-0000000000c1",
  outsider: "c2000000-0000-4000-8000-0000000000d1",
};
const C = { a: "c3000000-0000-4000-8000-00000000000a", b: "c3000000-0000-4000-8000-00000000000b" };
const S = { ownerA: "c4000000-0000-4000-8000-0000000000a1", employeeA: "c4000000-0000-4000-8000-0000000000a4", ownerB: "c4000000-0000-4000-8000-0000000000b1" };
await db.exec(`
  insert into auth.users (id, email) values
    ('${U.ownerA}', 'oa@example.invalid'), ('${U.employeeA}', 'ea@example.invalid'), ('${U.disabledA}', 'da@example.invalid'),
    ('${U.ownerB}', 'ob@example.invalid'), ('${U.multi}', 'm@example.invalid'), ('${U.outsider}', 'x@example.invalid');
  insert into auth.sessions (id, user_id) values ('${S.ownerA}', '${U.ownerA}'), ('${S.employeeA}', '${U.employeeA}'), ('${S.ownerB}', '${U.ownerB}');
  set session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values ('${C.a}', '${U.ownerA}', 'Firma A'), ('${C.b}', '${U.ownerB}', 'Firma B');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.a}', '${U.ownerA}', 'owner', 'active', '{}'),
    ('${C.a}', '${U.employeeA}', 'employee', 'active', '{}'),
    ('${C.a}', '${U.disabledA}', 'employee', 'disabled', '{}'),
    ('${C.a}', '${U.multi}', 'employee', 'active', '{}'),
    ('${C.b}', '${U.ownerB}', 'owner', 'active', '{}'),
    ('${C.b}', '${U.multi}', 'employee', 'active', '{}');
  set session_replication_role = origin;
`);
const ownerA = as(U.ownerA, S.ownerA), employeeA = as(U.employeeA, S.employeeA), ownerB = as(U.ownerB, S.ownerB);
const service: Who = { role: "service_role" };
const anon: Who = { role: "anon" };

const REC = "select public.esblu_record_ai_usage($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) r";
const rec = (company: string, user: string, flow = "document_scan", model = "gpt-5.6-terra", outcome = "success",
  nums: [number, number, number, number, number, number, number] = [9000, 0, 1500, 0, 0, 1, 0]) =>
  commitAs(service, REC, [company, user, flow, model, outcome, ...nums]);
const usage = (company: string) =>
  su<{ flow_type: string; model: string; outcome: string; requests: string; input_tokens: string; cached_input_tokens: string; output_tokens: string; audio_seconds: string; image_count: string; retry_count: string }>(
    "select flow_type, model, outcome, requests::text, input_tokens::text, cached_input_tokens::text, output_tokens::text, audio_seconds::text, image_count::text, retry_count::text from public.ai_usage_monthly where company_id = $1 order by flow_type, model, outcome", [company]);

// ----------------------------------------------------------------------------- AI usage telemetria
await check("telemetry: tabuľka obsahuje iba technické metriky (žiadny user_id, prompt, text, transcript, obsah)", async () => {
  const cols = (await su<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ai_usage_monthly' order by ordinal_position")).map((r) => r.column_name);
  assert.deepEqual(cols, ["company_id", "period_month", "flow_type", "model", "outcome", "requests", "input_tokens", "cached_input_tokens",
    "output_tokens", "audio_input_tokens", "audio_seconds", "image_count", "retry_count", "first_recorded_at", "last_recorded_at"]);
  for (const c of cols) assert.doesNotMatch(c, /user|email|prompt|text|transcript|content|body|name|ip/);
});

await check("telemetry: service zápis → mesačné počítadlo; druhý zápis inkrementuje (nie nový riadok)", async () => {
  assert.equal((await rec(C.a, U.ownerA)).data[0].r, true);
  assert.equal((await rec(C.a, U.employeeA, "document_scan", "gpt-5.6-terra", "success", [8000, 6000, 1000, 0, 0, 1, 1])).data[0].r, true);
  const rows = await usage(C.a);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].requests, rows[0].input_tokens, rows[0].cached_input_tokens, rows[0].output_tokens, rows[0].image_count, rows[0].retry_count],
    ["2", "17000", "6000", "2500", "2", "1"]);
});

await check("telemetry: flow × model × výsledok sú oddelené riadky (prepis s audio sekundami, zlyhanie)", async () => {
  assert.equal((await rec(C.a, U.ownerA, "voice_transcription", "gpt-4o-transcribe", "success", [300, 0, 20, 250, 4.5, 0, 0])).data[0].r, true);
  assert.equal((await rec(C.a, U.ownerA, "intent_classification_fallback", "gpt-5.6-terra", "failure", [0, 0, 0, 0, 0, 0, 1])).data[0].r, true);
  const rows = await usage(C.a);
  assert.equal(rows.length, 3);
  const voice = rows.find((r) => r.flow_type === "voice_transcription");
  assert.equal(voice?.audio_seconds, "4.500");
});

await check("company scoping: multi-company používateľ — usage A ≠ usage B", async () => {
  assert.equal((await rec(C.b, U.multi, "vehicle_registration_scan", "gpt-4.1-mini", "success", [5000, 0, 400, 0, 0, 2, 0])).data[0].r, true);
  const b = await usage(C.b);
  assert.equal(b.length, 1);
  assert.equal(b[0].flow_type, "vehicle_registration_scan");
  assert.equal((await usage(C.a)).some((r) => r.flow_type === "vehicle_registration_scan"), false);
});

await check("fail closed: používateľ mimo firmy / neaktívny člen / chýbajúce ID → nič sa nezapíše", async () => {
  const before = (await su("select count(*)::int n from public.ai_usage_monthly"))[0].n;
  assert.equal((await rec(C.b, U.ownerA)).data[0].r, false); // owner A nie je členom B
  assert.equal((await rec(C.a, U.outsider)).data[0].r, false);
  assert.equal((await rec(C.a, U.disabledA)).data[0].r, false);
  assert.equal((await commitAs(service, REC, [null, U.ownerA, "document_scan", "gpt-5.6-terra", "success", 1, 0, 1, 0, 0, 1, 0])).data[0].r, false);
  assert.equal((await commitAs(service, REC, [C.a, null, "document_scan", "gpt-5.6-terra", "success", 1, 0, 1, 0, 0, 1, 0])).data[0].r, false);
  assert.equal((await su("select count(*)::int n from public.ai_usage_monthly"))[0].n, before);
});

await check("company scoping (skeny): firma + používateľ sa odvodia z AI rezervácie; neznáma rezervácia / ne-sken flow → false", async () => {
  const resB = (await su<{ id: string }>(`insert into public.ai_processing_usage (company_id, user_id, endpoint, idempotency_key, content_sha256, entitlement_source)
    values ('${C.b}', '${U.multi}', 'scan-document', 'idem_key_for_tests_0001', repeat('a', 64), 'manual') returning id`))[0].id;
  const RES = "select public.esblu_record_ai_usage_for_reservation($1, $2, $3, $4, $5, $6, $7, $8, $9) r";
  assert.equal((await commitAs(service, RES, [resB, "document_scan", "gpt-5.6-terra", "success", 9100, 0, 1400, 1, 0])).data[0].r, true);
  assert.equal((await commitAs(service, RES, [resB, "document_scan_plate_fallback", "gpt-4.1", "success", 3800, 0, 60, 1, 0])).data[0].r, true);
  const b = await usage(C.b);
  assert.ok(b.some((r) => r.flow_type === "document_scan" && r.input_tokens === "9100"));
  assert.ok(b.some((r) => r.flow_type === "document_scan_plate_fallback"));
  assert.equal((await usage(C.a)).some((r) => r.input_tokens === "9100"), false);
  assert.equal((await commitAs(service, RES, ["c9000000-0000-4000-8000-000000000000", "document_scan", "gpt-5.6-terra", "success", 1, 0, 1, 1, 0])).data[0].r, false);
  assert.equal((await commitAs(service, RES, [resB, "voice_transcription", "gpt-4o-transcribe", "success", 1, 0, 1, 0, 0])).data[0].r, false);
  for (const who of [ownerA, employeeA, ownerB, anon]) {
    assert.equal((await attempt(who, RES, [resB, "document_scan", "gpt-5.6-terra", "success", 1, 0, 1, 1, 0])).layer, "privilege");
  }
});

await check("fail closed: neznámy flow, neplatný model, záporné / absurdné čísla → false", async () => {
  assert.equal((await rec(C.a, U.ownerA, "ai_chatbot")).data[0].r, false);
  assert.equal((await rec(C.a, U.ownerA, "document_scan", "GPT 5 <script>")).data[0].r, false);
  assert.equal((await rec(C.a, U.ownerA, "document_scan", "gpt-5.6-terra", "maybe")).data[0].r, false);
  assert.equal((await rec(C.a, U.ownerA, "document_scan", "gpt-5.6-terra", "success", [-1, 0, 0, 0, 0, 0, 0])).data[0].r, false);
  assert.equal((await rec(C.a, U.ownerA, "document_scan", "gpt-5.6-terra", "success", [1, 0, 1, 0, 0, 0, 99])).data[0].r, false);
});

await check("security: owner / employee / iná firma / anon nevedia čítať, meniť ani podvrhnúť usage", async () => {
  for (const who of [ownerA, employeeA, ownerB, anon]) {
    for (const sql of [
      "select * from public.ai_usage_monthly",
      `insert into public.ai_usage_monthly (company_id, period_month, flow_type, model, outcome) values ('${C.a}', date_trunc('month', now())::date, 'document_scan', 'x1', 'success')`,
      "update public.ai_usage_monthly set requests = 0",
      "delete from public.ai_usage_monthly",
    ]) {
      const o = await attempt(who, sql);
      assert.equal(o.layer, "privilege", `${who.role} ${who.uid ?? ""}: ${sql} → ${o.layer} ${o.message}`);
    }
    const r = await attempt(who, REC, [C.a, U.ownerA, "document_scan", "gpt-5.6-terra", "success", 1, 0, 1, 0, 0, 1, 0]);
    assert.equal(r.layer, "privilege", `${who.role}: record RPC → ${r.layer}`);
    const p = await attempt(who, "select public.esblu_purge_ai_usage_monthly(13)");
    assert.equal(p.layer, "privilege");
  }
});

await check("security: service_role nemá obchádzku cez anon/authenticated EXECUTE (ACL funkcií)", async () => {
  const acl = await su<{ proname: string; acl: string }>(
    "select p.proname, coalesce(array_to_string(p.proacl, ','), '') acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('esblu_record_ai_usage', 'esblu_record_ai_usage_for_reservation', 'esblu_purge_ai_usage_monthly', 'esblu_purge_chat_notification_deliveries')");
  assert.equal(acl.length, 4);
  for (const row of acl) {
    assert.match(row.acl, /service_role=X/);
    assert.doesNotMatch(row.acl, /(^|,)(anon|authenticated)=|(^|,)=X/);
  }
});

await check("retencia: purge zachová min. 13 mesiacov aj pri chybnom parametri; staré mesiace zmaže", async () => {
  await su(`insert into public.ai_usage_monthly (company_id, period_month, flow_type, model, outcome, requests) values
    ('${C.a}', (date_trunc('month', now()) - interval '12 months')::date, 'document_scan', 'gpt-5.6-terra', 'success', 1),
    ('${C.a}', (date_trunc('month', now()) - interval '30 months')::date, 'document_scan', 'gpt-5.6-terra', 'success', 1)`);
  const o = await commitAs(service, "select public.esblu_purge_ai_usage_monthly(0) n");
  assert.equal(o.data[0].n, 1);
  const months = (await su<{ m: string }>(`select period_month::text m from public.ai_usage_monthly where company_id = '${C.a}' order by 1`)).map((r) => r.m);
  assert.equal(months.length, 4); // aktuálny mesiac (3 flowy) + 12 mesiacov starý
});

// ----------------------------------------------------------------------------- J8 intent command počítadlá
const CMD = "select public.esblu_record_intent_command($1, $2, $3, $4) r";
await check("J8 intent_command: +1 v triede (deterministic / ai-fallback / unsupported / ambiguous), žiadne tokeny ani obsah", async () => {
  for (const cls of ["deterministic", "deterministic", "ai-fallback", "unsupported", "ambiguous"]) {
    assert.equal((await commitAs(service, CMD, [C.a, U.ownerA, cls, "success"])).data[0].r, true);
  }
  const rows = (await usage(C.a)).filter((r) => r.flow_type === "intent_command");
  assert.deepEqual(rows.map((r) => [r.model, r.requests, r.input_tokens, r.output_tokens]),
    [["ai-fallback", "1", "0", "0"], ["ambiguous", "1", "0", "0"], ["deterministic", "2", "0", "0"], ["unsupported", "1", "0", "0"]]);
});
await check("J8 intent_command: fail closed (cudzia firma, neaktívny, neznáma trieda/výsledok) a starý RPC flow nepustí", async () => {
  const before = (await su("select count(*)::int n from public.ai_usage_monthly"))[0].n;
  assert.equal((await commitAs(service, CMD, [C.b, U.ownerA, "deterministic", "success"])).data[0].r, false);
  assert.equal((await commitAs(service, CMD, [C.a, U.disabledA, "deterministic", "success"])).data[0].r, false);
  assert.equal((await commitAs(service, CMD, [C.a, U.ownerA, "chat", "success"])).data[0].r, false);
  assert.equal((await commitAs(service, CMD, [C.a, U.ownerA, "deterministic", "maybe"])).data[0].r, false);
  assert.equal((await rec(C.a, U.ownerA, "intent_command", "deterministic", "success", [0, 0, 0, 0, 0, 0, 0])).data[0].r, false);
  assert.equal((await su("select count(*)::int n from public.ai_usage_monthly"))[0].n, before);
});
await check("J8 intent_command: klient (owner / employee / anon) nevie zapisovať počítadlá", async () => {
  for (const who of [ownerA, employeeA, anon]) {
    const o = await attempt(who, `select public.esblu_record_intent_command('${C.a}', '${U.ownerA}', 'deterministic', 'success')`);
    assert.equal(o.layer, "privilege");
  }
});

// ----------------------------------------------------------------------------- notification_deliveries retencia
await check("notification retencia: maže iba 'chat' staršie ako N dní, 'deadline' (vrátane overdue) nikdy, po dávkach", async () => {
  await su(`insert into public.notification_deliveries (user_id, company_id, kind, dedupe_key, sent_at)
    select '${U.ownerA}', '${C.a}', 'chat', 'chat:old-' || g, now() - interval '10 days' from generate_series(1, 7) g`);
  await su(`insert into public.notification_deliveries (user_id, company_id, kind, dedupe_key, sent_at) values
    ('${U.ownerA}', '${C.a}', 'chat', 'chat:fresh', now() - interval '1 hour'),
    ('${U.ownerA}', '${C.a}', 'deadline', 'deadline:vehicle_stk:x:2025-01-01:overdue', now() - interval '400 days'),
    ('${U.ownerA}', '${C.a}', 'deadline', 'deadline:vehicle_stk:x:2025-01-01:7', now() - interval '400 days')`);
  const first = await commitAs(service, "select public.esblu_purge_chat_notification_deliveries(7, 5) n");
  assert.equal(first.data[0].n, 5);
  const second = await commitAs(service, "select public.esblu_purge_chat_notification_deliveries(7, 5) n");
  assert.equal(second.data[0].n, 2);
  const left = (await su<{ k: string }>("select dedupe_key k from public.notification_deliveries order by 1")).map((r) => r.k);
  assert.deepEqual(left, ["chat:fresh", "deadline:vehicle_stk:x:2025-01-01:7", "deadline:vehicle_stk:x:2025-01-01:overdue"]);
});

await check("notification retencia: minimum 1 deň — p_older_than_days=0 nezmaže čerstvý dedupe riadok", async () => {
  const o = await commitAs(service, "select public.esblu_purge_chat_notification_deliveries(0, 100) n");
  assert.equal(o.data[0].n, 0);
});

await check("notification retencia: klient (owner/employee/anon) nevie spustiť purge", async () => {
  for (const who of [ownerA, employeeA, anon]) {
    const o = await attempt(who, "select public.esblu_purge_chat_notification_deliveries(7, 10)");
    assert.equal(o.layer, "privilege");
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
