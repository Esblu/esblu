# Esblu Android - signed release AAB for Google Play Internal Testing.
# Run from PowerShell:
#   cd <checkout>\release
#   powershell -ExecutionPolicy Bypass -File .\build-release-aab.ps1
#
# - Passwords are asked with hidden input and passed ONLY as environment
#   variables of this process (never written to disk, never printed).
# - Aborts if the upload key fingerprint is not the expected one (release\upload-key.sha256,
#   written by create-upload-keystore.ps1).
# - Output: esblu-1.0.0-vc1.aab + esblu-1.0.0-vc1.signing.txt (public fingerprints only).

$ErrorActionPreference = "Continue"  # native tools write to stderr; every step is checked explicitly
$VersionCode = 1
$VersionName = "1.0.0"
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
    & .\gradlew.bat bundleRelease "-Dorg.gradle.java.home=$env:JAVA_HOME" "-PesbluVersionCode=$VersionCode" "-PesbluVersionName=$VersionName"
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

