import { createPrivateKey, sign } from "node:crypto";

// Podpis JWT (RS256 pre Google OAuth, ES256 pre APNs) iba cez Node crypto.

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** PEM z env: podporuje literálne "\n" (Vercel env) aj skutočné nové riadky. */
export function normalizePem(value: string | undefined): string | null {
  const pem = value?.trim().replace(/\\n/g, "\n");
  if (!pem || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) return null;
  return pem;
}

export function signJwt(alg: "RS256" | "ES256", header: Record<string, unknown>, claims: Record<string, unknown>, pem: string): string {
  const head = b64url(JSON.stringify({ alg, typ: "JWT", ...header }));
  const body = b64url(JSON.stringify(claims));
  const key = createPrivateKey(pem);
  const signature =
    alg === "RS256"
      ? sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key)
      : sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64url(signature)}`;
}
