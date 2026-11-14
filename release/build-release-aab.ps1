# Esblu Android - signed release AAB for Google Play Internal Testing.
# Run from PowerShell:
#   cd <checkout>\release
#   powershell -ExecutionPolicy Bypass -File .\build-release-aab.ps1
#
# - Passwords are asked with hidden input and passed ONLY as environment
#   variables of this process (never written to disk, never printed).
# - Aborts if the upload key fingerprint is not the expected one (release\upload-key.sha256,
#   written by create-upload-keystore.ps1).
# - Output: esblu-<versionName>-vc<versionCode>.aab + .signing.txt (public fingerprints only).
# - versionCode must grow with EVERY Play upload: vc1 = first build (main @ 901c46c),
#   vc2 = Internal Testing build from mobile-platform (dashboard + voice), vc3 = 1.0.0
#   (bc31e63), vc4 = 1.0.1 public-release candidate (0a44a60, open registration),
#   vc5 = 1.0.2 security update (Next.js 16.4.6, Capacitor 8.6.2 - proxy origin fix).
#   An existing AAB with the same versionCode is never overwritten.
# - Parameters (2026-11-17; previously hard-coded vc2):
#     -VersionCode 5 -VersionName 1.0.2   (defaults = next free code after vc4)
#     -PrepareWeb   also builds fresh mobile web assets (npm ci, mobile build,
#                   npx cap sync android) before Gradle. Without it the script only
#                   verifies the existing synced assets (it never packages stale ones silently).
param(
  [int]$VersionCode = 5,
  [string]$VersionName = "1.0.2",
  [switch]$PrepareWeb
)

$ErrorActionPreference = "Continue"  # native tools write to stderr; every step is checked explicitly
if ($VersionCode -lt 5) { Write-Host "FAIL: versionCode $VersionCode is already used (vc1-vc4). Use 5 or higher." -ForegroundColor Red; exit 1 }
# NEW upload key (2026). The legacy esblu-upload-key.jks (unknown password) is NOT used.
$Keystore = if ($env:ESBLU_UPLOAD_KEYSTORE) { $env:ESBLU_UPLOAD_KEYSTORE } else { Join-Path $env:USERPROFILE "Documents\Esblu-keys\esblu-upload-key-2026.jks" }
$ShaFile = Join-Path $PSScriptRoot "upload-key.sha256"
if (-not (Test-Path $ShaFile)) { Write-Host "FAIL: run .\create-upload-keystore.ps1 first (upload-key.sha256 missing)" -ForegroundColor Red; exit 1 }
$ExpectedSha256 = (Get-Content $ShaFile -Raw).Trim()
$Alias = "esblu"

$ReleaseDir = $PSScriptRoot
$Root = Split-Path $ReleaseDir -Parent
$AndroidDir = Join-Path $Root "mobile\android"
$OutAab = Join-Path $ReleaseDir ("esblu-{0}-vc{1}.aab" -f $VersionName, $VersionCode)
$OutTxt = Join-Path $ReleaseDir ("esblu-{0}-vc{1}.signing.txt" -f $VersionName, $VersionCode)

function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }

if (Test-Path $OutAab) { Fail "$OutAab already exists - bump `$VersionCode instead of overwriting an uploaded/archived build" }
Write-Host ("Building com.esblu.app {0} (versionCode {1})" -f $VersionName, $VersionCode)

# --- JDK 21 (never JBR 25; existing valid JAVA_HOME is kept) -----------------------
. (Join-Path $PSScriptRoot "jdk21.ps1")
$null = Use-Jdk21OrFail
$keytool = "$env:JAVA_HOME\bin\keytool.exe"
$jarsigner = "$env:JAVA_HOME\bin\jarsigner.exe"

# --- Preconditions -----------------------------------------------------------------
if (-not (Test-Path $Keystore)) { Fail "Upload keystore not found: $Keystore" }
if (-not (Test-Path (Join-Path $AndroidDir "app\keystore.properties"))) { Fail "app\keystore.properties missing" }
if (-not (Test-Path (Join-Path $AndroidDir "app\google-services.json"))) { Fail "app\google-services.json missing (push)" }
$gs = Get-Content (Join-Path $AndroidDir "app\google-services.json") -Raw | ConvertFrom-Json
$pkgs = @($gs.client | ForEach-Object { $_.client_info.android_client_info.package_name })
if ($pkgs -notcontains "com.esblu.app") { Fail "google-services.json has no com.esblu.app client" }
Write-Host "Firebase project: $($gs.project_info.project_id) (com.esblu.app OK)"

# --- Mobile web assets (Capacitor) ---------------------------------------------------
$MobileDir = Join-Path $Root "mobile"
$Assets = Join-Path $AndroidDir "app\src\main\assets\public"
if ($PrepareWeb) {
  if (-not (Test-Path (Join-Path $MobileDir ".env.local"))) { Fail "mobile\.env.local missing (copy mobile\.env.production.example)" }
  Push-Location $Root
  try {
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail "npm ci failed" }
    & npm run build --workspace mobile
    if ($LASTEXITCODE -ne 0) { Fail "mobile web build failed" }
    Push-Location $MobileDir
    try { & npx cap sync android; if ($LASTEXITCODE -ne 0) { Fail "npx cap sync android failed" } } finally { Pop-Location }
    & node scripts\android-prebuild-check.mjs --target production
    if ($LASTEXITCODE -ne 0) { Fail "android-prebuild-check --target production failed" }
  } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $Assets "index.html"))) { Fail "No synced web assets in $Assets - run with -PrepareWeb (or npm run build -w mobile + npx cap sync android)" }
