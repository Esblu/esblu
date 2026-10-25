// =============================================================================
// Esblu — CANONICAL PRICING + ENTITLEMENT TARGETS (jediný zdroj cien v appke).
//
// Launch pricing (OWNER DECISION 2026-10-25, repo + staging; nič nie je live):
//   ESBLU KOMPLET            15,90 € / firma / mesiac
//   ďalšia firma (Komplet)   12,90 € / firma / mesiac
//   samostatný modul          3,90 € / mesiac
//   cenový strop modulov = cena Kompletu pre danú firmu (15,90 / 12,90)
//   usage add-ony sa do stropu NEPOČÍTAJÚ.
// Esblu s.r.o. nie je platiteľ DPH → zákaznícke ceny bez textu „+ DPH“.
//
// Všetky ceny sú v CENTOCH (žiadna float aritmetika). Pricing logika nesmie
// byť nikde inde v UI — komponenty volajú iba funkcie z tohto modulu.
//
// Zdroj platobného stavu = billing provider (Stripe / Google Play / Apple —
// zatiaľ NIČ live). Kanonická aplikačná vrstva = nároky v DB:
// esblu_plan_entitlement_targets() je SQL zrkadlo entitlementTargets()
// nižšie (paritný test: scripts/pricing-entitlements-pglite-tests.ts).
// =============================================================================

export const PRICING_STATUS = "owner_approved_not_live" as const;
export const PRICING_CURRENCY = "EUR" as const;
/** Esblu s.r.o. nie je platiteľ DPH — žiadny text „+ DPH“ / „bez DPH“. */
export const PRICING_VAT_DISPLAY = "none" as const;
export const BILLING_INTERVAL = "month" as const;

export const COMPLETE_PRICE_CENTS = 1590;
export const SECONDARY_COMPLETE_PRICE_CENTS = 1290;
export const MODULE_PRICE_CENTS = 390;

// ----------------------------------------------------------------------------- module registry
/**
 * A — základný platený modul (3,90 €; súčasť Kompletu)
 * B — súčasť iného modulu (nepredáva sa samostatne)
 * C — usage / kvóta (zahrnuté množstvo + add-on balíky)
 * D — core / zdieľaná funkcia (vždy dostupná každej firme s prístupom)
 */
export type RegistryCategory = "A_base_module" | "B_part_of_module" | "C_usage" | "D_core";

export const BASE_MODULE_IDS = ["vehicles", "machines", "inventory", "invoicing", "documents", "einvoice"] as const;
export type BaseModuleId = (typeof BASE_MODULE_IDS)[number];

export type RegistryEntry = {
  id: string;
  category: RegistryCategory;
  /** Kľúč nároku v DB (entitlement_catalog), ak existuje. */
  entitlementKey: string | null;
  /** Pre B: do ktorého základného modulu patrí. */
  partOf?: BaseModuleId;
  /** Kde v appke žije (route), pre audit. */
  routes: string[];
  /** Predajné teraz? (eFaktúra = false, kým nie je live) */
  sellable: boolean;
};

