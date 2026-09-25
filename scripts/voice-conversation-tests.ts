// =============================================================================
// Viackrokový hlasový dialóg, rozlíšenie mien a Inbox hromadné príkazy.
//
// SPUSTENIE
//   npm run test:voice-conversation
//
// Skladá TIE ISTÉ moduly v TOM ISTOM poradí ako /api/assistant/intent a
// /api/assistant/action/execute (pozri runTurn nižšie a test poradia v
// route). Databáza je pamäťový klient s dotazmi, ktoré kód skutočne volá.
//
// Chráni:
//   - „Ku ktorému stroju?" → „Aman." pokračuje PÔVODNÝM príkazom so
//     zachovaným popisom servisu (nie „Nič sa nenašlo."),
//   - nový príkaz otázku nahradí, „Nechaj tak." ju zruší,
//   - vypršaná / cudzia (iný používateľ, iná firma) otázka nič nevykoná,
//   - „kotúča na asfalt" nájde „Kotúč na asfalt" — pri mazaní iba cez
//     otázku „Myslíte …?", potom deštruktívny náhľad a až potom zmazanie,
//   - „Vymaž nepriradené bločky" = náhľad s presnými ID, rovnaký filter
//     ako Inbox UI, účtovná stopa sa nemaže, nové doklady sa nepridajú.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "cd".repeat(32);
// Niektoré moduly faktúry importujú klientsky Supabase modul; v teste sa nikam nepripája.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { parseIntentDeterministic, violatesMachineCreateInvariant, isIntentCompatibleWithUtterance } = await import("@/lib/intents/parse");
const { isOperationalFamilyIntent } = await import("@/lib/intents/operational-intents");
const { isFolderFamilyIntent } = await import("@/lib/intents/folder-intents");
const { executeAction } = await import("@/lib/intents/actions");
const {
  classifyClarificationReply,
  sealPendingClarification,
  unsealPendingClarification,
  PENDING_CLARIFICATION_TTL_SECONDS,
} = await import("@/lib/intents/pending-clarification");
const { classifyConfirmationReply } = await import("@/lib/intents/confirmation-reply");
const { inflectionKey, resolveEntityByName } = await import("@/lib/intents/entity-resolution");
const { isUnassignedInboxDocument } = await import("@/lib/inbox-unassigned");
const { translate } = await import("@/lib/i18n/translate");
const { runAssistantTurnDetailed } = await import("@/lib/intents/orchestrator");
const { previewDraftTotals } = await import("@/lib/invoices");

type IntentResult = import("@/lib/intents/types").IntentResult;
type ParsedIntent = import("@/lib/intents/types").ParsedIntent;
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
// Pamäťová databáza
// -----------------------------------------------------------------------------

import { makeDb, COMPANY_A, COMPANY_B, USER_A, USER_B, type Row, type Role, type Tables } from "./support/memory-db.ts";
// -----------------------------------------------------------------------------
// Presne poradie z /api/assistant/intent (bez HTTP obalu)
// -----------------------------------------------------------------------------

const ACCESS: Record<Role, (financeManage: boolean) => AccessContext> = {
  owner: () => ({ role: "owner", financeView: true, financeManage: true, canOperate: true }),
  admin: (f) => ({ role: "admin", financeView: f, financeManage: f, canOperate: true }),
  accountant: () => ({ role: "accountant", financeView: true, financeManage: true, canOperate: false }),
  employee: () => ({ role: "employee", financeView: false, financeManage: false, canOperate: true }),
};

type Env = ReturnType<typeof makeDb>;
type Turn = { intent: ParsedIntent | null; result: IntentResult | { kind: "read"; name: string }; pending: string | null };

async function runTurn(env: Env, text: string, pending: string | null, opts: { module?: string; selection?: Array<{ type: "invoice" | "document"; id: string }>; now?: number; conversationId?: string; aiIntent?: ParsedIntent } = {}): Promise<Turn> {
  // TEN ISTÝ orchestrátor, ktorý volá /api/assistant/intent — nie kópia
  // poradia. AI klasifikátor je náhrada (vracia `aiIntent`).
  const ctx = ACCESS[env.state.role](env.state.financeManage);
  const { output, finalIntent } = await runAssistantTurnDetailed(
    { db: env.db, classifyWithAi: async () => opts.aiIntent ?? null, now: opts.now },
    {
      rawText: text,
      locale: "sk",
      userId: env.userId,
      companyId: env.companyId,
      role: env.state.role,
      financeView: ctx.financeView,
      financeManage: ctx.financeManage,
      canOperate: ctx.canOperate,
      conversationId: opts.conversationId ?? null,
      pendingClarification: pending,
      structuredPartnerId: null,
      issueDate: "2026-09-24",
      uiContext: null,
      moduleContext: opts.module as never,
      selection: opts.selection ? { items: opts.selection, folderId: null } : null,
      folderContextId: null,
    }
  );
  // Čítacie intenty mimo rodín s vlastným handlerom (sklad/stroje/vozidlá,
  // priečinky, Inbox) sa v týchto testoch neporovnávajú obsahom.
  const genericRead =
    finalIntent &&
    !isOperationalFamilyIntent(finalIntent.name) &&
    !isFolderFamilyIntent(finalIntent.name) &&
    !finalIntent.name.startsWith("INBOX_") &&
    isReadResult(output.result);
  const readOnly = genericRead ? { kind: "read" as const, name: finalIntent.name } : null;
  return { intent: finalIntent, result: readOnly ?? output.result, pending: output.pendingClarification ?? null };
}

/** Čítacie výsledky (zoznam, navigácia …) sa v týchto testoch neporovnávajú obsahom. */
function isReadResult(result: IntentResult): boolean {
  return ["list", "navigate", "report", "deadline_list", "document_list", "disambiguate"].includes(result.kind);
}

async function confirm(env: Env, result: Turn["result"]): Promise<IntentResult> {
  assert.equal(result.kind, "action_preview", JSON.stringify(result));
  return executeAction(env.db, "sk", { companyId: env.companyId, userId: env.userId, role: env.state.role as never }, (result as { confirmationId: string }).confirmationId);
}

const text = (r: Turn["result"]) => (r as { text?: string; summary?: string }).text ?? (r as { summary?: string }).summary ?? "";

const MACHINES = (): Tables => ({
  machines: [
    { id: "m-aman", name: "Aman", company_id: COMPANY_A },
    { id: "m-cat", name: "Bager CAT", company_id: COMPANY_A },
    { id: "m-b", name: "Aman", company_id: COMPANY_B },
  ],
});

// -----------------------------------------------------------------------------
// A. Servis stroja — dvojkrokový dialóg
// -----------------------------------------------------------------------------

await check("A: „Do stroja zaeviduj servis výmena filtra a oleja.“ → „Ku ktorému stroju?“ → „Aman.“ → náhľad s popisom", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MACHINES() });
  const t1 = await runTurn(env, "Do stroja zaeviduj servis výmena filtra a oleja.", null);
  assert.equal(t1.intent?.name, "MACHINE_SERVICE_ADD");
  assert.equal(t1.intent?.args.serviceTitle, "výmena filtra a oleja");
  assert.equal(text(t1.result), "Ku ktorému stroju? Povedzte jeho názov.");
  assert.ok(t1.pending, "chýba zapečatená otázka");
  assert.equal(env.state.confirmations.length, 0);

  const t2 = await runTurn(env, "Aman.", t1.pending);
  assert.equal(t2.intent?.name, "MACHINE_SERVICE_ADD");
  assert.equal(t2.result.kind, "action_preview", JSON.stringify(t2.result));
  assert.equal(text(t2.result), "Pridám servisný záznam „výmena filtra a oleja“ k Aman s dnešným dátumom.");
  assert.deepEqual(env.state.confirmations[0].canonical_args, { machineId: "m-aman", title: "výmena filtra a oleja", serviceDate: "2026-09-24", cost: null });
  assert.equal(t2.pending, null);

  const done = await confirm(env, t2.result);
  assert.ok(done.kind === "action_result" && done.success);
  assert.equal(env.state.tables.machine_services.length, 1);
  assert.equal(env.state.tables.machine_services[0].title, "výmena filtra a oleja");
  assert.equal(env.state.tables.machine_services[0].machine_id, "m-aman");
});

await check("A2: „Zaeviduj servis výmena filtra a oleja.“ (bez modulu) → otázka → „Aman.“ → stroj Aman", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MACHINES() });
  const t1 = await runTurn(env, "Zaeviduj servis výmena filtra a oleja.", null);
  assert.ok(t1.pending);
  const t2 = await runTurn(env, "Stroj Aman.", t1.pending);
  assert.equal(t2.result.kind, "action_preview", JSON.stringify(t2.result));
  assert.equal((env.state.confirmations[0].canonical_args as Row).machineId, "m-aman");
  assert.equal((env.state.confirmations[0].canonical_args as Row).title, "výmena filtra a oleja");
});

await check("stroj sa nenašiel → „Stroj „Amon“ sa nenašiel.“ a otázka trvá", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MACHINES() });
  const t1 = await runTurn(env, "Do stroja zaeviduj servis výmena oleja.", null);
  const t2 = await runTurn(env, "Amon", t1.pending);
  assert.equal(t2.result.kind, "not_found");
  assert.equal(text(t2.result), "Stroj „Amon“ sa nenašiel.");
  assert.ok(t2.pending, "otázka sa má zachovať");
  const t3 = await runTurn(env, "Aman", t2.pending);
  assert.equal(t3.result.kind, "action_preview");
  assert.equal((env.state.confirmations[0].canonical_args as Row).title, "výmena oleja");
});

// B / C / D / E / F
await check("B: čaká sa na stroj, „Ukáž sklad.“ → nový príkaz, otázka zahodená", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MACHINES() });
  const t1 = await runTurn(env, "Do stroja zaeviduj servis výmena oleja.", null);
  const t2 = await runTurn(env, "Ukáž sklad.", t1.pending);
  assert.equal(t2.intent?.name, "SEARCH_INVENTORY_ITEM");
  assert.equal(t2.pending, null);
  assert.equal(env.state.confirmations.length, 0);
});

