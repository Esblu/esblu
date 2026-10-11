// =============================================================================
// Subscriptions lifecycle — SKUTOČNÝ PostgreSQL (PGlite) pre
//   20261008120000_subscriptions_platform.sql + 20261011120000_subscriptions_lifecycle_hardening.sql
// nad prod-vernou entitlement vrstvou a SKUTOČNOU TS pipeline. Nikdy Supabase / Stripe / Google / Apple.
// Suity (prefix): subscription-migrations, entitlement-resolution, subscription-trial,
// subscription-refund-revoke, webhook-idempotency, purchase-idempotency, cross-provider,
// subscription-cross-device, subscription-rbac, subscription-rls, reconciliation,
// subscription-concurrency, stripe-adapter, failure-matrix.
//   npm i --no-save @electric-sql/pglite@0.5.8 && npm run test:subscriptions-lifecycle-db
//   SUITE=reconciliation npm run test:subscriptions-lifecycle-db
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANONICAL_STATUSES, ENTITLING_STATUSES, OPEN_STATUSES, TERMINAL_STATUSES } from "@/lib/billing/canonical-state";
import { applyVerifiedStorePurchase, processWebhook, type BillingDb } from "@/lib/billing/pipeline";
import { FakeBillingProvider, MemoryFakeStateStore } from "@/lib/billing/providers/fake";
import { StripeTestProvider } from "@/lib/billing/providers/stripe";
import { providerReconcileSource } from "@/lib/billing/reconcile-sources";
import { runReconciliation, type ReconcileSource } from "@/lib/billing/reconciliation";
import { signTimestamped } from "@/lib/billing/signature";
import { FakeGooglePlayApi, fakeGooglePurchase } from "@/lib/billing/stores/fake-stores";
import { verifyGoogleClientPurchase } from "@/lib/billing/stores/store-purchase";
import { parseSubscriptionView } from "@/lib/billing/client-model";
import type { NormalizedSubscriptionState } from "@/lib/billing/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const BASE = "supabase/migrations/20261008120000_subscriptions_platform.sql";
const LIFECYCLE = "supabase/migrations/20261011120000_subscriptions_lifecycle_hardening.sql";
const LIFECYCLE_ROLLBACK = "supabase/rollback/20261011120000_subscriptions_lifecycle_hardening_rollback.sql";
const SUITE = (process.argv[2] ?? process.env.SUITE ?? "").replace(/^--suite=/, "").trim() || null;

type Row = Record<string, unknown>;
type Db = { exec: (sql: string) => Promise<unknown>; query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

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
  if (SUITE && label.split(":")[0] !== SUITE) return;
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 3).join("\n       ") : String(error)}`);
  }
}

// PGlite = jedno spojenie. Transakcie serializujeme mutexom (inak by sa súbežné
// begin/commit prekrývali). Súbežnosť sa tak testuje na úrovni aplikácie
// (Promise.all nad pipeline); DB ochranu (unique index + advisory lock) overujeme
// štrukturálne v subscription-concurrency.
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}
async function inTx<T>(claims: Row, role: string, fn: () => Promise<T>): Promise<T> {
  return serialized(async () => {
    await db.exec("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await db.exec(`set local role ${role}`);
      const r = await fn();
      await db.exec("commit");
      return r;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  });
}
const as = <T>(uid: string, fn: () => Promise<T>) => inTx({ sub: uid, role: "authenticated" }, "authenticated", fn);
const asRole = <T>(role: "anon" | "service_role", fn: () => Promise<T>) => inTx({ role }, role, fn);
const su = <T = Row>(sql: string, params: unknown[] = []) => serialized(() => db.query<T>(sql, params));
const one = async <T = Row>(sql: string, params: unknown[] = []) => (await su<T>(sql, params)).rows[0];
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
const rpcAs = async (uid: string, fn: string, args: unknown[] = []) =>
  as(uid, async () => (await db.query<{ r: unknown }>(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) r`, args)).rows[0].r);
