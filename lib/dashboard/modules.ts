import type { CompanyEntitlements, EntitlementKey, EntitlementReason } from "../entitlements.ts";

// =============================================================================
// Moduly nástenky — dátový model a poradie (čistý modul, testovaný v Node).
//
// ZDROJ PRAVDY PRE ZAMKNUTIE: existujúce nároky firmy
// (`esblu_get_my_company_entitlements()` → lib/entitlements.ts): trial firmy,
// ručné/beta granty, budúce predplatné. Táto vrstva NEVYMÝŠĽA žiadny nový
// stav predplatného — iba ho číta.
//
// FALLBACK (dôležité, zámerné):
//   - nároky sa ešte načítavajú alebo RPC zlyhala (snapshot = null)
//     → stav „unknown": modul sa zobrazí ako dostupný, BEZ zámku.
//     Dôvod: nepravdivé „Nie je súčasťou vášho balíka" pri výpadku siete je
//     horšie než chýbajúci zámok; server (RLS, DB triggery, route guardy)
//     platené akcie aj tak vynúti.
//   - modul bez nároku v mape (napr. Obchodní partneri sú súčasťou
//     fakturácie) dedí nárok svojho rodiča.
// =============================================================================

export type DashboardModuleKey = "inbox" | "invoices" | "vehicles" | "machines" | "inventory" | "partners";

export type ModuleAccess =
  | { state: "active" }
  | { state: "unknown" }
  | { state: "locked"; reason: EntitlementReason | null };

export type DashboardModule = {
  key: DashboardModuleKey;
  href: string;
  /** Nárok, ktorý modul odomyká (lib/entitlements.ts). */
  entitlement: EntitlementKey;
  access: ModuleAccess;
  /** Počet záznamov, ak ho nástenka už pozná (bez nového dopytu). */
  count?: number;
  /** Počet upozornení (STK/EK/známky) — iba vozidlá. */
  alerts?: number;
};

/** Pevné základné poradie aktívnych modulov (najčastejšie používané hore). */
export const MODULE_ORDER: readonly DashboardModuleKey[] = ["inbox", "invoices", "vehicles", "machines", "inventory", "partners"];

export const MODULE_ROUTES: Record<DashboardModuleKey, string> = {
  inbox: "/ai-evidencia",
  invoices: "/faktury",
  vehicles: "/vozidla",
  machines: "/stroje",
  inventory: "/sklad",
  partners: "/obchodni-partneri",
};

export const MODULE_ENTITLEMENTS: Record<DashboardModuleKey, EntitlementKey> = {
  inbox: "ai_documents",
  invoices: "invoicing",
  vehicles: "vehicles",
  machines: "machines",
  inventory: "inventory",
  partners: "invoicing",
};

export function moduleAccess(entitlement: EntitlementKey, snapshot: CompanyEntitlements | null): ModuleAccess {
  if (!snapshot) return { state: "unknown" };
  const item = snapshot.items[entitlement];
  if (!item) return { state: "unknown" };
  return item.active ? { state: "active" } : { state: "locked", reason: item.reason ?? null };
}

export function isLocked(module: Pick<DashboardModule, "access">): boolean {
  return module.access.state === "locked";
}

/**
 * Zostaví moduly pre nástenku: iba moduly, ktoré rola a build smú vidieť
 * (`isVisible` — existujúca logika finance/operational + mobilné routy),
 * a zoradí ich: najprv dostupné (aktívne/unknown), potom zamknuté — v rámci
 * skupiny stabilne podľa MODULE_ORDER.
 */
export function buildDashboardModules(input: {
  isVisible: (href: string) => boolean;
  entitlements: CompanyEntitlements | null;
  counts?: Partial<Record<DashboardModuleKey, number>>;
  alerts?: Partial<Record<DashboardModuleKey, number>>;
}): DashboardModule[] {
  const modules = MODULE_ORDER.filter((key) => input.isVisible(MODULE_ROUTES[key])).map<DashboardModule>((key) => ({
    key,
    href: MODULE_ROUTES[key],
    entitlement: MODULE_ENTITLEMENTS[key],
    access: moduleAccess(MODULE_ENTITLEMENTS[key], input.entitlements),
    ...(input.counts?.[key] !== undefined ? { count: input.counts[key] } : {}),
    ...(input.alerts?.[key] ? { alerts: input.alerts[key] } : {}),
  }));
  return orderModules(modules);
}

