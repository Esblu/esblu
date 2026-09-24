// =============================================================================
// Intent Engine — role, rozsah hlasu, nové prevádzkové intenty a príjem
// dokladov bez čítania.
//
// SPUSTENIE
//   npm run test:intent-permissions
//
// ČO SA TU CHRÁNI
// ---------------
//   1. Hlas nikdy nemá viac práv než UI a databáza (matica rolí).
//   2. Oprávnenie sa rozhodne PRED dotazom; odmietnutie neobsahuje dáta.
//   3. Sklad, stroje, vozidlá a mazanie priečinka: SK/DE/EN vety, kontext
//      modulu, nástenka sa pýta, „tento“ iba s overenou entitou.
//   4. Zápisy len s potvrdením; mazanie iba pri PRESNOM mene.
//   5. Zamestnanec smie doklad odoslať, ale obsah skenu nedostane
//      (zapečatený, viazaný na používateľa, časovo obmedzený).
//
// Databázovú stranu (RLS, cudzí tenant, anon) testuje
// scripts/sql/role-scope-rls-matrix.sql.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  EMPLOYEE_ASSISTANT_ALLOWLIST,
  checkIntentAccess,
  denialMessageKey,
  intentRequirement,
  restrictedAssistantDenial,
  type AccessContext,
  type AccessDenial,
} from "@/lib/intents/permissions";
import { parseIntentDeterministic } from "@/lib/intents/parse";
import { INTENT_REGISTRY } from "@/lib/intents/registry";
import {
  OPERATIONAL_WRITE_INTENTS,
  handleOperationalIntent,
  resolveByName,
  stemVariants,
} from "@/lib/intents/operational-intents";
import { isOwnStoragePath, sealIntakeExtraction, unsealIntakeExtraction, INTAKE_SEAL_TTL_SECONDS } from "@/lib/intake-seal";
import { translate } from "@/lib/i18n/translate";
import type { IntentName, IntentResult, ParsedIntent } from "@/lib/intents/types";

let passed = 0;
let failed = 0;

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

// -----------------------------------------------------------------------------
// Roly (rovnaké hodnoty, aké vracajú esblu_my_finance_* a esblu_role_can_operate)
// -----------------------------------------------------------------------------

const ROLES: Record<string, AccessContext> = {
  owner: { role: "owner", financeView: true, financeManage: true, canOperate: true },
  adminNoFinance: { role: "admin", financeView: false, financeManage: false, canOperate: true },
  adminFinance: { role: "admin", financeView: true, financeManage: true, canOperate: true },
  accountant: { role: "accountant", financeView: true, financeManage: true, canOperate: false },
  employee: { role: "employee", financeView: false, financeManage: false, canOperate: true },
};

type Expect = Record<keyof typeof ROLES, AccessDenial | null>;
const ok = null;

