// =============================================================================
// Store API klienti (SERVER ONLY). Pripravené, NEAKTIVOVANÉ — vyžadujú
// enrollment + kľúče (docs/subscriptions-mobile-purchase-2026-10-08.md).
//
// GooglePlayApi (Play Developer API v3):
//   - purchases.subscriptionsv2.get           — autoritatívny stav predplatného
//   - purchases.subscriptions.acknowledge     — do 3 dní, inak auto-refund
//   - externalTransactions.createexternaltransaction / :refund — reporting billing choice
// AppleStoreApi (App Store Server API + External Purchase Server API):
//   - GET  /inApps/v1/subscriptions/{transactionId}  — všetky stavy predplatného
//   - PUT  /externalPurchase/v1/reports              — mesačný report externých nákupov
// Sandbox hosty sa používajú v environment='test'.
// =============================================================================

import { BillingProviderError } from "@/lib/billing/types";
import { appleApiToken, googleAccessToken, type AppleApiKey, type GoogleServiceAccount } from "@/lib/billing/stores/jwt";

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

export interface GooglePlayApi {
  getSubscriptionV2(purchaseToken: string): Promise<Obj>;
  acknowledge(productId: string, purchaseToken: string): Promise<void>;
  createExternalTransaction(externalTransactionId: string, body: Obj): Promise<Obj>;
  refundExternalTransaction(externalTransactionId: string, body: Obj): Promise<Obj>;
}

export class GooglePlayDeveloperApi implements GooglePlayApi {
  private readonly base: string;
  private token: { value: string; until: number } | null = null;
  private readonly account: GoogleServiceAccount;
  private readonly fetchImpl: typeof fetch;

  constructor(packageName: string, account: GoogleServiceAccount, fetchImpl: typeof fetch = fetch) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.]{2,200}$/.test(packageName)) throw new BillingProviderError("NOT_CONFIGURED");
    this.base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}`;
    this.account = account;
    this.fetchImpl = fetchImpl;
  }

  private async call(method: "GET" | "POST", path: string, body?: Obj): Promise<Obj> {
    const now = Date.now();
    if (!this.token || this.token.until < now) {
      this.token = { value: await googleAccessToken(this.account, this.fetchImpl), until: now + 50 * 60_000 };
    }
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token.value}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw new BillingProviderError("PROVIDER_ERROR", `google ${method} ${response.status}`);
    if (!text) return {};
    const json = JSON.parse(text) as unknown;
    return isObj(json) ? json : {};
  }

  getSubscriptionV2(purchaseToken: string) {
    return this.call("GET", `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
  }

  async acknowledge(productId: string, purchaseToken: string) {
    await this.call("POST", `/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`, {});
  }

  createExternalTransaction(externalTransactionId: string, body: Obj) {
    return this.call("POST", `/externalTransactions?externalTransactionId=${encodeURIComponent(externalTransactionId)}`, body);
  }

  refundExternalTransaction(externalTransactionId: string, body: Obj) {
    return this.call("POST", `/externalTransactions/${encodeURIComponent(externalTransactionId)}:refund`, body);
  }
}

export interface AppleStoreApi {
  getAllSubscriptionStatuses(transactionId: string): Promise<Obj>;
  sendExternalPurchaseReport(report: Obj): Promise<Obj>;
}

export class AppleStoreServerApi implements AppleStoreApi {
  private readonly host: string;
  private readonly key: AppleApiKey;
  private readonly fetchImpl: typeof fetch;

  constructor(key: AppleApiKey, environment: "test" | "live", fetchImpl: typeof fetch = fetch) {
    if (environment !== "test") throw new BillingProviderError("LIVE_MODE_FORBIDDEN");
    this.host = "https://api.storekit-sandbox.apple.com";
    this.key = key;
    this.fetchImpl = fetchImpl;
  }

  private async call(method: "GET" | "PUT", path: string, body?: Obj): Promise<Obj> {
    const response = await this.fetchImpl(`${this.host}${path}`, {
      method,
      headers: { Authorization: `Bearer ${appleApiToken(this.key)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw new BillingProviderError("PROVIDER_ERROR", `apple ${method} ${response.status}`);
    if (!text) return {};
    const json = JSON.parse(text) as unknown;
    return isObj(json) ? json : {};
  }

  getAllSubscriptionStatuses(transactionId: string) {
    return this.call("GET", `/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`);
  }

  sendExternalPurchaseReport(report: Obj) {
    return this.call("PUT", "/externalPurchase/v1/reports", report);
  }
}
