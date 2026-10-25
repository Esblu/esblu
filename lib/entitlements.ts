// =============================================================================
// Esblu — komerčné nároky (entitlements). Čistý modul (klient aj server).
//
// Vrstvy prístupu sú ODDELENÉ a všetky musia prejsť:
//   prihlásenie → členstvo vo firme → rola/oprávnenie → NÁROK MODULU → pravidlá akcie
// Tento modul rieši IBA nárok. Nikdy nerozširuje rolu ani oprávnenie.
//
// Autorita je databáza (esblu_resolve_entitlement, migrácia 20260928100000):
// trial firmy (14 dní, serverový čas), platené/ručné moduly, kvóty. Klient
// nikdy neposiela plán, limity ani počty — tento modul iba číta odpoveď RPC
// esblu_get_my_company_entitlements() a štruktúrované chyby
// `ENTITLEMENT_DENIED:<REASON>:<key>`.
//
// Fail closed: poškodená/nečitateľná odpoveď = žiadny nárok (platené akcie
// zakázané). Čítanie existujúcich dát touto vrstvou NIE JE obmedzené.
// =============================================================================

import type { IntentName } from "@/lib/intents/types";
import { ADDONS, LIMIT_ADDON_OFFER, type AddonId } from "@/lib/pricing";

export const ENTITLEMENT_KEYS = [
  "invoicing",
  // Samostatný platený modul eFaktúra (20261002100000). Mimo trialu. Sám
  // o sebe stačí aj na vznik/finalizáciu faktúr (DB trigger fakturácie).
  "einvoice",
  "ai_documents",
  "vehicles",
  "machines",
  "inventory",
  "voice",
  "team_members",
  // Kvóty z pricing + entitlements architektúry (20261026100000).
  "voice_minutes",
  "storage_mb",
  "einvoice_transactions",
] as const;

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export const ENTITLEMENT_REASONS = [
  "TRIAL_EXPIRED",
  "ENTITLEMENT_REQUIRED",
  "VOICE_ENTITLEMENT_REQUIRED",
  "USER_LIMIT_REACHED",
  "VEHICLE_LIMIT_REACHED",
  "MACHINE_LIMIT_REACHED",
  "INVENTORY_LIMIT_REACHED",
  "AI_PROCESSING_LIMIT_REACHED",
  "ENTITLEMENT_LIMIT_REACHED",
  "VOICE_LIMIT_REACHED",
  "STORAGE_LIMIT_REACHED",
  "EINVOICE_LIMIT_REACHED",
] as const;

export type EntitlementReason = (typeof ENTITLEMENT_REASONS)[number];

export type EntitlementDenial = {
  code: "ENTITLEMENT_DENIED";
  reason: EntitlementReason;
  key: EntitlementKey;
  /** Z DB detailu chyby (iba pri limitoch): zahrnuté množstvo a aktuálne čerpanie. */
  limit?: number | null;
  current?: number | null;
};

export type EntitlementState = {
  key: EntitlementKey;
  active: boolean;
  source: "trial" | "subscription" | "manual" | "beta_compat" | null;
  /** null = bez limitu (alebo neaktívne). */
  limit: number | null;
  reason: EntitlementReason | null;
};

export type CompanyEntitlements = {
  companyId: string;
  /** startedAt/endsAt = null: firma vznikla pred zavedením trialu (bez trialu, prístup cez granty). */
  trial: { startedAt: string | null; endsAt: string | null; active: boolean; aiProcessingUsed: number };
  items: Record<EntitlementKey, EntitlementState>;
};

export function isEntitlementKey(value: unknown): value is EntitlementKey {
  return typeof value === "string" && (ENTITLEMENT_KEYS as readonly string[]).includes(value);
}

export function isEntitlementReason(value: unknown): value is EntitlementReason {
  return typeof value === "string" && (ENTITLEMENT_REASONS as readonly string[]).includes(value);
}

