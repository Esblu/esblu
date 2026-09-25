// =============================================================================
// Súvislý hlasový režim + stavové dopĺňanie slotu + konverzačná oprava.
//
// SPUSTENIE
//   npm run test:continuous-voice
//
// 1. Sémantika slovesa: „Pridaj do položky X" = zmena stavu EXISTUJÚCEJ
//    položky, nie založenie (produkčná chyba 2026-09-25).
// 2. Otázka na množstvo má prednosť pred globálnym parserom.
// 3. Oprava „To je už vytvorené" pokračuje v úlohe namiesto „Nerozumel som".
// 4. Stavový automat relácie: jedno ťuknutie, striedanie reči, mikrofón a
//    syntéza nikdy naraz, zastavenie bez reštartu.
// 5. Koniec vety podľa ticha (krátke „áno", „päť").
// Mená položiek sú syntetické (žiadne produkčné/testovacie mená v kóde).
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "ef".repeat(32);
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { makeDb, COMPANY_B, USER_B, type Role } from "./support/memory-db.ts";

const { parseIntentDeterministic } = await import("@/lib/intents/parse");
const { runAssistantTurnDetailed } = await import("@/lib/intents/orchestrator");
const { executeAction } = await import("@/lib/intents/actions");
const { classifyQuantityReply, isExistingTargetRepair } = await import("@/lib/intents/slot-replies");
const { translate } = await import("@/lib/i18n/translate");
const {
  INITIAL_VOICE_SESSION,
  voiceSessionReducer,
  isVoiceStopCommand,
  decideVoiceConfirmation,
} = await import("@/lib/voice/voice-session");
const voiceSessionModule = await import("@/lib/voice/voice-session");
const { createVad, DEFAULT_VAD } = await import("@/lib/voice/vad");
const { spokenTextFor } = await import("@/lib/voice/spoken-text");

type IntentResult = import("@/lib/intents/types").IntentResult;
type VoiceEvent = import("@/lib/voice/voice-session").VoiceEvent;
type VoiceEffect = import("@/lib/voice/voice-session").VoiceEffect;
type VoiceSessionState = import("@/lib/voice/voice-session").VoiceSessionState;

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

const t = (key: string, vars?: Record<string, string | number>) => translate("sk", key, vars);
const CONV = "0123456789abcdef0123456789abcdef";
// Syntetické mená — zámerne nie sú nikde v produkčnom kóde.
const ITEM = "Trimex";
const OTHER = "Kolvaz";
const TABLES = () => ({
  inventory_items: [
    { id: "i-trimex", name: ITEM, quantity: 12, unit: "ks" },
    { id: "i-kolvaz", name: OTHER, quantity: 4, unit: "ks" },
    { id: "i-foreign", name: "Brevok", quantity: 99, unit: "ks", company_id: COMPANY_B },
  ],
});
const ACCESS: Record<Role, { financeView: boolean; financeManage: boolean; canOperate: boolean }> = {
  owner: { financeView: true, financeManage: true, canOperate: true },
  admin: { financeView: false, financeManage: false, canOperate: true },
  accountant: { financeView: true, financeManage: true, canOperate: false },
  employee: { financeView: false, financeManage: false, canOperate: true },
};

type Env = ReturnType<typeof makeDb>;
function session(env: Env, opts: { userId?: string; companyId?: string } = {}) {
  let pending: string | null = null;
  return {
    get pending() { return pending; },
    set pending(value: string | null) { pending = value; },
    async say(text: string) {
      const { output, finalIntent } = await runAssistantTurnDetailed(
        { db: env.db, classifyWithAi: async () => null },
        {
          rawText: text,
          locale: "sk",
          userId: opts.userId ?? env.userId,
          companyId: opts.companyId ?? env.companyId,
          role: env.state.role,
          ...ACCESS[env.state.role],
          conversationId: CONV,
          pendingClarification: pending,
          structuredPartnerId: null,
          issueDate: "2026-09-25",
          uiContext: null,
          moduleContext: "dashboard" as never,
          selection: null,
          folderContextId: null,
        }
      );
      pending = output.pendingClarification ?? null;
      return { result: output.result, intent: finalIntent, output };
    },
  };
}
const text = (r: IntentResult) => ((r as { text?: string }).text ?? (r as { summary?: string }).summary ?? (r as { question?: string }).question ?? "").replace(/ /g, " ");
const askAdd = (name: string) => t("assistant.inventory.askQuantityFor.add", { name });
const quantityOf = (env: Env, id: string) => Number((env.state.tables.inventory_items.find((row) => row.id === id) as { quantity: number }).quantity);

// =============================================================================
// 1. SÉMANTIKA SLOVESA — zmena stavu vs. založenie
// =============================================================================