await check("C: „Nechaj tak.“ → zrušené, nič sa nestane", async () => {
  for (const cancel of ["Nechaj tak.", "Zrušiť.", "Nie.", "Cancel.", "Never mind.", "Abbrechen.", "Lass es."]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: MACHINES() });
    const t1 = await runTurn(env, "Do stroja zaeviduj servis výmena oleja.", null);
    const t2 = await runTurn(env, cancel, t1.pending);
    assert.equal(text(t2.result), translate("sk", "assistant.clarify.cancelled"), cancel);
    assert.equal(t2.pending, null);
    assert.equal(env.state.confirmations.length, 0);
    assert.equal(env.state.tables.machine_services.length, 0);
  }
});

await check("D: vypršaná otázka + „Aman“ → nevykoná starú akciu", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MACHINES() });
  const past = Date.now() - (PENDING_CLARIFICATION_TTL_SECONDS + 60) * 1000;
  const t1 = await runTurn(env, "Do stroja zaeviduj servis výmena oleja.", null, { now: past });
  const t2 = await runTurn(env, "Aman", t1.pending);
  assert.equal(text(t2.result), translate("sk", "assistant.clarify.expired"));
  assert.equal(env.state.confirmations.length, 0);
});

await check("E: používateľ B nemôže odpovedať na otázku používateľa A", async () => {
  const a = makeDb({ role: "owner", financeManage: true, tables: MACHINES() });
  const t1 = await runTurn(a, "Do stroja zaeviduj servis výmena oleja.", null);
  const b = makeDb({ role: "owner", financeManage: true, userId: USER_B, tables: MACHINES() });
  const t2 = await runTurn(b, "Aman", t1.pending);
  assert.equal(text(t2.result), translate("sk", "assistant.clarify.expired"));
  assert.equal(b.state.confirmations.length, 0);
});

await check("F: firma B nemôže dokončiť dialóg firmy A", async () => {
  const a = makeDb({ role: "owner", financeManage: true, tables: MACHINES() });
  const t1 = await runTurn(a, "Do stroja zaeviduj servis výmena oleja.", null);
  const b = makeDb({ role: "owner", financeManage: true, companyId: COMPANY_B, tables: MACHINES() });
  const t2 = await runTurn(b, "Aman", t1.pending);
  assert.equal(text(t2.result), translate("sk", "assistant.clarify.expired"));
  assert.equal(b.state.confirmations.length, 0);
});

await check("podvrhnutý / upravený token → neplatný", () => {
  const binding = { userId: USER_A, companyId: COMPANY_A };
  const token = sealPendingClarification("MACHINE_DELETE", { query: "x" }, { slot: "machine" }, binding)!;
  assert.ok(unsealPendingClarification(token, binding));
  const flipped = token.slice(0, 50) + (token[50] === "A" ? "B" : "A") + token.slice(51);
  assert.equal(unsealPendingClarification(flipped, binding), null);
  assert.equal(unsealPendingClarification("x".repeat(100), binding), null);
  // entityId sa do tokenu nikdy nezapečatí zo slotov.
  const withId = sealPendingClarification("MACHINE_DELETE", { query: "x", entityId: "m-cat" }, { slot: "machine" }, binding)!;
  assert.equal(unsealPendingClarification(withId, binding)?.args.entityId, undefined);
});

await check("rola sa overí pri každom kroku: token z čias ownera + teraz zamestnanec → odmietnuté", async () => {
  const owner = makeDb({ role: "owner", financeManage: true, tables: MACHINES() });
  const t1 = await runTurn(owner, "Do stroja zaeviduj servis výmena oleja.", null);
  const employee = makeDb({ role: "employee", financeManage: false, tables: MACHINES() });
  const t2 = await runTurn(employee, "Aman", t1.pending);
  assert.equal(t2.result.kind, "error");
  assert.equal(text(t2.result), translate("sk", "assistant.denied.employee"));
  assert.equal(employee.state.confirmations.length, 0);
});

await check("zamestnanec nedostane ani otázku (odmietnutý pred dotazom)", async () => {
  const env = makeDb({ role: "employee", financeManage: false, tables: MACHINES() });
  const t1 = await runTurn(env, "Do stroja zaeviduj servis výmena oleja.", null);
  assert.equal(t1.result.kind, "error");
  assert.equal(t1.pending, null);
  assert.equal(env.state.queries, 0);
});

// -----------------------------------------------------------------------------
// Sklad, vozidlo, priečinok — ten istý mechanizmus
// -----------------------------------------------------------------------------

await check("SKLAD: „Zníž množstvo o 5.“ → „Ktorú skladovú položku…?“ → „Vrut 8x80.“ → náhľad", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { inventory_items: [{ id: "i-vrut", name: "Vrut 8x80", quantity: 40, unit: "ks" }] } });
  const t1 = await runTurn(env, "Zníž množstvo o 5.", null);
  assert.equal(t1.intent?.name, "INVENTORY_QUANTITY_ADJUST");
  assert.equal(text(t1.result), translate("sk", "assistant.inventory.whichItem"));
  const t2 = await runTurn(env, "Vrut 8x80.", t1.pending);
  assert.equal(t2.result.kind, "action_preview", JSON.stringify(t2.result));
  assert.deepEqual(env.state.confirmations[0].canonical_args, { itemId: "i-vrut", expectedQuantity: 40, newQuantity: 35 });
});

await check("VOZIDLO: „Pridaj servis za 250 eur.“ (Vozidlá) → „Ku ktorému vozidlu?“ → „AB123CD.“ → náhľad so sumou", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { vehicles: [{ id: "v-1", spz: "AB123CD", znacka: "Škoda", model: "Octavia" }] } });
  const t1 = await runTurn(env, "Pridaj servis za 250 eur.", null, { module: "vehicles" });
  assert.equal(text(t1.result), translate("sk", "assistant.vehicle.whichVehicle"));
  const t2 = await runTurn(env, "AB123CD.", t1.pending, { module: "vehicles" });
  assert.equal(t2.result.kind, "action_preview", JSON.stringify(t2.result));
  assert.match(text(t2.result), /250\.00 €/);
  assert.equal((env.state.confirmations[0].canonical_args as Row).cost, 250);
  const done = await confirm(env, t2.result);
  assert.ok(done.kind === "action_result" && done.success);
  assert.equal(env.state.tables.vehicle_services[0].cost, 250);
});

await check("SERVIS bez modulu: „Pridaj servis za 250 eur.“ → otázka → ŠPZ → vozidlo (stroj sa nenašiel)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { vehicles: [{ id: "v-1", spz: "AB123CD", znacka: "Škoda", model: "Octavia" }] } });
  const t1 = await runTurn(env, "Pridaj servis za 250 eur.", null);
  assert.equal(text(t1.result), translate("sk", "assistant.service.whichEntity"));
  const t2 = await runTurn(env, "AB123CD", t1.pending);
  assert.equal(t2.result.kind, "action_preview", JSON.stringify(t2.result));
  assert.equal(env.state.confirmations[0].intent, "VEHICLE_SERVICE_ADD");
});

await check("PRIEČINOK: „Pridaj tieto doklady do priečinka.“ → „Do ktorého priečinka?“ → „August 2026.“ → náhľad", async () => {
  const env = makeDb({
    role: "owner", financeManage: true,
    tables: {
      document_folders: [{ id: "f-aug", name: "August 2026", created_at: "2026-09-01" }, { id: "f-sep", name: "September 2026", created_at: "2026-09-02" }],
      documents: [{ id: "d-1", document_type: "receipt", deleted_at: null, extracted_fields: {}, created_at: "2026-08-10" }],
    },
  });
  const selection = [{ type: "document" as const, id: "d-1" }];
  const t1 = await runTurn(env, "Pridaj tieto doklady do priečinka.", null, { selection });
  assert.equal(t1.result.kind, "list");
  assert.ok(t1.pending);
  const t2 = await runTurn(env, "August 2026.", t1.pending, { selection });
  assert.equal(t2.result.kind, "action_preview", JSON.stringify(t2.result));
  assert.equal((env.state.confirmations[0].canonical_args as Row).folderId, "f-aug");
});

// -----------------------------------------------------------------------------
// Skloňovanie a bezpečné mazanie
// -----------------------------------------------------------------------------

const ITEMS = (): Tables => ({ inventory_items: [
  { id: "i-kotuc", name: "Kotúč na asfalt", quantity: 3, unit: "ks" },
  { id: "i-sprej", name: "Sprej", quantity: 12, unit: "ks" },
] });

await check("„Vymaž skladovú položku kotúča na asfalt.“ → „Myslíte … Kotúč na asfalt?“ → „Áno.“ → deštruktívny náhľad → potvrdenie → zmazané", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: ITEMS() });
  const t1 = await runTurn(env, "Vymaž skladovú položku kotúča na asfalt.", null);
  assert.equal(t1.intent?.args.query, "Kotúča na asfalt");
  assert.equal(text(t1.result), "Myslíte skladovú položku „Kotúč na asfalt“?");
  assert.ok(t1.pending);
  assert.equal(env.state.confirmations.length, 0, "žiadne potvrdenie pred „Áno“");

  const t2 = await runTurn(env, "Áno.", t1.pending);
  assert.equal(t2.result.kind, "action_preview", JSON.stringify(t2.result));
  assert.equal((t2.result as { destructive?: boolean }).destructive, true);
  assert.match(text(t2.result), /^Zmažem skladovú položku „Kotúč na asfalt“/);
  assert.deepEqual(env.state.confirmations[0].canonical_args, { itemId: "i-kotuc", name: "Kotúč na asfalt" });
  assert.equal(env.state.tables.inventory_items.length, 2, "ešte nič nezmazané");

  const done = await confirm(env, t2.result);
  assert.ok(done.kind === "action_result" && done.success);
  assert.deepEqual(env.state.tables.inventory_items.map((i) => i.id), ["i-sprej"]);
});

await check("„Vymaž skladovú položku Kotúč na asfalt“ (presne) → priamo deštruktívny náhľad", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: ITEMS() });
  const t1 = await runTurn(env, "Vymaž skladovú položku Kotúč na asfalt", null);
  assert.equal(t1.result.kind, "action_preview");
  assert.equal(t1.pending, null);
});

