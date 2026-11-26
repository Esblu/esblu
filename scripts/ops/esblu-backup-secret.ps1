<#
  Esblu - ulozenie a nacitanie serveroveho kluca zalohy cez Windows DPAPI (PowerShell 5.1+), 2026-11-26.
  Dot-source: . (Join-Path $PSScriptRoot "esblu-backup-secret.ps1")

  Format suboru: jeden riadok hex (vystup ConvertFrom-SecureString = DPAPI blob pre tohto pouzivatela a PC),
  ASCII bez BOM a bez koncoveho riadku. Citanie toleruje starsi format (Set-Content: CRLF na konci), BOM,
  UTF-16 (Out-File) a medzery - pricina chyby "Input string was not in a correct format" bol koncovy CRLF.
  Chybove hlasky nikdy neobsahuju hodnotu kluca ani obsah suboru.
  Kody chyb: SECRET_MISSING, SECRET_EMPTY, SECRET_FORMAT, SECRET_DPAPI.
#>

function Save-EsbluSecret {
  param([Parameter(Mandatory = $true)][Security.SecureString]$Secure, [Parameter(Mandatory = $true)][string]$Path)
  if ($Secure.Length -eq 0) { throw "SECRET_EMPTY: kluc je prazdny" }
  $enc = ConvertFrom-SecureString -SecureString $Secure
  if ($enc -notmatch '^[0-9a-fA-F]+$') { throw "SECRET_FORMAT: neocakavany vystup DPAPI" }
  [IO.File]::WriteAllText($Path, $enc, (New-Object Text.ASCIIEncoding))
  # Kontrola: subor sa da hned nacitat a ma rovnaku dlzku ako zadany kluc (hodnota sa neporovnava ani nevypisuje).
  $back = Read-EsbluSecret -Path $Path
  if ($back.Length -ne $Secure.Length) { throw "SECRET_FORMAT: kontrola po ulozeni zlyhala" }
}

function Read-EsbluSecret {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { throw "SECRET_MISSING: ulozeny kluc neexistuje - spusti -Setup -NoSchedule" }
  $raw = [IO.File]::ReadAllText($Path)          # rozpozna BOM UTF-8 / UTF-16
  $raw = $raw.Replace([string][char]0xFEFF, "").Replace([string][char]0, "").Trim()
  if ($raw.Length -eq 0) { throw "SECRET_FORMAT: subor s klucom je prazdny - spusti -Setup -NoSchedule" }
  if ($raw -notmatch '^[0-9a-fA-F]+$' -or ($raw.Length % 2) -ne 0) {
    throw "SECRET_FORMAT: subor s klucom je poskodeny (nie je DPAPI hex) - spusti -Setup -NoSchedule"
  }
  try { return (ConvertTo-SecureString -String $raw -ErrorAction Stop) }
  catch { throw "SECRET_DPAPI: kluc sa neda desifrovat (iny pouzivatel/PC alebo poskodeny blob) - spusti -Setup -NoSchedule" }
}

function ConvertFrom-EsbluSecure {
  # Iba na odovzdanie do procesu Node cez premennu prostredia; vysledok sa nikdy nevypisuje.
  param([Parameter(Mandatory = $true)][Security.SecureString]$Secure)
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Get-EsbluSecretKind {
  # Typ kluca bez hodnoty: sb_secret / jwt / neznamy + dlzka.
  param([Parameter(Mandatory = $true)][string]$Plain)
  $kind = "neznamy"
  if ($Plain -match '^sb_secret_[A-Za-z0-9_-]{8,}$') { $kind = "sb_secret" }
  elseif ($Plain -match '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') { $kind = "jwt" }
  return @{ kind = $kind; length = $Plain.Length }
}
