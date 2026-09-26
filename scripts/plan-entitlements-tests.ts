// =============================================================================
// Nároky (14-dňový trial + modulárne platené moduly) — aplikačná vrstva.
//
// SPUSTENIE
//   npm run test:plan-entitlements
//
// ČO SA TU CHRÁNI
//   1. Štruktúrované odmietnutia (ENTITLEMENT_DENIED:<REASON>:<key>) a
//      fail-closed čítanie stavu nárokov.
//   2. Asistent + hlas: modul intentu musí byť aktívny; hlas nič neodomkne;
//      rola má prednosť a nárok ju nerozširuje; každý intent je buď
//      priradený modulu, alebo výslovne jadro.
//   3. Hlas je platený: server (transcribe) overí nárok pred audiom aj pred
//      OpenAI; mikrofón v UI sa bez nároku neponúkne (iba UX).
//   4. AI spracovanie: každý AI dokumentový endpoint rezervuje kvótu PRED
//      volaním modelu (žiadny endpoint bez brány).
//   5. Cenník: centrálna konfigurácia, súčet v centoch, limity trialu = DB.
//   6. Migrácia: aditívna, RLS na nových tabuľkách, bez anon grantov.
//
// DB stranu (trial dni 1/13/hranica/15, reset, limity, AI ledger, pozvánky,
// voice × modul × rola, self-grant, cross-company) testuje
// scripts/sql/plan-entitlements-matrix.sql; súbežnosť
// scripts/sql/entitlements-concurrency-local.sh.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "cd".repeat(32);
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { makeDb, type Role } from "./support/memory-db.ts";

const E = await import("@/lib/entitlements");
const { runAssistantTurnDetailed } = await import("@/lib/intents/orchestrator");
const { executeOperationalAction } = await import("@/lib/intents/operational-intents");
const { INTENT_NAMES } = await import("@/lib/intents/types");
const { isRegisteredReadOnlyIntent } = await import("@/lib/intents/registry");
const { translate, hasTranslation } = await import("@/lib/i18n/translate");
const P = await import("@/lib/pricing");
const { getPlanLimitResourceFromError, isPlanLimitReachedError, canCreateUnderLimit } = await import("@/lib/plan-limits");

