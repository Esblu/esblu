// =============================================================================
// Uzavretá beta — P0 hardening (2026-09-26). Regresné testy P0-1 … P0-10.
//
// SPUSTENIE
//   npm run test:closed-beta-p0
//
// Čisto lokálne: syntetické dáta, pamäťová DB, statická kontrola migrácie.
// Žiadne produkčné dáta ani sieť.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "cd".repeat(32);
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import { makeDb, COMPANY_A, type Role, type Row } from "./support/memory-db.ts";

const cn = await import("@/lib/invoicing/credit-note-semantics");
const { visibleInvoices } = await import("@/lib/invoicing/invoice-register-filters");
const { saveInvoiceDraft } = await import("@/lib/invoices");
const { sanitizeRegistrationScan, mergeRegistrationIntoVehicle, cleanDate } = await import("@/lib/vehicle-registration-merge");
const { pendingInviteTokenFromMetadata, inviteReturnPath, isPendingInviteError } = await import("@/lib/auth/invite-return");
const { removeDocumentFromActiveView, isRetainedDocumentType } = await import("@/lib/document-retention");
const { parseIntentDeterministic } = await import("@/lib/intents/parse");
const { runAssistantTurnDetailed } = await import("@/lib/intents/orchestrator");
const { translate } = await import("@/lib/i18n/translate");

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

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const MIGRATION = read("supabase/migrations/20260929100000_closed_beta_p0_hardening.sql");

/** Telo SQL funkcie z migrácie (od create … po jej $$ koniec). */
function fnBody(name: string): string {
  const start = MIGRATION.search(new RegExp(`create or replace function public\\.${name}\\s*\\(`, "i"));
  assert.ok(start >= 0, `funkcia ${name} v migrácii chýba`);
  const rest = MIGRATION.slice(start);
  const tag = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(rest);
  assert.ok(tag, `${name}: chýba dollar-quote`);
  const open = tag.index + tag[0].length;
  const close = rest.indexOf(tag[1], open);
  assert.ok(close > open, `${name}: neukončené telo`);
  return rest.slice(0, close + tag[1].length);
}

// =============================================================================
// P0-3 — dobropis: znamienko, zostatok, register
// =============================================================================

type Doc = import("@/lib/invoicing/credit-note-semantics").SettlementDocument & { direction: string; payment_status: string };
const inv = (id: string, total: number, extra: Partial<Doc> = {}): Doc => ({
  id, kind: "regular_invoice", direction: "issued", document_status: "finalized", payment_status: "unpaid", total_amount: total, due_date: "2026-09-01", ...extra,
});
const credit = (id: string, corrects: string, total: number, extra: Partial<Doc> = {}): Doc =>
  inv(id, total, { kind: "credit_note", corrects_invoice_id: corrects, ...extra });

await check("P0-3: faktúra 100 + dobropis 20 → zostáva 80, stále otvorená", () => {
  const docs = [inv("F1", 100), credit("C1", "F1", 20)];
  const credited = cn.creditedTotals(docs);
  assert.equal(cn.remainingAfterCredits(docs[0], credited), 80);
  assert.equal(cn.isFullyCredited(docs[0], credited), false);
  assert.equal(cn.isOpenReceivable(docs[0], credited), true);
  assert.equal(cn.netDocumentTotal(docs), 80);
  assert.equal(cn.openReceivableTotal(docs), 80);
});

await check("P0-3: plný dobropis → 0, nie je otvorená ani po splatnosti", () => {
  const docs = [inv("F1", 100), credit("C1", "F1", 100)];
  const credited = cn.creditedTotals(docs);
  assert.equal(cn.remainingAfterCredits(docs[0], credited), 0);
  assert.equal(cn.isFullyCredited(docs[0], credited), true);
  assert.equal(cn.isOpenReceivable(docs[0], credited), false);
  assert.equal(cn.isEffectivelyOverdue(docs[0], credited, "2026-09-26"), false);
  assert.equal(cn.openReceivableTotal(docs), 0);
  assert.equal(cn.netDocumentTotal(docs), 0);
});

