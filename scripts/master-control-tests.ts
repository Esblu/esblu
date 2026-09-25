// =============================================================================
// Master Product Control Layer — prirodzené príkazy, potvrdenia, hlasové
// odpovede, push notifikácie a Google/Apple prihlásenie (aplikačná logika).
//
// SPUSTENIE
//   npm run test:master-control
//
// Všetko synteticky: pamäťová DB (scripts/support/memory-db.ts), ten istý
// orchestrátor ako /api/assistant/intent, čisté moduly pre push a OAuth.
// Kryptografia push sa overuje kolom zašifruj → dešifruj (RFC 8291) a
// overením VAPID podpisu verejným kľúčom — nie falšovaním poskytovateľa.
// =============================================================================

import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { readFileSync } from "node:fs";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "cd".repeat(32);
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { makeDb, COMPANY_A, COMPANY_B, USER_A, type Role, type Row, type Tables } from "./support/memory-db.ts";

const { parseIntentDeterministic } = await import("@/lib/intents/parse");
const { runAssistantTurnDetailed } = await import("@/lib/intents/orchestrator");
const { executeAction } = await import("@/lib/intents/actions");
const { translate } = await import("@/lib/i18n/translate");
const { spokenTextFor, speechLangFor } = await import("@/lib/voice/spoken-text");
const push = await import("@/lib/push/web-push-crypto");
const routing = await import("@/lib/push/routing");
const oauth = await import("@/lib/auth/oauth-routing");

type IntentResult = import("@/lib/intents/types").IntentResult;

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
const CONV = "abcdef0123456789abcdef0123456789";
const ACCESS: Record<Role, (f: boolean) => { financeView: boolean; financeManage: boolean; canOperate: boolean }> = {
  owner: () => ({ financeView: true, financeManage: true, canOperate: true }),
  admin: (f) => ({ financeView: f, financeManage: f, canOperate: true }),
  accountant: () => ({ financeView: true, financeManage: true, canOperate: false }),
  employee: (f) => ({ financeView: f, financeManage: f, canOperate: true }),
};
type Env = ReturnType<typeof makeDb>;
function session(env: Env, opts: { module?: string; conversationId?: string | null } = {}) {
  let pending: string | null = null;
  const ctx = ACCESS[env.state.role](env.state.financeManage);
  return {
    get pending() { return pending; },
    async say(text: string) {
      const { output, finalIntent } = await runAssistantTurnDetailed(
        { db: env.db, classifyWithAi: async () => null },
        {
          rawText: text, locale: "sk", userId: env.userId, companyId: env.companyId, role: env.state.role, ...ctx,
          conversationId: opts.conversationId === undefined ? CONV : opts.conversationId, pendingClarification: pending,
          structuredPartnerId: null, issueDate: "2026-09-25", uiContext: null, moduleContext: opts.module as never, selection: null, folderContextId: null,
        }
      );
      pending = output.pendingClarification ?? null;
      return { result: output.result, intent: finalIntent };
    },
  };
}
const say = (r: IntentResult) => ((r as { text?: string }).text ?? (r as { question?: string }).question ?? (r as { summary?: string }).summary ?? "").replace(/ /g, " ");
async function confirm(env: Env, result: IntentResult) {
  assert.equal(result.kind, "action_preview", JSON.stringify(result));
  return executeAction(env.db, "sk", { companyId: env.companyId, userId: env.userId, role: env.state.role as never }, (result as { confirmationId: string }).confirmationId);
}
const parsed = (text: string, module?: string) => {
  const intent = parseIntentDeterministic(text, module ? { module: module as never } : {});
  // Parser necháva nevyplnené kľúče ako undefined — porovnávajú sa iba hodnoty.
  return intent ? { ...intent, args: JSON.parse(JSON.stringify(intent.args)) as typeof intent.args } : null;
};

// =============================================================================
// 1. PRIRODZENÉ ZNENIA — rovnaký zámer, rôzne slová (nie jedna fráza)
// =============================================================================

await check("priečinok: „Vytvor / Sprav mi / Nový priečinok Dodacie listy“ → FOLDER_CREATE (nikdy hľadanie dodacích listov)", () => {
  for (const phrase of ["Vytvor priečinok Dodacie listy.", "Sprav mi priečinok Dodacie listy.", "Nový priečinok Dodacie listy.", "Založ priečinok Dodacie listy."]) {
    const intent = parsed(phrase);
    assert.equal(intent?.name, "FOLDER_CREATE", phrase);
    assert.equal(intent?.args.folderName, "Dodacie listy", phrase);
  }
});

await check("priečinok: premenovanie, export, stiahnutie, otvorenie, presun", () => {
  assert.deepEqual(parsed("Premenuj priečinok August na September.")?.args, { folderName: "August", newName: "September" });
  assert.equal(parsed("Premenuj priečinok August na September.")?.name, "FOLDER_RENAME");
  assert.equal(parsed("Exportuj priečinok August.")?.name, "FOLDER_EXPORT");
  assert.equal(parsed("Stiahni priečinok August.")?.name, "FOLDER_EXPORT");
  assert.equal(parsed("Otvor priečinok August.")?.name, "FOLDER_OPEN");
  assert.equal(parsed("Presuň tieto dokumenty do priečinka August.")?.name, "FOLDER_ADD_ITEMS");
  assert.equal(parsed("Zmaž priečinok August.")?.name, "FOLDER_DELETE");
});

