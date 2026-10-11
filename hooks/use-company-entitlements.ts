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

type State = { loading: boolean; snapshot: CompanyEntitlements | null; error: boolean };

type LoadResult = { snapshot: CompanyEntitlements | null; error: boolean };

let cache: { userId: string; promise: Promise<LoadResult> } | null = null;

async function load(userId: string): Promise<LoadResult> {
  if (cache?.userId === userId) return cache.promise;
  const promise = (async (): Promise<LoadResult> => {
    const { data, error } = await supabase.rpc("esblu_get_my_company_entitlements");
    if (error) return { snapshot: null, error: true };
    return { snapshot: parseCompanyEntitlements(data), error: false };
  })().catch((): LoadResult => ({ snapshot: null, error: true }));
  cache = { userId, promise };
  // Chyba sa necachuje — ďalší pokus (retry) sa spýta servera znova.
  void promise.then((result) => {
    if (result.error && cache?.promise === promise) cache = null;
  });
  return promise;
}

export function invalidateCompanyEntitlements(): void {
  cache = null;
}

export function useCompanyEntitlements(): State & { has: (key: EntitlementKey) => boolean; retry: () => void } {
  const [state, setState] = useState<State>({ loading: true, snapshot: null, error: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const refresh = async (userId: string | null) => {
      if (!userId) {
        cache = null;
        if (!cancelled) setState({ loading: false, snapshot: null, error: false });
        return;
      }
      const result = await load(userId);
      if (!cancelled) setState({ loading: false, snapshot: result.snapshot, error: result.error });
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
  }, [attempt]);

  return {
    ...state,
    has: (key) => state.snapshot?.items[key]?.active === true,
    retry: () => {
      cache = null;
      setState((current) => ({ ...current, loading: true, error: false }));
      setAttempt((value) => value + 1);
    },
  };
}