let dbFault: string | null = null;
const serviceDb: BillingDb = {
  rpc: async (fn, args = {}) => {
    if (dbFault && fn === dbFault) return { data: null, error: { message: "simulated connection reset" } };
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

// ----------------------------------------------------------------------------- schéma
await db.exec(read("scripts/sql/entitlements-local-baseline.sql"));
await db.exec(`
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`);
await db.exec(read("supabase/migrations/20260928100000_company_entitlements_trial.sql"));
await db.exec(read(BASE));
await db.exec(read(LIFECYCLE));
await db.exec(`update public.billing_runtime_config set web_provider = 'fake',
  enabled_methods = array['stripe_web_checkout','apple_iap','google_play']`);

// ----------------------------------------------------------------------------- fixtures
let seq = 0;
type Co = { id: string; owner: string; emp: string; acc: string; billingAdmin: string };
async function newCompany(opts: { trialEnded?: boolean } = {}): Promise<Co> {
  seq++;
  const h = seq.toString(16).padStart(4, "0");
  const co: Co = {
    id: `aa${h}00-0000-4000-8000-000000000000`,
    owner: `bb${h}00-0000-4000-8000-000000000001`,
    emp: `bb${h}00-0000-4000-8000-000000000002`,
    acc: `bb${h}00-0000-4000-8000-000000000003`,
    billingAdmin: `bb${h}00-0000-4000-8000-000000000004`,
  };
  await serialized(() => db.exec(`
    insert into auth.users (id, email) values ('${co.owner}', 'o${h}@example.invalid'), ('${co.emp}', 'e${h}@example.invalid'),
      ('${co.acc}', 'a${h}@example.invalid'), ('${co.billingAdmin}', 'b${h}@example.invalid');
    insert into public.companies (id, owner_id, name) values ('${co.id}', '${co.owner}', 'L${h}');
    insert into public.company_members (company_id, user_id, role, status, permissions) values
      ('${co.id}', '${co.owner}', 'owner', 'active', '{}'), ('${co.id}', '${co.emp}', 'employee', 'active', '{}'),
      ('${co.id}', '${co.acc}', 'accountant', 'active', '{}'), ('${co.id}', '${co.billingAdmin}', 'admin', 'active', '{"billing":{"manage":true}}');
    insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method)
      select '${co.id}', d.version, '${co.owner}', 'company_dpa_gate'
      from (select version from public.legal_documents where type = 'dpa' order by effective_at desc limit 1) d;
    ${opts.trialEnded ? `alter table public.companies disable trigger esblu_companies_trial_guard;
      update public.companies set trial_started_at = now() - interval '30 days', trial_ends_at = now() - interval '16 days' where id = '${co.id}';
      alter table public.companies enable trigger esblu_companies_trial_guard;` : ""}
  `));
  return co;
}

const SECRET = "fake_test_secret_0123456789abcdef";
let clock = new Date();
const tick = (s = 1) => (clock = new Date(clock.getTime() + s * 1000));
const fakeStore = new MemoryFakeStateStore();
const fake = new FakeBillingProvider(SECRET, fakeStore, () => clock);
async function deliver(type: string, state: NormalizedSubscriptionState, eventId?: string) {
  const signed = fake.signEvent(fake.buildEvent(type, state, eventId));
  return processWebhook(fake, signed.rawBody, signed.headers, serviceDb);
}
async function buyFake(co: Co, plan = "test_pro"): Promise<NormalizedSubscriptionState> {
  const checkout = String(((await rpcAs(co.owner, "esblu_billing_create_checkout_intent", [plan, "month"])) as Row).checkout_id);
  const s = await fake.simulateCheckoutPaid({ checkoutId: checkout, providerPriceId: plan === "test_pro" ? "fake_price_pro_month" : "fake_price_starter_month", interval: "month" });
  const r = await deliver("fake.checkout.completed", s);
  assert.equal(r.outcome, "applied", JSON.stringify(r));
  return s;
}
const next = (s: NormalizedSubscriptionState, patch: Partial<NormalizedSubscriptionState>): NormalizedSubscriptionState => {
  tick(5);
  return { ...s, checkout_ref: null, charge: null, ...patch, state_at: clock.toISOString() };
};
type Ent = { key: string; active: boolean; source?: string; limit?: number | null; reason?: string };
const entitlementsOf = async (uid: string) => ((await rpcAs(uid, "esblu_get_my_company_entitlements")) as { entitlements: Ent[] }).entitlements;
const ent = async (uid: string, key: string) => (await entitlementsOf(uid)).find((e) => e.key === key)!;
const explain = async (uid: string) => (await rpcAs(uid, "esblu_billing_explain_my_entitlements")) as { subscription_status: string; entitlements: Row[] };
const subOf = async (uid: string) => parseSubscriptionView(await rpcAs(uid, "esblu_get_my_subscription"))!;
const accountOf = (co: Co) => one<Row>(`select * from public.subscription_accounts where company_id = '${co.id}'`);
const eventsOf = async (co: Co) => Number((await one<{ n: number }>(`select count(*)::int n from public.billing_events where company_id = '${co.id}'`)).n);
const options = (uid: string, platform: string) => rpcAs(uid, "esblu_billing_purchase_options", [platform, "SK"]) as Promise<Row>;

// ============================================================================= subscription-migrations
await check("subscription-migrations: obe migrácie sú idempotentné (re-run bez chyby, bez straty dát)", async () => {
  const co = await newCompany();
  await buyFake(co);
  await serialized(() => db.exec(read(BASE)));
  await serialized(() => db.exec(read(LIFECYCLE)));
  assert.equal((await accountOf(co)).status, "active");
  assert.equal((await ent(co.owner, "voice")).active, true);
});
await check("subscription-migrations: DB kanonické stavy = TS (canonical_statuses + helpery)", async () => {
  const sql = (await one<{ r: string[] }>(`select public.esblu_billing_canonical_statuses() r`)).r;
  assert.deepEqual(sql, [...CANONICAL_STATUSES]);
  for (const s of CANONICAL_STATUSES) {
    const r = await one<Row>(`select public.esblu_billing_status_is_open($1) o, public.esblu_billing_status_is_entitling($1) e, public.esblu_billing_status_is_terminal($1) t`, [s]);
    assert.equal(r.o, OPEN_STATUSES.has(s), `open ${s}`);
    assert.equal(r.e, ENTITLING_STATUSES.has(s), `entitling ${s}`);
    assert.equal(r.t, TERMINAL_STATUSES.has(s), `terminal ${s}`);
  }
  await fails(() => su(`update public.subscription_accounts set status = 'bogus'`), /check/);
});
await check("subscription-migrations: forward-only — žiadny DROP TABLE / DELETE / TRUNCATE účtovných dát v migrácii", async () => {
  const sql = read(LIFECYCLE).toLowerCase();
  assert.ok(!/drop\s+table/.test(sql));
  assert.ok(!/\btruncate\b/.test(sql));
  assert.ok(!/delete\s+from\s+public\.(billing_events|subscription_accounts|billing_store_reports|company_entitlements)/.test(sql));
  assert.ok(!/environment\s*=\s*'live'/.test(sql.replace(/--.*$/gm, "")), "live sa nikde nezapína");
});

// ============================================================================= entitlement-resolution
const dash = await newCompany();
const sDash = await buyFake(dash);
await check("entitlement-resolution: dashboard kontrakt — esblu_get_my_company_entitlements po kúpe (tvar nezmenený)", async () => {
  const list = await entitlementsOf(dash.owner);
  const voice = list.find((e) => e.key === "voice")!;
  assert.equal(voice.active, true);
  assert.equal(voice.source, "subscription");
  for (const e of list) {
    assert.equal(typeof e.key, "string");
    assert.equal(typeof e.active, "boolean");
  }
  assert.equal((list.find((e) => e.key === "ai_documents")!).limit, 200, "quantity entitlement");
});
await check("entitlement-resolution: explain — zdroj, dôvod, platnosť, managed_via; referencia iba pre view rolu", async () => {
  const owner = await explain(dash.owner);
  assert.equal(owner.subscription_status, "active");
  const v = owner.entitlements.find((e) => e.key === "voice")!;
  assert.equal(v.explanation, "subscription_active");
  assert.equal(v.managed_via, "web");
  assert.equal(v.provider, "fake");
  assert.ok(String(v.reference).startsWith("subscription_account:"));
  assert.ok(v.valid_until);
  const emp = (await explain(dash.emp)).entitlements.find((e) => e.key === "voice")!;
  assert.equal(emp.active, true);
  assert.equal(emp.reference, undefined, "employee nevidí referenciu");
  assert.equal(emp.provider, undefined, "employee nevidí providera");
  // explain a dashboard sa nikdy nerozchádzajú
  const a = (await entitlementsOf(dash.emp)).map((e) => [e.key, e.active]);
  const b = (await explain(dash.emp)).entitlements.map((e) => [e.key, e.active]);
  assert.deepEqual(a, b);
});
await check("entitlement-resolution: manuálny / beta grant prežije zrušenie predplatného; revoke grantu = okamžite", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  await su(`insert into public.company_entitlements (company_id, entitlement_key, source, status, note) values ('${co.id}', 'voice', 'manual', 'active', 'support')`);
  await su(`insert into public.company_entitlements (company_id, entitlement_key, source, status, valid_until) values ('${co.id}', 'vehicles', 'beta_compat', 'active', now() + interval '10 days')`);
  assert.equal((await deliver("fake.subscription.deleted", next(s, { status: "canceled", ended_at: clock.toISOString() }))).outcome, "applied");
  assert.equal((await ent(co.owner, "voice")).source, "manual");
  assert.equal((await explain(co.owner)).entitlements.find((e) => e.key === "voice")!.explanation, "manual_grant");
  assert.equal((await explain(co.owner)).entitlements.find((e) => e.key === "vehicles")!.explanation, "beta_grant");
  assert.equal((await ent(co.owner, "ai_documents")).active, false, "plánový nárok bez grantu zamknutý");
  await su(`update public.company_entitlements set status = 'revoked' where company_id = '${co.id}' and source = 'manual'`);
  assert.equal((await ent(co.owner, "voice")).active, false);
  await su(`update public.company_entitlements set valid_from = now() - interval '2 days', valid_until = now() - interval '1 minute' where company_id = '${co.id}' and source = 'beta_compat'`);
  assert.equal((await ent(co.owner, "vehicles")).active, false, "valid_until v minulosti = neplatné");
});
await check("entitlement-resolution: downgrade Pro → Starter odvolá nároky mimo plánu (dáta ostanú)", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  assert.equal((await ent(co.owner, "voice")).active, true);
  const r = await deliver("fake.subscription.updated", next(s, { provider_price_id: "fake_price_starter_month" }));
  assert.equal(r.outcome, "applied");
  assert.equal((await accountOf(co)).plan_code, "test_starter");
  assert.equal((await ent(co.owner, "voice")).active, false);
  const rows = Number((await one<{ n: number }>(`select count(*)::int n from public.company_entitlements where company_id = '${co.id}' and source = 'subscription' and entitlement_key = 'voice'`)).n);
  assert.equal(rows, 1, "riadok ostáva (status revoked), nemaže sa");
});

