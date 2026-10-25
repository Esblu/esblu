// =============================================================================
// J8 — Intent fallback cost optimization: poistky, brána pred AI, dedupe,
// telemetria, prompt a hlasová cesta.
//
// SPUSTENIE
//   npm run test:intent-fallback
//
// Bez siete, bez OpenAI, bez DB. Orchestrátor beží nad pamäťovou DB s AI
// náhradou, ktorá iba počíta volania.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "cd".repeat(32);
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { makeDb, COMPANY_A, COMPANY_B } from "./support/memory-db.ts";

const guards = await import("@/lib/intents/command-guards");
const { parseIntentDeterministic } = await import("@/lib/intents/parse");
const { runAssistantTurnDetailed } = await import("@/lib/intents/orchestrator");
const { intentConfidence } = await import("@/lib/intents/confidence");
const dedupe = await import("@/lib/intents/ai-fallback-dedupe");
const telemetry = await import("@/lib/intents/command-telemetry");
const ai = await import("@/lib/intents/ai-fallback");
const { INTENT_REGISTRY } = await import("@/lib/intents/registry");
const { INTENT_NAMES } = await import("@/lib/intents/types");

type ParsedIntent = import("@/lib/intents/types").ParsedIntent;

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
const read = (f: string) => readFileSync(f, "utf8");
const isRead = (n: string) => (INTENT_REGISTRY as Record<string, { readOnly: boolean }>)[n]?.readOnly === true;

async function turn(text: string, opts: { role?: "owner" | "accountant" | "employee"; companyId?: string; ai?: (t: string) => ParsedIntent | null } = {}) {
  const role = opts.role ?? "owner";
  const env = makeDb({ role, financeManage: role !== "employee", companyId: opts.companyId });
  let aiCalls = 0;
  const { output, finalIntent } = await runAssistantTurnDetailed(
    { db: env.db, classifyWithAi: async (t) => { aiCalls++; return opts.ai ? opts.ai(t) : null; } },
    {
      rawText: text, locale: "sk", userId: env.userId, companyId: opts.companyId ?? COMPANY_A, role,
      financeView: role !== "employee", financeManage: role !== "employee", canOperate: role !== "accountant",
      conversationId: null, pendingClarification: null, structuredPartnerId: null, issueDate: "2026-10-25",
      uiContext: null, selection: null, folderContextId: null,
    } as never
  );
  return { output, finalIntent, aiCalls };
}

// -----------------------------------------------------------------------------
console.log("negatívne vety");
// -----------------------------------------------------------------------------
const NEGATED = [
  "nemám STK", "nechcem hľadať auto", "Nechcem vidieť faktúry", "neotváraj vozidlo BA123AB", "Nehľadaj stroje",
  "Nepotrebujem sklad", "I don't have an inspection", "don't search for the car", "do not open the vehicle",
  "Ich habe keinen TÜV", "such nicht nach dem Auto", "öffne das Fahrzeug nicht",
];
await check("zápor: parser nevráti žiadny intent a AI sa nevolá", async () => {
  for (const text of NEGATED) {
    assert.equal(guards.isNegatedCommand(text), true, text);
    assert.equal(parseIntentDeterministic(text), null, text);
    const r = await turn(text);
    assert.equal(r.aiCalls, 0, text);
    assert.equal(r.finalIntent, null, text);
  }
});
await check("zápor sa nepletie s kladnými vetami so záporným slovom", () => {
  for (const text of ["Ukáž neuhradené faktúry", "Ukáž nezaplatené faktúry", "Wer hat noch nicht bezahlt?", "Zeige nicht zugeordnete Belege", "Ukáž nepriradené doklady", "Kto nám ešte nezaplatil?"]) {
    assert.equal(guards.isNegatedCommand(text), false, text);
    assert.ok(parseIntentDeterministic(text), text);
  }
});

