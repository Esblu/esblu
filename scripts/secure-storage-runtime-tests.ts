// =============================================================================
// Regresné testy: EsbluSecureStorage + štart appky (fix 2026-10-09).
//
// Prvý real-device beh: "EsbluSecureStorage.then() is not implemented on
// android" → appka navždy na „Načítavam Esblu…". Capacitor registerPlugin()
// vracia Proxy, ktorá pre každú vlastnosť (aj `then`) vráti natívne volanie.
// Tu ju verne napodobňujeme (CapacitorLikeProxy) a overujeme:
//   - proxy sa nikdy nevolá cez `.then` (ani pri await / async return),
//   - cold start, session restore, migrácia z localStorage, logout,
//   - plugin nedostupný / zlyhanie / zaseknutie → explicitný startup error.
// Používa skutočný @supabase/supabase-js klient, bez siete.
//
//   npm run test:secure-storage-runtime
// =============================================================================

import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const secureMod = await import("@/lib/mobile/secure-storage");
const { resolveStartupSession } = await import("@/lib/startup-session");
const { createAuthStorage, loadSecureStoragePlugin } = secureMod;

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${(error as Error)?.stack ?? error}`);
  }
}

// Unhandled rejections z interných supabase emitov nesmú zhodiť test runner.
process.on("unhandledRejection", () => undefined);

/** Verná napodobenina Capacitor plugin proxy (registerPlugin). */
function capacitorLikeProxy(impl: Record<string, (o?: unknown) => Promise<unknown>>, platform = "android") {
  const accessed: string[] = [];
  const proxy = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (typeof prop === "symbol") return undefined;
      accessed.push(prop);
      if (prop in impl) return impl[prop];
      return () => Promise.reject(new Error(`EsbluSecureStorage.${prop}() is not implemented on ${platform}`));
    },
  });
  return { proxy, accessed };
}

function memoryNative() {
  const map = new Map<string, string>();
  const impl = {
    get: async (o?: unknown) => ({ value: map.get((o as { key: string }).key) ?? null }),
    set: async (o?: unknown) => {
      const { key, value } = o as { key: string; value: string };
      map.set(key, value);
    },
    remove: async (o?: unknown) => {
      map.delete((o as { key: string }).key);
    },
    clear: async () => {
      map.clear();
    },
  };
  return { map, impl };
}

function memoryLocalStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
  };
}

function fakeCore(proxy: unknown, opts: { native?: boolean; available?: boolean } = {}) {
  return async () =>
    ({
      Capacitor: { isNativePlatform: () => opts.native ?? true, isPluginAvailable: () => opts.available ?? true },
      registerPlugin: () => proxy,
    }) as never;
}

const REF = "cjbdijbbcujvmrzezusd";
const KEY = `sb-${REF}-auth-token`;
const URL = `https://${REF}.supabase.co`;
function fakeSession() {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    access_token: "header.payload.sig",
    refresh_token: "refresh",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "t@esblu.test", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  });
}
function client(storage: ReturnType<typeof createAuthStorage>) {
  return createClient(URL, "anon", {
    auth: { storage, flowType: "pkce", autoRefreshToken: false, detectSessionInUrl: false, persistSession: true },
    // Bez siete: server signOut odpovie 204.
    global: { fetch: async () => new Response(null, { status: 204 }) },
  });
}

console.log("EsbluSecureStorage — Capacitor proxy a štart appky");

await check("reprodukcia: async funkcia vracajúca proxy → proxy.then() → promise visí navždy (pôvodný bug)", async () => {
  const { proxy, accessed } = capacitorLikeProxy(memoryNative().impl);
  const buggy = async () => proxy;
  const outcome = await Promise.race([buggy().then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), 100))]);
  assert.equal(outcome, "pending", "presne ako na zariadení: nikdy neskončí → večné „Načítavam Esblu…“");
  assert.ok(accessed.includes("then"));
});