export const MODULE_REGISTRY: readonly RegistryEntry[] = [
  { id: "vehicles", category: "A_base_module", entitlementKey: "vehicles", routes: ["/vozidla"], sellable: true },
  { id: "machines", category: "A_base_module", entitlementKey: "machines", routes: ["/stroje"], sellable: true },
  { id: "inventory", category: "A_base_module", entitlementKey: "inventory", routes: ["/sklad"], sellable: true },
  { id: "invoicing", category: "A_base_module", entitlementKey: "invoicing", routes: ["/faktury"], sellable: true },
  { id: "documents", category: "A_base_module", entitlementKey: "ai_documents", routes: ["/ai-evidencia"], sellable: true },
  { id: "einvoice", category: "A_base_module", entitlementKey: "einvoice", routes: ["/faktury (eFaktúra)"], sellable: false },
  { id: "vehicle_records", category: "B_part_of_module", entitlementKey: null, partOf: "vehicles", routes: ["/vozidla/[id]"], sellable: false },
  { id: "partners", category: "B_part_of_module", entitlementKey: null, partOf: "invoicing", routes: ["/obchodni-partneri"], sellable: false },
  { id: "accounting_handoff", category: "B_part_of_module", entitlementKey: null, partOf: "invoicing", routes: ["/faktury"], sellable: false },
  { id: "folders", category: "B_part_of_module", entitlementKey: null, partOf: "documents", routes: ["/priecinky"], sellable: false },
  { id: "ai_processing", category: "C_usage", entitlementKey: "ai_documents", routes: ["/ai-evidencia"], sellable: true },
  { id: "voice", category: "C_usage", entitlementKey: "voice_minutes", routes: ["hlasové ovládanie"], sellable: true },
  { id: "users", category: "C_usage", entitlementKey: "team_members", routes: ["/nastavenia"], sellable: true },
  { id: "storage", category: "C_usage", entitlementKey: "storage_mb", routes: ["všetky prílohy"], sellable: false },
  { id: "einvoice_transactions", category: "C_usage", entitlementKey: "einvoice_transactions", routes: ["/faktury (eFaktúra)"], sellable: false },
  { id: "chat", category: "D_core", entitlementKey: null, routes: ["/chat"], sellable: false },
  { id: "dashboard", category: "D_core", entitlementKey: null, routes: ["/"], sellable: false },
  { id: "deadlines", category: "D_core", entitlementKey: null, routes: ["/ (termíny)"], sellable: false },
  { id: "notifications", category: "D_core", entitlementKey: null, routes: ["push"], sellable: false },
  { id: "team", category: "D_core", entitlementKey: null, routes: ["/nastavenia"], sellable: false },
  { id: "companies", category: "D_core", entitlementKey: null, routes: ["/firmy"], sellable: false },
];

/** Modul → nárok v DB. */
export const MODULE_ENTITLEMENT: Record<BaseModuleId, string> = {
  vehicles: "vehicles",
  machines: "machines",
  inventory: "inventory",
  invoicing: "invoicing",
  documents: "ai_documents",
  einvoice: "einvoice",
};

// ----------------------------------------------------------------------------- allowances
export const COMPLETE_ALLOWANCES = {
  users: 25,
  aiProcessingsPerMonth: 40,
  voiceMinutesPerMonth: 60,
  storageMb: 5 * 1024,
  /** Iba keď bude eFaktúra live (EINVOICE_LIVE_STATUS). */
  einvoiceTransactionsPerMonth: 20,
} as const;

/**
 * Modulárny plán — OWNER CONFIRMED 2026-10-26:
 *  - každá firma s AKÝMKOĽVEK plateným plánom má 25 používateľov a 5 GB
 *    (aj pri jedinom module za 3,90 €; aj ďalšia firma za 12,90 €),
 *  - samostatný modul Dokumenty / AI evidencia obsahuje 10 AI spracovaní /
 *    obdobie (Komplet 40); AI balík +40 / 3,90 €,
 *  - hlas NIE JE súčasťou žiadneho modulu — iba add-on +60 min / 3,90 €
 *    (Komplet 60 min, trial 15 min),
 *  - modul eFaktúra (placeholder, nie je live) obsahuje 20 tx / obdobie.
 */
export const MODULAR_ALLOWANCES = {
  users: 25,
  storageMb: 5 * 1024,
  aiProcessingsPerMonthWithDocuments: 10,
  voiceMinutesPerMonth: 0,
  einvoiceTransactionsPerMonthWithEinvoice: 20,
} as const;

/** Po skončení trialu bez plateného plánu: 0 nových uploadov (existujúce súbory ostávajú). */
export const NO_PLAN_STORAGE_MB = 0;

// ----------------------------------------------------------------------------- eFaktúra účtovanie
/**
 * Odoslaná eFaktúra = 1,0 tx, prijatá = 0,5 tx. Interne celé half-units
 * (odoslaná 2, prijatá 1) — žiadna float aritmetika; zrkadlo DB
 * (company_usage_counters.metric = 'einvoice_half_units').
 */
export const EINVOICE_HALF_UNITS = { sent: 2, received: 1 } as const;