const UNSUPPORTED: [string, string][] = [
  ["Vymaž všetky faktúry", "bulk_delete"], ["Zmaž všetky stroje", "bulk_delete"], ["Delete all invoices", "bulk_delete"], ["Lösche alle Rechnungen", "bulk_delete"],
  ["Pošli faktúru zákazníkovi", "send"], ["Send the invoice to the customer", "send"], ["Schick die Rechnung an den Steuerberater", "send"],
  ["Označ faktúru ako zaplatenú", "mark_paid"], ["Mark the invoice as paid", "mark_paid"], ["Markiere die Rechnung als bezahlt", "mark_paid"],
  ["Vystav tú faktúru", "finalize"], ["Finalizuj faktúru", "finalize"], ["Finalisiere die Rechnung", "finalize"],
  ["Zmeň VIN vozidla BA123AB", "edit_field"], ["Ändere die FIN von BA123AB", "edit_field"], ["Vymaž faktúru 2026001", "delete_document"],
];
await check("nepodporovaný zápis: žiadny intent, jasná odpoveď, bez AI", async () => {
  for (const [text, reason] of UNSUPPORTED) {
    assert.equal(guards.unsupportedActionReason(text), reason, text);
    assert.equal(parseIntentDeterministic(text), null, text);
    const r = await turn(text);
    assert.equal(r.aiCalls, 0, text);
    assert.equal(r.output.result.kind, "answer", text);
  }
});
await check("podporované zápisy s potvrdením ostávajú (nie sú „nepodporované“)", () => {
  const cases: [string, string][] = [
    ["Vymaž vozidlo BA123AB", "VEHICLE_DELETE"], ["Zmaž stroj JCB", "MACHINE_DELETE"], ["Zmaž priečinok August", "FOLDER_DELETE"],
    ["Lösche den Belegordner Test1.", "FOLDER_DELETE"], ["Zmaž skladovú položku sprej", "INVENTORY_ITEM_DELETE"],
    ["Pridaj vozidlo BA123AB", "VEHICLE_CREATE"], ["Vytvor priečinok August", "FOLDER_CREATE"],
  ];
  for (const [text, intent] of cases) {
    assert.equal(guards.unsupportedActionReason(text), null, text);
    assert.equal(parseIntentDeterministic(text)?.name, intent, text);
  }
});
await check("sloveso zápisu nikdy nedá čítanie dát („Zaeviduj bager X“)", () => {
  for (const text of ["Zaeviduj bager CAT 320", "Registriere Bagger CAT 320", "Register excavator CAT 320", "Zmaž všetky stroje"]) {
    const intent = parseIntentDeterministic(text);
    assert.ok(!intent || !isRead(intent.name), `${text} → ${intent?.name}`);
  }
});
await check("write vety nikdy nemapujú na read intent (EK v „gekostet“ už nie)", () => {
  assert.equal(parseIntentDeterministic("Wie viel hat uns BA123AB dieses Jahr gekostet?")?.name, "VEHICLE_COST_SUMMARY");
  assert.equal(parseIntentDeterministic("Kedy má BA123AB emisnú kontrolu?")?.name, "VEHICLE_EK_STATUS");
  assert.equal(parseIntentDeterministic("Ukáž technický preukaz BA123AB")?.name, "SHOW_VEHICLE_DOCUMENTS");
});

