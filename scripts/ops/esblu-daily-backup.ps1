<#
  Esblu - denna sifrovana zaloha produkcie (Windows PowerShell 5.1), 2026-11-20.
  Spusta scripts/ops/esblu-daily-backup.mjs. Nic nemeni v produkcii.

  -Setup   jednorazovo: skryte zadanie serveroveho kluca (ulozi sa iba sifrovane cez Windows DPAPI pre
           tohto pouzivatela), cesta k VEREJNEMU klucu + odtlacok, cielovy priecinok, uloha v Planovaci uloh.
  (bez)    denny beh (Planovac uloh): zaloha + kontrola integrity + retencia, log bez tajomstiev.

  Sukromny kluc zalohy NEPATRI na tento PC (USB / trezor / spravca hesiel). Bez neho sa zaloha neda obnovit.
#>
param([switch]$Setup, [string]$PublicKey = "", [string]$Fingerprint = "", [string]$BackupDir = "",
      [string]$Time = "02:30")

$ErrorActionPreference = "Stop"
$ConfDir = Join-Path $env:LOCALAPPDATA "Esblu\backup"
$KeyFile = Join-Path $ConfDir "server-key.dpapi"
$ConfFile = Join-Path $ConfDir "config.json"
$Script = Join-Path $PSScriptRoot "esblu-daily-backup.mjs"
$TaskName = "Esblu denna zaloha"

function Fail($m) { Write-Host "CHYBA: $m" -ForegroundColor Red; exit 1 }

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
  $sec | ConvertFrom-SecureString | Set-Content -Path $KeyFile -Encoding ASCII   # DPAPI, iba tento pouzivatel a PC
  [ordered]@{ publicKey = (Resolve-Path $PublicKey).Path; fingerprint = $Fingerprint; backupDir = $BackupDir } |
    ConvertTo-Json | Set-Content -Path $ConfFile -Encoding ASCII
  $ps = (Get-Process -Id $PID).Path
  $action = New-ScheduledTaskAction -Execute $ps -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`"" -f $PSCommandPath)
  $trigger = New-ScheduledTaskTrigger -Daily -At $Time
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Esblu: denna sifrovana zaloha produkcie (iba citanie)" -Force | Out-Null
  Write-Host "OK: uloha '$TaskName' denne o $Time (aj dodatocne, ak bol PC vypnuty). Prvy beh teraz: spusti tento skript bez -Setup." -ForegroundColor Green
  exit 0
}

if (-not (Test-Path $KeyFile) -or -not (Test-Path $ConfFile)) { Fail "najprv -Setup" }
$conf = Get-Content $ConfFile -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $conf.backupDir | Out-Null
$LogFile = Join-Path $conf.backupDir "backup.log"
$sec = Get-Content $KeyFile -Raw | ConvertTo-SecureString
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $env:ESBLU_BACKUP_SUPABASE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
$env:ESBLU_BACKUP_PUBLIC_KEY = $conf.publicKey
$env:ESBLU_BACKUP_PUBKEY_SHA256 = $conf.fingerprint
$env:ESBLU_BACKUP_DIR = $conf.backupDir
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail "Node.js nie je nainstalovany" }
$started = (Get-Date).ToUniversalTime().ToString("s") + "Z"
$ErrorActionPreference = "Continue"
$out = & $node $Script --run 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
Remove-Item Env:ESBLU_BACKUP_SUPABASE_KEY -ErrorAction SilentlyContinue
# Log iba vystup skriptu (neobsahuje kluc ani osobne udaje), maskovanie pre istotu.
$masked = $out | ForEach-Object { $_ -replace 'sb_secret_[A-Za-z0-9_-]+', 'sb_secret_***' -replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', 'eyJ***' }
Add-Content -Path $LogFile -Value ("[$started] exit=$code") -Encoding UTF8
Add-Content -Path $LogFile -Value $masked -Encoding UTF8
if ($code -ne 0) {
  [ordered]@{ status = "FAIL"; at = $started; exit = $code } | ConvertTo-Json | Set-Content (Join-Path $conf.backupDir "last-failure.json") -Encoding ASCII
  exit 1
}
exit 0
