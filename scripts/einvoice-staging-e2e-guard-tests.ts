// E-Faktúra — testy hard guardu staging E2E drivera (offline, bez siete).
// npm run test:einvoice-staging-guard
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRODUCTION_SUPABASE_REF,
  STAGING_E2E_COMPANIES,
  STAGING_SUPABASE_REF,
  parseTarget,
  stagingE2eGuard,
  targetForCompany,
} from "../lib/einvoice/staging-e2e/guard.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (ref: string, role: string) => `eyJhbGciOiJIUzI1NiJ9.${b64({ ref, role })}.sig`;
const OK: Record<string, string> = {
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "einvoice-port",
  ESBLU_STAGING_E2E_ENABLED: "true",
  ESBLU_STAGING_E2E_SECRET: "x".repeat(48),
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_SUPABASE_REF}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt(STAGING_SUPABASE_REF, "anon"),
  SUPABASE_SERVICE_ROLE_KEY: jwt(STAGING_SUPABASE_REF, "service_role"),
  ESBLU_EINVOICE_PROVIDER: "efaktura_sk",
  ESBLU_EINVOICE_ENVIRONMENT: "sandbox",
  ESBLU_EFAKTURA_API_KEY: "efk_pk_test_" + "0".repeat(24),
};
const reason = (patch: Record<string, string | undefined>) => {
  const r = stagingE2eGuard({ ...OK, ...patch });
  return r.ok ? "OK" : r.reason;
};

test("plná staging konfigurácia → povolené", () => assert.equal(reason({}), "OK"));
test("production / development VERCEL_ENV → zakázané", () => {
  assert.equal(reason({ VERCEL_ENV: "production" }), "NOT_PREVIEW");
  assert.equal(reason({ VERCEL_ENV: undefined }), "NOT_PREVIEW");
});
test("iná vetva (main, iný preview) → zakázané", () => {
  assert.equal(reason({ VERCEL_GIT_COMMIT_REF: "main" }), "WRONG_BRANCH");
  assert.equal(reason({ VERCEL_GIT_COMMIT_REF: "feature-x" }), "WRONG_BRANCH");
});
test("vypnutý prepínač alebo krátke tajomstvo → zakázané", () => {
  assert.equal(reason({ ESBLU_STAGING_E2E_ENABLED: "1" }), "DISABLED");
  assert.equal(reason({ ESBLU_STAGING_E2E_SECRET: "short" }), "SECRET_MISSING");
});
test("produkčná DB (URL, kľúč alebo ref kdekoľvek v env) → zakázané", () => {
  assert.equal(reason({ NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_SUPABASE_REF}.supabase.co` }), "NOT_STAGING_DB");
  assert.equal(reason({ SUPABASE_SERVICE_ROLE_KEY: jwt(PRODUCTION_SUPABASE_REF, "service_role") }), "SERVICE_KEY_NOT_STAGING");
  assert.equal(reason({ NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt(PRODUCTION_SUPABASE_REF, "anon") }), "ANON_KEY_NOT_STAGING");
  assert.match(reason({ SOME_OTHER: `postgres://x@db.${PRODUCTION_SUPABASE_REF}.supabase.co` }), /^PRODUCTION_REF_IN_/);
  assert.equal(reason({ SUPABASE_SERVICE_ROLE_KEY: "" }), "SERVICE_KEY_MISSING");
});
test("live eFaktúra (prostredie, kľúč, live flag, iný host) → zakázané", () => {
  assert.equal(reason({ ESBLU_EINVOICE_ENVIRONMENT: "live" }), "NOT_SANDBOX");
  assert.equal(reason({ ESBLU_EFAKTURA_API_KEY: "efk_pk_live_" + "0".repeat(24) }), "NOT_TEST_KEY");
  assert.equal(reason({ ESBLU_EINVOICE_LIVE_ENABLED: "true" }), "LIVE_FLAG_SET");
  assert.equal(reason({ ESBLU_EFAKTURA_BASE_URL: "https://evil.example.com" }), "BASE_URL");
});
test("uzavretý zoznam cieľov A–D", () => {
  assert.equal(parseTarget("A"), "A");
  assert.equal(parseTarget("E"), null);
  assert.equal(parseTarget({}), null);
  assert.equal(targetForCompany(STAGING_E2E_COMPANIES.D), "D");
  assert.equal(targetForCompany("a1300000-0000-4000-8000-00000000000a"), null);
});
test("route: guard + autorizácia pred akoukoľvek prácou, 404 pri zamietnutí, žiadne logovanie", () => {
  const src = readFileSync(new URL("../app/api/einvoice/staging-e2e/route.ts", import.meta.url), "utf8");
  assert.match(src, /^import "server-only";/);
  const post = src.slice(src.indexOf("export async function POST"));
  assert.ok(post.indexOf("stagingE2eGuard(process.env)") < post.indexOf("req.json()"), "guard pred čítaním tela");
  assert.ok(post.indexOf("authorized(req)") < post.indexOf("req.json()"), "auth pred čítaním tela");
  assert.doesNotMatch(src, /console\./);
  assert.doesNotMatch(src, /access_token\b[^;]*json\(/, "token sa nevracia");
});

console.log(`\neinvoice-staging-guard: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
