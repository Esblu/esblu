// =============================================================================
// Intent korpus — pokrytie deterministického parsera a počet AI fallbackov.
//
// SPUSTENIE
//   npm run test:intent-corpus              (asserty + súhrn)
//   npm run test:intent-corpus -- --report  (navyše zoznam chýb po riadkoch)
//   npm run test:intent-corpus -- --json    (strojovo čitateľný súhrn)
//
// Korpus: tests/fixtures/intent-command-corpus.json (syntetický, žiadne
// reálne dáta). Každá veta prejde DVOMA vrstvami:
//   1. parseIntentDeterministic — čistá funkcia (rovnaká pre text aj hlas,
//      hlas posiela prepis do toho istého /api/assistant/intent),
//   2. runAssistantTurnDetailed — celý orchestrátor nad pamäťovou DB (rola
//      owner) s AI náhradou, ktorá iba POČÍTA volania a vracia null.
//      Tak sa meria skutočný počet volaní modelu, vrátane viet, ktoré
//      orchestrátor odmietne ešte pred AI (zápis mimo allowlistu, oprava).
//
// Žiadne OpenAI volanie, žiadny text sa nikam neukladá.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "cd".repeat(32);
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { makeDb, COMPANY_A } from "./support/memory-db.ts";

const { parseIntentDeterministic } = await import("@/lib/intents/parse");
const { runAssistantTurnDetailed } = await import("@/lib/intents/orchestrator");
const { INTENT_REGISTRY } = await import("@/lib/intents/registry");
const { INTENT_NAMES } = await import("@/lib/intents/types");

type Row = {
  id: string;
  lang: "sk" | "cs" | "en" | "de";
  kind: "exact" | "natural" | "negative" | "unsupported" | "write";
  text: string;
  accept: string[];
  allowNoIntent: boolean;
};

const corpus = JSON.parse(readFileSync("tests/fixtures/intent-command-corpus.json", "utf8")) as { version: number; commands: Row[] };
const rows = corpus.commands;
const args = new Set(process.argv.slice(2));

let passed = 0;
let failed = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const isRead = (name: string) => (INTENT_REGISTRY as Record<string, { readOnly: boolean } | undefined>)[name]?.readOnly === true;
// Read-only v registri, ale iba OTVORIA formulár/príjem bez zápisu do DB
// (nový partner, výber modulu pre novú položku) — prípustné pre „pridaj …".
const FORM_ONLY = new Set(["PARTNER_CREATE", "ENTITY_CREATE"]);

// -----------------------------------------------------------------------------
// Korpus je platný: ≥300 viet, jazyky, žiadne neznáme intenty, unikátne ID.
// -----------------------------------------------------------------------------
check("korpus: ≥300 viet, ≥150 SK, ≥75 EN, ≥75 DE", () => {
  const by = (l: string) => rows.filter((r) => r.lang === l).length;
  assert.ok(rows.length >= 300, `spolu ${rows.length}`);
  assert.ok(by("sk") >= 150, `sk ${by("sk")}`);
  assert.ok(by("en") >= 75, `en ${by("en")}`);
  assert.ok(by("de") >= 75, `de ${by("de")}`);
});
check("korpus: unikátne ID a texty, iba známe intenty", () => {
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.equal(new Set(rows.map((r) => r.text)).size, rows.length, "duplicitný text");
  for (const r of rows) for (const a of r.accept) assert.ok((INTENT_NAMES as readonly string[]).includes(a), `${r.id}: ${a}`);
});
check("korpus: negatívne a nepodporované vety nepripúšťajú žiadny intent", () => {
  for (const r of rows) if (r.kind === "negative" || r.kind === "unsupported") assert.deepEqual(r.accept, [], r.id);
});
check("korpus: write vety pripúšťajú iba write intent", () => {
  for (const r of rows) if (r.kind === "write") for (const a of r.accept) assert.ok(!isRead(a) || FORM_ONLY.has(a), `${r.id}: ${a}`);
});

// -----------------------------------------------------------------------------
// Vrstva 1 + 2
// -----------------------------------------------------------------------------
type Outcome = {
  row: Row;
  det: string | null;
  /** správne: intent v accept, alebo null tam, kde je null povolený */
  correct: boolean;
  /** zlý intent (nie null) */
  falsePositive: boolean;
  /** write/negatívna/nepodporovaná veta → READ intent (kritické) */
  readOnWrite: boolean;
  aiCalled: boolean;
  clarification: boolean;
  orchestratorError: boolean;
};

