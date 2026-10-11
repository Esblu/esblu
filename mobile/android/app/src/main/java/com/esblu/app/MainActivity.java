package com.esblu.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Lokálne (app) Capacitor pluginy sa registrujú PRED super.onCreate
        // (Capacitor docs: Custom Native Android Code). Mobile Platform 2026-10-08.
        registerPlugin(EsbluSecureStoragePlugin.class);
        registerPlugin(EsbluAppConfigPlugin.class);
        registerOptionalBillingPlugin();
        super.onCreate(savedInstanceState);
    }

    /**
     * EsbluBilling sa kompiluje iba s -PesbluBilling=true (app/build.gradle).
     * Bez neho trieda neexistuje → plugin sa nezaregistruje a JS
     * (Capacitor.isPluginAvailable) ukáže, že nákup v obchode nie je dostupný.
     */
    private void registerOptionalBillingPlugin() {
        try {
            registerPlugin(Class.forName("com.esblu.app.billing.EsbluBillingPlugin").asSubclass(Plugin.class));
        } catch (ClassNotFoundException | ClassCastException ignored) {
            // default build bez Play Billing
        }
    }
}