await check("„Vymaž skladovú položku sprej“ funguje ako doteraz (presná zhoda)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: ITEMS() });
  const t1 = await runTurn(env, "Vymaž skladovú položku sprej.", null);
  assert.equal(t1.result.kind, "action_preview");
  assert.deepEqual(env.state.confirmations[0].canonical_args, { itemId: "i-sprej", name: "Sprej" });
});

await check("kandidát: „Nie.“ zruší; iné meno po otázke = nové hľadanie", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: ITEMS() });
  const t1 = await runTurn(env, "Vymaž skladovú položku kotúča na asfalt.", null);
  const t2 = await runTurn(env, "Nie.", t1.pending);
  assert.equal(text(t2.result), translate("sk", "assistant.clarify.cancelled"));
  assert.equal(env.state.confirmations.length, 0);
  const t3 = await runTurn(env, "Vymaž skladovú položku kotúča na asfalt.", null);
  const t4 = await runTurn(env, "Sprej", t3.pending);
  assert.equal(t4.result.kind, "action_preview");
  assert.equal((env.state.confirmations[0].canonical_args as Row).itemId, "i-sprej");
});

await check("nejednoznačné: „Kotúč na asfalt“ + „Kotúč na asfalt 350 mm“, „kotúč“ → výber, nič sa nehádá", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { inventory_items: [
    { id: "a", name: "Kotúč na asfalt", quantity: 1, unit: null },
    { id: "b", name: "Kotúč na asfalt 350 mm", quantity: 1, unit: null },
  ] } });
  const t1 = await runTurn(env, "Vymaž skladovú položku kotúč.", null);
  assert.equal(t1.result.kind, "list");
  assert.equal(env.state.confirmations.length, 0);
});

await check("potvrdený kandidát, ktorý medzitým zmizol → nič (znova pod RLS)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: ITEMS() });
  const t1 = await runTurn(env, "Vymaž skladovú položku kotúča na asfalt.", null);
  env.state.tables.inventory_items = env.state.tables.inventory_items.filter((i) => i.id !== "i-kotuc");
  const t2 = await runTurn(env, "Áno", t1.pending);
  assert.equal(t2.result.kind, "not_found");
  assert.equal(env.state.confirmations.length, 0);
});

await check("stroj „bagra CAT“ pri mazaní → otázka na „Bager CAT“; iná firma nevidí nič", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: MACHINES() });
  const t1 = await runTurn(env, "Zmaž stroj bagra CAT.", null);
  assert.equal(text(t1.result), "Myslíte stroj „Bager CAT“?");
  const t2 = await runTurn(env, "Áno", t1.pending);
  assert.equal(t2.result.kind, "action_preview");
  assert.equal((env.state.confirmations[0].canonical_args as Row).machineId, "m-cat");
});

await check("rozlíšenie mien: vrstvy exact → inflected → partial (SK tvary)", () => {
  const pairs: Array<[string, string]> = [
    ["Kotúč na asfalt", "kotúča na asfalt"], ["Kotúč na asfalt", "kotúčom na asfalt"],
    ["Bager CAT", "bagra CAT"], ["Bager CAT", "bagrom CAT"],
    ["Vŕtačka Bosch", "vŕtačku Bosch"], ["Vŕtačka Bosch", "vŕtačky Bosch"], ["Sprej", "spreja"],
  ];
  for (const [canonical, spoken] of pairs) assert.equal(inflectionKey(canonical), inflectionKey(spoken), `${canonical} ~ ${spoken}`);
  assert.notEqual(inflectionKey("Test1"), inflectionKey("Test2"));
  assert.notEqual(inflectionKey("Kotúč na asfalt"), inflectionKey("Kotúč na asfalt 350 mm"));
  const rows = [{ name: "Kotúč na asfalt" }, { name: "Sprej" }];
  assert.deepEqual(resolveEntityByName(rows, "Sprej", (r) => r.name), { match: rows[1], confidence: "exact" });
  assert.deepEqual(resolveEntityByName(rows, "kotúča na asfalt", (r) => r.name), { match: rows[0], confidence: "inflected" });
  assert.deepEqual(resolveEntityByName(rows, "piesok", (r) => r.name), { none: true });
});

await check("klasifikátor odpovede: odpoveď / zrušenie / nový príkaz", () => {
  const answers: Array<[string, string]> = [["Aman.", "Aman"], ["Stroj Aman.", "Aman"], ["Ten Aman.", "Aman"], ["AB123CD.", "AB123CD"], ["August 2026.", "August 2026"], ["Vrut 8x80.", "Vrut 8x80"], ["do priečinka August 2026", "August 2026"]];
  for (const [input, value] of answers) assert.deepEqual(classifyClarificationReply(input, {}), { kind: "answer", value }, input);
  for (const input of ["Ukáž sklad.", "Koľko máme vrutov?", "Otvor stroj CAT", "Vymaž nepriradené bločky", "Show vehicles", "Zeige Lager"]) {
    assert.equal(classifyClarificationReply(input, {}).kind, "new_command", input);
  }
  for (const input of ["Zrušiť.", "Nechaj tak.", "Nie.", "Cancel.", "Never mind.", "Abbrechen.", "Lass es."]) {
    assert.equal(classifyClarificationReply(input, {}).kind, "cancel", input);
  }
  assert.equal(classifyClarificationReply("Áno", { candidate: { id: "x", label: "y" } }).kind, "confirm_candidate");
  assert.equal(classifyClarificationReply("Áno", {}).kind, "new_command");
  // Mená, ktoré sa podobajú na anglické slovesá, sú odpoveď.
  assert.equal(classifyClarificationReply("Howard", {}).kind, "answer");
  assert.equal(classifyClarificationReply("Addison 2", {}).kind, "answer");
  assert.equal(classifyConfirmationReply("Áno."), "confirm");
});

// -----------------------------------------------------------------------------
// Inbox — nepriradené bločky
// -----------------------------------------------------------------------------

function inboxTables(): Tables {
  const doc = (id: string, type: string, extra: Row = {}): Row => ({
    id, document_type: type, deleted_at: null, archived_from_inbox_at: null, custom_category_id: null,
    original_filename: `${id}.jpg`, extracted_fields: { merchant: `Obchod ${id}` }, created_at: "2026-09-01",
    storage_bucket: "ai-inbox-documents", storage_path: `u/${id}.webp`, company_id: COMPANY_A, ...extra,
  });
  return {
    documents: [
      doc("r1", "receipt"),                                  // nepriradený → zmaže sa
      doc("r2", "receipt"),                                  // priradený k vozidlu
      doc("r3", "receipt", { custom_category_id: "cat-1" }), // vo vlastnej zložke
      doc("r4", "receipt"),                                  // nepriradený, ale v priečinku → chránený
      doc("r5", "receipt"),                                  // nepriradený, predloha faktúry → chránený
      doc("r6", "receipt", { deleted_at: "2026-09-02" }),    // zmazaný
      doc("r7", "receipt", { archived_from_inbox_at: "2026-09-02" }),
      doc("rb", "receipt", { company_id: COMPANY_B }),       // iná firma
      doc("i1", "invoice"),                                  // nepriradená faktúra
      doc("i2", "invoice"),                                  // už z nej vznikla faktúra
    ],
    document_links: [
      { id: "l2", document_id: "r2", vehicle_id: "v-1", machine_id: null, invoice_id: null },
      { id: "l3", document_id: "i2", vehicle_id: null, machine_id: null, invoice_id: "inv-2" },
    ],
    document_folder_items: [{ id: "fi", folder_id: "f-1", document_id: "r4", invoice_id: null }],
    invoices: [{ id: "inv-5", source_document_id: "r5" }],
    document_attachments: [{ id: "att", document_id: "r1", storage_bucket: "ai-inbox-attachments", storage_path: "u/r1-a.pdf", company_id: COMPANY_A }],
  };
}

await check("filter = Inbox UI: nepriradené bločky r1, r4, r5; faktúra i1", () => {
  const t = inboxTables();
  const links = (id: string) => t.document_links.filter((l) => l.document_id === id);
  const visible = t.documents.filter((d) => d.company_id === COMPANY_A && !d.deleted_at && !d.archived_from_inbox_at)
    .map((d) => ({ ...d, document_links: links(d.id as string) }))
    .filter((d) => isUnassignedInboxDocument(d as never))
    .map((d) => d.id);
  assert.deepEqual(visible, ["r1", "r4", "r5", "i1"]);
});

await check("A: „Ukáž nepriradené bločky“ → zoznam presne podľa UI", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: inboxTables() });
  const t = await runTurn(env, "Ukáž nepriradené bločky.", null);
  assert.equal(t.intent?.name, "INBOX_LIST_UNASSIGNED");
  assert.equal(t.result.kind, "list");
  assert.deepEqual((t.result as { items: { id: string }[] }).items.map((i) => i.id).sort(), ["r1", "r4", "r5"]);
});

await check("B: „Koľko je nepriradených bločkov?“ → počet (iba s oprávnením)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: inboxTables() });
  const t = await runTurn(env, "Koľko je nepriradených bločkov?", null);
  assert.equal(text(t.result), "Nepriradené bločky v Inboxe: 3.");
  const admin = makeDb({ role: "admin", financeManage: false, tables: inboxTables() });
  const denied = await runTurn(admin, "Koľko je nepriradených bločkov?", null);
  assert.equal(denied.result.kind, "error");
  assert.ok(!/\d/.test(text(denied.result)));
  assert.equal(admin.state.queries, 0);
});