export function einvoiceHalfUnits(sent: number, received: number): number {
  const n = (x: number) => (Number.isInteger(x) && x > 0 ? x : 0);
  return n(sent) * EINVOICE_HALF_UNITS.sent + n(received) * EINVOICE_HALF_UNITS.received;
}

/** Limit v tx → half-units (20 tx = 40). */
export function einvoiceLimitHalfUnits(transactions: number): number {
  return Math.max(0, Math.floor(transactions)) * 2;
}

/** Zobrazenie tx z half-units bez floatov: 39 → „19,5“ (sk/de) / „19.5“ (en). */
export function formatEinvoiceTx(halfUnits: number, locale: string): string {
  const whole = Math.floor(halfUnits / 2);
  const half = halfUnits % 2 === 1;
  if (!half) return String(whole);
  return `${whole}${locale === "en" ? "." : ","}5`;
}

export type AddonId = "ai_40" | "voice_60" | "users_25" | "einvoice_40" | "einvoice_100";

export type AddonDefinition = {
  id: AddonId;
  priceCents: number;
  /** Ktorý nárok navyšuje a o koľko. */
  entitlementKey: "ai_documents" | "voice_minutes" | "team_members" | "einvoice_transactions";
  units: number;
  /** Vyžaduje modul (pre modulárny plán); Komplet obsahuje všetko. */
  requiresModule: BaseModuleId | null;
};

export const ADDONS: Record<AddonId, AddonDefinition> = {
  ai_40: { id: "ai_40", priceCents: 390, entitlementKey: "ai_documents", units: 40, requiresModule: "documents" },
  voice_60: { id: "voice_60", priceCents: 390, entitlementKey: "voice_minutes", units: 60, requiresModule: null },
  users_25: { id: "users_25", priceCents: 490, entitlementKey: "team_members", units: 25, requiresModule: null },
  einvoice_40: { id: "einvoice_40", priceCents: 490, entitlementKey: "einvoice_transactions", units: 40, requiresModule: "einvoice" },
  einvoice_100: { id: "einvoice_100", priceCents: 990, entitlementKey: "einvoice_transactions", units: 100, requiresModule: "einvoice" },
};
export const ADDON_IDS = Object.keys(ADDONS) as AddonId[];
/** Strop počtu balíkov jedného druhu (ochrana pred chybou vstupu; zrkadlo DB check). */
export const MAX_ADDON_PACKS = 50;

/** Ktorý add-on sa ponúkne pri vyčerpaní limitu daného nároku. */
export const LIMIT_ADDON_OFFER: Record<string, AddonId> = {
  ai_documents: "ai_40",
  voice_minutes: "voice_60",
  team_members: "users_25",
  einvoice_transactions: "einvoice_40",
};

/** eFaktúra nie je live: blokované externe (provider, API, CLIA, účtovníctvo) + súhlas vlastníka. */
export const EINVOICE_LIVE_STATUS = "blocked_pending_external_and_owner_approval" as const;

// ----------------------------------------------------------------------------- trial
export const TRIAL_OFFER = {
  days: 14,
  limits: {
    users: 25,
    aiProcessings: 10,
    voiceMinutes: 15,
    storageMb: 1024,
  },
  /** Všetky hlavné moduly (okrem eFaktúry, ktorá nie je live). */
  includesAllModules: true,
  includesInvoicing: true,
  includesVoice: true,
  includesChat: true,
  /** eFaktúra počas trialu: žiadne live transakcie. */
  einvoiceLiveTransactions: false,
  paymentCardRequired: false,
  /** Po skončení trialu sa dáta nikdy nemažú. */
  dataDeletedAfterTrial: false,
} as const;

// ----------------------------------------------------------------------------- engine
export type PriceTier = "primary" | "secondary";
export type PlanKind = "complete" | "modular";
export type AddonCounts = Partial<Record<AddonId, number>>;

export type QuoteInput = {
  /** Vybrané základné moduly (pri `complete` sa ignorujú — Komplet obsahuje všetky). */
  modules: readonly BaseModuleId[];
  /** Zákazník výslovne zvolil Komplet. */
  complete?: boolean;
  /** primary = prvá platená firma ownera; secondary = každá ďalšia firma toho istého ownera. */
  tier: PriceTier;
  addons?: AddonCounts;
  /** eFaktúra predajná? (false, kým EINVOICE_LIVE_STATUS nie je live) */
  einvoiceAvailable?: boolean;
};

