// =============================================================================
// Dvojkrokový hlasový tok: náhľad → potvrdenie → vykonanie.
//
// SPUSTENIE
//   npm run test:voice-flow
//
// PREČO
// -----
// Jednotkové testy parsera nedokázali, že zmazanie priečinka hlasom v
// produkcii prejde. Toto skladá TIE ISTÉ moduly v TOM ISTOM poradí ako
// /api/assistant/intent a /api/assistant/action/execute:
//
//   parseIntentDeterministic → restrictedAssistantDenial → checkIntentAccess
//   → handleFolderIntent / handleOperationalIntent (náhľad)
//   → createFolderActionConfirmation (skutočný HMAC podpis + RPC)
//   → classifyConfirmationReply („Áno, zmaž ho") — to, čo robí hlasový UI
//   → executeAction (skutočný claim + overenie podpisu + opätovná kontrola
//     oprávnenia) → executeFolderAction → deleteDocumentFolder
//
// Databáza je nahradená pamäťovým klientom, ktorý napodobňuje presne tie
// dotazy a RPC, ktoré kód volá (vrátane jednorazového claimu a CASCADE
// členstiev). RLS stranu pokrýva scripts/sql/*-rls-matrix.sql.
// =============================================================================

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "ab".repeat(32);

const { parseIntentDeterministic } = await import("@/lib/intents/parse");
const { checkIntentAccess, restrictedAssistantDenial } = await import("@/lib/intents/permissions");
const { handleFolderIntent } = await import("@/lib/intents/folder-intents");
const { handleOperationalIntent } = await import("@/lib/intents/operational-intents");
const { createFolderActionConfirmation, createOperationalActionConfirmation, executeAction } = await import("@/lib/intents/actions");
const { classifyConfirmationReply } = await import("@/lib/intents/confirmation-reply");
const { folderSpokenKey, matchFolderByName } = await import("@/lib/document-folders");

type IntentResult = import("@/lib/intents/types").IntentResult;
type AccessContext = import("@/lib/intents/permissions").AccessContext;

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

// -----------------------------------------------------------------------------
// Pamäťová „databáza" s tými dotazmi, ktoré kód skutočne robí
// -----------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Role = "owner" | "admin" | "accountant" | "employee";

const COMPANY = "00000000-0000-4000-8000-0000000000c1";
const USER = "00000000-0000-4000-8000-0000000000a1";

