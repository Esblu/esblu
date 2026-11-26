// Testovacia stránka /nastavenia/predplatne/fake-checkout je dostupná iba v režime ESBLU_BILLING_MODE=fake
// (nikdy v produkcii) — server vracia 404 cez notFound().
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBillingServerMode } from "../lib/billing/config.ts";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error).message}`); }
}
const page = readFileSync("app/nastavenia/predplatne/fake-checkout/page.tsx", "utf8");
const client = readFileSync("app/nastavenia/predplatne/fake-checkout/FakeCheckoutClient.tsx", "utf8");

check("produkcia: fake režim nikdy (aj s ESBLU_BILLING_MODE=fake) → stránka 404", () => {
  assert.equal(getBillingServerMode({ VERCEL_ENV: "production", ESBLU_BILLING_MODE: "fake" }), "off");
  assert.equal(getBillingServerMode({ VERCEL_ENV: "production" }), "off");
});
check("preview bez fake režimu → off; s fake → fake", () => {
  assert.equal(getBillingServerMode({ VERCEL_ENV: "preview" }), "off");
  assert.equal(getBillingServerMode({ VERCEL_ENV: "preview", ESBLU_BILLING_MODE: "stripe_test" }), "stripe_test");
  assert.equal(getBillingServerMode({ VERCEL_ENV: "preview", ESBLU_BILLING_MODE: "fake" }), "fake");
});
check("page.tsx: serverová komponenta, dynamická, notFound mimo fake režimu", () => {
  assert.doesNotMatch(page, /^\s*["']use client["']/m);
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /if \(getBillingServerMode\(\) !== "fake"\) notFound\(\);/);
  assert.match(page, /import \{ notFound \} from "next\/navigation"/);
});
check("klientská časť nie je samostatná trasa (žiadny default export)", () => {
  assert.match(client, /^"use client";/);
  assert.doesNotMatch(client, /export default/);
  assert.match(client, /export function FakeCheckoutClient\(\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
