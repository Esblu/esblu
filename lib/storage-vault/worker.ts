// =============================================================================
// Trezor súborov (návrh, SERVER ONLY) — prevádzkové kópie súborov v buckete esblu-file-vault
// v tom istom Supabase projekte. NIE je nezávislá záloha ani zákonný archív.
// SQL: supabase/proposals/storage_vault_proposal.sql. Testy: scripts/ops/storage-vault-*-tests.ts.
//
//   drainVaultQueue  — cron každú minútu: fronta z triggera -> serverová Storage kópia -> overenie v DB
//   reconcileVault   — cron každú hodinu: doplní chýbajúce kópie, označí zmazané originály, poistka hromadného zmazania
//   purgeVault       — po lehote (8 dní bežné zmazanie / 0 dní definitívny výmaz), limit na beh
//   eraseVaultCopies — definitívny výmaz z cleanup jobu (zrušenie účtu / ukončenie firmy) s tými istými cieľmi
//   restoreFromVault — obnova operátorom (bucket + prefix + čas), nikdy neprepíše existujúci súbor
// Do logov a odpovedí idú iba počty a kódy (žiadne cesty ani mená súborov).
// =============================================================================

export const VAULT_BUCKET = "esblu-file-vault";

export type VaultTarget = { bucket: string; path: string };
export type ClaimRow = { queue_id: number; bucket_id: string; name: string; version: string; vault_name: string };
export type RecordOutcome = "ok" | "stale" | "mismatch" | "not_leased";
export type PlanRow = { id: number; source_bucket: string; source_name: string; source_version: string; vault_name: string; size_bytes: number | null; etag: string | null };
export type ReconcileResult = { enqueued: number; source_deleted: number; live_objects: number; mass_delete_pause: boolean; dead_queue: number; oldest_pending_minutes: number };

export interface VaultRpc {
  claim(owner: string, limit: number): Promise<ClaimRow[]>;
  record(queueId: number, owner: string): Promise<RecordOutcome>;
  fail(queueId: number, owner: string, code: string): Promise<void>;
  reconcile(): Promise<ReconcileResult>;
  erase(targets: VaultTarget[], reason: string): Promise<Array<{ id: number; vault_name: string }>>;
  purgeCandidates(limit: number): Promise<Array<{ id: number; vault_name: string }>>;
  markPurged(ids: number[]): Promise<number>;
  restorePlan(bucket: string, prefix: string, since: string): Promise<PlanRow[]>;
}
export class VaultStorageError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export interface VaultStorage {
  /** Serverová kópia bez prepisu; existujúci cieľ -> VaultStorageError("DUPLICATE"). */
  copy(srcBucket: string, srcPath: string, dstBucket: string, dstPath: string): Promise<void>;
  /** Idempotentné (chýbajúca cesta nie je chyba). */
  remove(bucket: string, paths: string[]): Promise<void>;
}

const codeOf = (e: unknown) => (e instanceof VaultStorageError ? e.code : "COPY_FAILED").replace(/[^A-Z0-9_:]/g, "_").slice(0, 80) || "COPY_FAILED";

export async function drainVaultQueue(rpc: VaultRpc, storage: VaultStorage, owner: string, limit = 50) {
  const rows = await rpc.claim(owner, limit);
  const out = { claimed: rows.length, copied: 0, stale: 0, mismatch: 0, failed: 0 };
  for (const r of rows) {
    try {
      try {
        await storage.copy(r.bucket_id, r.name, VAULT_BUCKET, r.vault_name);
      } catch (e) {
        // Kópia z predchádzajúceho prerušeného behu už existuje -> overí ju record (veľkosť + eTag).
        if (!(e instanceof VaultStorageError && e.code === "DUPLICATE")) throw e;
      }
      const outcome = await rpc.record(r.queue_id, owner);
      if (outcome === "ok") out.copied++;
      else if (outcome === "stale" || outcome === "mismatch") {
        // Originál sa medzitým zmenil/zmazal alebo kópia nesedí -> kópiu zahodiť (stale: novú verziu prinesie trigger).
        await storage.remove(VAULT_BUCKET, [r.vault_name]);
        if (outcome === "stale") out.stale++; else out.mismatch++;
      }
    } catch (e) {
      out.failed++;
      await rpc.fail(r.queue_id, owner, codeOf(e));
    }
  }
  return out;
}

export async function reconcileVault(rpc: VaultRpc) {
  return rpc.reconcile();
}

export async function purgeVault(rpc: VaultRpc, storage: VaultStorage, limit = 200) {
  const cand = await rpc.purgeCandidates(limit);
  if (!cand.length) return { purged: 0 };
  for (let i = 0; i < cand.length; i += 100) await storage.remove(VAULT_BUCKET, cand.slice(i, i + 100).map((c) => c.vault_name));
  return { purged: await rpc.markPurged(cand.map((c) => c.id)) };
}

