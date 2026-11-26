<#
  Regresny test DPAPI ulozenia serveroveho kluca zalohy (Windows PowerShell 5.1+), 2026-11-26.
  Iba SYNTETICKA hodnota (nahodna, vytvorena testom), docasny priecinok, ziadna siet, ziadny Supabase.
  Vypisuje iba nazvy testov a vysledok - nikdy hodnotu.
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\tests\esblu-backup-secret.tests.ps1
#>
$ErrorActionPreference = "Stop"
. (Join-Path (Split-Path $PSScriptRoot -Parent) "esblu-backup-secret.ps1")

$script:pass = 0; $script:fail = 0
function T([string]$name, [scriptblock]$body) {
  try { & $body; $script:pass++; Write-Host "  ok  $name" }
  catch { $script:fail++; Write-Host "  FAIL $name :: $($_.Exception.Message)" -ForegroundColor Red }
}
function Hash([string]$s) {
  $sha = [Security.Cryptography.SHA256]::Create()
  return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))
}
function Expect-Code([scriptblock]$body, [string]$code) {
  try { & $body } catch { if ($_.Exception.Message -like "$code*") { return } else { throw "ocakavane $code, prislo: $($_.Exception.Message.Split(':')[0])" } }
  throw "ocakavana chyba $code, ziadna nenastala"
}

$dir = Join-Path ([IO.Path]::GetTempPath()) ("esblu-secret-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $dir | Out-Null
$bytes = New-Object byte[] 24; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
$plain = "sb_secret_SYNTHETIC" + ([BitConverter]::ToString($bytes) -replace '-', '')   # syntetika, nie realny kluc
$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
$want = Hash $plain

try {
  T "Setup -> nacitanie -> pouzitie: rovnaka hodnota (porovnanie hashom), typ sb_secret" {
    $p = Join-Path $dir "new.dpapi"
    Save-EsbluSecret -Secure $secure -Path $p
    $got = ConvertFrom-EsbluSecure (Read-EsbluSecret -Path $p)
    if ((Hash $got) -ne $want) { throw "hodnota sa nezhoduje" }
    if ((Get-EsbluSecretKind $got).kind -ne "sb_secret") { throw "zly typ" }
    $txt = [IO.File]::ReadAllText($p)
    if ($txt -match "`r|`n") { throw "subor obsahuje koncovy riadok" }
    if ([IO.File]::ReadAllBytes($p)[0] -eq 0xEF) { throw "subor ma BOM" }
  }
  T "stary format zo -Setup (Set-Content -Encoding ASCII, koncovy CRLF) = povodna chyba; teraz sa nacita" {
    $p = Join-Path $dir "legacy.dpapi"
    $secure | ConvertFrom-SecureString | Set-Content -Path $p -Encoding ASCII
    $legacyFails = $false
    try { Get-Content $p -Raw | ConvertTo-SecureString | Out-Null } catch { $legacyFails = $true }
    Write-Host "       (povodne citanie Get-Content -Raw | ConvertTo-SecureString zlyhalo: $legacyFails)"
    if ((Hash (ConvertFrom-EsbluSecure (Read-EsbluSecret -Path $p))) -ne $want) { throw "hodnota sa nezhoduje" }
  }
  T "UTF-8 s BOM, UTF-16 (Out-File) a medzery okolo - nacita sa" {
    $enc = $secure | ConvertFrom-SecureString
    $p1 = Join-Path $dir "bom.dpapi";  [IO.File]::WriteAllText($p1, "  $enc  `r`n", (New-Object Text.UTF8Encoding($true)))
    $p2 = Join-Path $dir "utf16.dpapi"; $enc | Out-File -FilePath $p2
    foreach ($p in @($p1, $p2)) { if ((Hash (ConvertFrom-EsbluSecure (Read-EsbluSecret -Path $p))) -ne $want) { throw "hodnota sa nezhoduje ($p)" } }
  }
  T "chybajuci subor -> SECRET_MISSING" { Expect-Code { Read-EsbluSecret -Path (Join-Path $dir "nie.dpapi") } "SECRET_MISSING" }
  T "prazdny subor -> SECRET_FORMAT" {
    $p = Join-Path $dir "empty.dpapi"; [IO.File]::WriteAllText($p, "`r`n"); Expect-Code { Read-EsbluSecret -Path $p } "SECRET_FORMAT"
  }
  T "poskodeny obsah (nie hex) -> SECRET_FORMAT" {
    $p = Join-Path $dir "bad.dpapi"; [IO.File]::WriteAllText($p, "toto nie je dpapi"); Expect-Code { Read-EsbluSecret -Path $p } "SECRET_FORMAT"
  }
  T "hex, ale nie DPAPI blob tohto pouzivatela/PC -> SECRET_DPAPI" {
    $p = Join-Path $dir "foreign.dpapi"; [IO.File]::WriteAllText($p, ("01000000d08c9ddf0115d1118c7a00c04fc297eb" + ("ab" * 40)))
    Expect-Code { Read-EsbluSecret -Path $p } "SECRET_DPAPI"
  }
  T "orezany blob -> SECRET_DPAPI alebo SECRET_FORMAT" {
    $enc = $secure | ConvertFrom-SecureString
    $p = Join-Path $dir "trunc.dpapi"; [IO.File]::WriteAllText($p, $enc.Substring(0, 100))
    try { Read-EsbluSecret -Path $p | Out-Null; throw "nacital sa orezany blob" }
    catch { if ($_.Exception.Message -notmatch '^SECRET_(DPAPI|FORMAT)') { throw "neocakavana chyba" } }
  }
  T "prazdny SecureString pri ulozeni -> SECRET_EMPTY" {
    Expect-Code { Save-EsbluSecret -Secure (New-Object Security.SecureString) -Path (Join-Path $dir "e2.dpapi") } "SECRET_EMPTY"
  }
  T "chybove hlasky neobsahuju hodnotu ani obsah suboru" {
    $p = Join-Path $dir "leak.dpapi"; [IO.File]::WriteAllText($p, "x" + $plain)
    try { Read-EsbluSecret -Path $p | Out-Null } catch { if ($_.Exception.Message -like "*$plain*" -or $_.Exception.Message -like "*SYNTHETIC*") { throw "unik hodnoty" } }
  }
  T "neznamy tvar kluca sa rozpozna (bez vypisu hodnoty)" {
    if ((Get-EsbluSecretKind "nahodny text").kind -ne "neznamy") { throw "zly typ" }
    if ((Get-EsbluSecretKind "eyJa.eyJb.c").kind -ne "jwt") { throw "zly typ jwt" }
  }
}
finally {
  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  $plain = $null
}
Write-Host ""
Write-Host ("esblu-backup-secret: {0} passed, {1} failed" -f $script:pass, $script:fail)
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