await check("parser: „Pridaj do položky X“ / „Pridaj k X“ / „Pridaj do X“ = zmena stavu bez množstva", () => {
  for (const [sentence, name] of [
    [`Pridaj do položky ${ITEM}.`, ITEM],
    [`pridaj do položky ${ITEM.toLowerCase()}`, ITEM],
    [`Pridaj k ${ITEM}u.`, `${ITEM}u`],
    [`Pridaj do ${ITEM}a.`, `${ITEM}a`],
    [`Pridaj k položke ${OTHER}.`, OTHER],
  ] as const) {
    const parsed = parseIntentDeterministic(sentence);
    assert.equal(parsed?.name, "INVENTORY_QUANTITY_ADJUST", sentence);
    assert.equal(parsed?.args.quantityMode, "add", sentence);
    assert.equal(parsed?.args.quantity, undefined, `${sentence}: množstvo sa nedomýšľa`);
    assert.equal(parsed?.args.query?.toLowerCase(), name.toLowerCase(), sentence);
  }
});

await check("parser: množstvo, zníženie a nastavenie — aj slovom, bez slova „sklad“", () => {
  const cases: [string, "add" | "subtract" | "set", number][] = [
    [`Pridaj do položky ${ITEM} 5 kusov.`, "add", 5],
    [`Pridaj k položke ${ITEM} 5.`, "add", 5],
    [`Pridaj do položky ${ITEM} päť kusov.`, "add", 5],
    [`Zníž ${ITEM} o 2.`, "subtract", 2],
    [`Uber z položky ${ITEM} dva kusy.`, "subtract", 2],
    [`Nastav ${ITEM} na 5.`, "set", 5],
    [`Nastav počet ${ITEM} na 7.`, "set", 7],
  ];
  for (const [sentence, mode, quantity] of cases) {
    const parsed = parseIntentDeterministic(sentence);
    assert.equal(parsed?.name, "INVENTORY_QUANTITY_ADJUST", sentence);
    assert.equal(parsed?.args.quantityMode, mode, sentence);
    assert.equal(parsed?.args.quantity, quantity, sentence);
    assert.equal(parsed?.args.query, ITEM, sentence);
  }
});

await check("parser: založenie a iné oblasti sa NEMIEŠAJÚ so zmenou stavu", () => {
  assert.notEqual(parseIntentDeterministic(`Vytvor položku ${ITEM}.`)?.name, "INVENTORY_QUANTITY_ADJUST");
  assert.equal(parseIntentDeterministic(`Vytvor skladovú položku ${ITEM}.`)?.name, "INVENTORY_ITEM_CREATE");
  assert.equal(parseIntentDeterministic(`Pridaj novú položku ${ITEM} do skladu.`)?.name, "INVENTORY_ITEM_CREATE");
  assert.equal(parseIntentDeterministic(`Pridaj nový stroj ${OTHER}.`)?.name, "MACHINE_CREATE");
  assert.equal(parseIntentDeterministic(`Do stroja ${OTHER} 323 pridaj výmenu oleja.`)?.name, "MACHINE_SERVICE_ADD");
  assert.equal(parseIntentDeterministic("Pridaj do priečinka August bločky.")?.name, "FOLDER_ADD_ITEMS");
  assert.equal(parseIntentDeterministic("Pridaj do skladu 20 vrutov.")?.name, "INVENTORY_QUANTITY_ADJUST");
  assert.notEqual(parseIntentDeterministic("Pridaj k faktúre dopravu.")?.name, "INVENTORY_QUANTITY_ADJUST");
  assert.notEqual(parseIntentDeterministic(`Pridaj k ${OTHER} servis.`)?.name, "INVENTORY_QUANTITY_ADJUST");
  assert.notEqual(parseIntentDeterministic(`Nastav ${ITEM}.`)?.name, "INVENTORY_QUANTITY_ADJUST", "„Nastav X“ bez hodnoty je nejednoznačné");
  // Meno začínajúce triednym slovom sa neoreže („Stavebný …" nie je „stav").
  assert.equal(parseIntentDeterministic("Zvýš stav položky Stavebný piesok.")?.args.query, "Stavebný piesok");
});

await check("PRODUKCIA: „Pridaj do položky X.“ → otázka na množstvo, NIE „V ktorom module…“", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const s = session(env);
  const r = await s.say(`Pridaj do položky ${ITEM.toLowerCase()}.`);
  assert.equal(text(r.result), askAdd(ITEM));
  assert.notEqual(text(r.result), t("assistant.clarify.createModule"));
  assert.ok(s.pending, "otázka na množstvo je zapečatená");
  assert.equal(env.state.tables.inventory_items.length, 3, "nič sa nevytvorilo");
});

