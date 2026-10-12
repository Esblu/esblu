# Esblu Android release tooling - JDK 21 selection (dot-source: . "$PSScriptRoot\jdk21.ps1").
#
# The Gradle/AGP/Capacitor release build is validated on JDK 21. Newer JDKs (e.g. the
# JDK 25 bundled as Android Studio JBR) fail with "Unsupported class file major version 69".
#
# Rules:
#  1. An existing JAVA_HOME that is JDK 21.x is used as-is (never overwritten).
#  2. Otherwise discover JDK 21.x in common Windows locations (newest 21.x first):
#     Eclipse Adoptium, Oracle/OpenJDK (Java), Microsoft, Zulu, Amazon Corretto, BellSoft.
#  3. Android Studio JBR is a candidate ONLY if it really is JDK 21.
#  4. No JDK 21 -> $null (caller fails with a clear message). JDK 25 is never accepted.
# No specific patch version is hardcoded; any 21.x works.

$script:EsbluRequiredJdkMajor = 21

function Invoke-JavaVersion {
  # Runs `<java> -version` and returns { ExitCode; Text } or $null when it cannot start.
  # `java -version` writes its normal output to STDERR. In Windows PowerShell 5.1 a redirected
  # native stderr (`& java -version 2>&1`) becomes ErrorRecords, which turn into a terminating
  # NativeCommandError whenever the caller runs with $ErrorActionPreference = "Stop".
  # System.Diagnostics.Process captures stdout/stderr as plain strings (no ErrorRecords),
  # independent of $ErrorActionPreference, identically in PowerShell 5.1 and 7.
  param([string]$JavaExe, [int]$TimeoutMs = 30000)
  if (-not $JavaExe -or -not (Test-Path -LiteralPath $JavaExe)) { return $null }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $JavaExe
    $psi.Arguments = "-version"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderr = $proc.StandardError.ReadToEnd()
    if (-not $proc.WaitForExit($TimeoutMs)) {
      try { $proc.Kill() } catch { }
      return [pscustomobject]@{ ExitCode = -1; Text = "TIMEOUT" }
    }
    $proc.WaitForExit()
    $text = ($stderr + "`n" + $stdoutTask.Result).Trim()
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; Text = $text }
  } catch {
    return $null
  }
}

function Get-JavaVersionMajor([string]$Text) {
  $m = [regex]::Match([string]$Text, 'version "(\d+)(?:\.(\d+))?')
  if (-not $m.Success) { return $null }
  $maj = [int]$m.Groups[1].Value
  if ($maj -eq 1 -and $m.Groups[2].Success) { $maj = [int]$m.Groups[2].Value }
  return $maj
}

function Get-JdkMajor {
  param([string]$JavaHome)
  if (-not $JavaHome) { return $null }
  $java = Join-Path $JavaHome "bin\java.exe"
  if (-not (Test-Path -LiteralPath $java)) { return $null }
  # 1) JDK "release" file (no process start): JAVA_VERSION="21.0.12"
  $rel = Join-Path $JavaHome "release"
  if (Test-Path -LiteralPath $rel) {
    $line = Get-Content -LiteralPath $rel | Where-Object { $_ -match '^JAVA_VERSION="?(\d+)(?:\.(\d+))?' } | Select-Object -First 1
    if ($line -and $line -match '^JAVA_VERSION="?(\d+)(?:\.(\d+))?') {
      $maj = [int]$Matches[1]; if ($maj -eq 1 -and $Matches[2]) { $maj = [int]$Matches[2] }
      return $maj
    }
  }
  # 2) Fallback: java -version (stderr, captured safely; non-zero exit = unknown)
  $r = Invoke-JavaVersion $java
  if (-not $r -or $r.ExitCode -ne 0) { return $null }
  return (Get-JavaVersionMajor $r.Text)
}

function Get-JdkDirVersion([string]$Name) {
  # "jdk-21.0.12.101-hotspot" -> 21.0.12.101 (numeric, so 21.0.12 sorts above 21.0.3)
  $m = [regex]::Match($Name, '(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?')
  if (-not $m.Success) { return [version]"0.0" }
  $parts = @(1..4 | ForEach-Object { if ($m.Groups[$_].Success) { [int]$m.Groups[$_].Value } else { 0 } })
  return [version]::new($parts[0], $parts[1], $parts[2], $parts[3])
}

