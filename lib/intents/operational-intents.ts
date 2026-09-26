import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import { normalizeSpz } from "@/lib/normalize-spz";
import { vehicleDetailHref, machineDetailHref, inventoryItemDetailHref } from "@/lib/entity-links";
import type { ClarificationSlot, EntityRef, IntentName, IntentResult, ParsedIntent } from "@/lib/intents/types";
import { resolveEntityByName, type NameConfidence } from "@/lib/intents/entity-resolution";
import type { ResolvedUiEntity } from "@/lib/intents/ui-context";
import { isServiceUtterance } from "@/lib/intents/parse";
import { entitlementMessageKey, entitlementModuleKey, parseEntitlementDenial } from "@/lib/entitlements";

// =============================================================================
// Intent Engine — prevádzkové zápisy: sklad, stroje, vozidlá.
//
// PORADIE (zadanie: pochop → over oprávnenie → nájdi entitu → spýtaj sa →
// potvrď → vykonaj)
//   1. Oprávnenie rozhodol lib/intents/permissions.ts PRED zavolaním tohto
//      modulu. Zamestnanec ani účtovník sem so zápisom nedôjdu.
//   2. Entita sa hľadá pod RLS (user-scoped klient). Zápis vyžaduje PRESNÚ
//      zhodu mena; viac kandidátov = výber, žiadny = jasná veta, nie „nič".
//   3. „Tento stroj" = entita otvorená na obrazovke, ktorú server overil
//      (resolveUiEntity). Na nástenke taká nie je → otázka.
//   4. Každý zápis vráti iba náhľad; zapíše sa až po potvrdení cez
//      /api/assistant/action/execute (HMAC, jednorazové). Do potvrdenia sa
//      ukladajú presné identifikátory a očakávaný stav.
//   5. Vykonanie všetko znova overí (rola, existencia, aktuálny stav).
// =============================================================================

export const OPERATIONAL_WRITE_INTENTS = [
  "INVENTORY_ITEM_CREATE",
  "INVENTORY_QUANTITY_ADJUST",
  "INVENTORY_ITEM_DELETE",
  "INVENTORY_ITEM_RENAME",
  "MACHINE_CREATE",
  "MACHINE_SERVICE_ADD",
  "MACHINE_DELETE",
  "VEHICLE_CREATE",
  "VEHICLE_SERVICE_ADD",
  "VEHICLE_DELETE",
] as const;
export type OperationalWriteIntent = (typeof OPERATIONAL_WRITE_INTENTS)[number];

const OPERATIONAL_FAMILY: readonly string[] = [
  ...OPERATIONAL_WRITE_INTENTS,
  "INVENTORY_ITEM_EDIT",
  "MACHINE_PHOTO_ADD",
  "VEHICLE_PHOTO_ADD",
  "DOCUMENT_INTAKE",
];

export function isOperationalFamilyIntent(name: string): name is IntentName {
  return OPERATIONAL_FAMILY.includes(name);
}

export function isOperationalWriteIntent(name: string): name is OperationalWriteIntent {
  return (OPERATIONAL_WRITE_INTENTS as readonly string[]).includes(name);
}

export type OperationalContext = {
  companyId: string;
  userId: string;
  /** Entita otvorená na obrazovke, už overená serverom (alebo null). */
  resolvedEntity: ResolvedUiEntity | null;
  /** Kalendárny deň používateľa (servisný záznam). */
  today: string | null;
};

export type CreateOperationalConfirmation = (
  intent: OperationalWriteIntent,
  canonicalArgs: Record<string, unknown>,
  expectedCount: number | null
) => Promise<string | null>;

const t = translate;
const NAME_MAX = 120;

function answer(text: string, entity?: EntityRef): IntentResult {
  return entity ? { kind: "answer", text, entity } : { kind: "answer", text };
}

function actionResult(success: boolean, text: string): IntentResult {
  return { kind: "action_result", success, text };
}

export function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Ľahké odstránenie slovenských/českých pádových koncoviek pre hľadanie. */
export function stemVariants(query: string): string[] {
  const base = normalizeKey(query);
  const variants = new Set([base]);
  for (const ending of ["ami", "ovi", "ov", "om", "ou", "ach", "u", "a", "y", "e", "i"]) {
    if (base.length - ending.length >= 3 && base.endsWith(ending)) variants.add(base.slice(0, -ending.length));
  }
  return Array.from(variants);
}

type Named = { id: string; name: string | null };

/**
 * Zhoda mena vo vrstvách (lib/intents/entity-resolution.ts): presná →
 * bez skloňovania → predpona. Viac kandidátov → `ambiguous`, nikdy tichý
 * výber. `confidence` hovorí, ako istá zhoda je — mazanie berie bez otázky
 * iba `exact`.
 */
export function resolveByName<T extends Named>(
  rows: readonly T[],
  spoken: string
): { match: T; confidence: NameConfidence } | { ambiguous: T[] } | { none: true } {
  return resolveEntityByName(rows, spoken, (row) => row.name);
}

type Found<T> = { match: T; confidence: NameConfidence } | { ambiguous: T[] } | { none: true };

