// =============================================================================
// Voice E2E contract (2026-10-11) — celý hlasový príkazový kontrakt BEZ
// OpenAI a BEZ produkčnej DB.
//
// SPUSTENIE
//   npm run test:voice-e2e
//
// Staging má OpenAI zámerne vypnuté, produkcia sa na zápisy testovať nesmie.
// Tento harness preto ide cez presne tú istú cestu ako reálny hlas PO prepise:
//   prepis (text) → runAssistantTurnDetailed (parser + orchestrátor +
//   permission/entitlement gate + handlery) → pamäťová DB
//   (scripts/support/memory-db.ts, emuluje RLS jednej firmy, konverzačný
//   kontext s jednorazovým claimom a esblu_save_invoice_draft).
// AI klasifikátor je stub (vracia null) — testuje sa, čo appka zvládne
// deterministicky a že bez AI NIKDY nič nezapíše omylom.
//
// Všetky firmy, osoby, IČO, DIČ, IČ DPH a IBAN sú FIKTÍVNE.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "cd".repeat(32);
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { INITIAL_VOICE_SESSION, voiceSessionReducer } = await import("@/lib/voice/voice-session");
const { fetchJsonWithTimeout, failureMessageKey } = await import("@/lib/voice/assistant-http");
const { decideVoiceReplyForPreview } = await import("@/lib/voice/command-safety");
const { spokenTextFor } = await import("@/lib/voice/spoken-text");
const { runAssistantTurnDetailed, sanitizeAiIntent } = await import("@/lib/intents/orchestrator");
const { parseIntentDeterministic } = await import("@/lib/intents/parse");
const { findNumber, findVatRate } = await import("@/lib/intents/number-words");
const { extractInvoiceSlotsFromText, buildDraftConfirmQuestion } = await import("@/lib/intents/invoice-draft");
const { isOpenAiConfigured, lazyAiClient, safeAiErrorMeta } = await import("@/lib/ai/openai-runtime");
const { translate } = await import("@/lib/i18n/translate");

type IntentResult = import("@/lib/intents/types").IntentResult;
type Preview = Extract<IntentResult, { kind: "action_preview" }>;

import { makeDb, COMPANY_A, type Tables } from "./support/memory-db.ts";

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// -----------------------------------------------------------------------------
// Fiktívne dáta
// -----------------------------------------------------------------------------

const CONV = "0123456789abcdef0123456789abcdef";
const P_LESY = "00000000-0000-4000-8000-0000000000e1";
const P_KYS1 = "00000000-0000-4000-8000-0000000000e2";
const P_KYS2 = "00000000-0000-4000-8000-0000000000e3";
const DEMO_TABLES = (): Tables => ({
  business_partners: [
    { id: P_LESY, legal_name: "Lesy Horehronie s.r.o.", ico: "51234567", company_id: COMPANY_A },
    { id: P_KYS1, legal_name: "Stavby Kysuce s.r.o.", ico: "52345678", company_id: COMPANY_A },
    { id: P_KYS2, legal_name: "Stavby Kysuce Servis a.s.", ico: "53456789", company_id: COMPANY_A },
  ],
  vehicles: [
    { id: "00000000-0000-4000-8000-0000000000f1", name: "Škoda Octavia Combi", plate_number: "ZA123AB", company_id: COMPANY_A },
    { id: "00000000-0000-4000-8000-0000000000f2", name: "Ford Transit", plate_number: "ZA456CD", company_id: COMPANY_A },
  ],
});

type Env = ReturnType<typeof makeDb>;
function env(role: "owner" | "admin" | "accountant" | "employee" = "owner"): Env {
  return makeDb({ role, financeManage: role === "owner" || role === "admin", tables: DEMO_TABLES() });
}

async function say(e: Env, text: string, opts: { issueDate?: string | null; conversationId?: string | null } = {}): Promise<IntentResult> {
  const role = e.state.role;
  const finance = role !== "employee";
  const { output } = await runAssistantTurnDetailed(
    { db: e.db, classifyWithAi: async () => null },
    {
      rawText: text,
      locale: "sk",
      userId: e.userId,
      companyId: e.companyId,
      role,
      financeView: finance,
      financeManage: role === "owner" || role === "admin",
      canOperate: role !== "accountant",
      conversationId: opts.conversationId === undefined ? CONV : opts.conversationId,
      pendingClarification: null,
      structuredPartnerId: null,
      issueDate: opts.issueDate === undefined ? "2026-10-11" : opts.issueDate,
      uiContext: null,
      moduleContext: null as never,
      selection: null,
      folderContextId: null,
    }
  );
  return output.result;
}

