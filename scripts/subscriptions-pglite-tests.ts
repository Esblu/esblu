// =============================================================================
// Unified subscriptions — SKUTOČNÝ PostgreSQL test (PGlite) pre
//   20261008120000_subscriptions_platform.sql
// nad prod-vernou entitlement vrstvou:
//   scripts/sql/entitlements-local-baseline.sql + 20260928100000_company_entitlements_trial.sql
// a nad SKUTOČNOU TS pipeline (lib/billing/pipeline.ts + fake provider +
// Apple/Google normalizéry). NIKDY sa nepripája na Supabase ani na Stripe.
//
// Matica rolí: owner / admin / admin+billing.manage / accountant / employee /
// neaktívny člen / owner INEJ firmy.
//
// SPUSTENIE (PGlite nie je závislosť projektu):
//   npm i --no-save @electric-sql/pglite@0.5.8   (alebo PGLITE_DIR=…/node_modules/@electric-sql/pglite)
//   npm run test:subscriptions-db
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyProviderState, processWebhook, type BillingDb } from "@/lib/billing/pipeline";
import { FakeBillingProvider, MemoryFakeStateStore } from "@/lib/billing/providers/fake";
import { normalizeAppleNotification, normalizeGoogleSubscription } from "@/lib/billing/providers/stores";
import { sha256Hex, signTimestamped } from "@/lib/billing/signature";
import { interpretCheckoutReturn, parseSubscriptionView } from "@/lib/billing/client-model";
import type { NormalizedSubscriptionState } from "@/lib/billing/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const MIGRATION = "supabase/migrations/20261008120000_subscriptions_platform.sql";
const ROLLBACK = "supabase/rollback/20261008120000_subscriptions_platform_rollback.sql";

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

// ----------------------------------------------------------------------------- schéma
await db.exec(read("scripts/sql/entitlements-local-baseline.sql"));
await db.exec(`
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`);
await db.exec(read("supabase/migrations/20260928100000_company_entitlements_trial.sql"));
await db.exec(read(MIGRATION));
await check("migrácia je idempotentná (druhé spustenie)", async () => {
  await db.exec(read(MIGRATION));
});