/**
 * Nebezpečné akcie (zmazanie) potrebujú PRESNÉ meno. Jediná zhoda cez
 * skloňovanie/predponu sa neberie potichu — asistent sa spýta „Myslíte …?"
 * a až po „Áno" ukáže deštruktívny náhľad (s ďalším potvrdením).
 */
function requireExact<T extends Named>(
  found: Found<T>,
  exact: boolean
): Found<T> | { candidate: T } {
  if (!exact || !("match" in found) || found.confidence === "exact") return found;
  return { candidate: found.match };
}

function cleanName(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.replace(/\s+/g, " ").trim();
  if (!value || value.length > NAME_MAX) return null;
  return value;
}

function formatQuantity(value: number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 1000) / 1000;
  return unit ? `${rounded} ${unit}` : String(rounded);
}

// -----------------------------------------------------------------------------
// Načítanie entít (pod RLS)
// -----------------------------------------------------------------------------

type InventoryRow = { id: string; name: string | null; quantity: number | null; unit: string | null };
type MachineRow = { id: string; name: string | null; manufacturer: string | null; model: string | null };
type VehicleRow = { id: string; spz: string | null; znacka: string | null; model: string | null };

async function loadInventory(db: SupabaseClient): Promise<InventoryRow[]> {
  const { data } = await db.from("inventory_items").select("id, name, quantity, unit").limit(2000);
  return ((data ?? []) as InventoryRow[]).map((row) => ({ ...row, quantity: row.quantity === null ? null : Number(row.quantity) }));
}

async function loadMachines(db: SupabaseClient): Promise<MachineRow[]> {
  const { data } = await db.from("machines").select("id, name, manufacturer, model").limit(2000);
  return (data ?? []) as MachineRow[];
}

async function loadVehicles(db: SupabaseClient): Promise<VehicleRow[]> {
  const { data } = await db.from("vehicles").select("id, spz, znacka, model").limit(2000);
  return (data ?? []) as VehicleRow[];
}

function inventoryRef(row: InventoryRow): EntityRef {
  return { type: "inventory_item", id: row.id, label: row.name ?? "—", href: inventoryItemDetailHref(row.id) };
}

function machineRef(row: MachineRow): EntityRef {
  return { type: "machine", id: row.id, label: row.name ?? "—", href: machineDetailHref(row.id) };
}