const invoices = (e: Env) => (e.state.tables.invoices ?? []).length;
const writes = (e: Env) =>
  invoices(e) +
  (e.state.tables.business_partners ?? []).length - 3 +
  (e.state.tables.vehicles ?? []).length - 2 +
  e.state.confirmations.filter((c) => c.consumed_at || c.used_at || c.status === "consumed").length;
const question = (r: IntentResult) => (r as { question?: string }).question ?? (r as { text?: string }).text ?? "";

// =============================================================================
// A. Natívny kontrakt relácie (bez zariadenia)
// =============================================================================

console.log("\nA. Natívny kontrakt relácie");

function at(status: "listening" | "transcribing" | "waiting_server") {
  let s = voiceSessionReducer(INITIAL_VOICE_SESSION, { type: "START" }).state;
  s = voiceSessionReducer(s, { type: "MIC_READY", gen: s.gen }).state;
  if (status === "listening") return s;
  s = voiceSessionReducer(s, { type: "UTTERANCE_CAPTURED", gen: s.gen }).state;
  if (status === "transcribing") return s;
  return voiceSessionReducer(s, { type: "TRANSCRIPT", text: "otvor faktúry", gen: s.gen }).state;
}

await check("AI vypnutá (503 AI_UNAVAILABLE) → relácia skončí s oznámením, žiadna retry slučka", async () => {
  const res = await fetchJsonWithTimeout("/x", {}, {
    timeoutMs: 1000,
    isOnline: () => true,
    fetchImpl: async () => new Response(JSON.stringify({ success: false, code: "AI_UNAVAILABLE" }), { status: 503 }),
  });
  assert.equal(!res.ok && res.kind, "unavailable");
  assert.equal(failureMessageKey("unavailable"), "search.voice.errors.aiUnavailable");
  const s = at("transcribing");
  const step = voiceSessionReducer(s, { type: "TRANSCRIBE_FAILED", kind: "unavailable", gen: s.gen });
  assert.equal(step.state.status, "stopped");
  assert.equal(step.state.stopReason, "unavailable");
  assert.equal(step.state.noticeKey, "aiUnavailable");
  assert.ok(step.effects.some((e) => e.type === "releaseMic"), "mikrofón uvoľnený");
});

await check("iná 503 (výpadok infraštruktúry) ostáva „server“ (retry s limitom)", async () => {
  const res = await fetchJsonWithTimeout("/x", {}, {
    timeoutMs: 1000,
    isOnline: () => true,
    fetchImpl: async () => new Response("<html>503</html>", { status: 503 }),
  });
  assert.equal(!res.ok && res.kind, "server");
});

await check("offline počas čakania na server → koniec s „Ste offline“ (nie 3× „Spojenie zlyhalo“)", () => {
  const s = at("waiting_server");
  const step = voiceSessionReducer(s, { type: "TURN_FAILED", kind: "offline", gen: s.gen });
  assert.equal(step.state.status, "stopped");
  assert.equal(step.state.stopReason, "offline");
  const net = voiceSessionReducer(s, { type: "TURN_FAILED", gen: s.gen });
  assert.notEqual(net.state.status, "stopped", "bežná chyba siete = jedno zlyhanie kola");
});

await check("príliš dlhá veta → „povedzte kratší príkaz“, nie „nerozumel som“", () => {
  const s = at("listening");
  const long = voiceSessionReducer(s, { type: "CAPTURE_FAILED", tooLong: true, gen: s.gen });
  assert.equal(long.state.noticeKey, "tooLong");
  const err = voiceSessionReducer(s, { type: "CAPTURE_FAILED", gen: s.gen });
  assert.equal(err.state.noticeKey, "asrRetry");
});

