// =============================================================================
// Dashboard „Dnes" + Prvé kroky + prázdne stavy (2026-10-22).
//
// SPUSTENIE
//   npm run test:dashboard-today
//
// Pokrýva čistú agregáciu (lib/dashboard/today.ts), rolové hranice,
// závažnosti a poradie, prvé kroky, preklady všetkých generovaných kľúčov
// (sk/en/de), overenie, že navrhované otázky asistenta naozaj rozpozná
// deterministický parser, a zdrojové kontrakty Dashboardu (aktívna firma,
// žiadne meranie, billing iba vlastník).
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const today = await import("@/lib/dashboard/today");
const { parseIntentDeterministic } = await import("@/lib/intents/parse");
const { dictionaries } = await import("@/lib/i18n/dictionaries/index");

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
const read = (path: string) => readFileSync(path, "utf8");

const TODAY = "2026-10-22";
const ALL = { financeView: true, operational: true, billingOwner: true };

function invoice(over: Record<string, unknown>) {
  return {
    id: "i1",
    kind: "regular_invoice",
    direction: "issued",
    document_status: "finalized",
    payment_status: "unpaid",
    total_amount: 100,
    currency: "EUR",
    due_date: TODAY,
    corrects_invoice_id: null,
    invoice_number: "FA001",
    supplier_invoice_number: null,
    source: "manual",
    ...over,
  } as never;
}

function lookup(locale: string, key: string): unknown {
  let node: unknown = (dictionaries as Record<string, unknown>)[locale];
  for (const part of key.split(".")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  return node;
}

console.log("dashboard-today");

await check("faktúra po splatnosti → URGENT s akciou na detail", () => {
  const items = today.buildTodayItems({ access: ALL, today: TODAY, invoices: [invoice({ due_date: "2026-10-10" })] });
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "urgent");
  assert.equal(items[0].titleKey, "today.items.issuedOverdue");
  assert.equal(items[0].vars.days, 12);
  assert.equal(items[0].href, "/faktury/i1");
  assert.equal(items[0].ctaKey, "today.cta.checkPayment");
});

await check("splatná dnes → DNES, o 5 dní → ČOSKORO, o 20 dní → nič", () => {
  const items = today.buildTodayItems({
    access: ALL,
    today: TODAY,
    invoices: [invoice({ id: "a" }), invoice({ id: "b", due_date: "2026-10-27" }), invoice({ id: "c", due_date: "2026-11-11" })],
  });
  assert.deepEqual(items.map((i) => [i.id, i.severity]), [["invoice:a", "today"], ["invoice:b", "soon"]]);
});

await check("uhradená, preplatená, dobropis a plne dobropisovaná faktúra sa nezobrazí", () => {
  const items = today.buildTodayItems({
    access: ALL,
    today: TODAY,
    invoices: [
      invoice({ id: "paid", payment_status: "paid", due_date: "2026-10-01" }),
      invoice({ id: "over", payment_status: "overpaid", due_date: "2026-10-01" }),
      invoice({ id: "cn", kind: "credit_note", due_date: "2026-10-01" }),
      invoice({ id: "full", due_date: "2026-10-01", total_amount: 50 }),
      invoice({ id: "cn2", kind: "credit_note", corrects_invoice_id: "full", total_amount: 50, due_date: null }),
    ],
  });
  assert.deepEqual(items, []);
});

await check("prijatá faktúra: koncept → kontrola, eFaktúra má vlastný text, záväzok → „Označiť úhradu“", () => {
  const items = today.buildTodayItems({
    access: ALL,
    today: TODAY,
    invoices: [
      invoice({ id: "r1", direction: "received", document_status: "draft", supplier_invoice_number: "D-9", invoice_number: null }),
      invoice({ id: "r2", direction: "received", document_status: "draft", source: "efaktura_peppol" }),
      invoice({ id: "r3", direction: "received", due_date: "2026-10-24" }),
    ],
  });
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId["received-draft:r1"].titleKey, "today.items.receivedReview");
  assert.equal(byId["received-draft:r1"].vars.number, "D-9");
  assert.equal(byId["received-draft:r2"].titleKey, "today.items.einvoiceReview");
  assert.equal(byId["invoice:r3"].ctaKey, "today.cta.payInvoice");
});

