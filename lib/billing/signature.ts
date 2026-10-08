// =============================================================================
// HMAC podpisy webhookov (Stripe schéma `t=<unix>,v1=<hex>` nad
// `${t}.${rawBody}`). Používa ju Stripe adapter aj fake provider.
// Iba server (node:crypto). Porovnanie v konštantnom čase, tolerancia
// časovej pečiatky (replay ochrana), nikdy tolerancia 0 / neobmedzená.
// =============================================================================

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export type SignatureCheck = "ok" | "invalid" | "stale" | "malformed";

/**
 * Overí hlavičku `t=…,v1=…[,v1=…]`. Iné schémy (v0) sa ignorujú.
 * `nowSeconds` je parameter kvôli testom.
 */
export function verifyTimestampedSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
): SignatureCheck {
  if (!header || !secret || toleranceSeconds <= 0) return "malformed";
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return "malformed";
  const expected = hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  if (!signatures.some((candidate) => safeEqualHex(candidate, expected))) return "invalid";
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return "stale";
  return "ok";
}

/** Vytvorí podpisovú hlavičku (fake provider + testy). */
export function signTimestamped(rawBody: string, secret: string, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${hmacSha256Hex(secret, `${timestampSeconds}.${rawBody}`)}`;
}