await check("P0-3: viac dobropisov sa sčíta; koncept dobropisu nič neznižuje", () => {
  const docs = [inv("F1", 100), credit("C1", "F1", 30), credit("C2", "F1", 45), credit("C3", "F1", 25, { document_status: "draft" })];
  const credited = cn.creditedTotals(docs);
  assert.equal(credited.get("F1"), 75);
  assert.equal(cn.remainingAfterCredits(docs[0], credited), 25);
  assert.equal(cn.netDocumentTotal(docs), 25);
});

await check("P0-3: dobropis nie je pohľadávka, znamienko −1 aj pre základ/DPH/spolu", () => {
  const c = credit("C1", "F1", 123);
  assert.equal(cn.isReceivableDocument(c), false);
  assert.equal(cn.isOpenReceivable(c, new Map()), false);
  assert.equal(cn.documentSign("credit_note"), -1);
  assert.equal(cn.documentSign("regular_invoice"), 1);
  // 100 základ + 23 DPH = 123 spolu → všetko záporné
  assert.deepEqual([100, 23, 123].map((v) => cn.signedAmount("credit_note", v)), [-100, -23, -123]);
  assert.equal(cn.signedAmount("regular_invoice", "50.5"), 50.5);
});

await check("P0-3: register — dobropis ani plne dobropisovaná faktúra nie sú v Neuhradené/Po splatnosti/Uhradené", () => {
  const docs = [inv("F1", 100), credit("C1", "F1", 100, { payment_status: "paid" }), inv("F2", 50), inv("F3", 70, { payment_status: "paid" })];
  const credited = cn.creditedTotals(docs);
  const fully = (d: Doc) => cn.isFullyCredited(d, credited);
  const overdue = (d: Doc) => cn.isEffectivelyOverdue(d, credited, "2026-09-26");
  const ids = (s: Parameters<typeof visibleInvoices>[1]) => visibleInvoices(docs, s, "all", overdue, fully).map((d) => d.id);
  assert.deepEqual(ids("unpaid"), ["F2"]);
  assert.deepEqual(ids("overdue"), ["F2"]);
  assert.deepEqual(ids("paid"), ["F3"]);
  assert.deepEqual(ids("corrections"), ["C1"]);
  assert.deepEqual(ids("all"), ["F1", "C1", "F2", "F3"]);
});

await check("P0-3: export pre účtovníka, manifest, PDF a asistent používajú znamienko", () => {
  const exportSrc = read("lib/invoicing/export-accounting-handoff.ts");
  assert.match(exportSrc, /documentSign/);
  assert.match(exportSrc, /handoff\.col\.kind/);
  assert.match(read("lib/invoicing/handoff-package.ts"), /accounting_sign/);
  assert.match(read("app/api/accounting-handoff/package/route.ts"), /accounting_sign/);
  assert.match(read("lib/invoicing/pdf-renderer.tsx"), /creditTotalLabel/);
  assert.match(read("lib/intents/handlers-navigation-finance.ts"), /isOpenReceivable/);
});

// =============================================================================
// P0-4 — atomické uloženie konceptu
// =============================================================================

const draftEnv = () => {
  const env = makeDb({
    role: "owner", financeManage: true,
    tables: {
      invoices: [{ id: "D1", company_id: COMPANY_A, document_status: "draft", kind: "regular_invoice", direction: "issued", updated_at: "2026-09-26T10:00:00.000Z" }],
      invoice_items: [{ id: "L1", company_id: COMPANY_A, invoice_id: "D1", description: "Pôvodný riadok", quantity: 1, unit_price: 10, vat_category_code: "S", vat_rate: 23 }],
    },
  });
  return env;
};
const line = (description: string, quantity: number, unit_price: number) => ({
  description, quantity, unit: "ks", unit_price, price_mode: "net" as const, vat_category_code: "S", vat_rate: 23,
});