await check("C+D+E: „Vymaž nepriradené bločky“ → náhľad s presnými ID; nový doklad sa nepridá; účtovná stopa ostane", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: inboxTables() });
  const t1 = await runTurn(env, "Vymaž nepriradené bločky.", null);
  assert.equal(t1.intent?.name, "INBOX_DELETE_UNASSIGNED");
  assert.equal(t1.result.kind, "action_preview", JSON.stringify(t1.result));
  assert.equal((t1.result as { destructive?: boolean }).destructive, true);
  assert.equal(text(t1.result), "Našiel som 1 nepriradený bloček. Zmažú sa tieto doklady z Inboxu aj s pôvodnými súbormi. Táto akcia sa nedá vrátiť. 2 ďalších vynechám, lebo sú súčasťou faktúry, priečinka, odovzdania alebo už boli stiahnuté. Naozaj ich chcete zmazať?");
  assert.deepEqual(env.state.confirmations[0].canonical_args, { documentIds: ["r1"], documentTypes: ["receipt"] });
  assert.equal(env.state.tables.documents.length, 10, "prvý krok nič nezmaže");

  // Nový nepriradený bloček po náhľade.
  env.state.tables.documents.push({ id: "r9", document_type: "receipt", deleted_at: null, archived_from_inbox_at: null, custom_category_id: null, company_id: COMPANY_A, storage_bucket: "ai-inbox-documents", storage_path: "u/r9.webp" });

  const done = await confirm(env, t1.result);
  assert.ok(done.kind === "action_result" && done.success, JSON.stringify(done));
  const ids = env.state.tables.documents.map((d) => d.id);
  assert.ok(!ids.includes("r1"), "r1 zmazaný");
  for (const keep of ["r2", "r3", "r4", "r5", "r9", "i1", "i2", "rb"]) assert.ok(ids.includes(keep), `${keep} musí ostať`);
  assert.deepEqual(env.state.storageRemoved.sort(), ["ai-inbox-attachments/u/r1-a.pdf", "ai-inbox-documents/u/r1.webp"]);
});

await check("H: replay potvrdenia → nič ďalšie", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: inboxTables() });
  const t1 = await runTurn(env, "Vymaž nepriradené bločky.", null);
  await confirm(env, t1.result);
  const before = env.state.tables.documents.length;
  const replay = await confirm(env, t1.result);
  assert.ok(replay.kind === "action_result" && !replay.success);
  assert.equal(env.state.tables.documents.length, before);
});

await check("snapshot sa zmenil (r1 medzitým priradený) → nezmaže sa nič", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: inboxTables() });
  const t1 = await runTurn(env, "Vymaž nepriradené bločky.", null);
  env.state.tables.document_links.push({ id: "l9", document_id: "r1", vehicle_id: "v-1", machine_id: null, invoice_id: null });
  const done = await confirm(env, t1.result);
  assert.ok(done.kind === "action_result" && !done.success);
  assert.equal(text(done as never), translate("sk", "assistant.inbox.dataChanged"));
  assert.equal(env.state.tables.documents.length, 10);
  assert.equal(env.state.storageRemoved.length, 0);
});

await check("F: zamestnanec → odmietnutý pred akýmkoľvek dotazom", async () => {
  const env = makeDb({ role: "employee", financeManage: false, tables: inboxTables() });
  for (const phrase of ["Vymaž nepriradené bločky.", "Koľko je nepriradených bločkov?", "Ukáž nepriradené bločky."]) {
    const t = await runTurn(env, phrase, null);
    assert.equal(t.result.kind, "error", phrase);
  }
  assert.equal(env.state.queries, 0);
});

await check("G: iná firma — doklady A nevidí; potvrdenie A v kontexte B nič nezmaže", async () => {
  const a = makeDb({ role: "owner", financeManage: true, tables: inboxTables() });
  const t1 = await runTurn(a, "Vymaž nepriradené bločky.", null);
  const b = makeDb({ role: "owner", financeManage: true, companyId: COMPANY_B, tables: inboxTables() });
  const tb = await runTurn(b, "Ukáž nepriradené bločky.", null);
  assert.deepEqual((tb.result as { items: { id: string }[] }).items.map((i) => i.id), ["rb"]);
  const forged = await executeAction(b.db, "sk", { companyId: COMPANY_B, userId: USER_A, role: "owner" as never }, (t1.result as { confirmationId: string }).confirmationId);
  assert.ok(forged.kind === "action_result" && !forged.success);
  assert.equal(b.state.tables.documents.length, 10);
});

await check("I: žiadne nepriradené bločky → „Žiadne nepriradené bločky sa nenašli.“", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { documents: [] } });
  for (const phrase of ["Vymaž nepriradené bločky.", "Ukáž nepriradené bločky."]) {
    const t = await runTurn(env, phrase, null);
    assert.equal(text(t.result), "Žiadne nepriradené bločky sa nenašli.", phrase);
  }
  assert.equal(env.state.confirmations.length, 0);
});

await check("všetky chránené → vysvetlenie, žiadne potvrdenie", async () => {
  const tables = inboxTables();
  tables.documents = tables.documents.filter((d) => d.id !== "r1");
  const env = makeDb({ role: "owner", financeManage: true, tables });
  const t = await runTurn(env, "Vymaž nepriradené bločky.", null);
  assert.equal(t.result.kind, "answer");
  assert.match(text(t.result), /Hlasom ich nezmažem/);
  assert.equal(env.state.confirmations.length, 0);
});

await check("účtovník smie; admin bez financií nie; „Vymaž všetko.“ nie je hromadné mazanie", async () => {
  const acc = makeDb({ role: "accountant", financeManage: true, tables: inboxTables() });
  assert.equal((await runTurn(acc, "Vymaž nepriradené bločky.", null)).result.kind, "action_preview");
  const admin = makeDb({ role: "admin", financeManage: false, tables: inboxTables() });
  assert.equal((await runTurn(admin, "Vymaž nepriradené bločky.", null)).result.kind, "error");
  assert.equal(parseIntentDeterministic("Vymaž všetko."), null);
  assert.equal(parseIntentDeterministic("Vymaž všetky faktúry"), null);
});

await check("frázy Inboxu: priečinok a stiahnutie s filtrom nepriradených; nepriradené faktúry", async () => {
  assert.deepEqual(parseIntentDeterministic("Priraď nepriradené bločky do priečinka August.")?.args.unassignedOnly, true);
  assert.equal(parseIntentDeterministic("Stiahni nepriradené bločky.")?.name, "DOCUMENTS_EXPORT");
  assert.equal(parseIntentDeterministic("Stiahni nepriradené bločky.")?.args.unassignedOnly, true);
  const env = makeDb({ role: "owner", financeManage: true, tables: { ...inboxTables(), document_folders: [{ id: "f-aug", name: "August", created_at: "2026-09-01" }] } });
  const add = await runTurn(env, "Priraď nepriradené bločky do priečinka August.", null);
  assert.equal(add.result.kind, "action_preview", JSON.stringify(add.result));
  assert.deepEqual(((env.state.confirmations[0].canonical_args as Row).refs as { id: string }[]).map((r) => r.id).sort(), ["r1", "r4", "r5"]);
  const invoices = await runTurn(env, "Ukáž nepriradené faktúry.", null);
  assert.deepEqual((invoices.result as { items: { id: string }[] }).items.map((i) => i.id), ["i1"]);
  const notes = await runTurn(env, "Ukáž nepriradené dodacie listy.", null);
  assert.equal(text(notes.result), translate("sk", "assistant.inbox.deliveryNotesUnsupported"));
});


// -----------------------------------------------------------------------------
// Servis stroja — meno stroja vložené vo vete (produkčná chyba „Takeuchi 323")
// -----------------------------------------------------------------------------

const TAKEUCHI = (): Tables => ({ machines: [
  { id: "m-tak", name: "Takeuchi 323", company_id: COMPANY_A },
  { id: "m-cat", name: "CAT 320", company_id: COMPANY_A },
  { id: "m-jcb", name: "JCB 3CX", company_id: COMPANY_A },
] });

await check("A: „Do stroja Takeuchi 323 zaeviduj servis, výmena oleja, filtrov.“ → stroj aj popis, bez otázky", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
  const t = await runTurn(env, "Do stroja Takeuchi 323 zaeviduj servis, výmena oleja, filtrov.", null);
  assert.equal(t.intent?.name, "MACHINE_SERVICE_ADD");
  assert.equal(t.intent?.args.query, "Takeuchi 323");
  assert.equal(t.intent?.args.serviceTitle, "výmena oleja, filtrov");
  assert.equal(t.result.kind, "action_preview", JSON.stringify(t.result));
  assert.equal(t.pending, null, "žiadna otázka na stroj");
  assert.equal(text(t.result), "Pridám servisný záznam „výmena oleja, filtrov“ k Takeuchi 323 s dnešným dátumom.");
  assert.deepEqual(env.state.confirmations[0].canonical_args, { machineId: "m-tak", title: "výmena oleja, filtrov", serviceDate: "2026-09-24", cost: null });
});

await check("B + varianty SK: stroj z vety sa nestratí", async () => {
  const phrases: Array<[string, string]> = [
    ["Do stroja Takeuchi 323 pridaj servis výmena oleja.", "výmena oleja"],
    ["Stroju Takeuchi 323 pridaj servis výmena filtrov.", "výmena filtrov"],
    ["Na stroji Takeuchi 323 zaeviduj servis výmena oleja.", "výmena oleja"],
    ["Pridaj servis stroju Takeuchi 323, výmena filtra.", "výmena filtra"],
  ];
  for (const [phrase, title] of phrases) {
    const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
    const t = await runTurn(env, phrase, null);
    assert.equal(t.intent?.args.query, "Takeuchi 323", phrase);
    assert.equal(t.intent?.args.serviceTitle, title, phrase);
    assert.equal(t.result.kind, "action_preview", `${phrase}: ${JSON.stringify(t.result)}`);
    assert.equal((env.state.confirmations[0].canonical_args as Row).machineId, "m-tak", phrase);
  }
});

await check("C + D: „Zaeviduj servis výmena oleja.“ → otázka → „Takeuchi 323.“ → pôvodný servis", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
  const t1 = await runTurn(env, "Zaeviduj servis výmena oleja.", null);
  assert.equal(t1.intent?.args.query, undefined);
  assert.ok(t1.pending, "bez stroja sa asistent pýta");
  assert.equal(env.state.confirmations.length, 0);
  const t2 = await runTurn(env, "Takeuchi 323.", t1.pending);
  assert.equal(t2.result.kind, "action_preview", JSON.stringify(t2.result));
  assert.deepEqual(env.state.confirmations[0].canonical_args, { machineId: "m-tak", title: "výmena oleja", serviceDate: "2026-09-24", cost: null });
  // „Do stroja zaeviduj servis …" (stroj bez mena) → stále otázka.
  const t3 = await runTurn(env, "Do stroja zaeviduj servis výmena oleja.", null);
  assert.equal(text(t3.result), "Ku ktorému stroju? Povedzte jeho názov.");
});

