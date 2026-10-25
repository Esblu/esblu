// =============================================================================
// Cost control hardening — aplikačná logika a invarianty kódu (bez DB/siete):
//   - OpenAI retry cost guard (len 429/5xx, nikdy timeout / 4xx), politiky,
//   - usage metering: iba čísla z `usage`, nikdy obsah; company scoping,
//   - inventár OpenAI volaní: každé je za guardom a meria sa,
//   - interný chat: Realtime odbery majú filter (firma / konverzácia),
//   - push: paralelné dávky, deduplikácia, jeden FCM token pri súbehu,
//   - telemetry-maintenance cron.
// DB matica (RLS, granty, scoping, retencia): scripts/cost-control-pglite-tests.ts.
//
//   npm run test:cost-control
// =============================================================================
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const guard = await import("@/lib/ai/openai-guard");
const meter = await import("@/lib/ai/usage-meter");
const realtime = await import("@/lib/chat-realtime");
const { deliver, PUSH_USER_CONCURRENCY } = await import("@/lib/push/dispatch");
const fcm = await import("@/lib/push/providers/fcm");

const read = (p: string) => readFileSync(p, "utf8");
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 4).join("\n       ") : String(error)}`);
  }
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const SOURCES = [...walk("app"), ...walk("lib")];
const apiError = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`status ${status}`), { status, ...extra });
const noSleep = async () => {};

// ----------------------------------------------------------------------------- retry guard
await check("guard: klasifikácia — 429/500/502/503 retry; timeout/abort/connection/504/408 maybe_billed; 4xx a insufficient_quota final", () => {
  for (const s of [429, 500, 502, 503]) assert.equal(guard.classifyAiError(apiError(s)), "retryable", String(s));
  for (const s of [400, 401, 403, 404, 409, 422]) assert.equal(guard.classifyAiError(apiError(s)), "final", String(s));
  for (const s of [504, 408]) assert.equal(guard.classifyAiError(apiError(s)), "maybe_billed", String(s));
  assert.equal(guard.classifyAiError(apiError(429, { code: "insufficient_quota" })), "final");
  assert.equal(guard.classifyAiError(apiError(429, { error: { type: "insufficient_quota" } })), "final");
  for (const name of ["APIConnectionTimeoutError", "APIUserAbortError", "AbortError", "APIConnectionError"]) {
    assert.equal(guard.classifyAiError(Object.assign(new Error("x"), { name })), "maybe_billed", name);
  }
  assert.equal(guard.classifyAiError(null), "final");
});

await check("guard: 503 → 1 retry → úspech (attempts 2); maxRetries 0 → žiadny retry", async () => {
  let n = 0;
  const r = await guard.callOpenAiWithCostGuard(async () => { if (++n === 1) throw apiError(503); return "ok"; }, { maxRetries: 1, sleep: noSleep });
  assert.deepEqual(r, { ok: true, value: "ok", attempts: 2 });
  n = 0;
  const r0 = await guard.callOpenAiWithCostGuard(async () => { n++; throw apiError(503); }, { maxRetries: 0, sleep: noSleep });
  assert.equal(r0.ok, false);
  assert.equal(n, 1);
});

await check("guard: timeout ani 400 sa NEOPAKUJÚ (žiadny duplicitný platený request)", async () => {
  for (const err of [Object.assign(new Error("t"), { name: "APIConnectionTimeoutError" }), apiError(400), apiError(504)]) {
    let n = 0;
    const r = await guard.callOpenAiWithCostGuard(async () => { n++; throw err; }, { maxRetries: 2, sleep: noSleep });
    assert.equal(r.ok, false);
    assert.equal(n, 1, `${(err as Error).name} ${(err as { status?: number }).status ?? ""}`);
    assert.equal(r.attempts, 1);
  }
});

await check("guard: dlhý retry-after → bez retry; krátky retry-after sa dodrží; strop 2 retry", async () => {
  let n = 0;
  const long = await guard.callOpenAiWithCostGuard(async () => { n++; throw apiError(429, { headers: { "retry-after": "30" } }); }, { maxRetries: 1, sleep: noSleep });
  assert.equal(long.ok, false);
  assert.equal(n, 1);
  const waits: number[] = [];
  n = 0;
  await guard.callOpenAiWithCostGuard(async () => { n++; throw apiError(429, { headers: { "retry-after-ms": "750" } }); }, { maxRetries: 9, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(n, 3, "maxRetries je zastropované na 2");
  assert.deepEqual(waits, [750, 750]);
});

await check("politika: drahé obrazové flowy max. 1 retry, fallbacky 0, všetky s timeoutom", () => {
  const p = guard.AI_CALL_POLICY;
  assert.ok(p.documentScan.maxRetries <= 1 && p.vehicleRegistrationScan.maxRetries <= 1);
  assert.equal(p.plateFallback.maxRetries, 0);
  assert.equal(p.intentClassification.maxRetries, 0);
  for (const v of Object.values(p)) assert.ok(v.timeoutMs > 0 && v.timeoutMs <= 90_000);
  assert.ok(p.voiceTranscription.timeoutMs < 20_000, "hlasový klient čaká 20 s");
  assert.ok(p.intentClassification.timeoutMs < 20_000);
});

// ----------------------------------------------------------------------------- inventár OpenAI flowov
const OPENAI_FILES = SOURCES.filter((f) => /from "openai"/.test(read(f))).map((f) => path.relative(".", f)).sort();
await check("inventár: OpenAI SDK používa presne 5 známych súborov (žiadny samostatný AI chatbot)", () => {
  assert.deepEqual(OPENAI_FILES, [
    "app/api/assistant/transcribe/route.ts",
    "app/api/scan-document/route.ts",
    "app/api/scan-vehicle-doc/route.ts",
    "app/api/scan-vehicle-registration/route.ts",
    "lib/intents/ai-fallback.ts",
  ]);
  for (const f of SOURCES) assert.ok(!/api\.openai\.com|chat\.completions\.create|embeddings\.create|images\.generate/.test(read(f)), f);
  assert.ok(!SOURCES.some((f) => /app\/components\/chat|lib\/chat/.test(f) && /openai|ai-fallback|usage-meter/.test(read(f))), "interný chat nevolá AI");
});

await check("inventár: každý OpenAI klient má maxRetries 0 a timeout; každé volanie je za cost guardom a meria sa", () => {
  const expectedFlows: Record<string, string[]> = {
    "app/api/scan-document/route.ts": ["document_scan", "document_scan_plate_fallback"],
    "app/api/scan-vehicle-doc/route.ts": ["vehicle_document_scan", "vehicle_document_plate_fallback"],
    "app/api/scan-vehicle-registration/route.ts": ["vehicle_registration_scan"],
    "app/api/assistant/transcribe/route.ts": ["voice_transcription"],
    "app/api/assistant/intent/route.ts": ["intent_classification_fallback"],
  };
  for (const f of OPENAI_FILES) {
    const src = read(f);
    const clients = [...src.matchAll(/new OpenAI\(\{([\s\S]*?)\}\)/g)];
    assert.ok(clients.length >= 1, f);
    for (const c of clients) {
      assert.match(c[1], /maxRetries: 0/, `${f}: SDK retry musí byť 0`);
      assert.match(c[1], /timeout:/, `${f}: timeout`);
    }
    const calls = [...src.matchAll(/(responses\.create|transcriptions\.create)\(/g)];
    assert.ok(calls.length >= 1, f);
    for (const call of calls) {
      const before = src.slice(Math.max(0, call.index! - 160), call.index!);
      assert.match(before, /callOpenAiWithCostGuard\(/, `${f}: volanie bez cost guardu`);
    }
  }
  for (const [f, flows] of Object.entries(expectedFlows)) {
    const src = read(f);
    for (const flow of flows) assert.ok(src.includes(`flow: "${flow}"`), `${f}: chýba meranie ${flow}`);
  }
  assert.match(read("lib/intents/ai-fallback.ts"), /reportUsage\(\{/);
});

await check("company scoping: skeny cez AI rezerváciu, hlas cez aktívnu firmu session, intent cez overené členstvo", () => {
  for (const f of ["app/api/scan-document/route.ts", "app/api/scan-vehicle-doc/route.ts", "app/api/scan-vehicle-registration/route.ts"]) {
    assert.match(read(f), /reservationMeterScope\((reservation|guard)\.usageId\)/, f);
  }
  assert.match(read("app/api/assistant/transcribe/route.ts"), /meterScopeFromRequest\(req, user\.id\)/);
  assert.match(read("lib/ai/usage-meter-server.ts"), /rpc\("esblu_my_active_company_id"\)/);
  assert.match(read("app/api/assistant/intent/route.ts"), /kind: "member", companyId: membership\.company_id as string, userId: user\.id/);
  for (const f of OPENAI_FILES) assert.doesNotMatch(read(f), /companyId:\s*(body|formData|req\.)/, f);
});

// ----------------------------------------------------------------------------- usage metering — iba čísla
const RESPONSE = {
  output_text: '{"supplier":"Tajná s.r.o.","iban":"SK3112000000198742637541"}',
  usage: { input_tokens: 9123, input_tokens_details: { cached_tokens: 6400 }, output_tokens: 1450, output_tokens_details: { reasoning_tokens: 0 } },
};
const TRANSCRIPT = { text: "vystav faktúru pre Jána Nováka na 300 eur", usage: { type: "tokens", input_tokens: 310, input_token_details: { audio_tokens: 290, text_tokens: 20 }, output_tokens: 18 } };

await check("metering: z odpovede sa berú iba usage čísla (tokeny, cache, audio), nikdy text", () => {
  assert.deepEqual(meter.usageFromResponse(RESPONSE), { inputTokens: 9123, cachedInputTokens: 6400, outputTokens: 1450, audioInputTokens: 0, audioSeconds: 0 });
  assert.deepEqual(meter.usageFromTranscription(TRANSCRIPT), { inputTokens: 310, cachedInputTokens: 0, outputTokens: 18, audioInputTokens: 290, audioSeconds: 0 });
  assert.equal(meter.usageFromTranscription({ text: "x", usage: { type: "duration", seconds: 4.25 } }).audioSeconds, 4.25);
  assert.deepEqual(meter.usageFromResponse({ output_text: "x" }), meter.ZERO_USAGE);
  assert.deepEqual(meter.usageFromResponse({ usage: { input_tokens: -5, output_tokens: "100" } }), meter.ZERO_USAGE);
});

await check("metering: RPC argumenty = presný allowlist polí; žiadny obsah, prompt, transcript ani user dáta okrem ID na overenie", () => {
  const member = meter.buildUsageRpcCall(
    { kind: "member", companyId: "c3000000-0000-4000-8000-00000000000a", userId: "c2000000-0000-4000-8000-0000000000a1" },
    { flow: "voice_transcription", model: "gpt-4o-transcribe", outcome: "success", usage: meter.usageFromTranscription(TRANSCRIPT), imageCount: 0, retryCount: 0 }
  );
  assert.ok(member);
  assert.equal(member!.fn, "esblu_record_ai_usage");
  assert.deepEqual(Object.keys(member!.args).sort(), ["p_audio_input_tokens", "p_audio_seconds", "p_cached_input_tokens", "p_company_id", "p_flow_type",
    "p_image_count", "p_input_tokens", "p_model", "p_outcome", "p_output_tokens", "p_retry_count", "p_user_id"]);
  const res = meter.buildUsageRpcCall(meter.reservationMeterScope("c5000000-0000-4000-8000-000000000001"),
    { flow: "document_scan", model: "gpt-5.6-terra", outcome: "success", usage: meter.usageFromResponse(RESPONSE), imageCount: 1, retryCount: 1 });
  assert.equal(res!.fn, "esblu_record_ai_usage_for_reservation");
  assert.deepEqual(Object.keys(res!.args).sort(), ["p_ai_usage_id", "p_cached_input_tokens", "p_flow_type", "p_image_count", "p_input_tokens", "p_model",
    "p_outcome", "p_output_tokens", "p_retry_count"]);
  const serialized = JSON.stringify([member, res]);
  for (const secret of ["Tajná", "SK3112", "Jána", "faktúru", "300 eur", "output_text"]) assert.ok(!serialized.includes(secret), secret);
});

await check("metering: fail closed — neplatné UUID, neznámy flow/model, hlas cez rezerváciu → nič sa neodošle", async () => {
  const rec = { flow: "document_scan" as const, model: "gpt-5.6-terra" as const, outcome: "success" as const, usage: meter.ZERO_USAGE, imageCount: 1, retryCount: 0 };
  assert.equal(meter.buildUsageRpcCall(null, rec), null);
  assert.equal(meter.buildUsageRpcCall({ kind: "member", companyId: "nie-uuid", userId: "c2000000-0000-4000-8000-0000000000a1" }, rec), null);
  assert.equal(meter.buildUsageRpcCall(meter.reservationMeterScope("c5000000-0000-4000-8000-000000000001"), { ...rec, flow: "voice_transcription" }), null);
  assert.equal(meter.buildUsageRpcCall(meter.reservationMeterScope("c5000000-0000-4000-8000-000000000001"), { ...rec, flow: "ai_chatbot" as never }), null);
  assert.equal(meter.buildUsageRpcCall(meter.reservationMeterScope("c5000000-0000-4000-8000-000000000001"), { ...rec, model: "gpt-9" as never }), null);
  let calls = 0;
  const ok = await meter.recordAiUsageWith(async () => { calls++; throw new Error("db down"); }, meter.reservationMeterScope("c5000000-0000-4000-8000-000000000001"), rec);
  assert.equal(ok, false);
  assert.equal(calls, 1);
  assert.equal(await meter.recordAiUsageWith(async () => { calls++; return { data: true, error: null }; }, null, rec), false);
  assert.equal(calls, 1);
});

await check("metering: kód meradla nečíta output_text / transcript / prompt a nič neloguje", () => {
  for (const f of ["lib/ai/usage-meter.ts", "lib/ai/usage-meter-server.ts", "lib/ai/openai-guard.ts"]) {
    const code = read(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /\.output_text|\.text\b|\btranscript\b|prompt|console\./, f);
  }
  assert.deepEqual([...meter.AI_FLOW_TYPES].sort(), ["document_scan", "document_scan_plate_fallback", "intent_classification_fallback", "vehicle_document_plate_fallback",
    "vehicle_document_scan", "vehicle_registration_scan", "voice_transcription"]);
  const sql = read("supabase/migrations/20261025100000_ai_usage_metering.sql");
  for (const flow of meter.AI_FLOW_TYPES) assert.ok(sql.includes(`'${flow}'`), flow);
});

// ----------------------------------------------------------------------------- interný chat — Realtime
await check("chat realtime: filter iba pre platné UUID (inak žiadny odber)", () => {
  assert.equal(realtime.chatCompanyFilter("c3000000-0000-4000-8000-00000000000a"), "company_id=eq.c3000000-0000-4000-8000-00000000000a");
  assert.equal(realtime.chatConversationFilter("c3000000-0000-4000-8000-00000000000b"), "conversation_id=eq.c3000000-0000-4000-8000-00000000000b");
  for (const bad of [null, undefined, "", "x", "c3000000-0000-4000-8000-00000000000a,company_id=neq.0", "*"]) {
    assert.equal(realtime.chatCompanyFilter(bad as string), null, String(bad));
    assert.equal(realtime.chatConversationFilter(bad as string), null, String(bad));
  }
});

await check("chat realtime: žiadny postgres_changes odber chat tabuliek bez filtra (žiadny celoplatformový odber)", () => {
  let subscriptions = 0;
  for (const f of SOURCES.filter((x) => /\.tsx?$/.test(x))) {
    const src = read(f);
    for (const m of src.matchAll(/"postgres_changes",\s*(\{[\s\S]*?\})/g)) {
      if (!/table: "chat_/.test(m[1])) continue;
      subscriptions++;
      assert.match(m[1], /filter: (companyFilter|conversationFilter)/, `${f}: ${m[1].replace(/\s+/g, " ")}`);
    }
  }
  assert.equal(subscriptions, 7, "unread zoznam, widget, mobilný FAB, konverzácia (INSERT/UPDATE), prílohy, referencie");
});

// ----------------------------------------------------------------------------- push
type Target = import("@/lib/push/providers/types").DeliveryTarget;
const users = Array.from({ length: 19 }, (_, i) => `u${i}`);
function memStore(delayMs: number) {
  const claimed = new Set<string>();
  let active = 0;
  let maxActive = 0;
  return {
    stats: () => ({ maxActive }),
    store: {
      async targets(_c: string, ids: string[]): Promise<Target[]> {
        return ids.map((id) => ({ kind: "fcm", id: `t-${id}`, userId: id, locale: "sk", token: `tok-${id}` }) as Target);
      },
      async claim(i: { userId: string; dedupeKey: string }) {
        const key = `${i.userId}:${i.dedupeKey}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
      async record() {},
    },
    provider: {
      kind: "fcm" as const,
      async send() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, delayMs));
        active--;
        return "sent" as const;
      },
    },
  };
}
const message = (userId: string) => ({ title: "t", body: "b", target: { screen: "chat", id: "c3000000-0000-4000-8000-00000000000a" }, tag: `chat:${userId}` });