// ============================================================================= subscription-trial
await check("subscription-trial: nová firma = 14-dňový trial (server čas), hlas nie je v triale", async () => {
  const co = await newCompany();
  const r = await one<Row>(`select (trial_ends_at - trial_started_at) d from public.companies where id = '${co.id}'`);
  assert.match(String(r.d), /14 days/);
  assert.equal((await ent(co.owner, "vehicles")).source, "trial");
  assert.equal((await ent(co.owner, "voice")).active, false);
  assert.equal((await explain(co.owner)).entitlements.find((e) => e.key === "vehicles")!.explanation, "trial_window");
});
await check("subscription-trial: klient nemôže predĺžiť trial (trigger guard)", async () => {
  const co = await newCompany();
  await fails(() => as(co.owner, () => db.query(`update public.companies set trial_ends_at = now() + interval '1 year' where id = '${co.id}'`)));
  await fails(() => su(`update public.companies set trial_ends_at = now() + interval '1 year' where id = '${co.id}'`));
});
await check("subscription-trial: trial → paid (subscription má prednosť) → zrušené počas trialu → späť na trial", async () => {
  const co = await newCompany();
  const s = await buyFake(co);
  assert.equal((await ent(co.owner, "vehicles")).source, "subscription");
  await deliver("fake.subscription.deleted", next(s, { status: "canceled", ended_at: clock.toISOString() }));
  assert.equal((await ent(co.owner, "vehicles")).source, "trial", "trial okno stále beží");
  assert.equal((await ent(co.owner, "voice")).active, false);
});
await check("subscription-trial: skončený trial + predplatné → paid; po expirácii zamknuté (žiadny nový trial)", async () => {
  const co = await newCompany({ trialEnded: true });
  assert.equal((await ent(co.owner, "vehicles")).active, false);
  const s = await buyFake(co);
  assert.equal((await ent(co.owner, "vehicles")).active, true);
  await deliver("fake.subscription.deleted", next(s, { status: "expired", ended_at: clock.toISOString() }));
  assert.equal((await ent(co.owner, "vehicles")).active, false);
});
await check("subscription-trial: opakované čítanie počas behu je deterministické (žiadny race na zápis)", async () => {
  const co = await newCompany();
  const results = await Promise.all(Array.from({ length: 10 }, () => entitlementsOf(co.owner)));
  for (const r of results) assert.deepEqual(r, results[0]);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.company_entitlements where company_id = '${co.id}'`)).n), 0, "trial = výpočet, nie zápis");
});

// ============================================================================= subscription-refund-revoke
await check("subscription-refund-revoke: grace_period s budúcim grace_until = prístup; po grace bez prístupu", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  const future = new Date(Date.now() + 3 * 86400_000).toISOString();
  assert.equal((await deliver("fake.subscription.updated", next(s, { status: "grace_period", grace_until: future }))).outcome, "applied");
  assert.equal((await ent(co.owner, "voice")).active, true);
  assert.equal((await explain(co.owner)).entitlements.find((e) => e.key === "voice")!.explanation, "subscription_grace_period");
  const past = new Date(Date.now() - 60_000).toISOString();
  await deliver("fake.subscription.updated", next(s, { status: "grace_period", grace_until: past }));
  assert.equal((await ent(co.owner, "voice")).active, false);
});
await check("subscription-refund-revoke: past_due (Stripe) = 7 dní grace od servera; account_hold = bez prístupu, stále otvorené", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  await deliver("fake.invoice.payment_failed", next(s, { status: "past_due" }));
  const acc = await accountOf(co);
  const days = (new Date(String(acc.grace_until)).getTime() - new Date(clock).getTime()) / 86400_000;
  assert.ok(days > 6.9 && days < 7.1, `grace ${days}`);
  assert.equal((await ent(co.owner, "voice")).active, true);
  await deliver("fake.subscription.updated", next(s, { status: "account_hold" }));
  assert.equal((await ent(co.owner, "voice")).active, false);
  const opts = await options(co.owner, "web");
  assert.equal(opts.purchase_allowed, false, "account_hold = žiadny druhý nákup");
  assert.equal(opts.blocked_reason, "ALREADY_SUBSCRIBED");
  // Obnova po úhrade → active znova
  await deliver("fake.invoice.paid", next(s, { status: "active" }));
  assert.equal((await ent(co.owner, "voice")).active, true);
  assert.equal((await accountOf(co)).grace_until, null);
});
await check("subscription-refund-revoke: refunded → okamžite zamknuté, účtovné dáta ostávajú, neskorší 'active' je stale", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  const before = await eventsOf(co);
  assert.equal((await deliver("fake.charge.refund_full", next(s, { status: "refunded", ended_at: clock.toISOString() }))).outcome, "applied");
  assert.equal((await ent(co.owner, "voice")).active, false);
  const acc = await accountOf(co);
  assert.equal(acc.status, "refunded");
  assert.equal(acc.plan_code, "test_pro", "plán/história ostáva");
  assert.ok(acc.ended_at);
  assert.equal(await eventsOf(co), before + 1, "žiadny event sa nezmazal");
  const late = await deliver("fake.subscription.updated", next(s, { status: "active" }));
  assert.equal(late.outcome, "stale");
  assert.equal((await ent(co.owner, "voice")).active, false);
  // po refunde sa smie kúpiť nové predplatné
  assert.equal((await options(co.owner, "web")).purchase_allowed, true);
});
await check("subscription-refund-revoke: revoked (store revoke / dispute lost) → zamknuté; explain = not_entitled", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  await deliver("fake.subscription.updated", next(s, { status: "revoked", ended_at: clock.toISOString() }));
  assert.equal((await ent(co.owner, "voice")).active, false);
  assert.equal((await explain(co.owner)).subscription_status, "revoked");
  assert.equal((await explain(co.owner)).entitlements.find((e) => e.key === "voice")!.explanation, "not_entitled");
  assert.equal((await subOf(co.owner)).status, "revoked");
});
await check("subscription-refund-revoke: dispute flag — nastavený / zmazaný, iba pre view roly, nárok bez zmeny", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  await deliver("fake.subscription.updated", next(s, { review_flag: "dispute_open" }));
  assert.equal((await accountOf(co)).review_flag, "dispute_open");
  assert.equal((await ent(co.owner, "voice")).active, true);
  assert.equal((await rpcAs(co.owner, "esblu_get_my_subscription") as Row).review_flag, "dispute_open");
  assert.equal((await rpcAs(co.emp, "esblu_get_my_subscription") as Row).review_flag, undefined);
  await deliver("fake.subscription.updated", next(s, { review_flag: null }));
  assert.equal((await accountOf(co)).review_flag, null);
  await fails(() => su(`update public.subscription_accounts set review_flag = 'whatever' where company_id = '${co.id}'`), /check/);
});

// ============================================================================= webhook-idempotency
await check("webhook-idempotency: rovnaký webhook 10× → 1× applied, 9× duplicate, jeden event v DB", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  const before = await eventsOf(co);
  const signed = fake.signEvent(fake.buildEvent("fake.subscription.updated", next(s, { cancel_at_period_end: true }), "evt_same_10x"));
  const outcomes: string[] = [];
  for (let i = 0; i < 10; i++) outcomes.push((await processWebhook(fake, signed.rawBody, signed.headers, serviceDb)).outcome);
  assert.equal(outcomes.filter((o) => o === "applied").length, 1);
  assert.equal(outcomes.filter((o) => o === "duplicate").length, 9);
  assert.equal(await eventsOf(co), before + 1);
});
await check("webhook-idempotency: 10 súbežných doručení toho istého eventu → presne jedno applied", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  const signed = fake.signEvent(fake.buildEvent("fake.subscription.updated", next(s, { cancel_at_period_end: true }), "evt_conc_10x"));
  const res = await Promise.all(Array.from({ length: 10 }, () => processWebhook(fake, signed.rawBody, signed.headers, serviceDb)));
  assert.equal(res.filter((r) => r.outcome === "applied").length, 1);
  assert.ok(res.every((r) => r.outcome === "applied" || r.outcome === "duplicate"));
  assert.equal((await accountOf(co)).cancel_at_period_end, true);
});
await check("webhook-idempotency: rovnaké event ID s iným obsahom → odmietnuté (payload mismatch)", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  await deliver("fake.subscription.updated", next(s, { cancel_at_period_end: true }), "evt_mismatch");
  const r = await deliver("fake.subscription.updated", next(s, { cancel_at_period_end: false }), "evt_mismatch");
  assert.notEqual(r.outcome, "applied");
  assert.equal((await accountOf(co)).cancel_at_period_end, true);
});
await check("webhook-idempotency: out-of-order — starší event po novšom je stale (stav sa nevráti)", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  const older = next(s, { cancel_at_period_end: false });
  const newer = next(s, { cancel_at_period_end: true });
  assert.equal((await deliver("fake.subscription.updated", newer)).outcome, "applied");
  assert.equal((await deliver("fake.subscription.updated", older)).outcome, "stale");
  assert.equal((await accountOf(co)).cancel_at_period_end, true);
});
await check("webhook-idempotency: neplatný podpis → rejected, nič sa nezapíše", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  const before = await eventsOf(co);
  const signed = fake.signEvent(fake.buildEvent("fake.subscription.updated", next(s, { status: "revoked" })));
  const tampered = signed.rawBody.replace('"revoked"', '"active"');
  const r = await processWebhook(fake, tampered, signed.headers, serviceDb);
  assert.equal(r.outcome, "rejected");
  assert.equal(await eventsOf(co), before);
});

// ============================================================================= purchase-idempotency
const STORE_SECRET = "fake_store_secret_0123456789abcd";
const googleApi = new FakeGooglePlayApi(STORE_SECRET);
const storeProv = (id: "apple" | "google") => ({ id, environment: "test" as const });
const intent = (uid: string, plan: string, interval: string, platform: string, method: string, mode = "new") =>
  rpcAs(uid, "esblu_billing_create_purchase_intent", [plan, interval, platform, method, "US", mode, null]) as Promise<Row>;
async function buyGoogle(co: Co) {
  const i = await intent(co.owner, "test_pro", "month", "android", "google_play");
  const [productId, basePlanId] = String(i.provider_price_id).split(":");
  const token = fakeGooglePurchase(STORE_SECRET, { productId, basePlanId, obfuscatedAccountId: String(i.account_token), now: clock }).purchaseToken;
  return { i, token };
}
await check("purchase-idempotency: ten istý Google purchase token 10× (aj súbežne) → jeden nárok, žiadne duplicity", async () => {
  const co = await newCompany({ trialEnded: true });
  const { i, token } = await buyGoogle(co);
  const v = await verifyGoogleClientPurchase(googleApi, token, { environment: "test" });
  const state = { ...v.state, checkout_ref: String(i.checkout_id) };
  const seqRes = [];
  for (let k = 0; k < 5; k++) seqRes.push((await applyVerifiedStorePurchase(serviceDb, storeProv("google"), v.eventId, state, v.payloadSha256)).outcome);
  const conc = await Promise.all(Array.from({ length: 5 }, () => applyVerifiedStorePurchase(serviceDb, storeProv("google"), v.eventId, state, v.payloadSha256)));
  const all = [...seqRes, ...conc.map((r) => r.outcome)];
  assert.equal(all.filter((o) => o === "applied").length, 1, all.join(","));
  assert.ok(all.every((o) => o === "applied" || o === "duplicate"), all.join(","));
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.subscription_accounts where company_id = '${co.id}'`)).n), 1);
  assert.equal((await ent(co.owner, "voice")).active, true);
});
await check("purchase-idempotency: Google PENDING (odložená platba) → bez nároku, bez acknowledge; po zaplatení nárok + acknowledge", async () => {
  const co = await newCompany({ trialEnded: true });
  const i = await intent(co.owner, "test_pro", "month", "android", "google_play");
  const [productId, basePlanId] = String(i.provider_price_id).split(":");
  const token = fakeGooglePurchase(STORE_SECRET, { productId, basePlanId, obfuscatedAccountId: String(i.account_token), now: clock }).purchaseToken;
  const real = googleApi.getSubscriptionV2.bind(googleApi);
  googleApi.getSubscriptionV2 = async (t: string) => ({ ...(await real(t)), subscriptionState: "SUBSCRIPTION_STATE_PENDING" });
  const vp = await verifyGoogleClientPurchase(googleApi, token, { environment: "test" });
  googleApi.getSubscriptionV2 = real;
  assert.equal(vp.state.status, "pending");
  assert.equal(vp.acknowledge, null, "pending sa neacknowledguje");
  assert.equal((await applyVerifiedStorePurchase(serviceDb, storeProv("google"), vp.eventId, { ...vp.state, checkout_ref: String(i.checkout_id) }, vp.payloadSha256)).outcome, "applied");
  assert.equal((await ent(co.owner, "voice")).active, false);
  assert.equal((await options(co.owner, "android")).purchase_allowed, false, "pending = žiadny druhý nákup");
  tick(60);
  const va = await verifyGoogleClientPurchase(googleApi, token, { environment: "test" });
  assert.equal(va.state.status, "active");
  assert.ok(va.acknowledge);
  assert.notEqual(va.eventId, vp.eventId);
  assert.equal((await applyVerifiedStorePurchase(serviceDb, storeProv("google"), va.eventId, va.state, va.payloadSha256)).outcome, "applied");
  assert.equal((await ent(co.owner, "voice")).active, true);
});
await check("purchase-idempotency: token z cudzieho účtu (obfuscatedAccountId inej firmy) nepridelí nárok", async () => {
  const a = await newCompany({ trialEnded: true });
  const b = await newCompany({ trialEnded: true });
  const { token } = await buyGoogle(a);
  const v = await verifyGoogleClientPurchase(googleApi, token, { environment: "test" });
  const ib = await intent(b.owner, "test_pro", "month", "android", "google_play");
  const r = await applyVerifiedStorePurchase(serviceDb, storeProv("google"), v.eventId, { ...v.state, checkout_ref: String(ib.checkout_id) }, v.payloadSha256);
  assert.notEqual(r.outcome, "applied");
  assert.equal((await ent(b.owner, "voice")).active, false);
});

