// =============================================================================
// Zrušenie účtu × aktívne predplatné (2026-10-12) — unit + kontraktné testy.
// DB časť (trigger, parita predikátu, kaskáda, fake E2E) je v
// scripts/subscriptions-lifecycle-pglite-tests.ts (suite account-deletion).
//   npm run test:account-deletion-subscription
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deletionManagedViaKey,
  deletionReasonKey,
  evaluateDeletionGuard,
  type SubscriptionAccountSnapshot,
} from "@/lib/billing/deletion-guard";
import { checkSubscriptionForDeletion, isMissingBillingSchemaError } from "@/lib/account-deletion-subscription";
import sk from "@/lib/i18n/dictionaries/sk";
import en from "@/lib/i18n/dictionaries/en";
import de from "@/lib/i18n/dictionaries/de";

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${(error as Error)?.stack?.split("\n").slice(0, 3).join("\n       ") ?? error}`);
  }
}
const read = (p: string) => readFileSync(p, "utf8");
const acc = (status: string, provider: string | null, cancel = false, end: string | null = "2026-11-12T00:00:00Z"): SubscriptionAccountSnapshot => ({
  status,
  billing_provider: provider,
  cancel_at_period_end: cancel,
  current_period_end: end,
});
const owner = (account: SubscriptionAccountSnapshot | null, extra: Partial<Parameters<typeof evaluateDeletionGuard>[0]> = {}) =>
  evaluateDeletionGuard({ account, openCheckoutProvider: null, scope: "company", ...extra });

// ----------------------------------------------------------------------------- canonical policy
await check("policy: Stripe / Google Play / App Store aktívne a obnovujúce sa → can_delete=false, ACTIVE_SUBSCRIPTION_RENEWING, správne managed_via", () => {
  for (const [p, via] of [["stripe", "web"], ["google", "google_play"], ["apple", "app_store"]] as const) {
    const r = owner(acc("active", p));
    assert.equal(r.can_delete, false);
    assert.equal(r.blocking_reason, "ACTIVE_SUBSCRIPTION_RENEWING");
    assert.equal(r.subscription_status, "active_renewing");
    assert.equal(r.managed_via, via);
    assert.equal(r.provider, p);
  }
});
await check("policy: trial PROVIDERA (trialing bez zrušenia) sa zmení na platbu → blokuje", () => {
  assert.equal(owner(acc("trialing", "stripe")).can_delete, false);
});
await check("policy (NEZMENENÁ): zrušená obnova → povolené aj pred current_period_end; forfeits_remaining_period + upozornenie", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const r = owner(acc("active", "google", true), { now });
  assert.equal(r.can_delete, true);
  assert.equal(r.blocking_reason, null);
  assert.equal(r.subscription_status, "active_non_renewing");
  assert.equal(r.current_period_end, "2026-11-12T00:00:00Z");
  assert.equal(r.forfeits_remaining_period, true);
  assert.equal(deletionReasonKey(r), "settings.deleteModal.subscription.forfeitTitle");
  // obdobie už skončilo → nič neprepadá
  const after = owner(acc("active", "google", true), { now: new Date("2026-11-13T00:00:00Z") });
  assert.equal(after.can_delete, true);
  assert.equal(after.forfeits_remaining_period, false);
  // neznámy koniec obdobia → fail closed na upozornenie
  assert.equal(owner(acc("active", "stripe", true, null), { now }).forfeits_remaining_period, true);
  // obnovujúce sa / ukončené nikdy nie „forfeit"
  assert.equal(owner(acc("active", "stripe"), { now }).forfeits_remaining_period, false);
  assert.equal(owner(acc("canceled", "stripe"), { now }).forfeits_remaining_period, false);
});
await check("policy: platba u providera (pending/incomplete/grace/past_due/hold/unpaid/paused) → blokuje aj so zrušenou obnovou", () => {
  for (const s of ["pending", "incomplete", "grace_period", "past_due", "account_hold", "unpaid", "paused"]) {
    const r = owner(acc(s, "apple", true));
    assert.equal(r.can_delete, false, s);
    assert.equal(r.blocking_reason, "SUBSCRIPTION_PAYMENT_IN_PROGRESS", s);
  }
});
await check("policy: ukončené predplatné, manuálny grant, Esblu trial, free → neblokuje", () => {
  for (const s of ["canceled", "expired", "refunded", "revoked"]) assert.equal(owner(acc(s, "stripe")).can_delete, true, s);
  assert.equal(owner(acc("active", "manual")).subscription_status, "manual");
  assert.equal(owner(null, { manualGrantActive: true }).subscription_status, "manual");
  assert.equal(owner(null, { trialActive: true }).subscription_status, "trial");
  const free = owner(null);
  assert.equal(free.can_delete, true);
  assert.equal(free.subscription_status, "none");
  assert.equal(free.blocking_reason, null);
  // neblokujúci kontext nikdy neprebije externé predplatné
  assert.equal(owner(acc("active", "stripe"), { trialActive: true, manualGrantActive: true }).can_delete, false);
});
await check("policy: neznámy stav / neznámy provider / chyba čítania → fail closed", () => {
  assert.equal(owner(acc("weird", "stripe")).blocking_reason, "SUBSCRIPTION_STATE_UNVERIFIED");
  assert.equal(owner(acc("active", "paypal")).can_delete, false);
  const r = owner(null, { readFailed: true });
  assert.equal(r.can_delete, false);
  assert.equal(r.blocking_reason, "SUBSCRIPTION_STATE_UNVERIFIED");
  assert.equal(r.subscription_status, "unknown");
  assert.equal(deletionManagedViaKey(r), null, "pri neovernom stave neukazujeme, kde spravovať");
});
await check("policy: otvorený checkout blokuje (aj bez predplatného); predplatné má prednosť", () => {
  const r = owner(null, { openCheckoutProvider: "stripe" });
  assert.equal(r.can_delete, false);
  assert.equal(r.blocking_reason, "CHECKOUT_IN_PROGRESS");
  assert.equal(r.managed_via, "web");
  assert.equal(owner(acc("active", "google"), { openCheckoutProvider: "stripe" }).blocking_reason, "ACTIVE_SUBSCRIPTION_RENEWING");
  assert.equal(owner(acc("canceled", "stripe"), { openCheckoutProvider: "apple" }).blocking_reason, "CHECKOUT_IN_PROGRESS");
});
await check("policy: člen — firma ostáva; blokuje IBA overená identita platiteľa (dnes neexistuje), inak upozornenie správcovi", () => {
  const m = (a: SubscriptionAccountSnapshot | null, o: { verified?: boolean; manage?: boolean } = {}) =>
    evaluateDeletionGuard({ account: a, openCheckoutProvider: "stripe", scope: "member", verifiedMemberPurchaser: o.verified, memberCanManageBilling: o.manage });
  // bez overenej identity: nikdy neblokovať, nevymýšľať platiteľa
  for (const p of ["google", "apple"]) {
    const admin = m(acc("active", p), { manage: true });
    assert.equal(admin.can_delete, true, p);
    assert.equal(admin.store_subscription_notice, true, p);
    assert.equal(m(acc("active", p)).store_subscription_notice, false, `${p} employee`);
  }
  assert.equal(m(acc("active", "stripe"), { manage: true }).store_subscription_notice, false, "Stripe = firemná karta");
  assert.equal(m(acc("active", "apple", true), { manage: true }).store_subscription_notice, false, "zrušená obnova → bez upozornenia");
  // keby architektúra raz poskytla OVERENÚ identitu platiteľa
  assert.equal(m(acc("active", "google"), { verified: true }).blocking_reason, "STORE_SUBSCRIPTION_PURCHASER");
  assert.equal(m(acc("past_due", "apple", true), { verified: true }).blocking_reason, "STORE_SUBSCRIPTION_PURCHASER");
  assert.equal(m(acc("active", "stripe"), { verified: true }).can_delete, true);
  assert.equal(m(null, { verified: true }).can_delete, true, "otvorený checkout firmy člena neblokuje");
});
await check("guidance: dôvod + kde spravovať (rovnaké texty ako obrazovka Predplatné)", () => {
  assert.equal(deletionReasonKey(owner(acc("active", "stripe"))), "settings.deleteModal.subscription.blockedRenewing");
  assert.equal(deletionManagedViaKey(owner(acc("active", "stripe"))), "subscription.managedVia.web");
  assert.equal(deletionManagedViaKey(owner(acc("active", "google"))), "subscription.managedVia.googlePlay");
  assert.equal(deletionManagedViaKey(owner(acc("active", "apple"))), "subscription.managedVia.appStore");
  assert.equal(deletionReasonKey(owner(acc("past_due", "stripe"))), "settings.deleteModal.subscription.blockedPayment");
  assert.equal(deletionReasonKey(owner(null, { openCheckoutProvider: "google" })), "settings.deleteModal.subscription.blockedCheckout");
  assert.equal(deletionReasonKey(owner(null)), null);
  assert.equal(sk.subscription.managedVia.web.startsWith("Predplatné spravujete cez web"), true);
  assert.equal(sk.subscription.managedVia.googlePlay, "Predplatné spravujete cez Google Play.");
  assert.equal(sk.subscription.managedVia.appStore, "Predplatné spravujete cez App Store.");
});
await check("i18n: všetky nové kľúče v SK / EN / DE", () => {
  const keys = ["title", "blockedRenewing", "blockedPayment", "blockedCheckout", "blockedPurchaser", "blockedUnverified", "afterCancel",
    "forfeitTitle", "forfeitNoRenewal", "forfeitAccessEnds", "forfeitRemaining", "forfeitNoRefund", "forfeitAcknowledge", "storeNotice"];
  for (const [name, d] of [["sk", sk], ["en", en], ["de", de]] as const) {
    const m = (d.settings.deleteModal as Record<string, unknown>).subscription as Record<string, string>;
    for (const k of keys) assert.ok(typeof m[k] === "string" && m[k].length > 10, `${name}.${k}`);
    assert.ok(m.blockedPurchaser.includes("{{store}}") && m.forfeitRemaining.includes("{{date}}"), name);
    assert.equal(m.nonRenewingWarning, undefined, `${name}: starý kľúč odstránený`);
    const e = d.settings.errors as Record<string, string>;
    assert.ok(e.subscriptionBlocksDeletion && e.subscriptionStateUnverified && e.forfeitAcknowledgementRequired, name);
  }
});

// ----------------------------------------------------------------------------- server reader
type Res = { data: unknown; error: { code?: string; message?: string } | null; count?: number | null };
function fakeAdmin(tables: Record<string, Res | ((filters: Record<string, unknown>) => Res)>, calls: string[] = []) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const result = () => {
        calls.push(table);
        const t = tables[table];
        if (!t) return { data: null, error: null, count: 0 };
        return typeof t === "function" ? t(filters) : t;
      };
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gt", "order", "or", "limit"]) {
        builder[m] = (k: unknown, v: unknown) => {
          if (m === "eq" || m === "in") filters[String(k)] = v;
          return builder;
        };
      }
      builder.maybeSingle = async () => result();
      builder.then = (ok: (r: Res) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, ko);
      return builder;
    },
  } as never;
}
const NOW = new Date("2026-10-12T12:00:00Z");

await check("reader: billing schéma v DB neexistuje (produkcia pred migráciou) → bez blokácie", async () => {
  const missing = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.subscription_accounts' in the schema cache" } };
  assert.equal(isMissingBillingSchemaError(missing.error), true);
  assert.equal(isMissingBillingSchemaError({ code: "42P01", message: "relation does not exist" }), true);
  assert.equal(isMissingBillingSchemaError({ code: "08006", message: "connection failure" }), false);
  const r = await checkSubscriptionForDeletion(fakeAdmin({ subscription_accounts: missing }), { companyId: "c", userId: "u", scope: "company" }, NOW);
  assert.equal(r.can_delete, true);
});
await check("reader: iná chyba čítania subscription_accounts / checkoutov → SUBSCRIPTION_STATE_UNVERIFIED (fail closed)", async () => {
  const down = { data: null, error: { code: "57014", message: "statement timeout" } };
  assert.equal((await checkSubscriptionForDeletion(fakeAdmin({ subscription_accounts: down }), { companyId: "c", userId: "u", scope: "company" }, NOW)).blocking_reason, "SUBSCRIPTION_STATE_UNVERIFIED");
  const r = await checkSubscriptionForDeletion(
    fakeAdmin({ subscription_accounts: { data: null, error: null }, billing_checkout_sessions: down }),
    { companyId: "c", userId: "u", scope: "company" },
    NOW
  );
  assert.equal(r.blocking_reason, "SUBSCRIPTION_STATE_UNVERIFIED");
});
await check("reader: owner — aktívne Google predplatné blokuje; otvorený checkout blokuje; trial iba kontext", async () => {
  const r = await checkSubscriptionForDeletion(
    fakeAdmin({ subscription_accounts: { data: acc("active", "google"), error: null }, billing_checkout_sessions: { data: [], error: null } }),
    { companyId: "c", userId: "u", scope: "company" },
    NOW
  );
  assert.equal(r.blocking_reason, "ACTIVE_SUBSCRIPTION_RENEWING");
  const c = await checkSubscriptionForDeletion(
    fakeAdmin({ subscription_accounts: { data: null, error: null }, billing_checkout_sessions: { data: [{ provider: "stripe" }], error: null } }),
    { companyId: "c", userId: "u", scope: "company" },
    NOW
  );
  assert.equal(c.blocking_reason, "CHECKOUT_IN_PROGRESS");
  const t = await checkSubscriptionForDeletion(
    fakeAdmin({
      subscription_accounts: { data: null, error: null },
      billing_checkout_sessions: { data: [], error: null },
      companies: { data: { trial_ends_at: "2026-10-20T00:00:00Z" }, error: null },
    }),
    { companyId: "c", userId: "u", scope: "company" },
    NOW
  );
  assert.equal(t.can_delete, true);
  assert.equal(t.subscription_status, "trial");
  // chyba kontextu (trial/grant) neblokuje
  const e = await checkSubscriptionForDeletion(
    fakeAdmin({
      subscription_accounts: { data: null, error: null },
      billing_checkout_sessions: { data: [], error: null },
      companies: { data: null, error: { code: "x" } },
    }),
    { companyId: "c", userId: "u", scope: "company" },
    NOW
  );
  assert.equal(e.can_delete, true);
});
await check("reader: člen — ŽIADNE odvodzovanie platiteľa z checkoutov (restore nemá checkout); správca dostane upozornenie", async () => {
  for (const p of ["apple", "google"]) {
    const calls: string[] = [];
    const tables = {
      subscription_accounts: { data: acc("active", p), error: null },
      // aj keby existoval dokončený checkout tohto používateľa, nesmie sa použiť
      billing_checkout_sessions: { data: [{ created_by: "u1", provider: p }], error: null },
    };
    const admin = await checkSubscriptionForDeletion(fakeAdmin(tables, calls), { companyId: "c", userId: "u1", scope: "member", memberCanManageBilling: true }, NOW);
    assert.equal(admin.can_delete, true, p);
    assert.equal(admin.blocking_reason, null, p);
    assert.equal(admin.store_subscription_notice, true, p);
    assert.ok(!calls.includes("billing_checkout_sessions"), "checkout sa pre člena vôbec nečíta");
  }
});

// ----------------------------------------------------------------------------- routes / UI contract
await check("delete route: predplatné + forfeit potvrdenie PRED zrušením; DB NAJPRV cez orchestráciu; route sama Storage nemaže", () => {
  const route = read("app/api/account/delete/route.ts");
  const retention = route.indexOf("findOwnerDeletionBlocker(admin, membership.company_id)");
  const ownerCheck = route.indexOf('scope: "company",');
  const forfeit = route.indexOf("subscriptionCheck.forfeits_remaining_period && body.acknowledgeForfeit !== true");
  const ownerOrchestrate = route.indexOf('"owner",\n        user.id');
  assert.ok(retention > 0 && retention < ownerCheck && ownerCheck < forfeit && forfeit < ownerOrchestrate, "owner: archivácia → predplatné → potvrdenie → orchestrácia");
  const memberCheck = route.indexOf('scope: "member",');
  const memberOrchestrate = route.indexOf('"member",\n      user.id');
  assert.ok(memberCheck > 0 && memberCheck < memberOrchestrate, "člen: predplatné → orchestrácia");
  // route už nemaže Storage ani nevolá legacy RPC priamo (iba cez orchestráciu / deps)
  for (const direct of ["collectOwnerStorageTargets", "collectMemberOwnStorageTargets", "removeStorageTargets", "storage.from(", '"esblu_owner_delete_company"', '"esblu_member_delete_self"']) {
    assert.ok(!route.includes(direct), direct);
  }
  // owner/member flow (POST) nevolá deleteUser priamo — iba orphan flow (bez súborov a firmy)
  assert.ok(!route.slice(route.indexOf("export async function POST")).includes("auth.admin.deleteUser("));
  assert.match(route, /if \(!subscriptionCheck\.can_delete\) \{\s*return subscriptionBlockedResponse/);
  assert.match(route, /if \(!memberSubscriptionCheck\.can_delete\) \{\s*return subscriptionBlockedResponse/);
  assert.match(route, /case "blocked_subscription":/);
  assert.match(route, /blocking_reason: "FORFEIT_ACKNOWLEDGEMENT_REQUIRED"/);
  assert.match(route, /status: check\.blocking_reason === "SUBSCRIPTION_STATE_UNVERIFIED" \? 503 : 409/);
  for (const forbidden of [/stripe\.com/i, /androidpublisher/i, /api\.storekit/i, /cancelSubscription/, /\.refunds?\b|createRefund|issueRefund/i]) assert.doesNotMatch(route, forbidden);
});
await check("preflight route: vracia can_delete, blocking_reason, subscription_status (+ detail)", () => {
  const route = read("app/api/account/preflight/route.ts");
  assert.match(route, /can_delete: !ownerDeletionBlocked && subscription\.can_delete/);
  assert.match(route, /blocking_reason: ownerDeletionBlocked \?\? subscription\.blocking_reason/);
  assert.match(route, /subscription_status: subscription\.subscription_status/);
  assert.match(route, /scope: membership\.role === "owner" \? "company" : "member"/);
  assert.match(route, /orphan: true,\s*can_delete: true/);
});
await check("UI: zablokované zrušenie nemá potvrdzovacie tlačidlo; ukazuje dôvod, kde spravovať a odkaz na Predplatné", () => {
  const page = read("app/nastavenia/page.tsx");
  const blocked = page.indexOf("deletePreflight?.subscription && !deletePreflight.subscription.can_delete ?");
  const ownerConfirm = page.indexOf('deletePreflight?.role === "owner" ? (', blocked);
  assert.ok(blocked > 0 && ownerConfirm > blocked, "blokácia je pred owner aj member potvrdením");
  const panel = page.slice(blocked, ownerConfirm);
  assert.doesNotMatch(panel, /confirmDeleteAccount/);
  assert.match(panel, /deletionReasonKey\(deletePreflight\.subscription\)/);
  assert.match(panel, /deletionManagedViaKey\(deletePreflight\.subscription\)/);
  assert.match(panel, /href="\/nastavenia\/predplatne"/);
  // zrušená obnova + bežiace obdobie: 4 body upozornenia + povinné potvrdenie (tlačidlo inak vypnuté)
  const forfeit = page.slice(page.indexOf("deletePreflight.subscription?.forfeits_remaining_period && ("));
  for (const k of ["forfeitTitle", "forfeitNoRenewal", "forfeitAccessEnds", "forfeitRemaining", "forfeitNoRefund", "forfeitAcknowledge"]) assert.ok(forfeit.includes(`settings.deleteModal.subscription.${k}`), k);
  assert.match(page, /forfeits_remaining_period === true && !forfeitAcknowledged/);
  assert.match(page, /acknowledgeForfeit: deletePreflight\.role === "owner" && forfeitAcknowledged/);
  assert.match(page, /store_subscription_notice && \(/);
});
await check("migrácia: forward-only, bez DROP TABLE / DELETE dát, rollback existuje", () => {
  const sql = read("supabase/migrations/20261012120000_account_deletion_subscription_guard.sql");
  assert.doesNotMatch(sql, /drop table|truncate|delete from|update public\./i);
  assert.match(sql, /before delete on public\.subscription_accounts/);
  assert.match(sql, /before delete on public\.billing_checkout_sessions/);
  assert.match(read("supabase/rollback/20261012120000_account_deletion_subscription_guard_rollback.sql"), /drop trigger if exists subscription_accounts_delete_guard/);
});

console.log(`\naccount-deletion-subscription: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