// -----------------------------------------------------------------------------
console.log("brána pred AI");
// -----------------------------------------------------------------------------
await check("mimo domény / pozdrav: bez AI, „Nerozumel som“", async () => {
  for (const text of ["Ahoj", "Aké je počasie?", "Napíš mi básničku", "Hello", "Tell me a joke", "Hallo", "Erzähl mir einen Witz", "blabla", "?", "   "]) {
    assert.ok(guards.aiFallbackSkipReason(text), text);
    const r = await turn(text);
    assert.equal(r.aiCalls, 0, text);
    assert.equal(r.output.recognized, false, text);
  }
});
await check("veta s doménovou kotvou, ktorú parser nepozná, ide na AI ako doteraz", async () => {
  for (const text of ["Odober 5 cementu", "Zaeviduj bager CAT 320", "Koľko lepidla minul Jano na stavbe?"]) {
    assert.equal(guards.aiFallbackSkipReason(text), null, text);
  }
  const r = await turn("Odober 5 cementu");
  assert.equal(r.aiCalls, 1);
});
await check("AI výsledok ďalej prechádza poistkami (zápis bez výslovného slova sa zahodí)", async () => {
  const r = await turn("Zaeviduj bager CAT 320", { ai: () => ({ name: "MACHINE_CREATE", args: { entityName: "Bager CAT 320" }, source: "ai" }) });
  assert.equal(r.aiCalls, 1);
  assert.equal(r.finalIntent, null);
});

// -----------------------------------------------------------------------------
console.log("oprávnenia a multi-company");
// -----------------------------------------------------------------------------
await check("zamestnanec: deterministický read intent nič neobchádza (rovnaké odmietnutie, bez AI)", async () => {
  const r = await turn("Ukáž neuhradené faktúry", { role: "employee" });
  assert.equal(r.aiCalls, 0);
  assert.equal(r.output.result.kind, "error");
});
await check("účtovník: zápis do skladu cez nové synonymá sa nezíska", async () => {
  const r = await turn("Ukáž vozový park", { role: "accountant" });
  assert.equal(r.aiCalls, 0);
  assert.notEqual(r.output.result.kind, "action_preview");
});
await check("cudzia firma: rovnaká veta, iná firma — žiadne dáta z A", async () => {
  const env = makeDb({ role: "owner", financeManage: true, companyId: COMPANY_B, tables: { vehicles: [{ id: "v-a", spz: "BA123AB", company_id: COMPANY_A }] } });
  const { output } = await runAssistantTurnDetailed(
    { db: env.db, classifyWithAi: async () => null },
    { rawText: "Kedy má BA123AB STK?", locale: "sk", userId: env.userId, companyId: COMPANY_B, role: "owner", financeView: true, financeManage: true, canOperate: true,
      conversationId: null, pendingClarification: null, structuredPartnerId: null, issueDate: "2026-10-25", uiContext: null, selection: null, folderContextId: null } as never
  );
  assert.ok(!JSON.stringify(output).includes("v-a"));
});

// -----------------------------------------------------------------------------
console.log("istota (confidence)");
// -----------------------------------------------------------------------------
await check("HIGH = bez voľného textu alebo presná ŠPZ; MEDIUM = meno overované proti dátam; LOW = nič", () => {
  assert.equal(intentConfidence(parseIntentDeterministic("Kedy má BA123AB STK?")), "HIGH");
  assert.equal(intentConfidence(parseIntentDeterministic("Ukáž všetky vozidlá")), "HIGH");
  assert.equal(intentConfidence(parseIntentDeterministic("Koľko máme cementu?")), "MEDIUM");
  assert.equal(intentConfidence(parseIntentDeterministic("Ahoj")), "LOW");
  assert.equal(intentConfidence({ name: "SEARCH_VEHICLE", args: {}, source: "ai" }), "MEDIUM");
});

