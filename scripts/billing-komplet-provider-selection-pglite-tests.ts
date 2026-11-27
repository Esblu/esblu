// =============================================================================
// 20261130100000 — zaplatený Komplet zo Stripe dostane nároky aj bez staging mocku + poistka LIVE cien.
// SKUTOČNÝ PostgreSQL (PGlite), replay VŠETKÝCH migrácií. Nikdy Supabase / Stripe.
//
//   npm run test:billing-komplet-selection-db
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
const su = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
async function asService<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await db.exec("set local role service_role");
    const r = await db.query<T>(sql, params);
    await db.exec("commit");
    return r.rows;
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}
async function errorOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

await db.exec(read("scripts/sql/pglite/supabase-platform-stub.sql"));
for (const f of replayOrder(readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith(".sql")))) {
  await db.exec(read(`${MIGRATIONS}/${f}`));
}

// ----------------------------------------------------------------------------- fixtures
const U = { a: "d6000000-0000-4000-8000-0000000000a1", b: "d6000000-0000-4000-8000-0000000000b1", m: "d6000000-0000-4000-8000-0000000000c1" };
const C = {
  live: "d7000000-0000-4000-8000-00000000000a", second: "d7000000-0000-4000-8000-00000000000b",
  mock: "d7000000-0000-4000-8000-00000000000c", modular: "d7000000-0000-4000-8000-00000000000d",
  unpaid: "d7000000-0000-4000-8000-00000000000e",
};
await db.exec(`
  insert into auth.users (id, email) values ('${U.a}', 'a@example.invalid'), ('${U.b}', 'b@example.invalid'), ('${U.m}', 'm@example.invalid');
  set session_replication_role = replica;
  insert into public.companies (id, owner_id, name) values
    ('${C.live}', '${U.a}', 'Komplet s.r.o.'), ('${C.second}', '${U.a}', 'Druha s.r.o.'),
    ('${C.mock}', '${U.m}', 'Mock s.r.o.'), ('${C.modular}', '${U.b}', 'Modular s.r.o.'), ('${C.unpaid}', '${U.b}', 'Unpaid s.r.o.');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.live}', '${U.a}', 'owner', 'active', '{}'), ('${C.second}', '${U.a}', 'owner', 'active', '{}'),
    ('${C.mock}', '${U.m}', 'owner', 'active', '{}'), ('${C.modular}', '${U.b}', 'owner', 'active', '{}'),
    ('${C.unpaid}', '${U.b}', 'owner', 'active', '{}');
  set session_replication_role = origin;
`);
async function account(company: string, plan: string, status = "active", env = "test") {
  await su(
    `insert into public.subscription_accounts (company_id, plan_code, billing_interval, status, billing_provider, provider_environment,
       provider_customer_id, provider_subscription_id, current_period_start, current_period_end)
     values ($1::uuid, $2, 'month', $3, 'stripe', $4, 'cus_' || left(md5($1::uuid::text), 10), 'sub_' || left(md5($1::uuid::text), 10), now() - interval '1 day', now() + interval '29 days')
     on conflict (company_id) do update set plan_code = excluded.plan_code, status = excluded.status, provider_environment = excluded.provider_environment`,
    [company, plan, status, env],
  );
}
const sync = (company: string) => asService<{ n: number }>("select public.esblu_billing_sync_entitlements($1) n", [company]);
const ents = (company: string) =>
  su<{ entitlement_key: string; limit_value: number | null; status: string }>(
    "select entitlement_key, limit_value, status from public.company_entitlements where company_id = $1 and source = 'subscription' order by entitlement_key",
    [company],
  );
const selection = (company: string) => su<Row>("select plan_kind, price_tier, modules, source, version from public.company_plan_selection where company_id = $1", [company]);

// ----------------------------------------------------------------------------- testy
await check("zaplatený Komplet (Stripe) BEZ staging mocku → kompozícia 'provider' + nároky Kompletu", async () => {
  await account(C.live, "esblu_complete");
  assert.equal((await selection(C.live)).length, 0, "pred synchronizáciou bez kompozície (stav produkcie)");
  const [{ n }] = await sync(C.live);
  assert.ok(n > 0, `nároky: ${n}`);
  const sel = await selection(C.live);
  assert.equal(sel.length, 1);
  assert.equal(sel[0].plan_kind, "complete");
  assert.equal(sel[0].price_tier, "primary");
  assert.equal(sel[0].source, "provider");
  const keys = (await ents(C.live)).filter((e) => e.status === "active").map((e) => e.entitlement_key);
  for (const k of ["vehicles", "machines", "inventory", "invoicing", "ai_documents", "voice", "voice_minutes", "team_members", "storage_mb"]) {
    assert.ok(keys.includes(k), `chýba nárok ${k} (${keys.join(",")})`);
  }
  assert.ok(!keys.includes("einvoice"), "eFaktúra sa nepredáva (einvoice_sellable=false)");
  const docs = (await ents(C.live)).find((e) => e.entitlement_key === "ai_documents");
  assert.equal(docs?.limit_value, 40, "Komplet: 40 AI dokumentov");
});