await check("faktúra: „Vytvor faktúru“, „Potrebujem / Priprav faktúru pre X“, „Vystav faktúru pre X za …“ → draft", () => {
  for (const phrase of ["Vytvor faktúru.", "Potrebujem faktúru pre Stavby Kysuce.", "Priprav faktúru pre Stavby Kysuce.", "Vystav faktúru pre Müller Bau za kopanie 300 eur.", "Chcem faktúru pre Stavby Kysuce."]) {
    assert.equal(parsed(phrase)?.name, "CREATE_INVOICE_DRAFT", phrase);
  }
  assert.equal(parsed("Potrebujem faktúru pre Stavby Kysuce.")?.args.partnerQuery, "Stavby Kysuce");
});

await check("servis: „Pridaj servis Takeuchi“, „Na Takeuchi bola výmena oleja“, „Zaeviduj servis stroja Takeuchi“ → servis, NIKDY nový stroj", () => {
  for (const phrase of ["Pridaj servis Takeuchi.", "Na Takeuchi bola výmena oleja.", "Zaeviduj servis stroja Takeuchi.", "Na Takeuchi 323 bol servis za 350 eur, výmena oleja.", "Pridaj servis k Takeuchi 323."]) {
    const intent = parsed(phrase);
    assert.equal(intent?.name, "MACHINE_SERVICE_ADD", phrase);
    assert.notEqual(intent?.name, "MACHINE_CREATE", phrase);
  }
  assert.deepEqual(parsed("Na Takeuchi 323 bol servis za 350 eur, výmena oleja.")?.args, { query: "Takeuchi 323", serviceTitle: "výmena oleja", amount: 350 });
  assert.equal(parsed("Na AB123CD sa robil servis, výmena bŕzd.")?.name, "VEHICLE_SERVICE_ADD");
});

await check("sklad: PRIDAŤ / UBRAŤ / NASTAVIŤ sa nikdy nezamenia", () => {
  const cases: [string, "add" | "subtract" | "set", number][] = [
    ["Pridaj 20 vrutov.", "add", 20],
    ["Zvýš počet vrutov o 20.", "add", 20],
    ["Zvýš počet vrutov v sklade o 20.", "add", 20],
    ["Zníž Sprej o 2 kusy.", "subtract", 2],
    ["Nastav Sprej na 5 kusov.", "set", 5],
    ["Pridaj do skladu 5 kusov spreja.", "add", 5],
  ];
  for (const [phrase, mode, quantity] of cases) {
    const intent = parsed(phrase);
    assert.equal(intent?.name, "INVENTORY_QUANTITY_ADJUST", phrase);
    assert.equal(intent?.args.quantityMode, mode, phrase);
    assert.equal(intent?.args.quantity, quantity, phrase);
  }
  assert.equal(parsed("Vymaž položku Sprej.")?.name, "INVENTORY_ITEM_DELETE");
  assert.deepEqual(parsed("Premenuj položku Sprej na Sprej červený.")?.args, { query: "Sprej", newName: "Sprej červený" });
  assert.equal(parsed("Koľko máme vrutov?")?.name, "INVENTORY_ITEM_STATUS");
});

await check("doklady: čítanie, číslo faktúry, výber na export, vozidlo", () => {
  assert.equal(parsed("Otvor faktúru 2026001.")?.name, "SEARCH_INVOICE");
  assert.equal(parsed("Otvor faktúru 2026001.")?.args.query, "2026001");
  assert.equal(parsed("Ukáž bločky za august.")?.name, "SEARCH_DOCUMENTS");
  assert.equal(parsed("Ukáž dodacie listy.")?.name, "SEARCH_DOCUMENTS");
  assert.deepEqual(parsed("Exportuj tieto dokumenty.")?.args, { useSelection: true });
  assert.deepEqual(parsed("Stiahni originály.")?.args, { useSelection: true });
  assert.equal(parsed("Nájdi dokumenty k AB123CD.")?.name, "SHOW_VEHICLE_DOCUMENTS");
  assert.equal(parsed("Ukáž STK AB123CD.")?.name, "VEHICLE_STK_STATUS");
});

// =============================================================================
// 2. NEGATÍVNE — podobná veta nesmie spustiť nesprávnu akciu
// =============================================================================

await check("negatívne: priečinok ≠ hľadanie; servis ≠ nový stroj; „Addison 2“ ≠ sklad; nákup so sumou ≠ sklad", () => {
  assert.notEqual(parsed("Vytvor priečinok Dodacie listy.")?.name, "SEARCH_DOCUMENTS");
  assert.notEqual(parsed("Pridaj servis Takeuchi.")?.name, "MACHINE_CREATE");
  assert.notEqual(parsed("Addison 2")?.name, "INVENTORY_QUANTITY_ADJUST");
  assert.notEqual(parsed("Pridaj 2 kusy za 300 eur.")?.name, "INVENTORY_QUANTITY_ADJUST");
  assert.notEqual(parsed("Pridaj servis za 250 eur.")?.name, "INVENTORY_QUANTITY_ADJUST");
  assert.notEqual(parsed("Premenuj faktúru 2026001 na X.")?.name, "FOLDER_RENAME");
});

