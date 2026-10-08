// =============================================================================
// Odhlásenie na tomto zariadení — JEDINÝ postup pre všetky vstupy do
// odhlásenia (web aj mobile, Mobile Platform 2026-10-08):
//   1. odregistrovať push notifikácie tohto zariadenia (ak sú zapnuté),
//   2. vyčistiť lokálne artefakty relácie (jednorazový OAuth stav,
//      sessionStorage prefill formulárov) — nie jazyk ani installationId,
//   3. Supabase signOut + v natívnej appke vyčistenie Keystore/Keychain
//      (aj pri zlyhaní servera — lokálne odhlásenie má prednosť).
// Žiadny krok nesmie zablokovať odhlásenie.
// =============================================================================

import { mobileAuthStorage, supabase } from "@/lib/supabase";
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
  try {
    await supabase.auth.signOut();
  } finally {
    // Natívna appka: Keystore/Keychain musí byť prázdny aj keď server
    // signOut zlyhá (offline) — lokálne odhlásenie má vždy prednosť.
    await mobileAuthStorage?.clearAll().catch(() => undefined);
  }
}