function vehicleLabel(row: VehicleRow): string {
  return [row.spz, [row.znacka, row.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "—";
}

function vehicleRef(row: VehicleRow): EntityRef {
  return { type: "vehicle", id: row.id, label: vehicleLabel(row), href: vehicleDetailHref(row.id) };
}

function disambiguate(title: string, items: EntityRef[], slot?: ClarificationSlot): IntentResult {
  return { kind: "list", title, items: items.slice(0, 12), ...(slot ? { awaiting: { slot } } : {}) };
}

function ask(text: string, slot: ClarificationSlot): IntentResult {
  return { kind: "answer", text, awaiting: { slot } };
}

function askCandidate(text: string, slot: ClarificationSlot, ref: EntityRef): IntentResult {
  return { kind: "answer", text, entity: ref, awaiting: { slot, candidate: { id: ref.id, label: ref.label } } };
}

type Resolution<T> = { entity: T } | { result: IntentResult };

/** Spoločné vstupy rozlíšenia entity. `entityId` pochádza VÝHRADNE z potvrdeného kandidáta. */
type ResolveInput = {
  query: string | undefined;
  useContext: boolean | undefined;
  context: ResolvedUiEntity | null;
  entityId?: string;
  exact?: boolean;
};

async function resolveMachine(db: SupabaseClient, locale: Locale, input: ResolveInput): Promise<Resolution<MachineRow>> {
  const { query, useContext, context, entityId, exact = false } = input;
  if (entityId) {
    // Potvrdený kandidát — znova pod RLS; cudzí/zmazaný záznam = nenájdený.
    const { data } = await db.from("machines").select("id, name, manufacturer, model").eq("id", entityId).maybeSingle();
    if (data) return { entity: data as MachineRow };
    return { result: { kind: "not_found", text: t(locale, "assistant.machine.notFound", { name: query ?? "" }) } };
  }
  if ((useContext || !query) && context?.entityType === "machine") {
    return { entity: { id: context.entityId, name: context.label, manufacturer: null, model: null } };
  }
  if (!query) return { result: ask(t(locale, "assistant.machine.whichMachine"), "machine") };
  const rows = await loadMachines(db);
  const found = requireExact(resolveByName(rows, query), exact);
  if ("match" in found) return { entity: found.match };
  if ("candidate" in found) {
    return { result: askCandidate(t(locale, "assistant.machine.confirmCandidate", { name: found.candidate.name ?? "" }), "machine", machineRef(found.candidate)) };
  }
  if ("ambiguous" in found) return { result: disambiguate(t(locale, "assistant.machine.whichOne", { query }), found.ambiguous.map(machineRef), "machine") };
  return { result: { kind: "not_found", text: t(locale, "assistant.machine.notFound", { name: query }), awaiting: { slot: "machine" } } };
}

async function resolveVehicle(db: SupabaseClient, locale: Locale, input: ResolveInput): Promise<Resolution<VehicleRow>> {
  const { query, useContext, context, entityId, exact = false } = input;
  if (entityId) {
    const { data } = await db.from("vehicles").select("id, spz, znacka, model").eq("id", entityId).maybeSingle();
    if (data) return { entity: data as VehicleRow };
    return { result: { kind: "not_found", text: t(locale, "assistant.vehicle.notFound", { name: query ?? "" }) } };
  }
  if ((useContext || !query) && context?.entityType === "vehicle") {
    return { entity: { id: context.entityId, spz: context.label, znacka: null, model: null } };
  }
  if (!query) return { result: ask(t(locale, "assistant.vehicle.whichVehicle"), "vehicle") };
  const rows = await loadVehicles(db);
  const plate = normalizeSpz(query);
  if (plate) {
    // ŠPZ je presný identifikátor — zhoda po normalizácii je `exact`.
    const byPlate = rows.filter((row) => normalizeSpz(row.spz) === plate);
    if (byPlate.length === 1) return { entity: byPlate[0] };
  }
  const named = rows.map((row) => ({ ...row, name: `${row.znacka ?? ""} ${row.model ?? ""}`.trim() || row.spz }));
  const found = requireExact(resolveByName(named, query), exact);
  if ("match" in found) return { entity: found.match };
  if ("candidate" in found) {
    return { result: askCandidate(t(locale, "assistant.vehicle.confirmCandidate", { name: vehicleLabel(found.candidate) }), "vehicle", vehicleRef(found.candidate)) };
  }
  if ("ambiguous" in found) return { result: disambiguate(t(locale, "assistant.vehicle.whichOne", { query }), found.ambiguous.map(vehicleRef), "vehicle") };
  return { result: { kind: "not_found", text: t(locale, "assistant.vehicle.notFound", { name: query }), awaiting: { slot: "vehicle" } } };
}

async function resolveInventory(
  db: SupabaseClient,
  locale: Locale,
  input: ResolveInput
): Promise<Resolution<InventoryRow> | { missing: true }> {
  const { query, useContext, context, entityId, exact = false } = input;
  const byId = async (id: string): Promise<InventoryRow | null> => {
    const { data } = await db.from("inventory_items").select("id, name, quantity, unit").eq("id", id).maybeSingle();
    if (!data) return null;
    const row = data as InventoryRow;
    return { ...row, quantity: row.quantity === null ? null : Number(row.quantity) };
  };
  if (entityId) {
    const row = await byId(entityId);
    if (row) return { entity: row };
    return { result: { kind: "not_found", text: t(locale, "assistant.inventory.gone") } };
  }
  if ((useContext || !query) && context?.entityType === "inventory_item") {
    const row = await byId(context.entityId);
    if (row) return { entity: row };
  }
  if (!query) return { result: ask(t(locale, "assistant.inventory.whichItem"), "inventory_item") };
  const rows = await loadInventory(db);
  const found = requireExact(resolveByName(rows, query), exact);
  if ("match" in found) return { entity: found.match };
  if ("candidate" in found) {
    return { result: askCandidate(t(locale, "assistant.inventory.confirmCandidate", { name: found.candidate.name ?? "" }), "inventory_item", inventoryRef(found.candidate)) };
  }
  if ("ambiguous" in found) return { result: disambiguate(t(locale, "assistant.inventory.whichOne", { query }), found.ambiguous.map(inventoryRef), "inventory_item") };
  return { missing: true };
}

// -----------------------------------------------------------------------------
// Náhľad (bez zápisu)
// -----------------------------------------------------------------------------

function preview(
  locale: Locale,
  action: OperationalWriteIntent,
  summary: string,
  confirmationId: string,
  confirmLabelKey: string,
  destructive = false
): IntentResult {
  return {
    kind: "action_preview",
    action,
    summary,
    confirmLabel: t(locale, confirmLabelKey),
    cancelLabel: t(locale, "search.actions.cancelLabel"),
    confirmationId,
    destructive,
  };
}

export async function handleOperationalIntent(
  db: SupabaseClient,
  locale: Locale,
  intent: ParsedIntent,
  ctx: OperationalContext,
  createConfirmation: CreateOperationalConfirmation
): Promise<IntentResult> {
  const args = intent.args;
  const failed = (): IntentResult => ({ kind: "error", text: t(locale, "search.errors.generic") });

  switch (intent.name) {
    // ------------------------------------------------------------- sklad
    case "INVENTORY_ITEM_CREATE": {
      const name = cleanName(args.entityName);
      if (!name) return answer(t(locale, "assistant.inventory.askName"));
      const existing = resolveByName(await loadInventory(db), name);
      if ("match" in existing && normalizeKey(existing.match.name) === normalizeKey(name)) {
        return answer(t(locale, "assistant.inventory.alreadyExists", { name: existing.match.name ?? name }), inventoryRef(existing.match));
      }
      const quantity = typeof args.quantity === "number" && Number.isFinite(args.quantity) && args.quantity >= 0 ? args.quantity : 0;
      const unit = cleanName(args.unit) ?? null;
      const id = await createConfirmation("INVENTORY_ITEM_CREATE", { name, quantity, unit }, null);
      if (!id) return failed();
      return preview(locale, "INVENTORY_ITEM_CREATE",
        t(locale, "assistant.inventory.createSummary", { name, quantity: formatQuantity(quantity, unit) }),
        id, "assistant.confirm.create");
    }

    case "INVENTORY_QUANTITY_ADJUST": {
      const amount = typeof args.quantity === "number" && Number.isFinite(args.quantity) ? Math.abs(args.quantity) : null;
      const mode = args.quantityMode;
      if (!mode) return answer(t(locale, "assistant.inventory.askQuantity"));
      const resolved = await resolveInventory(db, locale, { query: args.query ?? args.entityName, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId });
      if ("result" in resolved) return resolved.result;
      if (amount === null) {
        // Chýba iba množstvo. Najprv cieľ (vyššie), potom otázka na JEDEN
        // chýbajúci slot so známym cieľom — ďalšia veta („päť") je odpoveďou.
        if ("missing" in resolved) {
          // „Pridaj do X" bez slova „položka": veta je skladová IBA pri zhode.
          if (args.implicitInventoryTarget) return { kind: "not_found", text: t(locale, "search.errors.commandNotUnderstood") };
          const name = cleanName(args.entityName ?? args.query);
          return { kind: "not_found", text: t(locale, "assistant.inventory.notFound", { name: name ?? "" }), awaiting: { slot: "inventory_item" } };
        }
        const item = resolved.entity;
        return {
          kind: "answer",
          text: t(locale, `assistant.inventory.askQuantityFor.${mode}`, { name: item.name ?? "" }),
          entity: inventoryRef(item),
          awaiting: { slot: "quantity", patch: { query: item.name ?? undefined, entityName: item.name ?? undefined, implicitInventoryTarget: undefined } },
        };
      }
      if ("missing" in resolved) {
        if (args.implicitInventoryTarget) return { kind: "not_found", text: t(locale, "search.errors.commandNotUnderstood") };
        const name = cleanName(args.entityName ?? args.query);
        // Pridávanie neexistujúcej položky = návrh založiť ju s týmto množstvom.
        if (mode === "add" && name) {
          const unit = cleanName(args.unit) ?? null;
          const id = await createConfirmation("INVENTORY_ITEM_CREATE", { name, quantity: amount, unit }, null);
          if (!id) return failed();
          return preview(locale, "INVENTORY_ITEM_CREATE",
            t(locale, "assistant.inventory.createInsteadSummary", { name, quantity: formatQuantity(amount, unit) }),
            id, "assistant.confirm.create");
        }
        return { kind: "not_found", text: t(locale, "assistant.inventory.notFound", { name: name ?? "" }), awaiting: { slot: "inventory_item" } };
      }
      const item = resolved.entity;
      const current = item.quantity ?? 0;
      const next = mode === "set" ? amount : mode === "add" ? current + amount : current - amount;
      if (next < 0) {
        return answer(t(locale, "assistant.inventory.notEnough", { name: item.name ?? "", quantity: formatQuantity(current, item.unit) }), inventoryRef(item));
      }
      const id = await createConfirmation(
        "INVENTORY_QUANTITY_ADJUST",
        { itemId: item.id, expectedQuantity: item.quantity, newQuantity: next },
        null
      );
      if (!id) return failed();
      return preview(locale, "INVENTORY_QUANTITY_ADJUST",
        t(locale, "assistant.inventory.adjustSummary", {
          name: item.name ?? "",
          from: formatQuantity(current, item.unit),
          to: formatQuantity(next, item.unit),
        }),
        id, "assistant.confirm.adjust", mode === "subtract" || (mode === "set" && next < current));
    }

    case "INVENTORY_ITEM_DELETE": {
      const resolved = await resolveInventory(db, locale, { query: args.query ?? args.entityName, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId, exact: true });
      if ("result" in resolved) return resolved.result;
      if ("missing" in resolved) {
        return { kind: "not_found", text: t(locale, "assistant.inventory.notFound", { name: args.query ?? "" }), awaiting: { slot: "inventory_item" } };
      }
      const item = resolved.entity;
      const id = await createConfirmation("INVENTORY_ITEM_DELETE", { itemId: item.id, name: item.name }, null);
      if (!id) return failed();
      return preview(locale, "INVENTORY_ITEM_DELETE",
        t(locale, "assistant.inventory.deleteSummary", { name: item.name ?? "", quantity: formatQuantity(item.quantity, item.unit) }),
        id, "assistant.confirm.delete", true);
    }

    case "INVENTORY_ITEM_EDIT": {
      // „Uprav skladovú položku X" — nič nezapisuje. Overí cieľ a spýta sa na
      // JEDINÉ, čo hlas vie bezpečne zmeniť: počet kusov alebo názov (tie isté
      // polia ako formulár v Sklade). Žiadne vymyslené pole.
      const resolved = await resolveInventory(db, locale, { query: args.query ?? args.entityName, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId });
      if ("result" in resolved) return resolved.result;
      if ("missing" in resolved) {
        return { kind: "not_found", text: t(locale, "assistant.inventory.notFound", { name: args.query ?? "" }), awaiting: { slot: "inventory_item" } };
      }
      const item = resolved.entity;
      return {
        kind: "answer",
        text: t(locale, "assistant.inventory.askEditField", { name: item.name ?? "" }),
        entity: inventoryRef(item),
        awaiting: { slot: "edit_field", patch: { query: item.name ?? undefined, entityName: item.name ?? undefined } },
        quickReplies: [
          { label: t(locale, "assistant.inventory.editQuantity"), text: t(locale, "assistant.inventory.editQuantity") },
          { label: t(locale, "assistant.inventory.editName"), text: t(locale, "assistant.inventory.editName") },
        ],
      };
    }

    case "INVENTORY_ITEM_RENAME": {
      // Ten istý stĺpec `name`, ktorý mení formulár položky v Sklade. Cieľ
      // iba presne (inak otázka „Myslíte …?"), nový názov presne ako zaznel.
      const newName = cleanName(args.newName);
      if (!newName) return answer(t(locale, "assistant.inventory.askName"));
      const resolved = await resolveInventory(db, locale, { query: args.query ?? args.entityName, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId, exact: true });
      if ("result" in resolved) return resolved.result;
      if ("missing" in resolved) {
        return { kind: "not_found", text: t(locale, "assistant.inventory.notFound", { name: args.query ?? "" }), awaiting: { slot: "inventory_item" } };
      }
      const item = resolved.entity;
      if (normalizeKey(item.name) === normalizeKey(newName)) {
        return answer(t(locale, "assistant.inventory.renameSame", { name: item.name ?? "" }), inventoryRef(item));
      }
      const id = await createConfirmation("INVENTORY_ITEM_RENAME", { itemId: item.id, name: item.name, newName }, null);
      if (!id) return { kind: "error", text: t(locale, "assistant.inventory.renameUnavailable") };
      return preview(locale, "INVENTORY_ITEM_RENAME",
        t(locale, "assistant.inventory.renameSummary", { name: item.name ?? "", newName }),
        id, "assistant.confirm.rename");
    }

    // ------------------------------------------------------------- stroje
    case "MACHINE_CREATE": {
      const name = cleanName(args.entityName);
      if (!name) return answer(t(locale, "assistant.machine.askName"));
      const existing = (await loadMachines(db)).find((m) => normalizeKey(m.name) === normalizeKey(name));
      if (existing) return answer(t(locale, "assistant.machine.alreadyExists", { name: existing.name ?? name }), machineRef(existing));
      const id = await createConfirmation("MACHINE_CREATE", { name }, null);
      if (!id) return failed();
      return preview(locale, "MACHINE_CREATE", t(locale, "assistant.machine.createSummary", { name }), id, "assistant.confirm.create");
    }

    case "MACHINE_SERVICE_ADD":
    case "VEHICLE_SERVICE_ADD": {
      // Modul z vety, inak z otvorenej entity. Bez oboch sa pýtame.
      const isVehicle =
        intent.name === "VEHICLE_SERVICE_ADD" ||
        (!args.targetModule && ctx.resolvedEntity?.entityType === "vehicle");
      const isMachine = !isVehicle && (intent.name === "MACHINE_SERVICE_ADD");
      // „Pridaj servis Takeuchi" — slovo za „servis" nie je popis, ale meno
      // stroja (žiadne údržbové slovo). Overí sa presne; potom otázka na popis.
      if (!args.query && !args.entityId && args.serviceTitle && !isServiceUtterance(args.serviceTitle)) {
        const asMachine = requireExact(resolveByName(await loadMachines(db), args.serviceTitle), true);
        if ("match" in asMachine) {
          // Meno stroja sa presunie z popisu do cieľa (zapečatená otázka).
          return {
            kind: "answer",
            text: t(locale, "assistant.service.askTitle", { name: asMachine.match.name ?? "" }),
            awaiting: { slot: "service_title", patch: { query: asMachine.match.name ?? args.serviceTitle, serviceTitle: undefined, targetModule: "machines" } },
          };
        }
      }
      if (!args.targetModule && !args.query && !args.entityId && !ctx.resolvedEntity) {
        return ask(t(locale, "assistant.service.whichEntity"), "machine_or_vehicle");
      }
      // Stroj/vozidlo je známe, popis nie → otázka (nie záznam „Servis").
      // (So sumou „Pridaj servis za 250 eur" je záznam úplný aj bez popisu.)
      if (!cleanName(args.serviceTitle) && args.amount === undefined && (args.query || args.entityId || args.useContext || ctx.resolvedEntity)) {
        const probe = isVehicle
          ? await resolveVehicle(db, locale, { query: args.query, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId })
          : await resolveMachine(db, locale, { query: args.query, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId });
        if ("entity" in probe) {
          const label = isVehicle ? vehicleLabel(probe.entity as VehicleRow) : (probe.entity as MachineRow).name ?? "";
          return ask(t(locale, "assistant.service.askTitle", { name: label }), "service_title");
        }
        if (!isVehicle && !args.targetModule && args.query && "result" in probe && probe.result.kind === "not_found") {
          // Môže to byť vozidlo — pokračuje sa pôvodnou cestou nižšie.
        } else {
          return probe.result;
        }
      }
      const title = cleanName(args.serviceTitle) ?? t(locale, "assistant.service.defaultTitle");
      // Suma iba ak zaznela („za 250 eur"); nič sa nedopĺňa.
      const cost = typeof args.amount === "number" && Number.isFinite(args.amount) && args.amount > 0 ? Math.round(args.amount * 100) / 100 : null;
      const summary = (entity: string) =>
        cost !== null
          ? t(locale, "assistant.service.addSummaryCost", { entity, title, cost: cost.toFixed(2) })
          : t(locale, "assistant.service.addSummary", { entity, title });
      if (isVehicle) {
        const resolved = await resolveVehicle(db, locale, { query: args.query, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId });
        if ("result" in resolved) return resolved.result;
        const label = vehicleLabel(resolved.entity);
        const id = await createConfirmation("VEHICLE_SERVICE_ADD", { vehicleId: resolved.entity.id, title, serviceDate: ctx.today, cost }, null);
        if (!id) return failed();
        return preview(locale, "VEHICLE_SERVICE_ADD", summary(label), id, "assistant.confirm.add");
      }
      if (isMachine) {
        let resolved = await resolveMachine(db, locale, { query: args.query, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId });
        // Modul nezaznel a stroj sa nenašiel — možno je to vozidlo.
        if ("result" in resolved && !args.targetModule && args.query && !args.entityId && resolved.result.kind === "not_found") {
          const asVehicle = await resolveVehicle(db, locale, { query: args.query, useContext: false, context: null });
          if ("entity" in asVehicle) {
            const label = vehicleLabel(asVehicle.entity);
            const id = await createConfirmation("VEHICLE_SERVICE_ADD", { vehicleId: asVehicle.entity.id, title, serviceDate: ctx.today, cost }, null);
            if (!id) return failed();
            return preview(locale, "VEHICLE_SERVICE_ADD", summary(label), id, "assistant.confirm.add");
          }
          if (asVehicle.result.kind === "list") return { ...asVehicle.result, awaiting: { slot: "machine_or_vehicle" } };
          resolved = { result: { kind: "not_found", text: t(locale, "assistant.service.entityNotFound", { name: args.query }), awaiting: { slot: "machine_or_vehicle" } } };
        }
        if ("result" in resolved) return resolved.result;
        const id = await createConfirmation("MACHINE_SERVICE_ADD", { machineId: resolved.entity.id, title, serviceDate: ctx.today, cost }, null);
        if (!id) return failed();
        return preview(locale, "MACHINE_SERVICE_ADD", summary(resolved.entity.name ?? ""), id, "assistant.confirm.add");
      }
      return ask(t(locale, "assistant.service.whichEntity"), "machine_or_vehicle");
    }

    case "MACHINE_DELETE": {
      const resolved = await resolveMachine(db, locale, { query: args.query, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId, exact: true });
      if ("result" in resolved) return resolved.result;
      const machine = resolved.entity;
      const [{ count: services }, { count: photos }] = await Promise.all([
        db.from("machine_services").select("id", { count: "exact", head: true }).eq("machine_id", machine.id),
        db.from("machine_photos").select("id", { count: "exact", head: true }).eq("machine_id", machine.id),
      ]);
      const id = await createConfirmation("MACHINE_DELETE", { machineId: machine.id, name: machine.name }, null);
      if (!id) return failed();
      return preview(locale, "MACHINE_DELETE",
        t(locale, "assistant.machine.deleteSummary", { name: machine.name ?? "", services: services ?? 0, photos: photos ?? 0 }),
        id, "assistant.confirm.delete", true);
    }

    case "MACHINE_PHOTO_ADD": {
      if (!args.query && ctx.resolvedEntity?.entityType === "vehicle") {
        const entity: EntityRef = { type: "vehicle", id: ctx.resolvedEntity.entityId, label: ctx.resolvedEntity.label, href: vehicleDetailHref(ctx.resolvedEntity.entityId) };
        return answer(t(locale, "assistant.photo.openDetail"), entity);
      }
      const resolved = await resolveMachine(db, locale, { query: args.query, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId });
      if ("result" in resolved) return resolved.result;
      return answer(t(locale, "assistant.photo.openDetail"), machineRef(resolved.entity));
    }

    // ------------------------------------------------------------- vozidlá
    case "VEHICLE_CREATE": {
      const plate = normalizeSpz(args.query ?? "");
      if (!plate) return answer(t(locale, "assistant.vehicle.askPlate"));
      const existing = (await loadVehicles(db)).find((v) => normalizeSpz(v.spz) === plate);
      if (existing) return answer(t(locale, "assistant.vehicle.alreadyExists", { plate }), vehicleRef(existing));
      const id = await createConfirmation("VEHICLE_CREATE", { spz: plate }, null);
      if (!id) return failed();
      return preview(locale, "VEHICLE_CREATE", t(locale, "assistant.vehicle.createSummary", { plate }), id, "assistant.confirm.create");
    }

    case "VEHICLE_DELETE": {
      const resolved = await resolveVehicle(db, locale, { query: args.query, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId, exact: true });
      if ("result" in resolved) return resolved.result;
      const vehicle = resolved.entity;
      const [{ count: services }, { count: photos }] = await Promise.all([
        db.from("vehicle_services").select("id", { count: "exact", head: true }).eq("vehicle_id", vehicle.id),
        db.from("vehicle_photos").select("id", { count: "exact", head: true }).eq("vehicle_id", vehicle.id),
      ]);
      const id = await createConfirmation("VEHICLE_DELETE", { vehicleId: vehicle.id, label: vehicleLabel(vehicle) }, null);
      if (!id) return failed();
      return preview(locale, "VEHICLE_DELETE",
        t(locale, "assistant.vehicle.deleteSummary", { name: vehicleLabel(vehicle), services: services ?? 0, photos: photos ?? 0 }),
        id, "assistant.confirm.delete", true);
    }

    case "VEHICLE_PHOTO_ADD": {
      const resolved = await resolveVehicle(db, locale, { query: args.query, useContext: args.useContext, context: ctx.resolvedEntity, entityId: args.entityId });
      if ("result" in resolved) return resolved.result;
      return answer(t(locale, "assistant.photo.openDetail"), vehicleRef(resolved.entity));
    }

    // ------------------------------------------------------------- príjem dokladu
    case "DOCUMENT_INTAKE": {
      const entity: EntityRef = { type: "document", id: "intake", label: t(locale, "assistant.intake.openInbox"), href: "/ai-evidencia" };
      return answer(t(locale, "assistant.intake.instructions"), entity);
    }

    default:
      return failed();
  }
}

// -----------------------------------------------------------------------------
// Vykonanie po potvrdení (volá lib/intents/actions.ts#executeAction)
// -----------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function executeOperationalAction(
  db: SupabaseClient,
  locale: Locale,
  ctx: { companyId: string; userId: string },
  intent: OperationalWriteIntent,
  args: Record<string, unknown>
): Promise<IntentResult> {
  const fail = (key = "search.errors.generic") => actionResult(false, t(locale, key));
  // Nárok/limit vynucuje DB trigger (esblu_enforce_plan_limit → nároky firmy)
  // rovnako pre UI, asistenta aj hlas; tu sa štruktúrovaný kód iba prevedie
  // na zrozumiteľnú odpoveď (bez dôvery v plán/počty z klienta).
  const planLimitFail = (error: unknown) => {
    const denial = parseEntitlementDenial(error);
    if (!denial) return null;
    return actionResult(false, t(locale, entitlementMessageKey(denial.reason), {
      module: t(locale, entitlementModuleKey(denial.key)),
    }));
  };

  switch (intent) {
    case "INVENTORY_ITEM_CREATE": {
      const name = str(args.name);
      if (!name) return fail();
      const { error } = await db.from("inventory_items").insert({
        company_id: ctx.companyId,
        user_id: ctx.userId,
        name,
        quantity: num(args.quantity) ?? 0,
        unit: str(args.unit),
      });
      if (error) return planLimitFail(error) ?? fail(error.code === "42501" ? "assistant.denied.inventoryReadOnly" : "search.errors.generic");
      return actionResult(true, t(locale, "assistant.inventory.created", { name }));
    }

    case "INVENTORY_QUANTITY_ADJUST": {
      const itemId = str(args.itemId);
      const next = num(args.newQuantity);
      if (!itemId || next === null) return fail();
      const expected = args.expectedQuantity === null ? null : num(args.expectedQuantity);
      const { data: current } = await db.from("inventory_items").select("id, name, quantity, unit").eq("id", itemId).maybeSingle();
      if (!current) return fail("assistant.inventory.gone");
      const currentQuantity = (current as InventoryRow).quantity === null ? null : Number((current as InventoryRow).quantity);
      // Stav sa medzitým zmenil → nič sa nezapíše; používateľ uvidí nový náhľad.
      if (currentQuantity !== expected) return fail("folders.intent.dataChanged");
      let query = db.from("inventory_items").update({ quantity: next }).eq("id", itemId);
      query = expected === null ? query.is("quantity", null) : query.eq("quantity", expected);
      const { data, error } = await query.select("id");
      if (error || (data ?? []).length !== 1) return fail(error ? "search.errors.generic" : "folders.intent.dataChanged");
      return actionResult(true, t(locale, "assistant.inventory.adjusted", {
        name: (current as InventoryRow).name ?? "",
        quantity: formatQuantity(next, (current as InventoryRow).unit),
      }));
    }

    case "INVENTORY_ITEM_DELETE": {
      const itemId = str(args.itemId);
      if (!itemId) return fail();
      const { data: photos, error: photosError } = await db.from("inventory_photos").select("file_path").eq("inventory_item_id", itemId);
      if (photosError) return fail();
      const paths = ((photos ?? []) as { file_path: string | null }[]).map((p) => p.file_path).filter((p): p is string => Boolean(p));
      if (paths.length > 0) {
        const { error: storageError } = await db.storage.from("inventory-photos").remove(paths);
        if (storageError) return fail();
      }
      const { data, error } = await db.from("inventory_items").delete().eq("id", itemId).select("id");
      if (error || (data ?? []).length !== 1) return fail();
      return actionResult(true, t(locale, "assistant.inventory.deleted", { name: str(args.name) ?? "" }));
    }

    case "INVENTORY_ITEM_RENAME": {
      const itemId = str(args.itemId);
      const newName = str(args.newName);
      if (!itemId || !newName) return fail();
      const { data, error } = await db.from("inventory_items").update({ name: newName }).eq("id", itemId).select("id");
      if (error || (data ?? []).length !== 1) return fail(error?.code === "42501" ? "assistant.denied.inventoryReadOnly" : "search.errors.generic");
      return actionResult(true, t(locale, "assistant.inventory.renamed", { name: str(args.name) ?? "", newName }));
    }

    case "MACHINE_CREATE": {
      const name = str(args.name);
      if (!name) return fail();
      const { error } = await db.from("machines").insert({ company_id: ctx.companyId, user_id: ctx.userId, name });
      if (error) return planLimitFail(error) ?? fail();
      return actionResult(true, t(locale, "assistant.machine.created", { name }));
    }

    case "MACHINE_SERVICE_ADD":
    case "VEHICLE_SERVICE_ADD": {
      const isVehicle = intent === "VEHICLE_SERVICE_ADD";
      const entityId = str(isVehicle ? args.vehicleId : args.machineId);
      if (!entityId) return fail();
      const row: Record<string, unknown> = {
        user_id: ctx.userId,
        title: str(args.title),
        service_date: str(args.serviceDate),
        ...(num(args.cost) !== null ? { cost: num(args.cost) } : {}),
        ...(isVehicle ? { vehicle_id: entityId } : { machine_id: entityId }),
      };
      const { error } = await db.from(isVehicle ? "vehicle_services" : "machine_services").insert(row);
      if (error) return fail();
      return actionResult(true, t(locale, "assistant.service.added"));
    }

    case "MACHINE_DELETE": {
      const machineId = str(args.machineId);
      if (!machineId) return fail();
      // Rovnaké kroky ako mazanie v UI (app/stroje/page.tsx): fotky zo
      // Storage, riadky fotiek, stroj — a overenie, že naozaj zmizol.
      const { data: photos, error: photosError } = await db.from("machine_photos").select("file_path").eq("machine_id", machineId);
      if (photosError) return fail();
      const paths = Array.from(new Set(((photos ?? []) as { file_path: string | null }[]).map((p) => p.file_path).filter((p): p is string => Boolean(p))));
      let { data, error } = await db.from("machines").delete().eq("id", machineId).select("id");
      // RESTRICT na fotkách: najprv riadky fotiek, potom ten istý delete znova.
      if (error?.code === "23503") {
        const { error: photoRowsError } = await db.from("machine_photos").delete().eq("machine_id", machineId);
        if (photoRowsError) return fail();
        ({ data, error } = await db.from("machines").delete().eq("id", machineId).select("id"));
      }
      if (error || (data ?? []).length !== 1) return fail();
      await db.from("machine_photos").delete().eq("machine_id", machineId);
      if (paths.length > 0) await db.storage.from("machine-photos").remove(paths);
      return actionResult(true, t(locale, "assistant.machine.deleted", { name: str(args.name) ?? "" }));
    }

    case "VEHICLE_CREATE": {
      const spz = normalizeSpz(str(args.spz) ?? "");
      if (!spz) return fail();
      const { error } = await db.from("vehicles").insert({ company_id: ctx.companyId, user_id: ctx.userId, spz });
      if (error) return planLimitFail(error) ?? fail();
      return actionResult(true, t(locale, "assistant.vehicle.created", { plate: spz }));
    }

    case "VEHICLE_DELETE": {
      const vehicleId = str(args.vehicleId);
      if (!vehicleId) return fail();
      // Rovnaké kroky ako mazanie v UI (app/vozidla/page.tsx): fotky zo
      // Storage a doklady PZP/TP sa vrátia do Inboxu (nikdy sa nemažú).
      const { data: photos } = await db.from("vehicle_photos").select("storage_path").eq("vehicle_id", vehicleId);
      const { data: linkedDocs } = await db
        .from("document_links")
        .select("document_id, documents!inner(document_type)")
        .eq("vehicle_id", vehicleId)
        .in("documents.document_type", ["insurance", "vehicle_registration"]);
      const { data, error } = await db.from("vehicles").delete().eq("id", vehicleId).select("id");
      if (error || (data ?? []).length !== 1) return fail();
      const docIds = ((linkedDocs ?? []) as { document_id: string | null }[]).map((d) => d.document_id).filter((d): d is string => Boolean(d));
      if (docIds.length > 0) {
        await db.from("documents").update({ archived_from_inbox_at: null }).in("id", docIds);
      }
      const paths = ((photos ?? []) as { storage_path: string | null }[]).map((p) => p.storage_path).filter((p): p is string => Boolean(p));
      if (paths.length > 0) await db.storage.from("vehicle-photos").remove(paths);
      return actionResult(true, t(locale, "assistant.vehicle.deleted", { name: str(args.label) ?? "" }));
    }
  }
}
