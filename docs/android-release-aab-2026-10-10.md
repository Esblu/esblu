# Android release AAB — signing a príprava na Play Internal Testing (2026-10-10)

Nič sa nenahráva do Play Console. Heslá ani privátny kľúč nie sú v Gite, v docs ani v logoch.

## Upload keystore

| | |
|---|---|
| Súbor | `C:\Users\roiaj\Documents\Esblu-keys\esblu-upload-key.jks` (mimo repa) |
| Typ / alias | PKCS12 / `esblu` (PrivateKeyEntry) |
| Očakávaný SHA-256 (assetlinks candidate) | `D0:D0:81:55:01:54:6E:CF:F7:91:74:57:53:DB:F6:43:92:B7:D8:DA:F6:3A:DA:A5:77:0B:E0:0A:90:F6:A2:FC` |
| Debug keystore (iba lokálne testy) | SHA-256 `C3:C2:D1:5C:6D:3A:C1:7A:FF:2D:BD:3B:FC:52:D7:6D:F8:43:A2:44:55:CA:EF:E2:69:66:3A:27:F7:46:65:E0`, SHA-1 `76:0C:E2:79:81:D6:B0:6A:10:CE:99:6B:F3:43:94:AC:CD:9C:1B:26` |

PKCS12 má aj certifikát šifrovaný heslom → fingerprint sa dá overiť až po zadaní hesla (robí to skript nižšie, ešte pred buildom).

## Signing config

- `mobile/android/app/keystore.properties` (lokálne, gitignored): iba `storeFile` + `keyAlias`, **bez hesiel**.
- `build.gradle`: heslá z `keystore.properties`, inak z premenných procesu `ESBLU_UPLOAD_STORE_PASSWORD` / `ESBLU_UPLOAD_KEY_PASSWORD`.
- Bez `keystore.properties` vznikne nepodpísaný bundle (Play ho odmietne); debug kľúč sa nikdy nepoužije.

## Build (Windows, prepared checkout)

```powershell
cd "C:\Users\roiaj\assetpilot\Claude outputs\esblu-mobile-production-beta\release"
powershell -ExecutionPolicy Bypass -File .\build-release-aab.ps1
```
Skript: JDK 21 (Android Studio JBR) → kontrola `google-services.json` (com.esblu.app) → skrytý vstup hesiel (iba env procesu) → **overenie SHA-256 keystore = očakávaný, inak STOP** → `gradlew bundleRelease -PesbluVersionCode=1 -PesbluVersionName=1.0.0` → `release\esblu-1.0.0-vc1.aab` → `jarsigner -verify` + `keytool -printcert -jarfile` (nie debug, SHA-256 = očakávaný) → `release\esblu-1.0.0-vc1.signing.txt` (iba verejné fingerprinty).

Statická validácia hotového AAB (bez hesiel):
```
python3 scripts/verify-release-aab.py release/esblu-1.0.0-vc1.aab --expected-sha256 D0:D0:81:...:A2:FC
```
package, versionCode/Name, min/target SDK, podpis (nie debug, očakávaný kľúč), ABI, FCM zdroje, a web assets cez `android-prebuild-check --target production`.

## Play Console (po overení firmy)

1. **Create app**: Home → Create app → názov `Esblu`, jazyk SK, App, Free, vyhlásenia → Create.
2. **Internal testing**: Test and release → Testing → Internal testing → Create new release.
3. **Play App Signing**: pri prvom release potvrď „Use Google-generated key" (Play App Signing). Tvoj `.jks` ostáva **upload key**.
4. **Upload**: nahraj `release\esblu-1.0.0-vc1.aab` (versionCode 1 je prvý — appka v Play ešte neexistuje). Release notes, Save → Review → Start rollout to Internal testing.
5. **App signing SHA-256**: Test and release → App integrity → Play app signing → *App signing key certificate* → skopíruj **SHA-256** (pri viacerých certifikátoch všetky). Pošli mi **iba tento verejný fingerprint**.

## assetlinks.json — candidate (nenasadené)

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.esblu.app",
      "sha256_cert_fingerprints": [
        "D0:D0:81:55:01:54:6E:CF:F7:91:74:57:53:DB:F6:43:92:B7:D8:DA:F6:3A:DA:A5:77:0B:E0:0A:90:F6:A2:FC",
        "__PLAY_APP_SIGNING_SHA256__"
      ]
    }
  }
]
```
Produkčný deploy až po doplnení Play fingerprintu a tvojom súhlase.
