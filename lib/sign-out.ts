// =============================================================================
// Odhlásenie na tomto zariadení (Mobile M1) — spoločný postup pre všetky
// vstupy do odhlásenia v novom kóde: najprv odregistrovať push notifikácie
// tohto zariadenia (ak sú zapnuté), potom Supabase signOut.
// =============================================================================

import { supabase } from "@/lib/supabase";
import { disablePushOnThisDevice } from "@/lib/push/client";

export async function signOutOnThisDevice(): Promise<void> {
  try {
    await disablePushOnThisDevice();
  } catch {
    // Push nemusí byť zapnutý/podporovaný — odhlásenie nesmie zlyhať kvôli nemu.
  }
  await supabase.auth.signOut();
}