await check("„Pridaj k Xu.“ (skloňované) → resolver bezpečne nájde položku → otázka na množstvo", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const r = await session(env).say(`Pridaj k ${ITEM}u.`);
  assert.equal(text(r.result), askAdd(ITEM));
});

await check("„Pridaj do X“ bez slova „položka“ a bez zhody v sklade → žiadna vymyslená položka", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const s = session(env);
  const r = await s.say("Pridaj do Zorblaxu.");
  assert.equal(text(r.result), t("search.errors.commandNotUnderstood"));
  assert.equal(s.pending, null);
  assert.equal(env.state.confirmations.length, 0, "žiadny náhľad založenia");
});

await check("s množstvom: ADD 5 / SUBTRACT 2 / SET 5 → náhľad so správnym cieľom", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const s = session(env);
  const add = await s.say(`Pridaj do položky ${ITEM} 5 kusov.`);
  assert.equal(add.result.kind, "action_preview");
  assert.match(text(add.result), /z 12 ks na 17 ks/);
  const sub = await s.say(`Zníž ${ITEM} o 2.`);
  assert.match(text(sub.result), /z 12 ks na 10 ks/);
  const set = await s.say(`Nastav ${ITEM} na 5.`);
  assert.match(text(set.result), /z 12 ks na 5 ks/);
  assert.equal(quantityOf(env, "i-trimex"), 12, "náhľad nič nezapísal");
});

// =============================================================================
// 2. OTÁZKA NA MNOŽSTVO MÁ PREDNOSŤ
// =============================================================================

await check("slot množstva: „päť“, „5 kusov“, „pridaj desať“, „vlastne tri“ → odpoveď", async () => {
  for (const [answer, to] of [["päť", 17], ["5 kusov", 17], ["pridaj desať", 22], ["vlastne tri", 15], ["Tri.", 15]] as const) {
    const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
    const s = session(env);
    await s.say(`Pridaj do položky ${ITEM}.`);
    const r = await s.say(answer);
    assert.equal(r.result.kind, "action_preview", `${answer}: ${text(r.result)}`);
    assert.match(text(r.result), new RegExp(`na ${to} ks`), answer);
  }
});

await check("slot množstva: „uber tri“ zmení zámer; „zrušiť“ ukončí; „Ukáž faktúry“ je nový príkaz", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const s = session(env);
  await s.say(`Pridaj do položky ${ITEM}.`);
  assert.match(text((await s.say("uber tri")).result), /na 9 ks/);

  await s.say(`Pridaj do položky ${ITEM}.`);
  const cancel = await s.say("zrušiť");
  assert.equal(text(cancel.result), t("assistant.clarify.cancelled"));
  assert.equal(s.pending, null);

  await s.say(`Pridaj do položky ${ITEM}.`);
  const next = await s.say("Ukáž faktúry");
  assert.equal(next.intent?.name, "SEARCH_DOCUMENTS", "výslovný nový príkaz nahradí úlohu");
});

await check("slot množstva: nový príkaz s VLASTNÝM cieľom nevyplní starý slot", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const s = session(env);
  await s.say(`Pridaj do položky ${ITEM}.`);
  const r = await s.say(`Pridaj do položky ${OTHER} 3.`);
  assert.match(text(r.result), new RegExp(`„${OTHER}“ z 4 ks na 7 ks`));
});

await check("slot množstva: nejasná veta → tá istá otázka znova (úloha sa nestratí)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const s = session(env);
  await s.say(`Pridaj do položky ${ITEM}.`);
  const r = await s.say("hmm");
  assert.equal(text(r.result), `${t("assistant.inventory.quantityNotUnderstood")} ${askAdd(ITEM)}`);
  assert.ok(s.pending);
  assert.match(text((await s.say("päť")).result), /na 17 ks/);
});

await check("classifyQuantityReply: čistá funkcia bez domýšľania", () => {
  assert.deepEqual(classifyQuantityReply("päť", "add"), { kind: "answer", quantity: 5, mode: "add" });
  assert.deepEqual(classifyQuantityReply("nastav na osem", "add"), { kind: "answer", quantity: 8, mode: "set" });
  assert.equal(classifyQuantityReply("áno", "add").kind, "unclear", "„áno“ nie je množstvo");
  assert.equal(classifyQuantityReply("nie", "add").kind, "cancel");
  assert.equal(classifyQuantityReply("", "add").kind, "unclear");
});

// =============================================================================
// 3. OPRAVA „TO JE UŽ VYTVORENÉ"
// =============================================================================