await check("push: 19 príjemcov v paralelných dávkach (≤ PUSH_USER_CONCURRENCY), všetci doručení, rýchlejšie ako sekvenčne", async () => {
  const m = memStore(20);
  const started = Date.now();
  const r = await deliver(m.store as never, { fcm: m.provider } as never, { companyId: "A", userIds: users, kind: "chat", dedupeKey: "chat:m1", messageFor: message as never });
  const elapsed = Date.now() - started;
  assert.equal(r.sent, 19);
  assert.equal(r.users, 19);
  assert.ok(m.stats().maxActive > 1 && m.stats().maxActive <= PUSH_USER_CONCURRENCY, `max súbežnosť ${m.stats().maxActive}`);
  assert.ok(elapsed < 19 * 20, `čas ${elapsed} ms`);
});

await check("push: deduplikácia platí aj pri paralelnom doručení (opakované volanie nič nepošle)", async () => {
  const m = memStore(1);
  const input = { companyId: "A", userIds: users, kind: "chat" as const, dedupeKey: "chat:m2", messageFor: message as never };
  assert.equal((await deliver(m.store as never, { fcm: m.provider } as never, input)).sent, 19);
  assert.equal((await deliver(m.store as never, { fcm: m.provider } as never, input)).sent, 0);
});

