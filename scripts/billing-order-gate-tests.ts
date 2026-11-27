// =============================================================================
// Spustenie predaja (2026-11-27): iba Esblu Komplet mesačne, súhlas s objednávkou a aktuálnymi VOP
// (VOP 1.3 čl. 10.4), Cenník „Pripravujeme“, bez textov testovacieho prostredia v predplatnom.
//
//   npm run test:billing-order-gate
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkOrderGate, LAUNCH_SELLABLE_PLANS, planPurchasable } from "@/lib/billing/order-gate";
import { StripeTestProvider } from "@/lib/billing/providers/stripe";
import sk from "@/lib/i18n/dictionaries/sk";
import en from "@/lib/i18n/dictionaries/en";
import de from "@/lib/i18n/dictionaries/de";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}
const db = (row: unknown, error: unknown = null) => ({
  rpc: async (fn: string) => {
    assert.equal(fn, "esblu_get_my_company_terms_status");
    return { data: row, error };
  },
});
const accepted = [{ current_terms_version: "1.3", has_current_acceptance: true }];

await check("predajné pri spustení: iba esblu_complete mesačne; moduly, ďalšia firma a ročná platba nie; test plány (staging) áno", () => {
  assert.deepEqual(LAUNCH_SELLABLE_PLANS, [{ planCode: "esblu_complete", interval: "month" }]);
  assert.equal(planPurchasable("esblu_complete", "month"), true);
  assert.equal(planPurchasable("esblu_complete", "year"), false);
  assert.equal(planPurchasable("esblu_modular", "month"), false);
  assert.equal(planPurchasable("esblu_complete_secondary", "month"), false);
  assert.equal(planPurchasable("test_pro", "month"), true);
});

await check("brána: nepredajný plán → 409 ESBLU_BILLING_PLAN_NOT_PURCHASABLE (pred čítaním DB)", async () => {
  const r = await checkOrderGate({ rpc: async () => assert.fail("DB sa nečíta") }, { planCode: "esblu_modular", interval: "month", orderConsent: true, termsVersion: "1.3" });
  assert.deepEqual(r, { ok: false, code: "ESBLU_BILLING_PLAN_NOT_PURCHASABLE", status: 409 });
});

await check("brána: bez výslovného potvrdenia objednávky alebo bez verzie VOP → 400 ESBLU_BILLING_ORDER_CONSENT_REQUIRED", async () => {
  for (const input of [
    { orderConsent: false, termsVersion: "1.3" },
    { orderConsent: "true", termsVersion: "1.3" },
    { orderConsent: true, termsVersion: null },
    { orderConsent: true, termsVersion: "1.3; drop" },
  ]) {
    const r = await checkOrderGate(db(accepted), { planCode: "esblu_complete", interval: "month", ...input });
    assert.deepEqual(r, { ok: false, code: "ESBLU_BILLING_ORDER_CONSENT_REQUIRED", status: 400 }, JSON.stringify(input));
  }
});

await check("brána: firma neprijala aktuálne VOP / iná verzia / chyba DB → 409 ESBLU_BILLING_TERMS_REQUIRED (fail closed)", async () => {
  const input = { planCode: "esblu_complete", interval: "month" as const, orderConsent: true, termsVersion: "1.3" };
  for (const [row, err] of [
    [[{ current_terms_version: "1.3", has_current_acceptance: false }], null],
    [[{ current_terms_version: "1.4", has_current_acceptance: true }], null],
    [[], null],
    [null, { message: "boom" }],
  ] as const) {
    const r = await checkOrderGate(db(row, err), input);
    assert.deepEqual(r, { ok: false, code: "ESBLU_BILLING_TERMS_REQUIRED", status: 409 });
  }
  assert.deepEqual(await checkOrderGate(db(accepted), input), { ok: true, termsVersion: "1.3" });
  assert.deepEqual(await checkOrderGate(db(accepted[0]), input), { ok: true, termsVersion: "1.3" }, "jeden riadok (nie pole)");
});

await check("routy: brána beží PRED vytvorením zámeru v DB (purchase-intent aj starý /checkout); verzia VOP ide do Stripe", () => {
  for (const [file, rpc] of [
    ["app/api/billing/purchase-intent/route.ts", "esblu_billing_create_purchase_intent"],
    ["app/api/billing/checkout/route.ts", "esblu_billing_create_checkout_intent"],
  ] as const) {
    const src = read(file);
    const gate = src.indexOf("await checkOrderGate(who.db");
    assert.ok(gate > 0 && gate < src.indexOf(`rpc("${rpc}"`), file);
    assert.match(src, /termsVersion: gate\.termsVersion/);
  }
});

