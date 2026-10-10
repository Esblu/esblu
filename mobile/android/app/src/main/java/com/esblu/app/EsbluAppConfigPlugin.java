package com.esblu.app;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.view.HapticFeedbackConstants;
import android.view.View;
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
 *
 * Voice hardening (2026-10-11):
 * haptic: krátka haptická odozva pri štarte/stope hlasového režimu cez
 *   View.performHapticFeedback — nevyžaduje povolenie VIBRATE a rešpektuje
 *   systémové nastavenie „Dotyková odozva".
 * openAppSettings: otvorí systémové nastavenia appky (Povolenia → Mikrofón),
 *   keď používateľ mikrofón trvalo zakázal („Nepýtať sa znova") a výzva sa
 *   už nedá zobraziť.
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

    @PluginMethod
    public void haptic(PluginCall call) {
        String kind = call.getString("kind", "start");
        final int constant = "error".equals(kind) ? HapticFeedbackConstants.LONG_PRESS : HapticFeedbackConstants.VIRTUAL_KEY;
        getActivity().runOnUiThread(() -> {
            View view = getBridge().getWebView();
            if (view != null) {
                view.performHapticFeedback(constant);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("settings_unavailable");
        }
    }
}