// -----------------------------------------------------------------------------
console.log("duplicitné AI volanie");
// -----------------------------------------------------------------------------
await check("dedupe: rovnaká veta, firma, používateľ → 1 volanie; iná firma/používateľ → nové", async () => {
  dedupe.resetClassifyOnceForTests();
  let calls = 0;
  const fn = async () => { calls++; return null; };
  const a = { companyId: COMPANY_A, userId: "u1" };
  await Promise.all([dedupe.classifyOnce(a, "Odober 5 cementu", fn), dedupe.classifyOnce(a, "odober  5 CEMENTU", fn)]);
  assert.equal(calls, 1);
  await dedupe.classifyOnce({ companyId: COMPANY_B, userId: "u1" }, "Odober 5 cementu", fn);
  await dedupe.classifyOnce({ companyId: COMPANY_A, userId: "u2" }, "Odober 5 cementu", fn);
  assert.equal(calls, 3);
});
await check("dedupe: po TTL znova; chyba sa necacheuje", async () => {
  dedupe.resetClassifyOnceForTests();
  let calls = 0;
  let now = 1_000;
  const a = { companyId: COMPANY_A, userId: "u1" };
  await dedupe.classifyOnce(a, "x", async () => { calls++; return null; }, () => now);
  now += dedupe.DEDUPE_TTL_MS + 1;
  await dedupe.classifyOnce(a, "x", async () => { calls++; return null; }, () => now);
  assert.equal(calls, 2);
  await assert.rejects(dedupe.classifyOnce(a, "y", async () => { throw new Error("boom"); }, () => now));
  await dedupe.classifyOnce(a, "y", async () => { calls++; return null; }, () => now);
  assert.equal(calls, 3);
});
await check("dedupe: kľúč je jednosmerný hash (text sa neukladá)", () => {
  const key = dedupe.dedupeKey(COMPANY_A, "u1", "Odober 5 cementu");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes("cement"));
  assert.doesNotMatch(read("lib/intents/ai-fallback-dedupe.ts"), /console\.|localStorage|insert|rpc\(/);
});

