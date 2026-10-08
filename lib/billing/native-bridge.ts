"use client";

// =============================================================================
// Natívny billing bridge (Capacitor plugin "EsbluBilling") — klientske rozhranie.
//
// Implementácie:
//   CapacitorBillingBridge — skutočný StoreKit 2 / Play Billing plugin
//     (zdrojáky: mobile/native-billing/** — ešte NEZAPOJENÉ do buildov,
//     vyžadujú Apple/Google enrollment; bez pluginu → available=false).
//   FakeBillingBridge — staging (NEXT_PUBLIC_ESBLU_BILLING_FAKE_NATIVE=1):
//     emuluje StoreKit/Play cez /api/billing/fake/store-purchase a systémové
//     dialógy (Google choice screen, Apple disclosure) cez AppDialog.
// Bridge NIKDY nerozhoduje o nároku — vracia iba artefakty obchodu
// (JWS transakcia, purchaseToken, store token), ktoré overí server.
// =============================================================================

import { apiUrl } from "@/lib/api-url";
import { supabase } from "@/lib/supabase";
import { confirmAction } from "@/lib/app-dialog";

export type Storefront = { platform: "android" | "ios"; country: string | null; osVersion?: string | null };

export type GooglePurchaseResult =
  | { kind: "play"; purchaseToken: string }
  | { kind: "developer_billing"; externalTransactionToken: string }
  | { kind: "canceled" };

export type AppleNoticeResult = { proceed: boolean; token: string | null };

