// =============================================================================
// FAKE App Store + FAKE Google Play (staging a testy). Emulujú to, čo by
// vrátil StoreKit 2 / Play Billing na zariadení a store API na serveri —
// podpísané HMAC test secretom, aby server mohol použiť TÚ ISTÚ overovaciu
// cestu (verify → normalize → record → apply) ako pri reálnych obchodoch.
// Nikdy sa nepoužije v produkcii (lib/billing/config.ts → store mode).
// =============================================================================

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { BillingProviderError } from "@/lib/billing/types";
import type { AppleSignedDataVerifier } from "@/lib/billing/stores/apple-jws";
import type { AppleStoreApi, GooglePlayApi } from "@/lib/billing/stores/store-apis";

type Obj = Record<string, unknown>;
const b64url = (v: string) => Buffer.from(v).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const b64urlDecode = (v: string) => Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function mac(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}
function macOk(secret: string, input: string, given: string): boolean {
  const expected = Buffer.from(mac(secret, input));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function requireSecret(secret: string | undefined): string {
  if (!secret || secret.trim().length < 16) throw new BillingProviderError("NOT_CONFIGURED");
  return secret.trim();
}

// ----------------------------------------------------------------------------- Apple
/** Emulácia StoreKit 2 Transaction.jwsRepresentation (alg FAKE-HS256). */
export function fakeAppleSignTransaction(secret: string | undefined, payload: Obj): string {
  const s = requireSecret(secret);
  const input = `${b64url(JSON.stringify({ alg: "FAKE-HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${mac(s, input)}`;
}

export class FakeAppleVerifier implements AppleSignedDataVerifier {
  private readonly secret: string | undefined;
  constructor(secret: string | undefined) {
    this.secret = secret;
  }
  async verify<T = Obj>(jws: string): Promise<T> {
    const s = requireSecret(this.secret);
    const parts = typeof jws === "string" ? jws.split(".") : [];
    if (parts.length !== 3) throw new BillingProviderError("MALFORMED_PAYLOAD");
    const header = JSON.parse(b64urlDecode(parts[0])) as { alg?: string };
    if (header.alg !== "FAKE-HS256" || !macOk(s, `${parts[0]}.${parts[1]}`, parts[2])) {
      throw new BillingProviderError("INVALID_SIGNATURE");
    }
    return JSON.parse(b64urlDecode(parts[1])) as T;
  }
}

/** Fake StoreKit nákup: vráti podpísanú transakciu s appAccountToken (ako zariadenie). */
export function fakeApplePurchase(secret: string | undefined, input: {
  productId: string;
  appAccountToken: string;
  interval: "month" | "year";
  originalTransactionId?: string;
  now?: Date;
  bundleId?: string;
}): { signedTransaction: string; transactionId: string; originalTransactionId: string } {
  const now = input.now ?? new Date();
  const expires = new Date(now.getTime());
  if (input.interval === "year") expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  else expires.setUTCMonth(expires.getUTCMonth() + 1);
  const transactionId = String(2_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  const originalTransactionId = input.originalTransactionId ?? transactionId;
  const payload = {
    transactionId,
    originalTransactionId,
    productId: input.productId,
    bundleId: input.bundleId ?? "com.esblu.app",
    purchaseDate: now.getTime(),
    expiresDate: expires.getTime(),
    signedDate: now.getTime(),
    appAccountToken: input.appAccountToken,
    environment: "Sandbox",
    type: "Auto-Renewable Subscription",
  };
  return { signedTransaction: fakeAppleSignTransaction(secret, payload), transactionId, originalTransactionId };
}

export class FakeAppleStoreApi implements AppleStoreApi {
  readonly reports: Obj[] = [];
  async getAllSubscriptionStatuses(): Promise<Obj> {
    return { data: [] };
  }
  async sendExternalPurchaseReport(report: Obj): Promise<Obj> {
    this.reports.push(report);
    return {};
  }
}

// ----------------------------------------------------------------------------- Google
/** Fake purchaseToken = podpísaný SubscriptionPurchaseV2 resource (stav nesie token). */
export function fakeGoogleIssueToken(secret: string | undefined, resource: Obj): string {
  const s = requireSecret(secret);
  const body = b64url(JSON.stringify(resource));
  return `fakegp.${body}.${mac(s, body)}`;
}

export function fakeGooglePurchase(secret: string | undefined, input: {
  productId: string;
  basePlanId: string;
  obfuscatedAccountId: string;
  linkedPurchaseToken?: string | null;
  now?: Date;
  state?: string;
}): { purchaseToken: string } {
  const now = input.now ?? new Date();
  const expiry = new Date(now.getTime());
  if (input.basePlanId.includes("year")) expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
  else expiry.setUTCMonth(expiry.getUTCMonth() + 1);
  return {
    purchaseToken: fakeGoogleIssueToken(secret, {
      kind: "androidpublisher#subscriptionPurchaseV2",
      nonce: randomUUID(),
      regionCode: "SK",
      startTime: now.toISOString(),
      subscriptionState: input.state ?? "SUBSCRIPTION_STATE_ACTIVE",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      linkedPurchaseToken: input.linkedPurchaseToken ?? undefined,
      externalAccountIdentifiers: { obfuscatedExternalAccountId: input.obfuscatedAccountId },
      testPurchase: {},
      lineItems: [{ productId: input.productId, expiryTime: expiry.toISOString(), offerDetails: { basePlanId: input.basePlanId } }],
    }),
  };
}

export class FakeGooglePlayApi implements GooglePlayApi {
  readonly acknowledged: string[] = [];
  readonly externalTransactions: { id: string; body: Obj }[] = [];
  readonly refunds: { id: string; body: Obj }[] = [];
  private readonly secret: string | undefined;
  constructor(secret: string | undefined) {
    this.secret = secret;
  }
  async getSubscriptionV2(purchaseToken: string): Promise<Obj> {
    const s = requireSecret(this.secret);
    const parts = purchaseToken.split(".");
    if (parts.length !== 3 || parts[0] !== "fakegp" || !macOk(s, parts[1], parts[2])) {
      throw new BillingProviderError("PROVIDER_ERROR", "unknown purchase token");
    }
    const resource = JSON.parse(b64urlDecode(parts[1])) as Obj;
    if (this.acknowledged.includes(purchaseToken)) resource.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
    return resource;
  }
  async acknowledge(_productId: string, purchaseToken: string): Promise<void> {
    this.acknowledged.push(purchaseToken);
  }
  async createExternalTransaction(id: string, body: Obj): Promise<Obj> {
    this.externalTransactions.push({ id, body });
    return { externalTransactionId: id, transactionState: "TRANSACTION_REPORTED", testPurchase: {} };
  }
  async refundExternalTransaction(id: string, body: Obj): Promise<Obj> {
    this.refunds.push({ id, body });
    return { externalTransactionId: id, transactionState: "TRANSACTION_CANCELED" };
  }
}

/** Fake Google externalTransactionToken / Apple ExternalPurchaseCustomLink token (staging). */
export function fakeStoreToken(kind: "google" | "apple"): string {
  if (kind === "google") return `fakeext_${randomUUID().replace(/-/g, "")}`;
  // Apple token = base64(JSON s externalPurchaseId) — tvar emulovaný; SANDBOX prefix.
  return Buffer.from(JSON.stringify({ externalPurchaseId: `SANDBOX_${randomUUID()}`, tokenType: "ACQUISITION" })).toString("base64");
}