export type QuoteLine = { id: string; kind: "module" | "complete" | "addon"; unitCents: number; quantity: number; totalCents: number };

export type Quote = {
  plan: PlanKind;
  tier: PriceTier;
  /** Moduly, ktoré firma reálne dostane (pri Komplete všetky predajné). */
  modules: BaseModuleId[];
  /** Súčet samostatných modulov (pred stropom). */
  modulesSubtotalCents: number;
  /** Cena Kompletu pre túto firmu (= strop modulov). */
  capCents: number;
  /** Cena základného balíka po strope. */
  baseCents: number;
  /** Súčet modulov by prekročil strop → Komplet je výhodnejší (vyžaduje potvrdenie zákazníka). */
  upgradeToCompleteRecommended: boolean;
  addonLines: QuoteLine[];
  addonsCents: number;
  totalCents: number;
  lines: QuoteLine[];
  /** Neplatné add-ony (napr. AI balík bez modulu Dokumenty) — nezapočítané. */
  rejectedAddons: AddonId[];
};

export function completePriceCents(tier: PriceTier): number {
  return tier === "secondary" ? SECONDARY_COMPLETE_PRICE_CENTS : COMPLETE_PRICE_CENTS;
}

export function sellableModules(einvoiceAvailable = false): BaseModuleId[] {
  return BASE_MODULE_IDS.filter((m) => m !== "einvoice" || einvoiceAvailable);
}

function normalizeModules(modules: readonly BaseModuleId[], einvoiceAvailable: boolean): BaseModuleId[] {
  const allowed = new Set(sellableModules(einvoiceAvailable));
  return BASE_MODULE_IDS.filter((m) => modules.includes(m) && allowed.has(m));
}

function packs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_ADDON_PACKS);
}

/**
 * Jediný výpočet ceny. Zákazník nikdy neplatí za základné moduly viac než
 * cena Kompletu pre svoju firmu (strop); add-ony idú navrch.
 */
export function quote(input: QuoteInput): Quote {
  const einvoiceAvailable = input.einvoiceAvailable === true;
  const capCents = completePriceCents(input.tier);
  const selected = normalizeModules(input.modules, einvoiceAvailable);
  const modulesSubtotalCents = selected.length * MODULE_PRICE_CENTS;
  const overCap = modulesSubtotalCents > capCents;
  const plan: PlanKind = input.complete === true || overCap ? "complete" : "modular";
  const modules = plan === "complete" ? sellableModules(einvoiceAvailable) : selected;
  const baseCents = plan === "complete" ? capCents : modulesSubtotalCents;

  const addonLines: QuoteLine[] = [];
  const rejectedAddons: AddonId[] = [];
  for (const id of ADDON_IDS) {
    const quantity = packs(input.addons?.[id]);
    if (quantity === 0) continue;
    const def = ADDONS[id];
    const moduleOk = def.requiresModule === null || modules.includes(def.requiresModule);
    if (!moduleOk) {
      rejectedAddons.push(id);
      continue;
    }
    addonLines.push({ id, kind: "addon", unitCents: def.priceCents, quantity, totalCents: def.priceCents * quantity });
  }
  const addonsCents = addonLines.reduce((sum, l) => sum + l.totalCents, 0);

  const baseLines: QuoteLine[] =
    plan === "complete"
      ? [{ id: input.tier === "secondary" ? "complete_secondary" : "complete", kind: "complete", unitCents: capCents, quantity: 1, totalCents: capCents }]
      : selected.map((m) => ({ id: m, kind: "module" as const, unitCents: MODULE_PRICE_CENTS, quantity: 1, totalCents: MODULE_PRICE_CENTS }));

  return {
    plan,
    tier: input.tier,
    modules,
    modulesSubtotalCents,
    capCents,
    baseCents,
    upgradeToCompleteRecommended: plan === "modular" ? false : input.complete !== true && overCap,
    addonLines,
    addonsCents,
    totalCents: baseCents + addonsCents,
    lines: [...baseLines, ...addonLines],
    rejectedAddons,
  };
}