// =============================================================================
// 3. ORCHESTRÁTOR — premenovanie, sklad, servis (náhľad → potvrdenie)
// =============================================================================

await check("premenovanie priečinka: presný cieľ → náhľad → potvrdenie → premenovaný; doklady ostanú", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: {
    document_folders: [{ id: "f-aug", name: "August", created_at: "2026-09-01" }],
    document_folder_items: [{ id: "i1", folder_id: "f-aug", document_id: "d1", invoice_id: null }],
  } });
  const r = await session(env).say("Premenuj priečinok August na September.");
  assert.equal(say(r.result), t("folders.intent.renameSummary", { name: "August", newName: "September" }));
  assert.equal((env.state.tables.document_folders[0] as Row).name, "August", "pred potvrdením sa nič nemení");
  const done = await confirm(env, r.result);
  assert.ok(done.kind === "action_result" && done.success, JSON.stringify(done));
  assert.equal((env.state.tables.document_folders[0] as Row).name, "September");
  assert.equal(env.state.tables.document_folder_items.length, 1);
  // Jednorazové: to isté potvrdenie druhýkrát nič nevykoná.
  const replay = await confirm(env, r.result);
  assert.ok(replay.kind === "action_result" && !replay.success);
});

await check("premenovanie priečinka: kolízia mien a približný cieľ → bez zápisu", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: {
    document_folders: [{ id: "f-a", name: "August", created_at: "2026-09-01" }, { id: "f-s", name: "September", created_at: "2026-09-02" }],
  } });
  const clash = await session(env).say("Premenuj priečinok August na September.");
  assert.equal(clash.result.kind, "action_result");
  assert.equal(env.state.confirmations.length, 0);
  const fuzzy = await session(env).say("Premenuj priečinok Augus na Október.");
  assert.notEqual(fuzzy.result.kind, "action_preview", "približný cieľ sa nikdy nepremenuje bez otázky");
});

await check("premenovanie skladovej položky → náhľad → potvrdenie; zamestnanec odmietnutý pred dotazom", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { inventory_items: [{ id: "i-s", name: "Sprej", quantity: 12, unit: "ks" }] } });
  const r = await session(env).say("Premenuj položku Sprej na Sprej červený.");
  assert.equal(say(r.result), t("assistant.inventory.renameSummary", { name: "Sprej", newName: "Sprej červený" }));
  await confirm(env, r.result);
  assert.equal((env.state.tables.inventory_items[0] as Row).name, "Sprej červený");
  assert.equal((env.state.tables.inventory_items[0] as Row).quantity, 12);
  const employee = makeDb({ role: "employee", financeManage: false, tables: { inventory_items: [{ id: "i-s", name: "Sprej", quantity: 12, unit: "ks" }] } });
  const denied = await session(employee).say("Premenuj položku Sprej na X.");
  assert.equal(say(denied.result), t("assistant.denied.employee"));
  assert.equal(employee.state.queries, 0);
});

await check("sklad: +20 / −2 / NASTAV 5 → presné nové množstvo v náhľade aj po potvrdení", async () => {
  const items = (): Tables => ({ inventory_items: [{ id: "i-v", name: "Vruty", quantity: 100, unit: "ks" }, { id: "i-s", name: "Sprej", quantity: 12, unit: "ks" }] });
  for (const [phrase, id, expected] of [["Pridaj 20 vrutov.", "i-v", 120], ["Zníž Sprej o 2 kusy.", "i-s", 10], ["Nastav Sprej na 5 kusov.", "i-s", 5]] as const) {
    const env = makeDb({ role: "owner", financeManage: true, tables: items() });
    const r = await session(env).say(phrase);
    assert.equal(r.result.kind, "action_preview", `${phrase}: ${JSON.stringify(r.result)}`);
    assert.equal((env.state.confirmations[0].canonical_args as Row).newQuantity, expected, phrase);
    await confirm(env, r.result);
    assert.equal((env.state.tables.inventory_items.find((row) => row.id === id) as Row).quantity, expected, phrase);
  }
});