await check("opakovaná synchronizácia je idempotentná (žiadna nová verzia kompozície)", async () => {
  const before = (await selection(C.live))[0].version;
  await sync(C.live);
  await sync(C.live);
  assert.equal((await selection(C.live))[0].version, before);
});

await check("esblu_complete_secondary → tier 'secondary' (kompozícia Komplet)", async () => {
  await account(C.second, "esblu_complete_secondary");
  await sync(C.second);
  const sel = await selection(C.second);
  assert.equal(sel[0].plan_kind, "complete");
  assert.equal(sel[0].price_tier, "secondary");
  assert.ok((await ents(C.second)).some((e) => e.entitlement_key === "invoicing" && e.status === "active"));
});

await check("staging mock kompozícia sa NEPREPISUJE (modulárny výber z mocku ostáva)", async () => {
  await su("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false)");
  await su("update public.billing_runtime_config set allow_mock_plans = true where id");
  await asService("select public.esblu_staging_mock_set_plan($1, 'modular', array['vehicles'], 0, 0, 0, 0, 0, true)", [C.mock]);
  await account(C.mock, "esblu_complete");
  await sync(C.mock);
  const sel = await selection(C.mock);
  assert.equal(sel[0].source, "staging_mock");
  assert.equal(sel[0].plan_kind, "modular");
  await su("update public.billing_runtime_config set allow_mock_plans = false where id");
});

await check("modulárny plán bez kompozície → žiadne nároky (fail closed, moduly sa neodvodzujú)", async () => {
  await account(C.modular, "esblu_modular");
  const [{ n }] = await sync(C.modular);
  assert.equal(n, 0);
  assert.equal((await selection(C.modular)).length, 0);
});

await check("neoprávnený stav (unpaid) → kompozícia sa nevytvorí, nároky žiadne", async () => {
  await account(C.unpaid, "esblu_complete", "unpaid");
  await sync(C.unpaid);
  assert.equal((await selection(C.unpaid)).length, 0);
  assert.equal((await ents(C.unpaid)).filter((e) => e.status === "active").length, 0);
});

await check("refundácia / ukončenie → nároky odvolané, kompozícia ostáva (údaj o pláne, nič sa nemaže)", async () => {
  await su("update public.subscription_accounts set status = 'unpaid' where company_id = $1", [C.live]);
  await sync(C.live);
  assert.equal((await ents(C.live)).filter((e) => e.status === "active").length, 0);
  assert.equal((await selection(C.live)).length, 1);
});

await check("LIVE cena: esblu_modular a esblu_complete_secondary odmietnuté, esblu_complete povolený, TEST ceny bez zmeny", async () => {
  const ins = (plan: string, env: string, id: string) =>
    su(
      `insert into public.billing_provider_prices (provider, environment, plan_code, billing_interval, provider_price_id, active)
       values ('stripe', $1, $2, 'month', $3, true)`,
      [env, plan, id],
    );
  assert.match(await errorOf(() => ins("esblu_modular", "live", "price_live_mod")), /ESBLU_BILLING_PLAN_NOT_LIVE_SELLABLE/);
  assert.match(await errorOf(() => ins("esblu_complete_secondary", "live", "price_live_sec")), /ESBLU_BILLING_PLAN_NOT_LIVE_SELLABLE/);
  assert.equal(await errorOf(() => ins("esblu_complete", "live", "price_live_complete")), "");
  assert.equal(await errorOf(() => ins("esblu_modular", "test", "price_test_mod")), "");
  assert.equal(await errorOf(() => ins("esblu_complete_secondary", "test", "price_test_sec")), "");
  assert.match(
    await errorOf(() => su("update public.billing_provider_prices set plan_code = 'esblu_modular' where provider_price_id = 'price_live_complete'")),
    /ESBLU_BILLING_PLAN_NOT_LIVE_SELLABLE/,
  );
});

await check("granty: poistka nie je volateľná klientom ani service_role", async () => {
  const rows = await su<{ a: boolean; s: boolean }>(
    "select has_function_privilege('authenticated', 'public.esblu_billing_live_price_guard()', 'execute') a, has_function_privilege('service_role', 'public.esblu_billing_live_price_guard()', 'execute') s",
  );
  assert.equal(rows[0].a, false);
  assert.equal(rows[0].s, false);
});

await check("rollback súbor existuje a vracia pôvodnú funkciu + odstraňuje poistku", async () => {
  const rb = read("supabase/rollback/20261130100000_billing_komplet_provider_selection_rollback.sql");
  assert.match(rb, /create or replace function public\.esblu_billing_sync_entitlements/);
  assert.doesNotMatch(rb, /company_plan_selection as s \(company_id, plan_kind, price_tier, source\)/);
  assert.match(rb, /drop trigger if exists esblu_billing_live_price_guard/);
});

console.log(`\nbilling-komplet-selection: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
