// =============================================================================
// Asistent — stavové prechody cez TEN ISTÝ orchestrátor, ktorý volá
// /api/assistant/intent (lib/intents/orchestrator.ts#runAssistantTurnDetailed).
//
// SPUSTENIE
//   npm run test:assistant-orchestrator
//
// Nie je to test parsera: každá veta prejde celým poradím (aktívna úloha →
// parser → zamestnanec → AI → poistky → brána oprávnení → handler → otázka)
// nad pamäťovou DB s väzbou na firmu. Obsahuje presné produkčné zlyhania z
// mobilu (A–G) a maticu rolí / cudzej firmy / AI fallbacku.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "cd".repeat(32);
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { makeDb, COMPANY_A, COMPANY_B, USER_A, type Row, type Role, type Tables } from "./support/memory-db.ts";

const { runAssistantTurnDetailed, sanitizeAiIntent } = await import("@/lib/intents/orchestrator");
const { executeAction } = await import("@/lib/intents/actions");
const { classifyConfirmationReply } = await import("@/lib/intents/confirmation-reply");
const { translate } = await import("@/lib/i18n/translate");

type IntentResult = import("@/lib/intents/types").IntentResult;
type ParsedIntent = import("@/lib/intents/types").ParsedIntent;

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const CONV = "fedcba9876543210fedcba9876543210";
const P_T1 = "00000000-0000-4000-8000-0000000000e1";
const P_ST = "00000000-0000-4000-8000-0000000000e2";

const PARTNERS = (): Tables => ({
  business_partners: [
    { id: P_T1, legal_name: "Tester1", ico: "12345678", company_id: COMPANY_A },
    { id: P_ST, legal_name: "Stavby s.r.o.", ico: "87654321", company_id: COMPANY_A },
    { id: "00000000-0000-4000-8000-0000000000b9", legal_name: "Cudzia firma B", ico: "99999999", company_id: COMPANY_B },
  ],
});

const ACCESS: Record<Role, (f: boolean) => { financeView: boolean; financeManage: boolean; canOperate: boolean }> = {
  owner: () => ({ financeView: true, financeManage: true, canOperate: true }),
  admin: (f) => ({ financeView: f, financeManage: f, canOperate: true }),
  accountant: () => ({ financeView: true, financeManage: true, canOperate: false }),
  // Zamestnanec — aj s podvrhnutými financiami (forge) ostáva bez asistenta.
  employee: (f) => ({ financeView: f, financeManage: f, canOperate: true }),
};

type Env = ReturnType<typeof makeDb>;

/** Relácia ako v UI: drží conversationId a zapečatenú otázku medzi vetami. */
function session(env: Env, opts: { module?: string; conversationId?: string | null; ai?: (text: string) => ParsedIntent | null } = {}) {
  let pending: string | null = null;
  let aiCalls = 0;
  const ctx = ACCESS[env.state.role](env.state.financeManage);
  return {
    get aiCalls() { return aiCalls; },
    get pending() { return pending; },
    async say(text: string, extra: { module?: string } = {}) {
      const { output, finalIntent } = await runAssistantTurnDetailed(
        {
          db: env.db,
          classifyWithAi: async (raw) => { aiCalls++; return opts.ai ? opts.ai(raw) : null; },
        },
        {
          rawText: text,
          locale: "sk",
          userId: env.userId,
          companyId: env.companyId,
          role: env.state.role,
          ...ctx,
          conversationId: opts.conversationId === undefined ? CONV : opts.conversationId,
          pendingClarification: pending,
          structuredPartnerId: null,
          issueDate: "2026-09-25",
          uiContext: null,
          moduleContext: (extra.module ?? opts.module) as never,
          selection: null,
          folderContextId: null,
        }
      );
      pending = output.pendingClarification ?? null;
      return { output, result: output.result, intent: finalIntent };
    },
  };
}

// Intl formátuje tisíce nezalomiteľnou medzerou — na porovnanie stačí bežná.
const say = (r: IntentResult) => ((r as { text?: string }).text ?? (r as { question?: string }).question ?? (r as { summary?: string }).summary ?? "").replace(/\u00a0/g, " ");
const stored = (env: Env) => env.state.conversations.get(`${env.userId}|${env.companyId}|${CONV}`) as Row | undefined;
const slots = (env: Env) => (stored(env)?.slots ?? {}) as Row;
const slotsOfEnv = slots;
const field = (env: Env) => ((stored(env)?.missing_fields ?? []) as string[])[0];
const items = (env: Env) => ((slots(env).items ?? []) as Row[]).map((i) => [i.description, i.unitPrice]);
const t = (key: string, vars?: Record<string, string | number>) => translate("sk", key, vars);
const PARTNER_NOT_FOUND = /Obchodného partnera .* som nenašiel/;

// =============================================================================
// FAKTÚRA — prechody stavov
// =============================================================================

await check("INVOICE: štart → partner → viac položiek → DPH → draft (nefinalizovaný)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  assert.equal(say((await s.say("Vytvor faktúru.")).result), t("search.voice.invoice.askPartner"));
  assert.equal(field(env), "partner");
  assert.equal(say((await s.say("Tester1.")).result), t("search.voice.invoice.askDescription"));
  assert.equal(field(env), "items");
  const r3 = await s.say("Za kopanie suma 300 eur, za odvoz materiálu suma 650 eur a za dvoch pracovníkov suma 830 eur.");
  assert.equal(r3.result.kind, "clarify");
  assert.equal(field(env), "vat");
  assert.deepEqual(items(env), [["kopanie", 300], ["odvoz materiálu", 650], ["dvoch pracovníkov", 830]]);
  const r4 = await s.say("23 percent.");
  assert.equal(r4.result.kind, "draft_created", JSON.stringify(r4.result));
  const invoice = env.state.tables.invoices.at(-1) as Row;
  assert.equal(invoice.customer_business_partner_id, P_T1);
  assert.equal(invoice.invoice_number ?? null, null, "draft nemá číslo");
  assert.notEqual(invoice.document_status, "final");
  assert.equal(env.state.tables.invoice_items.length, 3);
  assert.deepEqual((env.state.tables.invoice_items as Row[]).map((i) => [i.quantity, i.unit_price]), [[1, 300], [1, 650], [1, 830]], "žiadne vymyslené množstvo");
});

await check("REAL A: „Za čo má byť faktúra?“ → presná veta z mobilu = 3 položky, NIKDY hľadanie partnera", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  await s.say("Vytvor faktúru pre Tester1.");
  assert.equal(field(env), "items");
  const r = await s.say("Za kopanie suma 300 eur, za odvoz materiálu suma 650 eur a za dvoch pracovníkov suma 830 eur.");
  assert.doesNotMatch(say(r.result), PARTNER_NOT_FOUND);
  assert.notEqual(say(r.result), t("search.voice.invoice.askDescription"), "otázka sa neopakuje");
  assert.equal(slots(env).partnerId, P_T1);
  assert.equal(items(env).length, 3);
  assert.equal(s.aiCalls, 0, "AI sa pri aktívnej úlohe nevolá");
});

await check("REAL B: „Vytvor faktúru Tester1 za kopanie, za odvoz, za pracovníkov, suma spolu 1832 eur.“ → partner, 3 popisy, súčet, otázka na ceny", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env, { ai: () => ({ name: "VEHICLE_CREATE", args: {}, source: "ai" }) });
  const r = await s.say("Vytvor faktúru Tester1 za kopanie, za odvoz materiálu, za pracovníkov, suma spolu 1832 eur.");
  assert.equal(r.intent?.name, "CREATE_INVOICE_DRAFT");
  assert.equal(s.aiCalls, 0, "o faktúre nerozhoduje AI");
  assert.equal(r.result.kind, "clarify");
  assert.equal(slots(env).partnerId, P_T1);
  assert.equal(slots(env).statedTotal, 1832);
  assert.deepEqual(items(env), [["kopanie", undefined], ["odvoz materiálu", undefined], ["pracovníkov", undefined]], "nič sa nerozpočítalo");
  assert.equal(field(env), "itemPrice");
  assert.equal(say(r.result), "Rozumiem 3 položkám — kopanie, odvoz materiálu a pracovníkov — a celkovej sume 1 832 €. Aké sú ceny jednotlivých položiek?");
  assert.equal(env.state.confirmations.length, 0);
  assert.equal((env.state.tables.vehicles ?? []).length, 0);
});