await check("servis ručne aj hlasom — tá istá tabuľka a stĺpce; bez popisu sa asistent spýta", async () => {
  const machines = (): Tables => ({ machines: [{ id: "m-t", name: "Takeuchi 323", company_id: COMPANY_A }] });
  // „Pridaj servis k Takeuchi 323." → otázka na popis → „výmena oleja a filtrov" → náhľad → zápis
  const env = makeDb({ role: "owner", financeManage: true, tables: machines() });
  const s = session(env);
  const q = await s.say("Pridaj servis k Takeuchi 323.");
  assert.equal(say(q.result), t("assistant.service.askTitle", { name: "Takeuchi 323" }));
  const preview = await s.say("výmena oleja a filtrov");
  assert.equal(preview.result.kind, "action_preview", JSON.stringify(preview.result));
  await confirm(env, preview.result);
  const row = env.state.tables.machine_services[0] as Row;
  assert.deepEqual({ machine: row.machine_id, title: row.title, date: row.service_date }, { machine: "m-t", title: "výmena oleja a filtrov", date: "2026-09-25" });
  assert.equal(env.state.tables.machines.length, 1, "žiadny nový stroj");
  // Rovnaké stĺpce ako ručný formulár (app/stroje/MachineDetailView.tsx).
  const manual = readFileSync("app/stroje/MachineDetailView.tsx", "utf8");
  for (const column of ["machine_id", "user_id", "service_date", "title", "cost"]) assert.ok(manual.includes(`${column}`), column);

  // „Pridaj servis Takeuchi." — meno stroja nie je popis.
  const env2 = makeDb({ role: "owner", financeManage: true, tables: machines() });
  const s2 = session(env2);
  const q2 = await s2.say("Pridaj servis Takeuchi 323.");
  assert.equal(say(q2.result), t("assistant.service.askTitle", { name: "Takeuchi 323" }));
  const p2 = await s2.say("výmena oleja");
  assert.equal(p2.result.kind, "action_preview", JSON.stringify(p2.result));
  assert.equal((env2.state.confirmations[0].canonical_args as Row).title, "výmena oleja");

  // „Na Takeuchi 323 bol servis za 350 eur, výmena oleja." → rovno náhľad so sumou
  const env3 = makeDb({ role: "owner", financeManage: true, tables: machines() });
  const r3 = await session(env3).say("Na Takeuchi 323 bol servis za 350 eur, výmena oleja.");
  assert.equal(r3.result.kind, "action_preview");
  assert.deepEqual(env3.state.confirmations[0].canonical_args, { machineId: "m-t", title: "výmena oleja", serviceDate: "2026-09-25", cost: 350 });
});

await check("„Stiahni originály“ / „Exportuj tieto dokumenty“ na nástenke bez výberu → otázka, nikdy „všetko“ (orchestrátor)", async () => {
  const docs = (): Tables => ({ documents: [{ id: "d1", document_type: "receipt", company_id: COMPANY_A, deleted_at: null }] });
  for (const phrase of ["Stiahni originály.", "Exportuj tieto dokumenty.", "Stiahni tieto doklady."]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: docs() });
    const r = await session(env).say(phrase);
    assert.equal(r.intent?.name, "DOCUMENTS_EXPORT", phrase);
    assert.equal(say(r.result), t("folders.intent.noSelection"), phrase);
    assert.notEqual(r.result.kind, "action_preview", phrase);
  }
});

await check("DOCUMENTS_EXPORT handler: bez výberu aj bez filtra nikdy nevyberie všetky doklady", async () => {
  const { handleFolderIntent } = await import("@/lib/intents/folder-intents");
  const env = makeDb({ role: "owner", financeManage: true, tables: { documents: [{ id: "d1", document_type: "receipt", company_id: COMPANY_A, deleted_at: null }] } });
  const ctx = { companyId: COMPANY_A, userId: USER_A, selection: null, sourceFolderId: null, folderContextId: null };
  const noConfirm = async () => null;
  const a = await handleFolderIntent(env.db, "sk", { name: "DOCUMENTS_EXPORT", args: { useSelection: true }, source: "deterministic" }, ctx, noConfirm);
  assert.equal(say(a), t("folders.intent.noSelection"));
  const b = await handleFolderIntent(env.db, "sk", { name: "DOCUMENTS_EXPORT", args: {}, source: "deterministic" }, ctx, noConfirm);
  assert.equal(say(b), t("folders.intent.missingFilter"));
  const c = await handleFolderIntent(env.db, "sk", { name: "DOCUMENTS_EXPORT", args: { useSelection: true }, source: "deterministic" }, { ...ctx, selection: [] }, noConfirm);
  assert.equal(say(c), t("folders.intent.noSelection"), "prázdny výber = žiadny výber");
});

await check("nástenka = globálne centrum: faktúra, servis, sklad, priečinok, export, partner bez otvárania modulu", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { machines: [{ id: "m-t", name: "Takeuchi", company_id: COMPANY_A }] } });
  const expectations: [string, string][] = [
    ["Vytvor faktúru.", "CREATE_INVOICE_DRAFT"],
    ["Pridaj servis k Takeuchi.", "MACHINE_SERVICE_ADD"],
    ["Ukáž sklad.", "SEARCH_INVENTORY_ITEM"],
    ["Vytvor priečinok August.", "FOLDER_CREATE"],
    ["Exportuj bločky za august.", "EXPORT_DOCUMENTS"],
    ["Nájdi partnera Stavby Kysuce.", "SEARCH_PARTNER"],
  ];
  for (const [phrase, name] of expectations) {
    const r = await session(env, { module: "dashboard" }).say(phrase);
    assert.equal(r.intent?.name, name, phrase);
  }
});

// =============================================================================
// 4. POTVRDENIA — tlačidlá Áno/Nie idú tou istou cestou; väzba a expirácia
// =============================================================================