// ============================================================================= cross-provider
await check("cross-provider: web predplatné → Android/iOS neponúkne nákup, ukáže 'spravujete cez web'", async () => {
  const opts = await options(dash.owner, "android");
  assert.equal(opts.purchase_allowed, false);
  assert.deepEqual(opts.methods, []);
  assert.deepEqual(opts.current, { status: "active", managed_via: "web", manage_here: false, cancel_at_period_end: false });
  assert.equal(((await options(dash.owner, "web")).current as Row).manage_here, true);
  assert.equal(((await options(dash.owner, "ios")).current as Row).managed_via, "web");
});
await check("cross-provider: druhý nákup cez Google pri aktívnom webe → ESBLU_BILLING_ACTIVE_ON_OTHER_PROVIDER (server)", async () => {
  await fails(() => intent(dash.owner, "test_pro", "month", "android", "google_play"), /ESBLU_BILLING_ACTIVE_ON_OTHER_PROVIDER/);
  await fails(() => rpcAs(dash.owner, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /ALREADY_SUBSCRIBED|ACTIVE/);
});
await check("cross-provider: store purchase obíde UI → apply_event = conflict, žiadny druhý nárok, operátor vidí event", async () => {
  const co = await newCompany({ trialEnded: true });
  // Firma má najprv Google, potom sa niekto pokúsi o web cez podvrhnutý fake event s cudzím sub ID.
  const { i, token } = await buyGoogle(co);
  const v = await verifyGoogleClientPurchase(googleApi, token, { environment: "test" });
  assert.equal((await applyVerifiedStorePurchase(serviceDb, storeProv("google"), v.eventId, { ...v.state, checkout_ref: String(i.checkout_id) }, v.payloadSha256)).outcome, "applied");
  const acc = await accountOf(co);
  const checkout = String((await one<Row>(`insert into public.billing_checkout_sessions (company_id, provider, environment, plan_code, billing_interval, provider_price_id, status, created_by)
    values ('${co.id}', 'fake', 'test', 'test_pro', 'month', 'fake_price_pro_month', 'created', '${co.owner}') returning id`)).id ?? "");
  assert.ok(checkout, "checkout session fixture");
  const sWeb = await fake.simulateCheckoutPaid({ checkoutId: checkout, providerPriceId: "fake_price_pro_month", interval: "month" });
  assert.equal((await deliver("fake.checkout.completed", sWeb)).outcome, "conflict");
  const after = await accountOf(co);
  assert.equal(after.billing_provider, "google");
  assert.equal(after.provider_subscription_id, acc.provider_subscription_id);
  const conflicts = Number((await one<{ n: number }>(`select count(*)::int n from public.billing_events where company_id = '${co.id}' and status = 'conflict'`)).n);
  assert.equal(conflicts, 1);
  // Google predplatné: spravuje sa iba na Androide
  assert.deepEqual((await options(co.owner, "web")).current, { status: "active", managed_via: "google_play", manage_here: false, cancel_at_period_end: false });
  assert.equal(((await options(co.owner, "android")).current as Row).manage_here, true);
  assert.equal(((await options(co.owner, "ios")).current as Row).manage_here, false);
});
await check("cross-provider: po expirácii u jedného providera je nákup inde povolený", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  await deliver("fake.subscription.deleted", next(s, { status: "expired", ended_at: clock.toISOString() }));
  const opts = await options(co.owner, "android");
  assert.equal(opts.purchase_allowed, true);
  assert.equal(opts.current, null);
  const i = await intent(co.owner, "test_pro", "month", "android", "google_play");
  assert.equal(i.provider, "google");
});