await check("E: celé mená s medzerami a číslami (CAT 320, Takeuchi 323, JCB 3CX)", async () => {
  for (const [name, id] of [["CAT 320", "m-cat"], ["Takeuchi 323", "m-tak"], ["JCB 3CX", "m-jcb"]]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
    const t = await runTurn(env, `Do stroja ${name} pridaj servis výmena oleja.`, null);
    assert.equal(t.intent?.args.query, name);
    assert.equal((env.state.confirmations[0].canonical_args as Row).machineId, id, name);
  }
});

await check("F: DE / EN — stroj aj popis", async () => {
  const phrases: Array<[string, string]> = [
    ["Für die Maschine Takeuchi 323 Service eintragen: Ölwechsel.", "Ölwechsel"],
    ["Bei Takeuchi 323 Service hinzufügen, Öl und Filter wechseln.", "Öl und Filter wechseln"],
    ["Add service to machine Takeuchi 323, oil and filters.", "oil and filters"],
    ["Log service for Takeuchi 323: oil change.", "oil change"],
  ];
  for (const [phrase, title] of phrases) {
    const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
    const t = await runTurn(env, phrase, null);
    assert.equal(t.intent?.name, "MACHINE_SERVICE_ADD", phrase);
    assert.equal(t.intent?.args.query, "Takeuchi 323", phrase);
    assert.equal(t.intent?.args.serviceTitle, title, phrase);
    assert.equal(t.result.kind, "action_preview", `${phrase}: ${JSON.stringify(t.result)}`);
    assert.equal((env.state.confirmations[0].canonical_args as Row).machineId, "m-tak", phrase);
  }
});

await check("stroj z vety sa nenašiel / nejednoznačný → konkrétna veta / výber, nič nehádané", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { machines: [
    { id: "a", name: "Takeuchi 323", company_id: COMPANY_A }, { id: "b", name: "Takeuchi 323 II", company_id: COMPANY_A },
  ] } });
  const missing = await runTurn(env, "Do stroja Kubota 18 pridaj servis výmena oleja.", null);
  assert.equal(text(missing.result), "Stroj „Kubota 18“ sa nenašiel.");
  const many = await runTurn(env, "Do stroja Takeuchi pridaj servis výmena oleja.", null);
  assert.equal(many.result.kind, "list");
  assert.equal(env.state.confirmations.length, 0);
});

// -----------------------------------------------------------------------------
// Faktúra pre partnera — existujúci dialóg draftu faktúry
// -----------------------------------------------------------------------------

const CONV = "0123456789abcdef0123456789abcdef";
// Sloty dialógu prijímajú iba UUID (lib/intents/invoice-slots.ts#readSlots).
const P_T1 = "00000000-0000-4000-8000-0000000000e1";
const PARTNERS = (): Tables => ({ business_partners: [
  { id: P_T1, legal_name: "Tester1", ico: "12345678", company_id: COMPANY_A },
  { id: "00000000-0000-4000-8000-0000000000e2", legal_name: "Stavby s.r.o.", ico: "87654321", company_id: COMPANY_A },
] });

await check("A+B: „Vytvor faktúru pre Tester1.“ → draft faktúry, partner priradený, bez otázky na partnera", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const t = await runTurn(env, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV });
  assert.equal(t.intent?.name, "CREATE_INVOICE_DRAFT");
  assert.equal(t.intent?.args.partnerQuery, "Tester1");
  assert.equal(t.result.kind, "clarify", JSON.stringify(t.result));
  const stored = env.state.conversations.get(`${USER_A}|${COMPANY_A}|${CONV}`)!;
  assert.equal((stored.slots as Row).partnerId, P_T1);
  assert.notEqual((stored.missing_fields as string[])[0], "partner");
  assert.notEqual((stored.missing_fields as string[])[0], "partnerChoice");
  assert.ok(!/pre koho/i.test(text(t.result) || (t.result as { question: string }).question));
  assert.equal(env.state.confirmations.length, 0);
});

await check("C: partner sa nenašiel → konkrétna veta (nie „Nič sa nenašlo“)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const t = await runTurn(env, "Vytvor faktúru pre Neznámy Partner.", null, { conversationId: CONV });
  assert.equal(t.result.kind, "not_found");
  assert.equal(text(t.result), translate("sk", "search.voice.invoice.partnerNotFoundOfferCreate", { name: "Neznámy Partner" }));
  // Rozhovor ostáva otvorený a čaká na odberateľa (nie „Nič sa nenašlo").
  const stored = env.state.conversations.get(`${USER_A}|${COMPANY_A}|${CONV}`)!;
  assert.equal((stored.missing_fields as string[])[0], "partner");
});

await check("D: viac partnerov → otázka na výber", async () => {
  const tables = PARTNERS();
  tables.business_partners.push({ id: "00000000-0000-4000-8000-0000000000e3", legal_name: "Tester1 Plus", ico: "11112222", company_id: COMPANY_A });
  tables.business_partners.push({ id: "00000000-0000-4000-8000-0000000000e4", legal_name: "Tester10", ico: "11113333", company_id: COMPANY_A });
  const env = makeDb({ role: "owner", financeManage: true, tables });
  const t = await runTurn(env, "Vytvor faktúru pre Tester.", null, { conversationId: CONV });
  assert.equal(t.result.kind, "clarify", JSON.stringify(t.result));
  const stored = env.state.conversations.get(`${USER_A}|${COMPANY_A}|${CONV}`)!;
  assert.ok(((stored.slots as Row).partnerCandidateIds as string[]).length >= 2);
  assert.equal((stored.slots as Row).partnerId, undefined);
});

await check("E–H: owner áno; admin bez financií a zamestnanec nie (pred dotazom); účtovník podľa doterajšieho rozsahu", async () => {
  const owner = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  assert.equal((await runTurn(owner, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV })).result.kind, "clarify");
  const admin = makeDb({ role: "admin", financeManage: false, tables: PARTNERS() });
  const denied = await runTurn(admin, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV });
  assert.equal(denied.result.kind, "error");
  assert.equal(admin.state.queries, 0, "žiadny dotaz na partnerov");
  const employee = makeDb({ role: "employee", financeManage: false, tables: PARTNERS() });
  const empDenied = await runTurn(employee, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV });
  assert.equal(text(empDenied.result), translate("sk", "assistant.denied.employee"));
  assert.equal(employee.state.queries, 0);
  const accountant = makeDb({ role: "accountant", financeManage: true, tables: PARTNERS() });
  assert.equal((await runTurn(accountant, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV })).result.kind, "clarify");
});

await check("I: pokračovanie — položka a „Pridaj ešte dopravu 80 eur“ ostanú v tom istom drafte pre Tester1", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const t1 = await runTurn(env, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV });
  assert.equal(t1.result.kind, "clarify");
  // Pozn.: „10 hodín po 35 eur" (množstvo × jednotková cena) existujúci parser
  // položiek nepodporuje — asistent sa spýta znova, nič nehádá (overené nižšie).
  const unsupported = await runTurn(env, "Výkopové práce, 10 hodín po 35 eur.", null, { conversationId: CONV });
  assert.equal(unsupported.result.kind, "clarify");
  assert.equal((env.state.conversations.get(`${USER_A}|${COMPANY_A}|${CONV}`)!.slots as Row).partnerId, P_T1);
  const t2 = await runTurn(env, "Výkopové práce za 350 eur.", null, { conversationId: CONV });
  assert.ok(t2.result.kind === "clarify" || t2.result.kind === "draft_created", JSON.stringify(t2.result));
  let stored = env.state.conversations.get(`${USER_A}|${COMPANY_A}|${CONV}`)!;
  assert.equal((stored.slots as Row).partnerId, P_T1, "partner zostal");
  assert.equal(((stored.slots as Row).items as unknown[]).length, 1);
  const t3 = await runTurn(env, "Pridaj ešte dopravu 80 eur.", null, { conversationId: CONV });
  assert.ok(t3.result.kind === "clarify" || t3.result.kind === "draft_created", JSON.stringify(t3.result));
  stored = env.state.conversations.get(`${USER_A}|${COMPANY_A}|${CONV}`)!;
  assert.equal((stored.slots as Row).partnerId, P_T1);
  assert.equal(((stored.slots as Row).items as unknown[]).length, 2);
  assert.equal(env.state.confirmations.length, 0, "nič sa nefinalizuje ani nepotvrdzuje");
});

await check("J: SK / DE / EN frázy → CREATE_INVOICE_DRAFT s partnerom; bohatšie vety ostávajú na doterajšej ceste", () => {
  for (const phrase of [
    "Vytvor faktúru pre Tester1.", "Priprav faktúru pre Tester1.", "Založ faktúru pre Tester1.", "Nová faktúra pre Tester1.",
    "Vystav faktúru pre Tester1.", "Erstelle eine Rechnung für Tester1.", "Neue Rechnung für Tester1.",
    "Create an invoice for Tester1.", "New invoice for Tester1.",
  ]) {
    const intent = parseIntentDeterministic(phrase);
    assert.equal(intent?.name, "CREATE_INVOICE_DRAFT", phrase);
    assert.equal(intent?.args.partnerQuery, "Tester1", phrase);
  }
  // Veta s položkami je tiež deterministické založenie (nie AI): partner sa
  // vezme z vety, položky prečíta extractInvoiceSlotsFromText.
  const rich = parseIntentDeterministic("Vytvor faktúru pre Tester1 za kopanie 300 eur.");
  assert.equal(rich?.name, "CREATE_INVOICE_DRAFT");
  assert.equal(rich?.args.partnerQuery, "Tester1");
  assert.equal(parseIntentDeterministic("Ukáž faktúry pre Tester1")?.name === "CREATE_INVOICE_DRAFT", false);
});

await check("nástenka bez hlasu: písaný príkaz nezačne dialóg (rozpísaný text by sa zapísal do faktúry)", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const t = await runTurn(env, "Vytvor faktúru pre Tester1.", null);
  assert.equal(text(t.result), translate("sk", "assistant.invoice.useVoice"));
  const dashboard = readFileSync("app/components/Dashboard.tsx", "utf8");
  assert.ok(dashboard.includes("trimmed === voiceTranscriptRef.current.trim() ? { conversationId: invoiceConversationIdRef.current }"));
  assert.ok(dashboard.includes('intentResult?.kind === "clarify"'), "nástenka musí zobraziť otázku dialógu");
});