await check("P0-4: vynútené zlyhanie uloženia → pôvodné riadky ostanú (žiadne delete-then-insert)", async () => {
  const env = draftEnv();
  env.state.failNextDraftSave = true;
  await assert.rejects(() => saveInvoiceDraft("D1", { issue_date: "2026-09-26" }, [line("Nový", 2, 5)] as never, null, env.db));
  const lines = env.state.tables.invoice_items.filter((r) => r.invoice_id === "D1");
  assert.deepEqual(lines.map((r) => r.description), ["Pôvodný riadok"]);
});

await check("P0-4: neplatný riadok → nič sa nezmení (validácia pred zápisom)", async () => {
  const env = draftEnv();
  await assert.rejects(() => saveInvoiceDraft("D1", {}, [line("OK", 1, 5), line("Zlý", 0, 5)] as never, null, env.db));
  assert.deepEqual(env.state.tables.invoice_items.map((r) => r.description), ["Pôvodný riadok"]);
});

await check("P0-4: úspech nahradí riadky; zastaraný updated_at → ESBLU_DRAFT_STALE bez zmeny", async () => {
  const env = draftEnv();
  const saved = await saveInvoiceDraft("D1", {}, [line("A", 1, 5), line("B", 2, 7)] as never, "2026-09-26T10:00:00.000Z", env.db);
  assert.deepEqual(env.state.tables.invoice_items.map((r) => r.description), ["A", "B"]);
  assert.notEqual(saved.updated_at, "2026-09-26T10:00:00.000Z");
  await assert.rejects(
    () => saveInvoiceDraft("D1", {}, [line("C", 1, 1)] as never, "2026-09-26T10:00:00.000Z", env.db),
    (e: unknown) => String((e as { message?: string }).message).includes("ESBLU_DRAFT_STALE")
  );
  assert.deepEqual(env.state.tables.invoice_items.map((r) => r.description), ["A", "B"]);
});

await check("P0-4: smer, druh ani opravovaný doklad sa cez uloženie konceptu nemenia", async () => {
  const env = draftEnv();
  await saveInvoiceDraft("D1", { direction: "received", kind: "credit_note", corrects_invoice_id: "X" } as never, [line("A", 1, 1)] as never, null, env.db);
  const row = env.state.tables.invoices[0];
  assert.equal(row.direction, "issued");
  assert.equal(row.kind, "regular_invoice");
  assert.equal(row.corrects_invoice_id, undefined);
});

await check("P0-4: SQL RPC je SECURITY INVOKER, zamyká riadok, kontroluje draft a stale", () => {
  const body = fnBody("esblu_save_invoice_draft");
  assert.match(body, /security invoker/i);
  assert.doesNotMatch(body, /security definer/i);
  assert.match(body, /for update/i);
  assert.match(body, /ESBLU_DRAFT_STALE/);
  assert.match(body, /document_status\s*<>\s*'draft'|document_status\s*!=\s*'draft'/i);
  assert.doesNotMatch(read("lib/invoices.ts"), /replaceDraftInvoiceItems|updateDraftInvoiceHeader/);
});

// =============================================================================
// P0-5 — sken technického preukazu: čiastočné zlúčenie
// =============================================================================

await check("P0-5: prázdne/šumové polia skenu neprepíšu existujúce hodnoty, user_id sa nemení", () => {
  const existing = { id: "v1", user_id: "creator", company_id: COMPANY_A, spz: "BA123AB", vin: "WVWZZZ1JZXW000001", znacka: "VW", model: "Golf", farba: "modrá", rok_vyroby: 2015, stk: "2027-01-01" };
  const sanitized = sanitizeRegistrationScan({ spz: "", vin: "—", znacka: "Škoda", model: null, farba: "n/a", rokVyroby: "3050", objemMotora: "1 598 cm3" }, 2026);
  assert.deepEqual(sanitized, { znacka: "Škoda", objem: "1598" });
  const merged = mergeRegistrationIntoVehicle(existing, sanitized);
  assert.equal(merged.user_id, "creator");
  assert.equal(merged.spz, "BA123AB");
  assert.equal(merged.vin, "WVWZZZ1JZXW000001");
  assert.equal(merged.model, "Golf");
  assert.equal(merged.farba, "modrá");
  assert.equal(merged.rok_vyroby, 2015);
  assert.equal(merged.stk, "2027-01-01");
  assert.equal(merged.znacka, "Škoda");
  assert.equal((merged as Row).objem, 1598);
});

