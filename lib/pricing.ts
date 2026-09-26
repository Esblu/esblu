// =============================================================================
// Esblu — CENTRÁLNA konfigurácia cenníka (jediné miesto s cenami a limitmi,
// ktoré vidí zákazník). Stránka /cennik a sekcia na úvodnej stránke čítajú
// VÝHRADNE odtiaľto — žiadne ceny natvrdo v komponentoch.
//
// ⚠️ STAV: PROVIZÓRNY NÁVRH — čaká na finálne obchodné schválenie majiteľom.
//    Ceny NIE SÚ právne ani obchodne schválené. Žiadna fakturácia/platba sa
//    na ne neviaže (billing provider neexistuje). Zmena ceny = zmena tu.
//
// Limity skúšobnej verzie MUSIA sedieť s DB katalógom nárokov
// (supabase/migrations/20260928100000_company_entitlements_trial.sql →
// entitlement_catalog). Test scripts/plan-entitlements-tests.ts to overuje.
// =============================================================================

export const PRICING_APPROVAL_STATUS = "provisional" as const;

/**
 * PROVIZÓRNE: zahrnuté AI spracovania dokumentov / mesiac v platenom module
 * AI evidencia. Konzervatívna pracovná hodnota — zmena na 75/100 = zmena
 * iba tohto čísla (stránka aj test ho čítajú odtiaľto). Operátor ho
 * nastavuje aj v company_entitlements.limit_value (limit_period='month').
 * Trial má samostatný limit (TRIAL_OFFER.limits.aiProcessings = 5 spolu).
 */
export const AI_DOCUMENTS_MONTHLY_ALLOWANCE = 50;
export const PRICING_CURRENCY = "EUR" as const;
export const PRICING_VAT_NOTE = "excl_vat" as const;

export type PricingModuleId =
  | "invoicing"
  | "ai_documents"
  | "vehicles"
  | "machines"
  | "inventory"
  | "voice";

export type PricingAvailability = "available" | "coming_soon";

export type PricingModule = {
  id: PricingModuleId;
  /** Kľúč nároku v DB (company_entitlements.entitlement_key). Zákaznícky názov je v i18n (pricing.modules.items.<id>.name). */
  entitlementKey: PricingModuleId;
  /** Mesačná cena za firmu bez DPH (EUR). null = cena ešte nie je stanovená. */
  monthlyPriceExclVat: number | null;
  /** Voliteľná ročná cena (EUR bez DPH). null = zatiaľ neponúkame. */
  annualPriceExclVat: number | null;
  /** Zahrnuté použitie za mesiac (napr. AI spracovania). null = bez kvantitatívneho limitu. */
  includedMonthlyUsage: number | null;
  availability: PricingAvailability;
  /** Voliteľné doplnky (napr. balík AI spracovaní) — zatiaľ bez ceny. */
  addOns: { id: string; priceExclVat: number | null; units: number | null }[];
};

/** Poradie = poradie kariet na stránke. */
export const PRICING_MODULES: readonly PricingModule[] = [
  { id: "invoicing", entitlementKey: "invoicing", monthlyPriceExclVat: 5.9, annualPriceExclVat: null, includedMonthlyUsage: null, availability: "available", addOns: [] },
  {
    id: "ai_documents",
    entitlementKey: "ai_documents",
    monthlyPriceExclVat: 9.9,
    annualPriceExclVat: null,
    includedMonthlyUsage: AI_DOCUMENTS_MONTHLY_ALLOWANCE,
    availability: "available",
    addOns: [{ id: "ai_documents_pack", priceExclVat: null, units: 100 }],
  },
  { id: "vehicles", entitlementKey: "vehicles", monthlyPriceExclVat: 5.9, annualPriceExclVat: null, includedMonthlyUsage: null, availability: "available", addOns: [] },
  { id: "machines", entitlementKey: "machines", monthlyPriceExclVat: 5.9, annualPriceExclVat: null, includedMonthlyUsage: null, availability: "available", addOns: [] },
  { id: "inventory", entitlementKey: "inventory", monthlyPriceExclVat: 5.9, annualPriceExclVat: null, includedMonthlyUsage: null, availability: "available", addOns: [] },
  { id: "voice", entitlementKey: "voice", monthlyPriceExclVat: 6.9, annualPriceExclVat: null, includedMonthlyUsage: null, availability: "available", addOns: [] },
];

/**
 * 14-dňová skúšobná verzia firmy — zrkadlo DB katalógu (overené testom).
 * ROZHODNUTIE: trial obsahuje Fakturáciu (bez limitu počtu faktúr).
 */
export const TRIAL_OFFER = {
  days: 14,
  limits: {
    users: 1,
    vehicles: 2,
    machines: 2,
    inventoryItems: 5,
    aiProcessings: 5,
  },
  includesInvoicing: true,
  includesVoice: false,
  paymentCardRequired: false,
} as const;

export function modulePrice(id: PricingModuleId): number | null {
  return PRICING_MODULES.find((m) => m.id === id)?.monthlyPriceExclVat ?? null;
}

/**
 * Informatívny súčet (bez DPH). Počíta v centoch, aby 5,90 + 6,90 bolo
 * presne 12,80. Nič neaktivuje a nič neúčtuje.
 */
export function monthlyTotalExclVat(selected: readonly PricingModuleId[]): number {
  const unique = Array.from(new Set(selected));
  const cents = unique.reduce((sum, id) => {
    const price = modulePrice(id);
    return price === null ? sum : sum + Math.round(price * 100);
  }, 0);
  return cents / 100;
}

export function formatEur(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale === "sk" ? "sk-SK" : locale === "de" ? "de-DE" : "en-IE", {
    style: "currency",
    currency: PRICING_CURRENCY,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
