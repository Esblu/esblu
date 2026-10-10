# Esblu Android - create the NEW Google Play UPLOAD keystore (one time).
#   cd <checkout>\release
#   powershell -ExecutionPolicy Bypass -File .\create-upload-keystore.ps1
#
# - You type the password yourself (hidden input, twice). It is passed to keytool
#   only via an environment variable of this process and never written to disk.
# - RSA 4096 / SHA256withRSA, PKCS12, alias "esblu", validity 30 years.
# - Refuses to overwrite an existing file. The old keystore is NOT touched.
# - Writes only PUBLIC fingerprints to upload-key.sha256 / upload-key.sha1 (used by build-release-aab.ps1).

$ErrorActionPreference = "Continue"
$Keystore = if ($env:ESBLU_UPLOAD_KEYSTORE) { $env:ESBLU_UPLOAD_KEYSTORE } else { Join-Path $env:USERPROFILE "Documents\Esblu-keys\esblu-upload-key-2026.jks" }
$Alias = "esblu"
$DName = "CN=Esblu, O=Esblu s. r. o., L=Bratislava, C=SK"
$ReleaseDir = $PSScriptRoot

function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }

. (Join-Path $PSScriptRoot "jdk21.ps1")
$null = Use-Jdk21OrFail
$keytool = "$env:JAVA_HOME\bin\keytool.exe"

if (Test-Path $Keystore) { Fail "$Keystore already exists - not overwriting." }
New-Item -ItemType Directory -Force -Path (Split-Path $Keystore) | Out-Null

function Read-Secret($prompt) {
  $s = Read-Host -AsSecureString $prompt
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

Write-Host "Choose a NEW strong password (min. 16 characters). Store it in your password manager FIRST."
$p1 = Read-Secret "New upload keystore password"
$p2 = Read-Secret "Repeat password"
if ($p1 -ne $p2) { $p1 = $null; $p2 = $null; Fail "Passwords do not match." }
if ($p1.Length -lt 16) { $p1 = $null; $p2 = $null; Fail "Password too short (min. 16 characters)." }
$env:ESBLU_UPLOAD_STORE_PASSWORD = $p1
$p1 = $null; $p2 = $null

try {
  # PKCS12: key password = keystore password.
  & $keytool -genkeypair -storetype PKCS12 -keystore $Keystore -alias $Alias `
    -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 10950 -dname $DName `
    -storepass:env ESBLU_UPLOAD_STORE_PASSWORD -keypass:env ESBLU_UPLOAD_STORE_PASSWORD 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Keystore)) { Fail "keytool -genkeypair failed" }

  $list = & $keytool -list -v -keystore $Keystore -alias $Alias -storepass:env ESBLU_UPLOAD_STORE_PASSWORD 2>&1 | Out-String
  $sha256 = ([regex]::Match($list, 'SHA256:\s*([0-9A-F:]+)')).Groups[1].Value
  $sha1 = ([regex]::Match($list, 'SHA1:\s*([0-9A-F:]+)')).Groups[1].Value
  if (-not $sha256) { Fail "Could not read the new certificate fingerprint" }

  Set-Content -Encoding ASCII -Path (Join-Path $ReleaseDir "upload-key.sha256") -Value $sha256
  Set-Content -Encoding ASCII -Path (Join-Path $ReleaseDir "upload-key.sha1") -Value $sha1

  Write-Host ""
  Write-Host "OK  new upload keystore: $Keystore" -ForegroundColor Green
  Write-Host "    alias: $Alias   (RSA 4096, SHA256withRSA, valid 30 years)"
  Write-Host "    SHA-256: $sha256"
  Write-Host "    SHA-1:   $sha1"
  Write-Host "Next: back up the .jks file + password, then run .\build-release-aab.ps1"
} finally {
  Remove-Item Env:ESBLU_UPLOAD_STORE_PASSWORD -ErrorAction SilentlyContinue
}