const DENIAL_PATTERN = /ENTITLEMENT_DENIED:([A-Z_]+):([a-z_]+)/;

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null) return "";
  const record = error as Record<string, unknown>;
  return [record.message, record.error, record.details, record.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

/** Štruktúrovaná chyba z DB/servera. Neznámy dôvod alebo kľúč = null (nedôveruje sa). */
export function parseEntitlementDenial(error: unknown): EntitlementDenial | null {
  const match = DENIAL_PATTERN.exec(errorText(error));
  if (!match) return null;
  const [, reason, key] = match;
  if (!isEntitlementReason(reason) || !isEntitlementKey(key)) return null;
  const denial: EntitlementDenial = { code: "ENTITLEMENT_DENIED", reason, key };
  const detail = parseDenialDetail(error);
  if (detail) {
    denial.limit = detail.limit;
    denial.current = detail.current;
  }
  return denial;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** DB detail `{"reason","key","limit","current"}` (esblu_raise_entitlement_denial). */
function parseDenialDetail(error: unknown): { limit: number | null; current: number | null } | null {
  if (!error || typeof error !== "object") return null;
  const raw = (error as Record<string, unknown>).details;
  if (typeof raw !== "string" || raw.length > 500) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { limit: finiteOrNull(parsed.limit), current: finiteOrNull(parsed.current) };
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// LIMIT_REACHED — jednoznačný stav pre UI (nikdy tiché zlyhanie). Server
// zlyhá fail closed; UI dostane čerpanie, zahrnuté množstvo a ponuku
// add-onu z kanonického cenníka (lib/pricing.ts). Add-on sa NIKDY neaktivuje
// bez potvrdeného billing eventu (zatiaľ žiadny live billing).
// -----------------------------------------------------------------------------
export const LIMIT_REASONS: readonly EntitlementReason[] = [
  "AI_PROCESSING_LIMIT_REACHED",
  "VOICE_LIMIT_REACHED",
  "USER_LIMIT_REACHED",
  "STORAGE_LIMIT_REACHED",
  "EINVOICE_LIMIT_REACHED",
];

export type LimitReached = {
  code: "LIMIT_REACHED";
  reason: EntitlementReason;
  key: EntitlementKey;
  used: number | null;
  included: number | null;
  addon: { id: AddonId; units: number; priceCents: number } | null;
};

export function limitReachedFrom(denial: EntitlementDenial | null): LimitReached | null {
  if (!denial || !LIMIT_REASONS.includes(denial.reason)) return null;
  const addonId = LIMIT_ADDON_OFFER[denial.key];
  const addon = addonId ? ADDONS[addonId] : null;
  return {
    code: "LIMIT_REACHED",
    reason: denial.reason,
    key: denial.key,
    used: denial.current ?? null,
    included: denial.limit ?? null,
    addon: addon ? { id: addon.id, units: addon.units, priceCents: addon.priceCents } : null,
  };
}

function denied(key: EntitlementKey, reason: EntitlementReason = "ENTITLEMENT_REQUIRED"): EntitlementState {
  return { key, active: false, source: null, limit: null, reason };
}

/**
 * Validuje odpoveď esblu_get_my_company_entitlements(). Čokoľvek poškodené
 * → null (volajúci to berie ako „žiadne nároky"). Chýbajúci kľúč v odpovedi
 * = neaktívny (nikdy nie „bez limitu").
 */
export function parseCompanyEntitlements(raw: unknown): CompanyEntitlements | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const trial = value.trial as Record<string, unknown> | undefined;
  if (typeof value.company_id !== "string" || !trial || typeof trial !== "object") return null;
  const dateOrNull = (v: unknown) => v === null || typeof v === "string";
  if (!dateOrNull(trial.started_at) || !dateOrNull(trial.ends_at) || typeof trial.active !== "boolean") return null;
  if (!Array.isArray(value.entitlements)) return null;

  const items = Object.fromEntries(ENTITLEMENT_KEYS.map((key) => [key, denied(key)])) as Record<EntitlementKey, EntitlementState>;

  for (const entry of value.entitlements) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (!isEntitlementKey(item.key)) continue;
    const active = item.active === true;
    const limitRaw = item.limit;
    const limitValid = limitRaw === null || limitRaw === undefined || (typeof limitRaw === "number" && Number.isInteger(limitRaw) && limitRaw >= 0);
    if (active && !limitValid) {
      items[item.key] = denied(item.key);
      continue;
    }
    items[item.key] = {
      key: item.key,
      active,
      source:
        item.source === "trial" || item.source === "subscription" || item.source === "manual" || item.source === "beta_compat"
          ? item.source
          : null,
      limit: active && typeof limitRaw === "number" ? limitRaw : null,
      reason: active ? null : isEntitlementReason(item.reason) ? item.reason : "ENTITLEMENT_REQUIRED",
    };
  }

  const used = typeof trial.ai_processing_used === "number" && trial.ai_processing_used >= 0 ? trial.ai_processing_used : 0;

  return {
    companyId: value.company_id,
    trial: {
      startedAt: (trial.started_at as string | null) ?? null,
      endsAt: (trial.ends_at as string | null) ?? null,
      active: trial.active,
      aiProcessingUsed: used,
    },
    items,
  };
}

export function hasEntitlement(snapshot: CompanyEntitlements | null, key: EntitlementKey): boolean {
  return snapshot?.items[key]?.active === true;
}

/** undefined = nárok chýba (nie je čo počítať); null = bez limitu. */
export function getEffectiveLimit(snapshot: CompanyEntitlements | null, key: EntitlementKey): number | null | undefined {
  const item = snapshot?.items[key];
  if (!item || !item.active) return undefined;
  return item.limit;
}

export function denialFor(snapshot: CompanyEntitlements | null, key: EntitlementKey): EntitlementDenial | null {
  if (hasEntitlement(snapshot, key)) return null;
  const reason = snapshot?.items[key]?.reason ?? (key === "voice" ? "VOICE_ENTITLEMENT_REQUIRED" : "ENTITLEMENT_REQUIRED");
  return { code: "ENTITLEMENT_DENIED", reason, key };
}

/** i18n kľúče (entitlements.reasons.* + entitlements.modules.*). */
export function entitlementMessageKey(reason: EntitlementReason): string {
  return `entitlements.reasons.${reason}`;
}

export function entitlementModuleKey(key: EntitlementKey): string {
  return `entitlements.modules.${key}`;
}

// -----------------------------------------------------------------------------
// Asistent / hlas: ktorý modul intent používa. `null` = jadro (dokumenty,
// priečinky, navigácia, termíny, Inbox bez AI) — bez modulového nároku.
// Hlas samotný sa overuje zvlášť (prepis reči), tu iba modul.
// -----------------------------------------------------------------------------
const INTENT_MODULE: Partial<Record<IntentName, EntitlementKey>> = {
  OPEN_VEHICLE: "vehicles",
  SEARCH_VEHICLE: "vehicles",
  SHOW_VEHICLE_DOCUMENTS: "vehicles",
  SHOW_VEHICLE_SERVICE: "vehicles",
  VEHICLE_STK_STATUS: "vehicles",
  VEHICLE_EK_STATUS: "vehicles",
  VEHICLE_VIGNETTE_STATUS: "vehicles",
  VEHICLE_COST_SUMMARY: "vehicles",
  VEHICLE_REPORT: "vehicles",
  VEHICLE_CREATE: "vehicles",
  VEHICLE_SERVICE_ADD: "vehicles",
  VEHICLE_DELETE: "vehicles",
  VEHICLE_PHOTO_ADD: "vehicles",

  OPEN_MACHINE: "machines",
  SEARCH_MACHINE: "machines",
  SHOW_MACHINE_SERVICE: "machines",
  MACHINE_REPORT: "machines",
  SHOW_MACHINE_DOCUMENTS: "machines",
  SHOW_MACHINE_PHOTOS: "machines",
  MACHINE_CREATE: "machines",
  MACHINE_SERVICE_ADD: "machines",
  MACHINE_DELETE: "machines",
  MACHINE_PHOTO_ADD: "machines",

  OPEN_INVENTORY_ITEM: "inventory",
  SEARCH_INVENTORY_ITEM: "inventory",
  INVENTORY_ITEM_STATUS: "inventory",
  SHOW_LOW_STOCK: "inventory",
  INVENTORY_ITEM_CREATE: "inventory",
  INVENTORY_QUANTITY_ADJUST: "inventory",
  INVENTORY_ITEM_DELETE: "inventory",
  INVENTORY_ITEM_RENAME: "inventory",
  INVENTORY_ITEM_EDIT: "inventory",

  SEARCH_INVOICE: "invoicing",
  SHOW_UNPAID_INVOICES: "invoicing",
  SHOW_INVOICES_BY_STATUS: "invoicing",
  CREATE_INVOICE_DRAFT: "invoicing",
  PROCESS_CURRENT_DOCUMENT_AS_RECEIVED_INVOICE: "invoicing",
};

export function entitlementForIntent(intent: IntentName): EntitlementKey | null {
  return INTENT_MODULE[intent] ?? null;
}

/**
 * Brána pre asistenta — ROVNAKÁ politika ako ručné UI:
 *   • READ intenty (registry readOnly) nad existujúcimi dátami nárok
 *     nevyžadujú — po skončení trialu/predplatného sú historické dáta
 *     čitateľné podľa roly a finančných oprávnení (tie rozhoduje brána rolí
 *     a RLS, ktoré bežia vždy a PRED touto bránou).
 *   • WRITE / vytvorenie / AI akcie modulu vyžadujú aktívny nárok.
 * Bez snapshotu (RPC zlyhalo) sa modulové zápisy odmietnu (fail closed).
 */
export function assistantEntitlementDenial(
  snapshot: CompanyEntitlements | null,
  intent: IntentName,
  isReadOnly: (intent: IntentName) => boolean
): EntitlementDenial | null {
  const key = entitlementForIntent(intent);
  if (!key) return null;
  if (isReadOnly(intent)) return null;
  return denialFor(snapshot, key);
}
