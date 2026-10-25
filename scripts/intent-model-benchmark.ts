// =============================================================================
// J8 — benchmark AI klasifikátora intentov: gpt-5.6-terra vs gpt-5.6-luna.
//
// NIE JE súčasť CI ani `npm test`. Vyžaduje skutočný OPENAI_API_KEY
// (lokálne, mimo repa) a výslovný súhlas premennou:
//
//   ESBLU_INTENT_BENCHMARK_CONFIRM=yes OPENAI_API_KEY=… \
//     node --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs \
//     scripts/intent-model-benchmark.ts [--limit 120] [--models gpt-5.6-terra,gpt-5.6-luna]
//
// Posiela IBA syntetické vety z tests/fixtures/intent-command-corpus.json
// (žiadne dáta firmy) priamo do classifyIntentWithAi (obchádza parser —
// meria samotný model). Nič neukladá do DB; tokeny z odpovede iba sčíta.
// Odhad ceny: ~4,2k vstupných tokenov × počet viet × modely
// (terra ≈ 0,011 USD / veta bez cache, luna ≈ 0,0012 USD / veta).
//
// Výstup: presnosť (intent ∈ accept, null tam, kde je null povolený),
// falošne pozitívne, read intent na zápis/zápor, priemer tokenov, odhad USD.
// Prepnutie modelu v produkcii až po tomto behu + schválení (PENDING APPROVAL).
// =============================================================================

import { readFileSync } from "node:fs";

if (process.env.ESBLU_INTENT_BENCHMARK_CONFIRM !== "yes" || !process.env.OPENAI_API_KEY) {
  console.error("intent-model-benchmark: chýba OPENAI_API_KEY alebo ESBLU_INTENT_BENCHMARK_CONFIRM=yes — nič sa nespustilo.");
  process.exit(2);
}

const { classifyIntentWithAi, INTENT_FALLBACK_MODELS } = await import("@/lib/intents/ai-fallback");
const { INTENT_REGISTRY } = await import("@/lib/intents/registry");

type Row = { id: string; kind: string; text: string; accept: string[]; allowNoIntent: boolean };
const rows = (JSON.parse(readFileSync("tests/fixtures/intent-command-corpus.json", "utf8")) as { commands: Row[] }).commands;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const limit = Number(arg("--limit") ?? rows.length);
const models = (arg("--models") ?? INTENT_FALLBACK_MODELS.join(",")).split(",").filter((m) => (INTENT_FALLBACK_MODELS as readonly string[]).includes(m)) as (typeof INTENT_FALLBACK_MODELS)[number][];
const PRICE: Record<string, { input: number; cached: number; output: number }> = {
  // USD / 1M tokenov, developers.openai.com (overené 2026-10-25)
  "gpt-5.6-terra": { input: 2.0, cached: 0.2, output: 12.0 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
};
const isRead = (n: string) => (INTENT_REGISTRY as Record<string, { readOnly: boolean } | undefined>)[n]?.readOnly === true;

const sample = rows.slice(0, limit);
for (const model of models) {
  let ok = 0, fp = 0, readOnWrite = 0, input = 0, cached = 0, output = 0, failures = 0;
  for (const row of sample) {
    const intent = await classifyIntentWithAi(row.text, async (report) => {
      input += report.usage.inputTokens;
      cached += report.usage.cachedInputTokens;
      output += report.usage.outputTokens;
      if (report.outcome === "failure") failures++;
    }, { model });
    const name = intent?.name ?? null;
    if (name ? row.accept.includes(name) : row.allowNoIntent) ok++;
    if (name && !row.accept.includes(name)) fp++;
    if (name && isRead(name) && !row.accept.includes(name) && ["write", "negative", "unsupported"].includes(row.kind)) readOnWrite++;
  }
  const p = PRICE[model];
  const usd = ((input - cached) * p.input + cached * p.cached + output * p.output) / 1e6;
  console.log(JSON.stringify({
    model,
    commands: sample.length,
    accuracy: +(ok / sample.length).toFixed(4),
    falsePositives: fp,
    readIntentOnWriteOrNegative: readOnWrite,
    callFailures: failures,
    avgInputTokens: Math.round(input / sample.length),
    cachedShare: input ? +(cached / input).toFixed(3) : 0,
    avgOutputTokens: Math.round(output / sample.length),
    usdTotal: +usd.toFixed(4),
    usdPerCall: +(usd / sample.length).toFixed(5),
  }));
}