await check("„Myslíte …?“ nesie tlačidlá Áno / Nie; tlačidlo = tá istá odpoveď", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { inventory_items: [{ id: "i-k", name: "Kotúč na asfalt", quantity: 3, unit: "ks" }] } });
  const s = session(env);
  const r = await s.say("Vymaž skladovú položku kotúča na asfalt.");
  assert.deepEqual((r.result as { quickReplies?: unknown }).quickReplies, [{ label: "Áno", text: "Áno" }, { label: "Nie", text: "Nie" }]);
  const yes = await s.say("Áno");
  assert.equal(yes.result.kind, "action_preview");
  assert.equal((yes.result as { destructive?: boolean }).destructive, true);
});

await check("otázka faktúry s jediným kandidátom na odberateľa nesie Áno / Nie", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { business_partners: [{ id: "00000000-0000-4000-8000-0000000000e1", legal_name: "Tester1", ico: "12345678", company_id: COMPANY_A }] } });
  const r = await session(env).say("Vytvor faktúru pre Tester jeden.");
  assert.equal(r.result.kind, "clarify");
  assert.deepEqual((r.result as { quickReplies?: { text: string }[] }).quickReplies?.map((q) => q.text), ["Áno", "Nie"]);
});

await check("potvrdenie: iný používateľ ani iná firma ho neuplatní; replay nič nevykoná", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { document_folders: [{ id: "f-aug", name: "August", created_at: "2026-09-01" }] } });
  const r = await session(env).say("Zmaž priečinok August.");
  const id = (r.result as { confirmationId: string }).confirmationId;
  const other = makeDb({ role: "owner", financeManage: true, companyId: COMPANY_B, tables: { document_folders: [] } });
  (other.state as { confirmations: Row[] }).confirmations = env.state.confirmations; // tá istá tabuľka potvrdení
  const foreign = await executeAction(other.db, "sk", { companyId: COMPANY_B, userId: USER_A, role: "owner" as never }, id);
  assert.ok(foreign.kind === "action_result" && !foreign.success, "firma B potvrdenie firmy A neuplatní");
  const ok = await confirm(env, r.result);
  assert.ok(ok.kind === "action_result" && ok.success);
  const replay = await confirm(env, r.result);
  assert.ok(replay.kind === "action_result" && !replay.success);
});

// =============================================================================
// 5. HLASOVÉ ODPOVEDE — čo Esblu povie nahlas
// =============================================================================

await check("hlasová odpoveď = text na obrazovke; draft bez súm; jazyk podľa appky", () => {
  assert.equal(spokenTextFor({ kind: "clarify", question: "Pre ktorého odberateľa?", conversationId: "x" }), "Pre ktorého odberateľa?");
  assert.equal(spokenTextFor({ kind: "answer", text: "Hotovo." }), "Hotovo.");
  const draft = spokenTextFor({ kind: "draft_created", title: "Koncept je pripravený", note: "Skontrolujte ho.", summary: [{ label: "Suma", value: "1 832 EUR" }], entity: { type: "document", id: "1", label: "x", href: "/" } }) ?? "";
  assert.ok(!draft.includes("1 832"), "sumy z draftu sa nečítajú");
  assert.equal(spokenTextFor({ kind: "navigate", entity: { type: "folder", id: "1", label: "x", href: "/" } }), null);
  assert.deepEqual(["sk", "de", "en", "cs"].map(speechLangFor), ["sk-SK", "de-DE", "en-GB", "cs-CZ"]);
  // Písaný text nikdy nerozpráva: hovorí IBA hlasová relácia (useVoiceSession);
  // launcher ani nástenka nevolajú syntézu reči priamo a písanie reláciu končí.
  const launcher = readFileSync("app/components/voice/VoiceLauncher.tsx", "utf8");
  const dashboard = readFileSync("app/components/Dashboard.tsx", "utf8");
  for (const source of [launcher, dashboard]) {
    assert.ok(!/\bspeak\(/.test(source), "žiadne priame speak() mimo relácie");
    assert.ok(source.includes('voice.stop("manual")'), "ručný zásah reláciu ukončí");
  }
  assert.ok(launcher.includes('if (voice.active) voice.stop("manual");\n    cancelSpeech();\n    setTranscript(answer);'), "písaná odpoveď = ručný režim");
  assert.ok(readFileSync("lib/voice/speech.ts", "utf8").includes("synth.cancel();"), "nová odpoveď preruší starú");
});

// =============================================================================
// 6. PUSH — kryptografia, smerovanie, súkromie
// =============================================================================

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

await check("Web Push: zašifrované (RFC 8291) sa dá dešifrovať kľúčmi zariadenia", () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const authSecret = randomBytes(16);
  const subscription = { p256dh: push.base64UrlEncode(ua.getPublicKey()), auth: push.base64UrlEncode(authSecret) };
  const plaintext = Buffer.from(JSON.stringify({ title: "Nová správa v Esblu" }));
  const body = push.encryptPushPayload(plaintext, subscription);
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdhSecret = ua.computeSecret(asPublic);
  const ikm = hkdf(authSecret, ecdhSecret, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const decrypted = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  assert.equal(decrypted[decrypted.length - 1], 2, "delimiter posledného záznamu");
  assert.deepEqual(decrypted.subarray(0, decrypted.length - 1), plaintext);
  assert.equal(body.readUInt32BE(16), 4096);
});

await check("VAPID: JWT podpísaný súkromným kľúčom sa overí verejným; aud = pôvod endpointu", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { d: string };
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-65);
  const vapid = { publicKey: push.base64UrlEncode(raw), privateKey: jwk.d, subject: "mailto:info@esblu.com" };
  const header = push.vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", vapid, 1_800_000_000);
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(match);
  const claims = JSON.parse(push.base64UrlDecode(match![2]).toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:info@esblu.com");
  const ok = verify("sha256", Buffer.from(`${match![1]}.${match![2]}`), { key: createPublicKey(publicKey.export({ format: "pem", type: "spki" })), dsaEncoding: "ieee-p1363" }, push.base64UrlDecode(match![3]));
  assert.ok(ok);
});