export function orderModules<T extends Pick<DashboardModule, "key" | "access">>(modules: T[]): T[] {
  const rank = (key: DashboardModuleKey) => MODULE_ORDER.indexOf(key);
  return [...modules].sort((a, b) => {
    const lockDiff = Number(isLocked(a)) - Number(isLocked(b));
    return lockDiff !== 0 ? lockDiff : rank(a.key) - rank(b.key);
  });
}

export type CardAction =
  | { type: "navigate"; href: string }
  | { type: "focus"; index: number }
  | { type: "locked"; key: DashboardModuleKey };

/**
 * Ťuknutie na kartu:
 *   - karta mimo fokusu → iba sa natočí do fokusu (nikdy neotvorí iný modul,
 *     než ktorý používateľ vidí vpredu),
 *   - fokusovaná dostupná karta → otvorí modul,
 *   - fokusovaná zamknutá karta → NEotvorí modul, ukáže zamknutý stav / CTA.
 */
export function cardAction(module: DashboardModule, index: number, focusedIndex: number): CardAction {
  if (index !== focusedIndex) return { type: "focus", index };
  if (isLocked(module)) return { type: "locked", key: module.key };
  return { type: "navigate", href: module.href };
}


// -----------------------------------------------------------------------------
// Finálny polish 2026-10-11 — stav karty a zachovanie fokusu
// -----------------------------------------------------------------------------

/** Moduly, pri ktorých nástenka pozná počet záznamov (už načítané dáta). */
export const COUNTED_MODULES: readonly DashboardModuleKey[] = ["vehicles", "machines", "inventory"];

export type ModuleStatus =
  | { kind: "locked" }
  | { kind: "trial" }
  | { kind: "pending" } // nároky sa načítavajú — neutrálny skeleton, nikdy zámok
  | { kind: "loading" } // počet sa načítava — skeleton s pevnou šírkou (bez layout shiftu)
  | { kind: "error" } // údaje sa nepodarilo načítať — karta ostáva použiteľná
  | { kind: "count"; count: number }
  | { kind: "none" };

export function moduleStatus(
  module: Pick<DashboardModule, "key" | "access" | "count">,
  ctx: { entitlementsLoading: boolean; countsLoading: boolean; dataError: boolean }
): ModuleStatus {
  if (module.access.state === "locked") return module.access.reason === "TRIAL_EXPIRED" ? { kind: "trial" } : { kind: "locked" };
  if (COUNTED_MODULES.includes(module.key)) {
    if (ctx.countsLoading) return { kind: "loading" };
    if (ctx.dataError) return { kind: "error" };
    if (typeof module.count === "number") return { kind: "count", count: module.count };
  }
  if (ctx.entitlementsLoading) return { kind: "pending" };
  return { kind: "none" };
}

/** Index modulu s daným kľúčom (návrat z modulu, zmena poradia po načítaní nárokov), inak 0. */
export function focusIndexForKey(modules: ReadonlyArray<{ key: string }>, key: string | null | undefined): number {
  if (!key) return 0;
  const index = modules.findIndex((module) => module.key === key);
  return index >= 0 ? index : 0;
}

export function isDashboardModuleKey(value: unknown): value is DashboardModuleKey {
  return typeof value === "string" && (MODULE_ORDER as readonly string[]).includes(value);
}

/** Sú všetky moduly zamknuté? (prázdny/zamknutý stav nástenky s CTA) */
export function allLocked(modules: ReadonlyArray<Pick<DashboardModule, "access">>): boolean {
  return modules.length > 0 && modules.every(isLocked);
}
