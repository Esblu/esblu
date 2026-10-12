"use client";

// =============================================================================
// Zdieľané aktívne členstvo prihláseného používateľa (Mobile M1) — pre
// navigáciu a vstup do asistenta. Jeden dotaz na používateľa (cache podľa
// userId), obnova pri zmene prihlásenia. Iba UX: autorizáciu robí server.
// =============================================================================

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getMyActiveMembership, type MyActiveMembership } from "@/lib/company";

let cache: { userId: string; promise: Promise<MyActiveMembership | null> } | null = null;

function loadFor(userId: string): Promise<MyActiveMembership | null> {
  if (cache?.userId === userId) return cache.promise;
  const promise = getMyActiveMembership().catch(() => null);
  const entry = { userId, promise };
  cache = entry;
  // RC 2026-10-12: null = „bez firmy" ALEBO sieťová chyba (getMyActiveMembership
  // ich nerozlišuje) → necachuje sa, inak offline štart skryje firemnú navigáciu
  // až do reštartu appky. Úspešné členstvo ostáva v cache.
  void promise.then((membership) => {
    if (!membership && cache === entry) cache = null;
  });
  return promise;
}

/** Multi-company: po prepnutí / opustení firmy sa členstvo načíta nanovo. */
export function resetActiveMembershipCache(): void {
  cache = null;
}

export type ActiveMembershipState = {
  loading: boolean;
  signedIn: boolean;
  membership: MyActiveMembership | null;
};

export function useActiveMembership(): ActiveMembershipState {
  const [state, setState] = useState<ActiveMembershipState>({ loading: true, signedIn: false, membership: null });

  useEffect(() => {
    let active = true;

    async function resolve(userId: string | null) {
      if (!userId) {
        cache = null;
        if (active) setState({ loading: false, signedIn: false, membership: null });
        return;
      }
      const membership = await loadFor(userId);
      if (active) setState({ loading: false, signedIn: true, membership });
    }

    void supabase.auth.getSession().then(({ data }) => resolve(data.session?.user.id ?? null));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      void resolve(session?.user.id ?? null);
    });
    // Po návrate siete znova (z cache, ak už bola úspešná — žiadny extra dotaz).
    const onOnline = () => {
      void supabase.auth.getSession().then(({ data }) => resolve(data.session?.user.id ?? null));
    };
    window.addEventListener("online", onOnline);
    return () => {
      active = false;
      data.subscription.unsubscribe();
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return state;
}
