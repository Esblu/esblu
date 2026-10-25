// =============================================================================
// Úložisko firmy — predkontrola pred uploadom (pricing + entitlements, 2026-10-26).
//
// Tvrdá brána je v DB (RESTRICTIVE politika esblu_storage_company_capacity na
// storage.objects) — tá zlyhá aj bez tejto predkontroly. Predkontrola iba
// zabezpečí, že používateľ nedostane tiché/generické zlyhanie, ale jasný
// stav LIMIT_REACHED (využité / zahrnuté) cez app dialóg. Existujúce súbory
// sa nikdy nemažú.
// =============================================================================
import { supabase } from "@/lib/supabase";
import { notify } from "@/lib/app-dialog";
import { parseEntitlementDenial, limitReachedFrom } from "@/lib/entitlements";
import { translate } from "@/lib/i18n/translate";
import { LOCALE_STORAGE_KEY, normalizeLocale } from "@/lib/i18n/locales";

export class StorageLimitReachedError extends Error {
  readonly code = "LIMIT_REACHED";
  constructor(readonly usedMb: number | null, readonly includedMb: number | null) {
    super("STORAGE_LIMIT_REACHED");
    this.name = "StorageLimitReachedError";
  }
}

function currentLocale() {
  try {
    return normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return normalizeLocale(null);
  }
}

function formatGb(mb: number | null, locale: string): string {
  if (mb === null) return "?";
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(mb / 1024)} GB`;
}

/**
 * Pred každým uploadom do firemného úložiska. Vyčerpané → dialóg + výnimka
 * (volajúci flow sa zastaví). Nečitateľný stav → nechá rozhodnúť DB bránu.
 */
export async function assertStorageCapacity(): Promise<void> {
  const { error } = await supabase.rpc("esblu_require_my_storage_capacity");
  if (!error) return;
  const limit = limitReachedFrom(parseEntitlementDenial(error));
  if (!limit) return;
  const locale = currentLocale();
  await notify({
    tone: "error",
    title: translate(locale, "entitlements.limitReached.title"),
    message: `${translate(locale, "entitlements.reasons.STORAGE_LIMIT_REACHED")} ${translate(locale, "entitlements.limitReached.usage", {
      used: formatGb(limit.used, locale),
      included: formatGb(limit.included, locale),
    })}`,
  });
  throw new StorageLimitReachedError(limit.used, limit.included);
}