await check("P0-5: validácia VIN, dátumu a rozsahov", () => {
  assert.equal(sanitizeRegistrationScan({ vin: "wvw zzz 1jz xw 000001" }).vin, "WVWZZZ1JZXW000001");
  assert.equal(sanitizeRegistrationScan({ vin: "IOQ12345678" }).vin, undefined);
  assert.equal(cleanDate("14.03.2019"), "2019-03-14");
  assert.equal(cleanDate("2019-02-30"), undefined);
  assert.equal(cleanDate("neznáme"), undefined);
  assert.equal(sanitizeRegistrationScan({ pocetMiest: "0" }).pocet_miest, undefined);
  assert.equal(sanitizeRegistrationScan({ rokVyroby: "2027" }, 2026).rok_vyroby, "2027");
  assert.equal(sanitizeRegistrationScan({ rokVyroby: "2028" }, 2026).rok_vyroby, undefined);
});

await check("P0-5: SQL RPC coalesce, INVOKER, nemení user_id; UI volá RPC", () => {
  const body = fnBody("esblu_apply_vehicle_registration");
  assert.match(body, /security invoker/i);
  assert.match(body, /coalesce/i);
  assert.doesNotMatch(body, /user_id\s*=/i);
  const page = read("app/vozidla/page.tsx");
  assert.match(page, /esblu_apply_vehicle_registration/);
  assert.match(page, /sanitizeRegistrationScan/);
});

// =============================================================================
// P0-2 — návrat pozvaného po overení e-mailu
// =============================================================================

const TOKEN = "ab".repeat(32);
await check("P0-2: token pozvánky iba v presnom tvare, pevná relatívna cesta (bez open redirectu)", () => {
  assert.equal(pendingInviteTokenFromMetadata({ esblu_invite_token: TOKEN }), TOKEN);
  assert.equal(pendingInviteTokenFromMetadata({ esblu_invite_token: TOKEN.toUpperCase() }), TOKEN);
  for (const bad of ["https://evil.example/x", "//evil.example", `${TOKEN}/../x`, "ab".repeat(31), `${TOKEN}?next=//evil`, 42, null]) {
    assert.equal(pendingInviteTokenFromMetadata({ esblu_invite_token: bad }), null, String(bad));
  }
  assert.equal(pendingInviteTokenFromMetadata(null), null);
  assert.equal(inviteReturnPath(TOKEN, false), `/invite/${TOKEN}`);
  assert.equal(inviteReturnPath(TOKEN, true), `/invite?token=${TOKEN}`);
  assert.equal(inviteReturnPath("//evil.example", false), null);
  assert.equal(isPendingInviteError({ message: "ESBLU_PENDING_INVITE_EXISTS" }), true);
  assert.equal(isPendingInviteError(new Error("other")), false);
});

await check("P0-2: callback a onboarding čítajú token z overeného používateľa; server blokuje vlastnú firmu", () => {
  const callback = read("app/auth/callback/page.tsx");
  assert.match(callback, /pendingInviteTokenFromMetadata/);
  assert.match(callback, /getUser/);
  assert.match(read("app/onboarding/company/page.tsx"), /pendingInviteTokenFromMetadata|isPendingInviteError/);
  const ensure = fnBody("esblu_ensure_my_owner_company");
  assert.match(ensure, /ESBLU_PENDING_INVITE_EXISTS/);
  assert.match(ensure, /set search_path\s*(=|to)\s*''/i);
});

// =============================================================================
// P0-1, P0-6, P0-9 a oprávnenia — statická kontrola migrácie
// =============================================================================