await check("oprava pri otázke na množstvo: „To je už vytvorené“ a ekvivalenty → pokračuje tá istá úloha", async () => {
  for (const repair of ["To je už vytvorené.", "už existuje", "nechcem novú", "myslel som existujúcu položku", "tá položka už je"]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
    const s = session(env);
    await s.say(`Pridaj do položky ${ITEM}.`);
    const r = await s.say(repair);
    assert.notEqual(text(r.result), t("search.errors.commandNotUnderstood"), repair);
    assert.equal(text(r.result), `${t("assistant.repair.existing", { name: ITEM })} ${askAdd(ITEM)}`, repair);
    assert.ok(s.pending, `${repair}: úloha ostáva`);
    assert.match(text((await s.say("päť")).result), /na 17 ks/, repair);
    assert.equal(env.state.tables.inventory_items.length, 3, "nič sa nezaložilo");
  }
});

await check("oprava po otázke „V ktorom module…“ → existujúca položka, otázka na množstvo", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const s = session(env);
  const first = await s.say(`Pridaj položku ${ITEM}.`);
  assert.equal(text(first.result), t("assistant.clarify.createModule"));
  const r = await s.say("To je už vytvorené.");
  assert.equal(text(r.result), `${t("assistant.repair.existing", { name: ITEM })} ${askAdd(ITEM)}`);
  assert.match(text((await s.say("päť kusov")).result), /na 17 ks/);
});

await check("oprava po „Vytvor položku X“ → nič nezakladá, ukáže existujúcu (nevymyslí pridávanie)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const s = session(env);
  await s.say(`Vytvor položku ${ITEM}.`);
  const r = await s.say("už existuje");
  assert.equal(r.intent?.name, "INVENTORY_ITEM_STATUS");
  assert.equal(env.state.confirmations.length, 0);
});

await check("oprava bez úlohy → žiadny vymyslený cieľ, ale ani „Nerozumel som“", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const s = session(env);
  const r = await s.say("To je už vytvorené.");
  assert.equal(text(r.result), t("assistant.repair.noTarget"));
  assert.equal(s.pending, null);
  assert.equal(env.state.confirmations.length, 0);
});

await check("isExistingTargetRepair: SK/EN/DE význam, nie konkrétna veta; otázka nie je oprava", () => {
  for (const yes of ["Je to vytvorené.", "Už ju mám.", "It already exists.", "I don't want a new one", "I meant the existing one", "Existiert schon.", "Ist bereits angelegt.", "Keine neue."]) {
    assert.ok(isExistingTargetRepair(yes), yes);
  }
  for (const no of ["Existuje položka Trimex?", "Pridaj do položky Trimex", "päť", "Ukáž faktúry", "áno"]) {
    assert.ok(!isExistingTargetRepair(no), no);
  }
});

// =============================================================================
// 4. BEZPEČNOSŤ NEZMENENÁ
// =============================================================================

await check("zamestnanec a účtovník: rovnaké odmietnutie, žiadna otázka ani dotaz", async () => {
  for (const role of ["employee", "accountant"] as const) {
    const env = makeDb({ role, financeManage: role === "accountant", tables: TABLES() });
    const s = session(env);
    const r = await s.say(`Pridaj do položky ${ITEM}.`);
    assert.equal(r.result.kind, "error", role);
    assert.equal(s.pending, null, role);
  }
});

await check("cudzia firma: položka firmy B sa nenájde; token otázky je viazaný na používateľa a firmu", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const s = session(env);
  const foreign = await s.say("Pridaj do položky Brevok.");
  assert.equal(foreign.result.kind, "not_found");
  await s.say(`Pridaj do položky ${ITEM}.`);
  const token = s.pending;
  const envB = makeDb({ role: "owner", financeManage: true, companyId: COMPANY_B, userId: USER_B, tables: TABLES() });
  const sB = session(envB);
  sB.pending = token;
  const r = await sB.say("päť");
  assert.equal(text(r.result), t("assistant.clarify.expired"), "cudzí token nič nedoplní");
});

await check("hlasové „Áno“ = tá istá jednorazová podpísaná cesta; opakovanie neprejde", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TABLES() });
  const s = session(env);
  await s.say(`Pridaj do položky ${ITEM}.`);
  const preview = (await s.say("päť")).result;
  assert.equal(preview.kind, "action_preview");
  assert.equal(decideVoiceConfirmation("Áno."), "confirm");
  const id = (preview as { confirmationId: string }).confirmationId;
  const ctx = { companyId: env.companyId, userId: env.userId, role: "owner" as never };
  const done = await executeAction(env.db, "sk", ctx, id);
  assert.ok(done.kind === "action_result" && done.success);
  assert.equal(quantityOf(env, "i-trimex"), 17);
  const replay = await executeAction(env.db, "sk", ctx, id);
  assert.ok(replay.kind === "action_result" && !replay.success, "jednorazové");
  assert.equal(quantityOf(env, "i-trimex"), 17);
});

