// =============================================================================
// E-Faktúra — PRODUCTION GATE (readiness 2026-11-12). Bez siete, bez DB, bez kľúčov.
//
//  - feature flag default OFF: bez env / s neúplným live env → provider null
//  - žiadny produkčný (live) kľúč ani .env súbor v repozitári
//  - cron / webhook bez konfigurácie nič nevolajú
//  - recipient → company: inbound vrstva nikdy nepoužije „aktívnu firmu"
//  - RECIPIENT_MISMATCH sa neponúka na reprocess (vyžaduje operátora)
//  - dokument brány obsahuje všetky povinné podmienky G1–G12
//
// Spustenie: npm run test:einvoice-production-gate
// =============================================================================
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEfakturaWebhookSecrets, getEinvoiceProvider } from "../lib/einvoice/provider/index.ts";
import { inboundAllowedActions } from "../lib/einvoice/ops/allowed-actions.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

let passed = 0;
const failures: string[] = [];
async function check(label: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`  ✗ ${label}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

const FAKE_LIVE = "efk_pk_live_" + "0".repeat(24);
const FAKE_TEST = "efk_pk_test_" + "0".repeat(24);

await check("flag OFF: prázdne env (= dnešná Vercel production) → provider null, webhook bez tajomstva", () => {
  assert.equal(getEinvoiceProvider({}), null);
  assert.equal(getEinvoiceProvider({ VERCEL_ENV: "production" }), null);
  assert.deepEqual(getEfakturaWebhookSecrets({ VERCEL_ENV: "production" }), []);
});

await check("flag OFF: live bez KAŽDEJ zo štyroch podmienok → null (žiadna aktivácia omylom)", () => {
  const full = {
    ESBLU_EINVOICE_PROVIDER: "efaktura_sk",
    ESBLU_EINVOICE_ENVIRONMENT: "live",
    ESBLU_EFAKTURA_API_KEY: FAKE_LIVE,
    ESBLU_EINVOICE_LIVE_ENABLED: "true",
    VERCEL_ENV: "production",
  };
  for (const drop of ["ESBLU_EINVOICE_PROVIDER", "ESBLU_EINVOICE_ENVIRONMENT", "ESBLU_EFAKTURA_API_KEY", "ESBLU_EINVOICE_LIVE_ENABLED", "VERCEL_ENV"] as const) {
    const env: Record<string, string | undefined> = { ...full };
    delete env[drop];
    assert.equal(getEinvoiceProvider(env), null, `bez ${drop}`);
  }
  for (const v of ["1", "yes", "TRUE", "on", "false"]) assert.equal(getEinvoiceProvider({ ...full, ESBLU_EINVOICE_LIVE_ENABLED: v }), null, `LIVE_ENABLED=${v}`);
  assert.equal(getEinvoiceProvider({ ...full, VERCEL_ENV: "preview" }), null);
  assert.equal(getEinvoiceProvider({ ...full, ESBLU_EINVOICE_ENVIRONMENT: "production" }), null, "neznáme prostredie");
  // test kľúč nikdy neodosiela do live siete; live kľúč nikdy v sandbox
  assert.throws(() => getEinvoiceProvider({ ...full, ESBLU_EFAKTURA_API_KEY: FAKE_TEST }));
  assert.throws(() => getEinvoiceProvider({ ESBLU_EINVOICE_PROVIDER: "efaktura_sk", ESBLU_EINVOICE_ENVIRONMENT: "sandbox", ESBLU_EFAKTURA_API_KEY: FAKE_LIVE }));
  // base URL mimo allowlistu → chyba (žiadne presmerovanie kľúča inam)
  assert.throws(() =>
    getEinvoiceProvider({ ESBLU_EINVOICE_PROVIDER: "efaktura_sk", ESBLU_EINVOICE_ENVIRONMENT: "sandbox", ESBLU_EFAKTURA_API_KEY: FAKE_TEST, ESBLU_EFAKTURA_BASE_URL: "https://evil.example" })
  );
});

await check("žiadny produkčný kľúč ani .env v repozitári (git ls-files)", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const envFiles = files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !/\.example$|template/.test(f));
  assert.deepEqual(envFiles, [], "trackovaný .env súbor");
  const offenders: string[] = [];
  for (const f of files) {
    if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|otf|mp3|mp4|keystore|jar)$/i.test(f)) continue;
    let text: string;
    try {
      text = read(f);
    } catch {
      continue;
    }
    for (const m of text.matchAll(/efk_pk_(live|test)_([A-Za-z0-9]{12,})/g)) {
      if (/^0+$/.test(m[2]) || /^[x.…]+$/i.test(m[2]) || /CANARY/.test(m[2])) continue; // zjavne syntetické / canary
      offenders.push(`${f}: efk_pk_${m[1]}_${m[2].slice(0, 2)}…`);
    }
    if (/whsec_[A-Za-z0-9]{24,}/.test(text) && !/scripts\/|docs\//.test(f)) offenders.push(`${f}: whsec_…`);
  }
  assert.deepEqual(offenders, []);
});

await check("cron + webhook routes: bez providera / tajomstva nič nevolajú (configured:false / 503)", () => {
  for (const r of ["einvoice-inbound", "einvoice-outbound", "einvoice-events", "einvoice-maintenance"]) {
    const src = read(`app/api/cron/${r}/route.ts`);
    assert.match(src, /CRON_SECRET/, `${r}: CRON_SECRET`);
    if (r !== "einvoice-maintenance") assert.match(src, /if \(!runtimeConfig( \|\||\))/, `${r}: fail closed bez providera`);
  }
  const wh = read("app/api/einvoice/webhook/route.ts");
  assert.match(wh, /if \(!runtimeConfig \|\| secrets\.length === 0\) return json\(503/);
});

await check("recipient → company: inbound/webhook vrstva nikdy nepoužije aktívnu firmu ani company_id z tela", () => {
  const files = [
    "lib/einvoice/inbound/webhook.ts",
    "lib/einvoice/inbound/processor.ts",
    "lib/einvoice/inbound/supabase-store.ts",
    "lib/einvoice/inbound/feed.ts",
    "app/api/einvoice/webhook/route.ts",
  ];
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /esblu_my_active_company_id|activeCompany|set_my_active_company/, f);
    if (/webhook/.test(f)) assert.doesNotMatch(src, /payload\.company_id|data\?\.company_id/, `${f}: company_id z tela`);
  }
  const proc = read("lib/einvoice/inbound/processor.ts");
  assert.equal((proc.match(/verifyInboundRecipient\(/g) ?? []).length, 2, "kontrola príjemcu pred parse→parsed aj pred konceptom");
  // DB: firma iba z unikátneho mapovania (provider, environment, provider_org_id); neznáma org = výnimka
  const sql = read("supabase/migrations/20261002130000_einvoice_inbound_flow.sql");
  assert.match(sql, /if v_company is null then\s+raise exception using errcode = 'P0001', message = 'ESBLU_EINVOICE_UNKNOWN_ORG'/);
  assert.match(read("supabase/migrations/20261002100000_einvoice_foundation.sql"), /einvoice_organizations_provider_org_key unique \(provider, environment, provider_org_id\)/);
});

await check("RECIPIENT_MISMATCH / UNSUPPORTED_PROFILE: reprocess sa neponúka (vyžaduje operátora), iné zlyhanie áno", () => {
  const access = { financeManage: true, entitlementActive: true, providerConfigured: true, rolloutEnabled: true };
  assert.equal(inboundAllowedActions({ access, status: "failed", invoiceId: null, hasXml: true, lastErrorCode: "RECIPIENT_MISMATCH" }).reprocess, false);
  assert.equal(inboundAllowedActions({ access, status: "failed", invoiceId: null, hasXml: true, lastErrorCode: "UNSUPPORTED_PROFILE" }).reprocess, false);
  assert.equal(inboundAllowedActions({ access, status: "failed", invoiceId: null, hasXml: true, lastErrorCode: "DRAFT_CREATE_FAILED" }).reprocess, true);
  // bez finance.manage nič
  assert.deepEqual(inboundAllowedActions({ access: { ...access, financeManage: false }, status: "received", invoiceId: null, hasXml: false, lastErrorCode: null }), { reprocess: false, ackRetry: false });
});

await check("i18n: RECIPIENT_MISMATCH má text v sk/en/de (UI nikdy neukáže surový kód)", () => {
  for (const l of ["sk", "en", "de"]) assert.match(read(`lib/i18n/dictionaries/${l}.ts`), /RECIPIENT_MISMATCH: "/, l);
});

await check("dokument brány: G1–G12 vrátane explicitného schválenia majiteľa, default OFF", () => {
  const doc = read("docs/einvoice-production-gate-2026-11-12.md");
  for (const g of ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12"]) assert.match(doc, new RegExp(`\\| ${g} \\|`), g);
  for (const kw of ["Production partner contract", "Production API key", "DPA/GDPR review", "Subprocessor notice", "Webhook security", "A/B sandbox tests",
    "Dedupe/idempotency", "Recipient→company isolation", "Role tests", "Accounting review", "Billing/entitlement decision", "Explicitné schválenie majiteľa"]) {
    assert.ok(doc.includes(kw), kw);
  }
  assert.match(doc, /ZATVORENÉ \(OFF\)/);
});

console.log(`\neinvoice-production-gate: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