await check("push smerovanie: chat bez autora (aj zamestnanec); termíny iba vlastník/admin; neaktívny nikdy", () => {
  const members = [
    { userId: "owner", role: "owner" }, { userId: "admin", role: "admin" }, { userId: "acc", role: "accountant" },
    { userId: "emp", role: "employee" }, { userId: "gone", role: "employee", status: "disabled" },
  ];
  assert.deepEqual(routing.chatRecipients({ type: "company", memberUserIds: [] }, members, "owner").sort(), ["acc", "admin", "emp"]);
  assert.deepEqual(routing.chatRecipients({ type: "direct", memberUserIds: ["owner", "emp", "foreign"] }, members, "owner"), ["emp"], "cudzí používateľ mimo firmy nikdy");
  assert.deepEqual(routing.deadlineRecipients(members).sort(), ["admin", "owner"], "zamestnanec ani účtovník nedostane termíny");
});

await check("push súkromie: bez náhľadu všeobecný text; termíny iba počet; bezpečná relatívna cesta", () => {
  const chat = routing.buildChatPayload({ locale: "sk", conversationId: "c1", messageBody: "Faktúra 1 832 € pre Tester1", showPreview: false });
  assert.equal(chat.body, "Máte novú správu. Otvorte Esblu a prečítajte si ju.");
  assert.ok(!JSON.stringify(chat).includes("1 832"));
  const withPreview = routing.buildChatPayload({ locale: "sk", conversationId: "c1", messageBody: "Ahoj", showPreview: true });
  assert.equal(withPreview.body, "Ahoj");
  const deadlines = routing.buildDeadlinePayload({ locale: "sk", count: 3 });
  assert.ok(!/[A-Z]{2}\d{3}/.test(deadlines.body), "žiadna ŠPZ");
  for (const bad of ["https://evil.example", "//evil.example", "/../x", "javascript:alert(1)"]) assert.equal(routing.isSafeNotificationUrl(bad), false, bad);
  assert.equal(routing.isSafeNotificationUrl("/chat/c1"), true);
});

await check("push termíny: iba v zvolených oknách a po termíne raz; kľúč na deduplikáciu", () => {
  const items = [
    { deadlineType: "vehicle_stk", entityId: "v1", dueDate: "2026-10-25", daysRemaining: 30 },
    { deadlineType: "vehicle_ek", entityId: "v1", dueDate: "2026-10-10", daysRemaining: 15 },
    { deadlineType: "machine_service", entityId: "m1", dueDate: "2026-09-20", daysRemaining: -5 },
  ];
  const due = routing.deadlinesToNotify(items, [30, 7, 1, 0]);
  assert.deepEqual(due.map((d) => d.dedupeKey), ["deadline:vehicle_stk:v1:2026-10-25:30", "deadline:machine_service:m1:2026-09-20:overdue"]);
});

await check("push bezpečnosť: zariadenia iba vlastnej firmy a používateľa; revokácia pri 404/410; cron za tajomstvom", () => {
  const server = readFileSync("lib/push/server.ts", "utf8");
  assert.ok(server.includes('.eq("company_id", input.companyId)') && server.includes('.eq("user_id", userId)') && server.includes('.is("revoked_at", null)'));
  assert.ok(server.includes('outcome === "gone"'));
  const cron = readFileSync("app/api/cron/deadline-notifications/route.ts", "utf8");
  assert.ok(cron.includes("timingSafeEqual") && cron.includes("CRON_SECRET"));
  const chat = readFileSync("app/api/push/chat-message/route.ts", "utf8");
  assert.ok(chat.includes("row.author_id !== user.id") && chat.includes("chat:${row.id}"), "iba autor, raz na správu");
  const subscribe = readFileSync("app/api/push/subscribe/route.ts", "utf8");
  assert.ok(subscribe.includes('.eq("status", "active")') && !subscribe.includes("body.companyId"), "firma z členstva, nie z tela");
  const migration = readFileSync("supabase/migrations/20260927110000_push_notifications.sql", "utf8");
  assert.ok(migration.includes("NEAPLIKOVANÉ") && migration.includes("revoke all on public.notification_deliveries from public, anon, authenticated"));
  const client = readFileSync("lib/push/client.ts", "utf8");
  assert.ok(client.includes("Notification.requestPermission()") && !readFileSync("app/layout.tsx", "utf8").includes("requestPermission"), "povolenie iba z kliknutia");
});

