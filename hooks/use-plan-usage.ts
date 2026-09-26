"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isPlanUsageLimited, type Plan, type PlanResource } from "@/lib/plan-limits";
import { parseCompanyEntitlements, type EntitlementKey } from "@/lib/entitlements";
import { invalidateCompanyEntitlements } from "@/hooks/use-company-entitlements";
import { supabase } from "@/lib/supabase";

// =============================================================================
// UI prehľad limitu jedného zdroja (Vozidlá / Stroje / Sklad / Inbox AI).
//
// ZDROJ PRAVDY od 20260928100000: nároky firmy (esblu_get_my_company_entitlements
// → trial 14 dní + platené moduly), nie companies.plan ani plan_limits.
// Toto je IBA zobrazenie — limit vynucuje DB trigger / AI ledger. Pri
// chybe načítania sa vytváranie v UI zablokuje (fail closed), čítanie nie.
//
// ai_evidence = AI spracovania dokumentov (kvóta, nie počet uložených
// riadkov): usage = spotrebované trial spracovania, limit = trial limit
// alebo mesačný limit plateného modulu (null = bez limitu).
// =============================================================================

export type PlanUsageSnapshot = {
  /** Odvodené iba na zobrazenie: 'free' = trial/bez modulu, 'pro' = platený/ručný nárok. */
  plan: Plan;
  usage: number;
  limit: number | null;
  isLimited: boolean;
};

export type PlanUsageResult = PlanUsageSnapshot & {
  loading: boolean;
  error: string | null;
  refresh: () => Promise<PlanUsageSnapshot | null>;
};

const RESOURCE_KEY: Record<PlanResource, EntitlementKey> = {
  vehicles: "vehicles",
  machines: "machines",
  inventory_items: "inventory",
  ai_evidence: "ai_documents",
};

const BLOCKED: PlanUsageSnapshot = { plan: "free", usage: 0, limit: 0, isLimited: true };

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Nepodarilo sa načítať dostupnosť modulu.";
}

export function usePlanUsage(resource: PlanResource): PlanUsageResult {
  const [snapshot, setSnapshot] = useState<PlanUsageSnapshot>(BLOCKED);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (!session) throw new Error("Používateľ nie je prihlásený.");

      invalidateCompanyEntitlements();
      const { data, error: rpcError } = await supabase.rpc("esblu_get_my_company_entitlements");
      if (rpcError) throw rpcError;
      const entitlements = parseCompanyEntitlements(data);
      if (!entitlements) throw new Error("Nečitateľný stav nárokov firmy.");

      const item = entitlements.items[RESOURCE_KEY[resource]];
      let usage = 0;

      if (resource === "ai_evidence") {
        // Kvóta AI spracovaní. Počty mimo trialu (mesačné) nie sú v UI
        // prehľade — server ich vynúti pri rezervácii.
        usage = item.source === "trial" ? entitlements.trial.aiProcessingUsed : 0;
      } else {
        const { count, error: countError } = await supabase
          .from(resource)
          .select("id", { count: "exact", head: true })
          .eq("company_id", entitlements.companyId);
        if (countError) throw countError;
        usage = count ?? 0;
      }

      const limit = item.active ? item.limit : 0;
      const next: PlanUsageSnapshot = {
        plan: item.active && item.source !== "trial" ? "pro" : "free",
        usage,
        limit,
        isLimited: !item.active || isPlanUsageLimited(usage, limit),
      };

      if (requestId !== requestIdRef.current) return null;
      setSnapshot(next);
      return next;
    } catch (loadError: unknown) {
      if (requestId !== requestIdRef.current) return null;
      setSnapshot(BLOCKED);
      setError(getErrorMessage(loadError));
      return null;
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [resource]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
      requestIdRef.current += 1;
    };
  }, [refresh]);

  const isLimited = useMemo(
    () => snapshot.isLimited || isPlanUsageLimited(snapshot.usage, snapshot.limit),
    [snapshot]
  );

  return { ...snapshot, isLimited, loading, error, refresh };
}