await check("REAL B pokračovanie: ceny so súčtom 1832 → DPH; nesúlad → otázka, nič sa neupraví; oprava → DPH", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  await s.say("Vytvor faktúru Tester1 za kopanie, za odvoz materiálu, za pracovníkov, suma spolu 1832 eur.");
  const bad = await s.say("Kopanie 300, odvoz 650, pracovníci 800 eur.");
  assert.equal(field(env), "total");
  assert.match(say(bad.result), /Súčet položiek je 1 750 €, ale celková suma bola 1 832 €\. Nič som neupravil\./);
  assert.deepEqual(items(env), [["kopanie", 300], ["odvoz materiálu", 650], ["pracovníkov", 800]]);
  const fix = await s.say("Zmeň pracovníkov na 882 eur.");
  assert.match(say(fix.result), /Cenu položky „pracovníkov“ som zmenil na 882\./);
  assert.equal(field(env), "vat");
  assert.equal(slots(env).partnerId, P_T1);
});

await check("REAL B: holé ceny v poradí otázky „300, 650 a 882 eur“ → priradené, súčet sedí", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  await s.say("Vytvor faktúru Tester1 za kopanie, za odvoz materiálu, za pracovníkov, suma spolu 1832 eur.");
  await s.say("300, 650 a 882 eur.");
  assert.deepEqual(items(env), [["kopanie", 300], ["odvoz materiálu", 650], ["pracovníkov", 882]]);
  assert.equal(field(env), "vat");
});

await check("REAL C: po otázke o položkách „Kopanie, odvoz materiálu, pracovníci.“ → otázka na ceny, NIKDY „partnera som nenašiel“", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  await s.say("Vytvor faktúru pre Tester1.");
  const r = await s.say("Kopanie, odvoz materiálu, pracovníci.");
  assert.doesNotMatch(say(r.result), PARTNER_NOT_FOUND);
  assert.equal(field(env), "itemPrice");
  assert.match(say(r.result), /Aké sú ceny položiek Kopanie, odvoz materiálu a pracovníci\?/);
  assert.equal(slots(env).partnerId, P_T1);
});

await check("REAL C (pôvodná príčina): nejasné položky pri štarte → uložené prvé pole je otázka o POLOŽKÁCH, nie partner", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  const r = await s.say("Vytvor faktúru pre Tester1 za kopanie 300 eur, doprava.");
  assert.equal(r.result.kind, "clarify");
  assert.equal(slots(env).partnerId, P_T1, "partner vyriešený pred položkami");
  assert.equal(field(env), "items");
  const next = await s.say("Kopanie 300 eur, doprava 100 eur.");
  assert.doesNotMatch(say(next.result), PARTNER_NOT_FOUND);
  assert.deepEqual(items(env), [["Kopanie", 300], ["doprava", 100]]);
});

await check("čaká sa na partnera → veta s položkami NIE JE meno partnera (položky sa zapamätajú)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  await s.say("Vytvor faktúru.");
  const r = await s.say("Kopanie 300 eur, doprava 100 eur.");
  assert.doesNotMatch(say(r.result), PARTNER_NOT_FOUND);
  assert.equal(say(r.result), `${t("search.voice.invoice.itemsKeptAskPartner")} ${t("search.voice.invoice.askPartner")}`);
  assert.equal(field(env), "partner");
  assert.deepEqual(items(env), [["Kopanie", 300], ["doprava", 100]]);
  await s.say("Tester1.");
  assert.equal(slots(env).partnerId, P_T1);
  assert.equal(field(env), "vat", "položky ostali, pýta sa ďalej na DPH");
});

await check("faktúra čaká na položky → „Ukáž sklad.“ = nový príkaz, dialóg zrušený", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  await s.say("Vytvor faktúru pre Tester1.");
  const r = await s.say("Ukáž sklad.");
  assert.equal(r.intent?.name, "SEARCH_INVENTORY_ITEM");
  assert.equal(stored(env), undefined, "stará úloha neotráví ďalšie príkazy");
  const later = await s.say("Tester1.");
  assert.notEqual(later.intent?.name, "CREATE_INVOICE_DRAFT", "opustená faktúra sa implicitne neobnoví");
});

await check("faktúra čaká na položky → „Vytvor nový stroj.“ = nový príkaz (bez sumy)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  await s.say("Vytvor faktúru pre Tester1.");
  const r = await s.say("Vytvor nový stroj.");
  assert.equal(r.intent?.name, "MACHINE_CREATE");
  assert.equal(stored(env), undefined);
});

await check("rozpracovaná faktúra → „Pridaj ešte dopravu 80 eur.“ a „Ešte materiál 120 eur.“ → ten istý draft, ten istý partner", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  await s.say("Vytvor faktúru pre Tester1.");
  await s.say("Kopanie 300 eur.");
  await s.say("Pridaj ešte dopravu 80 eur.");
  await s.say("Ešte materiál 120 eur.");
  assert.deepEqual(items(env), [["Kopanie", 300], ["dopravu", 80], ["materiál", 120]]);
  assert.equal(slots(env).partnerId, P_T1);
  assert.equal(field(env), "vat");
});

await check("oprava: „Odstráň dopravu.“ / „Zmeň kopanie na 350 eur.“ / nejasná → otázka, nič sa nemení", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  await s.say("Vytvor faktúru pre Tester1.");
  await s.say("Kopanie 300 eur, doprava 100 eur, materiál 50 eur.");
  const removed = await s.say("Odstráň dopravu.");
  assert.match(say(removed.result), /^Odstránil som položku „doprava“\./);
  const changed = await s.say("Zmeň kopanie na 350 eur.");
  assert.match(say(changed.result), /^Cenu položky „Kopanie“ som zmenil na 350\./);
  assert.deepEqual(items(env), [["Kopanie", 350], ["materiál", 50]]);
  const unclear = await s.say("Odstráň lešenie.");
  assert.match(say(unclear.result), /Neviem jednoznačne určiť/);
  assert.deepEqual(items(env), [["Kopanie", 350], ["materiál", 50]]);
});

await check("„Zmeň odberateľa na Stavby s.r.o.“ — jediná cesta späť k partnerovi; položky ostanú", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  await s.say("Vytvor faktúru pre Tester1.");
  await s.say("Kopanie 300 eur.");
  await s.say("Zmeň odberateľa na Stavby s.r.o.");
  assert.equal(slots(env).partnerId, P_ST);
  assert.deepEqual(items(env), [["Kopanie", 300]]);
});

await check("CANCEL: „Zrušiť.“ / „Nechaj tak.“ / „Cancel.“ / „Abbrechen.“ počas faktúry → úloha zrušená, žiadna položka „Zrušiť“", async () => {
  for (const phrase of ["Zrušiť.", "Nechaj tak.", "Cancel.", "Abbrechen."]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
    const s = session(env);
    await s.say("Vytvor faktúru pre Tester1.");
    const r = await s.say(phrase);
    assert.equal(say(r.result), t("assistant.clarify.taskCancelled"), phrase);
    assert.equal(stored(env), undefined, phrase);
    assert.equal(env.state.tables.invoices.length, 0);
  }
});

await check("„Nie“ pri „Myslíte partnera …?“ odmieta IBA návrh, nie celú faktúru", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  const r = await s.say("Vytvor faktúru pre Tester jeden.");
  assert.equal(say(r.result), t("search.voice.invoice.confirmPartnerCandidate", { name: "Tester1 · 12345678" }));
  const no = await s.say("Nie.");
  assert.equal(say(no.result), t("search.voice.invoice.askPartner"));
  assert.ok(stored(env), "faktúra pokračuje");
});