function makeDb(opts: { role: Role; financeManage: boolean; folders: Array<{ name: string; items: number }> }) {
  const state = {
    role: opts.role,
    financeManage: opts.financeManage,
    folders: [] as Row[],
    items: [] as Row[],
    documents: [] as Row[],
    confirmations: [] as Row[],
    machines: [] as Row[],
  };
  for (const folder of opts.folders) {
    const id = randomUUID();
    state.folders.push({ id, name: folder.name, description: null, created_at: new Date().toISOString(), updated_at: null, created_by: USER, company_id: COMPANY });
    for (let i = 0; i < folder.items; i++) {
      const documentId = randomUUID();
      state.documents.push({ id: documentId, company_id: COMPANY });
      state.items.push({ id: randomUUID(), folder_id: id, document_id: documentId, invoice_id: null });
    }
  }

  function table(name: string) {
    let rows: Row[] = [];
    let op: "select" | "delete" | "insert" = "select";
    let inserted: Row | null = null;
    const filters: Array<[string, unknown]> = [];
    const source = (): Row[] =>
      name === "document_folders" ? state.folders
        : name === "document_folder_items" ? state.items
          : name === "documents" ? state.documents
            : name === "machines" ? state.machines
              : [];
    const apply = () => {
      rows = source().filter((row) => filters.every(([col, value]) => row[col] === value));
    };
    const result = () => {
      apply();
      if (op === "insert") {
        source().push(inserted!);
        return { data: [inserted], error: null };
      }
      if (op === "delete") {
        const ids = new Set(rows.map((row) => row.id));
        if (name === "document_folders") {
          state.folders = state.folders.filter((row) => !ids.has(row.id));
          state.items = state.items.filter((row) => !ids.has(row.folder_id)); // ON DELETE CASCADE
        }
        return { data: rows.map((row) => ({ id: row.id })), error: null };
      }
      if (name === "document_folders") {
        return {
          data: rows.map((row) => ({ ...row, document_folder_items: [{ count: state.items.filter((i) => i.folder_id === row.id).length }] })),
          error: null,
        };
      }
      return { data: rows, error: null };
    };
    const builder: Record<string, unknown> = {
      select() { return builder; },
      insert(row: Row) { op = "insert"; inserted = { id: randomUUID(), ...row }; return builder; },
      delete() { op = "delete"; return builder; },
      eq(col: string, value: unknown) { filters.push([col, value]); return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { const r = result(); return Promise.resolve({ data: (r.data as Row[])[0] ?? null, error: null }); },
      single() { const r = result(); return Promise.resolve({ data: (r.data as Row[])[0] ?? null, error: null }); },
      then(resolve: (value: unknown) => void, reject: (e: unknown) => void) {
        try { resolve(result()); } catch (error) { reject(error); }
      },
    };
    return builder;
  }

  const rpcHandlers: Record<string, (args: Row) => unknown> = {
    esblu_my_finance_manage: () => state.financeManage,
    esblu_my_finance_view: () => state.financeManage,
    esblu_my_active_role: () => state.role,
    esblu_role_can_operate: () => state.role !== "accountant",
    esblu_create_action_confirmation: (args) => {
      const id = randomUUID();
      state.confirmations.push({
        id,
        intent: args.p_intent,
        canonical_args: args.p_canonical_args,
        expected_count: args.p_expected_count,
        nonce: args.p_nonce,
        server_proof: args.p_server_proof,
        expires_at_epoch: args.p_expires_at_epoch,
        user_id: USER,
        company_id: COMPANY,
        consumed_at: null,
      });
      return id;
    },
    // Rovnaká sémantika ako SQL: jednorazový claim, iba vlastný a neexpirovaný.
    esblu_claim_action_confirmation: (args) => {
      const row = state.confirmations.find((c) => c.id === args.p_confirmation_id);
      if (!row || row.consumed_at || Number(row.expires_at_epoch) < Date.now() / 1000) return null;
      row.consumed_at = new Date().toISOString();
      return row;
    },
  };

  const db = {
    from: table,
    rpc(name: string, args: Row = {}) {
      const value = rpcHandlers[name] ? rpcHandlers[name](args) : null;
      const response = { data: value, error: null };
      return Object.assign(Promise.resolve(response), { maybeSingle: () => Promise.resolve(response) });
    },
  };
  return { db: db as never, state };
}

// -----------------------------------------------------------------------------
// Presne poradie z /api/assistant/intent (bez HTTP obalu)
// -----------------------------------------------------------------------------

const ACCESS: Record<Role, AccessContext> = {
  owner: { role: "owner", financeView: true, financeManage: true, canOperate: true },
  admin: { role: "admin", financeView: false, financeManage: false, canOperate: true },
  accountant: { role: "accountant", financeView: true, financeManage: true, canOperate: false },
  employee: { role: "employee", financeView: false, financeManage: false, canOperate: true },
};

async function turnOne(text: string, db: never, role: Role, module?: string): Promise<{ name: string | null; result: IntentResult }> {
  const ctx = ACCESS[role];
  const intent = parseIntentDeterministic(text, module ? { module: module as never } : {});
  const restricted = restrictedAssistantDenial(intent, ctx);
  if (restricted) return { name: intent?.name ?? null, result: { kind: "error", text: `denied:${restricted}` } };
  if (!intent) return { name: null, result: { kind: "not_found", text: "not understood" } };
  const denial = checkIntentAccess(intent.name, intent.args, ctx);
  if (denial) return { name: intent.name, result: { kind: "error", text: `denied:${denial}` } };
  const actionCtx = { companyId: COMPANY, userId: USER, role: role as never };
  if (intent.name.startsWith("MACHINE_") || intent.name.startsWith("INVENTORY_")) {
    const result = await handleOperationalIntent(
      db, "sk", intent,
      { companyId: COMPANY, userId: USER, resolvedEntity: null, today: "2026-09-24" },
      (name, args, count) => createOperationalActionConfirmation(db, actionCtx, name, args, count)
    );
    return { name: intent.name, result };
  }
  const result = await handleFolderIntent(
    db, "sk", intent,
    { companyId: COMPANY, userId: USER, selection: null, sourceFolderId: null, folderContextId: null },
    (name, args, count) => createFolderActionConfirmation(db, actionCtx, name, args, count)
  );
  return { name: intent.name, result };
}

/** To, čo urobí hlasový UI s druhým prepisom pri zobrazenom náhľade. */
async function turnTwo(spoken: string, preview: IntentResult, db: never, role: Role): Promise<IntentResult | "not_a_confirmation" | "cancelled"> {
  if (preview.kind !== "action_preview") throw new Error("náhľad chýba");
  const reply = classifyConfirmationReply(spoken);
  if (reply === "cancel") return "cancelled";
  if (reply !== "confirm") return "not_a_confirmation";
  return executeAction(db, "sk", { companyId: COMPANY, userId: USER, role: role as never }, preview.confirmationId!);
}

// -----------------------------------------------------------------------------
// E/F/G — skutočný dvojkrokový tok
// -----------------------------------------------------------------------------

await check("E+F+G: „Zmaž celý priečinok Test1“ → náhľad, „Áno, zmaž ho.“ → zmazaný iba priečinok", async () => {
  const { db, state } = makeDb({ role: "owner", financeManage: true, folders: [{ name: "Test1", items: 5 }, { name: "Iný", items: 2 }] });
  const folderId = state.folders[0].id;
  const documentsBefore = state.documents.length;

  const first = await turnOne("Zmaž celý priečinok Test1.", db, "owner");
  assert.equal(first.name, "FOLDER_DELETE");
  assert.equal(first.result.kind, "action_preview");
  const preview = first.result as Extract<IntentResult, { kind: "action_preview" }>;
  assert.equal(preview.destructive, true);
  assert.equal(preview.summary, "Priečinok „Test1“ obsahuje 5 dokladov. Zmaže sa iba priečinok a zaradenie dokladov. Samotné doklady zostanú v Esblu. Naozaj ho chcete zmazať?");
  // Po prvom kroku sa nič nezmazalo; potvrdenie je viazané na presné ID.
  assert.equal(state.folders.length, 2);
  assert.equal(state.items.length, 7);
  assert.equal(state.confirmations.length, 1);
  assert.deepEqual(state.confirmations[0].canonical_args, { folderId, name: "Test1" });

  const second = await turnTwo("Áno, zmaž ho.", preview, db, "owner");
  assert.ok(typeof second === "object" && second.kind === "action_result" && second.success, JSON.stringify(second));
  assert.equal((second as { text: string }).text, "Priečinok „Test1“ je zmazaný. Doklady zostali v Esblu.");
  assert.equal(state.folders.find((f) => f.id === folderId), undefined, "priečinok ostal");
  assert.equal(state.items.filter((i) => i.folder_id === folderId).length, 0, "členstvá ostali");
  assert.equal(state.items.length, 2, "cudzie členstvá sa zmazali");
  assert.equal(state.documents.length, documentsBefore, "doklady sa zmazali");
  assert.equal(state.folders.length, 1);
});

await check("produkčný prípad: priečinok „Test 1“, hlas „test1“ → ten istý priečinok (bez fuzzy)", async () => {
  const { db, state } = makeDb({ role: "owner", financeManage: true, folders: [{ name: "Test 1", items: 5 }] });
  const first = await turnOne("Zmaž celý priečinok test1.", db, "owner");
  assert.equal(first.result.kind, "action_preview", JSON.stringify(first.result));
  const second = await turnTwo("Áno, zmaž ho.", first.result, db, "owner");
  assert.ok(typeof second === "object" && second.kind === "action_result" && second.success);
  assert.equal(state.folders.length, 0);
  assert.equal(state.documents.length, 5);
});

await check("varianty: „Vymaž priečinok Test1“, „Odstráň celý priečinok Test1“, EN, DE", async () => {
  for (const text of [
    "Vymaž priečinok Test1.",
    "Odstráň celý priečinok Test1.",
    "Delete the accounting folder Test1.",
    "Lösche den Belegordner Test1.",
    "Belegordner Test1 löschen.",
    "Zmaž priečinok test jedna",
  ]) {
    const { db, state } = makeDb({ role: "owner", financeManage: true, folders: [{ name: "Test1", items: 1 }] });
    const first = await turnOne(text, db, "owner");
    assert.equal(first.name, "FOLDER_DELETE", text);
    assert.equal(first.result.kind, "action_preview", `${text}: ${JSON.stringify(first.result)}`);
    assert.equal(state.folders.length, 1, text);
  }
});

await check("druhý krok: iné vety nie sú potvrdenie; „Nie“ zruší bez zápisu", async () => {
  const { db, state } = makeDb({ role: "owner", financeManage: true, folders: [{ name: "Test1", items: 3 }] });
  const first = await turnOne("Zmaž celý priečinok Test1.", db, "owner");
  assert.equal(await turnTwo("Zmaž priečinok Test2", first.result, db, "owner"), "not_a_confirmation");
  assert.equal(await turnTwo("Koľko máme vrutov?", first.result, db, "owner"), "not_a_confirmation");
  assert.equal(await turnTwo("Nie, nezmaž ho.", first.result, db, "owner"), "cancelled");
  assert.equal(state.folders.length, 1);
  assert.equal(state.confirmations[0].consumed_at, null);
});

await check("potvrdenie je jednorazové (replay) a podvrhnuté ID nič nezmaže", async () => {
  const { db, state } = makeDb({ role: "owner", financeManage: true, folders: [{ name: "Test1", items: 1 }, { name: "Test2", items: 1 }] });
  const first = await turnOne("Zmaž celý priečinok Test1.", db, "owner");
  const once = await turnTwo("Áno", first.result, db, "owner");
  assert.ok(typeof once === "object" && once.kind === "action_result" && once.success);
  const replay = await turnTwo("Áno", first.result, db, "owner");
  assert.ok(typeof replay === "object" && replay.kind === "action_result" && !replay.success);
  const forged = await executeAction(db, "sk", { companyId: COMPANY, userId: USER, role: "owner" as never }, randomUUID());
  assert.ok(forged.kind === "action_result" && !forged.success);
  assert.deepEqual(state.folders.map((f) => f.name), ["Test2"]);
});

await check("podvrhnutý podpis (upravené canonical_args) → nič sa nezmaže", async () => {
  const { db, state } = makeDb({ role: "owner", financeManage: true, folders: [{ name: "Test1", items: 1 }, { name: "Test2", items: 1 }] });
  const first = await turnOne("Zmaž celý priečinok Test1.", db, "owner");
  state.confirmations[0].canonical_args = { folderId: state.folders[1].id, name: "Test2" };
  const result = await turnTwo("Áno", first.result, db, "owner");
  assert.ok(typeof result === "object" && result.kind === "action_result" && !result.success);
  assert.equal(state.folders.length, 2);
});

await check("H: nejednoznačné meno → výber, žiadne potvrdenie ani zmazanie", async () => {
  const { db, state } = makeDb({ role: "owner", financeManage: true, folders: [{ name: "Test1", items: 1 }, { name: "Test 1", items: 1 }, { name: "Test10", items: 0 }] });
  // „Test1" aj „Test 1" majú rovnaký hlasový kľúč → nie je presné; asistent sa spýta.
  const first = await turnOne("Zmaž celý priečinok Test1.", db, "owner");
  assert.ok(first.result.kind === "list" || first.result.kind === "answer", first.result.kind);
  assert.equal(state.confirmations.length, 0);
  const partial = await turnOne("Zmaž priečinok Test", db, "owner");
  assert.equal(partial.result.kind, "list");
  assert.equal(state.confirmations.length, 0);
  assert.equal(state.folders.length, 3);
});

await check("neexistujúci priečinok → „Priečinok Test9 sa nenašiel.“", async () => {
  const { db, state } = makeDb({ role: "owner", financeManage: true, folders: [{ name: "Test1", items: 1 }] });
  const first = await turnOne("Zmaž priečinok Test9.", db, "owner");
  assert.equal(first.result.kind, "not_found");
  assert.match((first.result as { text: string }).text, /Test9/);
  assert.equal(state.confirmations.length, 0);
});

await check("I: zamestnanec → odmietnutý, žiadny dotaz na priečinky", async () => {
  const { db, state } = makeDb({ role: "employee", financeManage: false, folders: [{ name: "Test1", items: 1 }] });
  const first = await turnOne("Zmaž celý priečinok Test1.", db, "employee");
  assert.equal(first.result.kind, "error");
  assert.equal((first.result as { text: string }).text, "denied:assistant_scope");
  assert.equal(state.confirmations.length, 0);
  assert.equal(state.folders.length, 1);
});

await check("J: účtovník smie; admin bez finance nie; odobratie práva medzi krokmi → nezmaže", async () => {
  const acc = makeDb({ role: "accountant", financeManage: true, folders: [{ name: "Test1", items: 1 }] });
  const accFirst = await turnOne("Zmaž celý priečinok Test1.", acc.db, "accountant");
  assert.equal(accFirst.result.kind, "action_preview");

  const admin = makeDb({ role: "admin", financeManage: false, folders: [{ name: "Test1", items: 1 }] });
  const adminFirst = await turnOne("Zmaž celý priečinok Test1.", admin.db, "admin");
  assert.equal((adminFirst.result as { text: string }).text, "denied:finance");

  const owner = makeDb({ role: "owner", financeManage: true, folders: [{ name: "Test1", items: 1 }] });
  const ownerFirst = await turnOne("Zmaž celý priečinok Test1.", owner.db, "owner");
  owner.state.financeManage = false; // právo odobraté medzi náhľadom a potvrdením
  const result = await turnTwo("Áno", ownerFirst.result, owner.db, "owner");
  assert.ok(typeof result === "object" && result.kind === "action_result" && !result.success);
  assert.equal(owner.state.folders.length, 1);
});

// -----------------------------------------------------------------------------
// A–D — vytvorenie stroja s menom (skutočný handler, bez opätovnej otázky)
// -----------------------------------------------------------------------------

await check("A: /stroje „Vytvor novú položku s názvom Aman.“ → MACHINE_CREATE(Aman) → náhľad, bez otázky na meno", async () => {
  const { db, state } = makeDb({ role: "owner", financeManage: true, folders: [] });
  const intent = parseIntentDeterministic("Vytvor novú položku s názvom Aman.", { module: "machines" });
  assert.equal(intent?.name, "MACHINE_CREATE");
  assert.equal(intent?.args.entityName, "Aman");
  const first = await turnOne("Vytvor novú položku s názvom Aman.", db, "owner", "machines");
  assert.equal(first.result.kind, "action_preview", JSON.stringify(first.result));
  assert.equal((first.result as { summary: string }).summary, "Zaevidujem nový stroj „Aman“.");
  assert.deepEqual(state.confirmations[0].canonical_args, { name: "Aman" });
});

await check("B: /sklad tá istá veta → INVENTORY_ITEM_CREATE(Aman)", () => {
  const intent = parseIntentDeterministic("Vytvor novú položku s názvom Aman.", { module: "inventory" });
  assert.equal(intent?.name, "INVENTORY_ITEM_CREATE");
  assert.equal(intent?.args.entityName, "Aman");
});

await check("C: nástenka tá istá veta → ENTITY_CREATE (route sa spýta na modul)", () => {
  const intent = parseIntentDeterministic("Vytvor novú položku s názvom Aman.", { module: "dashboard" });
  assert.equal(intent?.name, "ENTITY_CREATE");
  // Logika route žije v orchestrátore; route ho iba volá.
  assert.ok(readFileSync("app/api/assistant/intent/route.ts", "utf8").includes("runAssistantTurn("));
  const route = readFileSync("lib/intents/orchestrator.ts", "utf8");
  assert.ok(route.includes('"assistant.clarify.createModule"'));
});

await check("D + varianty: meno stroja sa nikdy nestratí", () => {
  const cases: Array<[string, string | undefined]> = [
    ["Pridaj stroj s názvom Aman.", undefined],
    ["Vytvor nový stroj Aman.", undefined],
    ["Zaeviduj stroj Aman.", undefined],
    ["Vytvor položku Aman.", "machines"],
    ["Pridaj položku Aman.", "machines"],
    ["Erstelle eine neue Maschine namens Aman.", undefined],
    ["Neue Maschine Aman anlegen.", undefined],
    ["Create a new machine called Aman.", undefined],
    ["Add machine Aman.", undefined],
  ];
  for (const [text, module] of cases) {
    const intent = parseIntentDeterministic(text, module ? { module: module as never } : {});
    assert.equal(intent?.name, "MACHINE_CREATE", text);
    assert.equal(intent?.args.entityName, "Aman", text);
  }
  // „položka" mimo Strojov NIKDY nie je stroj.
  assert.notEqual(parseIntentDeterministic("Vytvor položku Aman.", { module: "inventory" })?.name, "MACHINE_CREATE");
  assert.notEqual(parseIntentDeterministic("Vytvor položku Aman.")?.name, "MACHINE_CREATE");
});

// -----------------------------------------------------------------------------
// Pomocné funkcie
// -----------------------------------------------------------------------------

await check("folderSpokenKey: medzery, pomlčky, číslovky; nie fuzzy", () => {
  assert.equal(folderSpokenKey("Test 1"), folderSpokenKey("test1"));
  assert.equal(folderSpokenKey("Test-1"), folderSpokenKey("TEST 1"));
  assert.equal(folderSpokenKey("test jedna"), folderSpokenKey("Test 1"));
  assert.equal(folderSpokenKey("August 2026"), "august2026");
  assert.notEqual(folderSpokenKey("Test 1"), folderSpokenKey("Test 10"));
  assert.notEqual(folderSpokenKey("Test1"), folderSpokenKey("Test2"));
  const folders = [{ name: "Test 1" }, { name: "Test 10" }];
  assert.deepEqual(matchFolderByName(folders, "test1"), { folder: folders[0] });
});

await check("classifyConfirmationReply: SK/EN/DE súhlas, odmietnutie, nový príkaz", () => {
  for (const text of ["Áno, zmaž ho.", "Áno", "áno prosím", "Zmaž ho", "Potvrdzujem", "Yes, delete it", "Yes", "Ja, lösch ihn", "Ja", "Vymaž to"]) {
    assert.equal(classifyConfirmationReply(text), "confirm", text);
  }
  for (const text of ["Nie", "Nie, nezmaž ho", "Zruš", "Cancel", "Nein", "No"]) {
    assert.equal(classifyConfirmationReply(text), "cancel", text);
  }
  for (const text of ["Áno, zmaž priečinok Test2", "Zmaž priečinok Test1", "Koľko máme vrutov", "", "Ja chcem vidieť faktúry"]) {
    assert.equal(classifyConfirmationReply(text), null, text);
  }
});

await check("UI: hlasové potvrdenie je zapojené v launcheri aj na nástenke (nie ako nový príkaz)", () => {
  for (const file of ["app/components/voice/VoiceLauncher.tsx", "app/components/Dashboard.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("classifyConfirmationReply(text)"), file);
    assert.ok(source.includes("pendingPreviewRef"), file);
    // Tlačidlo nesmie odovzdať udalosť kliknutia ako „náhľad".
    assert.ok(!/onConfirm=\{handle(Action)?Confirm\}/.test(source), `${file}: onConfirm odovzdáva event`);
  }
  const launcher = readFileSync("app/components/voice/VoiceLauncher.tsx", "utf8");
  const transcript = launcher.indexOf("if (handleSpokenConfirmation(text)) return;");
  assert.ok(transcript > 0 && transcript < launcher.indexOf("void runIntent(text);", transcript));
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