await check("P0-1: účtovníka pozýva iba owner (vytvorenie aj prijatie pozvánky)", () => {
  const create = fnBody("esblu_create_company_invite");
  assert.match(create, /v_role\s*=\s*'accountant'\s+and\s+v_caller_role\s*<>\s*'owner'/i);
  assert.match(create, /ESBLU_INVITE_ROLE_NOT_PERMITTED/);
  const accept = fnBody("esblu_accept_company_invite");
  assert.match(accept, /accountant/);
  assert.match(accept, /invited_by/);
  assert.match(accept, /ESBLU_INVITE_ROLE_NOT_PERMITTED/);
  const settings = read("app/nastavenia/page.tsx");
  assert.match(settings, /accountant/);
});

await check("Migrácia: SECURITY DEFINER funkcie majú search_path='' a nie sú pre anon", () => {
  const defs = [...MIGRATION.matchAll(/create or replace function public\.(\w+)\s*\(/gi)].map((m) => m[1]);
  assert.ok(defs.length >= 6);
  for (const name of defs) {
    const body = fnBody(name);
    if (/security definer/i.test(body)) assert.match(body, /set search_path\s*(=|to)\s*''/i, name);
  }
  assert.doesNotMatch(MIGRATION, /grant\s+execute[^;]*\bto\s+[^;]*\banon\b/i);
  assert.doesNotMatch(MIGRATION, /grant[^;]*\bto\s+public\b/i);
  assert.doesNotMatch(MIGRATION, /disable row level security/i);
});

await check("P0-9: operátorský grant tímu je iba pre service_role, limit 1..50, zdroj manual", () => {
  const body = fnBody("esblu_operator_grant_team_allowance");
  assert.match(body, /team_members/);
  assert.match(body, /'manual'/);
  assert.match(MIGRATION, /revoke all on function public\.esblu_operator_grant_team_allowance[^;]*from public/i);
  assert.match(MIGRATION, /grant execute on function public\.esblu_operator_grant_team_allowance[^;]*to service_role/i);
  assert.doesNotMatch(MIGRATION, /grant execute on function public\.esblu_operator_grant_team_allowance[^;]*authenticated/i);
});

await check("P0-6: triggre retencie účtovných dokladov a dodacích listov", () => {
  assert.match(MIGRATION, /esblu_retain_finance_documents/);
  assert.match(MIGRATION, /before delete on public\.documents/i);
  assert.match(MIGRATION, /esblu_retain_delivery_notes/);
  assert.match(MIGRATION, /before delete on public\.ai_evidence/i);
  assert.match(MIGRATION, /ESBLU_FINANCE_DOCUMENT_RETAINED/);
  assert.match(MIGRATION, /alter table public\.ai_evidence add column if not exists deleted_at/i);
});

await check("Rozhodnutie 2: IBAN/BIC mení iba owner (trigger + UI)", () => {
  assert.match(MIGRATION, /esblu_guard_company_bank_details/);
  assert.match(MIGRATION, /ESBLU_BANK_DETAILS_OWNER_ONLY/);
  assert.match(MIGRATION, /esblu_guard_issued_invoice_iban/);
  assert.match(read("app/nastavenia/page.tsx"), /bankDetailsOwnerOnly/);
});

await check("P0 review: vydaná faktúra ne-ownera smie niesť IBAN firmy (nie „iba owner“), podvrh účtu zamietnutý", () => {
  const body = fnBody("esblu_guard_issued_invoice_iban");
  // IBAN sa porovná s nakonfigurovaným účtom AKTÍVNEJ firmy
  assert.match(body, /from public\.company_billing_profile p/);
  assert.match(body, /esblu_my_active_company_id\(\)/);
  assert.match(body, /ESBLU_INVOICE_IBAN_NOT_COMPANY_ACCOUNT/);
  // pôvodné pravidlo „INSERT s IBAN = iba owner" je preč
  assert.doesNotMatch(body, /tg_op = 'INSERT' and new\.iban is not null/);
  assert.doesNotMatch(body, /ESBLU_BANK_DETAILS_OWNER_ONLY/);
  // sleduje aj prepnutie smeru a firmy
  assert.match(MIGRATION, /before insert or update of iban, direction, company_id on public\.invoices/i);
  // behaviorálne pokrytie A–H: scripts/p0-bank-details-sql-tests.ts (PGlite)
});

await check("Rozhodnutie 1: kmeňové dáta strojov mení iba owner/admin (RLS + UI)", () => {
  for (const table of ["machines", "machine_services", "machine_photos"]) {
    for (const op of ["insert", "update", "delete"]) {
      assert.match(MIGRATION, new RegExp(`create policy "?${table}_${op}_manager"?\\s+on public\\.${table}`, "i"), `${table} ${op}`);
    }
  }
  assert.match(MIGRATION, /esblu_my_active_role\(\)\s+in\s+\('owner',\s*'admin'\)/i);
  assert.match(read("app/stroje/page.tsx"), /canManageMachines/);
  assert.match(read("app/stroje/MachineDetailView.tsx"), /canManageMachine/);
});

// =============================================================================
// P0-6 — odstránenie dokumentu (pamäťová DB)
// =============================================================================

const docRow = (id: string, document_type: string): Row => ({
  id, document_type, company_id: COMPANY_A, deleted_at: null, storage_bucket: "ai-inbox-documents", storage_path: `u/${id}.webp`,
});

await check("P0-6: účtovný doklad sa archivuje — riadok aj súbor ostanú", async () => {
  for (const type of ["invoice", "receipt", "delivery_note"]) {
    assert.equal(isRetainedDocumentType(type), true);
    const env = makeDb({ role: "owner", financeManage: true, tables: { documents: [docRow("d1", type)] } });
    const result = await removeDocumentFromActiveView(env.db, { id: "d1", document_type: type, storage_bucket: "ai-inbox-documents", storage_path: "u/d1.webp" }, COMPANY_A);
    assert.equal(result, "archived");
    assert.equal(env.state.tables.documents.length, 1);
    assert.ok(env.state.tables.documents[0].deleted_at);
    assert.deepEqual(env.state.storageRemoved, []);
  }
});

await check("P0-6: neúčtovný dokument — najprv DB, potom súbor vrátane príloh", async () => {
  const env = makeDb({
    role: "owner", financeManage: true,
    tables: {
      documents: [docRow("d2", "insurance")],
      document_attachments: [{ id: "a1", document_id: "d2", company_id: COMPANY_A, storage_bucket: "ai-inbox-attachments", storage_path: "u/d2-a.pdf" }],
    },
  });
  const result = await removeDocumentFromActiveView(env.db, { id: "d2", document_type: "insurance", storage_bucket: "ai-inbox-documents", storage_path: "u/d2.webp" }, COMPANY_A);
  assert.equal(result, "deleted");
  assert.equal(env.state.tables.documents.length, 0);
  assert.deepEqual(env.state.storageRemoved.sort(), ["ai-inbox-attachments/u/d2-a.pdf", "ai-inbox-documents/u/d2.webp"]);
});

await check("P0-6: bez zasiahnutého riadku (RLS) → chyba 'denied', súbor sa nemaže", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: { documents: [] } });
  await assert.rejects(
    () => removeDocumentFromActiveView(env.db, { id: "missing", document_type: "insurance", storage_bucket: "b", storage_path: "p" }, COMPANY_A),
    (e: unknown) => (e as { reason?: string }).reason === "denied"
  );
  await assert.rejects(
    () => removeDocumentFromActiveView(env.db, { id: "missing", document_type: "receipt", storage_bucket: "b", storage_path: "p" }, COMPANY_A),
    (e: unknown) => (e as { reason?: string }).reason === "denied"
  );
  assert.deepEqual(env.state.storageRemoved, []);
});