const outcomes: Outcome[] = [];
for (const row of rows) {
  const parsed = parseIntentDeterministic(row.text);
  const det = parsed?.name ?? null;
  const correct = det ? row.accept.includes(det) : row.allowNoIntent;
  const falsePositive = det !== null && !row.accept.includes(det);
  const readOnWrite = det !== null && isRead(det) && !row.accept.includes(det) && (row.kind === "write" || row.kind === "negative" || row.kind === "unsupported");

  const env = makeDb({ role: "owner", financeManage: true });
  let aiCalled = false;
  let clarification = false;
  let orchestratorError = false;
  try {
    const { output } = await runAssistantTurnDetailed(
      { db: env.db, classifyWithAi: async () => { aiCalled = true; return null; } },
      {
        rawText: row.text,
        locale: row.lang === "cs" ? "sk" : row.lang,
        userId: env.userId,
        companyId: COMPANY_A,
        role: "owner",
        financeView: true,
        financeManage: true,
        canOperate: true,
        conversationId: null,
        pendingClarification: null,
        structuredPartnerId: null,
        issueDate: "2026-10-25",
        uiContext: null,
        selection: null,
        folderContextId: null,
      } as never
    );
    clarification = output.result.kind === "clarify" || Boolean(output.pendingClarification);
  } catch {
    orchestratorError = true;
  }
  outcomes.push({ row, det, correct, falsePositive, readOnWrite, aiCalled, clarification, orchestratorError });
}

// -----------------------------------------------------------------------------
// Metriky
// -----------------------------------------------------------------------------
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)} %`);
type Agg = { total: number; supported: number; detHit: number; fallback: number; fp: number; fn: number; readOnWrite: number; clar: number };
function aggregate(list: Outcome[]): Agg {
  const supported = list.filter((o) => o.row.accept.length > 0 && o.row.kind !== "write" || (o.row.kind === "write" && o.row.accept.length > 0));
  return {
    total: list.length,
    supported: supported.length,
    detHit: supported.filter((o) => o.det !== null && o.row.accept.includes(o.det)).length,
    fallback: list.filter((o) => o.aiCalled).length,
    fp: list.filter((o) => o.falsePositive).length,
    fn: supported.filter((o) => o.det === null).length,
    readOnWrite: list.filter((o) => o.readOnWrite).length,
    clar: list.filter((o) => o.clarification).length,
  };
}
function line(label: string, a: Agg): string {
  return `${label.padEnd(26)} n=${String(a.total).padStart(3)}  det.pokrytie ${pct(a.detHit, a.supported).padStart(7)}  fallback ${pct(a.fallback, a.total).padStart(7)} (${a.fallback})  FP ${a.fp}  FN ${a.fn}  read-na-zápis ${a.readOnWrite}  otázka ${a.clar}`;
}

const all = aggregate(outcomes);
const summary = {
  corpusVersion: corpus.version,
  total: all.total,
  supportedCommands: all.supported,
  deterministicHits: all.detHit,
  deterministicCoverage: all.supported ? all.detHit / all.supported : 0,
  aiFallbackCalls: all.fallback,
  aiFallbackRate: all.total ? all.fallback / all.total : 0,
  falsePositives: all.fp,
  falseNegatives: all.fn,
  readIntentOnWriteOrNegative: all.readOnWrite,
  clarifications: all.clar,
  unsupportedRefusedBeforeAi: outcomes.filter((o) => o.row.kind === "unsupported" && !o.aiCalled && !o.det).length,
  orchestratorErrors: outcomes.filter((o) => o.orchestratorError).length,

  byLanguage: Object.fromEntries(["sk", "cs", "en", "de"].map((l) => [l, aggregate(outcomes.filter((o) => o.row.lang === l))])),
  byKind: Object.fromEntries(["exact", "natural", "negative", "unsupported", "write"].map((k) => [k, aggregate(outcomes.filter((o) => o.row.kind === k))])),
};

if (args.has("--json")) {
  console.log(JSON.stringify(summary, null, 1));
} else {
  console.log(line("SPOLU", all));
  for (const l of ["sk", "cs", "en", "de"]) console.log(line(`  jazyk ${l}`, aggregate(outcomes.filter((o) => o.row.lang === l))));
  for (const k of ["exact", "natural", "negative", "unsupported", "write"]) console.log(line(`  druh ${k}`, aggregate(outcomes.filter((o) => o.row.kind === k))));
  const intents = [...new Set(rows.flatMap((r) => r.accept.slice(0, 1)))].sort();
  if (args.has("--report")) {
    for (const name of intents) console.log(line(`  ${name}`, aggregate(outcomes.filter((o) => o.row.accept[0] === name))));
    console.log("\n--- chyby (FP / FN / AI fallback) ---");
    for (const o of outcomes) {
      if (o.correct && !o.aiCalled) continue;
      const tag = o.readOnWrite ? "READ-NA-ZÁPIS" : o.falsePositive ? "FP" : !o.correct ? "FN" : "AI";
      console.log(`${tag.padEnd(13)} ${o.row.id.padEnd(7)} ${o.row.kind.padEnd(11)} det=${String(o.det).padEnd(26)} ai=${o.aiCalled ? "áno" : "nie"}  čakal=${o.row.accept.join("|") || "∅"}  „${o.row.text}"`);
    }
  }
}

console.log(`\nintent-corpus: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
