<#
  Esblu - denna sifrovana zaloha produkcie (Windows PowerShell 5.1), 2026-11-20.
  Spusta scripts/ops/esblu-daily-backup.mjs. Nic nemeni v produkcii.

  -Setup   jednorazovo: skryte zadanie serveroveho kluca (ulozi sa iba sifrovane cez Windows DPAPI pre
           tohto pouzivatela), cesta k VEREJNEMU klucu + odtlacok, cielovy priecinok, uloha v Planovaci uloh.
  (bez)    denny beh (Planovac uloh): zaloha + kontrola integrity + retencia, log bez tajomstiev.
  -Setup -NoSchedule  ako -Setup, ale BEZ ulohy v Planovaci uloh (jednorazova zaloha pred release).
  -Diagnose  sietova diagnostika Node (DNS, TLS, verejny GET) bez kluca; nic nespusta.
  -UseSystemCa  Node pouzije aj certifikaty z Windows (antivirus/proxy s vlastnym korenovym certifikatom).
  -CheckSecret  iba overi, ze ulozeny kluc sa da nacitat (vypise typ a dlzku, nikdy hodnotu); nic nespusta.
  -Status  kontrola: posledna uspesna zaloha je mladsia ako 30 h a po nej nie je zlyhanie (exit 0/1);
           s -Notify zobrazi okno s upozornenim (uloha pri prihlaseni + po kazdom dennom behu).

  Sukromny kluc zalohy NEPATRI na tento PC (USB / trezor / spravca hesiel). Bez neho sa zaloha neda obnovit.
#>
param([switch]$Setup, [switch]$NoSchedule, [switch]$CheckSecret, [switch]$Diagnose, [switch]$UseSystemCa, [switch]$Status, [switch]$Notify, [string]$PublicKey = "", [string]$Fingerprint = "",
      [string]$BackupDir = "", [string]$Time = "02:30", [int]$MaxAgeHours = 30)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "esblu-backup-secret.ps1")
$ConfDir = Join-Path $env:LOCALAPPDATA "Esblu\backup"
$KeyFile = Join-Path $ConfDir "server-key.dpapi"
$ConfFile = Join-Path $ConfDir "config.json"
$Script = Join-Path $PSScriptRoot "esblu-daily-backup.mjs"
$TaskName = "Esblu denna zaloha"
$ps = (Get-Process -Id $PID).Path

function Fail($m) { Write-Host "CHYBA: $m" -ForegroundColor Red; exit 1 }

function Get-BackupHealth([string]$Dir, [int]$MaxAge) {
  # Iba subory bez osobnych udajov: last-success.json / last-failure.json.
  $ok = Join-Path $Dir "last-success.json"
  $bad = Join-Path $Dir "last-failure.json"
  if (-not (Test-Path $ok)) { return @{ ok = $false; msg = "Esblu zaloha: ziadna uspesna zaloha v $Dir" } }
  $s = Get-Content $ok -Raw | ConvertFrom-Json
  $t = [DateTime]::Parse([string]$s.created_at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal)
  $age = ([DateTime]::UtcNow - $t).TotalHours
  if (Test-Path $bad) {
    $f = Get-Content $bad -Raw | ConvertFrom-Json
    $ft = [DateTime]::Parse([string]$f.at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal)
    if ($ft -gt $t) { return @{ ok = $false; msg = "Esblu zaloha ZLYHALA ($($f.at), exit $($f.exit)) - pozri backup.log" } }
  }
  if ($age -gt $MaxAge) { return @{ ok = $false; msg = ("Esblu zaloha je stara {0:N0} h (limit {1} h) - PC bol vypnuty alebo uloha nebezi" -f $age, $MaxAge) } }
  $w = @($s.warnings | Where-Object { $_ })
  if ($w.Count -gt 0) { return @{ ok = $true; msg = "Esblu zaloha OK, upozornenia: $($w -join '; ')" } }
  return @{ ok = $true; msg = ("Esblu zaloha OK ({0:N0} h, {1} suborov, {2} riadkov)" -f $age, $s.storage_objects, $s.rows) }
}

if ($Status) {
  if (-not (Test-Path $ConfFile)) { Fail "najprv -Setup" }
  $conf = Get-Content $ConfFile -Raw | ConvertFrom-Json
  $h = Get-BackupHealth $conf.backupDir $MaxAgeHours
  Write-Host $h.msg
  if ($Notify -and (-not $h.ok -or $h.msg -match "upozornenia")) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($h.msg, "Esblu zaloha", "OK", $(if ($h.ok) { "Warning" } else { "Error" }))
  }
  if ($h.ok) { exit 0 } else { exit 1 }
}