Push-Location $Root
try { & node scripts\verify-mobile-bundle.mjs $Assets; if ($LASTEXITCODE -ne 0) { Fail "verify-mobile-bundle failed" } } finally { Pop-Location }
# Closed-beta UI texts (SK/EN/DE) must not be in the bundle. ASCII-only patterns (PS 5.1 reads this file as ANSI).
$closedBeta = Get-ChildItem -Path $Assets -Recurse -Include *.js, *.html, *.txt | Select-String -Pattern "testerov", "approved testers", "freigegebene Tester" -SimpleMatch -List -ErrorAction SilentlyContinue
if ($closedBeta) { Fail "Synced assets still contain closed-beta texts - stale web build" }
$buildId = ([regex]::Match((Get-Content (Join-Path $Assets "index.html") -Raw), '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z')).Value
Write-Host "Web assets OK (build id $buildId)"

# --- Passwords (hidden input, process env only) ------------------------------------
function Read-Secret($prompt) {
  $s = Read-Host -AsSecureString $prompt
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$env:ESBLU_UPLOAD_STORE_PASSWORD = Read-Secret "Upload keystore password"
$kp = $null  # PKCS12: key password = keystore password
if ($kp) { $env:ESBLU_UPLOAD_KEY_PASSWORD = $kp } else { Remove-Item Env:ESBLU_UPLOAD_KEY_PASSWORD -ErrorAction SilentlyContinue }
$kp = $null

try {
  # --- 1. Fingerprint of the keystore BEFORE building ---------------------------------
  $list = & $keytool -list -v -keystore $Keystore -alias $Alias -storepass:env ESBLU_UPLOAD_STORE_PASSWORD 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Fail "keytool could not open the keystore (wrong password or alias)" }
  $ksSha256 = ([regex]::Match($list, 'SHA256:\s*([0-9A-F:]+)')).Groups[1].Value
  $ksSha1 = ([regex]::Match($list, 'SHA1:\s*([0-9A-F:]+)')).Groups[1].Value
  Write-Host "Keystore SHA-256: $ksSha256"
  if ($ksSha256 -ne $ExpectedSha256) { Fail "Upload key fingerprint does NOT match the expected $ExpectedSha256 - nothing built" }
  Write-Host "Upload key fingerprint matches." -ForegroundColor Green

  # --- 2. Build --------------------------------------------------------------------------
  Push-Location $AndroidDir
  try {
    # Gradle launcher AND daemon on the selected JDK 21 (not a JBR/JDK 25 daemon).
    # Each argument is its own array element; JAVA_HOME without trailing \ (see jdk21.ps1 Get-EsbluGradleArgs).
    $gradleArgs = Get-EsbluGradleArgs -JavaHome $env:JAVA_HOME -VersionCode $VersionCode -VersionName $VersionName
    Write-Host ("gradlew.bat " + (($gradleArgs | ForEach-Object { "[$_]" }) -join ' '))
    & .\gradlew.bat @gradleArgs
    if ($LASTEXITCODE -ne 0) { Fail "gradlew bundleRelease failed" }
  } finally { Pop-Location }

  $built = Join-Path $AndroidDir "app\build\outputs\bundle\release\app-release.aab"
  if (-not (Test-Path $built)) { Fail "AAB not found: $built" }
  Copy-Item $built $OutAab -Force

  # --- 3. Verify signature of the AAB ---------------------------------------------------
  & $jarsigner -verify $OutAab | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "jarsigner -verify failed (AAB not signed?)" }
  $cert = & $keytool -printcert -jarfile $OutAab 2>&1 | Out-String
  $aabSha256 = ([regex]::Match($cert, 'SHA256:\s*([0-9A-F:]+)')).Groups[1].Value
  $aabSha1 = ([regex]::Match($cert, 'SHA1:\s*([0-9A-F:]+)')).Groups[1].Value
  $owner = ([regex]::Match($cert, 'Owner:\s*(.+)')).Groups[1].Value.Trim()
  if ($cert -match 'CN=Android Debug') { Fail "AAB is signed with the DEBUG key" }
  if ($aabSha256 -ne $ExpectedSha256) { Fail "AAB signer SHA-256 $aabSha256 != expected" }

  @(
    "Esblu Android release $VersionName (versionCode $VersionCode)"
    "AAB: $OutAab"
    "Built: $(Get-Date -Format s)"
    "Signer (upload key) owner: $owner"
    "Upload key SHA-256: $aabSha256"
    "Upload key SHA-1:   $aabSha1"
    "Matches release\upload-key.sha256: YES"
  ) | Set-Content -Encoding ASCII $OutTxt

  Write-Host ""
  Write-Host "OK  signed AAB: $OutAab" -ForegroundColor Green
  Write-Host "    upload key SHA-256: $aabSha256"
  Write-Host "    upload key SHA-1:   $aabSha1"
  Write-Host "    public fingerprints saved to: $OutTxt"
} finally {
  Remove-Item Env:ESBLU_UPLOAD_STORE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:ESBLU_UPLOAD_KEY_PASSWORD -ErrorAction SilentlyContinue
}

