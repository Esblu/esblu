// =============================================================================
// Zrušenie účtu — Storage ciele + mazanie (SERVER ONLY, service_role).
//
// Cesty sa čítajú VÝHRADNE z DB riadkov (storage_bucket + storage_path /
// file_path / logo_path). Primárne ich zbiera DB funkcia
// esblu_account_deletion_commit v transakcii zrušenia (20261012130000);
// tieto TS kolektory slúžia iba pre fallback, keď migrácia ešte nie je
// aplikovaná — aj vtedy sa Storage maže AŽ po úspešnom DB commite.
// remove() je idempotentné (chýbajúca cesta nie je chyba) → bezpečný retry.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export type StorageTarget = { bucket: string; path: string };

/**
 * Nemenná evidencia (eInvoice ↔ RC, 2026-10-13): XML / PDF e-faktúr v privátnom
 * bucket einvoice-documents sa pri zrušení NIKDY nemažú — firma s e-faktúrami sa
 * zrušiť ani nedá (20261013100000). Obrana do hĺbky: aj keby sa cieľ do jobu
 * dostal (ručná úprava, budúci kolektor), tu sa zahodí.
 */
export const DELETION_PROTECTED_BUCKETS: ReadonlySet<string> = new Set(["einvoice-documents"]);

/** Validácia jobu z DB (jsonb) — iba {bucket, path} stringy, bez prázdnych ciest. */
export function parseStorageTargets(value: unknown): StorageTarget[] {
  if (!Array.isArray(value)) return [];
  const out: StorageTarget[] = [];
  for (const item of value) {
    const bucket = (item as { bucket?: unknown })?.bucket;
    const path = (item as { path?: unknown })?.path;
    if (
      typeof bucket === "string" &&
      typeof path === "string" &&
      bucket &&
      path &&
      !path.includes("..") &&
      !DELETION_PROTECTED_BUCKETS.has(bucket)
    ) {
      out.push({ bucket, path });
    }
  }
  return out;
}

