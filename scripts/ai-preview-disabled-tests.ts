// =============================================================================
// Preview / staging: OpenAI ZÁMERNE VYPNUTÉ (OPENAI_API_KEY = "preview-disabled",
// docs/security-vercel-preview-env-audit-2026-10-06.md). Overuje fail-closed:
//   - zástupná hodnota NIE JE konfigurácia (žiadny OpenAI klient, žiadne volanie),
//   - KAŽDÁ server route s OpenAI má gate (isOpenAiConfigured / lazyAiClient)
//     PO autentifikácii a PRED kvótou, nahratím obsahu a akýmkoľvek volaním OpenAI,
//   - odpoveď je explicitný stav 503 AI_UNAVAILABLE (žiadna retry slučka),
//   - chyby OpenAI sa logujú iba cez safeAiErrorMeta (žiadny fragment kľúča),
//   - OpenAI sa nedá zapnúť inou premennou.
// Bez siete, bez OpenAI, bez Vercelu.   npm run test:ai-preview-disabled
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const { isOpenAiConfigured, lazyAiClient, safeAiErrorMeta } = await import("@/lib/ai/openai-runtime");

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message.split("\n").slice(0, 6).join("\n       ") : String(error)}`);
  }
}

const SENTINEL = "preview-disabled";

await check("sentinel: preview-disabled / disabled / prázdne nie sú konfigurácia; iba tvar sk-… áno", () => {
  for (const v of [SENTINEL, "disabled", "placeholder", "build-placeholder", "", "   ", undefined, "sk-", "sk-short"])
    assert.equal(isOpenAiConfigured({ OPENAI_API_KEY: v }), false, `hodnota ${JSON.stringify(v)}`);
  assert.equal(isOpenAiConfigured({ OPENAI_API_KEY: "sk-test-0000000000" }), true);
  assert.equal(isOpenAiConfigured({ OPENAI_API_KEY: "sk-proj-AAAAAAAAAA" }), true);
});

await check("sentinel: lazyAiClient nikdy nezavolá factory (OpenAI klient nevznikne)", () => {
  let built = 0;
  const get = lazyAiClient(() => { built++; return {}; }, { OPENAI_API_KEY: SENTINEL });
  assert.equal(get(), null);
  assert.equal(get(), null);
  assert.equal(built, 0);
});

await check("logy: safeAiErrorMeta nikdy nevráti message (fragment kľúča z 401)", () => {
  const err = Object.assign(new Error(`Incorrect API key provided: ${SENTINEL}. You can find your API key at …`), {
    status: 401, code: "invalid_api_key", type: "invalid_request_error",
  });
  const meta = safeAiErrorMeta(err);
  assert.deepEqual(Object.keys(meta).sort(), ["code", "name", "status", "type"]);
  assert.ok(!JSON.stringify(meta).includes(SENTINEL));
});

// ----------------------------------------------------------------------------- statický audit routes
function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    if (f === "node_modules" || f.startsWith(".")) return [];
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(f) ? [rel] : [];
  });
}
const sources = [...walk("app"), ...walk("lib")];
const openAiFiles = sources.filter((f) => /from "openai"|new OpenAI\(/.test(read(f)));

await check("inventár: OpenAI SDK používajú presne známe súbory", () => {
  assert.deepEqual(openAiFiles.sort(), [
    "app/api/assistant/transcribe/route.ts",
    "app/api/scan-document/route.ts",
    "app/api/scan-vehicle-doc/route.ts",
    "app/api/scan-vehicle-registration/route.ts",
    "lib/intents/ai-fallback.ts",
  ]);
});

const SCAN_ROUTES = ["app/api/scan-document/route.ts", "app/api/scan-vehicle-doc/route.ts", "app/api/scan-vehicle-registration/route.ts"];

await check("AI dokumenty: gate isOpenAiConfigured() je po auth (401) a pred kvótou, formData aj OpenAI volaním", () => {
  for (const f of SCAN_ROUTES) {
    const src = read(f);
    const post = src.indexOf("export async function POST");
    assert.ok(post > 0, `${f}: POST`);
    const body = src.slice(post);
    const gate = body.indexOf("if (!isOpenAiConfigured())");
    assert.ok(gate > 0, `${f}: chýba gate`);
    const lastAuth = body.lastIndexOf("{ status: 401 }", gate);
    assert.ok(lastAuth > 0 && lastAuth < gate, `${f}: gate musí byť až po autentifikácii`);
    for (const marker of ["formData()", ".rpc(", "guardAiProcessing(", "reserveAiProcessing(", "client.responses.create", "client.chat.completions.create"]) {
      const i = body.indexOf(marker);
      if (i >= 0) assert.ok(i > gate, `${f}: ${marker} je pred gate`);
    }
    assert.match(body.slice(gate, gate + 400), /code: "AI_UNAVAILABLE"[^]*status: 503/, `${f}: 503 AI_UNAVAILABLE`);
  }
});

await check("voice / assistant: lazyAiClient (bez kľúča null → 503 AI_UNAVAILABLE / deterministický fallback)", () => {
  const transcribe = read("app/api/assistant/transcribe/route.ts");
  assert.match(transcribe, /const getClient = lazyAiClient\(/);
  assert.match(transcribe, /if \(!client\) \{[^]*code: "AI_UNAVAILABLE"[^]*status: 503/);
  const fallback = read("lib/intents/ai-fallback.ts");
  assert.match(fallback, /const getClient = lazyAiClient\(\(\) => new OpenAI/);
  assert.ok(!/^const client = new OpenAI/m.test(fallback), "ai-fallback nesmie mať modulový klient");
});

await check("logy: OpenAI chyby sa logujú iba cez safeAiErrorMeta (nie error / error.message)", () => {
  for (const f of openAiFiles) {
    const bad = read(f).split("\n").filter((l) => /console\.(error|warn|log)\(/.test(l) && /OPENAI|OpenAI|AI|SCAN|transcri/i.test(l)
      && /,\s*(error|e|err|spzError|transcriptionError)(\.message)?\s*\)/.test(l) && !/safeAiErrorMeta/.test(l));
    assert.deepEqual(bad, [], f);
  }
});

await check("konfigurácia: OpenAI sa nedá zapnúť inou premennou; žiadny NEXT_PUBLIC_ OpenAI kľúč", () => {
  const envs = new Set(sources.flatMap((f) => [...read(f).matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1])).filter((k) => /OPENAI/.test(k)));
  assert.deepEqual([...envs], ["OPENAI_API_KEY"]);
  assert.ok(!sources.some((f) => /NEXT_PUBLIC_[A-Z_]*OPENAI/.test(read(f))));
});

await check("i18n: inbox.errors.aiUnavailable existuje v sk / de / en", () => {
  for (const l of ["sk", "de", "en"]) assert.match(read(`lib/i18n/dictionaries/${l}.ts`), /\n {6}aiUnavailable:\n/, l);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
