// =============================================================================
// Bezpečné úložisko Supabase auth relácie v natívnej appke (Mobile Platform
// 2026-10-08). Android Keystore (AES-GCM) / iOS Keychain cez lokálny Capacitor
// plugin "EsbluSecureStorage" (mobile/android/.../EsbluSecureStoragePlugin.java,
// mobile/ios/App/App/EsbluSecureStoragePlugin.swift).
//
// Supabase klient volá getItem/setItem/removeItem (async je podporované).
// MIGRÁCIA zo starého localStorage (appky pred touto zmenou):
//   getItem: secure → ak chýba, legacy localStorage → zapíš do secure →
//   AŽ PO úspešnom zápise zmaž legacy kópiu. Zlyhaný zápis = legacy ostáva
//   (používateľ sa neodhlási kvôli migrácii), pokus sa zopakuje nabudúce.
// setItem / removeItem vždy odstránia aj legacy kópiu (žiadna stará session
// v čitateľnom úložisku).
// Web a appka bez pluginu (starý natívny build): pôvodné localStorage.
//
// CAPACITOR PROXY (fix 2026-10-09, prvý real-device beh na Androide):
//   registerPlugin() vracia Proxy, ktorá pre KAŽDÚ vlastnosť vráti funkciu
//   volajúcu natívnu metódu — aj pre `then`. Keď sa proxy vráti z async
//   funkcie / Promise.resolve() / await, JS ju „asimiluje" ako thenable,
//   zavolá proxy.then() → natívne "EsbluSecureStorage.then() is not
//   implemented on android" → rejected promise → getSession() nikdy
//   nedobehol a appka visela na „Načítavam Esblu…".
//   Pravidlo: proxy NIKDY neopúšťa synchrónny kód ako hodnota promise.
//   loadSecureStoragePlugin() vracia obyčajný adaptér (bez `then`), ktorý
//   volá iba get/set/remove/clear. Natívne volania majú timeout, aby zaseknutý
//   bridge nezablokoval štart (chyba → explicitný startup error state).
// =============================================================================

export type SecureStoragePlugin = {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  clear(): Promise<void>;
};

export type LegacyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type AuthStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /** Logout: vymaže všetky secure položky appky aj legacy auth kľúče. */
  clearAll(): Promise<void>;
  /** Ktoré úložisko sa reálne používa (diagnostika / testy). */
  backend(): Promise<"secure" | "legacy">;
};

/** Chyba bezpečného úložiska (natívny plugin zlyhal alebo neodpovedal). */
export class SecureStorageError extends Error {
  /** code: "<operácia>_failed" | "<operácia>_timeout" */
  constructor(code: string, cause?: unknown) {
    super(`secure_storage_${code}`);
    this.name = "SecureStorageError";
    (this as { cause?: unknown }).cause = cause;
  }
}

export const SECURE_STORAGE_TIMEOUT_MS = 8000;

function withTimeout<T>(operation: string, promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SecureStorageError(`${operation}_timeout`)), ms);
  });
  return Promise.race([promise, timeout])
    .catch((error) => {
      throw error instanceof SecureStorageError ? error : new SecureStorageError(`${operation}_failed`, error);
    })
    .finally(() => clearTimeout(timer));
}

const SAFE_KEY = /^[A-Za-z0-9._-]{1,128}$/;

function legacyTry<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Supabase auth kľúče v legacy úložisku (sb-<ref>-auth-token, …-code-verifier, …-user). */
export function isSupabaseAuthKey(key: string): boolean {
  return /^sb-[A-Za-z0-9]+-auth-token(?:-code-verifier|-user)?$/.test(key);
}