await check("návrat zo Settings zhodí zastaranú chybu mikrofónu; bez mikrofónovej chyby nič", () => {
  let s = voiceSessionReducer(INITIAL_VOICE_SESSION, { type: "START" }).state;
  s = voiceSessionReducer(s, { type: "MIC_FAILED", reason: "blocked", gen: s.gen }).state;
  assert.equal(s.status, "error");
  const cleared = voiceSessionReducer(s, { type: "CLEAR_MIC_ERROR" });
  assert.equal(cleared.state.status, "idle");
  assert.equal(cleared.state.micFailure, undefined);
  assert.equal(cleared.effects.length, 0, "nič sa samo nespúšťa");
  const live = at("listening");
  assert.equal(voiceSessionReducer(live, { type: "CLEAR_MIC_ERROR" }).state, live, "aktívna relácia sa nemení");
});

await check("dvojitý štart / neskoré dokončenie staršieho kola nič nezdvojí", () => {
  const s = at("listening");
  assert.equal(voiceSessionReducer(s, { type: "START" }).state, s);
  assert.equal(voiceSessionReducer(s, { type: "UTTERANCE_CAPTURED", gen: s.gen - 1 }).state, s);
});

await check("hook: Otvoriť nastavenia aj pri „denied“ (natívne), CLEAR_MIC_ERROR na návrat do appky, audio nikdy neprežije reláciu", () => {
  const hook = read("hooks/use-voice-session.ts");
  assert.match(hook, /session\.micFailure === "blocked" \|\| session\.micFailure === "denied"/);
  assert.match(hook, /else if \(active === true\) dispatchRef\.current\(\{ type: "CLEAR_MIC_ERROR" \}\)/);
  assert.match(hook, /if \(stateRef\.current\.gen !== gen \|\| stateRef\.current\.status !== "listening"\) return;/);
  assert.match(hook, /blobRef\.current = null;\s*\n\s*\}/);
  assert.match(hook, /dispatch\(\{ type: "CAPTURE_FAILED", tooLong: true, gen \}\)/);
});

await check("Android: ACCESS_NETWORK_STATE (offline detekcia), RECORD_AUDIO, bez polohy/kontaktov", () => {
  const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android\.permission\.ACCESS_NETWORK_STATE/);
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.ok(!/ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|READ_CONTACTS|WRITE_EXTERNAL_STORAGE/.test(manifest));
});

// =============================================================================
// B. Navigácia
// =============================================================================

console.log("\nB. Navigácia");

for (const [phrase, href] of [
  ["Otvor faktúry", "/faktury"],
  ["Choď na partnerov", "/obchodni-partneri"],
  ["Otvor sklad", "/sklad"],
] as const) {
  await check(`„${phrase}“ → ${href} (deterministicky, bez AI, bez zápisu)`, async () => {
    const e = env();
    const r = await say(e, phrase);
    assert.equal(r.kind, "navigate", JSON.stringify(r));
    assert.equal((r as { entity: { href: string } }).entity.href, href);
    assert.equal(writes(e), 0);
  });
}

await check("navigácia rešpektuje rolu: zamestnanec neotvorí faktúry", async () => {
  const r = await say(env("employee"), "Otvor faktúry");
  assert.notEqual(r.kind, "navigate");
});

// =============================================================================
// C. Read-only
// =============================================================================

console.log("\nC. Read-only");

await check("„Koľko mám neuhradených faktúr“ → odpoveď, žiadny zápis", async () => {
  const e = env();
  assert.equal(parseIntentDeterministic("Koľko mám neuhradených faktúr?")?.name, "SHOW_UNPAID_INVOICES");
  const r = await say(e, "Koľko mám neuhradených faktúr?");
  assert.ok(["answer", "list", "not_found"].includes(r.kind), JSON.stringify(r));
  assert.equal(writes(e), 0);
});

await check("„Nájdi partnera Lesy Horehronie“ → otvorí partnera; nejednoznačné „Stavby“ → výber", async () => {
  const e = env();
  const one = await say(e, "Nájdi partnera Lesy Horehronie");
  assert.equal(one.kind, "navigate", JSON.stringify(one));
  assert.ok((one as { entity: { href: string } }).entity.href.includes(P_LESY));
  const many = await say(e, "Nájdi partnera Stavby");
  assert.ok(["disambiguate", "list"].includes(many.kind), JSON.stringify(many));
  assert.equal(writes(e), 0);
});