await check("potvrdenie hlasom: nejasná krátka veta sa nikdy nepovažuje za súhlas", () => {
  for (const unclear of ["áno?", "hm", "ehm tak", "Trimex"]) assert.equal(decideVoiceConfirmation(unclear), "ask_again", unclear);
  for (const yes of ["Áno.", "Potvrdiť.", "áno, pokračuj"]) assert.equal(decideVoiceConfirmation(yes), "confirm", yes);
  for (const no of ["Nie.", "Zrušiť."]) assert.equal(decideVoiceConfirmation(no), "cancel", no);
  assert.equal(decideVoiceConfirmation("Ukáž faktúry"), "new_command");
  assert.equal(decideVoiceConfirmation("Áno, zmaž priečinok Iný"), "new_command", "iný cieľ nie je súhlas");
});

// =============================================================================
// 5. STAVOVÝ AUTOMAT RELÁCIE
// =============================================================================

/** Simulácia prehliadača: sleduje mikrofón a syntézu a kontroluje, že nikdy nebežia naraz. */
function simulate() {
  let state: VoiceSessionState = INITIAL_VOICE_SESSION;
  let micOpen = false;
  let micRequested = false;
  let listening = false;
  let speaking = false;
  const log: string[] = [];
  const apply = (effects: VoiceEffect[]) => {
    for (const effect of effects) {
      log.push(effect.type);
      switch (effect.type) {
        case "acquireMic":
          assert.ok(!speaking, "mikrofón sa nesmie žiadať počas reči Esblu");
          micRequested = true;
          break;
        case "listen":
          assert.ok(micOpen && !speaking, "počúvať iba s otvoreným mikrofónom a bez reči");
          listening = true;
          break;
        case "cancelListen":
          listening = false;
          break;
        case "releaseMic":
          micOpen = false;
          micRequested = false;
          listening = false;
          break;
        case "speak":
        case "speakNotice":
          assert.ok(!micOpen && !listening, "Esblu hovorí iba s uvoľneným mikrofónom");
          speaking = true;
          break;
        case "cancelSpeech":
          speaking = false;
          break;
      }
    }
  };
  const send = (event: VoiceEvent) => {
    if (event.type === "MIC_READY") {
      if (micRequested) micOpen = true;
    }
    if (event.type === "SPEECH_DONE") speaking = false;
    const next = voiceSessionReducer(state, event);
    state = next.state;
    apply(next.effects);
    assert.ok(!(micOpen && speaking), "mikrofón a syntéza nikdy naraz");
    return next;
  };
  return { send, get state() { return state; }, get log() { return log; }, get micOpen() { return micOpen; } };
}

await check("relácia: jedno ťuknutie → LISTENING → TRANSCRIBING → SERVER → SPEAKING → LISTENING (bez druhého ťuknutia)", () => {
  const sim = simulate();
  sim.send({ type: "USER_TAP" });
  assert.equal(sim.state.status, "starting");
  sim.send({ type: "MIC_READY" });
  assert.equal(sim.state.status, "listening");
  sim.send({ type: "UTTERANCE_CAPTURED" });
  assert.equal(sim.state.status, "transcribing");
  assert.equal(sim.micOpen, false, "mikrofón je po zachytení vety uvoľnený");
  const sent = sim.send({ type: "TRANSCRIPT", text: `Pridaj do položky ${ITEM}.` });
  assert.deepEqual(sent.effects, [{ type: "sendTurn", text: `Pridaj do položky ${ITEM}.` }]);
  sim.send({ type: "TURN_RESULT", spoken: askAdd(ITEM) });
  assert.equal(sim.state.status, "speaking");
  sim.send({ type: "SPEECH_DONE" });
  assert.equal(sim.state.status, "starting", "po dohovorení sa mikrofón zapne sám");
  sim.send({ type: "MIC_READY" });
  assert.equal(sim.state.status, "listening");
  assert.equal(sim.state.turn, 1);
  assert.equal(sim.log.filter((effect) => effect === "acquireMic").length, 2);
});

await check("relácia: celý hands-free tok (množstvo → áno → hotovo → nový príkaz) jedným ťuknutím", () => {
  const sim = simulate();
  sim.send({ type: "USER_TAP" });
  const turn = (heard: string, reply: string | null) => {
    sim.send({ type: "MIC_READY" });
    sim.send({ type: "UTTERANCE_CAPTURED" });
    sim.send({ type: "TRANSCRIPT", text: heard });
    sim.send({ type: "TURN_RESULT", spoken: reply });
    if (reply) sim.send({ type: "SPEECH_DONE" });
  };
  turn(`Pridaj do položky ${ITEM}.`, askAdd(ITEM));
  turn("Päť.", "Zmením stav… Potvrdiť? Povedzte áno alebo nie.");
  turn("Áno.", "Stav položky je teraz 17 ks.");
  turn("Vytvor faktúru.", "Pre ktorého odberateľa?");
  assert.equal(sim.state.status, "starting");
  assert.equal(sim.state.turn, 4);
  assert.equal(sim.log.filter((effect) => effect === "sendTurn").length, 4);
});