// ============================================================================= subscription-cross-device
await check("subscription-cross-device: ten istý stav/nárok bez ohľadu na platformu a rolu (RPC nemá parameter platformy)", async () => {
  const ref = await entitlementsOf(dash.owner);
  for (const uid of [dash.emp, dash.acc, dash.billingAdmin]) assert.deepEqual(await entitlementsOf(uid), ref);
  const v = await subOf(dash.emp);
  assert.equal(v.status, "active");
  assert.equal(v.managedVia, "web");
  assert.equal(v.entitles, true);
});
await check("subscription-cross-device: zmena na jednom zariadení (cancel na webe) je hneď vidieť všade", async () => {
  tick(5);
  await deliver("fake.subscription.updated", { ...sDash, checkout_ref: null, charge: null, cancel_at_period_end: true, state_at: clock.toISOString() });
  for (const uid of [dash.owner, dash.emp]) assert.equal((await subOf(uid)).cancelAtPeriodEnd, true);
  assert.equal(((await options(dash.owner, "android")).current as Row).cancel_at_period_end, true);
  assert.equal((await ent(dash.emp, "voice")).active, true, "do konca obdobia");
});

// ============================================================================= subscription-rbac
await check("subscription-rbac: owner a admin+billing.manage smú kupovať; accountant / employee nie", async () => {
  const co = await newCompany();
  await rpcAs(co.billingAdmin, "esblu_billing_create_checkout_intent", ["test_pro", "month"]);
  await fails(() => rpcAs(co.emp, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /FORBIDDEN/);
  await fails(() => rpcAs(co.acc, "esblu_billing_create_checkout_intent", ["test_pro", "month"]), /FORBIDDEN/);
  await fails(() => intent(co.emp, "test_pro", "month", "android", "google_play"), /FORBIDDEN/);
  const empOpts = await options(co.emp, "web");
  assert.equal(empOpts.can_manage, false);
});
await check("subscription-rbac: cudzia firma nevidí ani neovplyvní predplatné", async () => {
  const other = await newCompany();
  assert.equal((await subOf(other.owner)).status, "none");
  const e = await explain(other.owner);
  assert.ok(e.entitlements.every((x) => x.source !== "subscription"));
});

// ============================================================================= subscription-rls
await check("subscription-rls: billing_reconciliation a service RPC sú pre authenticated/anon nedostupné", async () => {
  await fails(() => as(dash.owner, () => db.query(`select * from public.billing_reconciliation`)), /permission denied/);
  await fails(() => asRole("anon", () => db.query(`select * from public.billing_reconciliation`)), /permission denied/);
  for (const call of [`esblu_billing_reconcile_candidates(10)`, `esblu_billing_reconcile_record(gen_random_uuid(),'in_sync',null)`, `esblu_billing_reconcile_requeue(gen_random_uuid())`, `esblu_billing_ops_status('${dash.id}')`]) {
    await fails(() => as(dash.owner, () => db.query(`select public.${call}`)), /permission denied/);
    await fails(() => asRole("anon", () => db.query(`select public.${call}`)), /permission denied/);
  }
  await fails(() => asRole("anon", () => db.query(`select public.esblu_billing_explain_my_entitlements()`)), /permission denied/);
});
await check("subscription-rls: RLS je zapnuté na billing_reconciliation; klient nemôže zapisovať nároky ani účty", async () => {
  const r = await one<Row>(`select relrowsecurity from pg_class where oid = 'public.billing_reconciliation'::regclass`);
  assert.equal(r.relrowsecurity, true);
  await fails(() => as(dash.owner, () => db.query(`update public.subscription_accounts set status = 'active'`)), /permission denied/);
  await fails(() => as(dash.owner, () => db.query(`insert into public.company_entitlements (company_id, entitlement_key, source) values ('${dash.id}', 'voice', 'manual')`)), /permission denied/);
});
await check("subscription-rls: ops_status (service) — bez payloadov, iba hash-ref eventov", async () => {
  const ops = (await serviceDb.rpc("esblu_billing_ops_status", { p_company_id: dash.id })).data as Row;
  const json = JSON.stringify(ops);
  assert.ok(ops.account);
  assert.ok(!json.includes("payload"), "žiadne raw payloady");
  assert.ok(!json.includes("fake_cus_"), "žiadne customer ID");
});

// ============================================================================= reconciliation
await check("reconciliation: drift (provider revoked) → corrected tou istou pipeline; v sync → in_sync", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  await su(`update public.billing_reconciliation set next_check_at = now() + interval '1 day'`); // izolácia
  tick(5);
  await fakeStore.put({ ...s, status: "revoked", ended_at: clock.toISOString(), checkout_ref: null, charge: null, state_at: clock.toISOString() });
  const accId = String((await accountOf(co)).id);
  const out = await runReconciliation(serviceDb, { fake: providerReconcileSource(fake) }, { limit: 50 });
  const mine = out.results.find((r) => r.accountId === accId)!;
  assert.equal(mine.result, "corrected", JSON.stringify(out));
  assert.equal((await accountOf(co)).status, "revoked");
  assert.equal((await ent(co.owner, "voice")).active, false);
  const rec = await one<Row>(`select last_result, consecutive_failures from public.billing_reconciliation where account_id = '${(await accountOf(co)).id}'`);
  assert.equal(rec.last_result, "corrected");
});
await check("reconciliation: chyby → exponenciálny backoff → dead-letter po 8 → requeue", async () => {
  const co = await newCompany({ trialEnded: true });
  await buyFake(co);
  const id = String((await accountOf(co)).id);
  const steps: number[] = [];
  for (let k = 1; k <= 8; k++) {
    const r = (await serviceDb.rpc("esblu_billing_reconcile_record", { p_account_id: id, p_result: "error", p_error_code: "PROVIDER_TIMEOUT" })).data as Row;
    const mins = (new Date(String(r.next_check_at)).getTime() - Date.now()) / 60_000;
    steps.push(Math.round(mins));
    assert.equal(r.dead_letter, k >= 8);
  }
  assert.deepEqual(steps.slice(0, 4), [15, 30, 60, 120]);
  assert.ok(steps[7] <= 24 * 60);
  const cands = (await serviceDb.rpc("esblu_billing_reconcile_candidates", { p_limit: 500 })).data as Row[];
  assert.ok(!cands.some((c) => c.account_id === id), "dead-letter nie je kandidát");
  await serviceDb.rpc("esblu_billing_reconcile_requeue", { p_account_id: id });
  const after = (await serviceDb.rpc("esblu_billing_reconcile_candidates", { p_limit: 500 })).data as Row[];
  assert.ok(after.some((c) => c.account_id === id));
  const bad = await serviceDb.rpc("esblu_billing_reconcile_record", { p_account_id: id, p_result: "error", p_error_code: "sk_test_secret value" });
  assert.equal(((await one<Row>(`select last_error_code from public.billing_reconciliation where account_id = '${id}'`)).last_error_code), "INVALID_ERROR_CODE", JSON.stringify(bad));
});
await check("reconciliation: provider nedostupný / nenakonfigurovaný → error/skipped, stav účtu sa nemení", async () => {
  const co = await newCompany({ trialEnded: true });
  await buyFake(co);
  await su(`update public.billing_reconciliation set next_check_at = now() + interval '1 day' where account_id <> '${(await accountOf(co)).id}'`);
  const down: ReconcileSource = { provider: "fake", fetchState: async () => { throw new Error("ECONNRESET"); } };
  const accId = String((await accountOf(co)).id);
  const out = await runReconciliation(serviceDb, { fake: down }, { limit: 500 });
  const mine = out.results.find((r) => r.accountId === accId)!;
  assert.equal(mine.result, "error");
  assert.equal((await accountOf(co)).status, "active");
  await su(`update public.billing_reconciliation set next_check_at = now() - interval '1 minute', last_checked_at = null where account_id = '${(await accountOf(co)).id}'`);
  const out2 = await runReconciliation(serviceDb, {}, { limit: 500 });
  assert.equal(out2.results.find((r) => r.accountId === accId)!.result, "skipped");
});

