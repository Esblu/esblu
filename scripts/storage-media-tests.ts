// =============================================================================
// Súkromné médiá — aplikačná vrstva (bez siete).
//   - žiadny getPublicUrl v appke (web aj mobil zdieľajú app/ a lib/),
//   - zoznam súkromných bucketov = buckety v migrácii 20261005091000,
//   - normalizácia ciest (žiadne URL ani absolútne cesty do Storage API),
//   - cache podpísaných URL sa obnoví pred vypršaním.
// SPUSTENIE: npm run test:storage-media
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const media = await import("@/lib/storage/signed-media");

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

await check("appka nikde nevolá getPublicUrl ani /object/public/ (web + mobil)", () => {
  const offenders = [...walk("app"), ...walk("lib"), ...walk("mobile/app")]
    .filter((file) => !file.endsWith(path.join("lib", "storage", "signed-media.ts")))
    .filter((file) => /getPublicUrl\(|\/object\/public\//.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);
});

await check("súkromné buckety v appke = buckety prepnuté migráciou", () => {
  const sql = readFileSync("supabase/migrations/20261005091000_private_media_buckets.sql", "utf8");
  const m = sql.match(/where id in \(([^)]+)\)/);
  assert.ok(m);
  const buckets = m[1].split(",").map((s) => s.trim().replace(/'/g, "")).sort();
  assert.deepEqual(buckets, [...media.PRIVATE_MEDIA_BUCKETS].sort());
});

await check("normalizácia ciest: bez duplicít, prázdnych, URL a absolútnych ciest", () => {
  assert.deepEqual(
    media.normalizeMediaPaths(["a/b.webp", " a/b.webp ", "", null, undefined, "https://evil.example/x.webp", "/etc/passwd", "c/d.webp"]),
    ["a/b.webp", "c/d.webp"]
  );
});

await check("cache: platná URL sa použije, 5 min pred vypršaním sa obnoví", () => {
  const now = 1_000_000_000_000;
  assert.equal(media.isSignedEntryFresh({ url: "u", expiresAt: now + 30 * 60 * 1000 }, now), true);
  assert.equal(media.isSignedEntryFresh({ url: "u", expiresAt: now + 4 * 60 * 1000 }, now), false);
  assert.equal(media.isSignedEntryFresh({ url: "", expiresAt: now + 30 * 60 * 1000 }, now), false);
  assert.equal(media.isSignedEntryFresh(undefined, now), false);
});

await check("TTL podpísanej URL je krátky (≤ 1 h)", () => {
  assert.ok(media.SIGNED_MEDIA_TTL_SECONDS > 0 && media.SIGNED_MEDIA_TTL_SECONDS <= 3600);
});

const deletion = await import("@/lib/storage/media-deletion");

/** Falošný klient: sweep vráti položky, ktorých súbor ešte existuje; remove môže zlyhať. */
function fakeClient(files: Set<string>, opts: { failRemove?: boolean; rpcError?: boolean } = {}) {
  const calls = { rpc: 0, remove: [] as string[][] };
  const client = {
    rpc: async (name: string) => {
      calls.rpc++;
      assert.equal(name, "esblu_media_deletion_sweep");
      if (opts.rpcError) return { data: null, error: { message: "down" } };
      return { data: [...files].map((key) => ({ bucket_id: key.split("|")[0], object_path: key.split("|")[1] })), error: null };
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          calls.remove.push(paths.map((p) => `${bucket}|${p}`));
          if (opts.failRemove) return { data: null, error: { message: "storage down" } };
          for (const p of paths) files.delete(`${bucket}|${p}`);
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
  };
  return { client: client as unknown as import("@supabase/supabase-js").SupabaseClient, calls };
}

await check("mazanie: zoskupenie podľa bucketu", () => {
  assert.deepEqual(
    deletion.groupPendingByBucket([
      { bucket_id: "vehicle-photos", object_path: "a" },
      { bucket_id: "machine-photos", object_path: "b" },
      { bucket_id: "vehicle-photos", object_path: "c" },
    ]),
    { "vehicle-photos": ["a", "c"], "machine-photos": ["b"] }
  );
});

await check("mazanie: úspech → nič neostáva vo fronte", async () => {
  const files = new Set(["vehicle-photos|u/v/1.webp", "machine-photos|u/m/2.webp"]);
  const { client, calls } = fakeClient(files);
  assert.deepEqual(await deletion.flushMediaDeletions(client), { attempted: 2, remaining: 0 });
  assert.equal(files.size, 0);
  assert.equal(calls.rpc, 2);
});

await check("mazanie: zlyhanie Storage → položky ostávajú (nie ticho), retry ich dokončí", async () => {
  const files = new Set(["inventory-photos|u/i/1.webp"]);
  const failing = fakeClient(files, { failRemove: true });
  assert.deepEqual(await deletion.flushMediaDeletions(failing.client), { attempted: 1, remaining: 1 });
  const retry = fakeClient(files);
  assert.deepEqual(await deletion.flushMediaDeletions(retry.client), { attempted: 1, remaining: 0 });
  const again = fakeClient(files);
  assert.deepEqual(await deletion.flushMediaDeletions(again.client), { attempted: 0, remaining: 0 });
  assert.equal(again.calls.remove.length, 0, "idempotentné: nič na zmazanie");
});

await check("mazanie: nedostupný server → remaining -1, nič sa nemaže naslepo", async () => {
  const files = new Set(["company-logos|u/logo.webp"]);
  const { client, calls } = fakeClient(files, { rpcError: true });
  assert.deepEqual(await deletion.flushMediaDeletions(client), { attempted: 0, remaining: -1 });
  assert.equal(calls.remove.length, 0);
});

await check("toky mazania používajú frontu (nie priamy remove po zmazaní záznamu)", () => {
  const files = [
    "app/vozidla/VehicleDetailView.tsx", "app/vozidla/page.tsx", "app/stroje/MachineDetailView.tsx",
    "app/stroje/page.tsx", "app/sklad/page.tsx", "app/nastavenia/page.tsx", "lib/intents/operational-intents.ts",
  ];
  for (const file of files) assert.match(readFileSync(file, "utf8"), /flushMediaDeletions\(/, file);
  const intents = readFileSync("lib/intents/operational-intents.ts", "utf8");
  assert.ok(!/storage\.from\("(machine|vehicle)-photos"\)\.remove/.test(intents), "intents: priamy remove po zmazaní záznamu");
});

console.log(`storage-media: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
