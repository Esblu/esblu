# Esblu pre-production RC kit (2026-10-12) — Windows

Branch `preprod-release-candidate`. **Debug/staging only.** Nothing here deploys, uploads to
Google Play, activates billing or touches production data. No secrets are in this kit.

## 0. Prerequisites

- Node 22 + npm, Git, Android Studio (SDK 36), **JDK 21** (`release\jdk21.ps1` picks it; JBR 25 is not used blindly).
- Your own `.env.local` / `mobile\.env.staging` (copy from the `*.example` files; never commit them).

## 1. Install

```powershell
cd <kit>
npm ci
```

## 2. Checks (all must PASS)

```powershell
npx tsc --noEmit
npm run lint          # baseline: 37 errors / 26 warnings, identical to 1fe2c17 (no new ones)
# all suites (52):
Get-Content package.json | ConvertFrom-Json | % { $_.scripts.PSObject.Properties.Name } |
  ? { $_ -like 'test:*' } | % { npm run -s $_; if ($LASTEXITCODE) { throw "FAIL $_" } }
```

## 3. Web + mobile builds (Turbopack, as on Vercel)

```powershell
npm run build                      # web
npm run build -w mobile            # static export (billing UI hidden by default)
npm run verify:mobile-bundle
node scripts\android-prebuild-check.mjs --target staging   # with mobile\.env.staging
```

Billing UI contract build (staging only): set `NEXT_PUBLIC_ESBLU_BILLING_UI=1` and
`NEXT_PUBLIC_ESBLU_ENV=staging` for `npm run build -w mobile`.

## 4. Android build matrix (JDK 21, debug)

```powershell
cd mobile; npx cap sync android; cd ..   # Capacitor CLI 8.5 (see docs/android-staging-device-build-2026-10-11.md)
cd release
powershell -ExecutionPolicy Bypass -File .\build-billing-matrix.ps1
```

Expected PASS lines: billing-off (no `com.android.billingclient`, no `com.android.vending.BILLING`,
`EsbluBillingPlugin` not compiled), billing-on (`billing:9.1.0`, plugin compiled, BILLING present),
diff = only BILLING, no new exported component, and in both variants: no
location/camera/contacts/storage/media/AD_ID/exact-alarm/foreground-service permission,
`android:allowBackup=false`, baseline permissions present. Report: `release\billing-matrix\report.txt`.

## 5. Device smoke (staging, debug APK)

Login (email + Google), session restore after force-stop, offline cold start (airplane mode →
"Esblu sa nepodarilo spustiť" + retry, NOT /login), dashboard cylinder, voice mic (permission
deny/allow), push register/unregister on logout, Predplatné shows "disabled" unless staging
billing env is set, Settings → Zrušiť účet preflight.

## 5b. Account deletion × subscription (2026-10-12)

`npm run test:account-deletion-subscription` and `npm run test:account-deletion-orchestration`
(both included in step 2). Migrations `20261012120000` and `20261012130000` are NOT applied
anywhere; without them the code falls back to "DB first, Storage after" without a retry job.
Texts for deleting before the end of a cancelled period: LEGAL/CLIA REVIEW REQUIRED
(`docs/account-deletion-subscription-policy-2026-10-12.md`, section 5d).

## 6. Hard stops

No `main` merge, no production deploy/migration/secrets, no Play upload, no Stripe/Apple/Play live,
no reviewer account, no production assetlinks. See `docs/preproduction-readiness-2026-10-12.md`.
