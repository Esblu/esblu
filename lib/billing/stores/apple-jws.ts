// =============================================================================
// Apple signed data (JWS) — overenie BEZ dôvery v klienta (SERVER ONLY).
//
// StoreKit 2 Transaction.jwsRepresentation, App Store Server Notifications V2
// signedPayload, signedTransactionInfo / signedRenewalInfo sú JWS (ES256) s
// reťazou certifikátov v hlavičke `x5c`. Overenie:
//   1. alg = ES256, x5c = [leaf, intermediate, root] (DER base64),
//   2. root sa MUSÍ zhodovať (SHA-256 odtlačok) s dôveryhodným Apple rootom
//      — dodaný z konfigurácie (Apple Root CA - G3 z apple.com/certificateauthority),
//      nikdy nie z požiadavky; bez nakonfigurovaného rootu → NOT_CONFIGURED,
//   3. každý certifikát podpísaný nasledujúcim + platný v čase overenia,
//   4. leaf / intermediate nesú Apple OID (1.2.840.113635.100.6.11.1 /
//      1.2.840.113635.100.6.2.1) — rovnaká kontrola ako oficiálna
//      @apple/app-store-server-library (SignedDataVerifier),
//   5. ES256 podpis (IEEE P1363 r||s) nad `header.payload` kľúčom leaf certifikátu.
// Alternatíva pre produkciu: oficiálna knižnica @apple/app-store-server-library
// (pridá aj online OCSP). Rozhranie AppleSignedDataVerifier je rovnaké.
// =============================================================================

import { X509Certificate, createHash, verify as cryptoVerify } from "node:crypto";
import { BillingProviderError } from "@/lib/billing/types";

export interface AppleSignedDataVerifier {
  verify<T = Record<string, unknown>>(jws: string): Promise<T>;
}

const APPLE_LEAF_OID = "1.2.840.113635.100.6.11.1";
const APPLE_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

/** DER kódovanie OID (bez tagu) — na vyhľadanie rozšírenia v certifikáte. */
export function encodeOid(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const bytes: number[] = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const stack: number[] = [part & 0x7f];
    let value = Math.floor(part / 128);
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    bytes.push(...stack);
  }
  return Buffer.from([0x06, bytes.length, ...bytes]);
}

function hasOid(cert: X509Certificate, oid: string): boolean {
  return cert.raw.includes(encodeOid(oid));
}

function b64urlDecode(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function sha256Fingerprint(cert: X509Certificate): string {
  return createHash("sha256").update(cert.raw).digest("hex");
}

export type AppleJwsVerifierOptions = {
  /** SHA-256 odtlačky (hex) dôveryhodných root certifikátov (Apple Root CA - G3). */
  trustedRootSha256: string[];
  /** Vyžadovať Apple OID v leaf/intermediate (vypnuté iba v testoch so self-signed reťazou). */
  requireAppleOids?: boolean;
  now?: () => Date;
};

export class AppleJwsVerifier implements AppleSignedDataVerifier {
  private readonly roots: Set<string>;
  private readonly requireAppleOids: boolean;
  private readonly now: () => Date;

  constructor(options: AppleJwsVerifierOptions) {
    this.roots = new Set(options.trustedRootSha256.map((f) => f.toLowerCase().replace(/[^0-9a-f]/g, "")).filter((f) => f.length === 64));
    this.requireAppleOids = options.requireAppleOids ?? true;
    this.now = options.now ?? (() => new Date());
  }

  async verify<T = Record<string, unknown>>(jws: string): Promise<T> {
    if (this.roots.size === 0) throw new BillingProviderError("NOT_CONFIGURED", "apple root CA not configured");
    const parts = typeof jws === "string" ? jws.split(".") : [];
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new BillingProviderError("MALFORMED_PAYLOAD");
    let header: { alg?: string; x5c?: unknown };
    try {
      header = JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
    } catch {
      throw new BillingProviderError("MALFORMED_PAYLOAD");
    }
    if (header.alg !== "ES256") throw new BillingProviderError("INVALID_SIGNATURE", "alg");
    if (!Array.isArray(header.x5c) || header.x5c.length !== 3 || !header.x5c.every((c) => typeof c === "string")) {
      throw new BillingProviderError("INVALID_SIGNATURE", "x5c");
    }
    let chain: X509Certificate[];
    try {
      chain = (header.x5c as string[]).map((c) => new X509Certificate(Buffer.from(c, "base64")));
    } catch {
      throw new BillingProviderError("INVALID_SIGNATURE", "x5c parse");
    }
    const [leaf, intermediate, root] = chain;
    if (!this.roots.has(sha256Fingerprint(root))) throw new BillingProviderError("INVALID_SIGNATURE", "untrusted root");
    const at = this.now().getTime();
    for (const cert of chain) {
      if (at < Date.parse(cert.validFrom) || at > Date.parse(cert.validTo)) throw new BillingProviderError("INVALID_SIGNATURE", "cert validity");
    }
    if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) throw new BillingProviderError("INVALID_SIGNATURE", "leaf");
    if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) throw new BillingProviderError("INVALID_SIGNATURE", "intermediate");
    if (!root.verify(root.publicKey)) throw new BillingProviderError("INVALID_SIGNATURE", "root");
    if (this.requireAppleOids && (!hasOid(leaf, APPLE_LEAF_OID) || !hasOid(intermediate, APPLE_INTERMEDIATE_OID))) {
      throw new BillingProviderError("INVALID_SIGNATURE", "apple oid");
    }
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
      { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
      b64urlDecode(parts[2]),
    );
    if (!ok) throw new BillingProviderError("INVALID_SIGNATURE", "signature");
    try {
      return JSON.parse(b64urlDecode(parts[1]).toString("utf8")) as T;
    } catch {
      throw new BillingProviderError("MALFORMED_PAYLOAD");
    }
  }
}

/** Zo servera: odtlačky dôveryhodných rootov z env (APPLE_ROOT_CA_SHA256, čiarkou oddelené). */
export function appleVerifierFromEnv(env: Record<string, string | undefined> = process.env): AppleJwsVerifier {
  return new AppleJwsVerifier({ trustedRootSha256: (env.APPLE_ROOT_CA_SHA256 ?? "").split(",") });
}