await check("„Koľko mám vozidiel“ → zoznam vozidiel firmy, hlas povie počet (bez AI)", async () => {
  for (const phrase of ["Koľko mám vozidiel?", "koľko máme vozidiel", "Koľko vozidiel máme v evidencii?"]) {
    const p = parseIntentDeterministic(phrase);
    assert.equal(p?.name, "SEARCH_VEHICLE", phrase);
    assert.equal((p?.args as { listAll?: boolean }).listAll, true, phrase);
  }
  const e = env();
  const r = await say(e, "Koľko mám vozidiel?");
  assert.equal(r.kind, "list", JSON.stringify(r));
  assert.equal((r as { items: unknown[] }).items.length, 2);
  assert.match(spokenTextFor(r) ?? "", /: 2$/);
  assert.equal(writes(e), 0);
  assert.equal(parseIntentDeterministic("Koľko máme strojov?")?.name, "SEARCH_MACHINE");
  assert.equal(parseIntentDeterministic("koľko máme spreja")?.name, "INVENTORY_ITEM_STATUS", "stav položky ostáva");
});

// =============================================================================
// D. Zápis — návrh → súhrn → výslovné potvrdenie → jeden doklad
// =============================================================================

console.log("\nD. Zápis faktúry");

const WRITE_PHRASE = "Vytvor faktúru pre Lesy Horehronie, položka kopanie, 300 eur, 23 percent";

await check("presná veta zo zadania sa rozpozná celá (položka, cena, DPH)", () => {
  const slots = extractInvoiceSlotsFromText(WRITE_PHRASE, "Lesy Horehronie");
  assert.deepEqual(slots.items, [{ description: "kopanie", unitPrice: 300, currency: "EUR" }]);
  assert.equal(slots.vatRate, 23);
});

await check("veta → IBA návrh: súhrn s partnerom, položkou, sumou a DPH; tlačidlá Áno/Nie; 0 dokladov", async () => {
  const e = env();
  const r = await say(e, WRITE_PHRASE);
  assert.equal(r.kind, "clarify", JSON.stringify(r));
  const q = question(r);
  for (const part of ["Lesy Horehronie", "kopanie", "300", "DPH 23 %"]) assert.ok(q.includes(part), `${part} v „${q}“`);
  assert.equal((r as { quickReplies?: unknown[] }).quickReplies?.length, 2);
  assert.equal(invoices(e), 0);
});

await check("výslovné „áno“ → presne jeden draft; opakované „áno“ duplicitu nevytvorí", async () => {
  const e = env();
  await say(e, WRITE_PHRASE);
  const created = await say(e, "Áno.");
  assert.equal(created.kind, "draft_created", JSON.stringify(created));
  assert.equal(invoices(e), 1);
  const again = await say(e, "Áno.");
  assert.notEqual(again.kind, "draft_created");
  assert.equal(invoices(e), 1);
});

await check("súbežné dvojité „áno“ (dvojklik / dva zariadenia) → stále jeden draft (atomický claim)", async () => {
  const e = env();
  await say(e, WRITE_PHRASE);
  const [a, b] = await Promise.all([say(e, "Áno."), say(e, "Áno.")]);
  assert.equal([a, b].filter((r) => r.kind === "draft_created").length, 1, `${a.kind} / ${b.kind}`);
  assert.equal(invoices(e), 1);
});

await check("hlasový zápis bez konverzácie (písaný príkaz na nástenke) sa nevykoná", async () => {
  const e = env();
  const r = await say(e, WRITE_PHRASE, { conversationId: null });
  assert.notEqual(r.kind, "draft_created");
  assert.equal(invoices(e), 0);
});

await check("draft nemá číslo, splatnosť ani VS z hlasu (doplní ich človek vo formulári)", async () => {
  const e = env();
  await say(e, WRITE_PHRASE);
  await say(e, "Áno.");
  const row = (e.state.tables.invoices ?? [])[0] ?? {};
  assert.ok(!row.invoice_number, "bez čísla");
  assert.equal(row.due_date ?? null, null);
  assert.equal(row.variable_symbol ?? null, null);
});

