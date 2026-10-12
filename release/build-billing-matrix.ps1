# Esblu Android - subscriptions integration build matrix (DEBUG, STAGING ONLY).
#
#   cd <kit>\release
#   powershell -ExecutionPolicy Bypass -File .\build-billing-matrix.ps1
#
# Builds the SAME checkout twice with JDK 21:
#   A) normal build           : gradlew clean :app:assembleDebug
#   B) billing-enabled build  : gradlew clean :app:assembleDebug -PesbluBilling=true
# and verifies (PASS/FAIL per line, exit 1 on any FAIL):
#   - A has NO com.android.billingclient dependency and NO com.android.vending.BILLING permission
#   - B resolves com.android.billingclient:billing:9.1.0, compiles EsbluBillingPlugin,
#     and its merged manifest adds com.android.vending.BILLING
#   - permission / exported-component diff A -> B (everything printed to the report)
#   - package com.esblu.app, no cleartext traffic, no release signing used
# Output: .\billing-matrix\report.txt, both merged manifests, both debug APKs.
#
# Nothing here sends anything to Google Play or the Play Console. No secrets are read or printed.
# Debug builds only (Android debug keystore). Play Billing stays inactive until Play
# Console products exist - that is NOT done by this script.

$ErrorActionPreference = "Stop"
$Here = $PSScriptRoot
$Repo = Split-Path -Parent $Here
$Android = Join-Path $Repo "mobile\android"
$Out = Join-Path $Here "billing-matrix"
$AndroidNs = "http://schemas.android.com/apk/res/android"

. (Join-Path $Here "jdk21.ps1")
$null = Use-Jdk21OrFail

if (-not (Test-Path -LiteralPath (Join-Path $Android "gradlew.bat"))) { Write-Host "FAIL: $Android\gradlew.bat not found" -ForegroundColor Red; exit 1 }
if (-not (Test-Path -LiteralPath (Join-Path $Android "local.properties"))) { Write-Host "FAIL: mobile\android\local.properties (sdk.dir) missing - open the project once in Android Studio or copy it from the previous kit" -ForegroundColor Red; exit 1 }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$script:Lines = New-Object System.Collections.Generic.List[string]
$script:Failed = 0
function Log([string]$Text) { Write-Host $Text; $script:Lines.Add($Text) }
function Check([string]$Name, [bool]$Ok, [string]$Detail = "") {
  if ($Ok) { $tag = "PASS" } else { $tag = "FAIL"; $script:Failed++ }
  $line = "$tag  $Name"
  if ($Detail) { $line = "$line  ($Detail)" }
  if ($Ok) { Write-Host $line -ForegroundColor Green } else { Write-Host $line -ForegroundColor Red }
  $script:Lines.Add($line)
}

function Invoke-Gradle([string[]]$GradleArgs, [string]$LogFile) {
  # Gradle writes warnings to stderr; in Windows PowerShell 5.1 that must not become a terminating error.
  $ErrorActionPreference = "Continue"
  Push-Location $Android
  try {
    & .\gradlew.bat @GradleArgs --console=plain *> $LogFile
    return $LASTEXITCODE
  } finally { Pop-Location }
}