function Get-Jdk21Candidates {
  param([string[]]$ProgramFilesRoots = $null)
  if (-not $ProgramFilesRoots) {
    $ProgramFilesRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)})
    if ($env:LOCALAPPDATA) { $ProgramFilesRoots += (Join-Path $env:LOCALAPPDATA "Programs") }
  }
  $patterns = @(
    "Eclipse Adoptium\jdk-21*",
    "Java\jdk-21*",
    "Microsoft\jdk-21*",
    "Zulu\zulu-21*",
    "Amazon Corretto\jdk21*",
    "BellSoft\LibericaJDK-21*"
  )
  $found = @()
  foreach ($root in ($ProgramFilesRoots | Where-Object { $_ })) {
    foreach ($p in $patterns) {
      $found += @(Get-ChildItem -Path (Join-Path $root $p) -Directory -ErrorAction SilentlyContinue |
        Sort-Object -Descending -Property @{ Expression = { Get-JdkDirVersion $_.Name } } | ForEach-Object { $_.FullName })
    }
  }
  # Android Studio JBR last; accepted only if its major is 21 (checked by Select-Jdk21).
  foreach ($root in ($ProgramFilesRoots | Where-Object { $_ })) {
    $jbr = Join-Path $root "Android\Android Studio\jbr"
    if (Test-Path -LiteralPath $jbr) { $found += $jbr }
  }
  return $found
}

function Select-Jdk21 {
  param(
    [string]$CurrentJavaHome = $env:JAVA_HOME,
    [string[]]$Candidates = (Get-Jdk21Candidates)
  )
  $required = $script:EsbluRequiredJdkMajor
  if ($CurrentJavaHome -and (Get-JdkMajor $CurrentJavaHome) -eq $required) {
    return [pscustomobject]@{ Home = $CurrentJavaHome; Source = "JAVA_HOME (existing, kept)" }
  }
  foreach ($c in $Candidates) {
    if ((Get-JdkMajor $c) -eq $required) {
      return [pscustomobject]@{ Home = $c; Source = "discovered" }
    }
  }
  return $null
}

function Use-Jdk21OrFail {
  # Sets JAVA_HOME for THIS process only when the existing one is not JDK 21.
  $sel = Select-Jdk21
  if (-not $sel) {
    $cur = if ($env:JAVA_HOME) { "$env:JAVA_HOME (major $(Get-JdkMajor $env:JAVA_HOME))" } else { "<not set>" }
    Write-Host "FAIL: JDK 21 is required for the Esblu Android release build (newer JDKs such as 25 are not supported by this Gradle build)." -ForegroundColor Red
    Write-Host "      JAVA_HOME: $cur" -ForegroundColor Red
    Write-Host "      Install Eclipse Temurin 21 (https://adoptium.net) or set JAVA_HOME to a JDK 21." -ForegroundColor Red
    exit 1
  }
  if ($env:JAVA_HOME -ne $sel.Home) { $env:JAVA_HOME = $sel.Home }
  # Real check of the selected runtime: exit code 0 AND `java -version` reports major 21.
  $r = Invoke-JavaVersion (Join-Path $env:JAVA_HOME "bin\java.exe")
  $verLine = if ($r) { ($r.Text -split "`r?`n" | Select-Object -First 1) } else { "<java.exe could not be started>" }
  if (-not $r -or $r.ExitCode -ne 0 -or (Get-JavaVersionMajor $r.Text) -ne $script:EsbluRequiredJdkMajor) {
    $code = if ($r) { $r.ExitCode } else { "n/a" }
    Write-Host "FAIL: JDK 21 is required for the Esblu Android release build (java -version check failed)." -ForegroundColor Red
    Write-Host "      JAVA_HOME: $env:JAVA_HOME  exit code: $code  output: $verLine" -ForegroundColor Red
    exit 1
  }
  Write-Host "Selected JAVA_HOME: $env:JAVA_HOME  [$($sel.Source)]"
  Write-Host "Java version: $verLine"
  return $sel
}
