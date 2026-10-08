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
}): AuthStorage {
  let resolved: Promise<SecureStoragePlugin | null> | null = null;
  const plugin = () => (resolved ??= input.plugin().catch(() => null));
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

/** Natívny plugin iba v Capacitor natívnom behu; inak null (web / plugin chýba v builde). */
export async function loadSecureStoragePlugin(): Promise<SecureStoragePlugin | null> {
  const { Capacitor, registerPlugin } = await import("@capacitor/core");
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("EsbluSecureStorage")) {
    if (Capacitor.isNativePlatform()) console.warn("[secure-storage] plugin EsbluSecureStorage chýba v natívnom builde — používa sa localStorage");
    return null;
  }
  return registerPlugin<SecureStoragePlugin>("EsbluSecureStorage");
}
