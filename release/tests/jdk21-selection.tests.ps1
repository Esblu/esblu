# Regression tests for release\jdk21.ps1 (no Pester needed, Windows PowerShell 5.1+ / pwsh).
#   powershell -ExecutionPolicy Bypass -File release\tests\jdk21-selection.tests.ps1
# Uses fake JDK folders (JDK "release" file + empty bin\java.exe) - no real JDK started.

$ErrorActionPreference = "Stop"
. (Join-Path (Split-Path $PSScriptRoot -Parent) "jdk21.ps1")

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("esblu-jdk-tests-" + [guid]::NewGuid())
function New-FakeJdk([string]$path, [string]$version) {
  New-Item -ItemType Directory -Force -Path (Join-Path $path "bin") | Out-Null
  Set-Content -LiteralPath (Join-Path $path "bin\java.exe") -Value ""
  Set-Content -LiteralPath (Join-Path $path "release") -Value ("JAVA_VERSION=`"$version`"")
  return $path
}
$pf = Join-Path $tmp "Program Files"
$adopt21 = New-FakeJdk (Join-Path $pf "Eclipse Adoptium\jdk-21.0.12.101-hotspot") "21.0.12"
$adopt21old = New-FakeJdk (Join-Path $pf "Eclipse Adoptium\jdk-21.0.3.9-hotspot") "21.0.3"
$jbr25 = New-FakeJdk (Join-Path $pf "Android\Android Studio\jbr") "25.0.1"
$other21 = New-FakeJdk (Join-Path $tmp "custom\jdk21") "21.0.7"
$jdk17 = New-FakeJdk (Join-Path $tmp "custom\jdk17") "17.0.10"

$passed = 0; $failed = 0
function Check($label, [scriptblock]$test) {
  try { if (& $test) { $script:passed++; Write-Host "  ok  $label" } else { $script:failed++; Write-Host "  FAIL $label" -ForegroundColor Red } }
  catch { $script:failed++; Write-Host "  FAIL $label : $_" -ForegroundColor Red }
}

try {
  Check "Get-JdkMajor reads 21 / 25 / 17 from JDK release file (no hardcoded patch)" {
    (Get-JdkMajor $adopt21) -eq 21 -and (Get-JdkMajor $adopt21old) -eq 21 -and (Get-JdkMajor $jbr25) -eq 25 -and (Get-JdkMajor $jdk17) -eq 17
  }
  Check "discovery finds Adoptium jdk-21*, newest first, JBR last" {
    $c = Get-Jdk21Candidates -ProgramFilesRoots @($pf)
    $c[0] -eq $adopt21 -and $c[-1] -eq $jbr25
  }
  Check "JAVA_HOME = JDK 21 -> PASS and kept as-is (not overwritten)" {
    $s = Select-Jdk21 -CurrentJavaHome $other21 -Candidates (Get-Jdk21Candidates -ProgramFilesRoots @($pf))
    $s.Home -eq $other21 -and $s.Source -like "JAVA_HOME*"
  }
  Check "JAVA_HOME = JDK 25 -> not used blindly, JDK 21 selected instead" {
    $s = Select-Jdk21 -CurrentJavaHome $jbr25 -Candidates (Get-Jdk21Candidates -ProgramFilesRoots @($pf))
    $s.Home -eq $adopt21
  }
  Check "Android Studio JBR 25 + Adoptium 21 available, JAVA_HOME unset -> Adoptium 21" {
    $s = Select-Jdk21 -CurrentJavaHome "" -Candidates (Get-Jdk21Candidates -ProgramFilesRoots @($pf))
    $s.Home -eq $adopt21 -and $s.Source -eq "discovered"
  }
  Check "JBR accepted only when it really is JDK 21" {
    $pf2 = Join-Path $tmp "pf2"
    $jbr21 = New-FakeJdk (Join-Path $pf2 "Android\Android Studio\jbr") "21.0.5"
    $s = Select-Jdk21 -CurrentJavaHome "" -Candidates (Get-Jdk21Candidates -ProgramFilesRoots @($pf2))
    $s.Home -eq $jbr21
  }
  Check "no JDK 21 anywhere (JAVA_HOME 17, only JBR 25) -> null (clear FAIL in caller)" {
    $pf3 = Join-Path $tmp "pf3"
    New-FakeJdk (Join-Path $pf3 "Android\Android Studio\jbr") "25.0.1" | Out-Null
    $null -eq (Select-Jdk21 -CurrentJavaHome $jdk17 -Candidates (Get-Jdk21Candidates -ProgramFilesRoots @($pf3)))
  }
  Check "missing JAVA_HOME folder / no java.exe -> ignored" {
    (Get-JdkMajor (Join-Path $tmp "does-not-exist")) -eq $null
  }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "jdk21-selection: $passed passed, $failed failed"
if ($failed) { exit 1 }
