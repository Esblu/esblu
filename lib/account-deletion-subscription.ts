// =============================================================================
// Zrušenie účtu × predplatné — serverové čítanie stavu (SERVER ONLY,
// service_role klient). Rozhodnutie robí čistá funkcia evaluateDeletionGuard
// (lib/billing/deletion-guard.ts); tu je iba načítanie dát.
//
// Fail closed: chyba čítania subscription_accounts / billing_checkout_sessions
// = SUBSCRIPTION_STATE_UNVERIFIED (nič sa nemaže). Výnimka: billing schéma
// v databáze vôbec neexistuje (produkcia pred migráciou 20261008120000) —
// vtedy firma predplatné mať nemôže → bez blokácie.
// Nikdy sa nevolá provider API (žiadne live zrušenie predplatného).
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateDeletionGuard, type SubscriptionAccountSnapshot, type SubscriptionDeletionCheck } from "@/lib/billing/deletion-guard";

type QueryError = { code?: string | null; message?: string | null } | null;

/** Tabuľka billing schémy neexistuje (PostgREST schema cache / Postgres undefined_table). */
export function isMissingBillingSchemaError(error: QueryError): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /could not find the table|relation .* does not exist/i.test(error.message ?? "");
}

export async function checkSubscriptionForDeletion(
  admin: SupabaseClient,
  params: { companyId: string; userId: string; scope: "company" | "member" },
  now: Date = new Date()
): Promise<SubscriptionDeletionCheck> {
  const { companyId, userId, scope } = params;

  const accountRes = await admin
    .from("subscription_accounts")
    .select("status, billing_provider, cancel_at_period_end, current_period_end")
    .eq("company_id", companyId)
    .maybeSingle();

  if (accountRes.error && !isMissingBillingSchemaError(accountRes.error)) {
    console.error("account-deletion/subscription: subscription_accounts zlyhalo:", accountRes.error.code ?? "unknown");
    return evaluateDeletionGuard({ account: null, openCheckoutProvider: null, scope, readFailed: true });
  }
  const billingInstalled = !accountRes.error;
  const account = (accountRes.data as SubscriptionAccountSnapshot | null) ?? null;

  let openCheckoutProvider: string | null = null;
  let memberIsStorePurchaser = false;

  if (billingInstalled) {
    if (scope === "company") {
      const checkoutRes = await admin
        .from("billing_checkout_sessions")
        .select("provider")
        .eq("company_id", companyId)
        .in("status", ["created", "open"])
        .gt("expires_at", now.toISOString())
        .limit(1);
      if (checkoutRes.error) {
        console.error("account-deletion/subscription: billing_checkout_sessions zlyhalo:", checkoutRes.error.code ?? "unknown");
        return evaluateDeletionGuard({ account, openCheckoutProvider: null, scope, readFailed: true });
      }
      openCheckoutProvider = (checkoutRes.data as { provider: string }[] | null)?.[0]?.provider ?? null;
    } else if (account?.billing_provider === "google" || account?.billing_provider === "apple") {
      // Store predplatné je viazané na účet obchodu toho, kto ho kúpil.
      const purchaserRes = await admin
        .from("billing_checkout_sessions")
        .select("created_by")
        .eq("company_id", companyId)
        .eq("provider", account.billing_provider)
        .eq("status", "completed")
        .order("completed_at", { ascending: false, nullsFirst: false })
        .limit(1);
      if (purchaserRes.error) {
        console.error("account-deletion/subscription: purchaser lookup zlyhalo:", purchaserRes.error.code ?? "unknown");
        return evaluateDeletionGuard({ account, openCheckoutProvider: null, scope, readFailed: true });
      }
      memberIsStorePurchaser = (purchaserRes.data as { created_by: string }[] | null)?.[0]?.created_by === userId;
    }
  }

  // Informačný kontext (Esblu trial) — neblokuje, chyba sa ignoruje. Manuálne
  // granty (company_entitlements) sa tu zámerne nečítajú: aplikačný kód do
  // entitlement tabuliek nesiaha (test plan-entitlements); grant nikdy neblokuje.
  let trialActive = false;
  if (scope === "company") {
    const companyRes = await admin.from("companies").select("trial_ends_at").eq("id", companyId).maybeSingle();
    const trialEndsAt = (companyRes.data as { trial_ends_at?: string | null } | null)?.trial_ends_at ?? null;
    trialActive = !companyRes.error && !!trialEndsAt && new Date(trialEndsAt).getTime() > now.getTime();
  }

  return evaluateDeletionGuard({ account, openCheckoutProvider, scope, memberIsStorePurchaser, trialActive });
}