// -----------------------------------------------------------------------------
console.log("telemetria");
// -----------------------------------------------------------------------------
await check("triedy: ai-fallback > unsupported > ambiguous > deterministic", () => {
  const c = telemetry.classifyIntentTurn;
  assert.deepEqual(c({ aiCalled: true, recognized: false, resultKind: "not_found", pendingClarification: false }), { routeClass: "ai-fallback", outcome: "failure" });
  assert.deepEqual(c({ aiCalled: false, recognized: false, resultKind: "not_found", pendingClarification: false }), { routeClass: "unsupported", outcome: "failure" });
  assert.deepEqual(c({ aiCalled: false, recognized: true, resultKind: "answer", pendingClarification: false, refusedUnsupported: true }), { routeClass: "unsupported", outcome: "failure" });
  assert.deepEqual(c({ aiCalled: false, recognized: true, resultKind: "clarify", pendingClarification: true }), { routeClass: "ambiguous", outcome: "success" });
  assert.deepEqual(c({ aiCalled: false, recognized: true, resultKind: "list", pendingClarification: false }), { routeClass: "deterministic", outcome: "success" });
});
await check("RPC argumenty: iba firma, používateľ (overenie členstva), trieda, výsledok — žiadny obsah", () => {
  const args = telemetry.buildIntentCommandRpcArgs({ companyId: COMPANY_A, userId: "u1" }, { routeClass: "deterministic", outcome: "success" });
  assert.deepEqual(Object.keys(args ?? {}).sort(), ["p_company_id", "p_outcome", "p_route_class", "p_user_id"]);
  assert.equal(telemetry.buildIntentCommandRpcArgs({ companyId: "", userId: "u1" }, { routeClass: "deterministic", outcome: "success" }), null);
  const route = read("app/api/assistant/intent/route.ts");
  const call = route.slice(route.indexOf("recordIntentCommandInScope("), route.indexOf("recordIntentCommandInScope(") + 500);
  assert.doesNotMatch(call, /rawText\s*[,}]|transcript|prompt/);
  assert.match(call, /companyId, userId: user\.id/);
});
await check("migrácia: flow intent_command, service-only RPC, bez textových stĺpcov", () => {
  const sql = read("supabase/migrations/20261027100000_intent_command_telemetry.sql");
  assert.match(sql, /'intent_command'/);
  assert.match(sql, /revoke all on function public\.esblu_record_intent_command\(uuid, uuid, text, text\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.esblu_record_intent_command\(uuid, uuid, text, text\) to service_role;/);
  assert.match(sql, /cm\.status = 'active'/);
  assert.doesNotMatch(sql, /add column|create table/i);
  assert.ok(read("supabase/rollback/20261027100000_intent_command_telemetry_rollback.sql").includes("drop function if exists public.esblu_record_intent_command"));
});

// -----------------------------------------------------------------------------
console.log("prompt, model, cache");
// -----------------------------------------------------------------------------
await check("prompt v2: enumy iba v schéme, žiadne dáta firmy, statický", () => {
  const p = ai.INTENT_CLASSIFICATION_PROMPT;
  assert.ok(!p.includes("Povolené intenty:"));
  assert.ok(!INTENT_NAMES.every((n) => p.includes(n)), "celý zoznam intentov sa už neopakuje");
  assert.ok(p.length < 10_000, `prompt ${p.length} znakov`);
  assert.doesNotMatch(p, /\$\{|company|firma\s*:|user_id|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  assert.deepEqual((ai.INTENT_CLASSIFICATION_SCHEMA.properties.intent.enum as readonly (string | null)[]).filter(Boolean), [...INTENT_NAMES]);
});
await check("volanie: default model nezmenený (terra), max_output_tokens, statický prompt_cache_key, store:false", () => {
  assert.equal(ai.INTENT_FALLBACK_DEFAULT_MODEL, "gpt-5.6-terra");
  assert.match(ai.INTENT_PROMPT_CACHE_KEY, /^esblu-intent-classifier-v\d+$/);
  assert.ok(ai.INTENT_MAX_OUTPUT_TOKENS >= 300 && ai.INTENT_MAX_OUTPUT_TOKENS <= 600);
  const src = read("lib/intents/ai-fallback.ts");
  assert.match(src, /max_output_tokens: INTENT_MAX_OUTPUT_TOKENS/);
  assert.match(src, /prompt_cache_key: INTENT_PROMPT_CACHE_KEY/);
  assert.match(src, /store: false/);
  const route = read("app/api/assistant/intent/route.ts");
  assert.doesNotMatch(route, /model:\s*"gpt-5\.6-luna"|\{ model:/, "route neprepína model");
});
await check("benchmark harness sa bez kľúča a súhlasu nespustí", () => {
  const src = read("scripts/intent-model-benchmark.ts");
  assert.match(src, /ESBLU_INTENT_BENCHMARK_CONFIRM !== "yes" \|\| !process\.env\.OPENAI_API_KEY/);
  assert.ok(!Object.values(JSON.parse(read("package.json")).scripts as Record<string, string>).some((s) => s.includes("intent-model-benchmark")));
});

// -----------------------------------------------------------------------------
console.log("hlas");
// -----------------------------------------------------------------------------
await check("hlas používa ten istý parser: prepis ide do /api/assistant/intent, transcribe neinterpretuje", () => {
  assert.match(read("app/components/voice/VoiceLauncher.tsx"), /\/api\/assistant\/intent/);
  const transcribe = read("app/api/assistant/transcribe/route.ts");
  assert.doesNotMatch(transcribe, /import[^;]*(parseIntentDeterministic|classifyIntentWithAi|runAssistantTurn)/);
});
await check("hlasový prepis (bez diakritiky, s bodkou, malé písmená) → rovnaký intent ako písaný text", () => {
  const pairs: [string, string][] = [
    ["Kedy má BA123AB STK?", "kedy ma ba 123 ab stk."], ["Ukáž všetky vozidlá.", "ukaz vsetky vozidla"],
    ["Čo nám dochádza?", "co nam dochadza"], ["Zeige alle Fahrzeuge.", "zeige alle fahrzeuge"], ["Show unpaid invoices.", "show unpaid invoices"],
  ];
  for (const [typed, spoken] of pairs) assert.equal(parseIntentDeterministic(spoken)?.name, parseIntentDeterministic(typed)?.name, spoken);
});

console.log(`\nintent-fallback: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