await check("„Vystav faktúru pre Tester1.“ a „Nová faktúra pre Tester1.“ → iba DRAFT dialóg, nič nefinalizované", async () => {
  for (const phrase of ["Vystav faktúru pre Tester1.", "Nová faktúra pre Tester1.", "Vytvor faktúru Tester1."]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
    const r = await session(env).say(phrase);
    assert.equal(r.intent?.name, "CREATE_INVOICE_DRAFT", phrase);
    assert.equal(slots(env).partnerId, P_T1, phrase);
    assert.equal(env.state.tables.invoices.length, 0, phrase);
  }
});

await check("„Faktúra pre Horák Stav.“ (neexistuje) → nenájdený + ponuka založenia; partner sa NEZALOŽÍ; otázka na odberateľa trvá", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  // („Tester2" by bol o jedno písmeno od „Tester1" → bezpečný návrh „Myslíte …?", tiež nie založenie.)
  const r = await s.say("Faktúra pre Horák Stav.");
  assert.equal(say(r.result), t("search.voice.invoice.partnerNotFoundOfferCreate", { name: "Horák Stav" }));
  assert.equal(env.state.tables.business_partners.length, 3);
  assert.equal(field(env), "partner");
  await s.say("Tester1.");
  assert.equal(slots(env).partnerId, P_T1);
});

// =============================================================================
// PREPIS BEZ SLOVA „FAKTÚRU" + veľká suma je autoritatívna
// =============================================================================

const LOST_NOUN = "Vytvor testér jedna za kopanie materiál, odvoz materiálu, pracovníci za 10 831 eur s DPH.";

await check("REAL H: „Vytvor testér jedna za … pracovníci za 10 831 eur s DPH.“ → draft faktúry, kandidát Tester1, 3 položky, 10 831 € s DPH, otázka na ceny", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env, { ai: () => { throw new Error("AI sa nesmie volať"); } });
  const r1 = await s.say(LOST_NOUN);
  assert.equal(r1.intent?.name, "CREATE_INVOICE_DRAFT");
  assert.equal(r1.intent?.source, "deterministic");
  assert.equal(s.aiCalls, 0, "nie všeobecné hľadanie ani AI");
  assert.equal(r1.result.kind, "clarify", JSON.stringify(r1.result));
  assert.deepEqual(slots(env).partnerCandidateIds, [P_T1], "kandidát Tester1, nie automatický výber");
  assert.equal(slots(env).partnerId, undefined);
  assert.deepEqual(items(env), [["kopanie materiál", undefined], ["odvoz materiálu", undefined], ["pracovníci", undefined]]);
  assert.equal(slots(env).statedTotal, 10831, "suma presne tak, ako zaznela");
  assert.equal(slots(env).priceMode, "gross");
  assert.equal(say(r1.result),
    "Rozumiem 3 položkám — kopanie materiál, odvoz materiálu a pracovníci — a celkovej sume 10 831 € s DPH. Myslíte obchodného partnera „Tester1 · 12345678“?");
  assert.doesNotMatch(say(r1.result), /Nič sa nenašlo/);

  const r2 = await s.say("Áno.");
  assert.equal(slots(env).partnerId, P_T1);
  assert.equal(field(env), "itemPrice");
  assert.equal(say(r2.result), "Rozumiem 3 položkám — kopanie materiál, odvoz materiálu a pracovníci — a celkovej sume 10 831 € s DPH. Aké sú ceny jednotlivých položiek?");
  assert.doesNotMatch(say(r2.result), /potvr|naozaj|10 831 € správne/i, "suma sa nespochybňuje");

  // Ceny so súčtom 10 831 → ďalej na DPH; žiadne zaokrúhlenie ani úprava.
  await s.say("Kopanie materiál 5 000 eur, odvoz materiálu 2 831 eur, pracovníci 3 000 eur.");
  assert.deepEqual(items(env), [["kopanie materiál", 5000], ["odvoz materiálu", 2831], ["pracovníci", 3000]]);
  assert.equal(slots(env).statedTotal, 10831);
  assert.equal(field(env), "vat");
  assert.equal(env.state.tables.business_partners.length, 3, "partner sa nezaložil");
  for (const table of ["machines", "vehicles", "inventory_items"]) assert.equal((env.state.tables[table] ?? []).length, 0, table);
  assert.equal(env.state.confirmations.length, 0);
});

await check("veľká suma nie je dôvod na otázku: „Vytvor faktúru pre Tester1 za kopanie 10 831 eur s DPH.“ → rovno sadzba DPH", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const r = await session(env).say("Vytvor faktúru pre Tester1 za kopanie 10 831 eur s DPH.");
  assert.deepEqual(items(env), [["kopanie", 10831]]);
  assert.equal(slots(env).priceMode, "gross");
  assert.equal(field(env), "vat");
  assert.equal(say(r.result), t("search.voice.invoice.askVatAfterGross"));
});

await check("obnova bez „faktúru“ sa NESPUSTÍ pri inej oblasti, servise, bez sumy s menou; zamestnanec odmietnutý", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  for (const phrase of [
    "Vytvor priečinok August za 300 eur.",
    "Vytvor nový stroj Takeuchi za 50 000 eur.",
    "Vytvor skladovú položku Sprej za 5 eur.",
    "Vytvor servis za 250 eur.",
    "Vytvor testér jedna za kopanie materiál.",
    "Vytvor obchodného partnera Tester2 za 100 eur.",
  ]) {
    const r = await session(env).say(phrase);
    assert.notEqual(r.intent?.name, "CREATE_INVOICE_DRAFT", phrase);
  }
  const employee = makeDb({ role: "employee", financeManage: false, tables: PARTNERS() });
  const denied = await session(employee).say(LOST_NOUN);
  assert.equal(say(denied.result), t("assistant.denied.employee"));
  assert.equal(employee.state.queries, 0);
});

// =============================================================================
// HLAS: kontrakt prepisu, interná normalizácia, bezpečnosť obnovy bez „faktúru"
// =============================================================================

await check("KONTRAKT: prepis z /api/assistant/transcribe ide do /api/assistant/intent bez prepisovania", () => {
  const transcribe = readFileSync("app/api/assistant/transcribe/route.ts", "utf8");
  assert.ok(transcribe.includes('const text = transcription.text?.trim() || "";') && transcribe.includes("Response.json({ success: true, text })"));
  const hook = readFileSync("hooks/use-voice-session.ts", "utf8");
  assert.ok(hook.includes("return data.text as string;") && hook.includes('dispatch({ type: "TRANSCRIPT", text });'), "relácia odovzdá presne text servera");
  const launcher = readFileSync("app/components/voice/VoiceLauncher.tsx", "utf8");
  assert.ok(launcher.includes("setTranscript(text);") && launcher.includes("await runIntent(text);"), "launcher: zobrazený = odoslaný");
  assert.match(launcher, /body: JSON\.stringify\(\{\s*text,/);
  const dashboard = readFileSync("app/components/Dashboard.tsx", "utf8");
  assert.ok(dashboard.includes("voiceTranscriptRef.current = trimmed;") && dashboard.includes("setSearch(trimmed);") && dashboard.includes("setVoiceTranscript(trimmed);"));
  assert.ok(dashboard.includes("text: trimmed,"), "nástenka posiela obsah poľa (iba orezaný o medzery ako server)");
  const route = readFileSync("app/api/assistant/intent/route.ts", "utf8");
  assert.ok(route.includes('const rawText = typeof body?.text === "string" ? body.text.trim() : "";'));
  // Normalizácia súm je VÝHRADNE interná — klient ani route ju nepoužívajú.
  for (const file of ["hooks/use-voice-capture.ts", "hooks/use-voice-session.ts", "lib/voice/voice-session.ts", "app/components/voice/VoiceLauncher.tsx", "app/components/Dashboard.tsx", "app/api/assistant/intent/route.ts", "app/api/assistant/transcribe/route.ts", "lib/intents/orchestrator.ts"]) {
    assert.ok(!readFileSync(file, "utf8").includes("normalizeSpokenAmounts"), file);
  }
});

await check("KONTRAKT: 20 s diktovania sa zmestí do limitu textu; diagnostický log bez obsahu vety", () => {
  const route = readFileSync("app/api/assistant/intent/route.ts", "utf8");
  const limit = Number(/const MAX_TEXT_LENGTH = (\d+);/.exec(route)?.[1]);
  assert.ok(limit >= 500, `limit ${limit} je pod 20 s reči`);
  const log = route.slice(route.indexOf('"esblu_assistant_turn"'), route.indexOf("return Response.json(output);"));
  assert.ok(log.includes("textLength: rawText.length"));
  assert.ok(!/rawText[,\s})]/.test(log.replace("rawText.length", "")), "prepis sa neloguje");
  assert.ok(!/userId|companyId|partner|result\.text|question/.test(log), "žiadne identifikátory ani obsah výsledku");
});