// ----------------------------------------------------------------------------- dáta
const C = {
  A: "a0000000-0000-4000-8000-00000000000a",
  B: "b0000000-0000-4000-8000-00000000000b",
  X: "c0000000-0000-4000-8000-00000000000c", // trial skončil
  I: "d0000000-0000-4000-8000-00000000000d", // iOS firma
  G: "e0000000-0000-4000-8000-00000000000e", // Android firma
};
const U = {
  owner: "10000000-0000-4000-8000-000000000001",
  admin: "10000000-0000-4000-8000-000000000002",
  billingAdmin: "10000000-0000-4000-8000-000000000003",
  acc: "10000000-0000-4000-8000-000000000004",
  emp: "10000000-0000-4000-8000-000000000005",
  gone: "10000000-0000-4000-8000-000000000006",
  ownerB: "20000000-0000-4000-8000-000000000001",
  ownerX: "30000000-0000-4000-8000-000000000001",
  ownerI: "40000000-0000-4000-8000-000000000001",
  empI: "40000000-0000-4000-8000-000000000002",
  ownerG: "50000000-0000-4000-8000-000000000001",
};
await db.exec(`
  insert into auth.users (id, email) values ${Object.entries(U).map(([k, id]) => `('${id}', '${k}@example.invalid')`).join(", ")};
  insert into public.companies (id, owner_id, name) values
    ('${C.A}', '${U.owner}', 'A'), ('${C.B}', '${U.ownerB}', 'B'), ('${C.X}', '${U.ownerX}', 'X'),
    ('${C.I}', '${U.ownerI}', 'I'), ('${C.G}', '${U.ownerG}', 'G');
  insert into public.company_members (company_id, user_id, role, status, permissions) values
    ('${C.A}', '${U.owner}', 'owner', 'active', '{}'),
    ('${C.A}', '${U.admin}', 'admin', 'active', '{"finance":{"view":true,"manage":true}}'),
    ('${C.A}', '${U.billingAdmin}', 'admin', 'active', '{"billing":{"manage":true}}'),
    ('${C.A}', '${U.acc}', 'accountant', 'active', '{}'),
    ('${C.A}', '${U.emp}', 'employee', 'active', '{}'),
    ('${C.A}', '${U.gone}', 'owner', 'disabled', '{}'),
    ('${C.B}', '${U.ownerB}', 'owner', 'active', '{}'),
    ('${C.X}', '${U.ownerX}', 'owner', 'active', '{}'),
    ('${C.I}', '${U.ownerI}', 'owner', 'active', '{}'),
    ('${C.I}', '${U.empI}', 'employee', 'active', '{}'),
    ('${C.G}', '${U.ownerG}', 'owner', 'active', '{}');
  insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method)
  select c.id, d.version, c.owner_id, 'company_dpa_gate'
  from public.companies c cross join lateral (
    select version from public.legal_documents where type = 'dpa' order by effective_at desc limit 1) d;
  -- Firma X: trial skončil (trigger trialu je nemenný — test ho obíde ako superuser).
  alter table public.companies disable trigger esblu_companies_trial_guard;
  update public.companies set trial_started_at = now() - interval '30 days', trial_ends_at = now() - interval '16 days' where id = '${C.X}';
  alter table public.companies enable trigger esblu_companies_trial_guard;
  update public.billing_runtime_config set web_provider = 'fake';
`);

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
async function asRole<T>(role: "anon" | "service_role", fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
    await db.exec(`set local role ${role}`);
    const result = await fn();
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
async function fails(fn: () => Promise<unknown>, pattern?: RegExp): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern) assert.match(message, pattern);
    return message;
  }
  throw new Error("očakávaná chyba, prešlo");
}
const one = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rpcAs = async (uid: string, fn: string, args: unknown[] = []) =>
  as(uid, async () => (await db.query<{ r: unknown }>(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) r`, args)).rows[0].r);

/** service_role BillingDb nad PGlite — presne tie isté RPC, ktoré volá server. */
const serviceDb: BillingDb = {
  rpc: async (fn, args = {}) => {
    const entries = Object.entries(args);
    const sql = `select public.${fn}(${entries.map(([k], i) => `${k} => $${i + 1}`).join(", ")}) r`;
    const params = entries.map(([, v]) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v));
    try {
      const rows = await asRole("service_role", async () => (await db.query<{ r: unknown }>(sql, params)).rows);
      return { data: rows[0]?.r ?? null, error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  },
};

const SECRET = "fake_test_secret_0123456789abcdef";
let clock = new Date();
const store = new MemoryFakeStateStore();
const fake = new FakeBillingProvider(SECRET, store, () => clock);
const tick = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};
async function deliver(type: string, state: NormalizedSubscriptionState, eventId?: string) {
  const signed = fake.signEvent(fake.buildEvent(type, state, eventId));
  return { ...(await processWebhook(fake, signed.rawBody, signed.headers, serviceDb)), signed };
}
async function entitlementsOf(uid: string) {
  return (await rpcAs(uid, "esblu_get_my_company_entitlements")) as { entitlements: { key: string; active: boolean; source?: string; limit?: number | null; reason?: string }[] };
}
const ent = (data: Awaited<ReturnType<typeof entitlementsOf>>, key: string) => data.entitlements.find((e) => e.key === key)!;
async function subscriptionOf(uid: string) {
  return parseSubscriptionView(await rpcAs(uid, "esblu_get_my_subscription"))!;
}
async function subscriptionRowsA() {
  return Number((await one<{ n: number }>(`select count(*)::int n from public.company_entitlements where company_id = '${C.A}' and source = 'subscription'`)).n);
}

// ============================================================================= 1. Granty / RLS
await check("authenticated nemá priamy prístup k žiadnej billing tabuľke", async () => {
  for (const table of ["subscription_accounts", "billing_events", "billing_provider_prices", "billing_provider_links", "billing_checkout_sessions", "subscription_plans", "subscription_plan_entitlements", "billing_runtime_config"]) {
    await fails(() => as(U.owner, () => db.query(`select * from public.${table}`)), /permission denied/);
    await fails(() => as(U.owner, () => db.query(`delete from public.${table}`)), /permission denied/);
  }
  await fails(() => as(U.owner, () => db.query(`insert into public.company_entitlements (company_id, entitlement_key, source) values ('${C.A}', 'voice', 'subscription')`)), /permission denied/);
});
await check("anon nemôže volať žiadne billing RPC", async () => {
  for (const fn of ["esblu_get_my_subscription()", "esblu_billing_list_plans()", "esblu_billing_create_checkout_intent('test_pro','month')", "esblu_billing_my_access()"]) {
    await fails(() => asRole("anon", () => db.query(`select public.${fn}`)), /permission denied/);
  }
});
await check("authenticated nemôže volať service-only RPC (apply/record/sync/attach/resolve_price/close)", async () => {
  const calls = [
    `esblu_billing_record_event('fake','test','evt_x','t',now(),null)`,
    `esblu_billing_apply_event(gen_random_uuid(), '{}'::jsonb)`,
    `esblu_billing_sync_entitlements('${C.A}')`,
    `esblu_billing_attach_checkout_session(gen_random_uuid(), 'x')`,
    `esblu_billing_resolve_price('fake','test','test_pro','month')`,
    `esblu_billing_close_event(gen_random_uuid(),'ignored',null,'{}'::jsonb)`,
  ];
  for (const call of calls) await fails(() => as(U.owner, () => db.query(`select public.${call}`)), /permission denied/);
});
await check("klient nemôže poslať price ID (RPC nemá taký parameter)", async () => {
  await fails(() => as(U.owner, () => db.query(`select public.esblu_billing_create_checkout_intent('test_pro','month','fake_price_pro_month')`)), /does not exist/);
});

// ============================================================================= 2. Rolová matica checkoutu
await check("owner a admin+billing.manage smú začať checkout; admin(finance) / accountant / employee / neaktívny nie", async () => {
  const ok = (await rpcAs(U.owner, "esblu_billing_create_checkout_intent", ["test_pro", "month"])) as Row;
  assert.equal(ok.provider, "fake");
  assert.equal(ok.provider_price_id, "fake_price_pro_month");
  await rpcAs(U.billingAdmin, "esblu_billing_create_checkout_intent", ["test_starter", "year"]);
  await fails(() => rpcAs(U.admin, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /ESBLU_BILLING_FORBIDDEN/);
  await fails(() => rpcAs(U.acc, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /ESBLU_BILLING_FORBIDDEN/);
  await fails(() => rpcAs(U.emp, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /ESBLU_BILLING_FORBIDDEN/);
  await fails(() => rpcAs(U.gone, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /ESBLU_NO_ACTIVE_COMPANY/);
});
await check("neznámy plán / neplatný interval / vypnutý billing", async () => {
  await fails(() => rpcAs(U.owner, "esblu_billing_create_checkout_intent", ["enterprise_gold", "month"]), /PLAN_NOT_PURCHASABLE/);
  await fails(() => rpcAs(U.owner, "esblu_billing_create_checkout_intent", ["test_pro", "week"]), /INTERVAL_INVALID/);
  await db.exec(`update public.billing_runtime_config set web_provider = 'none'`);
  await fails(() => rpcAs(U.owner, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /ESBLU_BILLING_DISABLED/);
  await db.exec(`update public.billing_runtime_config set web_provider = 'fake'`);
});
await check("live prostredie je v DB zakázané (check constraint)", async () => {
  await fails(() => db.query(`update public.billing_runtime_config set environment = 'live'`), /billing_runtime_config_env_check/);
});
await check("employee / accountant nesmú meniť predplatné ani vydať mobilný token", async () => {
  for (const uid of [U.emp, U.acc, U.admin]) {
    await fails(() => rpcAs(uid, "esblu_billing_authorize_manage"), /ESBLU_BILLING_FORBIDDEN/);
    await fails(() => rpcAs(uid, "esblu_billing_issue_account_token", ["apple"]), /ESBLU_BILLING_FORBIDDEN/);
  }
});
await check("list_plans nevracia price ID", async () => {
  const plans = (await rpcAs(U.emp, "esblu_billing_list_plans")) as Row;
  assert.ok(!JSON.stringify(plans).includes("fake_price_"));
  assert.equal((plans.plans as Row[]).length, 2);
});

// ============================================================================= 3. Trial → paid (web)
let checkoutA = "";
let subA: NormalizedSubscriptionState;
await check("pred kúpou: trial firmy A, hlas nie je v triale", async () => {
  const e = await entitlementsOf(U.owner);
  assert.equal(ent(e, "vehicles").source, "trial");
  assert.equal(ent(e, "voice").active, false);
  assert.equal((await subscriptionOf(U.owner)).status, "none");
});
await check("fake 'success' redirect: neoverený checkout NIE JE potvrdenie", async () => {
  checkoutA = String(((await rpcAs(U.owner, "esblu_billing_create_checkout_intent", ["test_pro", "month"])) as Row).checkout_id);
  const status = (await rpcAs(U.owner, "esblu_get_my_checkout_status", [checkoutA])) as Row;
  assert.equal(status.status, "created");
  const verdict = interpretCheckoutReturn({ checkout: "returned" }, { checkoutStatus: String(status.status), subscription: await subscriptionOf(U.owner) });
  assert.equal(verdict, "pending");
  assert.equal(ent(await entitlementsOf(U.owner), "voice").active, false);
});
await check("cudzí checkout ID → found:false (žiadny oracle)", async () => {
  assert.deepEqual(await rpcAs(U.ownerB, "esblu_get_my_checkout_status", [checkoutA]), { found: false });
});
await check("webhook (podpísaný) → Pro aktívne; web/Android/iOS používateľ vidí rovnaké nároky", async () => {
  subA = await fake.simulateCheckoutPaid({ checkoutId: checkoutA, providerPriceId: "fake_price_pro_month", interval: "month" });
  const r = await deliver("fake.checkout.completed", subA, "evt_a_paid");
  assert.equal(r.outcome, "applied");
  const owner = await entitlementsOf(U.owner);
  const employee = await entitlementsOf(U.emp);
  assert.equal(ent(owner, "voice").active, true);
  assert.equal(ent(owner, "voice").source, "subscription");
  assert.equal(ent(owner, "ai_documents").limit, 200);
  // Rovnaká odpoveď bez ohľadu na rolu/platformu (RPC nemá parameter platformy).
  assert.deepEqual(owner.entitlements, employee.entitlements);
  const status = (await rpcAs(U.owner, "esblu_get_my_checkout_status", [checkoutA])) as Row;
  assert.equal(interpretCheckoutReturn({ checkout: "returned" }, { checkoutStatus: String(status.status), subscription: await subscriptionOf(U.owner) }), "confirmed");
});
await check("employee vidí plán/stav, ale nie detaily ani správu; accountant detaily bez správy", async () => {
  const emp = await subscriptionOf(U.emp);
  assert.equal(emp.planCode, "test_pro");
  assert.equal(emp.status, "active");
  assert.equal(emp.canManage, false);
  assert.equal(emp.canViewDetails, false);
  assert.equal(emp.billingProvider, null);
  const acc = await subscriptionOf(U.acc);
  assert.equal(acc.canViewDetails, true);
  assert.equal(acc.canManage, false);
  assert.equal(acc.billingInterval, "month");
  const owner = await subscriptionOf(U.owner);
  assert.equal(owner.canManage, true);
});
await check("druhý checkout pri aktívnom predplatnom je odmietnutý", async () => {
  await fails(() => rpcAs(U.owner, "esblu_billing_create_checkout_intent", ["test_starter", "month"]), /ESBLU_BILLING_ALREADY_SUBSCRIBED/);
});

// ============================================================================= 4. Idempotencia / poradie / replay
await check("ten istý webhook 2× → duplicate, nároky sa nezdvoja", async () => {
  const before = await subscriptionRowsA();
  const again = await deliver("fake.checkout.completed", subA, "evt_a_paid");
  assert.equal(again.outcome, "duplicate");
  // aj presne ten istý raw body + podpis
  const replay = await processWebhook(fake, again.signed.rawBody, again.signed.headers, serviceDb);
  assert.equal(replay.outcome, "duplicate");
  assert.equal(await subscriptionRowsA(), before);
  assert.equal(before, 7);
});
await check("rovnaké event ID s iným telom → neprijaté (payload_mismatch)", async () => {
  const r = await deliver("fake.checkout.completed", { ...subA, status: "canceled" }, "evt_a_paid");
  assert.equal(r.outcome, "duplicate");
  assert.equal(r.code, "payload_mismatch");
  assert.equal((await subscriptionOf(U.owner)).status, "active");
});
await check("neplatný podpis / starý timestamp / live → 400, nič sa neuloží", async () => {
  const body = fake.buildEvent("fake.x", subA, "evt_bad_sig");
  const raw = JSON.stringify(body);
  const bad = await processWebhook(fake, raw, new Headers({ "x-esblu-fake-signature": signTimestamped(raw, "wrong_secret_xxxxxxxxxxxx", Math.floor(clock.getTime() / 1000)) }), serviceDb);
  assert.equal(bad.httpStatus, 400);
  const stale = await processWebhook(fake, raw, new Headers({ "x-esblu-fake-signature": signTimestamped(raw, SECRET, Math.floor(clock.getTime() / 1000) - 3600) }), serviceDb);
  assert.equal(stale.code, "STALE_SIGNATURE");
  const liveRaw = JSON.stringify({ ...body, id: "evt_live", livemode: true });
  const live = await processWebhook(fake, liveRaw, new Headers({ "x-esblu-fake-signature": signTimestamped(liveRaw, SECRET, Math.floor(clock.getTime() / 1000)) }), serviceDb);
  assert.equal(live.code, "LIVE_MODE_FORBIDDEN");
  const n = await one<{ n: number }>(`select count(*)::int n from public.billing_events where provider_event_id in ('evt_bad_sig','evt_live')`);
  assert.equal(n.n, 0);
});
await check("event v nesprávnom poradí (starší stav) nevráti stav späť", async () => {
  const older: NormalizedSubscriptionState = { ...subA, status: "past_due", checkout_ref: null, state_at: new Date(new Date(subA.state_at).getTime() - 60_000).toISOString() };
  const r = await deliver("fake.invoice.payment_failed", older, "evt_a_old");
  assert.equal(r.outcome, "stale");
  assert.equal((await subscriptionOf(U.owner)).status, "active");
});
await check("billing_events neobsahuje raw payload (iba sha256 + minimalizovaný súhrn)", async () => {
  const row = await one<Row>(`select payload_sha256, summary from public.billing_events where provider_event_id = 'evt_a_paid'`);
  assert.match(String(row.payload_sha256), /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(row.summary as Row).sort(), ["cancel_at_period_end", "period_end", "price", "status", "subscription"]);
});

// ============================================================================= 5. Cancel / resume / upgrade / downgrade
await check("cancel → cancel_at_period_end viditeľné všade, prístup do konca obdobia", async () => {
  tick(10);
  const state = await fake.cancelSubscription({ providerSubscriptionId: subA.provider_subscription_id!, providerCustomerId: null });
  const r = await applyProviderState(serviceDb, fake, "cancel", state, sha256Hex(JSON.stringify(state)));
  assert.equal(r.outcome, "applied");
  for (const uid of [U.owner, U.emp, U.acc]) assert.equal((await subscriptionOf(uid)).cancelAtPeriodEnd, true);
  assert.equal(ent(await entitlementsOf(U.emp), "voice").active, true);
});
await check("neskorší webhook toho istého stavu po sync akcii → stale/duplicate, nič sa nemení", async () => {
  const late = { ...(await store.get(subA.provider_subscription_id!))!, state_at: new Date(clock.getTime() - 5000).toISOString() };
  const r = await deliver("fake.subscription.updated", late, "evt_a_late_cancel");
  assert.equal(r.outcome, "stale");
});
await check("resume → cancel_at_period_end=false", async () => {
  tick(10);
  const state = await fake.resumeSubscription({ providerSubscriptionId: subA.provider_subscription_id!, providerCustomerId: null });
  await applyProviderState(serviceDb, fake, "resume", state, sha256Hex(JSON.stringify(state)));
  assert.equal((await subscriptionOf(U.owner)).cancelAtPeriodEnd, false);
});
await check("downgrade Pro → Starter: hlas odvolaný, limity zmenené, dáta ostávajú", async () => {
  await as(U.owner, () => db.query(`insert into public.vehicles (spz, user_id, company_id) select 'BA' || g || 'XX', '${U.owner}', '${C.A}' from generate_series(1, 6) g`));
  tick(10);
  const state = await fake.changePlan({ providerSubscriptionId: subA.provider_subscription_id!, providerCustomerId: null }, "fake_price_starter_month");
  await applyProviderState(serviceDb, fake, "change", state, sha256Hex(JSON.stringify(state)));
  const e = await entitlementsOf(U.owner);
  assert.equal((await subscriptionOf(U.owner)).planCode, "test_starter");
  assert.equal(ent(e, "voice").active, false);
  assert.equal(ent(e, "vehicles").limit, 5);
  assert.equal((await one<{ n: number }>(`select count(*)::int n from public.vehicles where company_id = '${C.A}'`)).n, 6);
  await fails(() => as(U.owner, () => db.query(`insert into public.vehicles (spz, user_id, company_id) values ('BA999ZZ', '${U.owner}', '${C.A}')`)), /VEHICLE_LIMIT_REACHED/);
  const revoked = await one<Row>(`select status from public.company_entitlements where company_id = '${C.A}' and source = 'subscription' and entitlement_key = 'voice'`);
  assert.equal(revoked.status, "revoked");
});
await check("upgrade Starter → Pro: hlas znova aktívny, bez duplicitných riadkov", async () => {
  tick(10);
  const state = await fake.changePlan({ providerSubscriptionId: subA.provider_subscription_id!, providerCustomerId: null }, "fake_price_pro_month");
  await applyProviderState(serviceDb, fake, "change", state, sha256Hex(JSON.stringify(state)));
  assert.equal(ent(await entitlementsOf(U.owner), "voice").active, true);
  assert.equal(await subscriptionRowsA(), 7);
});

// ============================================================================= 6. Payment failed / grace / recovery / unpaid
await check("payment failed → past_due, rovnaký stav pre všetkých, prístup do grace", async () => {
  tick(10);
  const failedState = { ...(await store.get(subA.provider_subscription_id!))!, status: "past_due" as const, checkout_ref: null, state_at: clock.toISOString() };
  await store.put(failedState);
  assert.equal((await deliver("fake.invoice.payment_failed", failedState)).outcome, "applied");
  const views = await Promise.all([U.owner, U.emp, U.acc].map(subscriptionOf));
  assert.ok(views.every((v) => v.status === "past_due"));
  const grace = (await subscriptionOf(U.owner)).graceUntil!;
  assert.ok(Math.abs(new Date(grace).getTime() - (clock.getTime() + 7 * 86400_000)) < 2000);
  assert.equal(ent(await entitlementsOf(U.emp), "voice").active, true);
});
await check("recovery (platba prešla) → active, grace zrušená", async () => {
  tick(10);
  const ok = { ...(await store.get(subA.provider_subscription_id!))!, status: "active" as const, state_at: clock.toISOString() };
  await store.put(ok);
  assert.equal((await deliver("fake.invoice.paid", ok)).outcome, "applied");
  const view = await subscriptionOf(U.owner);
  assert.equal(view.status, "active");
  assert.equal(view.graceUntil, null);
});
await check("unpaid → platené nároky odvolané, trial firmy A stále platí (dáta nedotknuté)", async () => {
  tick(10);
  const unpaid = { ...(await store.get(subA.provider_subscription_id!))!, status: "unpaid" as const, state_at: clock.toISOString() };
  await store.put(unpaid);
  await deliver("fake.subscription.updated", unpaid);
  const e = await entitlementsOf(U.owner);
  assert.equal(ent(e, "voice").active, false);
  assert.equal(ent(e, "vehicles").source, "trial");
  tick(10);
  const back = { ...unpaid, status: "active" as const, state_at: clock.toISOString() };
  await store.put(back);
  await deliver("fake.invoice.paid", back);
  assert.equal(ent(await entitlementsOf(U.owner), "voice").active, true);
});

// ============================================================================= 7. Trial expiration / annual / expiry bez webhooku / reactivation
let subX: NormalizedSubscriptionState;
await check("trial skončil → TRIAL_EXPIRED; ročný plán → aktívne s obdobím ~1 rok", async () => {
  assert.equal(ent(await entitlementsOf(U.ownerX), "vehicles").reason, "TRIAL_EXPIRED");
  const intent = (await rpcAs(U.ownerX, "esblu_billing_create_checkout_intent", ["test_starter", "year"])) as Row;
  subX = await fake.simulateCheckoutPaid({ checkoutId: String(intent.checkout_id), providerPriceId: String(intent.provider_price_id), interval: "year" });
  assert.equal((await deliver("fake.checkout.completed", subX)).outcome, "applied");
  const view = await subscriptionOf(U.ownerX);
  assert.equal(view.billingInterval, "year");
  const days = (new Date(view.currentPeriodEnd!).getTime() - clock.getTime()) / 86400_000;
  assert.ok(days > 360 && days < 370);
  assert.equal(ent(await entitlementsOf(U.ownerX), "vehicles").source, "subscription");
});
await check("koniec obdobia bez webhooku → nárok sám vyprší (fail closed)", async () => {
  tick(10);
  const ended = { ...subX, checkout_ref: null, current_period_start: new Date(clock.getTime() - 40 * 86400_000).toISOString(), current_period_end: new Date(clock.getTime() - 3 * 86400_000).toISOString(), state_at: clock.toISOString() };
  await deliver("fake.subscription.updated", ended);
  assert.equal(ent(await entitlementsOf(U.ownerX), "vehicles").reason, "TRIAL_EXPIRED");
});
await check("ukončené predplatné sa nedá oživiť neskorším eventom toho istého ID; nový checkout = reactivation", async () => {
  tick(10);
  const canceled = { ...subX, checkout_ref: null, status: "canceled" as const, ended_at: clock.toISOString(), state_at: clock.toISOString() };
  await deliver("fake.subscription.deleted", canceled);
  tick(10);
  const zombie = { ...canceled, status: "active" as const, ended_at: null, state_at: clock.toISOString() };
  const r = await deliver("fake.subscription.updated", zombie);
  assert.equal(r.outcome, "stale");
  assert.equal(r.code, "TERMINAL_STATE");
  const intent = (await rpcAs(U.ownerX, "esblu_billing_create_checkout_intent", ["test_pro", "month"])) as Row;
  const fresh = await fake.simulateCheckoutPaid({ checkoutId: String(intent.checkout_id), providerPriceId: String(intent.provider_price_id), interval: "month" });
  assert.equal((await deliver("fake.checkout.completed", fresh)).outcome, "applied");
  assert.equal((await subscriptionOf(U.ownerX)).planCode, "test_pro");
});

// ============================================================================= 8. Tenant izolácia / tampering
await check("Company A event nezmení Company B; identifikátor A použitý pre B → CROSS_TENANT", async () => {
  const intentB = (await rpcAs(U.ownerB, "esblu_billing_create_checkout_intent", ["test_starter", "month"])) as Row;
  const hijack = { ...subA, checkout_ref: String(intentB.checkout_id), provider_price_id: "fake_price_starter_month", state_at: clock.toISOString() };
  const r = await deliver("fake.checkout.completed", hijack);
  assert.equal(r.code, "CROSS_TENANT_IDENTIFIER");
  assert.equal((await subscriptionOf(U.ownerB)).status, "none");
  assert.equal((await subscriptionOf(U.owner)).planCode, "test_pro");
});
await check("event bez našej väzby (podvrhnutý company v metadata nič neznamená) → UNKNOWN_COMPANY", async () => {
  const orphan = { ...subA, provider_subscription_id: "fake_sub_orphan", provider_customer_id: "fake_cus_orphan", checkout_ref: "00000000-0000-4000-8000-000000000000", state_at: clock.toISOString() };
  assert.equal((await deliver("fake.checkout.completed", orphan)).code, "UNKNOWN_COMPANY");
});
await check("neznámy price ID → UNKNOWN_PRICE; iný price než schválil server → PRICE_MISMATCH + checkout rejected", async () => {
  const intentB = (await rpcAs(U.ownerB, "esblu_billing_create_checkout_intent", ["test_starter", "month"])) as Row;
  const subB = await fake.simulateCheckoutPaid({ checkoutId: String(intentB.checkout_id), providerPriceId: "price_attacker", interval: "month" });
  assert.equal((await deliver("fake.checkout.completed", subB)).code, "UNKNOWN_PRICE");
  const mismatch = { ...subB, provider_subscription_id: "fake_sub_b2", provider_customer_id: "fake_cus_b2", provider_price_id: "fake_price_pro_month" };
  assert.equal((await deliver("fake.checkout.completed", mismatch)).code, "PRICE_MISMATCH");
  assert.equal(((await rpcAs(U.ownerB, "esblu_get_my_checkout_status", [intentB.checkout_id])) as Row).status, "rejected");
  assert.equal((await subscriptionOf(U.ownerB)).status, "none");
  assert.equal(ent(await entitlementsOf(U.ownerB), "voice").active, false);
});

// ============================================================================= 9. iOS / Android (normalizéry + rovnaká DB cesta)
async function deliverStore(provider: "apple" | "google", eventId: string, state: NormalizedSubscriptionState) {
  const recorded = (await serviceDb.rpc("esblu_billing_record_event", {
    p_provider: provider, p_environment: "test", p_provider_event_id: eventId, p_event_type: `${provider}.notification`,
    p_provider_created_at: state.state_at, p_payload_sha256: sha256Hex(eventId),
  })).data as Row;
  if (recorded.duplicate) return "duplicate";
  return ((await serviceDb.rpc("esblu_billing_apply_event", { p_event_id: recorded.event_id, p_state: state })).data as Row).result as string;
}
let appleToken = "";
await check("iOS kúpa (App Store, appAccountToken) → web aj Android vidia rovnaké nároky", async () => {
  appleToken = String(await rpcAs(U.ownerI, "esblu_billing_issue_account_token", ["apple"]));
  assert.equal(String(await rpcAs(U.ownerI, "esblu_billing_issue_account_token", ["apple"])), appleToken);
  const n = normalizeAppleNotification({
    notificationType: "SUBSCRIBED", subtype: "INITIAL_BUY", notificationUUID: "apple-uuid-1", signedDate: clock.getTime(),
    transaction: { originalTransactionId: "2000000111", productId: "com.esblu.test.pro.monthly", purchaseDate: clock.getTime(), expiresDate: clock.getTime() + 30 * 86400_000, appAccountToken: appleToken },
    renewal: { autoRenewStatus: 1 },
  });
  assert.equal(n.kind, "state");
  if (n.kind !== "state") return;
  assert.equal(await deliverStore("apple", "apple-uuid-1", n.state), "applied");
  const owner = await subscriptionOf(U.ownerI);
  assert.equal(owner.billingProvider, "apple");
  assert.equal(owner.planCode, "test_pro");
  assert.deepEqual((await entitlementsOf(U.ownerI)).entitlements, (await entitlementsOf(U.empI)).entitlements);
  assert.equal(ent(await entitlementsOf(U.empI), "voice").active, true);
});
await check("iOS: zrušenie obnovy v App Store → cancel_at_period_end všade", async () => {
  tick(10);
  const n = normalizeAppleNotification({
    notificationType: "DID_CHANGE_RENEWAL_STATUS", subtype: "AUTO_RENEW_DISABLED", notificationUUID: "apple-uuid-2", signedDate: clock.getTime(),
    transaction: { originalTransactionId: "2000000111", productId: "com.esblu.test.pro.monthly", purchaseDate: clock.getTime(), expiresDate: clock.getTime() + 29 * 86400_000, appAccountToken: appleToken },
    renewal: { autoRenewStatus: 0 },
  });
  if (n.kind !== "state") throw new Error("expected state");
  assert.equal(await deliverStore("apple", "apple-uuid-2", n.state), "applied");
  assert.equal((await subscriptionOf(U.empI)).cancelAtPeriodEnd, true);
  assert.equal(await deliverStore("apple", "apple-uuid-2", n.state), "duplicate");
});
await check("iOS firma: webový checkout je zablokovaný (aktívne cez iný kanál)", async () => {
  await db.exec(`update public.billing_runtime_config set web_provider = 'fake'`);
  await fails(() => rpcAs(U.ownerI, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /ESBLU_BILLING_ACTIVE_ON_OTHER_PROVIDER/);
});
await check("druhé aktívne predplatné (Apple pre firmu A s aktívnym webom) → conflict, žiadna zmena", async () => {
  const tokenA = String(await rpcAs(U.owner, "esblu_billing_issue_account_token", ["apple"]));
  const n = normalizeAppleNotification({
    notificationType: "SUBSCRIBED", notificationUUID: "apple-uuid-3", signedDate: clock.getTime(),
    transaction: { originalTransactionId: "2000000999", productId: "com.esblu.test.pro.yearly", purchaseDate: clock.getTime(), expiresDate: clock.getTime() + 365 * 86400_000, appAccountToken: tokenA },
  });
  if (n.kind !== "state") throw new Error("expected state");
  assert.equal(await deliverStore("apple", "apple-uuid-3", n.state), "conflict");
  assert.equal((await subscriptionOf(U.owner)).billingProvider, "fake");
});
await check("Android kúpa + upgrade s linkedPurchaseToken → applied (nie conflict), web vidí stav", async () => {
  const token = String(await rpcAs(U.ownerG, "esblu_billing_issue_account_token", ["google"]));
  const n1 = normalizeGoogleSubscription({
    purchaseToken: "gp_token_1", eventTimeMillis: clock.getTime(),
    resource: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", startTime: clock.toISOString(), externalAccountIdentifiers: { obfuscatedExternalAccountId: token },
      lineItems: [{ productId: "esblu_test_pro", expiryTime: new Date(clock.getTime() + 30 * 86400_000).toISOString(), offerDetails: { basePlanId: "monthly" } }] },
  });
  if (n1.kind !== "state") throw new Error("expected state");
  assert.equal(await deliverStore("google", "gmsg-1", n1.state), "applied");
  tick(10);
  const n2 = normalizeGoogleSubscription({
    purchaseToken: "gp_token_2", eventTimeMillis: clock.getTime(),
    resource: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", startTime: clock.toISOString(), linkedPurchaseToken: "gp_token_1", externalAccountIdentifiers: { obfuscatedExternalAccountId: token },
      lineItems: [{ productId: "esblu_test_pro", expiryTime: new Date(clock.getTime() + 365 * 86400_000).toISOString(), offerDetails: { basePlanId: "yearly" } }] },
  });
  if (n2.kind !== "state") throw new Error("expected state");
  assert.equal(await deliverStore("google", "gmsg-2", n2.state), "applied");
  const view = await subscriptionOf(U.ownerG);
  assert.equal(view.billingProvider, "google");
  assert.equal(view.billingInterval, "year");
  tick(10);
  const n3 = normalizeGoogleSubscription({
    purchaseToken: "gp_token_2", eventTimeMillis: clock.getTime(),
    resource: { subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", startTime: clock.toISOString(), externalAccountIdentifiers: { obfuscatedExternalAccountId: token },
      lineItems: [{ productId: "esblu_test_pro", expiryTime: new Date(clock.getTime() + 365 * 86400_000).toISOString(), offerDetails: { basePlanId: "yearly" } }] },
  });
  if (n3.kind !== "state") throw new Error("expected state");
  assert.equal(await deliverStore("google", "gmsg-3", n3.state), "applied");
  assert.equal((await subscriptionOf(U.ownerG)).status, "past_due");
});

// ============================================================================= 10. Rollback
await check("rollback: RPC zmiznú, tabuľky (default) ostanú, nároky sa nemažú; opätovné nasadenie OK", async () => {
  const before = await subscriptionRowsA();
  await db.exec(read(ROLLBACK));
  const fn = await one<{ n: number }>(`select count(*)::int n from pg_proc where proname like 'esblu_billing_%' or proname in ('esblu_get_my_subscription','esblu_get_my_checkout_status')`);
  assert.equal(fn.n, 0);
  assert.ok(await one(`select to_regclass('public.subscription_accounts') t`).then((r) => (r as Row).t));
  assert.equal(await subscriptionRowsA(), before);
  await db.exec(read(MIGRATION));
  assert.equal((await subscriptionOf(U.owner)).planCode, "test_pro");
  await db.exec(`set esblu.rollback_drop_billing_tables = 'yes'`);
  await db.exec(read(ROLLBACK));
  await db.exec(`reset esblu.rollback_drop_billing_tables`);
  assert.equal(((await one(`select to_regclass('public.subscription_accounts') t`)) as Row).t, null);
  await db.exec(read(MIGRATION));
});

console.log(`\nsubscriptions-pglite: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