function Get-MergedManifest {
  # Final merged manifest (AGP 8): intermediates\merged_manifests\debug\...; fallback merged_manifest\debug\...
  $root = Join-Path $Android "app\build\intermediates"
  $all = @(Get-ChildItem -Path $root -Recurse -Filter "AndroidManifest.xml" -ErrorAction SilentlyContinue)
  $final = @($all | Where-Object { $_.FullName -match '\\merged_manifests\\debug\\' })
  if ($final.Count -eq 0) { $final = @($all | Where-Object { $_.FullName -match '\\merged_manifest\\debug\\' }) }
  return ($final | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}

function Read-ManifestFacts([string]$Path) {
  [xml]$x = Get-Content -LiteralPath $Path -Raw
  $m = $x.manifest
  $perms = @($m.'uses-permission' | ForEach-Object { $_.GetAttribute("name", $AndroidNs) } | Where-Object { $_ }) | Sort-Object -Unique
  $exported = @()
  foreach ($kind in @("activity", "activity-alias", "service", "receiver", "provider")) {
    foreach ($n in @($m.application.$kind)) {
      if ($n -and $n.GetAttribute("exported", $AndroidNs) -eq "true") { $exported += "$kind " + $n.GetAttribute("name", $AndroidNs) }
    }
  }
  $components = @()
  foreach ($kind in @("activity", "service", "receiver", "provider")) {
    foreach ($n in @($m.application.$kind)) { if ($n) { $components += "$kind " + $n.GetAttribute("name", $AndroidNs) } }
  }
  return [pscustomobject]@{
    Package     = $m.GetAttribute("package")
    Permissions = $perms
    Exported    = ($exported | Sort-Object -Unique)
    Components  = ($components | Sort-Object -Unique)
    Cleartext   = $m.application.GetAttribute("usesCleartextTraffic", $AndroidNs)
    NetConfig   = $m.application.GetAttribute("networkSecurityConfig", $AndroidNs)
    AllowBackup = $m.application.GetAttribute("allowBackup", $AndroidNs)
  }
}

# RC 2026-10-12: production-intended permission baseline (Play policy delta guard).
# Any of these appearing in a merged manifest = FAIL until there is an objective reason.
$ForbiddenPermissionPattern = '^android\.permission\.(ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION|CAMERA|READ_CONTACTS|WRITE_CONTACTS|GET_ACCOUNTS|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|READ_MEDIA_[A-Z_]+|SCHEDULE_EXACT_ALARM|USE_EXACT_ALARM|FOREGROUND_SERVICE[A-Z_]*|SYSTEM_ALERT_WINDOW|REQUEST_INSTALL_PACKAGES|QUERY_ALL_PACKAGES)$|^com\.google\.android\.gms\.permission\.AD_ID$'
function Check-Baseline([string]$Label, $Facts) {
  $bad = @($Facts.Permissions | Where-Object { $_ -match $ForbiddenPermissionPattern })
  Check "[$Label] no location/camera/contacts/storage/media/AD_ID/exact-alarm/foreground-service permission" ($bad.Count -eq 0) ($bad -join ', ')
  Check "[$Label] android:allowBackup=false" ($Facts.AllowBackup -eq "false") "allowBackup=$($Facts.AllowBackup)"
  foreach ($p in @("android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE", "android.permission.POST_NOTIFICATIONS", "android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS")) {
    Check "[$Label] baseline permission $p" ($Facts.Permissions -contains $p) ""
  }
  Log "  [$Label] permissions: $($Facts.Permissions -join ', ')"
  Log "  [$Label] exported: $($Facts.Exported -join ', ')"
}

function Build-Variant([string]$Label, [string[]]$ExtraArgs) {
  Log ""
  Log "=== Build $Label ==="
  $log = Join-Path $Out "gradle-$Label.log"
  $code = Invoke-Gradle (@("clean", ":app:assembleDebug") + $ExtraArgs) $log
  Check "[$Label] gradlew clean :app:assembleDebug $($ExtraArgs -join ' ')" ($code -eq 0) "log: $log"
  if ($code -ne 0) {
    Get-Content -LiteralPath $log -Tail 40 | ForEach-Object { Log "    $_" }
    return $null
  }
  $deps = Join-Path $Out "deps-$Label.txt"
  $null = Invoke-Gradle (@(":app:dependencies", "--configuration", "debugRuntimeClasspath") + $ExtraArgs) $deps
  $apk = Join-Path $Android "app\build\outputs\apk\debug\app-debug.apk"
  $apkCopy = Join-Path $Out "esblu-staging-subscriptions-$Label-debug.apk"
  if (Test-Path -LiteralPath $apk) { Copy-Item -LiteralPath $apk -Destination $apkCopy -Force }
  Check "[$Label] debug APK produced" (Test-Path -LiteralPath $apkCopy) $apkCopy
  $mf = Get-MergedManifest
  Check "[$Label] merged manifest found" ($null -ne $mf) ""
  if ($null -eq $mf) { return $null }
  $mfCopy = Join-Path $Out "merged-manifest-$Label.xml"
  Copy-Item -LiteralPath $mf.FullName -Destination $mfCopy -Force
  $pluginClass = @(Get-ChildItem -Path (Join-Path $Android "app\build\intermediates") -Recurse -Filter "EsbluBillingPlugin.class" -ErrorAction SilentlyContinue)
  return [pscustomobject]@{
    Facts       = Read-ManifestFacts $mfCopy
    DepsText    = (Get-Content -LiteralPath $deps -Raw)
    PluginClass = ($pluginClass.Count -gt 0)
  }
}

Log "Esblu billing build matrix  $(Get-Date -Format s)"
Log "Repo: $Repo"
try { Log "Commit: $(git -C $Repo rev-parse --short HEAD) ($(git -C $Repo rev-parse --abbrev-ref HEAD))" } catch { Log "Commit: (git not available)" }

$off = Build-Variant "billing-off" @()
$on = Build-Variant "billing-on" @("-PesbluBilling=true")

if ($off) {
  $f = $off.Facts
  Check "[billing-off] package com.esblu.app" ($f.Package -eq "com.esblu.app") $f.Package
  Check "[billing-off] NO com.android.billingclient dependency" (-not ($off.DepsText -match 'com\.android\.billingclient')) ""
  Check "[billing-off] NO com.android.vending.BILLING permission" (-not ($f.Permissions -contains "com.android.vending.BILLING")) ""
  Check "[billing-off] EsbluBillingPlugin NOT compiled" (-not $off.PluginClass) ""
  Check-Baseline "billing-off" $f
  Check "[billing-off] no cleartext traffic / custom network security config" ((-not $f.Cleartext -or $f.Cleartext -eq "false") -and -not $f.NetConfig) "usesCleartextTraffic=$($f.Cleartext)"
}
if ($on) {
  $f = $on.Facts
  Check "[billing-on] package com.esblu.app" ($f.Package -eq "com.esblu.app") $f.Package
  Check "[billing-on] com.android.billingclient:billing:9.1.0 resolved" ($on.DepsText -match 'com\.android\.billingclient:billing:9\.1\.0') ""
  Check "[billing-on] EsbluBillingPlugin compiled" $on.PluginClass ""
  Check-Baseline "billing-on" $f
  Check "[billing-on] com.android.vending.BILLING permission present" ($f.Permissions -contains "com.android.vending.BILLING") ""
  Check "[billing-on] no cleartext traffic / custom network security config" ((-not $f.Cleartext -or $f.Cleartext -eq "false") -and -not $f.NetConfig) "usesCleartextTraffic=$($f.Cleartext)"
}
if ($off -and $on) {
  $addedPerms = @($on.Facts.Permissions | Where-Object { $off.Facts.Permissions -notcontains $_ })
  $removedPerms = @($off.Facts.Permissions | Where-Object { $on.Facts.Permissions -notcontains $_ })
  $addedExported = @($on.Facts.Exported | Where-Object { $off.Facts.Exported -notcontains $_ })
  $addedComponents = @($on.Facts.Components | Where-Object { $off.Facts.Components -notcontains $_ })
  Log ""
  Log "=== Manifest diff billing-off -> billing-on ==="
  Log "Permissions added   : $($addedPerms -join ', ')"
  Log "Permissions removed : $($removedPerms -join ', ')"
  Log "Exported added      : $($addedExported -join ', ')"
  Log "Components added    : $($addedComponents -join ', ')"
  Log "Exported (billing-on): $($on.Facts.Exported -join ', ')"
  Log "Permissions (billing-on): $($on.Facts.Permissions -join ', ')"
  Check "manifest diff: only com.android.vending.BILLING permission added" (($addedPerms.Count -eq 1) -and ($addedPerms[0] -eq "com.android.vending.BILLING")) ($addedPerms -join ', ')
  Check "manifest diff: no permission removed" ($removedPerms.Count -eq 0) ""
  Check "manifest diff: billing adds no EXPORTED component" ($addedExported.Count -eq 0) ($addedExported -join ', ')
}

Log ""
if ($script:Failed -eq 0) { Log "RESULT: PASS (all checks)" } else { Log "RESULT: FAIL ($($script:Failed) check(s))" }
$report = Join-Path $Out "report.txt"
$script:Lines | Set-Content -LiteralPath $report -Encoding UTF8
Write-Host "Report: $report"
Write-Host "Install on phone (USB debugging):  adb install -r `"$Out\esblu-staging-subscriptions-billing-on-debug.apk`""
if ($script:Failed -ne 0) { exit 1 }