await check("P0-6: čitatelia ai_evidence filtrujú archivované záznamy", () => {
  for (const path of ["app/ai-evidencia/page.tsx", "lib/machine-documents.ts", "lib/vehicle-documents.ts"]) {
    assert.match(read(path), /from\("ai_evidence"\)[\s\S]{0,400}\.is\("deleted_at", null\)/, path);
  }
});

// =============================================================================
// P0-7 — asistent: cena vs. množstvo
// =============================================================================

await check("P0-7: „cena“ nikdy nie je množstvo", () => {
  for (const phrase of ["Zmeň cenu Spreja na 4,90", "Zmeň cenu položky Sprej na 4.90", "Nastav cenu Spreja na 5 eur"]) {
    const intent = parseIntentDeterministic(phrase);
    assert.equal(intent?.name, "INVENTORY_ITEM_EDIT", phrase);
    assert.equal(intent?.args.editField, "price", phrase);
    assert.equal(intent?.args.quantity, undefined, phrase);
  }
});

await check("P0-7: explicitné množstvo a pridanie ostávajú; „Zmeň Sprej na 5“ sa pýta", () => {
  const set = parseIntentDeterministic("Nastav množstvo Spreja na 5");
  assert.equal(set?.name, "INVENTORY_QUANTITY_ADJUST");
  assert.equal(set?.args.quantity, 5);
  const add = parseIntentDeterministic("Pridaj 5 Sprejov");
  assert.ok(add && ["INVENTORY_QUANTITY_ADJUST", "INVENTORY_ADD"].includes(add.name), JSON.stringify(add));
  const ambiguous = parseIntentDeterministic("Zmeň Sprej na 5");
  assert.equal(ambiguous?.name, "INVENTORY_ITEM_EDIT");
  assert.equal(ambiguous?.args.editField, undefined);
});

