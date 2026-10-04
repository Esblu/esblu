"use client";

// =============================================================================
// Krátkodobé podpísané URL pre súkromné médiá (fotky vozidiel, strojov,
// skladu a firemné logá).
//
// PREČO: buckety vehicle-photos / machine-photos / inventory-photos /
// company-logos sú súkromné (migrácie 20261005090000 + 20261005091000). getPublicUrl() by po
// prepnutí vracal nefunkčnú adresu a pred ním obchádzal RLS. Podpísanú URL
// vydá Supabase Storage IBA ak prihlásený používateľ prejde SELECT politikou
// (esblu_can_read_media_object — firma podľa DB riadku, rola) — autorita
// ostáva na serveri, klient nič nerozhoduje.
//
// - Platnosť 1 hodina; cache v pamäti stránky, obnova 5 min pred vypršaním.
// - Dávkovo (createSignedUrls) — jeden request na zoznam, nie N.
// - Objekt, ku ktorému používateľ nemá prístup, sa jednoducho nevráti
//   (žiadna chyba v UI, žiadne zlyhanie celej dávky).
// - Nikdy service_role, nikdy verejná URL.
// - Funguje rovnako na webe aj v Android (Capacitor) appke.
// =============================================================================

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export const PRIVATE_MEDIA_BUCKETS = ["vehicle-photos", "machine-photos", "inventory-photos", "company-logos"] as const;
export type MediaBucket = (typeof PRIVATE_MEDIA_BUCKETS)[number];

export const SIGNED_MEDIA_TTL_SECONDS = 60 * 60;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type CacheEntry = { url: string; expiresAt: number };
const cache = new Map<string, CacheEntry>();

const cacheKey = (bucket: MediaBucket, path: string) => `${bucket}\u0000${path}`;

/** Je podpísaná URL ešte dosť dlho platná na zobrazenie? (čistá funkcia, testovateľná) */
export function isSignedEntryFresh(entry: CacheEntry | undefined, now: number = Date.now()): entry is CacheEntry {
  return Boolean(entry && entry.url && entry.expiresAt - now > REFRESH_MARGIN_MS);
}

/** Jedinečné, neprázdne cesty bez URL (do Storage API idú iba relatívne cesty v buckete). */
export function normalizeMediaPaths(paths: readonly (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const value of paths) {
    const path = typeof value === "string" ? value.trim() : "";
    if (!path || /^[a-z]+:\/\//i.test(path) || path.startsWith("/")) continue;
    out.add(path);
  }
  return [...out];
}

/** Podpísané URL pre zoznam ciest. Vráti iba tie, ku ktorým má používateľ prístup. */
export async function signMediaUrls(
  bucket: MediaBucket,
  paths: readonly (string | null | undefined)[],
  options: { force?: boolean } = {}
): Promise<Record<string, string>> {
  const now = Date.now();
  const result: Record<string, string> = {};
  const missing: string[] = [];

  for (const path of normalizeMediaPaths(paths)) {
    const entry = cache.get(cacheKey(bucket, path));
    if (!options.force && isSignedEntryFresh(entry, now)) result[path] = entry.url;
    else missing.push(path);
  }
  if (missing.length === 0) return result;

  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(missing, SIGNED_MEDIA_TTL_SECONDS);
  if (error || !data) return result;

  const expiresAt = now + SIGNED_MEDIA_TTL_SECONDS * 1000;
  for (const item of data) {
    if (!item || item.error || !item.signedUrl || !item.path) continue;
    cache.set(cacheKey(bucket, item.path), { url: item.signedUrl, expiresAt });
    result[item.path] = item.signedUrl;
  }
  return result;
}

/** Jedna podpísaná URL alebo "" ak nie je prístup / cesta chýba. */
export async function signMediaUrl(bucket: MediaBucket, path: string | null | undefined, options: { force?: boolean } = {}): Promise<string> {
  if (!path) return "";
  const map = await signMediaUrls(bucket, [path], options);
  return map[path.trim()] ?? "";
}

/** Zabudne podpísanú URL (napr. po zmazaní alebo výmene súboru). */
export function forgetSignedMedia(bucket: MediaBucket, path: string | null | undefined): void {
  if (path) cache.delete(cacheKey(bucket, path.trim()));
}

/**
 * React hook: mapa cesta → podpísaná URL pre aktuálny zoznam ciest.
 * Kým URL nie je k dispozícii, kľúč v mape chýba (UI nemá zobraziť <img>).
 */
export function useSignedMediaUrls(bucket: MediaBucket, paths: readonly (string | null | undefined)[]): Record<string, string> {
  const key = normalizeMediaPaths(paths).join("\n");
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const list = key ? key.split("\n") : [];
    async function load() {
      const next = list.length > 0 ? await signMediaUrls(bucket, list) : {};
      if (!cancelled) setUrls(next);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [bucket, key]);

  return urls;
}