export function createAuthStorage(input: {
  plugin: () => Promise<SecureStoragePlugin | null>;
  legacy: () => (LegacyStorage & { length?: number; key?(index: number): string | null }) | null;
  timeoutMs?: number;
}): AuthStorage {
  const ms = input.timeoutMs ?? SECURE_STORAGE_TIMEOUT_MS;
  // Plugin držíme v „krabici" { p } — promise nikdy neresolvuje priamo na
  // plugin objekt (ochrana proti thenable asimilácii aj pri inom loaderi).
  let resolved: Promise<{ p: SecureStoragePlugin | null }> | null = null;
  const box = () =>
    (resolved ??= input
      .plugin()
      .then((p) => ({ p: p ? toAdapter(p) : null }))
      .catch(() => ({ p: null })));
  const plugin = async (): Promise<SecureStoragePlugin | null> => {
    const { p } = await box();
    if (!p) return null;
    // Vrátiť adaptér z async funkcie je bezpečné: je to obyčajný objekt bez `then`.
    return {
      get: (o) => withTimeout("get", p.get(o), ms),
      set: (o) => withTimeout("set", p.set(o), ms),
      remove: (o) => withTimeout("remove", p.remove(o), ms),
      clear: () => withTimeout("clear", p.clear(), ms),
    };
  };
  const legacy = () => legacyTry(input.legacy, null);

  return {
    async backend() {
      return (await plugin()) ? "secure" : "legacy";
    },
    async getItem(key) {
      const secure = await plugin();
      const store = legacy();
      if (!secure || !SAFE_KEY.test(key)) return legacyTry(() => store?.getItem(key) ?? null, null);
      const current = (await secure.get({ key })).value ?? null;
      if (current !== null) return current;
      const old = legacyTry(() => store?.getItem(key) ?? null, null);
      if (old === null) return null;
      try {
        await secure.set({ key, value: old });
        legacyTry(() => store?.removeItem(key), undefined);
      } catch {
        // migrácia sa nepodarila — legacy ostáva, session funguje ďalej
      }
      return old;
    },
    async setItem(key, value) {
      const secure = await plugin();
      const store = legacy();
      if (!secure || !SAFE_KEY.test(key)) {
        legacyTry(() => store?.setItem(key, value), undefined);
        return;
      }
      await secure.set({ key, value });
      legacyTry(() => store?.removeItem(key), undefined);
    },
    async removeItem(key) {
      const secure = await plugin();
      if (secure && SAFE_KEY.test(key)) await secure.remove({ key });
      legacyTry(() => legacy()?.removeItem(key), undefined);
    },
    async clearAll() {
      const secure = await plugin();
      if (secure) await secure.clear();
      const store = legacy();
      if (!store || typeof store.length !== "number" || typeof store.key !== "function") return;
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = legacyTry(() => store.key!(i), null);
        if (k && isSupabaseAuthKey(k)) keys.push(k);
      }
      for (const k of keys) legacyTry(() => store.removeItem(k), undefined);
    },
  };
}

/**
 * Obyčajný objekt s presne štyrmi metódami — NIKDY nie Capacitor proxy.
 * Prístup k vlastnostiam proxy prebehne iba pri volaní metódy (synchrónne).
 */
export function toAdapter(source: SecureStoragePlugin): SecureStoragePlugin {
  return {
    get: (o) => source.get(o),
    set: (o) => source.set(o),
    remove: (o) => source.remove(o),
    clear: () => source.clear(),
  };
}

type CapacitorCore = Pick<typeof import("@capacitor/core"), "Capacitor" | "registerPlugin">;

/**
 * Natívny plugin iba v Capacitor natívnom behu; inak null (web / plugin chýba v builde).
 * Vracia ADAPTÉR, nie proxy z registerPlugin() — pozri hlavičku súboru.
 */
export async function loadSecureStoragePlugin(
  loadCore: () => Promise<CapacitorCore> = () => import("@capacitor/core")
): Promise<SecureStoragePlugin | null> {
  const { Capacitor, registerPlugin } = await loadCore();
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("EsbluSecureStorage")) {
    if (Capacitor.isNativePlatform()) console.warn("[secure-storage] plugin EsbluSecureStorage chýba v natívnom builde — používa sa localStorage");
    return null;
  }
  const proxy = registerPlugin<SecureStoragePlugin>("EsbluSecureStorage");
  return toAdapter(proxy);
}