// -----------------------------------------------------------------------------
// Faktúra: množstvo × jednotková cena v tom istom drafte (kanonické sumy)
// -----------------------------------------------------------------------------

const slotsOf = (env: Env) => env.state.conversations.get(`${USER_A}|${COMPANY_A}|${CONV}`)!.slots as Row;

await check("A+F+I: Tester1 → „Výkopové práce, 10 hodín po 35 eur.“ → „Pridaj ešte dopravu, 2 hodiny po 40 eur.“ → 23 % → draft s kanonickými sumami", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  await runTurn(env, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV });
  const t2 = await runTurn(env, "Výkopové práce, 10 hodín po 35 eur.", null, { conversationId: CONV });
  assert.equal(t2.result.kind, "clarify", JSON.stringify(t2.result));
  assert.deepEqual(slotsOf(env).items, [{ description: "Výkopové práce", quantity: 10, unit: "hod", unitPrice: 35, currency: "EUR" }]);
  assert.equal(slotsOf(env).partnerId, P_T1);

  const t3 = await runTurn(env, "Pridaj ešte dopravu, 2 hodiny po 40 eur.", null, { conversationId: CONV });
  assert.equal(t3.result.kind, "clarify", JSON.stringify(t3.result));
  assert.equal((slotsOf(env).items as unknown[]).length, 2);
  assert.equal(slotsOf(env).partnerId, P_T1);

  const t4 = await runTurn(env, "23 percent", null, { conversationId: CONV });
  assert.equal(t4.result.kind, "draft_created", JSON.stringify(t4.result));
  // Iba DRAFT: žiadne číslo, finalizácia, platba ani odovzdanie.
  assert.equal(env.state.tables.invoices.length, 1);
  const invoice = env.state.tables.invoices[0];
  assert.equal(invoice.customer_business_partner_id, P_T1);
  assert.equal(invoice.invoice_number, undefined);
  assert.equal(invoice.document_status, undefined, "stav nastavuje DB (draft), appka nefinalizuje");
  const lines = env.state.tables.invoice_items.sort((a, b) => Number(a.position) - Number(b.position));
  assert.deepEqual(lines.map((l) => [l.description, l.quantity, l.unit, l.unit_price]), [["Výkopové práce", 10, "hod", 35], ["dopravu", 2, "hod", 40]]);
  // Sumy riadkov = kanonický VAT engine nad tými istými vstupmi (nie parser).
  const canonical = previewDraftTotals(lines.map((l) => ({
    description: String(l.description), quantity: Number(l.quantity), unit: String(l.unit), unit_price: Number(l.unit_price),
    price_mode: "net" as const, vat_category_code: "S" as const, vat_rate: 23,
  })));
  assert.deepEqual(lines.map((l) => l.line_net_amount), canonical.lines.map((c) => Number(c.lineNetAmount)));
  assert.deepEqual(canonical.lines.map((c) => c.lineNetAmount), ["350.00", "80.00"]);
  assert.equal(canonical.subtotalAmount, "430.00");
  assert.equal(canonical.vatTotalAmount, "98.90");
});

await check("G: „… po 35 eur s DPH“ → režim s DPH (existujúci detektor), sumy z kanonického modelu", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  await runTurn(env, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV });
  const t2 = await runTurn(env, "Výkopové práce, 10 hodín po 35 eur s DPH.", null, { conversationId: CONV });
  assert.equal(slotsOf(env).priceMode, "gross");
  assert.equal((t2.result as { question: string }).question, translate("sk", "search.voice.invoice.askVatAfterGross"));
  const t3 = await runTurn(env, "23 percent", null, { conversationId: CONV });
  assert.equal(t3.result.kind, "draft_created", JSON.stringify(t3.result));
  const line = env.state.tables.invoice_items[0];
  assert.equal(line.price_mode, "gross");
  assert.equal(line.unit_price, 35);
  assert.equal(line.quantity, 10);
  assert.equal(line.line_gross_amount, 350);
  assert.equal(line.line_net_amount, 284.55);
});

await check("G2: „… bez DPH“ → net; bez zmienky → režim sa nenastaví a spýta sa otázka o DPH ako doteraz", async () => {
  const net = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  await runTurn(net, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV });
  await runTurn(net, "Výkopové práce, 10 hodín po 35 eur bez DPH.", null, { conversationId: CONV });
  assert.equal(slotsOf(net).priceMode, "net");
  const plain = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  await runTurn(plain, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV });
  const t = await runTurn(plain, "Výkopové práce, 10 hodín po 35 eur.", null, { conversationId: CONV });
  assert.equal(slotsOf(plain).priceMode, undefined);
  assert.equal((t.result as { question: string }).question, translate("sk", "search.voice.invoice.askVat"));
});

await check("E: „Výkopové práce, 10 hodín za 350 eur“ → nie 10 × 350; otázka, draft nevznikne", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  await runTurn(env, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV });
  const t = await runTurn(env, "Výkopové práce, 10 hodín za 350 eur.", null, { conversationId: CONV });
  assert.equal(t.result.kind, "clarify");
  assert.equal(slotsOf(env).items, undefined);
  assert.equal(env.state.tables.invoices.length, 0);
});

await check("cent-sensitive: kanonický model pre množstvo × cena (nezmenené výsledky)", () => {
  const line = (quantity: number, unitPrice: number, mode: "net" | "gross") => previewDraftTotals([{
    description: "x", quantity, unit: "ks", unit_price: unitPrice, price_mode: mode, vat_category_code: "S", vat_rate: 23,
  }]);
  const pick = (t: ReturnType<typeof line>) => [t.lines[0].lineNetAmount, t.lines[0].lineVatAmount, t.lines[0].lineGrossAmount];
  assert.deepEqual(pick(line(3, 0.33, "net")), ["0.99", "0.23", "1.22"]);
  assert.deepEqual(pick(line(3, 0.335, "net")), ["1.01", "0.23", "1.24"]);
  assert.deepEqual(pick(line(10, 35, "net")), ["350.00", "80.50", "430.50"]);
  assert.deepEqual(pick(line(10, 35, "gross")), ["284.55", "65.45", "350.00"]);
  assert.deepEqual(pick(line(3, 0.33, "gross")), ["0.80", "0.19", "0.99"]);
  assert.deepEqual(pick(line(2.5, 40, "net")), ["100.00", "23.00", "123.00"]);
});


// -----------------------------------------------------------------------------
// KRITICKÉ: servisná veta NIKDY nezaloží stroj (produkcia: „TAKEUCHI 323 oleja a filtrov")
// -----------------------------------------------------------------------------

const machineCreates = (env: Env) => env.state.confirmations.filter((c) => c.intent === "MACHINE_CREATE").length;

const SERVICE_SENTENCES = [
  "Do stroja Takeuchi 323 zaeviduj servis, výmena oleja a filtrov.",
  "Do stroja TAKEUCHI 323 pridaj výmenu oleja a filtrov.",
  "Do stroja TAKEUCHI 323 zaeviduj výmenu oleja a filtrov.",
  "Stroju TAKEUCHI 323 pridaj výmenu oleja a filtrov.",
  "Pridaj do stroja TAKEUCHI 323 výmenu oleja a filtrov",
  "Takeuchi 323 servis výmena oleja.",
  "Pridaj servis stroju Takeuchi 323.",
  "Zaeviduj opravu na Takeuchi 323.",
  "Log service for Takeuchi 323.",
  "Service bei Takeuchi 323 eintragen.",
  "Do stroja Takeuchi 323 zaeviduj servís výmena oleja a filtrov",
];

await check("A: reálna veta → MACHINE_SERVICE_ADD(Takeuchi 323, „výmena oleja a filtrov“), 0× založenie stroja", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
  const machinesBefore = env.state.tables.machines.length;
  const t = await runTurn(env, "Do stroja Takeuchi 323 zaeviduj servis, výmena oleja a filtrov.", null);
  assert.equal(t.intent?.name, "MACHINE_SERVICE_ADD");
  assert.equal(t.intent?.args.query, "Takeuchi 323");
  assert.equal(t.intent?.args.serviceTitle, "výmena oleja a filtrov");
  assert.equal(t.result.kind, "action_preview");
  assert.equal(machineCreates(env), 0);
  const done = await confirm(env, t.result);
  assert.ok(done.kind === "action_result" && done.success);
  assert.equal(env.state.tables.machines.length, machinesBefore, "žiadny nový stroj");
  assert.equal(env.state.tables.machine_services.length, 1);
  assert.equal(env.state.tables.machine_services[0].machine_id, "m-tak");
  assert.equal(env.state.tables.machine_services[0].title, "výmena oleja a filtrov");
});

await check("A2: produkčný prepis „Do stroja TAKEUCHI 323 pridaj výmenu oleja a filtrov.“ → servis, nie nový stroj", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
  const t = await runTurn(env, "Do stroja TAKEUCHI 323 pridaj výmenu oleja a filtrov.", null);
  assert.equal(t.intent?.name, "MACHINE_SERVICE_ADD");
  assert.equal(t.intent?.args.query, "TAKEUCHI 323");
  assert.equal(t.intent?.args.serviceTitle, "výmenu oleja a filtrov");
  assert.equal(t.result.kind, "action_preview");
  assert.equal((env.state.confirmations[0].canonical_args as Row).machineId, "m-tak");
  assert.equal(machineCreates(env), 0);
});

await check("B + sweep: ŽIADNA servisná veta nevedie na MACHINE_CREATE ani vloženie stroja", async () => {
  for (const sentence of SERVICE_SENTENCES) {
    assert.notEqual(parseIntentDeterministic(sentence)?.name, "MACHINE_CREATE", sentence);
    assert.equal(violatesMachineCreateInvariant("MACHINE_CREATE", sentence), true, sentence);
    const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
    const before = env.state.tables.machines.length;
    const t = await runTurn(env, sentence, null);
    assert.equal(machineCreates(env), 0, sentence);
    if (t.result.kind === "action_preview") await confirm(env, t.result);
    assert.equal(env.state.tables.machines.length, before, `${sentence}: stroj pribudol`);
  }
});

