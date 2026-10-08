# EsbluBilling — natívny billing plugin (referenčný, NEZAPOJENÝ)

Tieto súbory **nie sú súčasťou Android ani iOS buildu**. Gradle ani Xcode ich nekompilujú a v repe zatiaľ nie je `mobile/ios`. Kým sa plugin nezapojí, appka hlási `available=false` a obrazovka Predplatné zobrazí iba stav predplatného. Na stagingu sa natívny nákup emuluje cez `NEXT_PUBLIC_ESBLU_BILLING_FAKE_NATIVE=1` (`lib/billing/native-bridge.ts → FakeBillingBridge`).

| Súbor | Obsah |
|---|---|
| `ios/EsbluBillingPlugin.swift` | StoreKit 2 IAP (`appAccountToken`), restore, `ExternalPurchaseCustomLink` (EÚ), správa predplatného |
| `android/EsbluBillingPlugin.kt` | Play Billing Library 9.1+, billing choice program (scenár 1A), `setObfuscatedAccountId`, zmena plánu |

**JS kontrakt:** `lib/billing/native-bridge.ts` (`CapacitorBillingBridge`).

Zapojenie pluginu vyžaduje enrollmenty a produkty v obchodoch. Postup je v `docs/subscriptions-mobile-purchase-2026-10-08.md`, sekcia F.