type Env = ReturnType<typeof makeDb>;
async function say(env: Env, text: string) {
  const canOperate = env.state.role !== "accountant";
  const finance = env.state.role === "owner" || env.state.role === "accountant" || env.state.financeManage;
  const { output } = await runAssistantTurnDetailed(
    { db: env.db, classifyWithAi: async () => null },
    {
      rawText: text, locale: "sk", userId: env.userId, companyId: env.companyId, role: env.state.role,
      financeView: finance, financeManage: finance, canOperate,
      conversationId: "fedcba9876543210fedcba9876543210", pendingClarification: null, structuredPartnerId: null,
      issueDate: "2026-09-26", uiContext: null, moduleContext: null as never, selection: null, folderContextId: null,
    }
  );
  return output.result as { kind: string; text?: string; question?: string };
}
const inventory = () => ({ inventory_items: [{ id: "i1", name: "Sprej", quantity: 12, unit: "ks", company_id: COMPANY_A }] });

await check("P0-7: orchestrátor — cena sa nezapíše a množstvo ostane 12", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: inventory() });
  const r = await say(env, "Zmeň cenu Spreja na 4,90");
  assert.equal(r.text ?? r.question, translate("sk", "assistant.inventory.priceNotSupported"));
  assert.equal(env.state.tables.inventory_items[0].quantity, 12);
});

await check("P0-7: orchestrátor — „Zmeň Sprej na 5“ sa spýta množstvo/názov a nič nezapíše", async () => {
  const env = makeDb({ role: "owner", financeManage: true, tables: inventory() });
  const r = await say(env, "Zmeň Sprej na 5");
  assert.equal(r.text, translate("sk", "assistant.inventory.askEditFieldValue", { name: "Sprej", value: "5" }), JSON.stringify(r));
  assert.equal(env.state.tables.inventory_items[0].quantity, 12);
  assert.equal(env.state.tables.inventory_items[0].name, "Sprej");
});

await check("Zamestnanec ostáva bez všeobecného asistenta (cena aj množstvo)", async () => {
  for (const phrase of ["Zmeň cenu Spreja na 4,90", "Zmeň Sprej na 5", "Nastav množstvo Spreja na 5"]) {
    const env = makeDb({ role: "employee" as Role, financeManage: false, tables: inventory() });
    const r = await say(env, phrase);
    assert.notEqual(r.kind, "clarification", phrase);
    assert.notEqual(r.kind, "action_preview", phrase);
    assert.equal(env.state.tables.inventory_items[0].quantity, 12, phrase);
  }
});

// =============================================================================
// P0-8, P0-10 — texty a dokumentácia
// =============================================================================