await check("C: výslovné založenie stále funguje („Pridaj nový stroj …“, „Add machine …“, „Neue Maschine … anlegen“)", async () => {
  for (const phrase of ["Pridaj nový stroj Takeuchi 324.", "Vytvor nový stroj Takeuchi 324.", "Zaeviduj nový stroj Takeuchi 324.", "Add a new machine Takeuchi 324.", "Create machine Takeuchi 324.", "Neue Maschine Takeuchi 324 anlegen.", "Maschine Takeuchi 324 hinzufügen."]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
    const t = await runTurn(env, phrase, null);
    assert.equal(t.intent?.name, "MACHINE_CREATE", phrase);
    assert.equal(t.intent?.args.entityName, "Takeuchi 324", phrase);
    assert.equal(t.result.kind, "action_preview", phrase);
  }
  // „Do stroja X pridaj …" bez servisu nie je založenie.
  assert.notEqual(parseIntentDeterministic("Do stroja Takeuchi 323 pridaj niečo")?.name, "MACHINE_CREATE");
});

await check("D: neistá servisná veta → otázka, žiadne vloženie", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
  const t1 = await runTurn(env, "Pridaj výmenu oleja.", null);
  assert.equal(t1.intent?.name, "MACHINE_SERVICE_ADD");
  assert.ok(t1.pending, "asistent sa spýta na stroj");
  const t2 = await runTurn(env, "Do stroja pridaj výmenu oleja.", null);
  assert.equal(text(t2.result), "Ku ktorému stroju? Povedzte jeho názov.");
  assert.equal(machineCreates(env), 0);
  assert.equal(env.state.tables.machines.length, 3);
});

await check("E: AI navrhne MACHINE_CREATE zo servisnej vety → odmietnuté, zmení sa na otázku o stroji", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
  const ai: ParsedIntent = { name: "MACHINE_CREATE", args: { entityName: "TAKEUCHI 323 oleja a filtrov" }, source: "ai" };
  const sentence = "Takeuchi potrebuje výmenu oleja a filtrov";
  const t = await runTurn(env, sentence, null, { aiIntent: ai });
  assert.equal(t.intent?.name, "MACHINE_SERVICE_ADD");
  assert.equal(machineCreates(env), 0);
  // AI MACHINE_CREATE bez výslovného založenia (a bez servisu) → nerozpoznané.
  const odd = await runTurn(env, "Takeuchi 323 niečo", null, { aiIntent: { name: "MACHINE_CREATE", args: { entityName: "Takeuchi 323 niečo" }, source: "ai" } });
  assert.equal(odd.intent, null);
  assert.equal(machineCreates(env), 0);
  // Logika route žije v orchestrátore; route ho iba volá.
  assert.ok(readFileSync("app/api/assistant/intent/route.ts", "utf8").includes("runAssistantTurn("));
  const route = readFileSync("lib/intents/orchestrator.ts", "utf8");
  const guard = route.indexOf("violatesMachineCreateInvariant(intent.name, rawText)");
  assert.ok(guard > route.indexOf("deps.classifyWithAi(rawText)"), "invariant až po AI");
  assert.ok(guard < route.indexOf("checkIntentAccess(intent.name"), "invariant pred bránou a handlerom");
});

// -----------------------------------------------------------------------------
// Partner z hlasu: „Tester jeden" → „Myslíte obchodného partnera „Tester1“?"
// -----------------------------------------------------------------------------

await check("partner: „Tester1“ a „Tester 1“ → priamo (bez otázky na partnera)", async () => {
  for (const phrase of ["Vytvor faktúru pre Tester1.", "Vytvor faktúru pre Tester 1."]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
    const t = await runTurn(env, phrase, null, { conversationId: CONV });
    assert.equal(t.result.kind, "clarify", phrase);
    assert.equal(slotsOf(env).partnerId, P_T1, phrase);
  }
});

await check("partner: „Tester jeden“ / „Testér jeden“ → „Myslíte …?“ → „Áno.“ → ten istý draft pokračuje", async () => {
  for (const phrase of ["Vytvor faktúru pre Tester jeden.", "Vytvor faktúru pre Testér jeden.", "Create an invoice for Tester one."]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
    const t1 = await runTurn(env, phrase, null, { conversationId: CONV });
    assert.equal(t1.result.kind, "clarify", phrase);
    // Označenie partnera je to isté ako pri výbere (meno · IČO) — identita, nie iba meno.
    assert.match((t1.result as { question: string }).question, /^Myslíte obchodného partnera „Tester1( · 12345678)?“\?$/, phrase);
    assert.equal(slotsOf(env).partnerId, undefined, "bez potvrdenia sa partner nepriradí");
    assert.deepEqual(slotsOf(env).partnerCandidateIds, [P_T1]);
    const t2 = await runTurn(env, "Áno.", null, { conversationId: CONV });
    assert.equal((t2.result as { question: string }).question, translate("sk", "search.voice.invoice.askDescription"), phrase);
    assert.equal(slotsOf(env).partnerId, P_T1, phrase);
    const t3 = await runTurn(env, "Výkopové práce, 10 hodín po 35 eur.", null, { conversationId: CONV });
    assert.equal(t3.result.kind, "clarify");
    assert.deepEqual(slotsOf(env).items, [{ description: "Výkopové práce", quantity: 10, unit: "hod", unitPrice: 35, currency: "EUR" }]);
    assert.equal(slotsOf(env).partnerId, P_T1);
    assert.equal(env.state.tables.invoices.length, 0, "nič sa nefinalizuje");
  }
});

await check("partner: „Nie.“ na návrh → otázka na odberateľa, žiadny partner", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  await runTurn(env, "Vytvor faktúru pre Tester jeden.", null, { conversationId: CONV });
  const t = await runTurn(env, "Nie.", null, { conversationId: CONV });
  assert.equal((t.result as { question: string }).question, translate("sk", "search.voice.invoice.askPartner"));
  assert.equal(slotsOf(env).partnerId, undefined);
});

await check("partner: Tester1 + Tester10, „Tester“ → výber, žiadny tichý výber", async () => {
  const tables = PARTNERS();
  tables.business_partners.push({ id: "00000000-0000-4000-8000-0000000000e9", legal_name: "Tester10", ico: "99990000", company_id: COMPANY_A });
  const env = makeDb({ role: "owner", financeManage: true, tables });
  const t = await runTurn(env, "Vytvor faktúru pre Tester.", null, { conversationId: CONV });
  assert.equal(t.result.kind, "clarify");
  assert.match((t.result as { question: string }).question, /Tester1.*Tester10|Tester10.*Tester1/);
  assert.equal(slotsOf(env).partnerId, undefined);
  // „Tester jeden" pri Tester1 aj Tester10 → iba Tester1 (celé meno), stále s otázkou.
  const env2 = makeDb({ role: "owner", financeManage: true, tables });
  await runTurn(env2, "Vytvor faktúru pre Tester jeden.", null, { conversationId: CONV });
  assert.deepEqual(slotsOf(env2).partnerCandidateIds, [P_T1]);
});

await check("partner nenájdený → „Obchodného partnera „X“ som nenašiel…“; zamestnanec / admin bez financií bez dotazu", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const t = await runTurn(env, "Vytvor faktúru pre Úplne Iný.", null, { conversationId: CONV });
  assert.match(text(t.result), /^Obchodného partnera „Úplne Iný“ som nenašiel\./);
  for (const role of ["employee", "admin"] as const) {
    const denied = makeDb({ role, financeManage: false, tables: PARTNERS() });
    const r = await runTurn(denied, "Vytvor faktúru pre Tester jeden.", null, { conversationId: CONV });
    assert.equal(r.result.kind, "error", role);
    assert.equal(denied.state.queries, 0, `${role}: žiadny dotaz na partnerov`);
  }
  // Iná firma: partner firmy A sa firme B neponúkne.
  const other = makeDb({ role: "owner", financeManage: true, companyId: COMPANY_B, tables: PARTNERS() });
  const o = await runTurn(other, "Vytvor faktúru pre Tester jeden.", null, { conversationId: CONV });
  assert.equal(o.result.kind, "not_found");
});


// -----------------------------------------------------------------------------
// REGRESIA: „Vytvor faktúru." po otázke na stroj/vozidlo/priečinok
// -----------------------------------------------------------------------------
//
// Príčina: nová veta sa pri rozpracovanej otázke posudzovala iba podľa
// slovesa. „Vystav faktúru", „Nová faktúra" či prepis bez slovesa zo
// zoznamu sa doplnili ako meno stroja/vozidla. A holé „Vytvor faktúru"
// parser nepoznal — rozhodoval AI klasifikátor, ktorý od 29fdae3 pozná aj
// ENTITY_CREATE / VEHICLE_CREATE (→ „Akú ŠPZ…?" / „V ktorom module…?").

const INVOICE_PHRASES = ["Vytvor faktúru.", "Vystav faktúru.", "Nová faktúra.", "Faktúru pre Tester1."];
const noEntityQueries = (env: Env) => env.state.confirmations.filter((c) => /^(MACHINE|VEHICLE)_/.test(String(c.intent))).length;

await check("stará otázka na stroj → „Vytvor faktúru.“ → CREATE_INVOICE_DRAFT, otázka na odberateľa, 0 strojových akcií", async () => {
  for (const phrase of INVOICE_PHRASES) {
    const env = makeDb({ role: "owner", financeManage: true, tables: { ...TAKEUCHI(), ...PARTNERS() } });
    const t1 = await runTurn(env, "Pridaj servis výmena oleja.", null, { conversationId: CONV });
    assert.ok(t1.pending, "otázka na stroj existuje");
    const machineReads = env.state.queries;
    const t2 = await runTurn(env, phrase, t1.pending, { conversationId: CONV });
    assert.equal(t2.intent?.name, "CREATE_INVOICE_DRAFT", phrase);
    assert.equal(t2.result.kind, "clarify", `${phrase}: ${JSON.stringify(t2.result)}`);
    assert.equal(t2.pending, null, "stará otázka zahodená");
    assert.equal(noEntityQueries(env), 0);
    assert.ok(!/stroj|vozidl/i.test((t2.result as { question: string }).question), phrase);
    // Žiadne čítanie strojov/vozidiel v druhom kroku (iba partneri / dialóg faktúry).
    assert.ok(env.state.queries - machineReads <= 1, `${phrase}: zbytočné dotazy`);
  }
  const bare = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  const t = await runTurn(bare, "Vytvor faktúru.", null, { conversationId: CONV });
  assert.equal((t.result as { question: string }).question, translate("sk", "search.voice.invoice.askPartner"));
});