type IntentName = import("@/lib/intents/types").IntentName;
type CompanyEntitlements = import("@/lib/entitlements").CompanyEntitlements;
type EntitlementKey = import("@/lib/entitlements").EntitlementKey;

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${label}`);
    console.error(error);
  }
}

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const SOURCES = ["app", "lib", "hooks"].flatMap((d) => walk(path.join(ROOT, d)));
const MIGRATION = read("supabase/migrations/20260928100000_company_entitlements_trial.sql");
const MIGRATION_CODE = MIGRATION.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

// Syntetický snapshot tak, ako ho vracia esblu_get_my_company_entitlements().
function snapshot(active: Partial<Record<EntitlementKey, { source?: string; limit?: number | null }>>, trialActive = false): CompanyEntitlements {
  const raw = {
    company_id: "00000000-0000-0000-0000-00000000000a",
    trial: { started_at: "2026-09-01T00:00:00Z", ends_at: "2026-09-15T00:00:00Z", active: trialActive, ai_processing_used: 0 },
    entitlements: E.ENTITLEMENT_KEYS.map((key) =>
      active[key]
        ? { key, active: true, source: active[key]!.source ?? "subscription", limit: active[key]!.limit ?? null }
        : { key, active: false, reason: key === "voice" ? "VOICE_ENTITLEMENT_REQUIRED" : trialActive ? "ENTITLEMENT_REQUIRED" : "TRIAL_EXPIRED" }
    ),
  };
  const parsed = E.parseCompanyEntitlements(raw);
  assert.ok(parsed);
  return parsed;
}

const ACCESS: Record<Role, { financeView: boolean; financeManage: boolean; canOperate: boolean }> = {
  owner: { financeView: true, financeManage: true, canOperate: true },
  admin: { financeView: false, financeManage: false, canOperate: true },
  accountant: { financeView: true, financeManage: true, canOperate: false },
  employee: { financeView: false, financeManage: false, canOperate: true },
};

async function turn(role: Role, text: string, ents: CompanyEntitlements | null, conversationId: string | null = null) {
  const env = makeDb({ role, financeManage: ACCESS[role].financeManage });
  const gate = (intent: IntentName) => {
    const denial = E.assistantEntitlementDenial(ents, intent, isRegisteredReadOnlyIntent);
    return denial ? translate("sk", E.entitlementMessageKey(denial.reason), { module: translate("sk", E.entitlementModuleKey(denial.key)) }) : null;
  };
  let aiCalls = 0;
  const { output, finalIntent } = await runAssistantTurnDetailed(
    { db: env.db, classifyWithAi: async () => { aiCalls++; return null; } },
    {
      rawText: text, locale: "sk", userId: env.userId, companyId: env.companyId, role, ...ACCESS[role],
      conversationId, pendingClarification: null, structuredPartnerId: null, issueDate: "2026-09-26",
      uiContext: null, selection: null, folderContextId: null, entitlementGate: gate,
    }
  );
  const text2 = ((output.result as { text?: string }).text ?? "").replace(/ /g, " ");
  return { output, intent: finalIntent?.name ?? null, text: text2, queries: env.state.queries, aiCalls };
}

const inventoryDenied = translate("sk", "entitlements.reasons.TRIAL_EXPIRED", { module: translate("sk", "entitlements.modules.inventory") });

// ============================================================ 1. structured / fail closed
await check("denial parser: valid structured DB error", () => {
  assert.deepEqual(E.parseEntitlementDenial({ message: "ENTITLEMENT_DENIED:VEHICLE_LIMIT_REACHED:vehicles" }), {
    code: "ENTITLEMENT_DENIED", reason: "VEHICLE_LIMIT_REACHED", key: "vehicles",
  });
  assert.equal(E.parseEntitlementDenial({ message: "ENTITLEMENT_DENIED:MADE_UP:vehicles" }), null);
  assert.equal(E.parseEntitlementDenial({ message: "ENTITLEMENT_DENIED:TRIAL_EXPIRED:unknown_module" }), null);
  assert.equal(E.parseEntitlementDenial("Dosiahli ste limit"), null, "human text is never parsed");
});

await check("entitlement snapshot: malformed state fails closed", () => {
  assert.equal(E.parseCompanyEntitlements(null), null);
  assert.equal(E.parseCompanyEntitlements({ company_id: "x" }), null);
  assert.equal(E.parseCompanyEntitlements({ company_id: "x", trial: {}, entitlements: [] }), null);
  const partial = E.parseCompanyEntitlements({
    company_id: "x",
    trial: { started_at: "a", ends_at: "b", active: true },
    entitlements: [{ key: "vehicles", active: true, source: "trial", limit: -3 }, { key: "bogus", active: true }],
  });
  assert.ok(partial);
  assert.equal(partial.items.vehicles.active, false, "invalid limit => inactive, never unlimited");
  assert.equal(partial.items.voice.active, false, "missing key => inactive");
  assert.equal(E.hasEntitlement(null, "invoicing"), false);
});

await check("effective limit: null = unlimited, undefined = no entitlement", () => {
  const s = snapshot({ vehicles: { source: "trial", limit: 2 }, inventory: { limit: null } }, true);
  assert.equal(E.getEffectiveLimit(s, "vehicles"), 2);
  assert.equal(E.getEffectiveLimit(s, "inventory"), null);
  assert.equal(E.getEffectiveLimit(s, "voice"), undefined);
  assert.equal(canCreateUnderLimit(1, 2), true);
  assert.equal(canCreateUnderLimit(2, 2), false);
  assert.equal(canCreateUnderLimit(99, null), true);
});

await check("UI pages recognise new structured errors (legacy PLAN_LIMIT_REACHED still parsed)", () => {
  assert.equal(getPlanLimitResourceFromError({ message: "ENTITLEMENT_DENIED:INVENTORY_LIMIT_REACHED:inventory" }), "inventory_items");
  assert.equal(getPlanLimitResourceFromError({ message: "ENTITLEMENT_DENIED:TRIAL_EXPIRED:vehicles" }), "vehicles");
  assert.equal(getPlanLimitResourceFromError({ message: "ENTITLEMENT_DENIED:AI_PROCESSING_LIMIT_REACHED:ai_documents" }), "ai_evidence");
  assert.equal(isPlanLimitReachedError({ message: "PLAN_LIMIT_REACHED:machines" }, "machines"), true);
});

// ============================================================ 2. assistant × module × role
const CORE_INTENTS: IntentName[] = [
  "SEARCH_DOCUMENTS", "EXPORT_DOCUMENTS", "UPCOMING_DEADLINES", "CREATE_DOCUMENT_CATEGORY", "RENAME_DOCUMENT_CATEGORY",
  "ASSIGN_DOCUMENTS_TO_CATEGORY", "OPEN_MODULE", "SEARCH_PARTNER", "DELETE_DOCUMENT_CATEGORY", "MOVE_DOCUMENTS_TO_CATEGORY",
  "OPEN_DOCUMENT_FOLDER", "FOLDER_CREATE", "FOLDER_OPEN", "FOLDER_ADD_ITEMS", "FOLDER_REMOVE_ITEMS", "FOLDER_LIST_ITEMS",
  "FOLDER_EXPORT", "DOCUMENTS_EXPORT", "DOCUMENTS_LIST_UNDOWNLOADED", "DOCUMENTS_DOWNLOAD_STATUS", "FOLDER_DELETE",
  "DOCUMENT_INTAKE", "ENTITY_CREATE", "INBOX_LIST_UNASSIGNED", "INBOX_DELETE_UNASSIGNED", "PARTNER_CREATE", "FOLDER_RENAME",
];

await check("every intent is either bound to a module or explicitly core (no silent bypass for new intents)", () => {
  const unclassified = INTENT_NAMES.filter((name) => E.entitlementForIntent(name) === null && !CORE_INTENTS.includes(name));
  assert.deepEqual(unclassified, []);
  for (const core of CORE_INTENTS) assert.equal(E.entitlementForIntent(core), null, core);
});

const gate = (snap: CompanyEntitlements | null, intent: IntentName) => E.assistantEntitlementDenial(snap, intent, isRegisteredReadOnlyIntent);

await check("gate: voice + Fakturácia but no inventory → inventory WRITES denied, invoicing allowed", () => {
  const s = snapshot({ voice: {}, invoicing: {} });
  assert.equal(gate(s, "INVENTORY_ITEM_CREATE")?.reason, "TRIAL_EXPIRED");
  assert.equal(gate(s, "INVENTORY_QUANTITY_ADJUST")?.key, "inventory");
  assert.equal(gate(s, "CREATE_INVOICE_DRAFT"), null);
  assert.equal(gate(s, "SEARCH_DOCUMENTS"), null, "core stays available");
});

await check("gate: expired module still allows READ intents over existing data (same as manual UI)", () => {
  const expired = snapshot({});
  for (const read of ["SEARCH_INVOICE", "SHOW_UNPAID_INVOICES", "SEARCH_INVENTORY_ITEM", "INVENTORY_ITEM_STATUS", "VEHICLE_REPORT", "OPEN_MACHINE"] as IntentName[]) {
    assert.equal(isRegisteredReadOnlyIntent(read), true, `${read} is read-only in registry`);
    assert.equal(gate(expired, read), null, read);
  }
  // PROCESS_CURRENT_DOCUMENT_AS_RECEIVED_INVOICE je v registri readOnly (iba
  // otvorí kontrolu); samotný draft vzniká cez esblu_create_received_invoice_draft
  // → INSERT do invoices → DB trigger nároku (matica SQL) ho zablokuje.
  for (const write of ["CREATE_INVOICE_DRAFT", "VEHICLE_CREATE", "MACHINE_CREATE", "INVENTORY_ITEM_CREATE"] as IntentName[]) {
    assert.equal(isRegisteredReadOnlyIntent(write), false, write);
    assert.ok(gate(expired, write), write);
  }
});

await check("gate: every module-bound write intent is gated; every module-bound read is not", () => {
  const expired = snapshot({});
  for (const name of INTENT_NAMES) {
    if (!E.entitlementForIntent(name)) continue;
    assert.equal(Boolean(gate(expired, name)), !isRegisteredReadOnlyIntent(name), name);
  }
});

await check("gate: unreadable entitlements → module writes denied, reads and core allowed (fail closed for writes)", () => {
  assert.ok(gate(null, "VEHICLE_CREATE"));
  assert.equal(gate(null, "SEARCH_VEHICLE"), null);
  assert.equal(gate(null, "FOLDER_LIST_ITEMS"), null);
});

await check("orchestrator: owner says inventory WRITE without inventory module → denied before any data query", async () => {
  const r = await turn("owner", "Pridaj do skladu cement", snapshot({ voice: {}, invoicing: {} }), "fedcba9876543210fedcba9876543210");
  assert.equal(r.output.result.kind, "error");
  assert.equal(r.text, inventoryDenied);
});

await check("orchestrator: expired inventory module — owner READ ('Ukáž sklad') behaves like manual UI (no entitlement error)", async () => {
  const r = await turn("owner", "Ukáž sklad.", snapshot({}));
  assert.notEqual(r.text, inventoryDenied);
  assert.doesNotMatch(r.text, /skúšobná verzia skončila|nie je pre vašu firmu aktivovaný/);
});

await check("orchestrator: expired Fakturácia — owner reads unpaid invoices; employee still denied by finance role", async () => {
  const owner = await turn("owner", "Ukáž nezaplatené faktúry", snapshot({}));
  assert.doesNotMatch(owner.text, /skúšobná verzia skončila|nie je pre vašu firmu aktivovaný/);
  const employee = await turn("employee", "Ukáž nezaplatené faktúry", snapshot({}));
  assert.equal(employee.output.result.kind, "error");
  const admin = await turn("admin", "Ukáž nezaplatené faktúry", snapshot({}));
  assert.equal(admin.output.result.kind, "error", "admin without finance permission stays denied");
});

await check("orchestrator: same owner WITH inventory module reaches the normal flow (no entitlement error)", async () => {
  const r = await turn("owner", "Ukáž sklad.", snapshot({ inventory: {} }));
  assert.notEqual(r.text, inventoryDenied);
});

await check("orchestrator: role denial wins over entitlement (employee stays restricted even with all modules)", async () => {
  const all = snapshot(Object.fromEntries(E.ENTITLEMENT_KEYS.map((k) => [k, {}])) as never);
  const r = await turn("employee", "Ukáž nezaplatené faktúry", all);
  assert.equal(r.output.result.kind, "error");
  assert.doesNotMatch(r.text, /skúšobná verzia|nie je pre vašu firmu aktivovaný/);
});

await check("orchestrator: accountant with all modules still cannot use operational inventory write", async () => {
  const all = snapshot(Object.fromEntries(E.ENTITLEMENT_KEYS.map((k) => [k, {}])) as never);
  const r = await turn("accountant", "Pridaj do skladu cement", all);
  assert.notEqual(r.output.result.kind, "action_preview");
});

await check("orchestrator: active invoice dialog stops when invoicing entitlement disappears", async () => {
  const src = read("lib/intents/orchestrator.ts");
  assert.match(src, /flowCtx && financeManage && !input\.entitlementGate\?\.\("CREATE_INVOICE_DRAFT"\)/);
});

for (const [intent, key, args, reason] of [
  ["VEHICLE_CREATE", "vehicles", { spz: "BA123AB" }, "VEHICLE_LIMIT_REACHED"],
  ["MACHINE_CREATE", "machines", { name: "Bager" }, "MACHINE_LIMIT_REACHED"],
  ["INVENTORY_ITEM_CREATE", "inventory", { name: "Cement" }, "TRIAL_EXPIRED"],
] as const) {
  await check(`assistant ${intent}: DB denial ${reason} → localized structured answer`, async () => {
    const db = { from: () => ({ insert: async () => ({ error: { code: "P0001", message: `ENTITLEMENT_DENIED:${reason}:${key}` } }) }) };
    const result = await executeOperationalAction(db as never, "sk", { companyId: "c", userId: "u" }, intent, { ...args });
    const expected = translate("sk", `entitlements.reasons.${reason}`, { module: translate("sk", `entitlements.modules.${key}`) });
    assert.equal(JSON.stringify(result).includes(expected), true, JSON.stringify(result));
  });
}

// ============================================================ 3. voice paid-only
await check("transcribe route: voice entitlement checked server-side BEFORE reading audio and BEFORE OpenAI", () => {
  const src = read("app/api/assistant/transcribe/route.ts");
  const gate = src.indexOf("requireVoiceEntitlement(req)");
  assert.ok(gate > 0, "gate present");
  assert.ok(gate < src.indexOf("await req.formData()"), "gate before audio");
  assert.ok(gate < src.indexOf("client.audio.transcriptions.create"), "gate before OpenAI");
  assert.ok(gate > src.indexOf("verifyRequestUser(req, locale)"), "after authentication");
});

await check("transcribe route never trusts a client voice flag", () => {
  const src = read("app/api/assistant/transcribe/route.ts");
  assert.equal(/formData\?\.get\("(voice|plan|entitled|entitlement)"\)/.test(src), false);
});

await check("intent route: entitlement gate derived server-side and passed to orchestrator", () => {
  const src = read("app/api/assistant/intent/route.ts");
  assert.match(src, /getCompanyEntitlements\(supabase\)/);
  assert.match(src, /entitlementGate,\n/);
  assert.equal(/body\?\.(entitlements|plan|voice)/.test(src), false, "nothing from request body");
});

await check("UI: microphone control hidden without voice entitlement (UX only, not security)", () => {
  const src = read("app/components/voice/VoiceSessionControl.tsx");
  assert.match(src, /if \(!active && !entitlements\.has\("voice"\)\) return null;/);
});

// ============================================================ 4. AI processing gates
await check("every AI document endpoint reserves AI processing before the first model call", () => {
  for (const file of ["app/api/scan-document/route.ts", "app/api/scan-vehicle-registration/route.ts", "app/api/scan-vehicle-doc/route.ts"]) {
    const src = read(file);
    const reserve = Math.max(src.indexOf("reserveAiProcessing("), src.indexOf("guardAiProcessing("));
    const firstAi = src.indexOf("client.responses.create(", src.indexOf("export async function POST"));
    assert.ok(reserve > 0 && firstAi > 0 && reserve < firstAi, `${file}: reserve ${reserve} < ai ${firstAi}`);
    assert.match(src, /finalizeAiProcessing\([^)]*false\)/, `${file}: AI failure not charged`);
    assert.match(src, /finalizeAiProcessing\([^)]*true\)/, `${file}: success finalized`);
  }
});

await check("no other server file calls the OpenAI document/vision API without the gate", () => {
  const offenders = SOURCES.filter((f) => {
    const src = readFileSync(f, "utf8");
    return /input_image/.test(src) && /responses\.create/.test(src) && !/(reserveAiProcessing|guardAiProcessing)\(/.test(src);
  }).map((f) => path.relative(ROOT, f));
  assert.deepEqual(offenders, []);
});

await check("AI reservation keyed by client Idempotency-Key + server-computed content hash", () => {
  const src = read("lib/entitlements-server.ts");
  assert.match(src, /headers\.get\("idempotency-key"\)/);
  assert.match(src, /crypto\.subtle\.digest\("SHA-256"/);
});

// ============================================================ 5. pricing
await check("pricing: modules additive; eFaktura + Voice = 12.80 € excl. VAT; no double counting", () => {
  assert.equal(P.monthlyTotalExclVat(["invoicing", "voice"]), 12.8);
  assert.equal(P.monthlyTotalExclVat(["invoicing", "invoicing"]), 5.9);
  assert.equal(P.monthlyTotalExclVat([]), 0);
  assert.equal(P.monthlyTotalExclVat(P.PRICING_MODULES.map((m) => m.id)), 5.9 * 4 + 9.9 + 6.9);
});

await check("pricing: customer-facing module name is Fakturácia (not eFaktúra) in sk; en/de equivalents", () => {
  assert.equal(translate("sk", "pricing.modules.items.invoicing.name"), "Fakturácia");
  assert.equal(translate("sk", "entitlements.modules.invoicing"), "Fakturácia");
  assert.equal(translate("en", "pricing.modules.items.invoicing.name"), "Invoicing");
  assert.equal(translate("de", "pricing.modules.items.invoicing.name"), "Rechnungsstellung");
  for (const locale of ["sk", "en", "de"] as const) {
    for (const key of ["pricing.metaDescription", "pricing.modules.example", "pricing.faq.q3", "pricing.faq.a3", "pricing.modules.items.invoicing.name", "entitlements.modules.invoicing"]) {
      assert.doesNotMatch(translate(locale, key), /eFakt|eInvoic|E-Rechnung/, `${locale}:${key}`);
    }
  }
  assert.doesNotMatch(read("app/cennik/page.tsx"), /eFakt/);
});

await check("pricing: AI paid allowance on the site = central provisional 50; trial AI stays 5", () => {
  assert.equal(P.AI_DOCUMENTS_MONTHLY_ALLOWANCE, 50);
  assert.equal(P.PRICING_MODULES.find((m) => m.id === "ai_documents")?.includedMonthlyUsage, P.AI_DOCUMENTS_MONTHLY_ALLOWANCE);
  assert.equal(P.TRIAL_OFFER.limits.aiProcessings, 5);
  assert.match(read("app/cennik/PricingPageClient.tsx"), /module\.includedMonthlyUsage/);
});

await check("pricing: trial includes Fakturácia; wording 'Vyberiete si iba moduly, ktoré používate.'; no checkout", () => {
  assert.equal(P.TRIAL_OFFER.includesInvoicing, true);
  assert.match(translate("sk", "pricing.trial.after"), /Vyberiete si iba moduly, ktoré používate\./);
  assert.equal(translate("sk", "pricing.trial.title", { days: 14 }), "14 dní zadarmo");
});

await check("voice stays paid-only: not in trial (config + DB catalog)", () => {
  assert.equal(P.TRIAL_OFFER.includesVoice, false);
  assert.match(MIGRATION_CODE, /\('voice',\s*'capability',\s*false,/);
});

await check("entitlement snapshot: pre-entitlement company (null trial, beta_compat grants) parses", () => {
  const parsed = E.parseCompanyEntitlements({
    company_id: "x",
    trial: { started_at: null, ends_at: null, active: false, ai_processing_used: 0 },
    entitlements: [{ key: "invoicing", active: true, source: "beta_compat", limit: null }],
  });
  assert.ok(parsed);
  assert.equal(parsed.trial.startedAt, null);
  assert.equal(parsed.items.invoicing.source, "beta_compat");
  assert.equal(parsed.items.voice.active, false);
});

await check("migration: pre-entitlement companies get no fabricated trial; explicit beta_compat mapping", () => {
  assert.equal(/update public\.companies\s+set trial_started_at/i.test(MIGRATION_CODE), false, "no backfilled trial dates");
  assert.match(MIGRATION_CODE, /source in \('subscription', 'manual', 'beta_compat'\)/);
  assert.match(MIGRATION_CODE, /where c\.plan in \('pro', 'admin'\) or k\.key <> 'voice'/);
  assert.match(MIGRATION_CODE, /where c\.trial_started_at is null/);
});

await check("pricing: provisional status flagged; every module maps to a DB entitlement key", () => {
  assert.equal(P.PRICING_APPROVAL_STATUS, "provisional");
  for (const m of P.PRICING_MODULES) {
    assert.ok(E.isEntitlementKey(m.entitlementKey));
    assert.match(MIGRATION_CODE, new RegExp(`\\('${m.entitlementKey}',`));
  }
});

await check("pricing: trial limits on the website == DB entitlement catalog", () => {
  const row = (key: string) => {
    const m = new RegExp(`\\('${key}',\\s*'\\w+',\\s*(true|false),\\s*(null|\\d+),`).exec(MIGRATION_CODE);
    assert.ok(m, key);
    return { inTrial: m[1] === "true", limit: m[2] === "null" ? null : Number(m[2]) };
  };
  assert.deepEqual(row("team_members"), { inTrial: true, limit: P.TRIAL_OFFER.limits.users });
  assert.deepEqual(row("vehicles"), { inTrial: true, limit: P.TRIAL_OFFER.limits.vehicles });
  assert.deepEqual(row("machines"), { inTrial: true, limit: P.TRIAL_OFFER.limits.machines });
  assert.deepEqual(row("inventory"), { inTrial: true, limit: P.TRIAL_OFFER.limits.inventoryItems });
  assert.deepEqual(row("ai_documents"), { inTrial: true, limit: P.TRIAL_OFFER.limits.aiProcessings });
  assert.equal(row("voice").inTrial, P.TRIAL_OFFER.includesVoice);
  assert.equal(row("invoicing").inTrial, P.TRIAL_OFFER.includesInvoicing);
  assert.match(MIGRATION_CODE, /interval '14 days'/);
  assert.equal(P.TRIAL_OFFER.days, 14);
});

await check("pricing: no hard-coded prices in pricing UI components", () => {
  for (const f of ["app/cennik/PricingPageClient.tsx", "app/components/pricing/TrialOfferList.tsx", "app/components/PublicLandingPage.tsx"]) {
    assert.equal(/\b\d+[.,]\d{2}\s*€|€\s*\d/.test(read(f)), false, f);
  }
});

await check("pricing page: no checkout / buy button while billing does not exist", () => {
  const src = read("app/cennik/PricingPageClient.tsx");
  assert.equal(/checkout|stripe|kúpiť|buy now/i.test(src), false);
});

// ============================================================ i18n
await check("i18n: entitlement reasons, module names and pricing copy exist in sk/en/de", () => {
  const keys = [
    ...E.ENTITLEMENT_REASONS.map((r) => `entitlements.reasons.${r}`),
    ...E.ENTITLEMENT_KEYS.map((k) => `entitlements.modules.${k}`),
    ...P.PRICING_MODULES.flatMap((m) => [`pricing.modules.items.${m.id}.name`, `pricing.modules.items.${m.id}.description`]),
    "pricing.headline", "pricing.trial.cta", "pricing.summary.total", "pricing.faq.q5", "pricing.faq.a5",
    "auth.invite.createErrors.ENTITLEMENT_USER_LIMIT", "auth.invite.errors.ENTITLEMENT_USER_LIMIT",
  ];
  for (const locale of ["sk", "en", "de"] as const) for (const key of keys) assert.ok(hasTranslation(locale, key), `${locale}:${key}`);
  assert.equal(translate("sk", "pricing.headline"), "Plaťte iba za to, čo vaša firma používa.");
});

// ============================================================ 6. plan / storage / migration safety
await check("new code no longer reads companies.plan", () => {
  const offenders = SOURCES.filter((f) => /from\(\s*["']companies["']\s*\)\s*\.select\([^)]*\bplan\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});

await check("no client/server code writes entitlements, trial or plan", () => {
  const offenders = SOURCES.filter((f) => {
    const src = readFileSync(f, "utf8");
    return /from\(\s*["'](company_entitlements|ai_processing_usage|entitlement_catalog)["']\s*\)/.test(src)
      || /from\(\s*["']companies["']\s*\)\s*\.(update|upsert|insert)/.test(src);
  });
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});

await check("storage paths never derived from plan/entitlement", () => {
  const offenders = SOURCES.filter((f) => /(storage_path|\.upload\(|\.move\(|\.copy\()[^\n]*\b(plan|entitlement)/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});

await check("migration: additive only (no DROP TABLE/COLUMN, TRUNCATE, DELETE, storage or business-row UPDATE)", () => {
  const sql = MIGRATION_CODE.toLowerCase();
  assert.equal(/\bdrop\s+(table|column|policy|function|schema)\b/.test(sql), false);
  assert.equal(/\btruncate\b|\bdelete\s+from\b/.test(sql), false);
  assert.equal(/storage\./.test(sql), false);
  assert.equal(/update\s+public\.(vehicles|machines|inventory_items|documents|ai_evidence|company_members|invoices|business_partners)\b/.test(sql), false);
});

await check("migration: new tables have RLS and no anon/authenticated table grants", () => {
  for (const table of ["entitlement_catalog", "company_entitlements", "ai_processing_usage"]) {
    assert.match(MIGRATION_CODE, new RegExp(`alter table public\\.${table} enable row level security;`));
    assert.match(MIGRATION_CODE, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`));
  }
  assert.equal(/create policy/i.test(MIGRATION_CODE), false, "no policies = default deny");
});

await check("migration: every SECURITY DEFINER function pins search_path and revokes anon", () => {
  const fns = [...MIGRATION_CODE.matchAll(/create or replace function (public\.[a-z_]+)\(([^)]*)\)[\s\S]*?\$function\$;/g)];
  assert.ok(fns.length >= 10);
  for (const [block, name] of fns) {
    if (!/security definer/.test(block)) continue;
    assert.match(block, /set search_path to ''/, name);
    assert.match(MIGRATION_CODE, new RegExp(`revoke all on function ${name.replace(".", "\\.")}\\([^)]*\\) from public, anon`), `${name}: revoke anon`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
