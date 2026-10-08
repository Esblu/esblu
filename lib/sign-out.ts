// =============================================================================
// Odhlásenie na tomto zariadení — JEDINÝ postup pre všetky vstupy do
// odhlásenia (web aj mobile, Mobile Platform 2026-10-08):
//   1. odregistrovať push notifikácie tohto zariadenia (ak sú zapnuté),
//   2. vyčistiť lokálne artefakty relácie (jednorazový OAuth stav,
//      sessionStorage prefill formulárov) — nie jazyk ani installationId,
//   3. Supabase signOut (zmaže session z localStorage WebView/prehliadača).
// Žiadny krok nesmie zablokovať odhlásenie.
// =============================================================================

import { supabase } from "@/lib/supabase";
import { disablePushOnThisDevice } from "@/lib/push/client";

/** Kľúče localStorage viazané na reláciu (nie na zariadenie). */
export const SESSION_SCOPED_LOCAL_KEYS = ["esblu.oauthPending.v1"] as const;

export function clearSessionArtifacts(storage: { local?: Storage | null; session?: Storage | null } = {}): void {
  const local = storage.local ?? (typeof window !== "undefined" ? window.localStorage : null);
  const session = storage.session ?? (typeof window !== "undefined" ? window.sessionStorage : null);
  try {
    for (const key of SESSION_SCOPED_LOCAL_KEYS) local?.removeItem(key);
  } catch {
    // úložisko nedostupné
  }
  try {
    session?.clear();
  } catch {
    // úložisko nedostupné
  }
}

export async function signOutOnThisDevice(): Promise<void> {
  try {
    await disablePushOnThisDevice();
  } catch {
    // Push nemusí byť zapnutý/podporovaný — odhlásenie nesmie zlyhať kvôli nemu.
  }
  clearSessionArtifacts();
  await supabase.auth.signOut();
}
