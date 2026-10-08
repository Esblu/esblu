package com.esblu.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Bezpečné úložisko auth relácie (Mobile Platform 2026-10-08).
 *
 * Hodnoty (Supabase session JSON, PKCE code_verifier) sa šifrujú AES-256-GCM
 * kľúčom v Android Keystore (nevyexportovateľný, viazaný na zariadenie) a
 * ciphertext (IV ‖ ct) sa ukladá do privátnych SharedPreferences.
 * allowBackup=false → ani ciphertext sa nezálohuje. Kľúče úložiska sú iba
 * z JS allowlistu (lib/mobile/secure-storage.ts), hodnoty sa nikdy nelogujú.
 * Poškodený / nedešifrovateľný záznam = zmazať a vrátiť null (fail closed →
 * používateľ sa prihlási znova), nikdy pád appky.
 */
@CapacitorPlugin(name = "EsbluSecureStorage")
public class EsbluSecureStoragePlugin extends Plugin {
    private static final String KEY_ALIAS = "esblu_secure_storage_v1";
    private static final String PREFS = "esblu_secure_storage";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    private String encrypt(String plain) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] ct = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        ByteBuffer out = ByteBuffer.allocate(iv.length + ct.length);
        out.put(iv).put(ct);
        return Base64.encodeToString(out.array(), Base64.NO_WRAP);
    }

    private String decrypt(String stored) throws Exception {
        byte[] all = Base64.decode(stored, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, all, 0, IV_BYTES));
        byte[] plain = cipher.doFinal(all, IV_BYTES, all.length - IV_BYTES);
        return new String(plain, StandardCharsets.UTF_8);
    }

    private static boolean validKey(String key) {
        return key != null && key.matches("^[A-Za-z0-9._-]{1,128}$");
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (!validKey(key)) { call.reject("INVALID_KEY"); return; }
        String stored = prefs().getString(key, null);
        JSObject result = new JSObject();
        if (stored == null) { result.put("value", JSObject.NULL); call.resolve(result); return; }
        try {
            result.put("value", decrypt(stored));
        } catch (Exception e) {
            prefs().edit().remove(key).apply();
            result.put("value", JSObject.NULL);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (!validKey(key) || value == null) { call.reject("INVALID_ARGUMENTS"); return; }
        try {
            // commit (synchrónne) — po resolve musí byť hodnota na disku (kill procesu).
            if (!prefs().edit().putString(key, encrypt(value)).commit()) { call.reject("WRITE_FAILED"); return; }
            call.resolve();
        } catch (Exception e) {
            call.reject("ENCRYPT_FAILED");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (!validKey(key)) { call.reject("INVALID_KEY"); return; }
        prefs().edit().remove(key).commit();
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        prefs().edit().clear().commit();
        call.resolve();
    }
}
