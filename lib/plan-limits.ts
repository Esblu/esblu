export type Plan = "free" | "pro" | "admin";

export type PlanResource =
  | "ai_evidence"
  | "vehicles"
  | "inventory_items"
  | "machines";

export const PLAN_RESOURCE_LABELS: Record<PlanResource, string> = {
  ai_evidence: "Inbox",
  vehicles: "Vozidlá",
  inventory_items: "Sklad",
  machines: "Stroje",
};

export const PLAN_LIMIT_MESSAGE =
  "Dosiahli ste limit bezplatnej verzie. Platená verzia Esblu sa pripravuje.";

/**
 * Fallback used only while rendering the free-plan UX if plan_limits cannot be
 * loaded. The database plan_limits table and its trigger are authoritative.
 */
export const FREE_PLAN_UX_FALLBACK_LIMITS: Record<PlanResource, number> = {
  ai_evidence: 5,
  vehicles: 2,
  inventory_items: 5,
  machines: 2,
};

const PLAN_LIMIT_ERROR_PREFIX = "PLAN_LIMIT_REACHED:";

const planResources = new Set<PlanResource>([
  "ai_evidence",
  "vehicles",
  "inventory_items",
  "machines",
]);

export function isPlan(value: unknown): value is Plan {
  return value === "free" || value === "pro" || value === "admin";
}

export function isPlanResource(value: unknown): value is PlanResource {
  return typeof value === "string" && planResources.has(value as PlanResource);
}

export function isPlanUsageLimited(
  usage: number,
  limit: number | null
): boolean {
  return limit !== null && usage >= limit;
}

function getErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;

  if (typeof error !== "object" || error === null) return "";

  const errorRecord = error as Record<string, unknown>;
  return [errorRecord.message, errorRecord.details, errorRecord.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

// Nový formát z DB (20260928100000): ENTITLEMENT_DENIED:<REASON>:<key>.
// Mapuje kľúč nároku na tabuľku, ktorú stránky poznajú. Nárok `ai_documents`
// je kvóta AI spracovaní (nie počet uložených riadkov) — pre Inbox UI sa
// hlási ako ai_evidence, aby existujúce stránky zobrazili upozornenie.
const ENTITLEMENT_KEY_TO_RESOURCE: Record<string, PlanResource> = {
  vehicles: "vehicles",
  machines: "machines",
  inventory: "inventory_items",
  ai_documents: "ai_evidence",
};

export function getPlanLimitResourceFromError(
  error: unknown
): PlanResource | null {
  const errorText = getErrorText(error);
  const entitlementMatch = /ENTITLEMENT_DENIED:[A-Z_]+:([a-z_]+)/.exec(errorText);
  if (entitlementMatch) return ENTITLEMENT_KEY_TO_RESOURCE[entitlementMatch[1]] ?? null;

  const prefixIndex = errorText.indexOf(PLAN_LIMIT_ERROR_PREFIX);

  if (prefixIndex < 0) return null;

  const valueAfterPrefix = errorText.slice(
    prefixIndex + PLAN_LIMIT_ERROR_PREFIX.length
  );
  const resource = valueAfterPrefix.match(/^[a-z_]+/)?.[0];

  return isPlanResource(resource) ? resource : null;
}

export function isPlanLimitReachedError(
  error: unknown,
  resource?: PlanResource
): boolean {
  const errorResource = getPlanLimitResourceFromError(error);

  if (!errorResource) return false;
  return resource ? errorResource === resource : true;
}

/**
 * Structured, machine-readable form of a plan-limit denial. The DB trigger
 * esblu_enforce_plan_limit raises `PLAN_LIMIT_REACHED:<table>`; server routes
 * and the assistant convert it to this shape so UI and voice never have to
 * parse human-readable text. Plan and counts are deliberately NOT taken from
 * the client — the database is the only authority.
 */
export type PlanLimitDenial = {
  code: "PLAN_LIMIT_REACHED";
  resource: PlanResource;
};

export function toPlanLimitDenial(error: unknown): PlanLimitDenial | null {
  const resource = getPlanLimitResourceFromError(error);
  return resource ? { code: "PLAN_LIMIT_REACHED", resource } : null;
}

/**
 * Null-safe limit check for server code. `null` = unlimited (Pro/admin).
 * Negative or non-integer limits are treated as misconfiguration and fail
 * closed (limited), never as "unlimited".
 */
export function canCreateUnderLimit(usage: number, limit: number | null): boolean {
  if (limit === null) return true;
  if (!Number.isInteger(limit) || limit < 0) return false;
  return usage < limit;
}