// =============================================================================
// E. Nejasnosti — nikdy automatický zápis
// =============================================================================

console.log("\nE. Nejasnosti");

await check("nejasná suma → otázka, 0 dokladov aj po „áno“", async () => {
  const e = env();
  const r = await say(e, "Vytvor faktúru pre Lesy Horehronie, kopanie, neviem koľko eur");
  assert.equal(r.kind, "clarify", JSON.stringify(r));
  assert.ok(!question(r).includes("Mám ho vytvoriť"), "nie je to potvrdenie návrhu");
  await say(e, "Áno.");
  assert.equal(invoices(e), 0);
});

await check("nejasný partner („Stavby“ = dvaja partneri) → výber, nie tichá voľba; „áno“ nič nevytvorí", async () => {
  const e = env();
  const r = await say(e, "Vytvor faktúru pre Stavby, kopanie 300 eur, 23 percent");
  assert.equal(r.kind, "clarify", JSON.stringify(r));
  assert.ok(!question(r).includes("Mám ho vytvoriť"), question(r));
  await say(e, "Áno.");
  assert.equal(invoices(e), 0);
});

await check("presná zhoda mena („Stavby Kysuce“ = Stavby Kysuce s.r.o.) → súhrn vysloví celý názov aj IČO pred „áno“", async () => {
  const e = env();
  const r = await say(e, "Vytvor faktúru pre Stavby Kysuce, kopanie 300 eur, 23 percent");
  const q = question(r);
  assert.equal(r.kind, "clarify", JSON.stringify(r));
  assert.ok(q.includes("Stavby Kysuce s.r.o.") && q.includes("52345678"), q);
  assert.equal(invoices(e), 0);
});

await check("neznámy partner → nezaloží sa ani partner, ani doklad", async () => {
  const e = env();
  await say(e, "Vytvor faktúru pre Neexistujúca Firma s.r.o., kopanie 300 eur, 23 percent");
  await say(e, "Áno.");
  assert.equal(invoices(e), 0);
  assert.equal(e.state.tables.business_partners.length, 3);
});

await check("číslo faktúry vyslovené v príkaze sa NEpoužije ako číslo dokladu", async () => {
  const e = env();
  await say(e, "Vytvor faktúru číslo 2026001 pre Lesy Horehronie, kopanie 300 eur, 23 percent");
  await say(e, "Áno.");
  for (const row of e.state.tables.invoices ?? []) assert.ok(!row.invoice_number, "žiadne číslo z hlasu");
});

await check("chýbajúci/neoverený lokálny dátum → fail-closed, žiadny doklad", async () => {
  const e = env();
  await say(e, WRITE_PHRASE, { issueDate: null });
  const r = await say(e, "Áno.", { issueDate: null });
  assert.notEqual(r.kind, "draft_created", JSON.stringify(r));
  assert.equal(invoices(e), 0);
});

await check("IBAN / suma / dátum namiesto „áno“ pri potvrdení → otázka znova, 0 dokladov", async () => {
  const e = env();
  await say(e, WRITE_PHRASE);
  for (const reply of ["SK31 1200 0000 1987 4263 7541", "15. 10. 2026", "300", "možno"]) {
    const r = await say(e, reply);
    assert.notEqual(r.kind, "draft_created", reply);
    assert.equal(invoices(e), 0, reply);
  }
});

await check("nečitateľná DPH („dvadsať celých“) sa nedosadí potichu", () => {
  assert.equal(findVatRate("kopanie 300 eur dvadsať celých percent"), null);
  assert.equal(findNumber("dvadsať celých"), null);
});

// =============================================================================
// F. Kritické akcie — hlasové „áno“ nestačí
// =============================================================================

console.log("\nF. Kritické akcie");

const preview = (action: Preview["action"], destructive?: boolean): Preview => ({
  kind: "action_preview",
  action,
  summary: "…",
  confirmLabel: "Potvrdiť",
  cancelLabel: "Zrušiť",
  confirmationId: "x",
  ...(destructive !== undefined ? { destructive } : {}),
});

