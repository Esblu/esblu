// =============================================================================
// EsbluBilling — Capacitor plugin (Android). REFERENČNÁ IMPLEMENTÁCIA.
//
// STAV: NEKOMPILOVANÉ, NEZAPOJENÉ do mobile/android (Gradle závislosť
// com.android.billingclient:billing:9.1.0+ ešte nie je pridaná).
// Zapojenie: docs/subscriptions-mobile-purchase-2026-10-08.md → „Android kroky".
// Vyžaduje: Play Console produkty (subscription + base plany monthly/yearly),
// pre EEA zápis do „Billing choice" programu (Play Console → Settings) —
// zatiaľ NEAKTIVOVANÉ.
//
// Billing choice program (developer.android.com/google/play/billing/billingchoice):
//   scenár 1A — Google-rendered choice screen, platba v appke:
//   BillingClient.Builder.enableBillingProgram(BILLING_CHOICE)
//     + setDeveloperProvidedBillingListener
//   BillingFlowParams.Builder.enableDeveloperBillingOption(...)
//   → Play: PurchasesUpdatedListener (purchaseToken)
//   → Esblu: DeveloperProvidedBillingListener (externalTransactionToken)
// Mimo EEA: štandardný launchBillingFlow (billingChoice=false).
// Názvy tried podľa oficiálnej dokumentácie 2026-10-08; NEOVERENÉ kompiláciou.
// =============================================================================

package com.esblu.app.billing

import com.android.billingclient.api.*
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "EsbluBilling")
class EsbluBillingPlugin : Plugin() {
    private var pendingCall: PluginCall? = null
    private lateinit var client: BillingClient

    override fun load() {
        client = BillingClient.newBuilder(context)
            .setListener { result, purchases -> onPlayPurchase(result, purchases) }
            .enableBillingProgram(
                EnableBillingProgramParams.newBuilder()
                    .setBillingProgram(BillingProgram.BILLING_CHOICE)
                    .setDeveloperProvidedBillingListener { details ->
                        // Používateľ v Google choice screen zvolil Esblu billing.
                        resolvePending(JSObject().put("kind", "developer_billing")
                            .put("externalTransactionToken", details.externalTransactionToken))
                    }
                    .build()
            )
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build()
    }

    private fun withConnection(block: () -> Unit, onError: (String) -> Unit) {
        if (client.isReady) { block(); return }
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                if (result.responseCode == BillingClient.BillingResponseCode.OK) block() else onError("BILLING_UNAVAILABLE")
            }
            override fun onBillingServiceDisconnected() {}
        })
    }

    @PluginMethod
    fun getStorefront(call: PluginCall) {
        withConnection({
            client.getBillingConfigAsync(GetBillingConfigParams.newBuilder().build()) { _, config ->
                call.resolve(JSObject().put("platform", "android").put("country", config?.countryCode))
            }
        }, { call.resolve(JSObject().put("platform", "android").put("country", null)) })
    }

    @PluginMethod
    fun purchaseGoogle(call: PluginCall) {
        val productId = call.getString("productId") ?: return call.reject("INVALID_ARGUMENTS")
        val basePlanId = call.getString("basePlanId") ?: return call.reject("INVALID_ARGUMENTS")
        val accountId = call.getString("obfuscatedAccountId") ?: return call.reject("INVALID_ARGUMENTS")
        val oldToken = call.getString("oldPurchaseToken")
        val billingChoice = call.getBoolean("billingChoice", false) == true
        withConnection({
            val query = QueryProductDetailsParams.newBuilder().setProductList(listOf(
                QueryProductDetailsParams.Product.newBuilder().setProductId(productId)
                    .setProductType(BillingClient.ProductType.SUBS).build()
            )).build()
            client.queryProductDetailsAsync(query) { _, result ->
                val details = result.productDetailsList.firstOrNull() ?: return@queryProductDetailsAsync call.reject("PRODUCT_NOT_FOUND")
                val offer = details.subscriptionOfferDetails?.firstOrNull { it.basePlanId == basePlanId }
                    ?: return@queryProductDetailsAsync call.reject("BASE_PLAN_NOT_FOUND")
                val params = BillingFlowParams.newBuilder()
                    .setProductDetailsParamsList(listOf(
                        BillingFlowParams.ProductDetailsParams.newBuilder()
                            .setProductDetails(details).setOfferToken(offer.offerToken).build()
                    ))
                    // Server vydal nereverzibilný token firmy → subscriptionsv2 externalAccountIdentifiers.
                    .setObfuscatedAccountId(accountId)
                if (oldToken != null) {
                    params.setSubscriptionUpdateParams(
                        BillingFlowParams.SubscriptionUpdateParams.newBuilder()
                            .setOldPurchaseToken(oldToken)
                            .setSubscriptionReplacementMode(BillingFlowParams.SubscriptionUpdateParams.ReplacementMode.WITH_TIME_PRORATION)
                            .build()
                    )
                }
                if (billingChoice) {
                    params.enableDeveloperBillingOption(
                        DeveloperBillingOptionParams.newBuilder().setBillingProgram(BillingProgram.BILLING_CHOICE).build()
                    )
                }
                pendingCall = call
                val launch = client.launchBillingFlow(activity, params.build())
                if (launch.responseCode != BillingClient.BillingResponseCode.OK) {
                    pendingCall = null
                    call.resolve(JSObject().put("kind", "canceled"))
                }
            }
        }, { call.reject(it) })
    }

    private fun onPlayPurchase(result: BillingResult, purchases: List<Purchase>?) {
        val purchase = purchases?.firstOrNull()
        if (result.responseCode == BillingClient.BillingResponseCode.OK && purchase != null) {
            // Acknowledge robí SERVER po overení (purchases.subscriptions.acknowledge).
            resolvePending(JSObject().put("kind", "play").put("purchaseToken", purchase.purchaseToken))
        } else {
            resolvePending(JSObject().put("kind", "canceled"))
        }
    }

    private fun resolvePending(value: JSObject) {
        pendingCall?.resolve(value)
        pendingCall = null
    }

    @PluginMethod
    fun manageSubscriptions(call: PluginCall) {
        val productId = call.getString("productId")
        val url = "https://play.google.com/store/account/subscriptions?package=${context.packageName}" +
            (if (productId != null) "&sku=$productId" else "")
        activity.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
        call.resolve()
    }

    // iOS-only metódy — na Androide nedostupné.
    @PluginMethod fun purchaseApple(call: PluginCall) = call.unavailable("iOS only")
    @PluginMethod fun restoreApple(call: PluginCall) = call.resolve(JSObject().put("signedTransactions", emptyList<String>()))
    @PluginMethod fun appleExternalPurchaseNotice(call: PluginCall) = call.resolve(JSObject().put("proceed", false))
}