await check("KONTRAKT: nástenka pri nerozpoznanej hlasovej vete ukáže vetu servera, nie „Nič sa nenašlo.“", () => {
  const dashboard = readFileSync("app/components/Dashboard.tsx", "utf8");
  assert.ok(dashboard.includes('isVoiceTranscript && response.ok && data?.success && data.result?.kind === "not_found"'));
  assert.ok(dashboard.includes("isVoiceTranscript && response.status === 400"));
  const launcher = readFileSync("app/components/voice/VoiceLauncher.tsx", "utf8");
  assert.ok(launcher.includes("response.status === 400 && typeof data?.error === \"string\""));
});

await check("OBNOVA bez „faktúru“ sa nespustí pri zápise inej oblasti, dokladoch, exporte, servise (SK/DE/EN)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  for (const phrase of [
    "Vytvor nové vozidlo Škoda za 9 000 eur.", "Vytvor auto za 9000 eur.", "Vytvor zložku August za 300 eur.",
    "Vytvor kategóriu Palivo za 100 eur.", "Vytvor zákazníka Firma ABC za 100 eur.", "Vytvor doklad za 300 eur.",
    "Vytvor bloček za 50 eur.", "Vytvor export bločkov za 300 eur.", "Vytvor opravu bagra za 300 eur.",
    "Vytvor výmenu oleja za 80 eur.", "Vytvor report stroja za 100 eur.",
    "Erstelle Ordner August für 300 Euro.", "Create a new machine Takeuchi for 50 000 euros.", "Add vehicle AB123CD for 300 euros.",
    "Erstelle Tester1 für Erdarbeiten 300 Euro mit MwSt.", "Create Tester1 for excavation 300 euros with VAT.",
  ]) {
    const r = await session(env).say(phrase);
    assert.notEqual(r.intent?.name, "CREATE_INVOICE_DRAFT", phrase);
  }
  // DE / EN výslovné faktúry ostávajú bez zmeny.
  for (const phrase of ["Erstelle eine Rechnung für Tester1.", "Create an invoice for Tester1.", "Neue Rechnung für Tester1."]) {
    const r = await session(env).say(phrase);
    assert.equal(r.intent?.name, "CREATE_INVOICE_DRAFT", phrase);
  }
});

// =============================================================================
// DOMÉNA BEZ AKCIE: poškodený hlasový prepis sa NESMIE zmeniť na hľadanie dokladov
// =============================================================================

const DEGRADED = "Faktúru, zakopanie, odvoz materiálu, materiál, pracovníci.";
const DOC_TABLES = (): Tables => ({
  ...PARTNERS(),
  documents: [{ id: "doc-33084", document_type: "invoice", original_filename: "33084.png", company_id: COMPANY_A, deleted_at: null, archived_from_inbox_at: null }],
});

await check("REAL C: hlas „Faktúru, zakopanie, odvoz materiálu, materiál, pracovníci.“ → otázka faktúry, NIKDY hľadanie dokladov (0 dotazov)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: DOC_TABLES() });
  const s = session(env, { ai: () => { throw new Error("AI sa nesmie volať"); } });
  const r = await s.say(DEGRADED);
  assert.equal(r.result.kind, "answer", JSON.stringify(r.result));
  assert.equal(say(r.result), "Rozumiem, že chcete pracovať s faktúrou, a zachytil som položky zakopanie, odvoz materiálu, materiál a pracovníci. Chcete vytvoriť novú faktúru?");
  assert.equal(env.state.queries, 0, "žiadny dotaz na doklady (handler hľadania sa nevolal)");
  assert.doesNotMatch(JSON.stringify(r.output), /33084|Nájdené dokumenty/);
  assert.ok(s.pending, "čaká sa na odpoveď");
  for (const table of ["machines", "vehicles", "inventory_items"]) assert.equal((env.state.tables[table] ?? []).length, 0);
  assert.equal(env.state.tables.business_partners.length, 3);
  assert.equal(env.state.confirmations.length, 0);
  assert.equal(env.state.tables.invoices.length, 0, "nič sa nezapísalo");

  const yes = await s.say("Áno.");
  assert.equal(yes.intent?.name, "CREATE_INVOICE_DRAFT");
  assert.deepEqual(items(env), [["zakopanie", undefined], ["odvoz materiálu", undefined], ["materiál", undefined], ["pracovníci", undefined]]);
  assert.equal(field(env), "partner", "partner chýba naozaj — pýta sa naň");
  assert.match(say(yes.result), /^Rozumiem 4 položkám — zakopanie, odvoz materiálu, materiál a pracovníci\. Pre ktorého odberateľa/);
});

await check("hlas „Faktúra.“ → otázka vytvoriť / vyhľadať; „Vytvoriť“ → draft; „Vyhľadať“ → čítanie", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: DOC_TABLES() });
  const s = session(env);
  const r = await s.say("Faktúra.");
  assert.equal(say(r.result), t("assistant.domain.invoiceAsk"));
  assert.equal(env.state.queries, 0);
  const create = await s.say("Vytvoriť novú.");
  assert.equal(create.intent?.name, "CREATE_INVOICE_DRAFT");
  assert.equal(say(create.result), t("search.voice.invoice.askPartner"));

  const env2 = makeDb({ role: "owner", financeManage: true, tables: DOC_TABLES() });
  const s2 = session(env2);
  await s2.say("Faktúru.");
  const search = await s2.say("Vyhľadať existujúcu.");
  assert.equal(search.intent?.name, "SEARCH_DOCUMENTS");
  assert.ok(env2.state.queries > 0, "výslovná voľba hľadania smie čítať");
});

await check("hlas s výslovnou akciou alebo filtrom → čítanie povolené („Ukáž faktúru.“, „Nájdi faktúru 2026001.“, „Otvor faktúru 2026001.“, „Faktúry za august.“)", async () => {
  for (const phrase of ["Ukáž faktúru.", "Nájdi faktúru 2026001.", "Otvor faktúru 2026001.", "Faktúry za august.", "Nájdi faktúru od Tester1."]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: DOC_TABLES() });
    const r = await session(env).say(phrase);
    // Číslo faktúry → hľadanie faktúry podľa čísla; inak hľadanie dokladov.
    assert.equal(r.intent?.name, /\d{4,}/.test(phrase) ? "SEARCH_INVOICE" : "SEARCH_DOCUMENTS", phrase);
    assert.notEqual(r.result.kind, "answer", phrase);
    assert.ok(env.state.queries > 0, phrase);
  }
});

await check("písané hľadanie na nástenke (bez dialógu) ostáva: „Faktúra“ → hľadanie dokladov", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: DOC_TABLES() });
  const r = await session(env, { conversationId: null }).say("Faktúra");
  assert.equal(r.intent?.name, "SEARCH_DOCUMENTS");
  assert.notEqual(r.result.kind, "answer");
});