// =============================================================================
// 7. GOOGLE / APPLE — aplikačná logika okolo callbacku
// =============================================================================

const TOKEN = "a".repeat(64);
const pending = (over: Partial<import("@/lib/auth/oauth-routing").OAuthPending> = {}) => ({ provider: "google" as const, mode: "login" as const, legalAccepted: false, at: Date.now(), ...over });

await check("OAuth: existujúci vlastník → nástenka; nový (allowlist) → onboarding; pozvaný → jeho pozvánka", () => {
  assert.equal(oauth.decideOAuthDestination({ providerError: null, hasSession: true, hasActiveMembership: true, pending: pending() }), "/");
  assert.equal(oauth.decideOAuthDestination({ providerError: null, hasSession: true, hasActiveMembership: false, pending: pending({ mode: "register", legalAccepted: true }) }), "/onboarding/company");
  assert.equal(oauth.decideOAuthDestination({ providerError: null, hasSession: true, hasActiveMembership: false, pending: pending({ mode: "invite", inviteToken: TOKEN, provider: "apple" }) }), `/invite/${TOKEN}`);
});

await check("OAuth: zrušenie / chyba / bez session (napr. beta hook odmietol) → späť na prihlásenie", () => {
  assert.equal(oauth.decideOAuthDestination({ providerError: "access_denied", hasSession: false, hasActiveMembership: false, pending: null }), "/login?oauth=cancelled");
  assert.equal(oauth.decideOAuthDestination({ providerError: "server_error", hasSession: false, hasActiveMembership: false, pending: null }), "/login?oauth=error");
  assert.equal(oauth.decideOAuthDestination({ providerError: null, hasSession: false, hasActiveMembership: false, pending: pending() }), "/login?oauth=error");
});

await check("OAuth: presmerovanie iba na pevné cesty; token pozvánky iba v tvare 64 hex (žiadny open redirect)", () => {
  for (const evil of ["https://evil.example", "../../x", "%2F%2Fevil", "a".repeat(63)]) {
    const read = oauth.readOAuthPending({ provider: "google", mode: "invite", legalAccepted: false, inviteToken: evil, at: Date.now() });
    assert.equal(read, null, evil);
  }
  const allowed = ["/", "/onboarding/company", "/login?oauth=cancelled", "/login?oauth=error", `/invite/${TOKEN}`];
  const dest = oauth.decideOAuthDestination({ providerError: null, hasSession: true, hasActiveMembership: false, pending: pending({ mode: "invite", inviteToken: TOKEN }) });
  assert.ok(allowed.includes(dest));
  assert.equal(oauth.readOAuthPending({ provider: "facebook", mode: "login", at: Date.now() }), null);
  assert.equal(oauth.readOAuthPending({ provider: "google", mode: "login", at: Date.now() - 16 * 60 * 1000 }), null, "starý záznam");
});

await check("OAuth: súhlas s dokumentmi sa zapíše IBA ak bol zaškrtnutý pred OAuth; inak LegalAcceptanceGate", () => {
  assert.equal(oauth.mayRecordRegistrationConsent(pending({ mode: "register", legalAccepted: true })), true);
  assert.equal(oauth.mayRecordRegistrationConsent(pending({ mode: "login", legalAccepted: false })), false);
  assert.equal(oauth.mayRecordRegistrationConsent(null, "email"), true, "e-mailová registrácia bez zmeny");
  assert.equal(oauth.mayRecordRegistrationConsent(null, null), true, "e-mailová registrácia bez zmeny");
  // Stratený záznam (iný kontext, PWA): Google/Apple bez záznamu → súhlas sa NEZAPÍŠE.
  assert.equal(oauth.mayRecordRegistrationConsent(null, "google"), false);
  assert.equal(oauth.mayRecordRegistrationConsent(null, "apple"), false);
  const onboarding = readFileSync("app/onboarding/company/page.tsx", "utf8");
  assert.ok(onboarding.includes("mayRecordRegistrationConsent(takeOAuthPending(), session.user.app_metadata?.provider ?? null)") && onboarding.includes("ensureMyOwnerCompany()"), "firma cez tú istú RPC s allowlistom");
});

await check("OAuth prostredie: Capacitor a iOS nainštalovaná PWA → tlačidlá skryté; prehliadač a Android PWA → áno", () => {
  assert.equal(oauth.oauthAllowedInRuntime({ isCapacitorBuild: true, isIos: false, isStandalone: false }), false);
  assert.equal(oauth.oauthAllowedInRuntime({ isCapacitorBuild: false, isIos: true, isStandalone: true }), false);
  assert.equal(oauth.oauthAllowedInRuntime({ isCapacitorBuild: false, isIos: true, isStandalone: false }), true);
  assert.equal(oauth.oauthAllowedInRuntime({ isCapacitorBuild: false, isIos: false, isStandalone: true }), true);
  assert.ok(readFileSync("lib/auth/oauth-client.ts", "utf8").includes("if (!runtimeAllowsOAuth()) return [];"));
});