await check("mazanie: hlasové „áno“ → tap_required pre každý DELETE náhľad", () => {
  for (const action of ["VEHICLE_DELETE", "MACHINE_DELETE", "INVENTORY_ITEM_DELETE", "FOLDER_DELETE", "INBOX_DELETE_UNASSIGNED"] as const) {
    for (const yes of ["Áno", "áno, zmaž to", "jasné", "potvrdzujem"]) {
      assert.notEqual(decideVoiceReplyForPreview(yes, preview(action)), "confirm", `${action}: ${yes}`);
    }
  }
  assert.equal(decideVoiceReplyForPreview("Áno", preview("INVENTORY_QUANTITY_ADJUST", true)), "tap_required");
});

await check("„Zmaž vozidlo Ford Transit“ → iba náhľad (nič zmazané); AI delete nikdy neprejde", async () => {
  const e = env();
  const r = await say(e, "Zmaž vozidlo Ford Transit");
  assert.ok(r.kind !== "action_result", JSON.stringify(r));
  assert.equal(e.state.tables.vehicles.length, 2);
  if (r.kind === "action_preview") assert.equal(decideVoiceReplyForPreview("Áno", r), "tap_required");
  const fromAi = sanitizeAiIntent({ name: "VEHICLE_DELETE", args: { query: "Ford Transit" }, source: "ai" } as never, "zmaž ford");
  assert.equal(fromAi, null, "AI klasifikátor nesmie vyrobiť mazanie");
});

await check("zrušenie účtu hlasom neexistuje: „Zmaž môj účet“ → žiadna akcia, žiadny náhľad", async () => {
  for (const phrase of ["Zmaž môj účet", "Vymaž účet", "Zruš môj Esblu účet"]) {
    const e = env();
    const r = await say(e, phrase);
    assert.notEqual(r.kind, "action_preview", phrase);
    assert.notEqual(r.kind, "action_result", phrase);
    assert.equal(writes(e), 0, phrase);
  }
  assert.ok(!read("lib/intents/types.ts").includes("ACCOUNT_DELETE"), "žiadny intent na zrušenie účtu");
});

await check("platba hlasom neexistuje: „Zaplať faktúru 2026001“ / „Uhraď“ → nič sa nevykoná", async () => {
  for (const phrase of ["Zaplať faktúru 2026001", "Uhraď faktúru pre Lesy Horehronie", "Pošli platbu 300 eur"]) {
    const e = env();
    const r = await say(e, phrase);
    assert.notEqual(r.kind, "action_result", phrase);
    assert.notEqual(r.kind, "draft_created", phrase);
    assert.equal(writes(e), 0, phrase);
    if (r.kind === "action_preview") assert.notEqual(decideVoiceReplyForPreview("Áno", r), "confirm", phrase);
  }
  assert.ok(!/PAY|PAYMENT|TRANSFER/.test(read("lib/intents/types.ts").match(/INTENT_NAMES[\s\S]*?\]/)?.[0] ?? ""), "žiadny platobný intent");
});

await check("server: potvrdenie zápisu je jednorazové a podpísané (confirmationId), nie text „áno“", () => {
  const execute = read("app/api/assistant/action/execute/route.ts");
  assert.match(execute, /confirmationId/);
  assert.ok(!/rawText|transcript/.test(execute), "execute nikdy neberie text");
});

// =============================================================================
// G. Slovenský prepis a čísla
// =============================================================================

console.log("\nG. Slovenské čísla, identifikátory, prepis");

await check("„tisíc dvesto“ = 1200, „dvanásť tisíc“ = 12000, „dvetisíc päťsto“ = 2500", () => {
  assert.equal(findNumber("tisíc dvesto")?.value, 1200);
  assert.equal(findNumber("dvanásť tisíc")?.value, 12000);
  assert.equal(findNumber("dvetisíc päťsto")?.value, 2500);
});

await check("desatinné čísla: „dvadsať celých päť“ = 20,5; „tri celé dva“ = 3,2; „sto celých nula päť“ = 100,05; „300,50“", () => {
  assert.equal(findNumber("dvadsať celých päť")?.value, 20.5);
  assert.equal(findNumber("tri celé dva")?.value, 3.2);
  assert.equal(findNumber("sto celých nula päť")?.value, 100.05);
  assert.equal(findNumber("dvadsať celých dvadsaťpäť")?.value, 20.25);
  assert.equal(findNumber("300,50 eur")?.value, 300.5);
  assert.equal(findNumber("1.234,50 eur")?.value, 1234.5);
});