await check("aktívna faktúra (čaká na položky): poškodené vety sú položky, nie partner ani hľadanie", async () => {
  for (const phrase of [DEGRADED, "kopanie, odvoz materiálu, pracovníci"]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: DOC_TABLES() });
    const s = session(env);
    await s.say("Vytvor faktúru pre Tester1.");
    const r = await s.say(phrase);
    assert.doesNotMatch(say(r.result), /partnera .* som nenašiel|Nájdené/, phrase);
    assert.equal(slots(env).partnerId, P_T1, phrase);
    assert.ok(!items(env).some(([d]) => /fakt/i.test(String(d))), `${phrase}: „Faktúru“ nie je položka`);
    assert.equal(field(env), "itemPrice", phrase);
  }
});

await check("iné oblasti bez akcie → otázka podľa práv („Stroj.“, „Sklad.“, „Vozidlo.“); bez dotazu", async () => {
  const cases: [Role, boolean, string, string][] = [
    ["owner", true, "Stroj.", "assistant.domain.machineManage"],
    ["owner", true, "Sklad.", "assistant.domain.inventoryManage"],
    ["owner", true, "Vozidlo.", "assistant.domain.vehicleManage"],
  ];
  for (const [role, fin, phrase, key] of cases) {
    const env = makeDb({ role, financeManage: fin, tables: DOC_TABLES() });
    const r = await session(env).say(phrase);
    assert.equal(say(r.result), t(key), phrase);
    assert.equal(env.state.queries, 0, phrase);
  }
  // „Stroj Takeuchi“ má konkrétny cieľ → normálne čítanie.
  const env = makeDb({ role: "owner", financeManage: true, tables: { machines: [{ id: "m1", name: "Takeuchi 323", company_id: COMPANY_A }] } });
  const r = await session(env).say("Stroj Takeuchi.");
  assert.equal(r.intent?.name, "SEARCH_MACHINE");
  assert.notEqual(r.result.kind, "answer");
});

await check("oprávnenia pred otázkou: admin bez financií „Faktúru, …“ → odmietnutie; účtovník „Stroj.“ → odmietnutie; zamestnanec → odmietnutie", async () => {
  const admin = makeDb({ role: "admin", financeManage: false, tables: DOC_TABLES() });
  assert.equal(say((await session(admin).say(DEGRADED)).result), t("assistant.denied.finance"));
  assert.equal(admin.state.queries, 0);
  const accountant = makeDb({ role: "accountant", financeManage: true, tables: DOC_TABLES() });
  assert.equal(say((await session(accountant).say("Stroj.")).result), t("assistant.denied.operational"));
  const employee = makeDb({ role: "employee", financeManage: false, tables: DOC_TABLES() });
  assert.equal(say((await session(employee).say(DEGRADED)).result), t("assistant.denied.employee"));
  assert.equal(employee.state.queries, 0);
});

await check("dlhé diktovanie (~20 s) → celé prijaté, 5 položiek, bez orezania a bez hľadania", async () => {
  const long = "Vytvor faktúru pre Tester1 za kopanie základov rodinného domu v Čadci 3 200 eur, odvoz materiálu na skládku 1 450 eur, dovoz štrku a piesku 980 eur, práca pracovníkov na stavbe 2 400 eur a prenájom malého bagra s obsluhou 1 100 eur, všetko s DPH.";
  assert.ok(long.length > 200 && long.length <= 600, String(long.length));
  const env = makeDb({ role: "owner", financeManage: true, tables: DOC_TABLES() });
  const r = await session(env).say(long);
  assert.equal(r.intent?.name, "CREATE_INVOICE_DRAFT");
  assert.deepEqual(items(env).map(([, p]) => p), [3200, 1450, 980, 2400, 1100]);
  assert.equal(slots(env).priceMode, "gross");
  assert.equal(field(env), "vat");
});

await check("UI: hlasový prepis nikdy nepadá do podreťazcového hľadania nástenky", () => {
  const dashboard = readFileSync("app/components/Dashboard.tsx", "utf8");
  assert.ok(dashboard.includes("const isVoiceQuery = voiceTranscript !== null && search === voiceTranscript;"));
  assert.ok(dashboard.includes("!hasUsableIntentResult && isVoiceQuery ?"), "hlas nerenderuje zoznam „Nájdené dokumenty“");
  assert.ok(dashboard.includes('} else if (isVoiceTranscript) {\n          // Hlas NIKDY nepadá do podreťazcového hľadania nástenky.'));
});

await check("ASR: necitlivý kontext faktúry iba z uzavretého zoznamu; žiadne dáta firmy v prompte", () => {
  const route = readFileSync("app/api/assistant/transcribe/route.ts", "utf8");
  assert.ok(route.includes('formData?.get("context") === "invoice"'));
  assert.ok(route.includes('model: "gpt-4o-transcribe"') && route.includes("language: locale"));
  assert.ok(!/from\("|supabase|business_partners/.test(route), "prepis nečíta databázu");
  const hook = readFileSync("hooks/use-voice-capture.ts", "utf8");
  assert.ok(hook.includes('export type TranscriptionContext = "invoice";'));
});

// =============================================================================
// ZDIEĽANÝ RESOLVER PARTNERA vo všetkých tokoch (syntetické firmy)
// =============================================================================

const P_SK = "00000000-0000-4000-8000-0000000000f1";
const P_SKP = "00000000-0000-4000-8000-0000000000f2";
const P_MB = "00000000-0000-4000-8000-0000000000f3";
const P_ABC = "00000000-0000-4000-8000-0000000000f4";
const MANY = (): Tables => ({
  business_partners: [
    { id: P_T1, legal_name: "Tester1", ico: "12345678", company_id: COMPANY_A },
    { id: P_SK, legal_name: "Stavby Kysuce s.r.o.", ico: "44444444", company_id: COMPANY_A },
    { id: P_SKP, legal_name: "Stavby Kysuce Plus s.r.o.", ico: "55555555", company_id: COMPANY_A },
    { id: P_MB, legal_name: "Müller Bau GmbH", ico: null, company_id: COMPANY_A },
    { id: P_ABC, legal_name: "ABC Construction GmbH", ico: null, company_id: COMPANY_A },
    { id: "00000000-0000-4000-8000-0000000000b8", legal_name: "Horák Stav s.r.o.", ico: "66666666", company_id: COMPANY_B },
  ],
});

await check("REAL: položky zachytené → otázka na odberateľa → „Tester jedna“ → návrh Tester1, položky nedotknuté, ten istý draft", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MANY() });
  const s = session(env);
  await s.say("Vytvor faktúru.");
  await s.say("Kopanie 300 eur, doprava 100 eur.");
  assert.equal(field(env), "partner");
  const before = JSON.stringify(items(env));
  const r = await s.say("Tester jedna.");
  assert.equal(say(r.result), t("search.voice.invoice.confirmPartnerCandidate", { name: "Tester1 · 12345678" }));
  assert.equal(JSON.stringify(items(env)), before, "položka „Tester“ za 1 € nevznikla");
  assert.equal(slots(env).partnerId, undefined, "podobnosť nikdy nevyberá sama");
  await s.say("Áno.");
  assert.equal(slots(env).partnerId, P_T1);
  assert.equal(JSON.stringify(items(env)), before);
  assert.equal(field(env), "vat");
});

await check("pokračovanie: holé „Stavby Kysuce.“ na otázku o odberateľovi → partner (nie položka, hľadanie ani nový príkaz)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MANY() });
  const s = session(env, { ai: () => { throw new Error("AI sa nesmie volať"); } });
  await s.say("Vytvor faktúru.");
  await s.say("Kopanie 300 eur.");
  const r = await s.say("Stavby Kysuce.");
  assert.equal(slots(env).partnerId, P_SK, JSON.stringify(r.result));
  assert.deepEqual(items(env), [["Kopanie", 300]]);
  assert.equal(s.aiCalls, 0);
  for (const [phrase, id] of [["Stavby Kysuce es er ó.", P_SK], ["Müller Bau.", P_MB], ["ABC Construction gé em bé há.", P_ABC], ["Stavby Kysuce Plus.", P_SKP]] as const) {
    const e = makeDb({ role: "owner", financeManage: true, tables: MANY() });
    const ss = session(e);
    await ss.say("Vytvor faktúru.");
    await ss.say(phrase);
    assert.equal(slotsOfEnv(e).partnerId, id, phrase);
  }
});