await check("relácia: chyba syntézy aj prepisu → bezpečne ďalej počúvať; sieťová chyba sa nepošle ako príkaz", () => {
  const sim = simulate();
  sim.send({ type: "USER_TAP" });
  sim.send({ type: "MIC_READY" });
  sim.send({ type: "UTTERANCE_CAPTURED" });
  const asr = sim.send({ type: "TRANSCRIBE_FAILED" });
  assert.deepEqual(asr.effects.at(-1), { type: "speakNotice", key: "asrRetry" });
  sim.send({ type: "SPEECH_DONE" }); // aj onerror syntézy končí ako SPEECH_DONE
  assert.equal(sim.state.status, "starting");
  sim.send({ type: "MIC_READY" });
  sim.send({ type: "UTTERANCE_CAPTURED" });
  sim.send({ type: "TRANSCRIPT", text: "Ukáž sklad." });
  const net = sim.send({ type: "TURN_FAILED" });
  assert.ok(!net.effects.some((effect) => effect.type === "sendTurn"), "chybová veta nie je nový príkaz");
  assert.deepEqual(net.effects.at(-1), { type: "speakNotice", key: "networkRetry" });
});

await check("relácia: ručné zastavenie → žiadny reštart ani po oneskorenom konci reči", () => {
  const sim = simulate();
  sim.send({ type: "USER_TAP" });
  sim.send({ type: "MIC_READY" });
  sim.send({ type: "UTTERANCE_CAPTURED" });
  sim.send({ type: "TRANSCRIPT", text: "Ukáž sklad." });
  sim.send({ type: "TURN_RESULT", spoken: "Sklad." });
  const stopped = sim.send({ type: "STOP", reason: "user" });
  assert.equal(sim.state.status, "stopped");
  assert.ok(stopped.effects.some((effect) => effect.type === "releaseMic") && stopped.effects.some((effect) => effect.type === "cancelSpeech"));
  for (const late of [{ type: "SPEECH_DONE" }, { type: "MIC_READY" }, { type: "TURN_RESULT", spoken: "x" }, { type: "UTTERANCE_CAPTURED" }] as VoiceEvent[]) {
    const next = sim.send(late);
    assert.equal(sim.state.status, "stopped", late.type);
    assert.ok(!next.effects.some((effect) => effect.type === "acquireMic" || effect.type === "listen"), `${late.type} nereštartuje`);
  }
});

await check("relácia: ťuknutie počas počúvania = koniec; počas reči Esblu = prerušiť a hneď počúvať", () => {
  const a = simulate();
  a.send({ type: "USER_TAP" });
  a.send({ type: "MIC_READY" });
  a.send({ type: "USER_TAP" });
  assert.equal(a.state.status, "stopped");
  assert.equal(a.state.stopReason, "user");

  const b = simulate();
  b.send({ type: "USER_TAP" });
  b.send({ type: "MIC_READY" });
  b.send({ type: "UTTERANCE_CAPTURED" });
  b.send({ type: "TRANSCRIPT", text: "Ukáž sklad." });
  b.send({ type: "TURN_RESULT", spoken: "Dlhá odpoveď…" });
  const barge = b.send({ type: "USER_TAP" });
  assert.deepEqual(barge.effects.map((effect) => effect.type), ["cancelSpeech", "acquireMic"], "najprv ticho, potom mikrofón");
  assert.equal(b.state.status, "starting");
});

await check("relácia: hlasom „koniec“ / „prestaň počúvať“ / „stop“ zastaví; príkaz so slovom stop nie", () => {
  for (const phrase of ["Koniec.", "ukonči hlas", "Prestaň počúvať.", "stop", "Stopp", "End voice"]) {
    assert.ok(isVoiceStopCommand(phrase), phrase);
    const sim = simulate();
    sim.send({ type: "USER_TAP" });
    sim.send({ type: "MIC_READY" });
    sim.send({ type: "UTTERANCE_CAPTURED" });
    const r = sim.send({ type: "TRANSCRIPT", text: phrase });
    assert.equal(sim.state.status, "stopped", phrase);
    assert.equal(sim.state.stopReason, "phrase");
    assert.ok(!r.effects.some((effect) => effect.type === "sendTurn"), `${phrase}: nejde na server`);
  }
  for (const command of ["Zastav výrobu stroja", "koniec platnosti STK", "Ukáž stop stav"]) assert.ok(!isVoiceStopCommand(command), command);
});