const MATRIX: Array<[IntentName, Record<string, unknown>, Expect]> = [
  // Sklad: účtovník nič; zamestnanec nemá všeobecný asistent (UI mu sklad na čítanie nechá)
  ["SEARCH_INVENTORY_ITEM", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["INVENTORY_ITEM_STATUS", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["INVENTORY_ITEM_CREATE", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["INVENTORY_QUANTITY_ADJUST", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["INVENTORY_ITEM_DELETE", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  // Stroje
  ["OPEN_MACHINE", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["SHOW_MACHINE_SERVICE", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["MACHINE_CREATE", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["MACHINE_SERVICE_ADD", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["MACHINE_DELETE", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["MACHINE_PHOTO_ADD", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  // Vozidlá
  ["OPEN_VEHICLE", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["SHOW_VEHICLE_DOCUMENTS", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["VEHICLE_CREATE", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["VEHICLE_SERVICE_ADD", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  ["VEHICLE_DELETE", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
  // Financie: admin iba s výslovným oprávnením, zamestnanec nikdy
  ["SEARCH_INVOICE", {}, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["SHOW_UNPAID_INVOICES", {}, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["SEARCH_PARTNER", {}, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["DOCUMENTS_LIST_UNDOWNLOADED", {}, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["DOCUMENTS_DOWNLOAD_STATUS", {}, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["CREATE_INVOICE_DRAFT", {}, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["FOLDER_DELETE", {}, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["FOLDER_OPEN", {}, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["DOCUMENTS_EXPORT", {}, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["SEARCH_DOCUMENTS", { documentTypes: ["receipt"] }, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["SEARCH_DOCUMENTS", { documentTypes: ["delivery_note"] }, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["EXPORT_DOCUMENTS", {}, { owner: ok, adminNoFinance: "finance", adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  // Príjem dokladu: každý člen (zamestnanec IBA toto); navigácia: nie zamestnanec
  ["DOCUMENT_INTAKE", { documentTypes: ["invoice"] }, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: ok, employee: ok }],
  ["OPEN_MODULE", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  ["ENTITY_CREATE", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: ok, employee: "assistant_scope" }],
  // Termíny sú prevádzkové
  ["UPCOMING_DEADLINES", {}, { owner: ok, adminNoFinance: ok, adminFinance: ok, accountant: "operational", employee: "assistant_scope" }],
];

await check("matica rolí: každý intent × každá rola", () => {
  for (const [name, args, expect] of MATRIX) {
    for (const [role, ctx] of Object.entries(ROLES)) {
      assert.equal(checkIntentAccess(name, args, ctx), expect[role as keyof Expect], `${name} ${JSON.stringify(args)} / ${role}`);
    }
  }
});

await check("neznámy intent = najprísnejšie (finance_manage)", () => {
  assert.equal(intentRequirement("NOT_A_REAL_INTENT" as IntentName, {}), "finance_manage");
  assert.equal(checkIntentAccess("NOT_A_REAL_INTENT" as IntentName, {}, ROLES.employee), "assistant_scope");
  assert.equal(checkIntentAccess("NOT_A_REAL_INTENT" as IntentName, {}, ROLES.adminNoFinance), "finance");
});

await check("podvrhnutá rola bez práv serverových RPC nič neodomkne", () => {
  // Klient tvrdí „owner“, ale server spočítal financie = false → odmietnuté.
  const forged: AccessContext = { role: "owner", financeView: false, financeManage: false, canOperate: true };
  assert.equal(checkIntentAccess("SEARCH_INVOICE", {}, forged), "finance");
  // Neznáma rola nie je manažér.
  // Neznáma rola = ako zamestnanec: predvolene odmietnuté.
  const unknown: AccessContext = { role: "superuser", financeView: true, financeManage: true, canOperate: true };
  assert.equal(checkIntentAccess("MACHINE_DELETE", {}, unknown), "assistant_scope");
  assert.equal(checkIntentAccess("SEARCH_INVOICE", {}, unknown), "assistant_scope");
});

await check("každý nový intent má výslovnú požiadavku (nie predvolenú)", () => {
  const explicit: IntentName[] = [
    ...OPERATIONAL_WRITE_INTENTS, "FOLDER_DELETE", "MACHINE_PHOTO_ADD", "VEHICLE_PHOTO_ADD", "DOCUMENT_INTAKE", "ENTITY_CREATE",
  ];
  const source = readFileSync("lib/intents/permissions.ts", "utf8");
  for (const name of explicit) assert.ok(new RegExp(`\\b${name}:`).test(source), name);
});

// -----------------------------------------------------------------------------
// Odmietnutie bez dát
// -----------------------------------------------------------------------------

await check("odmietnutia: preložené v SK/DE/EN, bez čísel a premenných", () => {
  for (const denial of ["finance", "operational", "inventory_read_only", "write", "category", "assistant_scope"] as AccessDenial[]) {
    const key = denialMessageKey(denial);
    for (const locale of ["sk", "en", "de"] as const) {
      const text = translate(locale, key);
      assert.notEqual(text, key, `${key} ${locale}`);
      assert.ok(!/\d/.test(text), `${key} ${locale} obsahuje číslo`);
      assert.ok(!text.includes("{{"), `${key} ${locale} obsahuje premennú`);
    }
  }
});

await check("route: brána oprávnení beží pred overením entity a pred handlermi", () => {
  const route = readFileSync("app/api/assistant/intent/route.ts", "utf8");
  const gate = route.indexOf("checkIntentAccess(intent.name");
  assert.ok(gate > 0, "brána chýba");
  for (const later of ["await resolveUiEntity(", "handleOperationalIntent(", "handleFolderIntent(", "await handleIntent("]) {
    const at = route.indexOf(later);
    if (at >= 0) assert.ok(at > gate, `${later} je pred bránou`);
  }
});

await check("execute: operácia sa pred zápisom znova overí čerstvými RPC", () => {
  const actions = readFileSync("lib/intents/actions.ts", "utf8");
  assert.ok(actions.includes("checkIntentAccess"));
  for (const rpc of ["esblu_my_active_role", "esblu_role_can_operate", "esblu_my_finance_view", "esblu_my_finance_manage"]) {
    assert.ok(actions.includes(rpc), rpc);
  }
});

// -----------------------------------------------------------------------------
// Parser — SK / EN / DE, kontext modulu, nástenka
// -----------------------------------------------------------------------------

function parsed(text: string, module?: Parameters<typeof parseIntentDeterministic>[1]["module"]) {
  return parseIntentDeterministic(text, module ? { module } : {});
}

const PHRASES: Array<[string, string | undefined, IntentName | null, Record<string, unknown>?]> = [
  // Sklad
  ["Vytvor novú položku", "inventory", "INVENTORY_ITEM_CREATE"],
  ["Vytvor skladovú položku cement", undefined, "INVENTORY_ITEM_CREATE", { entityName: "Cement" }],
  ["Pridaj do skladu 20 vrutov", undefined, "INVENTORY_QUANTITY_ADJUST", { quantity: 20, quantityMode: "add" }],
  ["Odober zo skladu 5 cementu", undefined, "INVENTORY_QUANTITY_ADJUST", { quantity: 5, quantityMode: "subtract" }],
  ["Nastav stav vrutov na 100", "inventory", "INVENTORY_QUANTITY_ADJUST", { quantity: 100, quantityMode: "set" }],
  ["Zmaž skladovú položku cement", undefined, "INVENTORY_ITEM_DELETE", { query: "Cement" }],
  ["Otvor položku skrutky", undefined, "OPEN_INVENTORY_ITEM", { query: "skrutky" }],
  ["Máme na sklade cement?", undefined, "INVENTORY_ITEM_STATUS", { query: "cement" }],
  ["Ukáž nízke zásoby", undefined, "SHOW_LOW_STOCK"],
  ["Create new inventory item cement", undefined, "INVENTORY_ITEM_CREATE", { entityName: "Cement" }],
  ["Add 20 screws to inventory", undefined, "INVENTORY_QUANTITY_ADJUST", { quantity: 20, quantityMode: "add", entityName: "Screws" }],
  ["Neue Lagerposition Zement anlegen", undefined, "INVENTORY_ITEM_CREATE", { entityName: "Zement" }],
  ["20 Schrauben ins Lager buchen", undefined, "INVENTORY_QUANTITY_ADJUST", { quantity: 20, quantityMode: "add", entityName: "Schrauben" }],
  // Stroje
  ["Pridaj nový stroj bager CAT 320", undefined, "MACHINE_CREATE", { entityName: "Bager CAT 320" }],
  ["Zmaž stroj bager", undefined, "MACHINE_DELETE", { query: "Bager" }],
  ["Pridaj servis k stroju bager, výmena oleja", undefined, "MACHINE_SERVICE_ADD", { query: "Bager", serviceTitle: "výmena oleja" }],
  ["Ukáž servis stroja bager", undefined, "SHOW_MACHINE_SERVICE", { query: "Bager" }],
  ["Ukáž servis bagra CAT 302", undefined, "SHOW_MACHINE_SERVICE", { query: "cat 302" }], // regresia pôvodnej vetvy
  ["Ktoré stroje potrebujú servis", undefined, "UPCOMING_DEADLINES", { deadlineTypes: ["MACHINE_SERVICE"] }],
  ["Otvor stroj CAT 302", undefined, "OPEN_MACHINE"],
  ["Kedy má BA123CD STK", undefined, "VEHICLE_STK_STATUS"],
  ["Pridaj fotku k stroju bager", undefined, "MACHINE_PHOTO_ADD", { query: "Bager" }],
  ["Delete machine excavator", undefined, "MACHINE_DELETE", { query: "Excavator" }],
  ["Maschine Bagger löschen", undefined, "MACHINE_DELETE", { query: "Bagger" }],
  ["Zmaž tento stroj", "machines", "MACHINE_DELETE", { useContext: true }],
  // Vozidlá
  ["Pridaj vozidlo BA123CD", undefined, "VEHICLE_CREATE", { query: "BA123CD" }],
  ["Add vehicle BA123CD", undefined, "VEHICLE_CREATE", { query: "BA123CD" }],
  ["Fahrzeug BA123CD hinzufügen", undefined, "VEHICLE_CREATE", { query: "BA123CD" }],
  ["Zmaž vozidlo BA123CD", undefined, "VEHICLE_DELETE", { query: "BA123CD" }],
  ["Pridaj servis k vozidlu BA123CD", undefined, "VEHICLE_SERVICE_ADD", { query: "BA123CD" }],
  ["Ukáž servis vozidla BA123CD", undefined, "SHOW_VEHICLE_SERVICE", { query: "BA123CD" }],
  ["Ukáž servis", "vehicles", "SHOW_VEHICLE_SERVICE"],
  ["Otvor vozidlo BA123CD", undefined, "OPEN_VEHICLE", { query: "BA123CD" }],
  ["Pridaj fotku k vozidlu BA123CD", undefined, "VEHICLE_PHOTO_ADD", { query: "BA123CD" }],
  // Priečinky
  ["Zmaž priečinok Test1", undefined, "FOLDER_DELETE", { folderName: "Test1" }],
  ["Delete accounting folder Test1", undefined, "FOLDER_DELETE", { folderName: "Test1" }],
  ["Belegordner Test1 löschen", undefined, "FOLDER_DELETE", { folderName: "Test1" }],
  // Príjem dokladov
  ["Pridaj dodací list", undefined, "DOCUMENT_INTAKE", { documentTypes: ["delivery_note"] }],
  ["Naskenuj bloček", undefined, "DOCUMENT_INTAKE", { documentTypes: ["receipt"] }],
  ["Nahraj faktúru", undefined, "DOCUMENT_INTAKE", { documentTypes: ["invoice"] }],
  ["Upload receipt", undefined, "DOCUMENT_INTAKE", { documentTypes: ["receipt"] }],
  ["Lieferschein hochladen", undefined, "DOCUMENT_INTAKE", { documentTypes: ["delivery_note"] }],
  // Nepodporované / hromadné nebezpečné — nikdy nič nevykoná
  ["Vymaž všetky faktúry", undefined, null],
  ["Pošli faktúru", undefined, null],
];

await check("frázy SK/EN/DE → správny intent a sloty", () => {
  for (const [text, module, expected, args] of PHRASES) {
    const result = parsed(text, module as never);
    assert.equal(result?.name ?? null, expected, `${text} [${module ?? "-"}]`);
    for (const [key, value] of Object.entries(args ?? {})) {
      assert.deepEqual((result?.args as Record<string, unknown>)[key], value, `${text}: ${key}`);
    }
  }
});

await check("nástenka: „Vytvor novú položku“ nevie modul → ENTITY_CREATE (otázka)", () => {
  assert.equal(parsed("Vytvor novú položku", "dashboard")?.name, "ENTITY_CREATE");
  assert.equal(parsed("Vytvor novú položku")?.name, "ENTITY_CREATE");
  assert.equal(parsed("Vytvor novú položku", "machines")?.name, "MACHINE_CREATE");
  assert.equal(parsed("Vytvor novú položku", "vehicles")?.name, "VEHICLE_CREATE");
  const route = readFileSync("app/api/assistant/intent/route.ts", "utf8");
  assert.ok(route.includes('"assistant.clarify.createModule"'));
  assert.match(translate("sk", "assistant.clarify.createModule"), /V ktorom module ju chcete vytvoriť\?/);
});

await check("„z priečinka“ je vyradenie dokladov, nie zmazanie priečinka", () => {
  assert.notEqual(parsed("Odstráň tento doklad z priečinka Test1")?.name, "FOLDER_DELETE");
});

await check("mazanie množstvom v sklade = zmena stavu, nie zmazanie položky", () => {
  assert.equal(parsed("Odstráň zo skladu 5 cementu")?.name, "INVENTORY_QUANTITY_ADJUST");
});

await check("registry: všetky prevádzkové zápisy a FOLDER_DELETE vyžadujú potvrdenie", () => {
  for (const name of [...OPERATIONAL_WRITE_INTENTS, "FOLDER_DELETE"] as IntentName[]) {
    assert.equal(INTENT_REGISTRY[name].readOnly, false, name);
    assert.equal(INTENT_REGISTRY[name].requiresConfirmation, true, name);
  }
  for (const name of ["MACHINE_PHOTO_ADD", "VEHICLE_PHOTO_ADD", "DOCUMENT_INTAKE", "ENTITY_CREATE"] as IntentName[]) {
    assert.equal(INTENT_REGISTRY[name].readOnly, true, name);
  }
});

await check("potvrdenia: allowlist v migrácii a v actions.ts pokrýva všetky nové zápisy", () => {
  const sql = readFileSync("supabase/migrations/20260926120000_role_scope_voice_hardening.sql", "utf8");
  const actions = readFileSync("lib/intents/actions.ts", "utf8");
  for (const name of [...OPERATIONAL_WRITE_INTENTS, "FOLDER_DELETE"]) {
    assert.ok(sql.includes(`'${name}'`), `SQL ${name}`);
    assert.ok(actions.includes(`"${name}"`), `actions ${name}`);
  }
});

// -----------------------------------------------------------------------------
// Rozlíšenie mien a nejednoznačnosť
// -----------------------------------------------------------------------------

await check("stemVariants: pádové koncovky", () => {
  assert.ok(stemVariants("cementu").includes("cement"));
  assert.ok(stemVariants("vrutov").includes("vrut"));
  assert.deepEqual(stemVariants("ab"), ["ab"]);
});

await check("resolveByName: presná, jednoznačná, nejednoznačná, žiadna", () => {
  const rows = [
    { id: "1", name: "Cement" },
    { id: "2", name: "Cement biely" },
    { id: "3", name: "Vruty 5x60" },
  ];
  assert.deepEqual(resolveByName(rows, "cement"), { match: rows[0] });
  assert.deepEqual(resolveByName(rows, "vrutov"), { match: rows[2] });
  assert.ok("ambiguous" in resolveByName(rows, "cem"));
  assert.deepEqual(resolveByName(rows, "piesok"), { none: true });
  assert.deepEqual(resolveByName(rows, "  "), { none: true });
});

// Minimálny falošný klient: select/eq/limit/maybeSingle/count nad pamäťou.
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const queries: string[] = [];
  const db = {
    from(table: string) {
      queries.push(table);
      let rows = [...(tables[table] ?? [])];
      let head = false;
      const builder: Record<string, unknown> = {
        select(_cols: string, opts?: { head?: boolean }) { head = Boolean(opts?.head); return builder; },
        eq(col: string, value: unknown) { rows = rows.filter((r) => r[col] === value); return builder; },
        limit() { return builder; },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
        then(resolve: (v: unknown) => void) { resolve(head ? { count: rows.length, data: null, error: null } : { data: rows, error: null }); },
      };
      return builder;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { db: db as never, queries };
}

function confirmations() {
  const calls: Array<{ intent: string; args: Record<string, unknown> }> = [];
  const create = async (intent: string, args: Record<string, unknown>) => {
    calls.push({ intent, args });
    return "00000000-0000-4000-8000-00000000c0f1";
  };
  return { calls, create: create as never };
}

const CTX = { companyId: "c1", userId: "u1", resolvedEntity: null, today: "2026-09-24" };
const intent = (name: IntentName, args: Record<string, unknown> = {}): ParsedIntent => ({ name, args, source: "deterministic" });
const INVENTORY = {
  inventory_items: [
    { id: "i1", name: "Cement", quantity: 10, unit: "vrece" },
    { id: "i2", name: "Cement biely", quantity: 4, unit: "vrece" },
    { id: "i3", name: "Vruty", quantity: 3, unit: "ks" },
  ],
};
const MACHINES = {
  machines: [
    { id: "m1", name: "Bager CAT 320", manufacturer: "CAT", model: "320" },
    { id: "m2", name: "Bager JCB", manufacturer: "JCB", model: "3CX" },
  ],
  machine_services: [{ id: "s1", machine_id: "m1" }],
  machine_photos: [],
};

await check("zmazanie položky: približné meno → výber, žiadne potvrdenie", async () => {
  const { db } = fakeDb(INVENTORY);
  const c = confirmations();
  const result = await handleOperationalIntent(db, "sk", intent("INVENTORY_ITEM_DELETE", { query: "cem" }), CTX, c.create);
  assert.equal(result.kind, "list");
  assert.equal(c.calls.length, 0);
});

await check("zmazanie položky: jediná približná zhoda sa NEBERIE potichu", async () => {
  const { db } = fakeDb(INVENTORY);
  const c = confirmations();
  const result = await handleOperationalIntent(db, "sk", intent("INVENTORY_ITEM_DELETE", { query: "vrut" }), CTX, c.create);
  assert.equal(result.kind, "list");
  assert.equal(c.calls.length, 0);
});

await check("zmazanie položky: presné meno → deštruktívny náhľad s presným ID", async () => {
  const { db } = fakeDb(INVENTORY);
  const c = confirmations();
  const result = await handleOperationalIntent(db, "sk", intent("INVENTORY_ITEM_DELETE", { query: "Cement" }), CTX, c.create) as Extract<IntentResult, { kind: "action_preview" }>;
  assert.equal(result.kind, "action_preview");
  assert.equal(result.destructive, true);
  assert.deepEqual(c.calls, [{ intent: "INVENTORY_ITEM_DELETE", args: { itemId: "i1", name: "Cement" } }]);
});

await check("zmena stavu: pod nulu nejde; potvrdenie viaže očakávaný stav", async () => {
  const { db } = fakeDb(INVENTORY);
  const c = confirmations();
  const low = await handleOperationalIntent(db, "sk", intent("INVENTORY_QUANTITY_ADJUST", { query: "Vruty", quantity: 5, quantityMode: "subtract" }), CTX, c.create);
  assert.equal(low.kind, "answer");
  assert.equal(c.calls.length, 0);
  const add = await handleOperationalIntent(db, "sk", intent("INVENTORY_QUANTITY_ADJUST", { query: "Vruty", quantity: 20, quantityMode: "add" }), CTX, c.create);
  assert.equal(add.kind, "action_preview");
  assert.deepEqual(c.calls[0], { intent: "INVENTORY_QUANTITY_ADJUST", args: { itemId: "i3", expectedQuantity: 3, newQuantity: 23 } });
});

await check("pridanie neexistujúcej položky → návrh založiť (s potvrdením)", async () => {
  const { db } = fakeDb(INVENTORY);
  const c = confirmations();
  const result = await handleOperationalIntent(db, "sk", intent("INVENTORY_QUANTITY_ADJUST", { query: "Piesok", entityName: "Piesok", quantity: 2, quantityMode: "add" }), CTX, c.create);
  assert.equal(result.kind, "action_preview");
  assert.equal(c.calls[0].intent, "INVENTORY_ITEM_CREATE");
});

await check("vytvorenie bez mena → otázka „Aký názov…“", async () => {
  const { db } = fakeDb(INVENTORY);
  const c = confirmations();
  const result = await handleOperationalIntent(db, "sk", intent("INVENTORY_ITEM_CREATE", {}), CTX, c.create) as { text: string };
  assert.equal(result.text, "Aký názov má mať nová skladová položka?");
  assert.equal(c.calls.length, 0);
});

await check("„tento stroj“ bez overenej entity (nástenka) → otázka, žiadny dotaz ani potvrdenie", async () => {
  const { db, queries } = fakeDb(MACHINES);
  const c = confirmations();
  const result = await handleOperationalIntent(db, "sk", intent("MACHINE_DELETE", { useContext: true }), CTX, c.create);
  assert.equal(result.kind, "answer");
  assert.equal(queries.length, 0);
  assert.equal(c.calls.length, 0);
});

await check("„tento stroj“ s entitou overenou serverom → náhľad pre ňu", async () => {
  const { db } = fakeDb(MACHINES);
  const c = confirmations();
  const resolvedEntity = { entityType: "machine", entityId: "m1", label: "Bager CAT 320", row: {} } as never;
  const result = await handleOperationalIntent(db, "sk", intent("MACHINE_DELETE", { useContext: true }), { ...CTX, resolvedEntity }, c.create);
  assert.equal(result.kind, "action_preview");
  assert.equal(c.calls[0].args.machineId, "m1");
});

await check("zmazanie stroja: „bager“ je nejednoznačný → výber", async () => {
  const { db } = fakeDb(MACHINES);
  const c = confirmations();
  const result = await handleOperationalIntent(db, "sk", intent("MACHINE_DELETE", { query: "Bager" }), CTX, c.create);
  assert.equal(result.kind, "list");
  assert.equal(c.calls.length, 0);
});

await check("stroj sa nenašiel → konkrétna veta s menom", async () => {
  const { db } = fakeDb(MACHINES);
  const c = confirmations();
  const result = await handleOperationalIntent(db, "sk", intent("MACHINE_DELETE", { query: "Žeriav" }), CTX, c.create) as { kind: string; text: string };
  assert.equal(result.kind, "not_found");
  assert.ok(result.text.includes("Žeriav"));
});

// -----------------------------------------------------------------------------
// Príjem dokladu bez čítania
// -----------------------------------------------------------------------------

const SECRET = "a".repeat(64);
const EXTRACTION = {
  documentType: "invoice" as const,
  confidenceScore: 0.9,
  reviewStatus: "needs_review",
  rawText: "TAJNÉ 1 234,56 EUR",
  documentLanguage: "sk",
  fieldConfidence: null,
  fields: { supplier: "Dodávateľ s.r.o.", totalAmount: 1234.56 },
};

await check("pečať: nečitateľná, round-trip iba pre toho istého používateľa", () => {
  const token = sealIntakeExtraction(EXTRACTION, "user-a", { secret: SECRET });
  assert.ok(token);
  assert.ok(!token!.includes("Dod") && !token!.includes("1234"));
  assert.ok(!Buffer.from(token!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").includes("TAJN"));
  assert.deepEqual(unsealIntakeExtraction(token!, "user-a", { secret: SECRET }), EXTRACTION);
  assert.equal(unsealIntakeExtraction(token!, "user-b", { secret: SECRET }), null);
});

await check("pečať: manipulácia, zlý kľúč, expirácia, chýbajúce tajomstvo", () => {
  const now = Date.UTC(2026, 8, 24, 12);
  const token = sealIntakeExtraction(EXTRACTION, "user-a", { secret: SECRET, now })!;
  const flipped = token.slice(0, 40) + (token[40] === "A" ? "B" : "A") + token.slice(41);
  assert.equal(unsealIntakeExtraction(flipped, "user-a", { secret: SECRET, now }), null);
  assert.equal(unsealIntakeExtraction(token, "user-a", { secret: "b".repeat(64), now }), null);
  assert.ok(unsealIntakeExtraction(token, "user-a", { secret: SECRET, now: now + (INTAKE_SEAL_TTL_SECONDS - 5) * 1000 }));
  assert.equal(unsealIntakeExtraction(token, "user-a", { secret: SECRET, now: now + (INTAKE_SEAL_TTL_SECONDS + 5) * 1000 }), null);
  assert.equal(sealIntakeExtraction(EXTRACTION, "user-a", { secret: "" }), null);
  assert.equal(sealIntakeExtraction(EXTRACTION, "user-a", { secret: "short" }), null);
  assert.equal(unsealIntakeExtraction("x".repeat(50), "user-a", { secret: SECRET }), null);
});

await check("cesta v Storage: iba vlastný priečinok, bez traverzie", () => {
  const uid = "11111111-2222-4333-8444-555555555555";
  assert.equal(isOwnStoragePath(`${uid}/2026/scan.jpg`, uid), true);
  assert.equal(isOwnStoragePath(`99999999-2222-4333-8444-555555555555/scan.jpg`, uid), false);
  assert.equal(isOwnStoragePath(`${uid}/../other/scan.jpg`, uid), false);
  assert.equal(isOwnStoragePath(`${uid}//scan.jpg`, uid), false);
  assert.equal(isOwnStoragePath(`${uid}\\scan.jpg`, uid), false);
  assert.equal(isOwnStoragePath(`${uid}/scan <x>.jpg`, uid), false);
  assert.equal(isOwnStoragePath(42, uid), false);
});

await check("scan-document: bez finance_view vráti iba pečať, nie polia", () => {
  const route = readFileSync("app/api/scan-document/route.ts", "utf8");
  assert.ok(route.includes("esblu_my_finance_view"));
  assert.ok(route.includes("intakeOnly: true"));
  assert.ok(route.includes("sealedExtraction"));
});

await check("inbox/intake: odpoveď obsahuje iba „odoslané“, žiadny RETURNING", () => {
  const route = readFileSync("app/api/inbox/intake/route.ts", "utf8");
  assert.ok(!/\.select\(/.test(route), "intake nesmie čítať späť vložený riadok");
  const code = route.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!/service_role|SERVICE_ROLE|getServiceSupabase|supabaseAdmin/i.test(code), "intake nesmie používať service_role");
  assert.ok(code.includes("getUserScopedSupabaseClient"));
  assert.ok(route.includes("isOwnStoragePath"));
  const responses = route.match(/Response\.json\(\s*\{[^}]*\}/g) ?? [];
  for (const response of responses) {
    assert.ok(!/fields|extraction|amount|supplier/.test(response), response);
  }
});


// -----------------------------------------------------------------------------
// Zamestnanec: žiadny všeobecný asistent — iba príjem dokladu
// -----------------------------------------------------------------------------

/** Presne to, čo robí route: deterministický parser → brána pre obmedzené roly → bežná brána. */
function employeeDecision(text: string, ctx: AccessContext = ROLES.employee, module?: string) {
  const intent = parseIntentDeterministic(text, module ? { module: module as never } : {});
  const early = restrictedAssistantDenial(intent, ctx);
  if (early) return { intent, denial: early };
  return { intent, denial: intent ? checkIntentAccess(intent.name, intent.args, ctx) : null };
}

const EMPLOYEE_DENIED = [
  "Ukáž sklad.",
  "Koľko máme vrutov?",
  "Máme na sklade cement?",
  "Otvor stroj CAT 320.",
  "Ukáž vozidlá.",
  "Otvor vozidlo AB698CT.",
  "Ukáž faktúry.",
  "Ukáž bločky.",
  "Stiahni faktúry.",
  "Vytvor priečinok Test.",
  "Zmaž priečinok Test.",
  "Pridaj do skladu 20 vrutov",
  "Pridaj servis k stroju bager, výmena oleja",
  "Termíny tento mesiac",
  "Ukáž tento doklad",
  "Open vehicle AB698CT",
  "Zeige offene Rechnungen",
  "blabla nezmysel xyz",
];

await check("zamestnanec: všeobecné príkazy (sklad, stroje, vozidlá, financie, priečinky) → odmietnuté", () => {
  for (const text of EMPLOYEE_DENIED) {
    const { denial } = employeeDecision(text);
    assert.equal(denial, "assistant_scope", text);
  }
  // Aj s kontextom modulu (napr. zamestnanec v Sklade).
  assert.equal(employeeDecision("Vytvor novú položku", ROLES.employee, "inventory").denial, "assistant_scope");
  assert.equal(employeeDecision("Ukáž servis", ROLES.employee, "vehicles").denial, "assistant_scope");
});

await check("zamestnanec: „Ukáž faktúry“ — odmietnutie bez počtu a dát", () => {
  const { denial } = employeeDecision("Ukáž faktúry.");
  for (const locale of ["sk", "en", "de"] as const) {
    const text = translate(locale, denialMessageKey(denial!));
    assert.ok(!/\d/.test(text), `${locale}: číslo v odmietnutí`);
    assert.ok(!/faktúr\w* \d|EUR|€/.test(text));
  }
});

await check("zamestnanec: príjem dokladu (faktúra, bloček, dodací list) → povolený", () => {
  for (const [text, type] of [
    ["Nahraj faktúru", "invoice"],
    ["Pridaj bloček", "receipt"],
    ["Nahraj bloček", "receipt"],
    ["Pridaj dodací list", "delivery_note"],
    ["Upload receipt", "receipt"],
    ["Lieferschein hochladen", "delivery_note"],
  ] as const) {
    const { intent, denial } = employeeDecision(text);
    assert.equal(intent?.name, "DOCUMENT_INTAKE", text);
    assert.deepEqual(intent?.args.documentTypes, [type], text);
    assert.equal(denial, null, text);
  }
});

await check("zamestnanec: biely zoznam je jediný a obsahuje iba DOCUMENT_INTAKE", () => {
  assert.deepEqual([...EMPLOYEE_ASSISTANT_ALLOWLIST], ["DOCUMENT_INTAKE"]);
  const all = Object.keys(INTENT_REGISTRY) as IntentName[];
  const allowed = all.filter((name) => checkIntentAccess(name, {}, ROLES.employee) === null);
  assert.deepEqual(allowed, ["DOCUMENT_INTAKE"]);
  // Príjem s iným typom než finančný doklad neprejde.
  assert.equal(checkIntentAccess("DOCUMENT_INTAKE", { documentTypes: ["other"] } as never, ROLES.employee), "assistant_scope");
});

await check("zamestnanec: príjem vráti iba odkaz na Inbox — žiadny dotaz, žiadne dáta", async () => {
  const { db, queries } = fakeDb({ documents: [{ id: "d1", total_amount: 999 }] });
  const c = confirmations();
  const result = await handleOperationalIntent(db, "sk", intent("DOCUMENT_INTAKE", { documentTypes: ["invoice"] }), CTX, c.create) as { kind: string; text: string; entity?: { href: string } };
  assert.equal(result.kind, "answer");
  assert.equal(result.entity?.href, "/ai-evidencia");
  assert.equal(queries.length, 0);
  assert.equal(c.calls.length, 0);
  assert.ok(!/\d/.test(result.text));
});

await check("po odoslaní: bezpečné potvrdenie „Doklad bol odoslaný na spracovanie.“", () => {
  assert.equal(translate("sk", "assistant.intake.submitted"), "Doklad bol odoslaný na spracovanie.");
  const route = readFileSync("app/api/inbox/intake/route.ts", "utf8");
  const success = route.slice(route.lastIndexOf("return Response.json("));
  assert.ok(success.includes('"assistant.intake.submitted"'));
  assert.ok(!/fields|extraction|documentId|storagePath/.test(success.split("\n").slice(0, 4).join("\n")));
});

await check("zamestnanec s podvrhnutým permissions.finance → stále odmietnutý", () => {
  const forged: AccessContext = { role: "employee", financeView: true, financeManage: true, canOperate: true };
  for (const text of ["Ukáž faktúry.", "Stiahni faktúry.", "Vytvor priečinok Test.", "Ukáž bločky.", "Otvor stroj CAT 320."]) {
    assert.equal(employeeDecision(text, forged).denial, "assistant_scope", text);
  }
  for (const name of ["SEARCH_INVOICE", "DOCUMENTS_EXPORT", "FOLDER_CREATE", "CREATE_INVOICE_DRAFT", "SEARCH_DOCUMENTS"] as IntentName[]) {
    assert.equal(checkIntentAccess(name, {}, forged), "assistant_scope", name);
  }
});

await check("owner/admin/accountant: brána pre obmedzené roly ich nezasahuje", () => {
  for (const role of ["owner", "adminNoFinance", "adminFinance", "accountant"] as const) {
    assert.equal(restrictedAssistantDenial(null, ROLES[role]), null, role);
    assert.equal(employeeDecision("Ukáž faktúry.", ROLES[role]).denial === "assistant_scope", false, role);
  }
  assert.equal(employeeDecision("Otvor stroj CAT 320.", ROLES.owner).denial, null);
  assert.equal(employeeDecision("Otvor stroj CAT 320.", ROLES.accountant).denial, "operational");
  assert.equal(employeeDecision("Vytvor priečinok Test.", ROLES.adminNoFinance).denial, "finance");
  assert.equal(employeeDecision("Vytvor priečinok Test.", ROLES.accountant).denial, null);
});

await check("route: brána pre zamestnanca beží pred AI klasifikáciou a pred bránou modulov", () => {
  const route = readFileSync("app/api/assistant/intent/route.ts", "utf8");
  const early = route.indexOf("restrictedAssistantDenial(intent");
  assert.ok(early > 0);
  assert.ok(early < route.indexOf("classifyIntentWithAi(rawText)"), "pred AI");
  assert.ok(early < route.indexOf('intent.name === "ENTITY_CREATE"'), "pred otázkou na modul");
  assert.ok(early < route.indexOf("checkIntentAccess(intent.name"), "pred bránou modulov");
});

// -----------------------------------------------------------------------------
// i18n: každý assistant.* kľúč z kódu existuje v SK/EN/DE
// -----------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

await check("i18n: assistant.* a folders.intent.delete* kľúče preložené vo všetkých jazykoch", () => {
  const keys = new Set<string>();
  for (const file of [...walk("app"), ...walk("lib")]) {
    if (file.includes(`${path.sep}dictionaries${path.sep}`)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["'`]((?:assistant\.[a-zA-Z]+|folders\.intent\.delete[a-zA-Z]*)(?:\.[a-zA-Z]+)*)["'`]/g)) {
      keys.add(match[1]);
    }
  }
  assert.ok(keys.size > 30, `málo kľúčov: ${keys.size}`);
  // EN/DE majú `satisfies typeof sk` — chýbajúci kľúč zastaví tsc; tu sa
  // overuje, že kľúč existuje v zdrojovom SK slovníku.
  for (const key of keys) {
    for (const locale of ["sk", "en", "de"] as const) {
      assert.notEqual(translate(locale, key), key, `${locale}: ${key}`);
    }
  }
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