await check("loadSecureStoragePlugin(): proxy sa nikdy nečíta cez `then` (await aj async return)", async () => {
  const { proxy, accessed } = capacitorLikeProxy(memoryNative().impl);
  const plugin = await loadSecureStoragePlugin(fakeCore(proxy));
  assert.ok(plugin);
  const again = await Promise.resolve(plugin);
  await again!.set({ key: KEY, value: "x" });
  assert.equal((await again!.get({ key: KEY })).value, "x");
  await again!.remove({ key: KEY });
  await again!.clear();
  assert.ok(!accessed.includes("then"), `pristúpené: ${accessed.join(",")}`);
  assert.deepEqual([...new Set(accessed)].sort(), ["clear", "get", "remove", "set"]);
});

await check("adaptér nemá `then` (nie je thenable)", async () => {
  const { proxy } = capacitorLikeProxy(memoryNative().impl);
  const plugin = await loadSecureStoragePlugin(fakeCore(proxy));
  assert.equal("then" in (plugin as object), false);
});

await check("createAuthStorage nad adaptérom nikdy nepristúpi k proxy.then", async () => {
  const { proxy, accessed } = capacitorLikeProxy(memoryNative().impl);
  const storage = createAuthStorage({ plugin: () => loadSecureStoragePlugin(fakeCore(proxy)), legacy: () => memoryLocalStorage() });
  await storage.setItem(KEY, "v");
  assert.equal(await storage.getItem(KEY), "v");
  assert.equal(await storage.backend(), "secure");
  assert.ok(!accessed.includes("then"));
});

await check("cold start bez session → signed_out (login), Keystore použitý", async () => {
  const native = memoryNative();
  const { proxy, accessed } = capacitorLikeProxy(native.impl);
  const storage = createAuthStorage({ plugin: () => loadSecureStoragePlugin(fakeCore(proxy)), legacy: () => memoryLocalStorage() });
  const sb = client(storage);
  assert.deepEqual(await resolveStartupSession(() => sb.auth.getSession(), 3000), { status: "signed_out" });
  assert.ok(accessed.includes("get") && !accessed.includes("then"));
});

await check("session restore z Keystore → signed_in", async () => {
  const native = memoryNative();
  native.map.set(KEY, fakeSession());
  const { proxy, accessed } = capacitorLikeProxy(native.impl);
  const storage = createAuthStorage({ plugin: () => loadSecureStoragePlugin(fakeCore(proxy)), legacy: () => memoryLocalStorage() });
  const sb = client(storage);
  assert.deepEqual(await resolveStartupSession(() => sb.auth.getSession(), 3000), { status: "signed_in" });
  assert.ok(!accessed.includes("then"));
});

await check("migrácia z localStorage: session sa obnoví, presunie do Keystore a legacy kópia zmizne", async () => {
  const native = memoryNative();
  const ls = memoryLocalStorage({ [KEY]: fakeSession() });
  const { proxy, accessed } = capacitorLikeProxy(native.impl);
  const storage = createAuthStorage({ plugin: () => loadSecureStoragePlugin(fakeCore(proxy)), legacy: () => ls });
  const sb = client(storage);
  assert.deepEqual(await resolveStartupSession(() => sb.auth.getSession(), 3000), { status: "signed_in" });
  assert.ok(native.map.has(KEY), "session je v Keystore");
  assert.equal(ls.m.has(KEY), false, "legacy kópia odstránená");
  assert.ok(!accessed.includes("then"));
});

await check("logout: lokálny signOut + clearAll vyčistí Keystore aj legacy auth kľúče", async () => {
  const native = memoryNative();
  native.map.set(KEY, fakeSession());
  const ls = memoryLocalStorage({ [`${KEY}-code-verifier`]: "v", other: "keep" });
  const { proxy, accessed } = capacitorLikeProxy(native.impl);
  const storage = createAuthStorage({ plugin: () => loadSecureStoragePlugin(fakeCore(proxy)), legacy: () => ls });
  const sb = client(storage);
  await sb.auth.signOut({ scope: "local" });
  await storage.clearAll();
  assert.equal(native.map.size, 0);
  assert.equal(ls.m.has(`${KEY}-code-verifier`), false);
  assert.equal(ls.m.get("other"), "keep");
  assert.deepEqual(await resolveStartupSession(() => client(storage).auth.getSession(), 3000), { status: "signed_out" });
  assert.ok(!accessed.includes("then"));
});