if ($Setup) {
  if (-not (Test-Path $Script)) { Fail "chyba $Script" }
  if (-not $PublicKey -or -not (Test-Path $PublicKey)) { Fail "zadaj -PublicKey <cesta k esblu-backup-public.pem> (z --init-keys)" }
  if ($Fingerprint -notmatch '^[0-9a-f]{64}$') { Fail "zadaj -Fingerprint <ESBLU_BACKUP_PUBKEY_SHA256 z --init-keys>" }
  if (-not $BackupDir) { $BackupDir = Join-Path $env:USERPROFILE "esblu-backups\daily" }
  if ($BackupDir -match '(?i)\\onedrive') { Fail "cielovy priecinok nesmie byt v OneDrive" }
  New-Item -ItemType Directory -Force -Path $ConfDir | Out-Null
  & icacls $ConfDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
  Write-Host "Supabase Dashboard -> projekt assetpilot -> Project Settings -> API Keys -> Secret keys ->"
  Write-Host "vytvor NOVY secret kluc s nazvom 'backup' (da sa samostatne zrusit). Vloz ho sem (nezobrazi sa)."
  $sec = Read-Host -AsSecureString "Serverovy kluc pre zalohu"
  try { Save-EsbluSecret -Secure $sec -Path $KeyFile }   # DPAPI, iba tento pouzivatel a PC; ASCII bez BOM a CRLF
  catch { Fail $_.Exception.Message }
  $kindInfo = Get-EsbluSecretKind (ConvertFrom-EsbluSecure $sec)
  if ($kindInfo.kind -eq "neznamy") { Remove-Item -LiteralPath $KeyFile -Force; Fail "vlozena hodnota nema tvar serveroveho kluca (sb_secret_... alebo JWT) - nic sa neulozilo" }
  Write-Host ("Kluc ulozeny (typ {0}, dlzka {1})." -f $kindInfo.kind, $kindInfo.length)
  [ordered]@{ publicKey = (Resolve-Path $PublicKey).Path; fingerprint = $Fingerprint; backupDir = $BackupDir } |
    ConvertTo-Json | Set-Content -Path $ConfFile -Encoding ASCII
  if ($NoSchedule) {
    Write-Host "OK: nastavenie ulozene (bez ulohy v Planovaci uloh). Zalohu spusti tymto skriptom bez -Setup." -ForegroundColor Green
    exit 0
  }
  $action = New-ScheduledTaskAction -Execute $ps -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`"" -f $PSCommandPath)
  $trigger = New-ScheduledTaskTrigger -Daily -At $Time
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Esblu: denna sifrovana zaloha produkcie (iba citanie)" -Force | Out-Null
  # Kontrola pri kazdom prihlaseni: zlyhana / stara zaloha = okno s upozornenim (aj ked denna uloha vobec nebezala).
  $chk = New-ScheduledTaskAction -Execute $ps -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`" -Status -Notify" -f $PSCommandPath)
  Register-ScheduledTask -TaskName "$TaskName - kontrola" -Action $chk -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) -Description "Esblu: upozornenie na zlyhanu alebo staru zalohu" -Force | Out-Null
  Write-Host "OK: uloha '$TaskName' denne o $Time (aj dodatocne, ak bol PC vypnuty). Prvy beh teraz: spusti tento skript bez -Setup." -ForegroundColor Green
  exit 0
}

$NodeArgs = @()
if ($UseSystemCa) { $NodeArgs += "--use-system-ca" }   # iba doplni doveryhodne certifikaty z Windows; overovanie TLS ostava zapnute

if ($Diagnose) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Fail "Node.js nie je nainstalovany" }
  & $node @NodeArgs $Script --diagnose
  exit $LASTEXITCODE
}

if ($CheckSecret) {
  try { $chk = Get-EsbluSecretKind (ConvertFrom-EsbluSecure (Read-EsbluSecret -Path $KeyFile)) } catch { Fail $_.Exception.Message }
  if ($chk.kind -eq "neznamy") { Fail "ulozena hodnota nema tvar serveroveho kluca - spusti -Setup -NoSchedule" }
  Write-Host ("OK: ulozeny kluc sa da nacitat (typ {0}, dlzka {1})." -f $chk.kind, $chk.length) -ForegroundColor Green
  exit 0
}

if (-not (Test-Path $KeyFile) -or -not (Test-Path $ConfFile)) { Fail "najprv -Setup" }
$conf = Get-Content $ConfFile -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $conf.backupDir | Out-Null
$LogFile = Join-Path $conf.backupDir "backup.log"
try { $sec = Read-EsbluSecret -Path $KeyFile } catch { Fail $_.Exception.Message }
$env:ESBLU_BACKUP_SUPABASE_KEY = ConvertFrom-EsbluSecure $sec
$env:ESBLU_BACKUP_PUBLIC_KEY = $conf.publicKey
$env:ESBLU_BACKUP_PUBKEY_SHA256 = $conf.fingerprint
$env:ESBLU_BACKUP_DIR = $conf.backupDir
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail "Node.js nie je nainstalovany" }
$started = (Get-Date).ToUniversalTime().ToString("s") + "Z"
$ErrorActionPreference = "Continue"
$out = & $node @NodeArgs $Script --run 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
Remove-Item Env:ESBLU_BACKUP_SUPABASE_KEY -ErrorAction SilentlyContinue
# Log iba vystup skriptu (neobsahuje kluc ani osobne udaje), maskovanie pre istotu.
$masked = $out | ForEach-Object { $_ -replace 'sb_secret_[A-Za-z0-9_-]+', 'sb_secret_***' -replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', 'eyJ***' }
Add-Content -Path $LogFile -Value ("[$started] exit=$code") -Encoding UTF8
Add-Content -Path $LogFile -Value $masked -Encoding UTF8
if ($code -ne 0) {
  [ordered]@{ status = "FAIL"; at = $started; exit = $code } | ConvertTo-Json | Set-Content (Join-Path $conf.backupDir "last-failure.json") -Encoding ASCII
}
# Po kazdom behu: pri chybe alebo upozorneni okno pre prihlaseneho pouzivatela (bez osobnych udajov).
& $ps -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Status -Notify | Out-Null
if ($code -ne 0) { exit 1 }
exit 0
