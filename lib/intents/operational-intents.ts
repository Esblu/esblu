import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import { normalizeSpz } from "@/lib/normalize-spz";
import { vehicleDetailHref, machineDetailHref, inventoryItemDetailHref } from "@/lib/entity-links";
import type { EntityRef, IntentName, IntentResult, ParsedIntent } from "@/lib/intents/types";
import type { ResolvedUiEntity } from "@/lib/intents/ui-context";

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
 * Presná alebo jednoznačná zhoda mena. Pri zápise sa berie iba PRESNÁ zhoda
 * (po normalizácii), alebo jediný kandidát, ktorého meno začína tým, čo
 * zaznelo. Viac kandidátov → `ambiguous`, nikdy tichý výber.
 */
export function resolveByName<T extends Named>(
  rows: readonly T[],
  spoken: string
): { match: T } | { ambiguous: T[] } | { none: true } {
  const key = normalizeKey(spoken);
  if (!key) return { none: true };
  const exact = rows.filter((row) => normalizeKey(row.name) === key);
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };

  const variants = stemVariants(spoken);
  const partial = rows.filter((row) => {
    const name = normalizeKey(row.name);
    return variants.some((variant) => name.startsWith(variant) || name.split(" ").some((word) => word.startsWith(variant)));
  });
  if (partial.length === 1) return { match: partial[0] };
  if (partial.length > 1) return { ambiguous: partial };
  return { none: true };
}

/**
 * Nebezpečné akcie (zmazanie) potrebujú PRESNÉ meno. Jediná približná zhoda
 * sa neberie potichu — asistent ju ukáže a poprosí o celé meno.
 */
