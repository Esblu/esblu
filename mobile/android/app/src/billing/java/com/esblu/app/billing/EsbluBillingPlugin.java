package com.esblu.app.billing;

import android.content.Intent;
import android.net.Uri;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.GetBillingConfigParams;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONException;

/**
 * EsbluBilling — Google Play Billing (subscriptions) pre Capacitor. Integračná vetva
 * subscriptions-mobile-integration, 2026-10-11.
 *
 * KOMPILUJE SA IBA s -PesbluBilling=true (app/build.gradle). Default build je bez
 * Play Billing knižnice aj bez com.android.vending.BILLING povolenia.
 *
 * Bezpečnostný model: plugin NIKDY neudeľuje nárok ani nerobí acknowledge.
 * Vráti iba purchaseToken → server (/api/billing/mobile/confirm) ho overí cez
 * Play Developer API (subscriptionsv2), priradí firmu podľa obfuscatedAccountId
 * a až potom urobí acknowledge (server-side). Neacknowledgnutý nákup Google
 * po 3 dňoch refunduje — preto restoreGoogle() pri štarte/obnove znova posiela
 * tokeny na server (idempotentné).
 *
 * Výsledky purchaseGoogle (kontrakt lib/billing/native-bridge-contract.ts):
 *   play | pending | canceled | already_owned | billing_unavailable | error{code}
 *
 * Billing choice (EEA, BillingProgram) NIE JE zapojený — vyžaduje zápis do programu
 * v Play Console a overenie API voči aktuálnej knižnici; billingChoice=true vráti
 * error BILLING_CHOICE_NOT_WIRED (bezpečné zlyhanie, žiadna platba).
 */
@CapacitorPlugin(name = "EsbluBilling")
public class EsbluBillingPlugin extends Plugin {
    private BillingClient client;
    private PluginCall pendingCall;

