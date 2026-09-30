"use client";

import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { refreshPushRegistration } from "@/lib/push/client";

// -----------------------------------------------------------------------------
// Po prihlásení / štarte appky obnoví väzbu UŽ ZAPNUTÉHO push zariadenia na
// aktuálnu auth session (web push aj natívny token). Nikdy nežiada povolenie
// ani nič nezapína — iba zopakuje idempotentnú registráciu, ak zariadenie
// odber už má. Server doručuje iba zariadeniam so živou session, takže bez
// tejto obnovy by zariadenie po novom prihlásení (napr. po vypršaní alebo
// revokácii session) ostalo nemé.
// -----------------------------------------------------------------------------

const refreshedSessions = new Set<string>();

export default function PushRegistrationSync() {
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== "SIGNED_IN" && event !== "INITIAL_SESSION") return;
      const key = session?.user?.id && session.access_token ? `${session.user.id}:${session.access_token.slice(-16)}` : null;
      if (!key || refreshedSessions.has(key)) return;
      refreshedSessions.add(key);
      // Mimo callbacku auth (Supabase odporúča žiadne await vnútri).
      setTimeout(() => void refreshPushRegistration(), 0);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  return null;
}