export async function collectOwnerStorageTargets(
  admin: SupabaseClient,
  companyId: string,
  ownerUserId: string
): Promise<StorageTarget[]> {
  const targets: StorageTarget[] = [];

  const [
    documentsRes,
    attachmentsRes,
    aiEvidenceRes,
    machinePhotosRes,
    inventoryPhotosRes,
    vehiclePhotosRes,
    settingsRes,
    billingProfileRes,
  ] = await Promise.all([
    admin
      .from("documents")
      .select("storage_bucket, storage_path")
      .eq("company_id", companyId),
    admin
      .from("document_attachments")
      .select("storage_bucket, storage_path")
      .eq("company_id", companyId),
    admin
      .from("ai_evidence")
      .select("photo_url")
      .eq("company_id", companyId)
      .not("photo_url", "is", null),
    admin
      .from("machine_photos")
      .select("file_path")
      .eq("company_id", companyId)
      .not("file_path", "is", null),
    admin
      .from("inventory_photos")
      .select("file_path")
      .eq("company_id", companyId)
      .not("file_path", "is", null),
    admin
      .from("vehicle_photos")
      .select("storage_path")
      .eq("company_id", companyId)
      .not("storage_path", "is", null),
    admin
      .from("settings")
      .select("logo_path")
      .eq("user_id", ownerUserId)
      .not("logo_path", "is", null),
    // Fáza 1B: company_billing_profile.logo_path je teraz JEDINÝ živý zdroj
    // aktuálneho firemného loga (settings.logo_path vyššie je legacy a od
    // tejto fázy doň appka už nezapisuje — pozri lib/company-billing-
    // profile.ts). Bez tohto riadku by zrušenie firmy nechalo osirelý
    // Storage objekt vždy, keď logo naposledy nahral/zmenil ADMIN (nie
    // owner) — company_billing_profile je company-scoped, nie user-scoped,
    // takže presne túto latentnú medzeru (predtým: logo nahraté adminom sa
    // pri zrušení firmy vôbec nekontrolovalo) zároveň opravuje.
    admin
      .from("company_billing_profile")
      .select("logo_path")
      .eq("company_id", companyId)
      .not("logo_path", "is", null),
  ]);

  for (const [label, res] of [
    ["documents", documentsRes],
    ["document_attachments", attachmentsRes],
    ["ai_evidence", aiEvidenceRes],
    ["machine_photos", machinePhotosRes],
    ["inventory_photos", inventoryPhotosRes],
    ["vehicle_photos", vehiclePhotosRes],
    ["settings", settingsRes],
    ["company_billing_profile", billingProfileRes],
  ] as const) {
    if (res.error) {
      throw new Error(
        `ESBLU_STORAGE_LOOKUP_FAILED:${label}:${res.error.code ?? ""}:${res.error.message}`
      );
    }
  }

  for (const row of documentsRes.data ?? []) {
    if (row.storage_bucket && row.storage_path) {
      targets.push({ bucket: row.storage_bucket, path: row.storage_path });
    }
  }

  for (const row of attachmentsRes.data ?? []) {
    if (row.storage_bucket && row.storage_path) {
      targets.push({ bucket: row.storage_bucket, path: row.storage_path });
    }
  }

  for (const row of aiEvidenceRes.data ?? []) {
    if (row.photo_url) {
      targets.push({ bucket: "ai-evidence-documents", path: row.photo_url });
    }
  }

  for (const row of machinePhotosRes.data ?? []) {
    if (row.file_path) {
      targets.push({ bucket: "machine-photos", path: row.file_path });
    }
  }

  for (const row of inventoryPhotosRes.data ?? []) {
    if (row.file_path) {
      targets.push({ bucket: "inventory-photos", path: row.file_path });
    }
  }

  for (const row of vehiclePhotosRes.data ?? []) {
    if (row.storage_path) {
      targets.push({ bucket: "vehicle-photos", path: row.storage_path });
    }
  }

  for (const row of settingsRes.data ?? []) {
    if (row.logo_path) {
      targets.push({ bucket: "company-logos", path: row.logo_path });
    }
  }

  for (const row of billingProfileRes.data ?? []) {
    if (row.logo_path) {
      targets.push({ bucket: "company-logos", path: row.logo_path });
    }
  }

  return targets;
}

export async function collectMemberOwnStorageTargets(
  admin: SupabaseClient,
  userId: string
): Promise<StorageTarget[]> {
  // Admin/employee flow NIKDY nemaže firemné dáta/Storage — jediný Storage
  // objekt, ktorý mu môže patriť VÝHRADNE osobne, je jeho vlastný nahraný
  // logo súbor v jeho vlastnom (typicky prázdnom) settings riadku.
  const { data, error } = await admin
    .from("settings")
    .select("logo_path")
    .eq("user_id", userId)
    .not("logo_path", "is", null);

  if (error) {
    throw new Error(
      `ESBLU_STORAGE_LOOKUP_FAILED:settings:${error.code ?? ""}:${error.message}`
    );
  }

  return (data ?? [])
    .filter((row) => row.logo_path)
    .map((row) => ({ bucket: "company-logos", path: row.logo_path as string }));
}

export async function removeStorageTargets(
  admin: SupabaseClient,
  targets: StorageTarget[]
): Promise<number> {
  const byBucket = new Map<string, string[]>();

  for (const target of targets) {
    if (DELETION_PROTECTED_BUCKETS.has(target.bucket)) continue;
    const list = byBucket.get(target.bucket) ?? [];
    list.push(target.path);
    byBucket.set(target.bucket, list);
  }

  let removed = 0;

  for (const [bucket, paths] of byBucket) {
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const { data, error } = await admin.storage.from(bucket).remove(batch);

      if (error) {
        throw new Error(
          `ESBLU_STORAGE_REMOVE_FAILED:${bucket}:${error.message}`
        );
      }

      removed += data?.length ?? batch.length;
    }
  }

  return removed;
}