await check("priamy príkaz používa ten istý resolver: „pre Stavby Kysuce“, „Faktúra pre Müller Bau“, „Vystav faktúru ABC Construction“", async () => {
  for (const [phrase, id] of [
    ["Vytvor faktúru pre Stavby Kysuce.", P_SK],
    ["Faktúra pre Müller Bau.", P_MB],
    ["Vystav faktúru ABC Construction.", P_ABC],
    ["Vytvor faktúru pre Muller Bau.", P_MB],
  ] as const) {
    const env = makeDb({ role: "owner", financeManage: true, tables: MANY() });
    await session(env).say(phrase);
    assert.equal(slots(env).partnerId, id, phrase);
  }
});

await check("podobnosť / čiastočný názov → otázka, nikdy tichý výber („Miler Bau“, „Stavby“)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MANY() });
  const r = await session(env).say("Vytvor faktúru pre Miler Bau.");
  assert.equal(say(r.result), t("search.voice.invoice.confirmPartnerCandidate", { name: "Müller Bau GmbH" }));
  assert.equal(slots(env).partnerId, undefined);

  const env2 = makeDb({ role: "owner", financeManage: true, tables: MANY() });
  const r2 = await session(env2).say("Vytvor faktúru pre Stavby.");
  assert.equal(r2.result.kind, "clarify");
  assert.deepEqual((r2.result as { choices?: { value: string }[] }).choices?.map((c) => c.value), [P_SK, P_SKP]);
  assert.equal(slots(env2).partnerId, undefined);
});

await check("hľadanie partnera cez ten istý resolver: „Nájdi partnera Stavby Kysuce es er ó“ → otvorí; „Nájdi partnera Miler Bau“ → iba na výber", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MANY() });
  const r = await session(env, { conversationId: null }).say("Nájdi partnera Stavby Kysuce es er ó.");
  assert.equal(r.intent?.name, "SEARCH_PARTNER");
  // Čítacie výsledky sa tu porovnávajú priamo z výstupu orchestrátora.
  assert.equal(r.output.result.kind, "navigate", JSON.stringify(r.output.result));
  const r2 = await session(env, { conversationId: null }).say("Nájdi partnera Miler Bau.");
  assert.equal(r2.output.result.kind, "list", "podobnosť sa neotvára priamo");
});

await check("duplicita pri zakladaní cez ten istý resolver: „Vytvor partnera Stavby Kysuce es er ó“ → už existuje", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MANY() });
  const r = await session(env).say("Vytvor partnera Stavby Kysuce es er ó.");
  assert.equal(say(r.result), t("assistant.partner.exists", { name: "Stavby Kysuce s.r.o. · 44444444" }));
});

await check("cudzia firma: partner firmy B sa nenájde ani rovnakým menom; firma B nevidí partnerov A", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MANY() });
  const r = await session(env).say("Vytvor faktúru pre Horák Stav.");
  assert.equal(r.result.kind, "not_found");
  const b = makeDb({ role: "owner", financeManage: true, companyId: COMPANY_B, tables: MANY() });
  const rb = await session(b).say("Vytvor faktúru pre Stavby Kysuce.");
  assert.equal(rb.result.kind, "not_found");
  assert.equal(slotsOfEnv(b).partnerId, undefined);
});

await check("oprávnenia PRED dotazom na partnerov: zamestnanec a admin bez financií (faktúra aj hľadanie partnera)", async () => {
  for (const phrase of ["Vytvor faktúru pre Stavby Kysuce.", "Nájdi partnera Stavby Kysuce."]) {
    const employee = makeDb({ role: "employee", financeManage: false, tables: MANY() });
    assert.equal(say((await session(employee).say(phrase)).result), t("assistant.denied.employee"), phrase);
    assert.equal(employee.state.queries, 0, phrase);
    const admin = makeDb({ role: "admin", financeManage: false, tables: MANY() });
    const r = await session(admin).say(phrase);
    assert.equal(r.result.kind, "error", phrase);
    assert.equal(admin.state.queries, 0, phrase);
  }
});

// =============================================================================
// ZMENA ÚLOHY A KONTEXT OBRAZOVKY
// =============================================================================

await check("stroj: otázka „Ku ktorému stroju?“ → „Vytvor faktúru.“ → faktúra, otázka o stroji zahodená", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { ...PARTNERS(), machines: [{ id: "m1", name: "Takeuchi 323", company_id: COMPANY_A }] } });
  const s = session(env);
  await s.say("Zaeviduj servis výmena oleja.");
  assert.ok(s.pending);
  const r = await s.say("Vytvor faktúru.");
  assert.equal(r.intent?.name, "CREATE_INVOICE_DRAFT");
  assert.equal(say(r.result), t("search.voice.invoice.askPartner"));
  assert.equal(s.pending, null);
});

await check("kontext obrazovky: výslovný príkaz vyhráva; všeobecná veta podľa modulu", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  assert.equal((await session(env, { module: "machines" }).say("Vytvor faktúru.")).intent?.name, "CREATE_INVOICE_DRAFT");
  assert.equal((await session(env, { module: "invoices" }).say("Pridaj nový stroj.")).intent?.name, "MACHINE_CREATE");
  assert.equal((await session(env, { module: "machines" }).say("Vytvor novú položku.")).intent?.name, "MACHINE_CREATE");
  assert.equal((await session(env, { module: "inventory" }).say("Vytvor novú položku.")).intent?.name, "INVENTORY_ITEM_CREATE");
  assert.equal(say((await session(env, { module: "dashboard" }).say("Vytvor novú položku.")).result), t("assistant.clarify.createModule"));
});

// =============================================================================
// OBCHODNÝ PARTNER — založenie (iba príprava formulára)
// =============================================================================

type Review = Extract<IntentResult, { kind: "partner_review" }>;

await check("REAL D: „Vytvor obchodného partnera Tester2.“ → formulár nového partnera; nič sa neuložilo", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const r = await session(env).say("Vytvor obchodného partnera Tester2.");
  assert.equal(r.intent?.name, "PARTNER_CREATE");
  assert.equal(r.result.kind, "partner_review", JSON.stringify(r.result));
  assert.deepEqual((r.result as Review).prefill, { legal_name: "Tester2" });
  assert.equal((r.result as Review).href, "/obchodni-partneri?new=1", "údaje nie sú v URL");
  assert.equal(env.state.tables.business_partners.length, 3);
});

await check("PARTNER: štart bez mena → „Ako sa volá …?“ → meno → formulár", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  const r1 = await s.say("Vytvor obchodného partnera.");
  assert.equal(say(r1.result), t("assistant.partner.askName"));
  assert.ok(s.pending);
  const r2 = await s.say("Firma ABC.");
  assert.equal(r2.result.kind, "partner_review");
  assert.equal((r2.result as Review).prefill.legal_name, "Firma ABC");
});

await check("PARTNER: „Vytvor firmu Stavby Kysuce s.r.o., IČO 12345679.“ → vyslovené údaje; „Pridaj zákazníka Firma ABC.“ → zákazník", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const a = await session(env).say("Vytvor firmu Stavby Kysuce s.r.o., IČO 12345679.");
  assert.deepEqual((a.result as Review).prefill, { legal_name: "Stavby Kysuce s.r.o.", ico: "12345679" });
  const b = await session(env).say("Pridaj zákazníka Firma ABC.");
  assert.deepEqual((b.result as Review).prefill, { legal_name: "Firma ABC", kind: "customer" });
});