await check("sumy EUR v položkách: „1 250,50 €“, „tisíc dvesto eur“, desatinná cena slovami", () => {
  assert.deepEqual(extractInvoiceSlotsFromText("kopanie 1 250,50 €").items?.[0]?.unitPrice, 1250.5);
  assert.deepEqual(extractInvoiceSlotsFromText("odvoz materiálu tisíc dvesto eur").items?.[0]?.unitPrice, 1200);
  assert.deepEqual(extractInvoiceSlotsFromText("kopanie dvesto celých päťdesiat eur").items?.[0]?.unitPrice, 200.5);
});

await check("sadzby DPH: 23 %, 20 %, 19 %, 5 %, 0 %, „dvadsaťtri percent“, „dvadsať celých päť percent“", () => {
  assert.equal(findVatRate("23 percent"), 23);
  assert.equal(findVatRate("s DPH 20 %"), 20);
  assert.equal(findVatRate("19 percent"), 19);
  assert.equal(findVatRate("päť percent"), 5);
  assert.equal(findVatRate("nula percent"), 0);
  assert.equal(findVatRate("kopanie 300 eur, dvadsaťtri percent"), 23);
  assert.equal(findVatRate("kopanie 300 eur dvadsať celých päť percent"), 20.5);
  assert.equal(findVatRate("faktúra za 300 eur percent"), null, "suma nie je sadzba");
});

await check("DPH je v súhrne pred potvrdením (aj desatinná)", () => {
  const slots = extractInvoiceSlotsFromText("kopanie 300 eur dvadsať celých päť percent");
  assert.equal(slots.vatRate, 20.5);
  const q = buildDraftConfirmQuestion("sk", slots, "Lesy Horehronie s.r.o.");
  assert.ok(q.includes("DPH 20,5 %"), q);
});

await check("firma + IČO + DIČ + IČ DPH z hlasu (nový partner, fiktívne údaje)", () => {
  const p = parseIntentDeterministic("Pridaj nového partnera Lesy Horehronie s.r.o., IČO 51 234 567, DIČ 2023456789, IČ DPH SK2023456789");
  assert.equal(p?.name, "PARTNER_CREATE", JSON.stringify(p));
  const args = p?.args as Record<string, string | undefined>;
  assert.equal(args.entityName, "Lesy Horehronie s.r.o.");
  assert.equal(args.partnerIco, "51234567", "medzery z prepisu odstránené");
  assert.equal(args.partnerDic, "2023456789");
  assert.equal(args.partnerIcDph, "SK2023456789");
  const spaced = parseIntentDeterministic("Pridaj partnera Lesy Horehronie s.r.o., IČO 51234567, IČ DPH SK 2023456789");
  assert.equal((spaced?.args as Record<string, string>).partnerIcDph, "SK2023456789");
});

await check("osoba ako partner (fiktívna): „Pridaj nového partnera Ján Novák“", () => {
  const p = parseIntentDeterministic("Pridaj nového partnera Ján Novák");
  assert.equal(p?.name, "PARTNER_CREATE", JSON.stringify(p));
  assert.match(JSON.stringify(p?.args), /Ján Novák/);
});

await check("číslo faktúry: „Otvor faktúru FA-2026-7“ → vyhľadanie dokladu (read-only)", () => {
  const p = parseIntentDeterministic("Otvor faktúru FA-2026-7");
  assert.equal(p?.name, "SEARCH_INVOICE", JSON.stringify(p));
});