    @Override
    public void load() {
        client = BillingClient.newBuilder(getContext())
            .setListener(this::onPurchasesUpdated)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().enablePrepaidPlans().build())
            .enableAutoServiceReconnection()
            .build();
    }

    private interface Ready { void run(); }
    private interface Failed { void run(String code); }

    /** Pripojenie (aj reconnect po odpojení služby). */
    private void withConnection(Ready ready, Failed failed) {
        if (client.isReady()) { ready.run(); return; }
        client.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(BillingResult result) {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) ready.run();
                else failed.run(codeName(result.getResponseCode()));
            }
            @Override
            public void onBillingServiceDisconnected() { /* enableAutoServiceReconnection */ }
        });
    }

    static String codeName(int code) {
        switch (code) {
            case BillingClient.BillingResponseCode.OK: return "OK";
            case BillingClient.BillingResponseCode.USER_CANCELED: return "USER_CANCELED";
            case BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE: return "SERVICE_UNAVAILABLE";
            case BillingClient.BillingResponseCode.BILLING_UNAVAILABLE: return "BILLING_UNAVAILABLE";
            case BillingClient.BillingResponseCode.ITEM_UNAVAILABLE: return "ITEM_UNAVAILABLE";
            case BillingClient.BillingResponseCode.DEVELOPER_ERROR: return "DEVELOPER_ERROR";
            case BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED: return "ITEM_ALREADY_OWNED";
            case BillingClient.BillingResponseCode.ITEM_NOT_OWNED: return "ITEM_NOT_OWNED";
            case BillingClient.BillingResponseCode.NETWORK_ERROR: return "NETWORK_ERROR";
            case BillingClient.BillingResponseCode.SERVICE_DISCONNECTED: return "SERVICE_DISCONNECTED";
            case BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED: return "FEATURE_NOT_SUPPORTED";
            default: return "ERROR";
        }
    }

    /** BillingResult → kontrakt (bez úspešného nákupu). */
    static JSObject failureResult(int code) {
        JSObject r = new JSObject();
        switch (code) {
            case BillingClient.BillingResponseCode.USER_CANCELED:
                r.put("kind", "canceled");
                break;
            case BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED:
                r.put("kind", "already_owned");
                break;
            case BillingClient.BillingResponseCode.BILLING_UNAVAILABLE:
            case BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE:
            case BillingClient.BillingResponseCode.SERVICE_DISCONNECTED:
                r.put("kind", "billing_unavailable");
                break;
            default:
                r.put("kind", "error");
                r.put("code", codeName(code));
        }
        return r;
    }

    @PluginMethod
    public void getStorefront(PluginCall call) {
        withConnection(() -> client.getBillingConfigAsync(GetBillingConfigParams.newBuilder().build(), (result, config) -> {
            JSObject r = new JSObject();
            r.put("platform", "android");
            r.put("country", config != null ? config.getCountryCode() : null);
            call.resolve(r);
        }), code -> {
            JSObject r = new JSObject();
            r.put("platform", "android");
            r.put("country", null);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void queryGoogleProducts(PluginCall call) {
        List<String> ids;
        try {
            JSArray arr = call.getArray("productIds", new JSArray());
            ids = arr.toList();
        } catch (JSONException e) {
            call.reject("INVALID_ARGUMENTS");
            return;
        }
        if (ids.isEmpty()) { call.resolve(productsResult(Collections.emptyList())); return; }
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        for (String id : ids) {
            products.add(QueryProductDetailsParams.Product.newBuilder().setProductId(id).setProductType(BillingClient.ProductType.SUBS).build());
        }
        withConnection(() -> client.queryProductDetailsAsync(
            QueryProductDetailsParams.newBuilder().setProductList(products).build(),
            (result, details) -> call.resolve(productsResult(
                result.getResponseCode() == BillingClient.BillingResponseCode.OK ? details.getProductDetailsList() : Collections.emptyList()))
        ), code -> call.resolve(productsResult(Collections.emptyList())));
    }

    private static JSObject productsResult(List<ProductDetails> list) {
        JSArray products = new JSArray();
        for (ProductDetails d : list) {
            JSArray plans = new JSArray();
            List<ProductDetails.SubscriptionOfferDetails> offers = d.getSubscriptionOfferDetails();
            if (offers != null) {
                for (ProductDetails.SubscriptionOfferDetails o : offers) {
                    if (o.getOfferId() != null) continue; // iba base plány (bez akciových ponúk)
                    List<ProductDetails.PricingPhase> phases = o.getPricingPhases().getPricingPhaseList();
                    JSObject p = new JSObject();
                    p.put("basePlanId", o.getBasePlanId());
                    p.put("formattedPrice", phases.isEmpty() ? null : phases.get(phases.size() - 1).getFormattedPrice());
                    plans.put(p);
                }
            }
            JSObject item = new JSObject();
            item.put("productId", d.getProductId());
            item.put("basePlans", plans);
            products.put(item);
        }
        JSObject r = new JSObject();
        r.put("products", products);
        return r;
    }

    @PluginMethod
    public void purchaseGoogle(PluginCall call) {
        String productId = call.getString("productId");
        String basePlanId = call.getString("basePlanId");
        String accountId = call.getString("obfuscatedAccountId");
        String oldToken = call.getString("oldPurchaseToken");
        if (productId == null || basePlanId == null || accountId == null) { call.reject("INVALID_ARGUMENTS"); return; }
        if (Boolean.TRUE.equals(call.getBoolean("billingChoice", false))) {
            JSObject r = new JSObject();
            r.put("kind", "error");
            r.put("code", "BILLING_CHOICE_NOT_WIRED");
            call.resolve(r);
            return;
        }
        if (pendingCall != null) {
            JSObject r = new JSObject();
            r.put("kind", "error");
            r.put("code", "PURCHASE_IN_PROGRESS");
            call.resolve(r);
            return;
        }
        List<QueryProductDetailsParams.Product> product = Collections.singletonList(
            QueryProductDetailsParams.Product.newBuilder().setProductId(productId).setProductType(BillingClient.ProductType.SUBS).build());
        withConnection(() -> client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(product).build(), (result, details) -> {
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK || details.getProductDetailsList().isEmpty()) {
                call.resolve(failureResult(result.getResponseCode() == BillingClient.BillingResponseCode.OK
                    ? BillingClient.BillingResponseCode.ITEM_UNAVAILABLE : result.getResponseCode()));
                return;
            }
            ProductDetails pd = details.getProductDetailsList().get(0);
            String offerToken = null;
            if (pd.getSubscriptionOfferDetails() != null) {
                for (ProductDetails.SubscriptionOfferDetails o : pd.getSubscriptionOfferDetails()) {
                    if (basePlanId.equals(o.getBasePlanId()) && o.getOfferId() == null) { offerToken = o.getOfferToken(); break; }
                }
            }
            if (offerToken == null) { call.resolve(failureResult(BillingClient.BillingResponseCode.ITEM_UNAVAILABLE)); return; }
            BillingFlowParams.Builder params = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(Collections.singletonList(
                    BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(pd).setOfferToken(offerToken).build()))
                // Nereverzibilný token firmy vydaný serverom → subscriptionsv2 externalAccountIdentifiers.
                .setObfuscatedAccountId(accountId);
            if (oldToken != null) {
                // Upgrade/downgrade v tom istom obchode (server povolil iba mode=change pre google).
                params.setSubscriptionUpdateParams(BillingFlowParams.SubscriptionUpdateParams.newBuilder()
                    .setOldPurchaseToken(oldToken)
                    .setSubscriptionReplacementMode(BillingFlowParams.SubscriptionUpdateParams.ReplacementMode.WITH_TIME_PRORATION)
                    .build());
            }
            pendingCall = call;
            getActivity().runOnUiThread(() -> {
                BillingResult launch = client.launchBillingFlow(getActivity(), params.build());
                if (launch.getResponseCode() != BillingClient.BillingResponseCode.OK) resolvePending(failureResult(launch.getResponseCode()));
            });
        }), code -> {
            JSObject r = new JSObject();
            r.put("kind", "billing_unavailable");
            call.resolve(r);
        });
    }

    private void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
        if (result.getResponseCode() == BillingClient.BillingResponseCode.OK && purchases != null && !purchases.isEmpty()) {
            Purchase p = purchases.get(0);
            JSObject r = new JSObject();
            // PENDING (odložená platba): nárok až keď server uvidí PURCHASED (RTDN / restore).
            r.put("kind", p.getPurchaseState() == Purchase.PurchaseState.PENDING ? "pending" : "play");
            r.put("purchaseToken", p.getPurchaseToken());
            resolvePending(r);
        } else {
            resolvePending(failureResult(result.getResponseCode()));
        }
    }

    private void resolvePending(JSObject value) {
        PluginCall call = pendingCall;
        pendingCall = null;
        if (call != null) call.resolve(value);
    }

    /** Obnova / reconnect: tokeny aktívnych predplatných → server ich overí (idempotentne). */
    @PluginMethod
    public void restoreGoogle(PluginCall call) {
        withConnection(() -> client.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(),
            (result, purchases) -> {
                JSArray tokens = new JSArray();
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    for (Purchase p : purchases) {
                        if (p.getPurchaseState() == Purchase.PurchaseState.PURCHASED) tokens.put(p.getPurchaseToken());
                    }
                }
                JSObject r = new JSObject();
                r.put("purchaseTokens", tokens);
                call.resolve(r);
            }), code -> {
                JSObject r = new JSObject();
                r.put("purchaseTokens", new JSArray());
                call.resolve(r);
            });
    }

    @PluginMethod
    public void manageSubscriptions(PluginCall call) {
        String productId = call.getString("productId");
        String url = "https://play.google.com/store/account/subscriptions?package=" + getContext().getPackageName()
            + (productId != null ? "&sku=" + Uri.encode(productId) : "");
        getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        call.resolve();
    }

    // iOS-only metódy — na Androide bezpečné prázdne odpovede.
    @PluginMethod
    public void purchaseApple(PluginCall call) { call.unavailable("iOS only"); }

    @PluginMethod
    public void restoreApple(PluginCall call) {
        JSObject r = new JSObject();
        r.put("signedTransactions", new JSArray());
        call.resolve(r);
    }

    @PluginMethod
    public void appleExternalPurchaseNotice(PluginCall call) {
        JSObject r = new JSObject();
        r.put("proceed", false);
        r.put("token", null);
        call.resolve(r);
    }
}