await check("PARTNER duplicita: rovnaký názov / IČO → „už existuje, otvoriť?“ → „Áno“ otvorí, „Nie“ pripraví nového", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const s = session(env);
  const r = await s.say("Pridaj nového partnera Tester 1.");
  assert.equal(say(r.result), t("assistant.partner.exists", { name: "Tester1 · 12345678" }));
  const yes = await s.say("Áno.");
  assert.equal(yes.result.kind, "navigate");
  assert.equal((yes.result as { entity: { href: string } }).entity.href, `/obchodni-partneri/${P_T1}`);

  const s2 = session(env);
  await s2.say("Vytvor firmu Nová Firma, IČO 87654321.");
  const no = await s2.say("Nie.");
  assert.equal(no.result.kind, "partner_review", JSON.stringify(no.result));
  assert.equal(env.state.tables.business_partners.length, 3, "nič sa neuložilo");
});

await check("PARTNER: partner INEJ firmy nie je duplicita (bez úniku mena)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const r = await session(env).say("Vytvor obchodného partnera Cudzia firma B.");
  assert.equal(r.result.kind, "partner_review");
  assert.doesNotMatch(JSON.stringify(r.result), /99999999/);
});

await check("PARTNER role: admin bez financií, zamestnanec aj s podvrhnutými financiami → odmietnutie PRED dotazom; účtovník áno", async () => {
  const admin = makeDb({ role: "admin", financeManage: false, tables: PARTNERS() });
  assert.equal(say((await session(admin).say("Vytvor obchodného partnera Tester2.")).result), t("assistant.denied.finance"));
  assert.equal(admin.state.queries, 0);
  const forged = makeDb({ role: "employee", financeManage: true, tables: PARTNERS() });
  assert.equal(say((await session(forged).say("Vytvor obchodného partnera Tester2.")).result), t("assistant.denied.employee"));
  assert.equal(forged.state.queries, 0);
  const accountant = makeDb({ role: "accountant", financeManage: true, tables: PARTNERS() });
  assert.equal((await session(accountant).say("Vytvor obchodného partnera Tester2.")).result.kind, "partner_review");
});

// =============================================================================
// STROJE, SKLAD, PRIEČINKY, INBOX — produkčné vety
// =============================================================================

await check("REAL E: „Do stroja Takeuchi 323 pridaj výmenu oleja a filtrov.“ → servis, NIKDY nový stroj", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { machines: [{ id: "m1", name: "Takeuchi 323", company_id: COMPANY_A }] } });
  const r = await session(env, { ai: () => ({ name: "MACHINE_CREATE", args: { entityName: "Takeuchi 323 oleja" }, source: "ai" }) }).say("Do stroja Takeuchi 323 pridaj výmenu oleja a filtrov.");
  assert.equal(r.intent?.name, "MACHINE_SERVICE_ADD");
  assert.equal(r.result.kind, "action_preview");
  assert.equal(env.state.confirmations[0].intent, "MACHINE_SERVICE_ADD");
  assert.deepEqual((env.state.confirmations[0].canonical_args as Row).machineId, "m1");
});

await check("MACHINE: servis → otázka na stroj → stroj → náhľad → potvrdenie", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { machines: [{ id: "m1", name: "Takeuchi 323", company_id: COMPANY_A }] } });
  const s = session(env);
  await s.say("Zaeviduj servis výmena oleja.");
  const r = await s.say("Takeuchi 323.");
  assert.equal(r.result.kind, "action_preview");
  const done = await executeAction(env.db, "sk", { companyId: COMPANY_A, userId: USER_A, role: "owner" }, (r.result as { confirmationId: string }).confirmationId);
  assert.ok(done.kind === "action_result" && done.success);
  assert.equal(env.state.tables.machines.length, 1, "žiadny nový stroj");
  assert.equal(env.state.tables.machine_services.length, 1);
});

await check("REAL G: „Vymaž skladovú položku kotúča na asfalt.“ → návrh → „Áno“ → deštruktívny náhľad → potvrdenie", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { inventory_items: [{ id: "i-k", name: "Kotúč na asfalt", quantity: 3, unit: "ks" }] } });
  const s = session(env);
  const r1 = await s.say("Vymaž skladovú položku kotúča na asfalt.");
  assert.equal(say(r1.result), "Myslíte skladovú položku „Kotúč na asfalt“?");
  assert.equal(env.state.confirmations.length, 0);
  const r2 = await s.say("Áno.");
  assert.equal(r2.result.kind, "action_preview");
  assert.equal((r2.result as { destructive?: boolean }).destructive, true);
  assert.equal(classifyConfirmationReply("Áno, zmaž ho."), "confirm");
  const done = await executeAction(env.db, "sk", { companyId: COMPANY_A, userId: USER_A, role: "owner" }, (r2.result as { confirmationId: string }).confirmationId);
  assert.ok(done.kind === "action_result" && done.success);
  assert.equal(env.state.tables.inventory_items.length, 0);
});

await check("FOLDER: zmazanie → náhľad → potvrdenie; doklady ostanú", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: {
    document_folders: [{ id: "f-aug", name: "August", created_at: "2026-09-01" }],
    document_folder_items: [{ id: "fi1", folder_id: "f-aug", document_id: "d1", invoice_id: null }],
    documents: [{ id: "d1", document_type: "receipt", company_id: COMPANY_A }],
  } });
  const r = await session(env).say("Zmaž priečinok August.");
  assert.equal(r.intent?.name, "FOLDER_DELETE");
  assert.equal(r.result.kind, "action_preview", JSON.stringify(r.result));
  assert.equal((r.result as { destructive?: boolean }).destructive, true);
  const done = await executeAction(env.db, "sk", { companyId: COMPANY_A, userId: USER_A, role: "owner" }, (r.result as { confirmationId: string }).confirmationId);
  assert.ok(done.kind === "action_result" && done.success, JSON.stringify(done));
  assert.equal(env.state.tables.document_folders.length, 0);
  assert.equal(env.state.tables.documents.length, 1, "doklad prežil");
});

await check("REAL F: „Vymaž nepriradené bločky.“ → náhľad s presným počtom; nový bloček po náhľade sa nezmaže", async () => {
  const doc = (id: string): Row => ({ id, document_type: "receipt", deleted_at: null, archived_from_inbox_at: null, custom_category_id: null,
    original_filename: `${id}.jpg`, extracted_fields: {}, created_at: "2026-09-01", storage_bucket: "ai-inbox-documents", storage_path: `u/${id}.webp`, company_id: COMPANY_A });
  const env = makeDb({ role: "owner", financeManage: true, tables: { documents: [doc("r1"), doc("r2")] } });
  const r = await session(env).say("Vymaž nepriradené bločky.");
  assert.equal(r.result.kind, "action_preview");
  assert.equal((r.result as { affectedCount?: number }).affectedCount, 2);
  env.state.tables.documents.push(doc("r3"));
  const done = await executeAction(env.db, "sk", { companyId: COMPANY_A, userId: USER_A, role: "owner" }, (r.result as { confirmationId: string }).confirmationId);
  assert.ok(done.kind === "action_result" && done.success);
  assert.deepEqual(env.state.tables.documents.map((d) => d.id), ["r3"]);
});

// =============================================================================
// ZAMESTNANEC — všeobecný asistent odmietnutý, VÝNIMKA: príjem finančného dokladu
// =============================================================================

const INTAKE_PHRASES: [string, string][] = [
  ["Nahraj bloček.", "receipt"], ["Pridaj bloček.", "receipt"],
  ["Nahraj faktúru.", "invoice"], ["Pridaj faktúru.", "invoice"],
  ["Nahraj dodací list.", "delivery_note"], ["Pridaj dodací list.", "delivery_note"],
];
const EMPLOYEE_DENIED = [
  "Ukáž bločky.", "Ukáž faktúry.", "Koľko máme faktúr?", "Stiahni faktúry.", "Vytvor faktúru.",
  "Vytvor partnera.", "Vytvor obchodného partnera.", "Ukáž sklad.", "Pridaj stroj.", "Otvor vozidlo AB123CD.",
  "Vytvor priečinok August.", "Stiahni priečinok August.", "Exportuj bločky za august.", "Vymaž nepriradené bločky.",
  "Pridaj do skladu 20 vrutov.", "Zníž Sprej o 2 kusy.", "Pridaj servis k AB123CD za 250 eur.",
];
const SENSITIVE = (): Tables => ({
  ...PARTNERS(),
  documents: [{ id: "d-secret", document_type: "invoice", extracted_fields: { totalAmount: 4321.5, supplier: "Tajný dodávateľ", invoiceNumber: "FA-777" }, company_id: COMPANY_A, deleted_at: null, archived_from_inbox_at: null }],
  inventory_items: [{ id: "i1", name: "Sprej", quantity: 12, unit: "ks" }],
  vehicles: [{ id: "v1", plate: "AB123CD", company_id: COMPANY_A }],
});

