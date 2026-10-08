// =============================================================================
// Minimálne JWT utility pre store API (SERVER ONLY, node:crypto):
//   - Google service account → OAuth access token (RS256, scope androidpublisher)
//   - Apple App Store Server API / External Purchase Server API token (ES256)
//   - Overenie Google OIDC tokenu z Pub/Sub push (RTDN) — RS256 + JWKS
// Žiadne kľúče sa nelogujú; chyby sú bez detailov.
// =============================================================================

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import { BillingProviderError } from "@/lib/billing/types";

const b64url = (value: Buffer | string) =>
  Buffer.from(value).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const b64urlDecode = (part: string) => Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKeyPem: string,
): string {
  const alg = header.alg;
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey(privateKeyPem);
  const signature =
    alg === "ES256"
      ? cryptoSign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" })
      : cryptoSign("sha256", Buffer.from(input), key);
  return `${input}.${b64url(signature)}`;
}

export type GoogleServiceAccount = { client_email: string; private_key: string; token_uri?: string };

export function parseServiceAccount(json: string | undefined): GoogleServiceAccount | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<GoogleServiceAccount>;
    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") return null;
    return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri };
  } catch {
    return null;
  }
}

/** OAuth 2.0 JWT bearer grant (Google service account). */
export async function googleAccessToken(
  account: GoogleServiceAccount,
  fetchImpl: typeof fetch,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    },
    account.private_key,
  );
  const response = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  const json = (await response.json().catch(() => null)) as { access_token?: string } | null;
  if (!response.ok || !json?.access_token) throw new BillingProviderError("PROVIDER_ERROR", "google token");
  return json.access_token;
}

export type AppleApiKey = { keyId: string; issuerId: string; bundleId: string; privateKeyPem: string };

/** App Store Server API / External Purchase Server API bearer token (ES256, max 60 min). */
export function appleApiToken(key: AppleApiKey, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  return signJwt(
    { alg: "ES256", kid: key.keyId, typ: "JWT" },
    { iss: key.issuerId, iat: nowSeconds, exp: nowSeconds + 1200, aud: "appstoreconnect-v1", bid: key.bundleId },
    key.privateKeyPem,
  );
}

export type OidcExpectation = { audience: string; email: string; jwks: { keys: (JsonWebKey & { kid?: string })[] }; nowSeconds?: number };

/**
 * Overenie Pub/Sub push OIDC tokenu (Authorization: Bearer …):
 * RS256 podpis kľúčom z Google JWKS, iss accounts.google.com, aud, email,
 * email_verified, exp.
 */
export function verifyGoogleOidcToken(token: string, expected: OidcExpectation): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new BillingProviderError("INVALID_SIGNATURE");
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
    payload = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
  } catch {
    throw new BillingProviderError("INVALID_SIGNATURE");
  }
  if (header.alg !== "RS256") throw new BillingProviderError("INVALID_SIGNATURE");
  const jwk = expected.jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new BillingProviderError("INVALID_SIGNATURE");
  const ok = cryptoVerify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), b64urlDecode(parts[2]));
  if (!ok) throw new BillingProviderError("INVALID_SIGNATURE");
  const now = expected.nowSeconds ?? Math.floor(Date.now() / 1000);
  const issOk = payload.iss === "https://accounts.google.com" || payload.iss === "accounts.google.com";
  if (!issOk || payload.aud !== expected.audience || payload.email !== expected.email || payload.email_verified !== true) {
    throw new BillingProviderError("INVALID_SIGNATURE");
  }
  if (typeof payload.exp !== "number" || payload.exp < now) throw new BillingProviderError("STALE_SIGNATURE");
  return payload;
}