await check("relácia: jedno ticho reláciu NEUKONČÍ; pripomienka po dlhšom tichu; koniec až po veľmi dlhom; pozadie/offline zastaví", () => {
  const { IDLE_PROMPT_AFTER_WINDOWS, IDLE_STOP_AFTER_WINDOWS } = voiceSessionModule;
  const sim = simulate();
  sim.send({ type: "USER_TAP" });
  sim.send({ type: "MIC_READY" });
  sim.send({ type: "NO_SPEECH" });
  assert.equal(sim.state.status, "listening", "krátke ticho: počúvam ďalej");
  assert.equal(sim.micOpen, true);
  let prompts = 0;
  for (let window = 2; window < IDLE_STOP_AFTER_WINDOWS; window++) {
    const r = sim.send({ type: "NO_SPEECH" });
    if (r.effects.some((effect) => effect.type === "speakNotice" && effect.key === "idlePrompt")) {
      prompts++;
      assert.equal(window, IDLE_PROMPT_AFTER_WINDOWS, "pripomienka presne raz, po dlhšom tichu");
      sim.send({ type: "SPEECH_DONE" });
      sim.send({ type: "MIC_READY" });
    }
    assert.equal(sim.state.status, "listening", `okno ${window}`);
  }
  assert.equal(prompts, 1);
  sim.send({ type: "NO_SPEECH" });
  assert.equal(sim.state.status, "stopped", "veľmi dlhé ticho → koniec");
  assert.equal(sim.state.stopReason, "no_speech");
  assert.equal(sim.micOpen, false);
  // Veta počítadlo nuluje.
  const again = simulate();
  again.send({ type: "USER_TAP" });
  again.send({ type: "MIC_READY" });
  for (let i = 0; i < IDLE_PROMPT_AFTER_WINDOWS - 1; i++) again.send({ type: "NO_SPEECH" });
  again.send({ type: "UTTERANCE_CAPTURED" });
  assert.equal(again.state.idleWindows, 0);
  for (const reason of ["hidden", "offline", "mic_lost", "navigation", "session_end"] as const) {
    const s = simulate();
    s.send({ type: "USER_TAP" });
    s.send({ type: "MIC_READY" });
    s.send({ type: "STOP", reason });
    assert.equal(s.state.status, "stopped", reason);
    assert.equal(s.micOpen, false, reason);
  }
});

await check("relácia: tlačidlo „Áno“ počas relácie ide tou istou cestou a zruší počúvanie", () => {
  const sim = simulate();
  sim.send({ type: "USER_TAP" });
  sim.send({ type: "MIC_READY" });
  const manual = sim.send({ type: "MANUAL_TURN", text: "Áno" });
  assert.equal(sim.state.status, "waiting_server");
  assert.deepEqual(manual.effects.map((effect) => effect.type), ["cancelListen", "releaseMic", "cancelSpeech", "sendTurn"]);
  // Mimo relácie tlačidlo reláciu nespustí.
  const idle = voiceSessionReducer(INITIAL_VOICE_SESSION, { type: "MANUAL_TURN", text: "Áno" });
  assert.equal(idle.state.status, "idle");
  assert.equal(idle.effects.length, 0);
});

await check("relácia: bez povolenia mikrofónu → chyba, nič nepočúva", () => {
  const sim = simulate();
  sim.send({ type: "USER_TAP" });
  sim.send({ type: "MIC_FAILED", reason: "denied" });
  assert.equal(sim.state.status, "error");
  assert.equal(sim.state.noticeKey, "micDenied");
  assert.ok(!sim.log.includes("listen"));
});