await check("stará otázka na vozidlo (Vozidlá) → „Vytvor faktúru.“ → faktúra, žiadne vozidlo", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { vehicles: [{ id: "v-1", spz: "AB123CD", znacka: "Škoda", model: "Octavia" }], ...PARTNERS() } });
  const t1 = await runTurn(env, "Pridaj servis za 250 eur.", null, { module: "vehicles", conversationId: CONV });
  assert.equal(text(t1.result), translate("sk", "assistant.vehicle.whichVehicle"));
  const t2 = await runTurn(env, "Vytvor faktúru.", t1.pending, { module: "vehicles", conversationId: CONV });
  assert.equal(t2.intent?.name, "CREATE_INVOICE_DRAFT");
  assert.equal(t2.result.kind, "clarify");
  assert.equal(noEntityQueries(env), 0);
});

await check("stará otázka na priečinok → „Vytvor faktúru.“ / „Pridaj nový stroj.“ → nové príkazy", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: {
    ...PARTNERS(),
    document_folders: [{ id: "f-aug", name: "August 2026", created_at: "2026-09-01" }, { id: "f-sep", name: "September 2026", created_at: "2026-09-02" }],
    documents: [{ id: "d-1", document_type: "receipt", deleted_at: null, extracted_fields: {}, created_at: "2026-08-10" }],
  } });
  const selection = [{ type: "document" as const, id: "d-1" }];
  const t1 = await runTurn(env, "Pridaj tieto doklady do priečinka.", null, { selection, conversationId: CONV });
  assert.ok(t1.pending);
  const t2 = await runTurn(env, "Vytvor faktúru.", t1.pending, { selection, conversationId: CONV });
  assert.equal(t2.intent?.name, "CREATE_INVOICE_DRAFT");
  const t3 = await runTurn(env, "Pridaj nový stroj Test 99.", t1.pending, { selection });
  assert.equal(t3.intent?.name, "MACHINE_CREATE");
  const t4 = await runTurn(env, "Ukáž sklad.", t1.pending, { selection });
  assert.equal(t4.intent?.name, "SEARCH_INVENTORY_ITEM");
  assert.equal(env.state.confirmations.filter((c) => c.intent === "FOLDER_ADD_ITEMS").length, 0);
});

await check("kontext stránky: /stroje, /vozidlá, /sklad + „Vytvor faktúru.“ → faktúra; /stroje + „Vytvor novú položku.“ → stroj", async () => {
  for (const page of ["machines", "vehicles", "inventory"]) {
    const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
    const t = await runTurn(env, "Vytvor faktúru.", null, { module: page, conversationId: CONV });
    assert.equal(t.intent?.name, "CREATE_INVOICE_DRAFT", page);
    assert.equal(t.result.kind, "clarify", page);
  }
  assert.equal(parseIntentDeterministic("Vytvor novú položku.", { module: "machines" })?.name, "MACHINE_CREATE");
  assert.equal(parseIntentDeterministic("Faktúra.")?.name === "CREATE_INVOICE_DRAFT", false, "holé „Faktúra.“ nie je založenie");
});

await check("poistka: faktúra vo vete + MACHINE_/VEHICLE_/INVENTORY_/ENTITY_CREATE → nikdy (ani z AI)", async () => {
  for (const name of ["MACHINE_CREATE", "MACHINE_SERVICE_ADD", "VEHICLE_CREATE", "VEHICLE_SERVICE_ADD", "INVENTORY_ITEM_CREATE", "ENTITY_CREATE"]) {
    assert.equal(isIntentCompatibleWithUtterance(name, "Vytvor faktúru."), false, name);
  }
  assert.equal(isIntentCompatibleWithUtterance("CREATE_INVOICE_DRAFT", "Vytvor faktúru za servis stroja 300 eur"), true);
  const env = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
  const t = await runTurn(env, "Urob mi tú faktúru hneď", null, { aiIntent: { name: "VEHICLE_CREATE", args: {}, source: "ai" } });
  assert.equal(t.intent, null);
  assert.equal(noEntityQueries(env), 0);
});

await check("skutočné odpovede ostávajú: „Takeuchi 323.“ → stroj, „AB123CD.“ → vozidlo, „Áno.“ → partner", async () => {
  const m = makeDb({ role: "owner", financeManage: true, tables: TAKEUCHI() });
  const m1 = await runTurn(m, "Do stroja zaeviduj servis výmena oleja.", null);
  const m2 = await runTurn(m, "Takeuchi 323.", m1.pending);
  assert.equal((m.state.confirmations[0].canonical_args as Row).machineId, "m-tak");
  assert.equal(m2.result.kind, "action_preview");
  const v = makeDb({ role: "owner", financeManage: true, tables: { vehicles: [{ id: "v-1", spz: "AB123CD", znacka: "Škoda", model: "Octavia" }] } });
  const v1 = await runTurn(v, "Pridaj servis za 250 eur.", null, { module: "vehicles" });
  await runTurn(v, "AB123CD.", v1.pending, { module: "vehicles" });
  assert.equal((v.state.confirmations[0].canonical_args as Row).vehicleId, "v-1");
  const p = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  await runTurn(p, "Vytvor faktúru pre Tester jeden.", null, { conversationId: CONV });
  await runTurn(p, "Áno.", null, { conversationId: CONV });
  assert.equal(slotsOf(p).partnerId, P_T1);
});

await check("rozpracovaná faktúra: odpovede ostávajú odpoveďami, nový príkaz ju zruší", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  await runTurn(env, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV });
  await runTurn(env, "Prenájom bagra za 300 eur.", null, { conversationId: CONV });
  assert.deepEqual((slotsOf(env).items as Row[]).map((i) => i.description), ["Prenájom bagra"]);
  const t = await runTurn(env, "Ukáž sklad.", null, { conversationId: CONV });
  assert.equal(t.intent?.name, "SEARCH_INVENTORY_ITEM");
  assert.equal(env.state.conversations.get(`${USER_A}|${COMPANY_A}|${CONV}`), undefined, "dialóg faktúry zrušený");
  // „Vytvor faktúru pre Tester1." uprostred iného dialógu začne odznova.
  await runTurn(env, "Vytvor faktúru pre Tester1.", null, { conversationId: CONV });
  await runTurn(env, "Výkopové práce za 350 eur.", null, { conversationId: CONV });
  const restart = await runTurn(env, "Vytvor faktúru.", null, { conversationId: CONV });
  assert.equal((restart.result as { question: string }).question, translate("sk", "search.voice.invoice.askPartner"));
  assert.equal(slotsOf(env).items, undefined, "nová faktúra, nie pokračovanie starej");
});

await check("stav: zrušenie a vypršanie; prepis sa posiela raz a nezmenený", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { ...TAKEUCHI(), ...PARTNERS() } });
  const past = Date.now() - (PENDING_CLARIFICATION_TTL_SECONDS + 60) * 1000;
  const t1 = await runTurn(env, "Pridaj servis výmena oleja.", null, { now: past });
  const t2 = await runTurn(env, "Vytvor faktúru.", t1.pending, { conversationId: CONV });
  assert.equal(t2.intent?.name, "CREATE_INVOICE_DRAFT", "vypršaná otázka neblokuje nový príkaz");
  const t3 = await runTurn(env, "Pridaj servis výmena oleja.", null);
  const t4 = await runTurn(env, "Nechaj tak.", t3.pending);
  assert.equal(t4.pending, null);
  const launcher = readFileSync("app/components/voice/VoiceLauncher.tsx", "utf8");
  // (pred zobrazením sa iba zastaví predchádzajúca hlasová odpoveď)
  assert.ok(/onTranscript: \(text\) => \{[^}]{0,120}setTranscript\(text\);[^}]{0,120}void runIntent\(text\);/.test(launcher), "launcher: zobrazený prepis = odoslaný text");
  assert.ok(launcher.includes("body: JSON.stringify({\n          text,"), "launcher posiela presne `text`");
  assert.ok(launcher.includes("pendingClarificationRef.current = null;"), "zatvorenie/zrušenie maže otázku");
  const dashboard = readFileSync("app/components/Dashboard.tsx", "utf8");
  assert.ok(dashboard.includes("voiceTranscriptRef.current = text;\n      setSearch(text);"), "nástenka: prepis ide do poľa bez úprav");
  assert.ok(dashboard.includes("text: trimmed,"), "nástenka posiela iba orezaný text poľa");
});

// -----------------------------------------------------------------------------
// Route a UI zapojenie
// -----------------------------------------------------------------------------

await check("route: otázka sa spracuje pred parserom, brána oprávnení platí aj pre pokračovanie", () => {
  // Logika route žije v orchestrátore; route ho iba volá.
  assert.ok(readFileSync("app/api/assistant/intent/route.ts", "utf8").includes("runAssistantTurn("));
  const route = readFileSync("lib/intents/orchestrator.ts", "utf8");
  const resume = route.indexOf("unsealPendingClarification(input.pendingClarification");
  const parse = route.indexOf("parseIntentDeterministic(rawText");
  const gate = route.indexOf("restrictedAssistantDenial(intent");
  const access = route.indexOf("checkIntentAccess(intent.name");
  assert.ok(resume > 0 && resume < parse && parse < gate && gate < access);
  assert.ok(route.includes("sealPendingClarification(intent.name"));
  assert.ok(route.includes('"INBOX_DELETE_UNASSIGNED",') && route.includes("sanitizeAiIntent(await deps.classifyWithAi(rawText), rawText)"), "AI nesmie vybrať hromadné mazanie");
  assert.ok(route.includes("delete args.entityId"), "entityId z parsera/AI sa zahodí");
});

await check("UI: token otázky drží ref (nie pole hľadania) v launcheri aj na nástenke", () => {
  for (const file of ["app/components/voice/VoiceLauncher.tsx", "app/components/Dashboard.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("pendingClarificationRef"), file);
    assert.ok(source.includes("pendingClarification: pendingClarificationRef.current"), file);
  }
  const dashboard = readFileSync("app/components/Dashboard.tsx", "utf8");
  assert.ok(dashboard.includes('intentResult.kind === "not_found" || intentResult.kind === "error"'), "nástenka musí ukázať konkrétnu vetu");
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
