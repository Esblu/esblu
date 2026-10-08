# iOS — App Store release readiness (2026-10-08)

**Stav: iOS projekt VYTVORENÝ (`mobile/ios`), XCODE NOT YET VERIFIED.**

Projekt je vygenerovaný cez `npx cap add ios` (Capacitor 8, Swift Package Manager) z rovnakého webového základu. V tomto prostredí nie je macOS ani Xcode, takže nič nebolo skompilované ani spustené. Overené je iba staticky (plist / entitlements parsovanie a testy v `scripts/mobile-platform-tests.ts`).

V Apple Developer **nebolo nič registrované** (žiadne App ID, certifikáty ani provisioning).

| Položka | Stav | Detail | Blocker |
|---|---|---|---|
| Xcode projekt | READY (vygenerovaný) | `mobile/ios/App/App.xcodeproj`, SPM (`CapApp-SPM/Package.swift`) | XCODE NOT YET VERIFIED |
| Bundle identifier | READY | `com.esblu.app` (Debug + Release), zhodné s Androidom | APPLE USER ACTION: registrácia App ID |
| Deployment target | READY | iOS 15.0 (Capacitor 8 default) | — |
| Signing | PARTIAL | Automatic, **bez Team ID v repe** | APPLE USER ACTION: Apple Developer Program + Team v Xcode |
| Entitlements | PARTIAL | `App/App.entitlements`: `aps-environment`, `applinks:www.esblu.com` | APPLE USER ACTION: capabilities Push + Associated Domains |
| Associated Domains / Universal Links | PARTIAL | entitlement pripravený | APPLE USER ACTION + CONFIG: `https://www.esblu.com/.well-known/apple-app-site-association` s `<TeamID>.com.esblu.app` (web deploy so súhlasom) |
| OAuth návrat | READY | `CFBundleURLTypes` → `com.esblu.app` (PKCE) | CONFIG: Supabase Redirect URLs |
| Push (APNs) | PARTIAL | `AppDelegate` odovzdáva device token do `@capacitor/push-notifications`; server posiela priamo cez APNs | APPLE USER ACTION: APNs Auth Key (`.p8`), Key ID, Team ID do **server** env (nie do appky) |
| Foreground / background / tap | PARTIAL | `presentationOptions` badge, sound, alert; tap → `PushBridge` allowlist | REAL DEVICE TEST (push na simulátore iba čiastočne) |
| Fotoaparát / fotky / súbory | READY | `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription` | REAL DEVICE TEST |
| Mikrofón (hlas) | PARTIAL | `NSMicrophoneUsageDescription`; WKWebView `getUserMedia` | REAL DEVICE TEST |
| ATS / sieť | READY | žiadne `NSAllowsArbitraryLoads`; iba HTTPS (`capacitor://localhost` origin je v CORS allowliste) | — |
| Sign in with Apple | MISSING (zámerne) | iOS appka Google **neponúka** (App Review 4.8), iba e-mail + heslo | rozhodnutie: ponechať, alebo pridať Apple (APPLE USER ACTION + CODE) |
| Ikony | **MISSING** | `AppIcon.appiconset` = default Capacitor ikona | CODE/CONFIG: dodať Esblu ikonu 1024×1024 bez priehľadnosti |
| Splash | PARTIAL | default Capacitor splash | CODE/CONFIG |
| `UIRequiredDeviceCapabilities` | READY | `arm64` (pôvodné `armv7` z template opravené) | — |
| Export compliance | PARTIAL | `ITSAppUsesNonExemptEncryption = false` (iba HTTPS z OS) | LEGAL/CLIA: potvrdiť |
| App Store privacy labels | PARTIAL | rovnaké vstupy ako Google Data safety (`android-release-readiness`) | APPLE USER ACTION + LEGAL/CLIA |
| Zrušenie účtu (5.1.1(v)) | READY | v appke Nastavenia → Zrušiť účet; blokovaný owner dostane vysvetlenie | — |
| Recenzent / demo účet | MISSING | uzavretá beta → demo účet na allowliste + poznámky pre App Review | APPLE USER ACTION |
| Minimum funkcionality (4.2) | PARTIAL | natívne prvky: push, fotoaparát, share sheet, deep links, offline stav | STORE REVIEW |
| Lifecycle | READY | `AppLifecycleBridge` (refresh po návrate, `SIGNED_OUT` → login) | REAL DEVICE TEST |
| Safe area | READY | `viewport-fit=cover` v appke + `--esblu-safe-*` | REAL DEVICE TEST (notch, Dynamic Island) |

## Kroky na Macu (po tvojom súhlase s Apple Developer)

```bash
npm ci
npm run build -w mobile
cd mobile && npx cap sync ios && npx cap open ios
```

V Xcode:

1. Signing & Capabilities: vyber Team.
2. Pridaj Push Notifications a Associated Domains (entitlements súbor už existuje).
3. Spusti na simulátore a zariadení a prejdi checklist `REAL DEVICE TEST` z `mobile-architecture-2026-10-08.md`.
4. Product → Archive → TestFlight (interné testovanie).