await check("UI: písanie ani formuláre reláciu nespúšťajú; štart IBA ťuknutím na mikrofón", () => {
  const dashboard = readFileSync("app/components/Dashboard.tsx", "utf8");
  const launcher = readFileSync("app/components/voice/VoiceLauncher.tsx", "utf8");
  const hook = readFileSync("hooks/use-voice-session.ts", "utf8");
  for (const [name, source] of [["dashboard", dashboard], ["launcher", launcher]] as const) {
    // Jediné miesto, ktoré reláciu spúšťa, je ovládací prvok mikrofónu.
    assert.equal((source.match(/voice\.tap/g) ?? []).length, 1, `${name}: voice.tap iba na mikrofóne`);
    assert.ok(/<VoiceSessionControl[^>]*onTap=\{voice\.tap\}/.test(source), `${name}: tap je iba onTap mikrofónu`);
    assert.ok(!source.includes("useVoiceCapture("), `${name}: starý jednorazový mikrofón nie je zapojený`);
  }
  assert.ok(dashboard.includes('if (voice.active) voice.stop("manual");\n                voiceHandledTextRef.current = null;\n                setSearch(e.target.value);'), "písanie do poľa = ručný režim");
  // START vzniká iba z ťuknutia (USER_TAP v tap()).
  assert.ok(!/type: "START"/.test(hook.replace(/dispatchRef\.current\(\{ type: "START" \}\);\n\s*dispatchRef\.current\(\{ type: "MIC_FAILED"/, "")), "hook neštartuje sám");
  assert.ok(hook.includes('document.visibilityState === "hidden"') && hook.includes('"offline"') && hook.includes('"pagehide"'), "súkromie: pozadie/offline/odchod");
  assert.ok(hook.includes('event === "SIGNED_OUT"'), "odhlásenie zastaví reláciu");
});

await check("UI: syntéza čaká na skutočný koniec (onend/onerror), mikrofón sa uvoľňuje po každej vete", () => {
  const speech = readFileSync("lib/voice/speech.ts", "utf8");
  assert.ok(speech.includes("utterance.onend = () => finish(\"ended\");") && speech.includes("utterance.onerror"));
  assert.ok(speech.includes("synth.speaking || synth.pending"), "poistka podľa skutočného stavu syntézy");
  const capture = readFileSync("lib/voice/utterance-capture.ts", "utf8");
  assert.ok(capture.includes("echoCancellation: true"));
  assert.ok(capture.includes("track.stop()"), "release zastaví stopy mikrofónu");
  assert.ok(capture.includes("recorder.onstop = () =>"), "koniec nahrávky podľa udalosti stop");
});

await check("hlasový náhľad: za súhrn sa pridá otázka na potvrdenie (iba v relácii)", () => {
  const preview: IntentResult = { kind: "action_preview", action: "INVENTORY_QUANTITY_ADJUST", summary: "Zmením stav.", confirmLabel: "Zmeniť", cancelLabel: "Zrušiť", confirmationId: "x", destructive: false } as IntentResult;
  assert.equal(spokenTextFor(preview), "Zmením stav.");
  assert.equal(spokenTextFor(preview, { confirmPrompt: t("search.voice.session.confirmPrompt") }), `Zmením stav. ${t("search.voice.session.confirmPrompt")}`);
});

// =============================================================================
// 6. KONIEC VETY PODĽA TICHA
// =============================================================================

function feed(levels: [number, number][], step = 50) {
  const vad = createVad({ ...DEFAULT_VAD, maxMs: 20_000 });
  let elapsed = 0;
  let verdict = "waiting";
  for (const [level, duration] of levels) {
    for (let t0 = 0; t0 < duration; t0 += step) {
      verdict = vad.push(level, elapsed);
      if (verdict === "end" || verdict === "no_speech" || verdict === "too_long") return { verdict, elapsed };
      elapsed += step;
    }
  }
  return { verdict, elapsed };
}

await check("VAD: krátke „áno“ (300 ms) sa zachytí a ukončí po 900 ms ticha", () => {
  const r = feed([[0.004, 500], [0.12, 300], [0.004, 2000]]);
  assert.equal(r.verdict, "end");
  assert.ok(r.elapsed >= 500 + 300 + 850 && r.elapsed <= 500 + 300 + 1000, String(r.elapsed));
});

await check("VAD: reč hneď od začiatku (bez ticha na kalibráciu) sa nezahodí", () => {
  assert.equal(feed([[0.1, 400], [0.004, 1500]]).verdict, "end");
});

await check("VAD: klik (50 ms) nie je veta; ticho → no_speech po 8 s; strop dĺžky", () => {
  assert.equal(feed([[0.004, 300], [0.3, 50], [0.004, 9000]]).verdict, "no_speech");
  const long = createVad({ ...DEFAULT_VAD, maxMs: 1000 });
  assert.equal(long.push(0.2, 1000), "too_long");
});

await check("VAD: prirodzená pauza v krátkej vete („päť … kusov“) ju nerozsekne", () => {
  const r = feed([[0.004, 300], [0.1, 300], [0.004, 500], [0.1, 300], [0.004, 1500]]);
  assert.equal(r.verdict, "end");
  assert.ok(r.elapsed > 300 + 300 + 500 + 300, "koniec až po druhom slove");
});

await check("žiadne testovacie meno v produkčnom kóde novej logiky", () => {
  for (const file of ["lib/intents/slot-replies.ts", "lib/voice/voice-session.ts", "lib/voice/vad.ts", "hooks/use-voice-session.ts"]) {
    const source = readFileSync(file, "utf8");
    for (const name of [ITEM, OTHER, "Sprej", "Takeuchi"]) assert.ok(!source.includes(name), `${file}: ${name}`);
  }
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
