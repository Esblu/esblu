"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { parseCompanyEntitlements, type CompanyEntitlements, type EntitlementKey } from "@/lib/entitlements";

// =============================================================================
// Nároky firmy pre UI (zobrazenie, skrytie mikrofónu, upozornenia).
//
// TOTO NIE JE BEZPEČNOSTNÁ HRANICA — rozhoduje server/DB (transcribe route,
// intent route, DB triggery, esblu_reserve_ai_processing). UI iba nezobrazí
// ovládanie, ktoré by server aj tak odmietol. Pri chybe/načítavaní UI
// predpokladá „bez nároku" (platené ovládanie sa nezobrazí).
//
// Jedno načítanie na prihlásenie (zdieľané medzi komponentmi), obnoví sa pri
// zmene session. Žiadne ukladanie do localStorage.
// =============================================================================

type State = { loading: boolean; snapshot: CompanyEntitlements | null };

let cache: { userId: string; promise: Promise<CompanyEntitlements | null> } | null = null;

async function load(userId: string): Promise<CompanyEntitlements | null> {
  if (cache?.userId === userId) return cache.promise;
  const promise = (async () => {
    const { data, error } = await supabase.rpc("esblu_get_my_company_entitlements");
    return error ? null : parseCompanyEntitlements(data);
  })().catch(() => null);
  cache = { userId, promise };
  return promise;
}

export function invalidateCompanyEntitlements(): void {
  cache = null;
}

export function useCompanyEntitlements(): State & { has: (key: EntitlementKey) => boolean } {
  const [state, setState] = useState<State>({ loading: true, snapshot: null });

  useEffect(() => {
    let cancelled = false;

    const refresh = async (userId: string | null) => {
      if (!userId) {
        cache = null;
        if (!cancelled) setState({ loading: false, snapshot: null });
        return;
      }
      const snapshot = await load(userId);
      if (!cancelled) setState({ loading: false, snapshot });
    };

    void supabase.auth.getSession().then(({ data }) => refresh(data.session?.user.id ?? null));
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cache && cache.userId !== session?.user.id) cache = null;
      void refresh(session?.user.id ?? null);
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return {
    ...state,
    has: (key) => state.snapshot?.items[key]?.active === true,
  };
}