await check("rozpracované vydané faktúry → jedna INFO položka s odkazom na koncepty", () => {
  const items = today.buildTodayItems({
    access: ALL,
    today: TODAY,
    invoices: [invoice({ id: "d1", document_status: "draft" }), invoice({ id: "d2", document_status: "draft" })],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "info");
  assert.equal(items[0].vars.count, 2);
  assert.equal(items[0].href, "/faktury?section=drafts");
});

await check("STK po termíne → URGENT, EK o 10 dní → ČOSKORO, servis stroja o 25 dní → INFO", () => {
  const items = today.buildTodayItems({
    access: ALL,
    today: TODAY,
    vehicles: [{ id: "v1", spz: "BA123AB", znacka: "Škoda", model: "Octavia", stk: "2026-10-01", ek: "2026-11-01" }],
    machines: [{ id: "m1", name: "Bager", category: null }],
    machineServices: [{ machine_id: "m1", service_date: "2026-01-01", next_service_date: "2026-11-16" }],
  });
  const map = Object.fromEntries(items.map((i) => [i.titleKey, i.severity]));
  assert.equal(map["today.items.stkOverdue"], "urgent");
  assert.equal(map["today.items.ekSoon"], "soon");
  const machine = items.find((i) => i.category === "machine");
  assert.equal(machine?.severity, "info");
  assert.equal(machine?.ctaKey, "today.cta.openMachine");
});

await check("sklad: vypredané → DNES, pod minimom → ČOSKORO, bez minima → nič", () => {
  const base = { category: null, location: null, notes: null, created_at: "", company_id: "c" };
  const items = today.buildTodayItems({
    access: ALL,
    today: TODAY,
    inventory: [
      { ...base, id: "s1", name: "Káble", quantity: 0, unit: "m", min_quantity: 10 },
      { ...base, id: "s2", name: "Skrutky", quantity: 3, unit: "ks", min_quantity: 5 },
      { ...base, id: "s3", name: "Farba", quantity: 1, unit: "l", min_quantity: null },
    ],
  });
  assert.deepEqual(items.map((i) => [i.id, i.severity]), [["stock:s1", "today"], ["stock:s2", "soon"]]);
  assert.ok(items.every((i) => i.ctaKey === "today.cta.restock"));
});

await check("rola: bez financií žiadne faktúry; bez prevádzky žiadne termíny ani sklad; billing iba vlastník", () => {
  const input = {
    today: TODAY,
    invoices: [invoice({ due_date: "2026-10-01" })],
    vehicles: [{ id: "v1", spz: "X", znacka: null, model: null, stk: "2026-10-01", ek: null }],
    inventory: [{ id: "s1", name: "A", quantity: 0, unit: "ks", min_quantity: 1, category: null, location: null, notes: null, created_at: "", company_id: "c" }],
    trialActive: true,
    trialEndsAt: "2026-10-24",
  };
  const employee = today.buildTodayItems({ ...input, access: { financeView: false, operational: true, billingOwner: false } });
  assert.ok(employee.every((i) => i.category !== "invoice" && i.category !== "received" && i.category !== "billing"));
  assert.ok(employee.some((i) => i.category === "vehicle"));
  const accountant = today.buildTodayItems({ ...input, access: { financeView: true, operational: false, billingOwner: false } });
  assert.ok(accountant.every((i) => i.category !== "vehicle" && i.category !== "inventory" && i.category !== "billing"));
  assert.ok(accountant.some((i) => i.category === "invoice"));
  const admin = today.buildTodayItems({ ...input, access: { financeView: true, operational: true, billingOwner: false } });
  assert.ok(!admin.some((i) => i.category === "billing"), "admin nemá billing autoritu");
  const owner = today.buildTodayItems({ ...input, access: ALL });
  const trial = owner.find((i) => i.category === "billing");
  assert.equal(trial?.href, "/nastavenia/predplatne");
  assert.equal(trial?.vars.days, 2);
});

await check("poradie: URGENT → DNES → ČOSKORO → INFO, v rámci závažnosti podľa dní", () => {
  const items = today.buildTodayItems({
    access: ALL,
    today: TODAY,
    invoices: [invoice({ id: "s", due_date: "2026-10-25" }), invoice({ id: "u2", due_date: "2026-10-20" }), invoice({ id: "u1", due_date: "2026-10-01" }), invoice({ id: "t" })],
    inboxUnassigned: 3,
    unreadChat: 2,
  });
  assert.deepEqual(items.map((i) => i.severity), ["urgent", "urgent", "today", "soon", "info", "info"]);
  assert.equal(items[0].id, "invoice:u1", "najstaršia po splatnosti prvá");
  assert.deepEqual(today.countBySeverity(items), { urgent: 2, today: 1, soon: 1, info: 2 });
});

await check("prvé kroky: iba vlastník/správca; povinné kroky riadia zobrazenie, pozvánka je voliteľná", () => {
  assert.deepEqual(today.buildFirstSteps({ role: "employee", profileComplete: null, recordCount: 0, teamCount: null }), []);
  assert.deepEqual(today.buildFirstSteps({ role: "accountant", profileComplete: true, recordCount: 0, teamCount: 0 }), []);
  const fresh = today.buildFirstSteps({ role: "owner", profileComplete: false, recordCount: 0, teamCount: 0 });
  assert.deepEqual(fresh.map((s) => s.key), ["company", "profile", "firstRecord", "invite"]);
  assert.ok(today.firstStepsPending(fresh));
  const done = today.buildFirstSteps({ role: "owner", profileComplete: true, recordCount: 1, teamCount: 0 });
  assert.ok(!today.firstStepsPending(done), "chýbajúca pozvánka nedrží zoznam otvorený");
  const adminNoFinance = today.buildFirstSteps({ role: "admin", profileComplete: null, recordCount: 0, teamCount: 2 });
  assert.ok(!adminNoFinance.some((s) => s.key === "profile"), "bez prístupu k fakturačným údajom sa krok nezobrazí");
  assert.equal(today.isBillingProfileComplete({ legal_name: "A s.r.o.", ico: "123", address_line1: "Ulica 1", city: "BA" }), true);
  assert.equal(today.isBillingProfileComplete({ legal_name: "A s.r.o.", ico: " ", address_line1: "Ulica 1", city: "BA" }), false);
  assert.equal(today.isBillingProfileComplete(null), false);
});

await check("každý generovaný i18n kľúč existuje v sk/en/de (bez fallbacku)", () => {
  const p = read("lib/dashboard/today.ts");
  const keys = new Set<string>([...p.matchAll(/"(today\.(?:items|cta)\.[A-Za-z]+)"/g)].map((m) => m[1]));
  for (const kind of ["stk", "ek", "vignette", "vehicleService", "machineService"]) {
    for (const state of ["Overdue", "Today", "Soon"]) keys.add(`today.items.${kind}${state}`);
  }
  const panel = read("app/components/dashboard/TodayPanel.tsx");
  for (const m of panel.matchAll(/t\("(today\.[A-Za-z.]+)"/g)) keys.add(m[1]);
  for (const sev of today.TODAY_SEVERITY_ORDER) keys.add(`today.severity.${sev}`);
  for (const step of ["company", "profile", "firstRecord", "invite"]) keys.add(`today.firstSteps.steps.${step}`);
  for (const a of ["profile", "vehicle", "machine", "invoice", "partner", "invite"]) keys.add(`today.firstSteps.actions.${a}`);
  for (const g of ["documents", "finance", "operations"]) keys.add(`nav.groups.${g}`);
  for (const e of ["vehicles", "machines", "inventory", "invoices", "partners", "folders"]) {
    keys.add(`emptyStates.${e}.title`);
    keys.add(`emptyStates.${e}.body`);
  }
  keys.add("dashboard.cylinder.ownerActivates");
  keys.add("dashboard.cylinder.ownerActivatesHint");
  assert.ok(keys.size > 60, `málo kľúčov (${keys.size})`);
  for (const locale of ["sk", "en", "de"]) {
    for (const key of keys) assert.equal(typeof lookup(locale, key), "string", `${locale}: chýba ${key}`);
  }
});

await check("navrhované otázky asistenta naozaj rozpozná parser (sk/en/de) — žiadny sľub navyše", () => {
  const expected: Record<string, string> = {
    overdue: "SHOW_INVOICES_BY_STATUS",
    deadlines: "UPCOMING_DEADLINES",
    lowStock: "SHOW_LOW_STOCK",
    unassigned: "INBOX_LIST_UNASSIGNED",
  };
  for (const locale of ["sk", "en", "de"]) {
    for (const [key, intent] of Object.entries(expected)) {
      const text = lookup(locale, `today.ask.${key}`) as string;
      assert.equal(parseIntentDeterministic(text)?.name, intent, `${locale}: „${text}“`);
    }
  }
});

await check("Dashboard: „Dnes“ v oboch variantoch, dáta iba aktívnej firmy, nič navonok", () => {
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes('<TodayPanel variant="compact" {...todayPanelProps} />'));
  assert.ok(dash.includes('<TodayPanel variant="full" {...todayPanelProps} />'));
  const load = dash.slice(dash.indexOf("async function loadToday("), dash.indexOf("function dismissFirstSteps("));
  assert.ok(load.length > 200);
  for (const table of ["invoices", "business_partners", "vehicle_services", "machine_services", "documents"]) {
    const at = load.indexOf(`from("${table}")`);
    assert.ok(at > 0, `${table} sa načítava`);
    assert.ok(load.slice(at, at + 400).includes('.eq("company_id", companyId)'), `${table} je obmedzené na aktívnu firmu`);
  }
  assert.ok(load.includes("const companyId = current.company_id;"));
  for (const src of [dash, read("app/components/dashboard/TodayPanel.tsx"), read("lib/dashboard/today.ts")]) {
    assert.ok(!/gtag|analytics|posthog|mixpanel|segment\.|sentry|fetch\("http/i.test(src), "žiadne meranie ani externé volanie");
  }
});

await check("billing autorita: výzva na aktiváciu iba vlastníkovi, ostatným vysvetlenie", () => {
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes('const isOwner = role === "owner";'));
  assert.ok(dash.includes('voiceGateNotice === "locked" && isOwner &&'));
  assert.ok(dash.includes('t("dashboard.cylinder.ownerActivates")'));
  assert.ok(dash.includes("if (isOwner) router.push(\"/kontakt\");"));
  assert.ok(dash.includes("billingOwner: isOwner"));
});

await check("multi-company: prepínač firmy je na nástenke (sidebar aj mobilné menu webu)", () => {
  const dash = read("app/components/Dashboard.tsx");
  assert.equal((dash.match(/<CompanySwitcher className="mt-4" \/>/g) ?? []).length, 2);
});

await check("prázdne stavy: modul hovorí čo robí a čo spraviť ako prvé", () => {
  assert.ok(read("app/vozidla/page.tsx").includes('title={t("emptyStates.vehicles.title")}'));
  assert.ok(read("app/stroje/page.tsx").includes('title={t("emptyStates.machines.title")}'));
  assert.ok(read("app/sklad/page.tsx").includes('title={t("emptyStates.inventory.title")}'));
  assert.ok(read("app/faktury/page.tsx").includes('title={t("emptyStates.invoices.title")}'));
  assert.ok(read("app/obchodni-partneri/page.tsx").includes('t("emptyStates.partners.title")'));
  assert.ok(read("app/priecinky/page.tsx").includes('title={t("emptyStates.folders.title")}'));
  assert.ok(read("app/components/ui/Primitives.tsx").includes("description?: ReactNode;"));
});

console.log(`\ndashboard-today: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