function requireExact<T extends Named>(
  found: { match: T } | { ambiguous: T[] } | { none: true },
  spoken: string,
  exact: boolean
): { match: T } | { ambiguous: T[] } | { none: true } {
  if (!exact || !("match" in found)) return found;
  return normalizeKey(found.match.name) === normalizeKey(spoken) ? found : { ambiguous: [found.match] };
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

function disambiguate(title: string, items: EntityRef[]): IntentResult {
  return { kind: "list", title, items: items.slice(0, 12) };
}

type Resolution<T> = { entity: T } | { result: IntentResult };

async function resolveMachine(
  db: SupabaseClient,
  locale: Locale,
  query: string | undefined,
  useContext: boolean | undefined,
  context: ResolvedUiEntity | null,
  exact = false
): Promise<Resolution<MachineRow>> {
  if ((useContext || !query) && context?.entityType === "machine") {
    return { entity: { id: context.entityId, name: context.label, manufacturer: null, model: null } };
  }
  if (!query) return { result: answer(t(locale, "assistant.machine.whichMachine")) };
  const rows = await loadMachines(db);
  const found = requireExact(resolveByName(rows, query), query, exact);
  if ("match" in found) return { entity: found.match };
  if ("ambiguous" in found) return { result: disambiguate(t(locale, "assistant.machine.whichOne", { query }), found.ambiguous.map(machineRef)) };
  return { result: { kind: "not_found", text: t(locale, "assistant.machine.notFound", { name: query }) } };
}

async function resolveVehicle(
  db: SupabaseClient,
  locale: Locale,
  query: string | undefined,
  useContext: boolean | undefined,
  context: ResolvedUiEntity | null,
  exact = false
): Promise<Resolution<VehicleRow>> {
  if ((useContext || !query) && context?.entityType === "vehicle") {
    return { entity: { id: context.entityId, spz: context.label, znacka: null, model: null } };
  }
  if (!query) return { result: answer(t(locale, "assistant.vehicle.whichVehicle")) };
  const rows = await loadVehicles(db);
  const plate = normalizeSpz(query);
  if (plate) {
    const byPlate = rows.filter((row) => normalizeSpz(row.spz) === plate);
    if (byPlate.length === 1) return { entity: byPlate[0] };
  }
  const named = rows.map((row) => ({ ...row, name: `${row.znacka ?? ""} ${row.model ?? ""}`.trim() || row.spz }));
  const found = requireExact(resolveByName(named, query), query, exact);
  if ("match" in found) return { entity: found.match };
  if ("ambiguous" in found) return { result: disambiguate(t(locale, "assistant.vehicle.whichOne", { query }), found.ambiguous.map(vehicleRef)) };
  return { result: { kind: "not_found", text: t(locale, "assistant.vehicle.notFound", { name: query }) } };
}

async function resolveInventory(
  db: SupabaseClient,
  locale: Locale,
  query: string | undefined,
  useContext: boolean | undefined,
  context: ResolvedUiEntity | null,
  exact = false
): Promise<Resolution<InventoryRow> | { missing: true }> {
  if ((useContext || !query) && context?.entityType === "inventory_item") {
    const { data } = await db.from("inventory_items").select("id, name, quantity, unit").eq("id", context.entityId).maybeSingle();
    if (data) return { entity: { ...(data as InventoryRow), quantity: (data as InventoryRow).quantity === null ? null : Number((data as InventoryRow).quantity) } };
  }
  if (!query) return { result: answer(t(locale, "assistant.inventory.whichItem")) };
  const rows = await loadInventory(db);
  const found = requireExact(resolveByName(rows, query), query, exact);
  if ("match" in found) return { entity: found.match };
  if ("ambiguous" in found) return { result: disambiguate(t(locale, "assistant.inventory.whichOne", { query }), found.ambiguous.map(inventoryRef)) };
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
      if (amount === null || !mode) return answer(t(locale, "assistant.inventory.askQuantity"));
      const resolved = await resolveInventory(db, locale, args.query ?? args.entityName, args.useContext, ctx.resolvedEntity);
      if ("result" in resolved) return resolved.result;
      if ("missing" in resolved) {
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
        return { kind: "not_found", text: t(locale, "assistant.inventory.notFound", { name: name ?? "" }) };
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
      const resolved = await resolveInventory(db, locale, args.query ?? args.entityName, args.useContext, ctx.resolvedEntity, true);
      if ("result" in resolved) return resolved.result;
      if ("missing" in resolved) return { kind: "not_found", text: t(locale, "assistant.inventory.notFound", { name: args.query ?? "" }) };
      const item = resolved.entity;
      const id = await createConfirmation("INVENTORY_ITEM_DELETE", { itemId: item.id, name: item.name }, null);
      if (!id) return failed();
      return preview(locale, "INVENTORY_ITEM_DELETE",
        t(locale, "assistant.inventory.deleteSummary", { name: item.name ?? "", quantity: formatQuantity(item.quantity, item.unit) }),
        id, "assistant.confirm.delete", true);
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
      if (!args.targetModule && !args.query && !ctx.resolvedEntity) {
        return answer(t(locale, "assistant.service.whichEntity"));
      }
      const title = cleanName(args.serviceTitle) ?? t(locale, "assistant.service.defaultTitle");
      if (isVehicle) {
        const resolved = await resolveVehicle(db, locale, args.query, args.useContext, ctx.resolvedEntity);
        if ("result" in resolved) return resolved.result;
        const label = vehicleLabel(resolved.entity);
        const id = await createConfirmation("VEHICLE_SERVICE_ADD", { vehicleId: resolved.entity.id, title, serviceDate: ctx.today }, null);
        if (!id) return failed();
        return preview(locale, "VEHICLE_SERVICE_ADD", t(locale, "assistant.service.addSummary", { entity: label, title }), id, "assistant.confirm.add");
      }
      if (isMachine) {
        let resolved = await resolveMachine(db, locale, args.query, args.useContext, ctx.resolvedEntity);
        // Modul nezaznel a stroj sa nenašiel — možno je to vozidlo.
        if ("result" in resolved && !args.targetModule && args.query && resolved.result.kind === "not_found") {
          const asVehicle = await resolveVehicle(db, locale, args.query, false, null);
          if ("entity" in asVehicle) {
            const label = vehicleLabel(asVehicle.entity);
            const id = await createConfirmation("VEHICLE_SERVICE_ADD", { vehicleId: asVehicle.entity.id, title, serviceDate: ctx.today }, null);
            if (!id) return failed();
            return preview(locale, "VEHICLE_SERVICE_ADD", t(locale, "assistant.service.addSummary", { entity: label, title }), id, "assistant.confirm.add");
          }
          if (asVehicle.result.kind === "list") return asVehicle.result;
          resolved = { result: { kind: "not_found", text: t(locale, "assistant.service.entityNotFound", { name: args.query }) } };
        }
        if ("result" in resolved) return resolved.result;
        const id = await createConfirmation("MACHINE_SERVICE_ADD", { machineId: resolved.entity.id, title, serviceDate: ctx.today }, null);
        if (!id) return failed();
        return preview(locale, "MACHINE_SERVICE_ADD", t(locale, "assistant.service.addSummary", { entity: resolved.entity.name ?? "", title }), id, "assistant.confirm.add");
      }
      return answer(t(locale, "assistant.service.whichEntity"));
    }

    case "MACHINE_DELETE": {
      const resolved = await resolveMachine(db, locale, args.query, args.useContext, ctx.resolvedEntity, true);
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
      const resolved = await resolveMachine(db, locale, args.query, args.useContext, ctx.resolvedEntity);
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
      const resolved = await resolveVehicle(db, locale, args.query, args.useContext, ctx.resolvedEntity, true);
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
      const resolved = await resolveVehicle(db, locale, args.query, args.useContext, ctx.resolvedEntity);
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
      if (error) return fail(error.code === "42501" ? "assistant.denied.inventoryReadOnly" : "search.errors.generic");
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

    case "MACHINE_CREATE": {
      const name = str(args.name);
      if (!name) return fail();
      const { error } = await db.from("machines").insert({ company_id: ctx.companyId, user_id: ctx.userId, name });
      if (error) return fail();
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
      if (error) return fail();
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