await check("prepisový prompt: SK slovník (IČO, DIČ, IČ DPH, IBAN, splatnosť, číslice), bez firemných dát", () => {
  const route = read("app/api/assistant/transcribe/route.ts");
  for (const term of ["IČO", "DIČ", "IČ DPH", "IBAN", "číslo faktúry", "splatnosť", "s.r.o.", "zapíš číslicami"]) assert.ok(route.includes(term), term);
  assert.match(route, /language: locale/);
  assert.match(route, /model: "gpt-4o-transcribe"/);
  assert.ok(!/legal_name|business_partners|\.from\(/.test(route), "prompt neobsahuje dáta z DB");
});

// =============================================================================
// H. Súkromie a AI runtime
// =============================================================================

console.log("\nH. Súkromie a AI runtime");

await check("OpenAI kľúč: chýbajúci = AI nedostupná (žiadny pád pri importe), hodnota sa nikdy nevracia", () => {
  assert.equal(isOpenAiConfigured({}), false);
  assert.equal(isOpenAiConfigured({ OPENAI_API_KEY: "  " }), false);
  assert.equal(isOpenAiConfigured({ OPENAI_API_KEY: "disabled" }), false, "zástupná hodnota stagingu");
  assert.equal(isOpenAiConfigured({ OPENAI_API_KEY: "placeholder" }), false);
  assert.equal(isOpenAiConfigured({ OPENAI_API_KEY: "sk-test-0000000000" }), true, "tvar kľúča (fiktívny)");
  let built = 0;
  const get = lazyAiClient(() => ({ id: ++built }), {});
  assert.equal(get(), null);
  assert.equal(built, 0, "bez kľúča sa klient nevytvorí");
  const get2 = lazyAiClient(() => ({ id: ++built }), { OPENAI_API_KEY: "sk-test-0000000000" });
  assert.equal(get2(), get2(), "singleton");
  for (const file of ["app/api/assistant/transcribe/route.ts", "lib/intents/ai-fallback.ts"]) {
    const src = read(file);
    assert.ok(!/^const client = new OpenAI/m.test(src), `${file}: klient na úrovni modulu`);
    assert.match(src, /lazyAiClient\(/, file);
  }
  assert.match(read("app/api/assistant/transcribe/route.ts"), /status: 503/);
});

await check("logy: chyby OpenAI iba ako {name,status,code,type} — nikdy message (fragment kľúča)", () => {
  const meta = safeAiErrorMeta(Object.assign(new Error("Incorrect API key provided: sk-proj-****abcd"), { status: 401, code: "invalid_api_key", headers: { authorization: "Bearer sk-x" } }));
  assert.deepEqual(meta, { name: "Error", status: 401, code: "invalid_api_key" });
  assert.ok(!JSON.stringify(meta).includes("sk-"));
  for (const file of ["app/api/assistant/transcribe/route.ts", "lib/intents/ai-fallback.ts"]) {
    const src = read(file);
    assert.ok(!/console\.(error|warn|log)\([^;]*\.message/.test(src), `${file}: loguje error.message`);
  }
});

await check("audio iba v pamäti; prepis/audio/token sa nelogujú; mikrofón sa vždy zastaví", () => {
  const files = ["hooks/use-voice-session.ts", "lib/voice/utterance-capture.ts", "lib/voice/voice-session.ts", "lib/voice/assistant-http.ts", "app/api/assistant/transcribe/route.ts", "app/api/assistant/intent/route.ts"];
  for (const file of files) {
    const src = read(file);
    assert.ok(!/createObjectURL|indexedDB|writeFile|Filesystem\.|localStorage\.setItem\([^)]*(audio|transcript|text)/i.test(src), `${file}: perzistencia`);
    assert.ok(!/console\.\w+\([^)]*\b(rawText|transcript|transcription\.text|access_token|Authorization)\b/.test(src), `${file}: log citlivého obsahu`);
  }
  const capture = read("lib/voice/utterance-capture.ts");
  assert.match(capture, /getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)|track\.stop\(\)/);
  assert.match(capture, /\.close\(\)/, "AudioContext sa zatvára");
  const intent = read("app/api/assistant/intent/route.ts");
  assert.match(intent, /textLength/, "intent loguje iba dĺžku textu");
});

await check("i18n: nové hlasové oznámenia existujú v sk/en/de", () => {
  for (const locale of ["sk", "en", "de"] as const) {
    for (const key of ["search.voice.errors.aiUnavailable", "search.voice.session.aiUnavailable", "search.voice.session.rateLimited", "search.voice.invoice.vatSuffix"]) {
      const value = translate(locale, key, { rate: "23" });
      assert.ok(value && value !== key, `${locale}: ${key}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