await check("P0-8: /subprocessors bez TODO a so známym regiónom Supabase", async () => {
  for (const lang of ["sk", "en", "de"]) {
    const src = read(`lib/i18n/dictionaries/${lang}.ts`);
    const block = src.slice(src.indexOf("supabaseLocation"), src.indexOf("namecheapLocation"));
    assert.doesNotMatch(block, /TODO/, lang);
    assert.match(block, /eu-central-1/, lang);
  }
});

await check("P0-10: hlavička migrácie 20260928100000 uvádza produkčnú verziu 20260926150526", () => {
  const head = read("supabase/migrations/20260928100000_company_entitlements_trial.sql").slice(0, 800);
  assert.match(head, /APLIKOVANÉ 2026-09-26/);
  assert.match(head, /20260926150526/);
  assert.doesNotMatch(head, /STAV: NAVRHNUTÉ, NEAPLIKOVANÉ/);
});

await check("P0 migrácia je v hlavičke označená ako APLIKOVANÁ (prod verzia 20260927081034); push/OAuth ostávajú neaplikované", () => {
  // Iba blok „-- STAV:" hlavičky (po prvý prázdny riadok komentára „--"),
  // spojený do jedného textu — slová v iných častiach súboru sa nerátajú.
  const lines = MIGRATION.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("-- STAV:"));
  assert.ok(start >= 0 && start < 20, "hlavička nemá riadok „-- STAV:“");
  const end = lines.findIndex((l, i) => i > start && l.trim() === "--");
  assert.ok(end > start, "blok STAV nie je ukončený");
  const stav = lines.slice(start, end).map((l) => l.replace(/^--\s?/, "")).join(" ").replace(/\s+/g, " ");

  // Stav TEJTO migrácie = prvá veta bloku STAV.
  const ownStatus = stav.slice(0, stav.indexOf(".") + 1);
  assert.match(ownStatus, /^STAV: APLIKOVANÉ do produkcie 2026-09-27\b/, ownStatus);
  assert.match(ownStatus, /fkpgvgvsmbpieduoatrt/);
  assert.doesNotMatch(ownStatus, /NAVRHNUT|NEAPLIKOVAN/);
  assert.match(stav, /pod verziou 20260927081034\b/);
  assert.match(stav, /NIKDY `supabase db push`/);

  // Jediný výskyt „NEAPLIKOVANÉ" v bloku patrí push/OAuth migráciám.
  assert.match(stav, /Push migrácia 20260927110000 a OAuth migrácia 20260927120000 ostávajú NEAPLIKOVANÉ\./);
  assert.equal((stav.match(/NEAPLIKOVAN/g) ?? []).length, 1, "NEAPLIKOVANÉ smie označovať iba push/OAuth migrácie");

  // Nikde v úvodnej hlavičke (pred prvým SQL príkazom) nie je starý stav.
  const header = MIGRATION.slice(0, MIGRATION.search(/^create or replace function/m));
  assert.doesNotMatch(header, /NAVRHNUTÉ|STAV: NEAPLIKOVAN/);
});

await check("i18n: nové kľúče existujú v sk/en/de", () => {
  const keys = [
    "inbox.errors.confirmArchiveDocument", "inbox.errors.documentRemovalDenied", "assistant.inbox.archived",
    "invoices.creditNote.fullyCredited", "invoices.creditNote.correctsLabel", "invoices.creditNote.openCorrected",
    "invoices.creditNote.creditedLabel", "invoices.creditNote.remainingLabel", "invoices.creditNote.noPaymentsNotice",
    "invoices.pdf.correctsLabel", "invoices.pdf.creditTotalLabel", "invoices.errors.draftStale", "handoff.col.kind",
    "auth.invite.errors.ESBLU_INVITE_ROLE_NOT_PERMITTED", "auth.invite.createErrors.ESBLU_INVITE_ROLE_NOT_PERMITTED",
    "onboarding.pendingInviteTitle", "onboarding.pendingInviteDescription", "settings.company.bankDetailsOwnerOnly",
    "assistant.inventory.priceNotSupported", "assistant.inventory.askEditFieldValue",
  ];
  for (const locale of ["sk", "en", "de"] as const) {
    for (const key of keys) assert.notEqual(translate(locale, key), key, `${locale}:${key}`);
  }
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