await check("FCM: súbežné odoslania zdieľajú jedno získanie OAuth tokenu", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString().replace(/\n/g, "\\n");
  const config = fcm.readFcmConfig({ FCM_PROJECT_ID: "esblu-test", FCM_CLIENT_EMAIL: "svc@esblu-test.iam.gserviceaccount.com", FCM_PRIVATE_KEY: pem });
  let oauth = 0;
  const fakeFetch = (async (url: string) => {
    if (url.includes("oauth2")) {
      oauth++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ name: "projects/esblu-test/messages/1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = fcm.createFcmProvider(config!, fakeFetch);
  const target = { kind: "fcm", id: "t", userId: "u", locale: "sk", token: "tok" } as Target;
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => provider.send(target, message("u") as never)));
  assert.deepEqual(outcomes, ["sent", "sent", "sent", "sent", "sent"]);
  assert.equal(oauth, 1);
});

// ----------------------------------------------------------------------------- cron
await check("telemetry-maintenance: CRON_SECRET, iba dve purge RPC, žiadny priamy DELETE, denne", () => {
  const src = read("app/api/cron/telemetry-maintenance/route.ts");
  assert.match(src, /timingSafeEqual/);
  const rpcs = [...src.matchAll(/rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(rpcs, ["esblu_purge_ai_usage_monthly", "esblu_purge_chat_notification_deliveries"]);
  assert.doesNotMatch(src, /\.delete\(|admin\.from\(|\)\.from\(/);
  const cron = JSON.parse(read("vercel.json")).crons.find((c: { path: string }) => c.path === "/api/cron/telemetry-maintenance");
  assert.match(cron.schedule, /^\d+ \d+ \* \* \*$/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