await check("OAuth: tlačidlá iba pre zapnutých poskytovateľov; beta brána a pozvánky ostávajú v DB", () => {
  assert.ok(readFileSync("lib/auth/oauth-client.ts", "utf8").includes("NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS"));
  const gate = readFileSync("supabase/migrations/20260927120000_beta_gate_allow_oauth_invites.sql", "utf8");
  assert.ok(gate.includes("NEAPLIKOVANÉ") && gate.includes("ci.email = v_email") && gate.includes("ba.consumed_at is null"));
  const callback = readFileSync("app/auth/callback/page.tsx", "utf8");
  assert.ok(callback.includes('window.history.replaceState(null, "", window.location.pathname);'), "tokeny sa z adresy odstránia");
});

await check("push vlastníctvo endpointu: aktívny endpoint iného používateľa / firmy sa NEPREVEZME", () => {
  const caller = { userId: "user-a", companyId: "company-a" };
  assert.equal(routing.decideSubscriptionWrite(null, caller), "insert");
  assert.equal(routing.decideSubscriptionWrite({ userId: "user-a", companyId: "company-a", revoked: false }, caller), "update");
  assert.equal(routing.decideSubscriptionWrite({ userId: "user-a", companyId: "company-b", revoked: false }, caller), "update", "vlastné zariadenie po zmene firmy");
  assert.equal(routing.decideSubscriptionWrite({ userId: "user-b", companyId: "company-a", revoked: false }, caller), "reject", "iný používateľ, tá istá firma");
  assert.equal(routing.decideSubscriptionWrite({ userId: "user-b", companyId: "company-b", revoked: false }, caller), "reject", "iný používateľ, iná firma");
  assert.equal(routing.decideSubscriptionWrite({ userId: "user-b", companyId: "company-b", revoked: true }, caller), "update", "zrušený po odhlásení");
  const route = readFileSync("app/api/push/subscribe/route.ts", "utf8");
  assert.ok(route.includes('if (decision === "reject") return Response.json({ success: false }, { status: 409 });'), "odmietnutie bez prezradenia vlastníka");
  assert.ok(!/upsert\(/.test(route), "žiadny slepý upsert");
  assert.ok(route.includes(".or(`user_id.eq.${who.userId},revoked_at.not.is.null`)") && route.includes("(written ?? []).length !== 1"), "súbeh: prepíše iba vlastný alebo zrušený riadok");
});

await check("push tabuľky: žiadny priamy prístup klienta (ani čítanie), iba service role; prázdne okno dní zakázané", () => {
  const sql = readFileSync("supabase/migrations/20260927110000_push_notifications.sql", "utf8");
  for (const table of ["push_subscriptions", "notification_preferences", "notification_deliveries"]) {
    assert.ok(sql.includes(`alter table public.${table} enable row level security;`), table);
    assert.ok(sql.includes(`revoke all on public.${table} from public, anon, authenticated;`), table);
    assert.ok(sql.includes(`grant select, insert, update, delete on public.${table} to service_role;`), table);
  }
  const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.ok(!/grant[^;]*to\s+(authenticated|anon)/i.test(code), "žiadny grant pre authenticated/anon");
  assert.ok(!/create policy/i.test(code), "žiadne politiky = žiadny klientsky prístup");
  assert.ok(!/security\s+definer/i.test(code));
  assert.ok(sql.includes("cardinality(deadline_days) > 0") && sql.includes("cardinality(deadline_days) <= 6"));
  assert.ok(sql.includes("RETENCIA"), "retencia zdokumentovaná");
  // Prehliadač sa na tabuľky nepýta vôbec.
  for (const file of ["lib/push/client.ts", "app/components/push/PushNotificationSettings.tsx", "app/nastavenia/page.tsx"]) {
    const code = readFileSync(file, "utf8");
    assert.ok(!/push_subscriptions|notification_preferences|notification_deliveries/.test(code), file);
  }
});

await check("OAuth pozvánková brána: iba google/apple z app_metadata (nie user_metadata); iný poskytovateľ bez obchvatu", () => {
  const sql = readFileSync("supabase/migrations/20260927120000_beta_gate_allow_oauth_invites.sql", "utf8");
  assert.ok(sql.includes("v_provider := lower(btrim(coalesce(event #>> '{user,app_metadata,provider}', '')));"));
  assert.ok(sql.includes("if v_provider in ('google', 'apple') then"));
  const branch = sql.slice(sql.indexOf("if v_provider in ('google', 'apple') then"), sql.indexOf("-- Owner-registration prípad"));
  assert.ok(!branch.includes("user_metadata"), "poskytovateľ sa neberie z klientskych metadát");
  assert.ok(branch.includes("ci.status = 'pending'") && branch.includes("ci.expires_at > now()") && branch.includes("ci.email = v_email"));
  // Token vetva e-mailu a allowlist ostávajú nezmenené.
  assert.ok(sql.includes("event #>> '{user,user_metadata,esblu_invite_token}'") && sql.includes("ba.consumed_at is null"));
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
