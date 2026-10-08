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
| Sign in with Apple | READY (kód), fail closed | natívne ASAuthorization (`EsbluAppleSignInPlugin.swift`, SHA-256 nonce) → `signInWithIdToken`; bez pluginu systémový prehliadač; entitlement `com.apple.developer.applesignin`. Ponúkne sa iba pri `NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS` s `apple`; Google na iOS iba spolu s Apple | APPLE USER ACTION: capability na App ID, Services ID + kľúč, Apple provider v Supabase |
| Ikony | READY (2026-10-09) | AppIcon 1024 (bez alfa) zo schválenej master ikony; Xcode z nej odvodí všetky veľkosti. V 29 a 40 pt (Settings / Spotlight) text „Esblu" nie je čitateľný, symbol áno | voliteľne: symbol-only varianty malých veľkostí — iba so súhlasom (návrh v `mobile/icon-source/proposals/`) |
| Splash | READY | vygenerovaný zo schválenej `public/icons/icon-512.png` | STORE REVIEW |
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

## Aktualizácia 2 (2026-10-08)

- **Keychain:** `EsbluSecureStoragePlugin.swift` (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, nezálohuje sa).
  - Registrácia pluginu: `MainViewController.capacitorDidLoad`; `SceneDelegate` používa `MainViewController`.
  - Súbory sú pridané do `project.pbxproj` (Sources).
- **AASA:** šablóna `mobile/deep-link-templates/apple-app-site-association.template.json` s placeholderom `__APPLE_TEAM_ID__`. Render je fail-closed (`scripts/render-deep-link-files.mjs`). Nič nie je nasadené.
- **Stále XCODE NOT YET VERIFIED:** Swift súbory nikto neskompiloval.
