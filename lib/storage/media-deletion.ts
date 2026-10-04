// =============================================================================
// Dokončenie mazania súborov médií (fotky vozidiel, strojov, skladu, logá).
//
// MODEL (migrácie 20261005090000 + 20261005091000):
//   1. Appka zmaže DB záznam (fotku, celé vozidlo/stroj/položku, alebo zmení
//      logo). Trigger v TEJ ISTEJ transakcii zapíše súbor do
//      public.media_deletion_queue — súbor tak nikdy neostane bez evidencie.
//   2. Táto funkcia zavolá esblu_media_deletion_sweep(): server vráti súbory
//      mojej firmy, ktoré smiem zmazať (owner/admin, pri logu finance.manage)
//      — aj keď ich nahral iný člen firmy.
//   3. Zmaže ich cez Storage API (ako prihlásený používateľ, žiadny
//      service_role) a znova zavolá sweep, ktorý overí, že v úložisku už nie
//      sú, a položky uzavrie.
//   Zlyhanie v kroku 3 nič nestratí: položka ostáva vo fronte a pri ďalšom
//   volaní (napr. pri otvorení nástenky) sa zopakuje. Opakovanie je bezpečné.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export type MediaDeletionResult = {
  /** Koľko súborov sa v tomto behu pokúsilo zmazať. */
  attempted: number;
  /** Koľko súborov ostáva vo fronte (0 = všetko hotové; -1 = server nedostupný). */
  remaining: number;
};

type PendingRow = { bucket_id: string; object_path: string };

/** Zoskupí čakajúce súbory podľa bucketu (čistá funkcia — testovateľná). */
export function groupPendingByBucket(rows: readonly PendingRow[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    if (!row?.bucket_id || !row?.object_path) continue;
    (out[row.bucket_id] ??= []).push(row.object_path);
  }
  return out;
}

export async function flushMediaDeletions(client: SupabaseClient, limit = 100): Promise<MediaDeletionResult> {
  const first = await client.rpc("esblu_media_deletion_sweep", { p_limit: limit });
  if (first.error) return { attempted: 0, remaining: -1 };

  const pending = (first.data ?? []) as PendingRow[];
  if (pending.length === 0) return { attempted: 0, remaining: 0 };

  for (const [bucket, paths] of Object.entries(groupPendingByBucket(pending))) {
    // Chyba jednotlivého bucketu nezastaví ostatné; výsledok overí server.
    await client.storage.from(bucket).remove(paths);
  }

  const second = await client.rpc("esblu_media_deletion_sweep", { p_limit: limit });
  if (second.error) return { attempted: pending.length, remaining: -1 };
  return { attempted: pending.length, remaining: ((second.data ?? []) as PendingRow[]).length };
}
