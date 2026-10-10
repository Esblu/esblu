# 07 — Permissions / manifest / policy audit

Zdroj: merged manifest z podpísaného `release/esblu-1.0.0-vc1.aab` (aapt2 proto, `scripts/verify-release-aab.py` + výpis komponentov), 2026-10-11.

## Povolenia
| Povolenie | Prečo | Play declaration? | User-facing disclosure |
|---|---|---|---|
| `INTERNET` | celá appka (API, Supabase) | nie | nie |
| `POST_NOTIFICATIONS` | push (Android 13+ runtime) | nie | runtime dialóg sa zobrazí iba po kliknutí „Zapnúť" v Nastaveniach (v kontexte) |
| `RECORD_AUDIO` | hlasový asistent (WebView `getUserMedia`) | nie (žiadny formulár; spadá pod User Data policy) | runtime dialóg pri prvom použití mikrofónu; spomenúť v privacy policy (hlas → OpenAI) — **CLIA** |
| `MODIFY_AUDIO_SETTINGS` | WebView audio capture (WebRTC) | nie (normal) | nie |
| `ACCESS_NETWORK_STATE`, `WAKE_LOCK` | Firebase Messaging (merge) | nie (normal) | nie |
| `com.google.android.c2dm.permission.RECEIVE` | FCM príjem | nie | nie |
| `com.esblu.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | AndroidX (interné, signature) | nie | nie |
| CAMERA, location, READ_MEDIA_*, storage, AD_ID, FOREGROUND_SERVICE*, exact alarm, contacts, phone/SMS, Bluetooth | **nie sú** | — | fotoaparát cez systémový `IMAGE_CAPTURE` intent, súbory cez systémový výber |

Nič na odstránenie.

## Komponenty a konfigurácia
| Položka | Stav |
|---|---|
| targetSdk / minSdk | 36 / 24 — spĺňa požiadavku API 36 (nové appky a updaty od 31. 8. 2026) |
| 64-bit / native | ABI `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` (z AndroidX/Capacitor knižníc) — 64-bit ✅; `extractNativeLibs=false` |
| Exportované | `MainActivity` (launcher + App Links + OAuth scheme — nutné); `FirebaseInstanceIdReceiver` (chránený `c2dm.permission.SEND`); `ProfileInstallReceiver` (chránený `DUMP`). Ostatné (FileProvider, Browser, MessagingService, Firebase providery/služby) `exported=false` |
| Backup | `allowBackup=false`. Odporúčanie (ďalší build, nie blocker): pridať `dataExtractionRules` (Android 12+ device-to-device transfer); session je šifrovaná kľúčom v Android Keystore, ktorý sa neprenáša |
| Cleartext | `usesCleartextTraffic` nenastavené → pri targetSdk 36 zakázané; žiadny network security config |
| App Links | `autoVerify` pre `https://www.esblu.com` (`/invite`, `/invite/*`, `/reset-hesla`, `/onboarding/company`, `/auth/callback`) — overenie až s Play App Signing fingerprintom v `assetlinks.json` |
| OAuth callback | `com.esblu.app://auth/callback` (Custom Tab, PKCE; redirect povolený v produkčnom Supabase) |
| AI-generated content policy | AI iba vyťažuje údaje z dokladov (používateľ vždy potvrdzuje) + asistent príkazov → pravdepodobne výnimka „productivity"; in-app „nahlásiť výstup AI" odporúčané pred Production (produktové rozhodnutie) |