for (const forged of [false, true]) {
  const who = forged ? "zamestnanec s podvrhnutým permissions.finance" : "zamestnanec";

  await check(`${who}: „Nahraj/Pridaj bloček/faktúru/dodací list“ → IBA bezpečný príjem, bez dotazu a bez čítania späť`, async () => {
    for (const [phrase, type] of INTAKE_PHRASES) {
      const env = makeDb({ role: "employee", financeManage: forged, tables: SENSITIVE() });
      const s = session(env, { ai: () => { throw new Error("AI sa nesmie volať"); } });
      const r = await s.say(phrase);
      assert.equal(r.intent?.name, "DOCUMENT_INTAKE", phrase);
      assert.deepEqual(r.intent?.args.documentTypes, [type], phrase);
      assert.equal(r.result.kind, "answer", phrase);
      assert.equal(say(r.result), t("assistant.intake.instructions"), phrase);
      assert.equal((r.result as { entity?: { href: string } }).entity?.href, "/ai-evidencia", phrase);
      assert.equal(env.state.queries, 0, `${phrase}: žiadny dotaz do DB`);
      assert.equal(s.aiCalls, 0, phrase);
      assert.equal(s.pending, null, phrase);
      const body = JSON.stringify(r.output);
      for (const leak of ["4321", "Tajný", "FA-777", "d-secret", "Tester1", "12345678"]) assert.ok(!body.includes(leak), `${phrase}: únik ${leak}`);
    }
  });

  await check(`${who}: všetko ostatné (čítanie, faktúra, partner, sklad, stroj, vozidlo, priečinok, export) → odmietnutie PRED AI aj pred dotazom`, async () => {
    for (const phrase of EMPLOYEE_DENIED) {
      const env = makeDb({ role: "employee", financeManage: forged, tables: SENSITIVE() });
      const s = session(env, { ai: () => ({ name: "SEARCH_DOCUMENTS", args: { documentTypes: ["invoice"] }, source: "ai" }) });
      const r = await s.say(phrase);
      assert.equal(r.result.kind, "error", phrase);
      assert.equal(say(r.result), t("assistant.denied.employee"), phrase);
      assert.equal(env.state.queries, 0, `${phrase}: žiadny dotaz do DB`);
      assert.equal(env.state.confirmations.length, 0, phrase);
      assert.equal(s.aiCalls, 0, `${phrase}: AI sa nevolá`);
    }
  });
}

await check("zamestnanec: nerozpoznaná veta ide na odmietnutie bez AI (text sa AI neposiela)", async () => {
  const env = makeDb({ role: "employee", financeManage: false, tables: SENSITIVE() });
  const s = session(env, { ai: () => ({ name: "DOCUMENT_INTAKE", args: { documentTypes: ["receipt"] }, source: "ai" }) });
  const r = await s.say("čo máme nové vo firme");
  assert.equal(say(r.result), t("assistant.denied.employee"));
  assert.equal(s.aiCalls, 0);
  assert.equal(env.state.queries, 0);
});

await check("owner / admin / účtovník: „Nahraj bloček“ ten istý bezpečný príjem; „Ukáž faktúry“ podľa doterajších práv", async () => {
  for (const [role, fin] of [["owner", true], ["admin", true], ["admin", false], ["accountant", true]] as [Role, boolean][]) {
    const env = makeDb({ role, financeManage: fin, tables: SENSITIVE() });
    const intake = await session(env).say("Nahraj bloček.");
    assert.equal(say(intake.result), t("assistant.intake.instructions"), role);
    const read = await session(env).say("Ukáž faktúry.");
    if (fin) assert.notEqual(read.result.kind, "error", `${role}: čítanie faktúr povolené`);
    else assert.equal(say(read.result), t("assistant.denied.finance"), `${role} bez financií`);
  }
});

// =============================================================================
// AI FALLBACK — iba interpretácia
// =============================================================================

await check("AI: mazanie nikdy (stroj, vozidlo, položka, priečinok, Inbox)", async () => {
  for (const name of ["MACHINE_DELETE", "VEHICLE_DELETE", "INVENTORY_ITEM_DELETE", "FOLDER_DELETE", "INBOX_DELETE_UNASSIGNED"] as const) {
    const env = makeDb({ role: "owner", financeManage: true, tables: { machines: [{ id: "m1", name: "Aman", company_id: COMPANY_A }] } });
    const r = await session(env, { ai: () => ({ name, args: { query: "Aman" }, source: "ai" }) }).say("preč s tým Aman");
    assert.equal(r.output.recognized, false, name);
    assert.equal(env.state.confirmations.length, 0, name);
  }
});

await check("AI: založenie iba pri výslovných slovách; entityId z AI sa zahodí", async () => {
  for (const name of ["MACHINE_CREATE", "VEHICLE_CREATE", "INVENTORY_ITEM_CREATE", "PARTNER_CREATE", "CREATE_INVOICE_DRAFT", "FOLDER_CREATE", "ENTITY_CREATE"] as const) {
    assert.equal(sanitizeAiIntent({ name, args: { entityName: "X" }, source: "ai" }, "Takeuchi niečo tam"), null, name);
  }
  assert.equal(sanitizeAiIntent({ name: "VEHICLE_CREATE", args: {}, source: "ai" }, "Pridaj nové auto Škoda")?.name, "VEHICLE_CREATE");
  const stripped = sanitizeAiIntent({ name: "SEARCH_MACHINE", args: { query: "Aman", entityId: "m1", confirmedNew: true }, source: "ai" }, "kde je Aman");
  assert.equal(stripped?.args.entityId, undefined);
  assert.equal(stripped?.args.confirmedNew, undefined);
});

// =============================================================================
// CUDZIA FIRMA, ANON, PORADIE
// =============================================================================

await check("cudzia firma nemôže pokračovať v rozhovore o faktúre firmy A (rovnaké conversationId)", async () => {
  const a = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  await session(a).say("Vytvor faktúru pre Tester1.");
  const b = makeDb({ role: "owner", financeManage: true, companyId: COMPANY_B, tables: PARTNERS() });
  const r = await session(b).say("Kopanie 300 eur.");
  assert.notEqual(r.intent?.name, "CREATE_INVOICE_DRAFT");
  assert.equal(b.state.tables.invoices.length, 0);
});

await check("cudzia firma: partner firmy B sa pri faktúre firmy A nenájde", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const r = await session(env).say("Vytvor faktúru pre Cudzia firma B.");
  assert.match(say(r.result), PARTNER_NOT_FOUND);
});

await check("route: 401 pred orchestrátorom; route nič nerozhoduje sama", () => {
  const route = readFileSync("app/api/assistant/intent/route.ts", "utf8");
  assert.ok(route.indexOf("status: 401") > 0 && route.indexOf("status: 401") < route.indexOf("runAssistantTurn("));
  assert.ok(!route.includes("parseIntentDeterministic"), "parser volá iba orchestrátor");
  const orchestrator = readFileSync("lib/intents/orchestrator.ts", "utf8");
  const task = orchestrator.indexOf("decideInvoiceTurn(rawText");
  const parse = orchestrator.indexOf("parseIntentDeterministic(rawText, { module");
  const ai = orchestrator.indexOf("deps.classifyWithAi(rawText)");
  const gate = orchestrator.indexOf("checkIntentAccess(intent.name");
  assert.ok(task > 0 && task < parse && parse < ai && ai < gate, "aktívna úloha → parser → AI → brána");
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