export interface NativeBillingBridge {
  readonly available: boolean;
  readonly fake: boolean;
  getStorefront(): Promise<Storefront | null>;
  /** StoreKit 2: Product.purchase(options: [.appAccountToken]) → Transaction.jwsRepresentation. */
  purchaseApple(input: { productId: string; appAccountToken: string }): Promise<{ signedTransaction: string } | { canceled: true }>;
  /** Transaction.currentEntitlements → JWS (obnova nákupov). */
  restoreApple(): Promise<string[]>;
  /**
   * EÚ: ExternalPurchaseCustomLink — isEligible → token(for: ACQUISITION) → showNotice(type).
   * Pokračovať iba pri .continued.
   */
  appleExternalPurchaseNotice(type: "browser" | "withinApp"): Promise<AppleNoticeResult>;
  /**
   * Play Billing: launchBillingFlow so setObfuscatedAccountId; v EEA s billing
   * choice programom (enableDeveloperBillingOption) — Google choice screen.
   */
  purchaseGoogle(input: {
    productId: string;
    basePlanId: string;
    obfuscatedAccountId: string;
    oldPurchaseToken?: string | null;
    billingChoice: boolean;
  }): Promise<GooglePurchaseResult>;
  /** Stripe Checkout v appke: Custom Tab / SFSafariViewController alebo Safari (Apple .browser). */
  openCheckout(url: string, mode: "in_app" | "browser"): Promise<void>;
  /** Správa predplatného v obchode (AppStore.showManageSubscriptions / Play subscriptions). */
  manageStoreSubscription(provider: "apple" | "google", productId?: string | null): Promise<void>;
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` } : null;
}

async function fakeStore(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const headers = await authHeaders();
  if (!headers) return null;
  const response = await fetch(apiUrl("/api/billing/fake/store-purchase"), { method: "POST", headers, body: JSON.stringify(body) }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

/** STAGING — emulácia obchodu. Texty dialógov sú zámerne technické (test). */
export class FakeBillingBridge implements NativeBillingBridge {
  readonly available = true;
  readonly fake = true;
  private readonly platform: "android" | "ios";
  private readonly country: string;

  constructor(platform: "android" | "ios", country = "SK") {
    this.platform = platform;
    this.country = country;
  }

  async getStorefront(): Promise<Storefront> {
    return { platform: this.platform, country: this.country, osVersion: "fake" };
  }

  async purchaseApple(input: { productId: string; appAccountToken: string }) {
    const ok = await confirmAction({ message: `[FAKE App Store] Kúpiť ${input.productId}? (sandbox, bez platby)` });
    if (!ok) return { canceled: true as const };
    const result = await fakeStore({ action: "apple_purchase", productId: input.productId, accountToken: input.appAccountToken });
    if (typeof result?.signedTransaction !== "string") throw new Error("fake store unavailable");
    return { signedTransaction: result.signedTransaction };
  }

  async restoreApple(): Promise<string[]> {
    return [];
  }

  async appleExternalPurchaseNotice(type: "browser" | "withinApp"): Promise<AppleNoticeResult> {
    // Emulácia systémového disclosure sheetu ExternalPurchaseCustomLink.showNotice.
    const proceed = await confirmAction({
      message: `[FAKE Apple disclosure – ${type}] Chystáte sa nakúpiť mimo App Store. Apple nezodpovedá za túto transakciu. Pokračovať?`,
    });
    if (!proceed) return { proceed: false, token: null };
    const result = await fakeStore({ action: "apple_external_token" });
    return { proceed: true, token: typeof result?.token === "string" ? result.token : null };
  }

  async purchaseGoogle(input: { productId: string; basePlanId: string; obfuscatedAccountId: string; oldPurchaseToken?: string | null; billingChoice: boolean }): Promise<GooglePurchaseResult> {
    if (input.billingChoice && !input.oldPurchaseToken) {
      // Emulácia Google-rendered choice screen (billing choice program, scenár 1A).
      const useDeveloper = await confirmAction({
        message: "[FAKE Google choice screen] Zvoľte spôsob platby: OK = Esblu (karta cez Stripe), Zrušiť = Google Play",
      });
      if (useDeveloper) {
        const token = await fakeStore({ action: "google_external_token" });
        if (typeof token?.token !== "string") throw new Error("fake store unavailable");
        return { kind: "developer_billing", externalTransactionToken: token.token };
      }
    }
    const ok = await confirmAction({ message: `[FAKE Google Play] Kúpiť ${input.productId}/${input.basePlanId}? (test, bez platby)` });
    if (!ok) return { kind: "canceled" };
    const result = await fakeStore({
      action: "google_purchase",
      productId: input.productId,
      basePlanId: input.basePlanId,
      accountToken: input.obfuscatedAccountId,
      oldPurchaseToken: input.oldPurchaseToken ?? null,
    });
    if (typeof result?.purchaseToken !== "string") throw new Error("fake store unavailable");
    return { kind: "play", purchaseToken: result.purchaseToken };
  }

  /** Fake „hosted checkout": dialóg + /api/billing/fake/complete (podpísaný fake webhook na serveri). */
  async openCheckout(url: string): Promise<void> {
    const checkoutId = new URL(url, "https://fake.invalid").searchParams.get("checkout");
    if (!checkoutId) return;
    const paid = await confirmAction({ message: "[FAKE Stripe Checkout] Simulovať úspešnú platbu kartou? (bez platby)" });
    const headers = await authHeaders();
    if (!headers) return;
    await fetch(apiUrl("/api/billing/fake/complete"), {
      method: "POST",
      headers,
      body: JSON.stringify({ checkoutId, outcome: paid ? "paid" : "failed" }),
    }).catch(() => null);
  }

  async manageStoreSubscription(): Promise<void> {
    await confirmAction({ message: "[FAKE] Tu by sa otvorila správa predplatného v obchode." });
  }
}

type EsbluBillingPlugin = {
  getStorefront(): Promise<{ platform: "android" | "ios"; country: string | null; osVersion?: string }>;
  purchaseApple(o: { productId: string; appAccountToken: string }): Promise<{ signedTransaction?: string; canceled?: boolean }>;
  restoreApple(): Promise<{ signedTransactions: string[] }>;
  appleExternalPurchaseNotice(o: { type: "browser" | "withinApp" }): Promise<{ proceed: boolean; token: string | null }>;
  purchaseGoogle(o: Record<string, unknown>): Promise<{ kind: "play" | "developer_billing" | "canceled"; purchaseToken?: string; externalTransactionToken?: string }>;
  manageSubscriptions(o: { provider: string; productId?: string | null }): Promise<void>;
};

/** Skutočný plugin (mobile/native-billing). Ak nie je v builde → available=false. */
export class CapacitorBillingBridge implements NativeBillingBridge {
  readonly fake = false;
  readonly available: boolean;
  private readonly plugin: EsbluBillingPlugin;
  private readonly browserOpen: (url: string) => Promise<void>;

  constructor(plugin: EsbluBillingPlugin, available: boolean, browserOpen: (url: string) => Promise<void>) {
    this.plugin = plugin;
    this.available = available;
    this.browserOpen = browserOpen;
  }

  async getStorefront() {
    if (!this.available) return null;
    const r = await this.plugin.getStorefront();
    return { platform: r.platform, country: r.country ? r.country.toUpperCase().slice(0, 2) : null, osVersion: r.osVersion ?? null };
  }
  async purchaseApple(input: { productId: string; appAccountToken: string }) {
    const r = await this.plugin.purchaseApple(input);
    return r.signedTransaction ? { signedTransaction: r.signedTransaction } : { canceled: true as const };
  }
  async restoreApple() {
    return (await this.plugin.restoreApple()).signedTransactions ?? [];
  }
  async appleExternalPurchaseNotice(type: "browser" | "withinApp") {
    return this.plugin.appleExternalPurchaseNotice({ type });
  }
  async purchaseGoogle(input: { productId: string; basePlanId: string; obfuscatedAccountId: string; oldPurchaseToken?: string | null; billingChoice: boolean }): Promise<GooglePurchaseResult> {
    const r = await this.plugin.purchaseGoogle(input);
    if (r.kind === "play" && r.purchaseToken) return { kind: "play", purchaseToken: r.purchaseToken };
    if (r.kind === "developer_billing" && r.externalTransactionToken) return { kind: "developer_billing", externalTransactionToken: r.externalTransactionToken };
    return { kind: "canceled" };
  }
  async openCheckout(url: string, mode: "in_app" | "browser") {
    if (mode === "browser") window.open(url, "_system");
    else await this.browserOpen(url);
  }
  async manageStoreSubscription(provider: "apple" | "google", productId?: string | null) {
    await this.plugin.manageSubscriptions({ provider, productId });
  }
}

/** Vyberie bridge: fake (staging) → skutočný plugin → null (web). */
export async function loadNativeBillingBridge(platform: "android" | "ios"): Promise<NativeBillingBridge> {
  if (process.env.NEXT_PUBLIC_ESBLU_BILLING_FAKE_NATIVE === "1") return new FakeBillingBridge(platform);
  const [{ Capacitor, registerPlugin }, { Browser }] = await Promise.all([import("@capacitor/core"), import("@capacitor/browser")]);
  const plugin = registerPlugin<EsbluBillingPlugin>("EsbluBilling");
  return new CapacitorBillingBridge(plugin, Capacitor.isPluginAvailable("EsbluBilling"), (url) => Browser.open({ url }));
}