export async function eraseVaultCopies(rpc: VaultRpc, storage: VaultStorage, targets: VaultTarget[], reason: string) {
  if (!targets.length) return { erased: 0 };
  const rows = await rpc.erase(targets, reason);
  if (!rows.length) return { erased: 0 };
  for (let i = 0; i < rows.length; i += 100) await storage.remove(VAULT_BUCKET, rows.slice(i, i + 100).map((r) => r.vault_name));
  return { erased: await rpc.markPurged(rows.map((r) => r.id)) };
}

export async function restoreFromVault(rpc: VaultRpc, storage: VaultStorage, bucket: string, prefix: string, since: string) {
  const plan = await rpc.restorePlan(bucket, prefix, since);
  const out = { planned: plan.length, restored: 0, exists: 0, failed: 0, restored_names: [] as string[] };
  for (const p of plan) {
    try {
      await storage.copy(VAULT_BUCKET, p.vault_name, p.source_bucket, p.source_name);
      out.restored++;
      out.restored_names.push(`${p.source_bucket}/${p.source_name}`);
    } catch (e) {
      if (e instanceof VaultStorageError && e.code === "DUPLICATE") out.exists++; // nikdy neprepisuje existujúci súbor
      else out.failed++;
    }
  }
  return out;
}

// ----------------------------------------------------------------------------- Supabase adaptér (service_role)
type Rpcable = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
  storage: { from: (b: string) => {
    copy: (from: string, to: string, opts?: { destinationBucket?: string }) => Promise<{ error: { message?: string; statusCode?: string | number } | null }>;
    remove: (paths: string[]) => Promise<{ error: { message?: string } | null }>;
  } };
};
export class VaultNotInstalledError extends Error {}
async function call<T>(db: Rpcable, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") throw new VaultNotInstalledError(fn);
    throw new Error(`ESBLU_VAULT_RPC_FAILED:${fn}:${error.code ?? "unknown"}`);
  }
  return data as T;
}
export function supabaseVaultRpc(db: Rpcable): VaultRpc {
  return {
    claim: (owner, limit) => call(db, "esblu_storage_vault_claim", { p_owner: owner, p_limit: limit }),
    record: (id, owner) => call(db, "esblu_storage_vault_record", { p_queue_id: id, p_owner: owner }),
    fail: async (id, owner, code) => { await call(db, "esblu_storage_vault_fail", { p_queue_id: id, p_owner: owner, p_error: code }); },
    reconcile: () => call(db, "esblu_storage_vault_reconcile", {}),
    erase: (targets, reason) => call(db, "esblu_storage_vault_erase", { p_targets: targets, p_reason: reason }),
    purgeCandidates: (limit) => call(db, "esblu_storage_vault_purge_candidates", { p_limit: limit }),
    markPurged: (ids) => call(db, "esblu_storage_vault_mark_purged", { p_ids: ids }),
    restorePlan: (bucket, prefix, since) => call(db, "esblu_storage_vault_restore_plan", { p_bucket: bucket, p_prefix: prefix, p_since: since }),
  };
}
export function supabaseVaultStorage(db: Rpcable): VaultStorage {
  return {
    async copy(srcBucket, srcPath, dstBucket, dstPath) {
      const { error } = await db.storage.from(srcBucket).copy(srcPath, dstPath, { destinationBucket: dstBucket });
      if (error) {
        const msg = `${error.message ?? ""}`;
        if (String(error.statusCode) === "409" || /already exists|duplicate/i.test(msg)) throw new VaultStorageError("DUPLICATE");
        if (String(error.statusCode) === "404" || /not found/i.test(msg)) throw new VaultStorageError("SOURCE_NOT_FOUND");
        throw new VaultStorageError("COPY_FAILED");
      }
    },
    async remove(bucket, paths) {
      if (bucket !== VAULT_BUCKET) throw new Error("ESBLU_VAULT_REMOVE_OUTSIDE_VAULT");
      const { error } = await db.storage.from(bucket).remove(paths);
      if (error) throw new VaultStorageError("REMOVE_FAILED");
    },
  };
}

/** Definitívny výmaz z cleanup jobu; trezor ešte nenainštalovaný = nič na mazanie (nie chyba). */
export async function eraseVaultCopiesBestEffortIfMissing(db: Rpcable, targets: VaultTarget[], reason: string) {
  try {
    return await eraseVaultCopies(supabaseVaultRpc(db), supabaseVaultStorage(db), targets, reason);
  } catch (e) {
    if (e instanceof VaultNotInstalledError) return { erased: 0, installed: false };
    throw e; // iná chyba -> cleanup job sa zopakuje (výmaz musí dobehnúť)
  }
}