await check("Stripe Checkout: metadáta esblu_terms_version na relácii aj predplatnom", async () => {
  let sent = "";
  const provider = new StripeTestProvider({
    secretKey: "sk_test_" + "x".repeat(24),
    webhookSecret: "whsec_" + "x".repeat(24),
    fetchImpl: (async (_url: string, init?: { body?: string }) => {
      sent = String(init?.body ?? "");
      return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", livemode: false }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await provider.createCheckout({
    checkoutId: "11111111-1111-4111-8111-111111111111", providerPriceId: "price_1", providerCustomerId: null,
    successUrl: "https://www.esblu.com/x", cancelUrl: "https://www.esblu.com/y", termsVersion: "1.3",
  });
  const p = new URLSearchParams(sent);
  assert.equal(p.get("metadata[esblu_terms_version]"), "1.3");
  assert.equal(p.get("subscription_data[metadata][esblu_terms_version]"), "1.3");
});

await check("predplatné (UI): cena, obdobie, automatické predĺženie, okamih prvej platby, zrušenie; nákup iba po prijatí VOP a potvrdení", () => {
  const page = read("app/nastavenia/predplatne/page.tsx");
  for (const key of ["subscription.order.price", "subscription.order.renewal", "subscription.order.firstCharge", "subscription.order.cancel", "subscription.order.consent"]) {
    assert.ok(page.includes(key), key);
  }
  assert.match(page, /disabled=\{busy \|\| !orderReady\} onClick=\{\(\) => runAction\(a, plan\.planCode, "new"\)\}/);
  assert.match(page, /const orderReady = termsAccepted && orderConsent;/);
  assert.match(page, /orderConsent, termsVersion: termsStatus\?\.current_terms_version \?\? null/);
  assert.match(page, /acceptCompanyTerms\(termsStatus\.current_terms_version, termsB2b, termsAuthority\)/);
  assert.ok(!page.includes("subscription.stagingNotice"), "žiadny text o testovacom prostredí");
  assert.ok(!read("app/components/billing/PlanOverviewPanel.tsx").includes("stagingNotice"), "panel bez textu o testovacom prostredí");
  assert.ok(!read("app/components/billing/PlanOverviewPanel.tsx").includes("previewAddModule"), "panel bez simulácie modulov");
});

await check("Cenník: moduly, rozšírenia a ďalšia firma „Pripravujeme“, bez výberu a kalkulačky; oznámenie podľa NEXT_PUBLIC_ESBLU_BILLING_UI", () => {
  const src = read("app/cennik/PricingPageClient.tsx");
  assert.ok(!src.includes("toggle(") && !src.includes("pricing.summary."), "bez výberu modulov a kalkulačky");
  assert.ok((src.match(/pricing\.modules\.comingSoon/g) ?? []).length >= 4, "odznak pri moduloch, kartách, rozšíreniach, ďalšej firme");
  assert.match(src, /billingUi \? t\("pricing\.liveNotice"\) : t\("pricing\.betaNotice"\)/);
});

await check("texty SK/EN/DE: objednávka, chybové kódy, Cenník", () => {
  for (const d of [sk, en, de]) {
    const x = d as unknown as {
      subscription: { order: Record<string, string>; errors: Record<string, string> };
      pricing: Record<string, unknown> & { modules: Record<string, string>; faq: Record<string, string> };
    };
    for (const k of ["price", "renewal", "firstCharge", "cancel", "consent", "termsLink", "termsRequired"]) assert.ok(x.subscription.order[k]?.length > 10, k);
    assert.match(x.subscription.order.consent, /\{\{version\}\}/);
    assert.match(x.subscription.order.price, /\{\{price\}\}/);
    for (const k of ["planNotPurchasable", "orderConsentRequired", "termsRequired"]) assert.ok(x.subscription.errors[k]?.length > 10, k);
    assert.ok(typeof x.pricing.liveNotice === "string" && x.pricing.modules.notYet.length > 10);
    assert.doesNotMatch(x.pricing.intro as string, /iba moduly|only the modules|nur die Module/);
  }
});

console.log(`\nbilling-order-gate: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