// ============================================================================= subscription-concurrency
await check("subscription-concurrency: dve rôzne predplatné súbežne pre jednu firmu → jedno applied, druhé conflict", async () => {
  const co = await newCompany({ trialEnded: true });
  const c1 = String(((await rpcAs(co.owner, "esblu_billing_create_checkout_intent", ["test_pro", "month"])) as Row).checkout_id);
  const c2 = String(((await rpcAs(co.billingAdmin, "esblu_billing_create_checkout_intent", ["test_pro", "month"])) as Row).checkout_id);
  const s1 = await fake.simulateCheckoutPaid({ checkoutId: c1, providerPriceId: "fake_price_pro_month", interval: "month" });
  const s2 = await fake.simulateCheckoutPaid({ checkoutId: c2, providerPriceId: "fake_price_pro_month", interval: "month" });
  const [r1, r2] = await Promise.all([deliver("fake.checkout.completed", s1), deliver("fake.checkout.completed", s2)]);
  assert.deepEqual([r1.outcome, r2.outcome].sort(), ["applied", "conflict"], JSON.stringify([r1, r2]));
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.company_entitlements where company_id = '${co.id}' and source = 'subscription' and entitlement_key = 'voice'`)).n), 1);
});
await check("subscription-concurrency: súbežný cancel + renewal toho istého predplatného → vyhrá novší provider stav", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  const renewal = next(s, { cancel_at_period_end: false });
  const cancel = next(s, { cancel_at_period_end: true });
  await Promise.all([deliver("fake.subscription.updated", cancel), deliver("fake.subscription.updated", renewal)]);
  assert.equal((await accountOf(co)).cancel_at_period_end, true);
});
await check("subscription-concurrency: DB ochrana — unique (provider, env, event_id) + advisory lock v apply_event / intent", async () => {
  const idx = await one<{ n: number }>(`select count(*)::int n from pg_indexes where tablename = 'billing_events' and indexdef ilike '%unique%' and indexdef ilike '%provider_event_id%'`);
  assert.ok(Number(idx.n) >= 1);
  const src = read(LIFECYCLE);
  const apply = src.slice(src.indexOf("function public.esblu_billing_apply_event"), src.indexOf("function public.esblu_billing_purchase_options"));
  assert.match(apply, /pg_advisory_xact_lock/);
  assert.match(apply, /for update/);
  const intentSrc = src.slice(src.indexOf("function public.esblu_billing_create_purchase_intent"));
  assert.match(intentSrc, /pg_advisory_xact_lock/);
});

// ============================================================================= stripe-adapter (cez DB pipeline)
await check("stripe-adapter: Stripe test webhook → DB (checkout, full refund → refunded, dispute lost → revoked)", async () => {
  const KEY = "sk_test_" + "a".repeat(24);
  const WHSEC = "whsec_" + "b".repeat(32);
  await su(`insert into public.billing_provider_prices (provider, environment, plan_code, billing_interval, provider_price_id, active)
    values ('stripe', 'test', 'test_pro', 'month', 'price_test_pro_m', true) on conflict do nothing`);
  await su(`update public.billing_runtime_config set web_provider = 'stripe'`);
  try {
    const co = await newCompany({ trialEnded: true });
    const checkout = String(((await rpcAs(co.owner, "esblu_billing_create_checkout_intent", ["test_pro", "month"])) as Row).checkout_id);
    let nowS = Math.floor(Date.now() / 1000);
    let remote: Row = {
      object: "subscription", id: "sub_db_1", customer: "cus_db_1", status: "active", cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
      metadata: { esblu_checkout_id: checkout }, items: { data: [{ id: "si_1", price: { id: "price_test_pro_m" }, current_period_start: nowS, current_period_end: nowS + 30 * 86400 }] },
    };
    const charge = { object: "charge", id: "ch_db_1", amount: 1218, currency: "eur", payment_intent: "pi_1" };
    const fetchImpl = (async (url: string) => {
      const body = url.includes("/subscriptions/sub_db_1") ? remote
        : url.includes("/invoice_payments") ? { data: [{ invoice: "in_db_1" }] }
        : url.includes("/invoices/in_db_1") ? { object: "invoice", id: "in_db_1", subscription: "sub_db_1" }
        : url.includes("/charges/ch_db_1") ? charge : null;
      return new Response(JSON.stringify(body ?? { error: {} }), { status: body ? 200 : 404 });
    }) as unknown as typeof fetch;
    let wallMs = Date.now();
    const stripe = new StripeTestProvider({ secretKey: KEY, webhookSecret: WHSEC, fetchImpl, now: () => new Date(wallMs) });
    const send = (type: string, object: unknown, id: string) => {
      wallMs += 5000;
      nowS = Math.floor(wallMs / 1000);
      const raw = JSON.stringify({ object: "event", id, type, created: nowS, livemode: false, data: { object } });
      return processWebhook(stripe, raw, new Headers({ "stripe-signature": signTimestamped(raw, WHSEC, nowS) }), serviceDb);
    };
    const r1 = await send("checkout.session.completed", { object: "checkout.session", id: "cs_1", mode: "subscription", subscription: "sub_db_1", client_reference_id: checkout, metadata: { esblu_checkout_id: checkout } }, "evt_db_1");
    assert.equal(r1.outcome, "applied", JSON.stringify(r1));
    assert.equal((await ent(co.owner, "voice")).active, true);
    // Webhook 10× (Stripe retry) → jedno spracovanie
    for (let k = 0; k < 3; k++) assert.equal((await send("customer.subscription.updated", remote, "evt_db_2")).outcome, k === 0 ? "applied" : "duplicate");
    const r3 = await send("charge.refunded", { ...charge, amount_refunded: 1218, refunded: true }, "evt_db_3");
    assert.equal(r3.outcome, "applied", JSON.stringify(r3));
    assert.equal((await accountOf(co)).status, "refunded");
    assert.equal((await ent(co.owner, "voice")).active, false);
    // late dispute lost na už refundovanom = terminálny (refunded→revoked je stále terminálny, nič sa neoživí)
    const r4 = await send("charge.dispute.closed", { object: "dispute", id: "dp_1", charge: "ch_db_1", status: "lost" }, "evt_db_4");
    assert.ok(["applied", "stale"].includes(r4.outcome), JSON.stringify(r4));
    assert.equal((await ent(co.owner, "voice")).active, false);
    remote = { ...remote };
  } finally {
    await su(`update public.billing_runtime_config set web_provider = 'fake'`);
  }
});

// ============================================================================= failure-matrix
await check("failure-matrix: výpadok DB pri apply → retry (5xx), event ostane nespracovaný; opakované doručenie → applied", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  const signed = fake.signEvent(fake.buildEvent("fake.subscription.updated", next(s, { cancel_at_period_end: true }), "evt_dbfault"));
  dbFault = "esblu_billing_apply_event";
  const r1 = await processWebhook(fake, signed.rawBody, signed.headers, serviceDb);
  dbFault = null;
  assert.equal(r1.outcome, "retry");
  assert.ok(r1.httpStatus >= 500);
  assert.equal((await accountOf(co)).cancel_at_period_end, false);
  const r2 = await processWebhook(fake, signed.rawBody, signed.headers, serviceDb);
  assert.equal(r2.outcome, "applied", JSON.stringify(r2));
  assert.equal((await accountOf(co)).cancel_at_period_end, true);
});
await check("failure-matrix: výpadok DB pri record_event → retry, nič nezapísané", async () => {
  const co = await newCompany({ trialEnded: true });
  const s = await buyFake(co);
  const before = await eventsOf(co);
  dbFault = "esblu_billing_record_event";
  const r = await deliver("fake.subscription.updated", next(s, { cancel_at_period_end: true }));
  dbFault = null;
  assert.equal(r.outcome, "retry");
  assert.equal(await eventsOf(co), before);
});
await check("failure-matrix: neznáma cena / neznáma firma → failed_permanent (žiadny nárok), nie nekonečný retry", async () => {
  const co = await newCompany({ trialEnded: true });
  const c = String(((await rpcAs(co.owner, "esblu_billing_create_checkout_intent", ["test_pro", "month"])) as Row).checkout_id);
  const s = await fake.simulateCheckoutPaid({ checkoutId: c, providerPriceId: "fake_price_does_not_exist", interval: "month" });
  const r = await deliver("fake.checkout.completed", s);
  assert.equal(r.outcome, "failed_permanent", JSON.stringify(r));
  assert.equal((await ent(co.owner, "voice")).active, false);
  const orphan = await fake.simulateCheckoutPaid({ checkoutId: "00000000-0000-4000-8000-0000000000ff", providerPriceId: "fake_price_pro_month", interval: "month" });
  assert.equal((await deliver("fake.checkout.completed", orphan)).outcome, "failed_permanent");
});

// ============================================================================= subscription-migrations (rollback — posledné)
await check("subscription-migrations: lifecycle rollback zachová dáta, zmapuje stavy späť; re-apply forward je OK", async () => {
  const before = Number((await one<{ n: number }>(`select count(*)::int n from public.billing_events`)).n);
  await serialized(() => db.exec(read(LIFECYCLE_ROLLBACK)));
  const statuses = (await su<{ status: string }>(`select distinct status from public.subscription_accounts`)).rows.map((r) => r.status);
  for (const s of statuses) assert.ok(["none", "incomplete", "trialing", "active", "past_due", "unpaid", "paused", "canceled", "expired"].includes(s), s);
  assert.equal(Number((await one<{ n: number }>(`select count(*)::int n from public.billing_events`)).n), before, "rollback nemaže eventy");
  await fails(() => su(`select public.esblu_billing_explain_my_entitlements()`), /does not exist/);
  await serialized(() => db.exec(read(LIFECYCLE)));
  assert.equal((await ent(dash.owner, "voice")).active, true);
});

console.log(`\nsubscriptions-lifecycle-db: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
