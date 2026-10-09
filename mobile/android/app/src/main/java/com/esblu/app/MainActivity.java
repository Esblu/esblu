package com.esblu.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Lokálne (app) Capacitor pluginy sa registrujú PRED super.onCreate
        // (Capacitor docs: Custom Native Android Code). Mobile Platform 2026-10-08.
        registerPlugin(EsbluSecureStoragePlugin.class);
        registerPlugin(EsbluAppConfigPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
