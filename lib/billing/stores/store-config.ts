// =============================================================================
// Konfigurácia Apple/Google adaptérov (SERVER ONLY).
//
// ESBLU_BILLING_STORE_MODE:
//   off      (default)   — mobilné store nákupy sa nespracúvajú
//   fake                 — FAKE App Store / Play (staging, HMAC secret)
//   sandbox              — reálne Apple Sandbox / Google license-test nákupy
//                          (vyžaduje enrollment + kľúče — zatiaľ NIE)
// VERCEL_ENV=production → vždy off. Live obchody sa v tejto fáze nepodporujú.
// =============================================================================

import { appleVerifierFromEnv, type AppleSignedDataVerifier } from "@/lib/billing/stores/apple-jws";
import { FakeAppleStoreApi, FakeAppleVerifier, FakeGooglePlayApi } from "@/lib/billing/stores/fake-stores";
import { parseServiceAccount } from "@/lib/billing/stores/jwt";
import { AppleStoreServerApi, GooglePlayDeveloperApi, type AppleStoreApi, type GooglePlayApi } from "@/lib/billing/stores/store-apis";

export type StoreMode = "off" | "fake" | "sandbox";
type Env = Record<string, string | undefined>;

export function getStoreMode(env: Env = process.env): StoreMode {
  if (env.VERCEL_ENV === "production") return "off";
  const mode = (env.ESBLU_BILLING_STORE_MODE ?? "").trim();
  return mode === "fake" || mode === "sandbox" ? mode : "off";
}

export function fakeStoreSecret(env: Env = process.env): string | undefined {
  return env.ESBLU_FAKE_STORE_SECRET || env.ESBLU_FAKE_BILLING_SECRET;
}

export function appleBundleId(env: Env = process.env): string {
  return (env.APPLE_BUNDLE_ID ?? "com.esblu.app").trim();
}

// Fake Google API drží acknowledge/reporty v pamäti procesu — na stagingu stačí.
let fakeGoogle: FakeGooglePlayApi | null = null;
let fakeApple: FakeAppleStoreApi | null = null;

export function getAppleVerifier(env: Env = process.env): AppleSignedDataVerifier | null {
  const mode = getStoreMode(env);
  if (mode === "fake") return new FakeAppleVerifier(fakeStoreSecret(env));
  if (mode === "sandbox") return appleVerifierFromEnv(env);
  return null;
}

export function getGooglePlayApi(env: Env = process.env): GooglePlayApi | null {
  const mode = getStoreMode(env);
  if (mode === "fake") return (fakeGoogle ??= new FakeGooglePlayApi(fakeStoreSecret(env)));
  if (mode === "sandbox") {
    const account = parseServiceAccount(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
    const pkg = env.GOOGLE_PLAY_PACKAGE_NAME;
    return account && pkg ? new GooglePlayDeveloperApi(pkg, account) : null;
  }
  return null;
}

export function getAppleStoreApi(env: Env = process.env): AppleStoreApi | null {
  const mode = getStoreMode(env);
  if (mode === "fake") return (fakeApple ??= new FakeAppleStoreApi());
  if (mode === "sandbox") {
    const { APPLE_IAP_KEY_ID: keyId, APPLE_IAP_ISSUER_ID: issuerId, APPLE_IAP_PRIVATE_KEY: privateKeyPem } = env;
    return keyId && issuerId && privateKeyPem
      ? new AppleStoreServerApi({ keyId, issuerId, privateKeyPem, bundleId: appleBundleId(env) }, "test")
      : null;
  }
  return null;
}