/**
 * Náhľad pred pridaním modulu (bod 4 zadania). Ak by súčet modulov presiahol
 * strop, UI musí ukázať odporúčanie Kompletu a čakať na potvrdenie — nič sa
 * neprepína automaticky.
 */
export function previewAddModule(current: Omit<QuoteInput, "complete">, module: BaseModuleId) {
  const before = quote(current);
  const nextModules = Array.from(new Set([...current.modules, module]));
  const rawCents = normalizeModules(nextModules, current.einvoiceAvailable === true).length * MODULE_PRICE_CENTS;
  const after = quote({ ...current, modules: nextModules });
  return {
    before,
    after,
    /** Matematický súčet modulov po pridaní (napr. 19,50 €). */
    modulesSumAfterCents: rawCents,
    exceedsCap: rawCents > after.capCents,
    /** Cena, ktorú zákazník zaplatí po potvrdení Kompletu. */
    completeCents: after.capCents,
  };
}

// ----------------------------------------------------------------------------- entitlement targets (SQL parita)
export type EntitlementTarget = { key: string; limit: number | null; period: "month" | null };

/**
 * Nároky, ktoré firma dostane z plánu + add-onov. Zrkadlo SQL
 * public.esblu_plan_entitlement_targets(...). Limity sú per firma (nikdy
 * nezdieľané medzi firmami). Kľúče zoradené abecedne.
 */
export function entitlementTargets(input: { plan: PlanKind; modules: readonly BaseModuleId[]; addons?: AddonCounts; einvoiceAvailable?: boolean }): EntitlementTarget[] {
  const einvoiceAvailable = input.einvoiceAvailable === true;
  const modules = input.plan === "complete" ? sellableModules(einvoiceAvailable) : normalizeModules(input.modules, einvoiceAvailable);
  const a = (id: AddonId) => packs(input.addons?.[id]);
  const out: EntitlementTarget[] = [];
  for (const m of modules) if (m !== "documents") out.push({ key: MODULE_ENTITLEMENT[m], limit: null, period: null });

  const hasDocs = modules.includes("documents");
  const includedAi = input.plan === "complete" ? COMPLETE_ALLOWANCES.aiProcessingsPerMonth : MODULAR_ALLOWANCES.aiProcessingsPerMonthWithDocuments;
  if (hasDocs) out.push({ key: "ai_documents", limit: includedAi + 40 * a("ai_40"), period: "month" });

  const includedVoice = input.plan === "complete" ? COMPLETE_ALLOWANCES.voiceMinutesPerMonth : MODULAR_ALLOWANCES.voiceMinutesPerMonth;
  const voiceMinutes = includedVoice + 60 * a("voice_60");
  if (voiceMinutes > 0) {
    out.push({ key: "voice", limit: null, period: null });
    out.push({ key: "voice_minutes", limit: voiceMinutes, period: "month" });
  }

  // Každá platená firma (Komplet aj moduly): 25 používateľov + 5 GB.
  out.push({ key: "team_members", limit: MODULAR_ALLOWANCES.users + 25 * a("users_25"), period: null });
  out.push({ key: "storage_mb", limit: MODULAR_ALLOWANCES.storageMb, period: null });

  if (modules.includes("einvoice")) {
    out.push({ key: "einvoice_transactions", limit: COMPLETE_ALLOWANCES.einvoiceTransactionsPerMonth + 40 * a("einvoice_40") + 100 * a("einvoice_100"), period: "month" });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

// ----------------------------------------------------------------------------- formatting
/** „15,90 €“ (sk/de) / „€15.90“ (en). Bez textu o DPH. */
export function formatEurCents(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale === "en" ? "en-IE" : locale === "de" ? "de-DE" : "sk-SK", {
    style: "currency",
    currency: PRICING_CURRENCY,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/** Spätná kompatibilita (sumy v EUR). */
export function formatEur(value: number, locale: string): string {
  return formatEurCents(Math.round(value * 100), locale);
}
