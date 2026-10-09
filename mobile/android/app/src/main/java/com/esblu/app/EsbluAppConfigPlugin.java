package com.esblu.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Natívna konfigurácia buildu pre JS (Mobile Platform 2026-10-09).
 *
 * fcmConfigured: google-services Gradle plugin vygeneruje string resource
 * "google_app_id" IBA ak je v buildi google-services.json. Bez neho by
 * PushNotifications.register() zlyhal na neinicializovanom FirebaseApp
 * (pád appky) — JS preto register() bez FCM vôbec nezavolá (PUSH NOT CONFIGURED).
 */
@CapacitorPlugin(name = "EsbluAppConfig")
public class EsbluAppConfigPlugin extends Plugin {
    @PluginMethod
    public void get(PluginCall call) {
        int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
        JSObject result = new JSObject();
        result.put("fcmConfigured", id != 0);
        call.resolve(result);
    }
}