await check("plugin nedostupný v natívnom builde → legacy localStorage (bez pádu)", async () => {
  const { proxy, accessed } = capacitorLikeProxy(memoryNative().impl);
  const ls = memoryLocalStorage({ [KEY]: fakeSession() });
  const storage = createAuthStorage({ plugin: () => loadSecureStoragePlugin(fakeCore(proxy, { available: false })), legacy: () => ls });
  assert.equal(await storage.backend(), "legacy");
  assert.deepEqual(await resolveStartupSession(() => client(storage).auth.getSession(), 3000), { status: "signed_in" });
  assert.equal(accessed.length, 0, "proxy sa vôbec nepoužila");
});

await check("web (nie natívna platforma) → legacy, registerPlugin sa nevolá", async () => {
  let registered = false;
  const core = async () => ({ Capacitor: { isNativePlatform: () => false, isPluginAvailable: () => false }, registerPlugin: () => ((registered = true), {}) }) as never;
  assert.equal(await loadSecureStoragePlugin(core), null);
  assert.equal(registered, false);
});

await check("plugin zlyhá (get reject) → startup error, NIE prihlásenie ani večné načítavanie", async () => {
  const { proxy } = capacitorLikeProxy({ ...memoryNative().impl, get: async () => Promise.reject(new Error("KEYSTORE_FAILURE")) });
  const storage = createAuthStorage({ plugin: () => loadSecureStoragePlugin(fakeCore(proxy)), legacy: () => memoryLocalStorage() });
  const result = await resolveStartupSession(() => client(storage).auth.getSession(), 3000);
  assert.equal(result.status, "error");
  assert.equal((result as { reason: string }).reason, "secure_storage_get_failed");
});

await check("plugin sa zasekne (get nikdy neodpovie) → timeout → startup error", async () => {
  const { proxy } = capacitorLikeProxy({ ...memoryNative().impl, get: () => new Promise(() => undefined) });
  const storage = createAuthStorage({ plugin: () => loadSecureStoragePlugin(fakeCore(proxy)), legacy: () => memoryLocalStorage(), timeoutMs: 200 });
  const result = await resolveStartupSession(() => client(storage).auth.getSession(), 3000);
  assert.equal(result.status, "error");
  assert.equal((result as { reason: string }).reason, "secure_storage_get_timeout");
});

await check("pôvodný bug (async proxy loader) → startup error namiesto večného „Načítavam Esblu…“", async () => {
  const { proxy } = capacitorLikeProxy(memoryNative().impl);
  const storage = createAuthStorage({ plugin: async () => proxy as never, legacy: () => memoryLocalStorage() });
  // Loader visí (asimilácia) → startup timeout → chybová obrazovka, nie prihlásenie ani večné čakanie.
  const result = await resolveStartupSession(() => client(storage).auth.getSession(), 300);
  assert.deepEqual(result, { status: "error", reason: "startup_session_timeout" });
});

await check("getSession, ktorý nikdy neskončí → startup_session_timeout", async () => {
  const result = await resolveStartupSession(() => new Promise(() => undefined), 100);
  assert.deepEqual(result, { status: "error", reason: "startup_session_timeout" });
});

await check("app/page.tsx používa resolveStartupSession a má chybovú obrazovku s „Skúsiť znova“", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new globalThis.URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /resolveStartupSession\(\(\) => supabase\.auth\.getSession\(\)\)/);
  assert.match(page, /startupFailedTitle/);
  assert.match(page, /window\.location\.reload\(\)/);
  assert.doesNotMatch(page, /supabase\.auth\.getSession\(\)\.then\(/);
  const lib = readFileSync(new globalThis.URL("../lib/mobile/secure-storage.ts", import.meta.url), "utf8");
  assert.match(lib, /return toAdapter\(proxy\);/);
  assert.doesNotMatch(lib, /return registerPlugin</, "proxy sa nesmie vracať z async funkcie");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
