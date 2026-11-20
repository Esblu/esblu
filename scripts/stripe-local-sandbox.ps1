<#
  Esblu - lokalny test predplatneho cez Stripe SANDBOX (test mode) + staging DB esblu-test.

  Okno 1 (Esblu + stripe listen):
    powershell -ExecutionPolicy Bypass -File .\scripts\stripe-local-sandbox.ps1
  Okno 2 (scenare):
    powershell -ExecutionPolicy Bypass -File .\scripts\stripe-local-sandbox.ps1 -Step <krok> [-CheckoutId <uuid>] [-Subscription <sub_...>]
      mark-exposed - bez platieb: overi Stripe CLI (nativny stripe v PATH ma prednost pred npx) a ulozi SHA-256
                     aktualneho whsec_ profilu -Project medzi kompromitovane (start s nim sa uz nespusti)
      new-sandbox  - NOVY anonymny sandbox v samostatnom profile CLI (-Project, default esblu-qa2) -Email <adresa>:
                     test kluce, nova cena 15,90 EUR/mes., mapovanie ceny na stagingu, odtlacok vystaveneho tajomstva
      clock-setup  - predplatne na Stripe TEST CLOCK pre firmu QA-STRIPE D (zamer sa vytvori automaticky)
      renew        - posun hodin za koniec obdobia -> nova zaplatena faktura subscription_cycle
      fail-renew   - karta pm_card_chargeCustomerFail + posun hodin -> invoice.payment_failed, past_due
      fix-payment  - platna karta + zaplatenie otvorenej faktury -> active
      refund-partial / refund-full - refundacia poslednej zaplatenej platby
      refund-old     - plna refundacia STARSEJ zaplatenej faktury -> Esblu aj Stripe ostavaju active
      refund-current - plna refundacia faktury AKTUALNEHO obdobia -> Esblu refunded + Stripe predplatne ukoncene
      reconcile      - reconciliation Esblu (lokalny cron): ucet refunded/revoked + Stripe active -> ukoncit u Stripe
      advance-check  - posun Test Clock o dalsie obdobie -> ziadna nova faktura ani platba, Esblu bez zmeny
      verify-terminal - refunded/revoked ostava po customer.subscription.deleted, opakovanej reconciliation; ziadny aktivny narok
      qa-login     - prihlasenie syntetickeho ownera QA-STRIPE E (qa-stripe-e-owner@example.invalid): nove nahodne
                     heslo cez Supabase Admin API stagingu, iba do schranky (nevypisuje sa), odblokovanie pouzivatela
      qa-check     - firma E: zamery checkoutu, relacie v Stripe, predplatne, zrusenie; invarianty dvoch kariet
      s12-account  - S12: ucet a typ kluca (bez vypisu), test mode, opravnenie citat ucet a udalosti
      s12-events   - S12: skutocne strankovanie /v1/events (ending_before) a poradie od najstarsej
      s12-catchup  - S12: 2x lokalny cron /api/cron/billing-stripe-events (druhy beh = nic nove) + kurzor v DB
      s12-cancel-at - S13: cancel_at uprostred obdobia (test clock) -> Esblu scheduled_end_at, naroky do datumu;
                     posun hodin za datum -> Stripe ukonci, Esblu canceled bez 48 h (cez dotahovanie, ak -NoListen)
      s12-refund-missing - S12: plna refundacia aktualnej faktury BEZ webhooku (okno 1 s -NoListen) -> dotahovanie
      s13-existing - S13 na EXISTUJUCOM predplatnom firmy E (bez noveho objektu): cancel_at = teraz + 5 min,
                     zistenie ci Stripe skrati koniec obdobia, Esblu scheduled_end_at cez dotahovanie (-NoListen),
                     po ukonceni v Stripe: canceled a 0 narokov (bez 48 h)
      status       - stav v Stripe aj v Esblu + posledne riadky stripe listen (tajomstva zamaskovane)
      s17          - S17 (P4, docs par. 8.14): JEDEN zlozeny krok, plne automaticky - preflight (test mode, staging, aplikacny
                     kod HEAD = origin/main 1e2ab73, inak odmietne bez -Force) a zapnutie billingu stagingu iba na test;
                     pripnuta verzia Stripe API + lokalny cron dotahovania; nakup na Test Clock (pm_card_visa) -> invoice.paid;
                     uctovna kopia faktury + snapshot; archiv PDF (cron billing-documents) + SHA-256 v storage; ciastocna
                     refundacia dobropisom; ZASTAVI stripe listen okna 1 -> zmeskana udalost -> dotahovanie presne raz;
                     mesacny export (scripts/s17-accounting-export.ts, CSV do %USERPROFILE%\esblu-backups\s17); poplatok/
                     cista suma vs. Stripe; izolacia a duplicity; obnova stagingu (billing OFF). [-Month YYYY-MM] [-Force]
                     Dokazy bez tajomstiev: <hlavny checkout>\release-backups\s17\s17-evidence.json
      s17-cleanup  - S17: idempotentne upratanie (aj po padnuti) - ukoncenie QA predplatneho, staging billing spat,
                     zmazanie Test Clocks S17
    Kazdy krok vypise OK AZ ked je vysledok overeny v Stripe AJ v testovacej DB Esblu.

  Bezpecnost:
  - Stripe kluc: $env:STRIPE_API_KEY -> profil CLI -> skryta vyzva (po prevzati sandboxu). Nikdy sa nevypisuje.
    Profily v $CompromisedKeyProjects (esblu-qa3: CLI kluc zverejneny): IBA novy sk_test_/rk_test_ zo skrytej vyzvy,
    SHA-256 sa nesmie zhodovat s klucom profilu. -Project je povinny vzdy (docs par. 8.14c).
    Overenie: kluc vidi cenu profilu (spravny ucet) a ma pristup k Test Clocks. Iba test mode.
  - Webhook secret zo `stripe listen` je viazany na Stripe UCET (sandbox), nie na zariadenie. Novy secret
    = novy sandbox (-Step new-sandbox). Skript porovnava iba SHA-256 s odtlackom vystaveneho tajomstva
    (exposed.sha256) a nespusti sa, kym sa zhoduju. Stare logy sa mazu.
  - Vsetky vypisy prechadzaju maskovanim (whsec_*, *_test_*, *_live_*, JWT).
  - Staging service role kluc: skryte zadanie (Read-Host) alebo $env:ESBLU_QA_SERVICE_ROLE v okne 2.
  - Databaza: Supabase staging `cjbdijbbcujvmrzezusd` (esblu-test). Produkcia sa nepouziva.
#>
param(
  [ValidateSet("start", "status", "mark-exposed", "new-sandbox", "map-price", "s17-auto", "clock-setup", "renew", "fail-renew", "fix-payment", "refund-partial", "refund-full",
               "refund-old", "refund-current", "reconcile", "advance-check", "verify-terminal", "qa-login", "qa-check",
               "s12-account", "s12-events", "s12-catchup", "s12-cancel-at", "s12-refund-missing", "s13-existing",
               "s17", "s17-cleanup", "s17-preflight")]
  [string]$Step = "start",
  # Okno 1 BEZ stripe listen: ziadny webhook sa nedoruci, synchronizacia iba cez dotahovanie (S12).
  [switch]$NoListen,
  [string]$Project = "esblu-qa2",
  [string]$Email = "",
  [string]$CheckoutId = "",
  [string]$Subscription = "",
  [int]$Port = 3000,
  # S17: mesiac exportu (default aktualny mesiac UTC) a vedome prepisanie kontroly HEAD = origin/main.
  [string]$Month = "",
  [switch]$Force,
  # Pokracovanie na existujucom profile: odtlacok whsec_ tohto profilu, ktory do zoznamu kompromitovanych
  # omylom pridala chyba "default profil" (2026-11-20, CLI s nastavenym project-name), sa odstrani - iba ak
  # tajomstvo NEBOLO zverejnene (vedome rozhodnutie operatora; zapise sa do exposed-released.log).
  [switch]$ReleaseAutoMarked
)
$ErrorActionPreference = "Stop"

function Resolve-StripeCliBase {
  # Poradie: $env:ESBLU_STRIPE_CLI (plna cesta k stripe.exe) -> nativny `stripe` v PATH (WinGet/Scoop)
  # -> zaloha npx @stripe/cli@1.55.12. Nativny CLI cita ten isty profil (~/.config/stripe) aj
  # systemovy trezor po `stripe login` (S17: povodne sa vzdy pouzival iba npx, aj ked bol nainstalovany CLI).
  $p = $env:ESBLU_STRIPE_CLI
  if (-not $p) {
    $c = Get-Command stripe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { $p = $c.Source }
  }
  if ($p) { return @($p) }
  return @("npx", "--yes", "@stripe/cli@1.55.12")
}
$StripeCliBase = @(Resolve-StripeCliBase)
# Samostatny profil Stripe CLI pre QA sandbox (default profil = povodny sandbox s vystavenym tajomstvom).
$StripeProfileArgs = @("--project-name", $Project)
$StripeCli = @($StripeCliBase) + $StripeProfileArgs
# Profil "default" VZDY vyslovne: bez --project-name pouzije Stripe CLI aktualny `project-name` z config.toml
# (po `sandboxes create --project-name X` je to X) -> "default" by ukazoval na prave testovany profil.
$StripeDefaultCli = @($StripeCliBase) + @("--project-name", "default")
$StagingRef = "cjbdijbbcujvmrzezusd"
$ProdRef = "fkpgvgvsmbpieduoatrt"
$StagingUrl = "https://$StagingRef.supabase.co"
# Verejny (anon) kluc stagingu - nie je tajny (je v kazdom klientskom bundli).
$StagingAnon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqYmRpamJiY3Vqdm1yemV6dXNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NTMxMDgsImV4cCI6MjEwMjEyOTEwOH0.gxhb1j2a5lmQnkeDHYOD2KEAe_zN44p-nSDUqIqkJbM"
$StateDir = Join-Path $env:TEMP "esblu-stripe-qa"
$ClockFile = Join-Path $StateDir "clock-$Project.json"
$SandboxFile = Join-Path $StateDir "sandbox-$Project.json"     # cena sandboxu (nie je tajna)
$ExposedFile = Join-Path $StateDir "exposed.sha256"             # SHA-256 vystaveneho whsec (nie tajomstvo)
$CronFile = Join-Path $StateDir "cron-$Project.secret"          # nahodny lokalny CRON_SECRET (iba pocas behu okna 1)
$NoListenFile = Join-Path $StateDir "nolisten-$Project.flag"     # okno 1 bezi bez stripe listen (S12 testy)
$ListenPidFile = Join-Path $StateDir "listen-$Project.pid"       # PID stripe listen z okna 1 (S17 ho zastavi)
$HeadFile = Join-Path $StateDir "head-$Project.json"             # commit, z ktoreho bezi okno 1 (S17 porovna)
$S17StateFile = Join-Path $StateDir "s17-$Project.json"          # povodny stav stagingu + objekty S17 (upratanie)
$S17ExpectedMain = "1e2ab730ab5caab86ab5a72d1042fbca28748f7b"    # origin/main = produkcny kod, ktory S17 overuje
$RepoRoot = Split-Path -Parent $PSScriptRoot
$CompanyD = "5a5a0000-0000-4000-8000-0000000000d0"              # QA-STRIPE D (test clock)
$OwnerD = "5a5a0000-0000-4000-8000-000000000031"
$CompanyE = "5a5a0000-0000-4000-8000-0000000000e0"              # QA-STRIPE E (dve karty + zrusenie v aplikacii)
$OwnerE = "5a5a0000-0000-4000-8000-000000000041"
$OwnerEEmail = "qa-stripe-e-owner@example.invalid"
$PriceId = $null
$SandboxAccount = ""   # account v sandbox-<profil>.json (starsie verzie skriptu ho nezapisovali)
if (Test-Path $SandboxFile) {
  $sbx = Get-Content $SandboxFile -Raw | ConvertFrom-Json
  $PriceId = $sbx.price
  if ($sbx.PSObject.Properties["account"] -and $sbx.account) { $SandboxAccount = [string]$sbx.account }
}
# Windows PowerShell 5.1 (.NET Framework): Stripe API vyzaduje TLS 1.2+.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# S17 bezpecnost: profil sa musi zadat VYSLOVNE (-Project), default 'esblu-qa2' sa uz nesmie pouzit omylom.
$CompromisedProjects = @("esblu-qa2", "esblu-qa3")   # qa2: whsec_ zverejnene; qa3: CLI kluc zverejneny a sandbox sa neda prevziat (2026-11-20)   # whsec_ zverejnene v konverzacii 2026-11-20 (odtlacok v exposed.sha256)
# CLI test kluc profilu (test_mode_api_key, rkcs_test_) zverejneny v konverzacii 2026-11-20: profil sa smie pouzit
# IBA s NOVYM klucom sandboxu zo skrytej vyzvy (sk_test_/rk_test_), nikdy s klucom z profilu ani zdedenym STRIPE_API_KEY.
$CompromisedKeyProjects = @("esblu-qa3")
$CompromisedKeyFile = Join-Path $StateDir "compromised-keys.sha256"   # SHA-256 kompromitovanych Stripe klucov (nie tajomstvo)
if (-not $PSBoundParameters.ContainsKey("Project")) {
  Write-Host "CHYBA: zadaj profil vyslovne, napr. -Project esblu-qa3 (default sa nepouziva)." -ForegroundColor Red; exit 1
}
# 2026-11-20: ZIADNE dalsie sandboxy. esblu-qa2 = povodne funkcne prostredie S12/S13/S16 (PREVZATY sandbox
# acct_1UdCxsRKE4QKs2UL, Test Clocks/refundy/webhooky PASS). Zverejnene bolo IBA jeho whsec_ zo `stripe listen`
# (API kluc nie) -> profil sa smie pouzit IBA bez stripe listen (-NoListen): whsec_ sa necita ani nepouziva, lokalny
# webhook dostane nahodne jednorazove tajomstvo (podpis sa dalej overuje, kazde podvrhnute volanie = 400), udalosti
# prichadzaju iba cez dotahovanie /v1/events (ta ista pipeline processVerifiedEvent ako webhook).
$WhsecOnlyCompromised = @("esblu-qa2")
$KnownAccounts = @{ "esblu-qa2" = "acct_1UdCxsRKE4QKs2UL" }   # z dokazov S12 (s12-account, kurzor 34 udalosti)
$NoListenOnly = $WhsecOnlyCompromised -contains $Project
if (-not $SandboxAccount -and $KnownAccounts.ContainsKey($Project)) { $SandboxAccount = $KnownAccounts[$Project] }
if ($CompromisedProjects -contains $Project) {
  $okQa2 = $NoListenOnly -and ((@("mark-exposed", "status", "s17-preflight", "s17-auto", "s17", "s17-cleanup") -contains $Step) -or ($Step -eq "start" -and $NoListen))
  if (-not $okQa2) {
    if ($NoListenOnly) { Write-Host "CHYBA: profil '$Project' ma zverejnene whsec_ - povolene iba s17-preflight, s17-auto, s17, s17-cleanup, status a start -NoListen." -ForegroundColor Red }
    else { Write-Host "CHYBA: profil '$Project' je kompromitovany (API kluc) - nepouziva sa." -ForegroundColor Red }
    exit 1
  }
}
if ($Step -eq "new-sandbox") {
  Write-Host "CHYBA: zakladanie dalsich Stripe sandboxov je vypnute (rozhodnutie prevadzkovatela 2026-11-20). Pouzi existujuci prevzaty sandbox (-Project esblu-qa2)." -ForegroundColor Red; exit 1
}
$Events = @(
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "checkout.session.expired", "customer.subscription.created", "customer.subscription.updated",
  "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required",
  "charge.refunded", "charge.dispute.created", "charge.dispute.closed",
  # P4: doklady (uctovne kopie faktur a dobropisov) a pauza predplatneho - rovnaka mnozina ako dotahovanie
  "customer.subscription.paused", "customer.subscription.resumed", "invoice.finalized", "invoice.voided",
  "invoice.marked_uncollectible", "credit_note.created", "credit_note.updated", "credit_note.voided"
) -join ","
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# ----------------------------------------------------------------------------- pomocne funkcie
function Hide-Secrets([string]$s) {
  if (-not $s) { return $s }
  $s = $s -replace "whsec_[A-Za-z0-9]+", "whsec_***"
  $s = $s -replace "((?:sk|rk|rkcs|pk)_(?:test|live)_)[A-Za-z0-9]+", '$1***'
  $s = $s -replace "eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "eyJ***"
  $s = $s -replace "sb_(secret|publishable)_[A-Za-z0-9_-]+", 'sb_$1_***'
  return $s
}
function Say([string]$s) { Write-Host (Hide-Secrets $s) }
function Fail([string]$s) { throw (Hide-Secrets $s) }
function Format-Eur([long]$minor, [string]$cur = "EUR") {
  # Sumy sa porovnavaju v centoch (long); zobrazenie 1590 -> "15,90 EUR".
  $sign = if ($minor -lt 0) { "-" } else { "" }; $a = [Math]::Abs($minor)
  return ("{0}{1},{2:D2} {3}" -f $sign, [Math]::Floor($a / 100), ($a % 100), $cur.ToUpper())
}
function Utc([long]$ts) { return [DateTimeOffset]::FromUnixTimeSeconds($ts).UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss 'UTC'", [Globalization.CultureInfo]::InvariantCulture) }

function Get-CliRest([string[]]$cli) {
  # Pozor: pre 1-prvkove pole by $cli[1..0] vratilo prvky [1] a [0] (opacny rozsah) -> nativny stripe.exe by dostal sam seba ako argument.
  if ($cli.Length -gt 1) { return @($cli[1..($cli.Length - 1)]) }
  return @()
}
function Invoke-Stripe([string[]]$StripeArgs) {
  $cmd = $StripeCli[0]; $rest = @(Get-CliRest $StripeCli) + $StripeArgs
  # Windows PowerShell 5.1: stderr nativneho prikazu pri 2>&1 nesmie ukoncit skript.
  $ErrorActionPreference = "Continue"
  $out = (& $cmd @rest 2>&1 | ForEach-Object { "$_" }) | Out-String
  # Stripe CLI pri chybe API vracia JSON s "error" aj s exit kodom 0 -> treba kontrolovat obsah.
  if ($LASTEXITCODE -ne 0 -or $out -match '"error"\s*:\s*\{') { Fail "stripe $($StripeArgs[0..1] -join ' ') zlyhal:`n$out" }
  return $out
}
function Get-StripeJson([string[]]$StripeArgs) {
  $text = Invoke-Stripe $StripeArgs
  $a = $text.IndexOf("{"); $b = $text.LastIndexOf("}")
  if ($a -lt 0 -or $b -le $a) { Fail "Stripe CLI nevratil JSON pre: $($StripeArgs[0..1] -join ' ')" }
  return ($text.Substring($a, $b - $a + 1) | ConvertFrom-Json)
}

function Get-ProfileAccountId([string[]]$cli) {
  # account_id profilu Stripe CLI (nie je tajny). Prazdny retazec = profil bez uctu.
  $m = [regex]::Match((Invoke-StripeRaw $cli @("config", "--list")), "account_id\s*=\s*['`"]?(acct_[A-Za-z0-9]+)")
  if ($m.Success) { return $m.Groups[1].Value }
  return ""
}
function Assert-StagingAccess {
  # READ-ONLY overenie stagingu PRED akymkolvek zapisom: URL = esblu-test, kluc = service_role (vidi tabulku
  # bez prava pre anon/authenticated), billing konfiguracia = test. Vrati aktualne riadky mapovania ceny.
  if ($StagingUrl -ne "https://$StagingRef.supabase.co" -or $StagingUrl -match $ProdRef) { Fail "Supabase URL nie je staging $StagingRef." }
  $cfg = @(Get-Rows "billing_runtime_config?select=environment,web_provider")
  if ($cfg.Count -ne 1 -or $cfg[0].environment -ne "test") { Fail "Staging billing_runtime_config nie je environment=test (najdene: $($cfg.Count) riadkov)." }
  $null = @(Get-Rows "internal_operator_grants?select=id&limit=1")   # iba service_role; anon/authenticated -> chyba
  $rows = @(Get-Rows "billing_provider_prices?select=id,provider_price_id,active&provider=eq.stripe&environment=eq.test&plan_code=eq.esblu_complete&billing_interval=eq.month")
  Say "    staging $StagingRef OK: service_role (read-only test), billing environment=test web_provider=$($cfg[0].web_provider), mapovanie cien: $($rows.Count) riadkov, aktivnych $(@($rows | Where-Object { $_.active }).Count)"
  return $rows
}
function Set-StagingPriceMapping([string]$newPrice) {
  # Obnovitelna zmena mapovania (unikatny index: 1 aktivna cena na plan/interval):
  # 1) predchadzajuci stav -> lokalny restore subor, 2) novy riadok NEAKTIVNY, 3) stare aktivne -> neaktivne,
  # 4) novy -> aktivny, 5) kontrola presne 1 aktivny = novy. Pri chybe po kroku 2 sa vrati predchadzajuci stav.
  $base = "billing_provider_prices?provider=eq.stripe&environment=eq.test&plan_code=eq.esblu_complete&billing_interval=eq.month"
  $before = @(Get-Rows "$base&select=id,provider_price_id,active")
  $prevActive = @($before | Where-Object { $_.active } | ForEach-Object { $_.id })
  $restoreFile = Join-Path $StateDir "price-mapping-restore-$Project.json"
  @{ at = (Get-Date).ToUniversalTime().ToString("o"); previously_active_ids = $prevActive; new_price = $newPrice } | ConvertTo-Json | Set-Content -Path $restoreFile -Encoding ASCII
  $existing = @($before | Where-Object { $_.provider_price_id -eq $newPrice })
  if ($existing.Count -gt 0) { $newId = $existing[0].id }
  else {
    $row = Invoke-Staging "POST" "billing_provider_prices" @{ provider = "stripe"; environment = "test"; plan_code = "esblu_complete"; billing_interval = "month"; provider_price_id = $newPrice; active = $false }
    $newId = @($row)[0].id
  }
  try {
    foreach ($id in $prevActive) { if ($id -ne $newId) { Invoke-Staging "PATCH" "billing_provider_prices?id=eq.$id" @{ active = $false } | Out-Null } }
    Invoke-Staging "PATCH" "billing_provider_prices?id=eq.$newId" @{ active = $true } | Out-Null
    $after = @(Get-Rows "$base&active=eq.true&select=id,provider_price_id")
    if ($after.Count -ne 1 -or $after[0].provider_price_id -ne $newPrice) { throw "po zmene nie je presne 1 aktivna cena = $newPrice" }
  } catch {
    $msg = $_.Exception.Message
    try {
      Invoke-Staging "PATCH" "billing_provider_prices?id=eq.$newId" @{ active = $false } | Out-Null
      foreach ($id in $prevActive) { Invoke-Staging "PATCH" "billing_provider_prices?id=eq.$id" @{ active = $true } | Out-Null }
      Fail "Mapovanie ceny zlyhalo ($msg) - predchadzajuci stav obnoveny ($($prevActive.Count) aktivnych). Restore: $restoreFile"
    } catch { Fail "Mapovanie ceny zlyhalo ($msg) A obnova zlyhala ($($_.Exception.Message)). Rucne obnov podla $restoreFile." }
  }
  Say "    staging: esblu_complete/month -> $newPrice (presne 1 aktivna; restore $restoreFile)"
}

function Get-Rows([string]$path) {
  # Windows PowerShell 5.1: Invoke-RestMethod vrati JSON pole ako JEDEN objekt (nerozbaleny).
  # @(...) by potom malo vzdy Count = 1 (aj pre prazdne pole) -> rozbalit cez ForEach-Object.
  return @(Invoke-Staging "GET" $path | ForEach-Object { $_ })
}

function Read-HiddenText([string]$prompt) {
  # Read-Host -AsSecureString -> text iba v pamati procesu (BSTR sa hned vynuluje); nikdy sa nevypisuje.
  $sec = Read-Host -AsSecureString $prompt
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $t = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if ($null -eq $t) { return "" }
  return $t.Trim()
}
function Register-CompromisedProfileKeys {
  # Odtlacky (SHA-256) CLI klucov profilov so ZVEREJNENYM API klucom -> compromised-keys.sha256 (lokalne, bez vypisu).
  # (esblu-qa2: zverejnene iba whsec_, nie API kluc -> jeho kluc sa sem nezapisuje.)
  foreach ($pr in $CompromisedKeyProjects) {
    $cfgX = Invoke-StripeRaw (@($StripeCliBase) + @("--project-name", $pr)) @("config", "--list")
    $mX = [regex]::Match($cfgX, "test_mode_api_key\s*=\s*['`"]?((?:sk|rk|rkcs)_test_[A-Za-z0-9]+)")
    if ($mX.Success) {
      $hX = Get-Sha256 $mX.Groups[1].Value
      if (@(Get-CompromisedKeyHashes) -notcontains $hX) { Add-Content -Path $CompromisedKeyFile -Value $hX -Encoding ASCII }
    }
  }
}
function Get-StripeProbeStatus([hashtable]$h, [string]$path) {
  # HTTP stav GET (iba citanie). 200 = OK, 403 = chyba OPRAVNENIE kluca, 401 = neplatny kluc, 400/404 = chyba kontroly/verzie.
  try { Invoke-RestMethod -Uri "https://api.stripe.com/v1/$path" -Headers $h -Method Get | Out-Null; return 200 }
  catch { $c = 0; try { $c = [int]$_.Exception.Response.StatusCode } catch { }; return $c }
}
function Test-StripeKeyAccess([string]$key, [string]$version) {
  # READ-ONLY sonda pred akymkolvek zapisom. Povinne zdroje S17 -> pri chybe STOP. Uctovne zdroje
  # (balance_transactions, payouts): 403 = kluc sandboxu nema pravo (CLI kluc rkcs_ claimable sandboxu) ->
  # LIMITATION pre poplatok/cistu sumu (S17-9), S17 pokracuje; ine kody = chyba kontroly -> STOP.
  $h = @{ Authorization = "Bearer $key" }
  if ($version) { $h["Stripe-Version"] = $version }
  $need = @("test_helpers/test_clocks", "prices", "customers", "subscriptions", "invoices", "credit_notes", "refunds", "charges", "payment_intents", "events")
  $missing = @()
  foreach ($r in $need) { $c = Get-StripeProbeStatus $h "$($r)?limit=1"; if ($c -ne 200) { $missing += "$r (HTTP $c)" } }
  if ($missing.Count -gt 0) { Fail "Kluc/verzia $version nema pristup: $($missing -join ', ') - zastavene pred zapisom." }
  # Sonda ZAPISU bez vedlajsieho ucinku: POST test_clocks bez povinneho frozen_time. Opravneny kluc -> 400 (chyba
  # parameter, nic nevznikne); kluc bez prava (rkcs_ neprevzateho sandboxu) -> 403. GET 200 pravo zapisu nedokazuje.
  $wc = 0
  try { Invoke-RestMethod -Uri "https://api.stripe.com/v1/test_helpers/test_clocks" -Headers $h -Method Post -ContentType "application/x-www-form-urlencoded" -Body "" | Out-Null; $wc = 200 }
  catch { try { $wc = [int]$_.Exception.Response.StatusCode } catch { } }
  if ($wc -eq 403) { Fail "Kluc NEMA pravo vytvarat Test Clocks (HTTP 403 - kluc neprevzateho sandboxu). Pouzi Secret key (sk_test_) prevzateho sandboxu - zastavene pred zapisom." }
  if ($wc -ne 400) { Fail "Sonda zapisu Test Clocks vratila HTTP $wc (ocakavane 400 = opravnene, bez vytvorenia) - zastavene." }
  $acc = [ordered]@{}
  foreach ($r in @("balance_transactions", "payouts")) {
    $c = Get-StripeProbeStatus $h "$($r)?limit=1"
    if ($c -eq 200) { $acc[$r] = "ok" }
    elseif ($c -eq 403) { $acc[$r] = "permission_denied" }
    else { Fail "Kontrola $r vratila HTTP $c (nie je to chyba opravnenia) - zastavene, over verziu $version / endpoint." }
  }
  $env:S17_LEDGER_ACCESS = $acc["balance_transactions"]   # zdedia podprocesy (S17-8/9)
  Say "    Stripe API sonda OK (Stripe-Version $version): $($need.Count) povinnych zdrojov citanie + zapis Test Clocks (400 bez vytvorenia); balance_transactions: $($acc['balance_transactions']); payouts: $($acc['payouts'])"
  if ($acc["balance_transactions"] -ne "ok") { Say "    POZOR: kluc sandboxu nema pravo citat balance transactions -> S17-9 (poplatok/cista suma) bude LIMITATION, nie PASS." }
  return $acc
}

function Get-CompromisedKeyHashes {
  if (-not (Test-Path $CompromisedKeyFile)) { return @() }
  return @(Get-Content $CompromisedKeyFile | ForEach-Object { "$_".Trim().ToLower() } | Where-Object { $_ -match "^[0-9a-f]{64}$" })
}

function Get-StripeTestKey {
  # Kluc sa NIKDY nevypisuje. Poradie:
  #  1) $env:STRIPE_API_KEY (test) z tohto okna,
  #  2) nezamaskovany test_mode_api_key v profile Stripe CLI (anonymny sandbox pred prevzatim),
  #  3) skryta vyzva - po prevzati sandboxu a `stripe login` uklada CLI kluc do systemoveho trezoru
  #     (Windows Credential Manager) a `config --list` ho uz neukaze.
  # Vybrany kluc sa nastavi do $env:STRIPE_API_KEY (iba tento proces), takze CLI aj Esblu pouziju TEN ISTY ucet.
  $testRe = "(?:sk|rk|rkcs)_test_[A-Za-z0-9]+"
  $liveRe = "(?:sk|rk|rkcs)_live_"
  $key = $null; $src = ""
  if ($CompromisedKeyProjects -contains $Project) {
    # Kompromitovany CLI kluc profilu: porovnavaju sa IBA odtlacky SHA-256 (kluc sa nikdy nevypisuje ani neuklada).
    $cfg = Invoke-StripeRaw $StripeCli @("config", "--list")
    if ($cfg -match "test_mode_api_key\s*=\s*['`"]?$liveRe") { Fail "V profile je LIVE kluc - skript pracuje iba s test mode." }
    $bad = @(Get-CompromisedKeyHashes)
    $m = [regex]::Match($cfg, "test_mode_api_key\s*=\s*['`"]?($testRe)")
    if ($m.Success) {
      $h = Get-Sha256 $m.Groups[1].Value
      if ($bad -notcontains $h) { Add-Content -Path $CompromisedKeyFile -Value $h -Encoding ASCII; $bad += $h }
    }
    if ($bad.Count -eq 0) { Say "    POZOR: odtlacok kompromitovaneho kluca profilu '$Project' nie je dostupny (kluc nie je v profile) - porovnanie sa preskoci." }
    if ($env:STRIPE_API_KEY) {
      $inh = if ($bad -contains (Get-Sha256 $env:STRIPE_API_KEY.Trim())) { "= kompromitovany kluc" } else { "nepouzije sa" }
      Remove-Item Env:STRIPE_API_KEY
      Say "    zdedena premenna STRIPE_API_KEY ignorovana ($inh) - profil '$Project' vyzaduje novy kluc zo skrytej vyzvy"
    }
    Say "    Profil '$Project': CLI kluc je KOMPROMITOVANY - pouzije sa iba NOVY kluc tohto sandboxu."
    Say "    Stripe Dashboard -> sandbox profilu '$Project' -> Developers -> API keys -> Secret key (sk_test_, po rotacii) alebo novy Restricted key (rk_test_)."
    $key = Read-HiddenText "    Vloz NOVY testovaci kluc sk_test_/rk_test_ (nezobrazi sa)"
    if ($key -match "^$liveRe") { Fail "Zadany kluc je LIVE - skript pracuje iba s test mode." }
    if ($key -notmatch "^(?:sk|rk)_test_[A-Za-z0-9]+$") { Fail "Zadany kluc nie je novy sandbox kluc sk_test_/rk_test_ (CLI kluc rkcs_ sa pre '$Project' nepouziva)." }
    if ($bad -contains (Get-Sha256 $key)) { Fail "Zadany kluc je KOMPROMITOVANY kluc profilu '$Project' - vytvor/rotuj novy kluc v Dashboarde sandboxu." }
    $src = "skryta vyzva (novy kluc; SHA-256 != kompromitovany)"
  }
  elseif ($env:STRIPE_API_KEY) {
    if ($env:STRIPE_API_KEY -match "^$liveRe") { Fail "STRIPE_API_KEY je LIVE kluc - skript pracuje iba s test mode." }
    if ($env:STRIPE_API_KEY -match "^$testRe$") { $key = $env:STRIPE_API_KEY; $src = "STRIPE_API_KEY" }
  }
  if (-not $key) {
    $cfg = Invoke-StripeRaw $StripeCli @("config", "--list")
    if ($cfg -match "test_mode_api_key\s*=\s*['`"]?$liveRe") { Fail "V profile je LIVE kluc - skript pracuje iba s test mode." }
    $m = [regex]::Match($cfg, "test_mode_api_key\s*=\s*['`"]?($testRe)")
    if ($m.Success) { $key = $m.Groups[1].Value; $src = "profil Stripe CLI '$Project'" }
  }
  if (-not $key) {
    Say "    Profil '$Project' nema citatelny testovaci kluc (po stripe login je v systemovom trezore)."
    Say "    Stripe Dashboard -> tvoj sandbox (prepinac vlavo hore) -> Developers -> API keys -> Secret key (sk_test_...)."
    $key = Read-HiddenText "    Vloz testovaci Secret key (nezobrazi sa)"
    if ($key -match "^$liveRe") { Fail "Zadany kluc je LIVE - skript pracuje iba s test mode." }
    if ($key -notmatch "^$testRe$") { Fail "Zadany kluc nie je testovaci Stripe kluc (sk_test_/rk_test_/rkcs_test_)." }
    $src = "skryta vyzva"
  }
  if ($key -match "^rkcs_test_" -and $Step -ne "mark-exposed") {
    # Stripe (S17 2026-11-20): kluc neprevzateho sandboxu nema pravo napr. na POST test_clocks -> nepouzije sa.
    Say "    kluc z '$src' je rkcs_test_ (neprevzaty sandbox, obmedzene prava) - nepouzije sa."
    Say "    Stripe Dashboard -> prevzaty sandbox profilu '$Project' -> Developers -> API keys -> Secret key (sk_test_)."
    $key = Read-HiddenText "    Vloz Secret key sk_test_ (alebo rk_test_) prevzateho sandboxu (nezobrazi sa)"
    if ($key -match "^$liveRe") { Fail "Zadany kluc je LIVE - skript pracuje iba s test mode." }
    if ($key -notmatch "^(?:sk|rk)_test_[A-Za-z0-9]+$") { Fail "Zadany kluc nie je sk_test_/rk_test_ (rkcs_ neprevzateho sandboxu nestaci)." }
    $src = "skryta vyzva (plny kluc)"
  }
  if (@(Get-CompromisedKeyHashes) -contains (Get-Sha256 $key)) { Fail "Kluc je evidovany ako KOMPROMITOVANY - nepouzije sa." }
  $env:STRIPE_API_KEY = $key   # iba tento proces; Stripe CLI ho uprednostni pred profilom
  Say ("    kluc: {0} ({1}***)" -f $src, $key.Substring(0, $key.IndexOf("_test_") + 6))
  return $key
}

function Assert-StripeAccount([string]$key) {
  # Spravny ucet = kluc vidi cenu ulozenu pre profil (ceny su viazane na ucet). Bez vypisu kluca.
  $h = @{ Authorization = "Bearer $key" }
  try { $pr = Invoke-RestMethod -Uri "https://api.stripe.com/v1/prices/$PriceId" -Headers $h -Method Get }
  catch { Fail "Kluc nevidi cenu $PriceId - patri inemu Stripe uctu alebo nema opravnenie na Prices. ($($_.Exception.Message))" }
  if ($pr.livemode -or $pr.id -ne $PriceId) { Fail "Cena $PriceId nie je testovacia cena tohto kluca." }
  if ($pr.unit_amount -ne 1590 -or $pr.currency -ne "eur" -or $pr.recurring.interval -ne "month") { Fail "Cena $PriceId nie je 15,90 EUR / mesiac." }
  try { Invoke-RestMethod -Uri "https://api.stripe.com/v1/test_helpers/test_clocks?limit=1" -Headers $h -Method Get | Out-Null }
  catch { Fail "Kluc nema opravnenie na Test Clocks (test_helpers). Pouzi Secret key (sk_test_) sandboxu. ($($_.Exception.Message))" }
  # Identita uctu: account zo sandbox-<profil>.json, inak account_id profilu CLI (starsi subor bez "account").
  $expAcct = $SandboxAccount
  $acctSrc = "sandbox-$Project.json"
  if (-not $expAcct) { $expAcct = Get-ProfileAccountId $StripeCli; $acctSrc = "profil CLI '$Project'" }
  if (-not $expAcct) { Fail "Neviem urcit ucet profilu '$Project' (sandbox subor bez account, profil bez account_id)." }
  $acctNote = ""
  try {
    $a = Invoke-RestMethod -Uri "https://api.stripe.com/v1/account" -Headers $h -Method Get
    if ([string]$a.id -ne $expAcct) { Fail "Kluc patri uctu $($a.id), ocakavany $expAcct ($acctSrc) - zastavene." }
    $acctNote = "/v1/account = $expAcct"
  } catch {
    $code = $null; try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    if ($code -eq 403) { $acctNote = "kluc bez prava na /v1/account (403) - ucet $expAcct overeny cez cenu" }
    elseif ($code) { Fail "Overenie uctu kluca zlyhalo (HTTP $code)." }
    else { throw }
  }
  Say "    ucet OK: $acctNote ($acctSrc); kluc vidi cenu $PriceId (15,90 EUR / mesiac, test) a ma pristup k Test Clocks"
}

function Get-Sha256([string]$s) {
  $sha = [Security.Cryptography.SHA256]::Create()
  return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s))) -replace "-", "").ToLower()
}

function Get-ServiceRole {
  if ($env:ESBLU_QA_SERVICE_ROLE) { $k = $env:ESBLU_QA_SERVICE_ROLE }
  else {
    $k = Read-HiddenText "Staging service_role kluc (esblu-test, nezobrazi sa)"
    $env:ESBLU_QA_SERVICE_ROLE = $k   # iba pre tento proces
  }
  if ($k.Length -lt 20) { Fail "Kluc je prilis kratky." }
  if ($k -match "^eyJ") {
    $payload = $k.Split(".")[1].Replace("-", "+").Replace("_", "/"); while ($payload.Length % 4) { $payload += "=" }
    if (([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))) -notmatch $StagingRef) { Fail "Kluc nepatri stagingu $StagingRef." }
  }
  return $k
}

function Get-HttpErrorText($err) {
  # Telo chybovej odpovede (PostgREST: code, message, details, hint). Windows PowerShell 5.1:
  # ErrorDetails.Message, inak stream odpovede. Vystup ide cez Hide-Secrets.
  $raw = $null
  if ($err.ErrorDetails -and $err.ErrorDetails.Message) { $raw = $err.ErrorDetails.Message }
  elseif ($err.Exception.Response) {
    try { $sr = New-Object IO.StreamReader($err.Exception.Response.GetResponseStream()); $raw = $sr.ReadToEnd(); $sr.Close() } catch { }
  }
  $status = $null
  try { $status = [int]$err.Exception.Response.StatusCode } catch { }
  $txt = "HTTP $status"
  if ($raw) {
    try {
      $j = $raw | ConvertFrom-Json
      $txt += " code=$($j.code) message=$($j.message) details=$($j.details) hint=$($j.hint)"
      if (-not $j.code -and -not $j.message) { $txt += " body=$raw" }
    } catch { $txt += " body=$raw" }
  }
  return (Hide-Secrets $txt)
}
function Invoke-Staging([string]$method, [string]$path, $body = $null) {
  $k = Get-ServiceRole
  $h = @{ apikey = $k; Authorization = "Bearer $k"; Prefer = "return=representation" }
  $u = "$StagingUrl/rest/v1/$path"
  $op = "$method /rest/v1/$(($path -split '\?')[0])"
  try {
    if ($body -ne $null) { return Invoke-RestMethod -Uri $u -Headers $h -Method $method -ContentType "application/json" -Body ($body | ConvertTo-Json -Compress) }
    return Invoke-RestMethod -Uri $u -Headers $h -Method $method
  } catch {
    Fail "Staging REST $op zlyhal: $(Get-HttpErrorText $_)"
  }
}

function Invoke-StripeRaw([string[]]$cli, [string[]]$StripeArgs) {
  # Bez kontroly chyb (napr. prazdny profil); vystup sa nikdy nevypisuje priamo. Exit kod -> $script:LastStripeExit.
  $cmd = $cli[0]; $rest = @(Get-CliRest $cli) + $StripeArgs
  $ErrorActionPreference = "Continue"
  $script:LastStripeExit = $null
  try {
    $out = ((& $cmd @rest 2>&1 | ForEach-Object { "$_" }) | Out-String)
    $script:LastStripeExit = $LASTEXITCODE
  } catch {
    $out = "spustenie '$cmd' zlyhalo: $($_.Exception.Message)"; $script:LastStripeExit = -1
  }
  return $out
}
function Get-ListenSecret([string[]]$cli, [switch]$Quiet) {
  # Rovnake poradie argumentov ako overeny rucny prikaz: stripe listen --print-secret --project-name <profil>.
  $i = [Array]::IndexOf([string[]]$cli, "--project-name")
  if ($i -ge 1) { $base = @($cli[0..($i - 1)]); $prof = @($cli[$i..($cli.Length - 1)]) } else { $base = @($cli); $prof = @() }
  $out = Invoke-StripeRaw $base (@("listen", "--print-secret") + $prof)
  $m = [regex]::Match($out, "whsec_[A-Za-z0-9]+")
  if ($m.Success) { return $m.Value }
  if (-not $Quiet) {
    # Diagnostika bez tajomstiev: exit kod a prvych 6 riadkov (cez Hide-Secrets).
    Say "    stripe listen --print-secret nevratil whsec_: CLI '$($base[0])', exit $($script:LastStripeExit)"
    foreach ($l in @(($out -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 6)) { Say "      | $l" }
  }
  return ""
}
function Get-ExposedHashes {
  # exposed.sha256 = jeden SHA-256 na riadok (vsetky vystavene / kompromitovane whsec_ tajomstva; nie tajomstvo).
  if (-not (Test-Path $ExposedFile)) { return @() }
  return @(Get-Content $ExposedFile | ForEach-Object { "$_".Trim().ToLower() } | Where-Object { $_ -match "^[0-9a-f]{64}$" })
}
function Add-ExposedHash([string]$h) {
  if (@(Get-ExposedHashes) -notcontains $h.ToLower()) { Add-Content -Path $ExposedFile -Value $h.ToLower() -Encoding ASCII }
}

function Get-EsbluAccount([string]$subId) {
  $k = Get-ServiceRole
  $h = @{ apikey = $k; Authorization = "Bearer $k" }
  $u = "$StagingUrl/rest/v1/subscription_accounts?provider_subscription_id=eq.$subId&select=status,plan_code,current_period_end,cancel_at_period_end,scheduled_end_at,company_id"
  $rows = Invoke-RestMethod -Uri $u -Headers $h -Method Get
  if ($rows -and $rows.Count -gt 0) { return $rows[0] } else { return $null }
}

function Invoke-Catchup {
  # Lokalny cron S12 (okno 1). Vracia JSON odpovede (iba pocty a kody).
  if (-not (Test-Path $CronFile)) { Fail "Okno 1 nebezi s novou verziou skriptu (chyba lokalny CRON_SECRET) - restartuj okno 1." }
  $cron = (Get-Content $CronFile -Raw).Trim()
  try {
    return Invoke-RestMethod -Uri "http://localhost:$Port/api/cron/billing-stripe-events" -Headers @{ Authorization = "Bearer $cron" } -Method Get
  } catch { Fail "GET /api/cron/billing-stripe-events zlyhal: $(Get-HttpErrorText $_)" }
}

function Wait-Esblu([string]$subId, [scriptblock]$ok, [string]$what) {
  for ($i = 0; $i -lt 40; $i++) {
    # Bez stripe listen (okno 1 -NoListen) prichadzaju zmeny IBA cez dotahovanie udalosti.
    if (Test-Path $NoListenFile) { Invoke-Catchup | Out-Null }
    $acc = Get-EsbluAccount $subId
    if ($acc -and (& $ok $acc)) { return $acc }
    Start-Sleep -Seconds 3
  }
  $last = if ($acc) { "stav=$($acc.status) koniec=$($acc.current_period_end)" } else { "ucet nenajdeny" }
  Fail "Esblu DB: $what sa do 120 s neprejavilo ($last). Skontroluj okno 1 (POST /api/billing/webhooks/stripe)."
}

function Get-Period($sub) {
  $item = $sub.items.data[0]
  $ps = if ($item.current_period_start) { $item.current_period_start } else { $sub.current_period_start }
  $pe = if ($item.current_period_end) { $item.current_period_end } else { $sub.current_period_end }
  return @{ start = [long]$ps; end = [long]$pe }
}
function Get-Sub([string]$id) { return (Get-StripeJson @("subscriptions", "retrieve", $id, "--expand", "latest_invoice")) }

function Get-ClockState {
  if (-not (Test-Path $ClockFile)) { Fail "Chyba stav test clock - spusti najprv -Step clock-setup -CheckoutId <uuid>." }
  return (Get-Content $ClockFile -Raw | ConvertFrom-Json)
}

function Move-Clock([string]$clock, [long]$to) {
  Invoke-Stripe @("test_helpers", "test_clocks", "advance", $clock, "-d", "frozen_time=$to") | Out-Null
  for ($i = 0; $i -lt 60; $i++) {
    $c = Get-StripeJson @("test_helpers", "test_clocks", "retrieve", $clock)
    if ($c.status -eq "ready") { return }
    if ($c.status -eq "internal_failure") { Fail "Test clock zlyhal (internal_failure)." }
    Start-Sleep -Seconds 2
  }
  Fail "Test clock sa do 120 s neposunul."
}

function Wait-StripeInvoice([string]$subId, [string]$reason, [string]$status, [long]$after) {
  for ($i = 0; $i -lt 40; $i++) {
    $s = Get-Sub $subId
    $li = $s.latest_invoice
    if ($li -and $li.billing_reason -eq $reason -and $li.status -eq $status -and $li.created -ge $after) { return $s }
    Start-Sleep -Seconds 3
  }
  Fail "Stripe: faktura $reason/$status sa do 120 s neobjavila."
}

function Get-PaidInvoices([string]$subId) {
  $list = Get-StripeJson @("invoices", "list", "-d", "subscription=$subId", "-d", "status=paid", "--limit", "20", "--expand", "data.payments")
  return @($list.data)
}
function Get-InvoicePaymentIntent($inv) {
  if ($inv.payments -and $inv.payments.data -and $inv.payments.data.Count -gt 0) {
    $p = $inv.payments.data[0].payment
    if ($p.payment_intent) { if ($p.payment_intent.id) { return $p.payment_intent.id } else { return $p.payment_intent } }
  }
  if ($inv.payment_intent) { if ($inv.payment_intent.id) { return $inv.payment_intent.id } else { return $inv.payment_intent } }
  Fail "Faktura $($inv.id) nema payment_intent."
}
function Get-RefundEventForInvoice([string]$subId, [string]$invoiceId) {
  # charge.refunded pre refundovanu fakturu. Server filtruje iba osvedcenym jednourovnovym filtrom
  # summary->>subscription (rovnako ako Get-SubEvents); dvojurovnovy filter summary->refund->>invoice
  # v PS 5.1 nevratil ziadny riadok, hoci udalost existovala. Fakturu porovnavame az v PowerShelli.
  $rows = Get-Rows "billing_events?provider=eq.stripe&event_type=eq.charge.refunded&summary->>subscription=eq.$subId&order=received_at.desc&limit=50&select=provider_event_id,status,error_code,received_at,processed_at,company_id,summary"
  foreach ($r in $rows) {
    $ri = $null
    if ($r.summary -and $r.summary.refund) { $ri = [string]$r.summary.refund.invoice }
    if ($ri -eq $invoiceId) { return $r }
  }
  return $null
}
function Get-LastRefundEventInfo {
  $rows = Get-Rows "billing_events?provider=eq.stripe&event_type=eq.charge.refunded&order=received_at.desc&limit=1&select=provider_event_id,status,error_code,received_at,summary"
  if ($rows.Count -eq 0) { return "ziadna udalost charge.refunded" }
  $r = $rows[0]
  return ("posledna charge.refunded: {0} status={1} chyba={2} prijata={3} faktura={4}" -f $r.provider_event_id, $r.status, $r.error_code, $r.received_at, $r.summary.refund.invoice)
}
function Get-ChargeRefundState([string]$pi) {
  # Stav refundacie platby v Stripe (na zabranenie dvojitej refundacii pri opakovanom behu).
  $p = Get-StripeJson @("payment_intents", "retrieve", $pi, "--expand", "latest_charge")
  $c = $p.latest_charge
  if (-not $c -or -not $c.id) { Fail "PaymentIntent $pi nema charge." }
  return @{ charge = $c.id; amount = [long]$c.amount; refunded = [long]$c.amount_refunded }
}
function Get-SubEvents([string]$subId, [string]$type) {
  $q = "billing_events?provider=eq.stripe&summary->>subscription=eq.$subId&order=received_at.asc&select=event_type,status,error_code,received_at,summary"
  if ($type) { $q += "&event_type=eq.$type" }
  return (Get-Rows $q)
}
function Get-ActiveSubEnts([string]$companyId) {
  # Vsetky aktivne a platne naroky firmy (kazdy zdroj) - to, co realne odomyka moduly v aplikacii.
  $now = [DateTime]::UtcNow.ToString("o")
  $rows = Get-Rows "company_entitlements?company_id=eq.$companyId&status=eq.active&or=(valid_until.is.null,valid_until.gt.$now)&select=entitlement_key,source,valid_until,external_ref"
  foreach ($r in $rows) { Say ("    aktivny narok: {0} zdroj={1} do={2} ref={3}" -f $r.entitlement_key, $r.source, $r.valid_until, $r.external_ref) }
  return $rows.Count
}
function Assert-TerminalKept([string]$subId, [string]$expect) {
  # Po ukonceni u Stripe pride customer.subscription.deleted (canceled) -> musi byt stale/TERMINAL_STATE.
  $del = $null
  for ($i = 0; $i -lt 40; $i++) {
    $del = Get-SubEvents $subId "customer.subscription.deleted" | Select-Object -Last 1
    if ($del -and $del.status -ne "received") { break }
    $del = $null; Start-Sleep -Seconds 3
  }
  if (-not $del) { Fail "Esblu DB: customer.subscription.deleted pre $subId sa do 120 s nespracovala." }
  $acc = Get-EsbluAccount $subId
  $ents = Get-ActiveSubEnts $acc.company_id
  Say "Esblu: customer.subscription.deleted -> status=$($del.status) error=$($del.error_code); ucet=$($acc.status); aktivne naroky (vsetky zdroje)=$ents"
  if ($acc.status -ne $expect) { Fail "Esblu stav $($acc.status) namiesto $expect (prepisany udalostou zrusenia)." }
  if ($del.status -ne "stale" -or $del.error_code -ne "TERMINAL_STATE") { Fail "Udalost zrusenia nebola zapisana ako stale/TERMINAL_STATE." }
  if ($ents -ne 0) { Fail "Firma ma stale $ents aktivnych narokov (vypis vyssie)." }
}

function Get-Counts([string]$subId, [string]$customer) {
  $inv = Get-StripeJson @("invoices", "list", "-d", "subscription=$subId", "--limit", "100")
  $ch = Get-StripeJson @("charges", "list", "-d", "customer=$customer", "--limit", "100")
  return @{ invoices = @($inv.data).Count; charges = @($ch.data | Where-Object { $_.status -eq "succeeded" }).Count; latest = @($inv.data)[0].id }
}

function Show-Logs {
  foreach ($name in @("listen.out.log", "listen.log")) {
    $log = Join-Path $StateDir $name
    if (Test-Path $log) { Say "--- posledne riadky $name (zamaskovane) ---"; Get-Content $log -Tail 12 | ForEach-Object { Say $_ } }
  }
}

# ----------------------------------------------------------------------------- S17 (P4 na skutocnom Stripe sandboxe)
# S17 overuje P4 funkcie (pripnuta verzia Stripe API, doklady + snapshot, archiv PDF, refundacia dobropisom,
# dotahovanie zmeskanej udalosti, mesacny export, poplatok/cista suma) na kode origin/main $S17ExpectedMain.
# Aplikacny kod checkoutu musi byt zhodny s tymto commitom - lisit sa smu IBA harness subory nizsie a docs/.
$S17HarnessFiles = @("scripts/stripe-local-sandbox.ps1", "scripts/s17-accounting-export.ts", "scripts/stripe-local-sandbox-static-tests.mjs")
$S17Ctx = @{ events = [ordered]@{} }
$S17Evidence = [ordered]@{}
$S17Steps = New-Object System.Collections.ArrayList
$S17DocSelect = "kind,status,company_id,provider_subscription_id,provider_customer_id,related_invoice_id,payment_intent_id,currency,total_minor,amount_paid_minor,service_period_start,service_period_end,issued_at,paid_at,pdf_url,pdf_sha256,pdf_storage_path,pdf_archived_at,pdf_archive_attempts,pdf_archive_error,customer_company_id,customer_legal_name,customer_ico,customer_dic,customer_ic_dph,customer_registration_id,customer_address,customer_billing_country,customer_snapshot_at,customer_snapshot_source,first_event_id,last_event_id,updated_at"
$S17ListenRe = "localhost:$Port/api/billing/webhooks/stripe"

function Hide-S17([string]$s) {
  # Hide-Secrets (kluce, whsec, JWT) + e-maily.
  $s = Hide-Secrets $s
  if ($s) { $s = $s -replace "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}", "***@***" }
  return $s
}
function Say17([string]$s, [string]$color = "") {
  if ($color) { Write-Host (Hide-S17 $s) -ForegroundColor $color } else { Write-Host (Hide-S17 $s) }
}
function Get-ShortId([string]$id) {
  if (-not $id) { return "" }
  if ($id.Length -le 16) { return $id }
  return $id.Substring(0, 16) + "..."
}
function Get-UtcIso { return [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture) }
function ConvertTo-UtcDate($v) {
  # PS 5.1 vracia casy z JSON ako text, PS 7 ako DateTime.
  if ($null -eq $v -or "$v" -eq "") { return $null }
  if ($v -is [DateTime]) { return $v.ToUniversalTime() }
  return [DateTimeOffset]::Parse([string]$v, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
}

function Invoke-Git([string[]]$GitArgs) {
  $ErrorActionPreference = "Continue"
  # stdout a stderr oddelene: varovania gitu (CRLF, safe.directory) sa nesmu citat ako nazvy suborov / SHA.
  $errFile = [IO.Path]::GetTempFileName()
  try {
    $out = @(& git -C $RepoRoot @GitArgs 2> $errFile | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
    $err = (Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
  } finally { Remove-Item $errFile -Force -ErrorAction SilentlyContinue }
  $txt = (($out | Where-Object { $_ }) -join "`n").Trim()
  if ($code -ne 0 -and $err) { $txt = ($txt + "`n" + $err).Trim() }
  return @{ code = $code; out = $txt }
}
function Test-S17HarnessPath([string]$p) {
  return (($S17HarnessFiles -contains $p) -or $p.StartsWith("docs/"))
}
function Get-S17HeadInfo {
  # Aplikacny kod HEAD (+ necommitnute zmeny) vs. ocakavany origin/main. Bez siete (ziadny git fetch).
  $hr = Invoke-Git @("rev-parse", "HEAD")
  if ($hr.code -ne 0 -or $hr.out -notmatch "^[0-9a-f]{40}$") { Fail "git rev-parse HEAD zlyhal v $RepoRoot ($($hr.out)) - checkout nie je funkcny." }
  $head = $hr.out
  $tree = (Invoke-Git @("rev-parse", "HEAD^{tree}")).out
  $origin = Invoke-Git @("rev-parse", "--verify", "--quiet", "origin/main")
  $expectedOk = ((Invoke-Git @("cat-file", "-e", "$S17ExpectedMain^{commit}")).code -eq 0)
  $changed = @()
  $expTree = ""
  if ($expectedOk) {
    $changed = @(((Invoke-Git @("diff", "--name-only", $S17ExpectedMain, "HEAD")).out -split "`n") | Where-Object { $_ })
    $expTree = (Invoke-Git @("rev-parse", "$S17ExpectedMain^{tree}")).out
  }
  $dirty = @(((Invoke-Git @("status", "--porcelain")).out -split "`n") | Where-Object { $_.Length -gt 3 } | ForEach-Object { $_.Substring(3).Trim('"') })
  $appChanged = @($changed | Where-Object { -not (Test-S17HarnessPath $_) })
  $appDirty = @($dirty | Where-Object { -not (Test-S17HarnessPath $_) })
  return [ordered]@{
    head = $head
    head_tree = $tree
    origin_main = $(if ($origin.code -eq 0) { $origin.out } else { "" })
    expected_main = $S17ExpectedMain
    expected_main_tree = $expTree
    expected_main_present = $expectedOk
    harness_or_docs_files_changed = ($changed.Count - $appChanged.Count)
    app_files_changed = $appChanged.Count
    app_files_uncommitted = $appDirty.Count
    app_changed_sample = @($appChanged | Select-Object -First 10)
    app_uncommitted_sample = @($appDirty | Select-Object -First 10)
    app_matches = ($expectedOk -and $appChanged.Count -eq 0 -and $appDirty.Count -eq 0)
  }
}
function Get-S17PinnedVersion {
  $f = Join-Path $RepoRoot "lib\billing\stripe-api-version.ts"
  if (-not (Test-Path $f)) { Fail "Chyba $f - S17 musi bezat z checkoutu s kodom origin/main (P4)." }
  $m = [regex]::Match((Get-Content $f -Raw), 'export const STRIPE_API_VERSION = "([^"]+)"')
  if (-not $m.Success) { Fail "Pripnuta verzia Stripe API sa v $f nenasla." }
  return $m.Groups[1].Value
}
function Get-S17EvidenceFile {
  # Hlavny checkout (C:\Users\...\assetpilot) aj pri behu z worktree: priecinok release-backups je git-excluded.
  $main = $RepoRoot
  $common = (Invoke-Git @("rev-parse", "--path-format=absolute", "--git-common-dir")).out
  if ($common -and ($common -notmatch "`n") -and (Test-Path $common)) { $main = Split-Path -Parent ($common -replace "/", "\") }
  $dir = Join-Path $main "release-backups\s17"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return (Join-Path $dir "s17-evidence.json")
}
function Save-S17Evidence {
  if (-not $S17Ctx.evidenceFile) { return }
  $S17Evidence["steps"] = @($S17Steps)
  $S17Evidence["updated_at"] = Get-UtcIso
  $json = $S17Evidence | ConvertTo-Json -Depth 12
  Set-Content -Path $S17Ctx.evidenceFile -Value (Hide-S17 $json) -Encoding UTF8
}
function Add-S17Result([string]$n, [string]$name, [string]$status, $details) {
  [void]$S17Steps.Add([ordered]@{ step = $n; name = $name; status = $status; at = (Get-UtcIso); details = $details })
  $color = "Cyan"
  if ($status -eq "PASS") { $color = "Green" } elseif ($status -eq "FAIL") { $color = "Red" } elseif ($status -eq "LIMITATION") { $color = "Yellow" }
  Say17 ("[{0}] S17-{1} {2}" -f $status, $n, $name) $color
  Save-S17Evidence
}
function Invoke-S17Step([string]$n, [string]$name, [scriptblock]$body) {
  # Telo nastavuje $d (detaily do dokazu); $d["_status"] = LIMITATION/INFO, inak PASS. Vynimka = FAIL a koniec.
  Say17 ""
  Say17 "=== S17-$n $name ==="
  $details = [ordered]@{}
  try {
    & $body $details | Out-Null
    $status = "PASS"
    if ($details.Contains("_status")) { $status = [string]$details["_status"]; $details.Remove("_status") }
    Add-S17Result $n $name $status $details
  } catch {
    $details["error"] = Hide-S17 ($_.Exception.Message)
    Add-S17Result $n $name "FAIL" $details
    throw
  }
}

function Save-S17State($st) {
  $st | ConvertTo-Json -Depth 6 | Set-Content -Path $S17StateFile -Encoding ASCII
}

function ConvertTo-FormBody($form) {
  if (-not $form) { return "" }
  return (@($form.GetEnumerator() | ForEach-Object { [Uri]::EscapeDataString([string]$_.Key) + "=" + [Uri]::EscapeDataString([string]$_.Value) }) -join "&")
}
function Invoke-StripeApi([string]$method, [string]$path, $form = $null, [string]$idem = "") {
  # Priame volanie Stripe API s PRIPNUTOU verziou (rovnaka hlavicka Stripe-Version ako posiela Esblu).
  if (-not $S17Ctx.pinned) { Fail "Pripnuta verzia Stripe API nie je nacitana." }
  if ($env:STRIPE_API_KEY -notmatch "^(?:sk|rk|rkcs)_test_") { Fail "STRIPE_API_KEY nie je testovaci kluc." }
  $h = @{ Authorization = "Bearer $($env:STRIPE_API_KEY)"; "Stripe-Version" = $S17Ctx.pinned }
  if ($idem) { $h["Idempotency-Key"] = $idem }
  $u = "https://api.stripe.com/v1$path"
  $body = ConvertTo-FormBody $form
  try {
    if ($method -eq "POST") {
      $r = Invoke-RestMethod -Uri $u -Headers $h -Method Post -ContentType "application/x-www-form-urlencoded" -Body $body
    } else {
      if ($body) { $u += "?" + $body }
      $r = Invoke-RestMethod -Uri $u -Headers $h -Method $method
    }
  } catch { Fail "Stripe $method $(($path -split '\?')[0]) zlyhal: $(Get-HttpErrorText $_)" }
  if ($r -and $r.PSObject.Properties["livemode"] -and $r.livemode -eq $true) { Fail "Stripe vratil livemode=true - S17 pracuje iba v test mode." }
  return $r
}
function Find-StripeEvent([string]$type, [string]$objectId, [int]$timeoutSec = 90) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  do {
    $r = Invoke-StripeApi "GET" "/events" ([ordered]@{ type = $type; limit = 25 })
    foreach ($e in @($r.data | ForEach-Object { $_ })) { if ($e.data.object.id -eq $objectId) { return $e } }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)
  Fail "Stripe: udalost $type pre $(Get-ShortId $objectId) sa do $timeoutSec s neobjavila."
}

function Invoke-LocalCron([string]$name) {
  if (-not (Test-Path $CronFile)) { Fail "Okno 1 nebezi (chyba lokalny CRON_SECRET) - spusti okno 1 (-Step start)." }
  $cron = (Get-Content $CronFile -Raw).Trim()
  try { return Invoke-RestMethod -Uri "http://localhost:$Port/api/cron/$name" -Headers @{ Authorization = "Bearer $cron" } -Method Get -TimeoutSec 180 }
  catch { Fail "GET /api/cron/$name zlyhal: $(Get-HttpErrorText $_)" }
}
function Invoke-S17Catchup {
  # Dotahovanie (S12) az po result=ok (prvy beh moze dotahovat starsie udalosti po strankach).
  $r = Invoke-LocalCron "billing-stripe-events"
  for ($i = 0; $i -lt 10 -and $r.result -eq "partial"; $i++) { $r = Invoke-LocalCron "billing-stripe-events" }
  return $r
}
function Get-BillingEventRows([string]$evtId) {
  return (Get-Rows "billing_events?provider=eq.stripe&environment=eq.test&provider_event_id=eq.$evtId&select=provider_event_id,event_type,status,error_code,company_id,received_at,processed_at,dead_letter")
}
function Wait-BillingEvent([string]$evtId, [int]$timeoutSec = 90) {
  # Riadok udalosti v Esblu, ktory uz nie je 'received' (spracovany / ignorovany / zlyhany); inak $null.
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  do {
    $rows = @(Get-BillingEventRows $evtId)
    if ($rows.Count -ge 1 -and $rows[0].status -ne "received") { return $rows[0] }
    Start-Sleep -Seconds 3
    if (Test-Path $NoListenFile) { Invoke-S17Catchup | Out-Null }   # bez stripe listen iba dotahovanie
  } while ((Get-Date) -lt $deadline)
  return $null
}
function Get-DocRows([string]$docId) {
  return (Get-Rows "billing_invoice_documents?provider=eq.stripe&environment=eq.test&provider_document_id=eq.$docId&select=$S17DocSelect")
}
function Wait-Doc([string]$docId, [scriptblock]$ok, [int]$timeoutSec = 90) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  do {
    $rows = @(Get-DocRows $docId)
    if ($rows.Count -ge 1 -and (& $ok $rows[0])) { return $rows[0] }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)
  return $null
}
function Get-S17StorageSha([string]$objectPath) {
  # Stiahnutie objektu z privatneho bucketu billing-documents (staging, service role) -> SHA-256. Subor sa hned zmaze.
  $k = Get-ServiceRole
  $tmp = Join-Path $StateDir ("s17-" + [Guid]::NewGuid().ToString("N") + ".pdf")
  $enc = (@($objectPath -split "/" | ForEach-Object { [Uri]::EscapeDataString($_) })) -join "/"
  try {
    Invoke-WebRequest -Uri "$StagingUrl/storage/v1/object/billing-documents/$enc" -Headers @{ apikey = $k; Authorization = "Bearer $k" } -OutFile $tmp -UseBasicParsing | Out-Null
  } catch { Fail "Stiahnutie PDF zo staging storage zlyhalo: $(Get-HttpErrorText $_)" }
  try {
    $bytes = [IO.File]::ReadAllBytes($tmp)
    $magic = ""
    if ($bytes.Length -ge 5) { $magic = [Text.Encoding]::ASCII.GetString($bytes, 0, 5) }
    $sha = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
    return @{ sha256 = $sha; bytes = $bytes.Length; is_pdf = ($magic -eq "%PDF-") }
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

function Get-S17ListenProcesses {
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and $_.CommandLine -match "\blisten\b" -and $_.CommandLine -match "forward-to" -and $_.CommandLine.Contains($S17ListenRe) })
}
function Test-S17ListenAlive {
  if (Test-Path $ListenPidFile) {
    $listenPid = 0
    if ([int]::TryParse((Get-Content $ListenPidFile -Raw).Trim(), [ref]$listenPid) -and (Get-Process -Id $listenPid -ErrorAction SilentlyContinue)) { return $true }
  }
  return ((Get-S17ListenProcesses).Count -gt 0)
}
function Stop-S17Listen {
  # Zastavi `stripe listen` z okna 1 (cely strom procesov npx -> node -> stripe). Esblu (next dev) bezi dalej.
  $killed = 0
  if (Test-Path $ListenPidFile) {
    $listenPid = 0
    if ([int]::TryParse((Get-Content $ListenPidFile -Raw).Trim(), [ref]$listenPid) -and (Get-Process -Id $listenPid -ErrorAction SilentlyContinue)) {
      $ErrorActionPreference = "Continue"
      & taskkill.exe /PID $listenPid /T /F 2>&1 | Out-Null
      $ErrorActionPreference = "Stop"
      $killed++
    }
  }
  foreach ($p in (Get-S17ListenProcesses)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }
  Start-Sleep -Seconds 3
  return @{ killed = $killed; remaining = (Get-S17ListenProcesses).Count }
}

function Enable-S17Billing($st) {
  # Staging billing iba pre test: web_provider='stripe' + aktivna cena sandboxu. Predchadzajuci stav sa ulozi PRED zmenou.
  $null = Assert-StagingAccess   # READ-ONLY (URL, service_role, environment=test) pred prvym zapisom S17
  $cfg = @(Get-Rows "billing_runtime_config?select=web_provider,environment")[0]
  if (-not $cfg) { Fail "Staging billing_runtime_config nema riadok." }
  if ($cfg.environment -ne "test") { Fail "Staging billing_runtime_config.environment=$($cfg.environment) (ocakavane test)." }
  if ([string]$cfg.web_provider -ne "none") { Fail "Staging web_provider=$($cfg.web_provider) (ocakavane none = billing vypnuty). Najprv -Step s17-cleanup alebo over stav stagingu." }
  $prices = @(Get-Rows "billing_provider_prices?provider=eq.stripe&environment=eq.test&select=provider_price_id,plan_code,billing_interval,active")
  $st.prev_web_provider = [string]$cfg.web_provider
  $st.prev_prices = @($prices | ForEach-Object { [ordered]@{ price = [string]$_.provider_price_id; active = [bool]$_.active } })
  $st.mapping_created = $false
  $st.enabled = $true
  $st.restored = $false
  Save-S17State $st
  $cur = Reset-S17EventCursor $st
  if (-not (@($prices | Where-Object { $_.provider_price_id -eq $PriceId }).Count)) {
    # Staging nema riadok pre cenu sandboxu -> obnovitelne mapovanie (novy riadok, presne 1 aktivna); obnova S17-11
    # vrati aktivne ceny na stav PRED tymto krokom (prev_prices) a web_provider na 'none'.
    Say17 "    staging nema mapovanie pre $(Get-ShortId $PriceId) -> vytvaram (Set-StagingPriceMapping)"
    $st.mapping_created = $true
    Save-S17State $st
    Set-StagingPriceMapping $PriceId
  }
  foreach ($p in @($prices | Where-Object { $_.active -and $_.provider_price_id -ne $PriceId -and $_.plan_code -eq "esblu_complete" -and $_.billing_interval -eq "month" })) {
    Invoke-Staging "PATCH" "billing_provider_prices?provider=eq.stripe&environment=eq.test&provider_price_id=eq.$($p.provider_price_id)" @{ active = $false } | Out-Null
  }
  Invoke-Staging "PATCH" "billing_provider_prices?provider=eq.stripe&environment=eq.test&provider_price_id=eq.$PriceId" @{ active = $true } | Out-Null
  Invoke-Staging "PATCH" "billing_runtime_config?id=eq.true" @{ web_provider = "stripe" } | Out-Null
  $cfg2 = @(Get-Rows "billing_runtime_config?select=web_provider,environment")[0]
  $act = @(Get-Rows "billing_provider_prices?provider=eq.stripe&environment=eq.test&active=eq.true&select=provider_price_id")
  if ($cfg2.web_provider -ne "stripe" -or $act.Count -ne 1 -or $act[0].provider_price_id -ne $PriceId) { Fail "Zapnutie billingu na stagingu sa neprejavilo (web_provider=$($cfg2.web_provider), aktivnych cien $($act.Count))." }
  return [ordered]@{ prev_web_provider = $st.prev_web_provider; prev_active_prices = @($st.prev_prices | Where-Object { $_.active }).Count; mapping_created = [bool]$st.mapping_created; now_web_provider = "stripe"; now_active_price = (Get-ShortId $PriceId); event_cursor = $cur }
}

$S17CursorPath = "billing_event_cursors?provider=eq.stripe&environment=eq.test"
$S17CursorCols = @("provider", "environment", "account_ref", "last_event_id", "last_event_created", "events_processed", "last_run_at", "last_success_at", "last_error_code", "consecutive_failures", "created_at", "updated_at")

function Reset-S17EventCursor($st) {
  # Kurzor dotahovania udalosti (billing_event_cursors) je v aplikacii viazany na Stripe ucet: iny ucet -> cron vrati
  # ACCOUNT_MISMATCH a nic nespracuje (zamerna ochrana, NEMENI sa). Reset je podla migracie vedomy krok operatora:
  # ak kurzor patri inemu (staremu) sandboxu, povodny riadok sa ULOZI do stavu S17 a az potom zmaze; cron ho pri
  # prvom behu zalozi pre ucet testovaneho sandboxu. S17-11 / s17-cleanup povodny riadok vrati (Restore-S17EventCursor).
  $acct = $SandboxAccount
  if (-not $acct) { $acct = Get-ProfileAccountId $StripeCli }
  if ($acct -notmatch '^acct_[A-Za-z0-9]{1,64}$') { Fail "Neviem urcit Stripe ucet profilu '$Project' pre kurzor udalosti." }
  $st.cursor_account = $acct
  Save-S17State $st
  $cur = @(Get-Rows "$($S17CursorPath)&select=*")[0]
  if (-not $cur) { return [ordered]@{ action = "none (kurzor neexistuje, cron ho zalozi pre $acct)" } }
  if ([string]$cur.account_ref -eq $acct) { return [ordered]@{ action = "none (kurzor uz patri $acct)" } }
  if ($cur.lease_until -and [DateTimeOffset]::Parse([string]$cur.lease_until) -gt [DateTimeOffset]::UtcNow) {
    Fail "Kurzor udalosti na stagingu ma aktivny lease (prave bezi iny beh catch-up) - zopakuj neskor."
  }
  $prev = [ordered]@{}
  foreach ($c in $S17CursorCols) { $prev[$c] = $cur.$c }
  $st.prev_cursor = $prev
  $st.cursor_reset = $true
  $st.cursor_restored = $false
  Save-S17State $st   # zaloha PRED zmazanim
  $del = @(Invoke-Staging "DELETE" "$($S17CursorPath)&account_ref=eq.$($cur.account_ref)" | ForEach-Object { $_ })
  if ($del.Count -ne 1) { Fail "Reset kurzora udalosti: zmazanych riadkov $($del.Count) (ocakavany 1)." }
  if (@(Get-Rows "$($S17CursorPath)&select=account_ref").Count -ne 0) { Fail "Reset kurzora udalosti sa neprejavil." }
  Say17 "    kurzor udalosti: ucet $($cur.account_ref) -> reset pre $acct (povodny riadok ulozeny, S17-11 ho vrati)" "Yellow"
  return [ordered]@{ action = "reset"; prev_account = [string]$cur.account_ref; prev_last_event = (Get-ShortId ([string]$cur.last_event_id)); prev_events_processed = $cur.events_processed; test_account = $acct }
}

function Restore-S17EventCursor($st) {
  # Idempotentne vrati povodny riadok kurzora (ak ho S17 resetoval). Zmaze iba kurzor testovaneho uctu.
  if (-not $st.cursor_reset -or $st.cursor_restored) { return "nic (kurzor S17 neresetoval alebo uz obnoveny)" }
  $prev = $st.prev_cursor
  $prevAcct = [string]$prev.account_ref
  $testAcct = [string]$st.cursor_account
  if ($prevAcct -notmatch '^acct_' -or $testAcct -notmatch '^acct_') { throw "stav S17 nema povodny kurzor / ucet testu." }
  $now = @(Get-Rows "$($S17CursorPath)&select=account_ref,lease_until")[0]
  if ($now -and [string]$now.account_ref -ne $prevAcct) {
    if ([string]$now.account_ref -ne $testAcct) { throw "kurzor patri neocakavanemu uctu $($now.account_ref) - nemenim, over rucne." }
    Invoke-Staging "DELETE" "$($S17CursorPath)&account_ref=eq.$testAcct" | Out-Null
    $now = $null
  }
  if (-not $now) {
    $body = [ordered]@{}
    foreach ($c in $S17CursorCols) { $body[$c] = $prev.$c }
    $body["lease_owner"] = $null
    $body["lease_until"] = $null
    Invoke-Staging "POST" "billing_event_cursors" $body | Out-Null
  }
  $chk = @(Get-Rows "$($S17CursorPath)&select=account_ref,last_event_id,events_processed")
  if ($chk.Count -ne 1 -or [string]$chk[0].account_ref -ne $prevAcct -or [string]$chk[0].last_event_id -ne [string]$prev.last_event_id) { throw "obnova kurzora sa neprejavila." }
  $st.cursor_restored = $true
  Save-S17State $st
  return "obnoveny (ucet $prevAcct, posledna udalost $(Get-ShortId ([string]$prev.last_event_id)))"
}

function Restore-S17Staging($st) {
  # Idempotentne: (a) ukoncit QA predplatne u Stripe a dotiahnut do Esblu, (b) vratit staging konfiguraciu.
  # Dokazy (billing_events, doklady, archiv PDF, ledger) ostavaju.
  $d = [ordered]@{}
  $errors = @()
  if ($st.subscription) {
    try {
      $s = $null
      try { $s = Invoke-StripeApi "GET" "/subscriptions/$($st.subscription)" }
      catch {
        # Zmazanie Test Clock (predchadzajuci cleanup) zmaze aj zakaznika a predplatne -> 404 = v Stripe uz neexistuje.
        if ($_.Exception.Message -match "HTTP 404") { $s = [pscustomobject]@{ status = "canceled"; note = "404 (zmazane s Test Clock)" } } else { throw }
      }
      if ($s.status -ne "canceled" -and $s.status -ne "incomplete_expired") { $s = Invoke-StripeApi "DELETE" "/subscriptions/$($st.subscription)" }
      for ($i = 0; $i -lt 20 -and $s.status -ne "canceled" -and $s.status -ne "incomplete_expired"; $i++) { Start-Sleep -Seconds 3; $s = Invoke-StripeApi "GET" "/subscriptions/$($st.subscription)" }
      $d["stripe_subscription"] = Get-ShortId $st.subscription
      $d["stripe_subscription_status"] = [string]$s.status
      if ($s.status -ne "canceled" -and $s.status -ne "incomplete_expired") { throw "Stripe predplatne nie je ukoncene (stav=$($s.status))." }
      # stripe listen je po S17-7 zastaveny -> ukoncenie prenesie dotahovanie (ako by webhook vypadol).
      # Dotahovanie vyzaduje okno 1 (CRON_SECRET) a zapnuty billing na stagingu (pred obnovou konfiguracie).
      $cfgNow = @(Get-Rows "billing_runtime_config?select=web_provider")[0]
      $canCatchup = (Test-Path $CronFile) -and ([string]$cfgNow.web_provider -eq "stripe")
      $acc = $null
      for ($i = 0; $i -lt 20; $i++) {
        $acc = Get-EsbluAccount $st.subscription
        if (-not $acc -or $acc.status -in @("canceled", "expired", "refunded", "revoked")) { break }
        if (-not $canCatchup) { break }
        Invoke-S17Catchup | Out-Null
        Start-Sleep -Seconds 3
      }
      $d["esblu_account_status"] = $(if ($acc) { [string]$acc.status } else { "none" })
      if ($acc -and $acc.status -notin @("canceled", "expired", "refunded", "revoked")) {
        if ($canCatchup) { throw "Esblu ucet ostal $($acc.status) po ukonceni v Stripe." }
        # Billing uz vypnuty / okno 1 nebezi: Stripe je ukonceny, Esblu (iba QA-STRIPE D na stagingu) sa nedotiahne -> upozornenie.
        $d["warning"] = "QA-STRIPE D: Esblu ucet $($acc.status) - dotahovanie nedostupne (billing vypnuty alebo okno 1 nebezi); Stripe predplatne ukoncene."
      }
      $ents = Get-ActiveSubEnts $CompanyD
      $d["company_d_active_entitlements"] = $ents
      if ($ents -ne 0 -and -not $d.Contains("warning")) { throw "Firma QA-STRIPE D ma po ukonceni $ents ucinnych narokov." }
    } catch { $errors += "predplatne: $($_.Exception.Message)" }
  }
  if ($st.enabled -and -not $st.restored) {
    try {
      Invoke-Staging "PATCH" "billing_runtime_config?id=eq.true" @{ web_provider = [string]$st.prev_web_provider } | Out-Null
      # najprv vypnut kazdu aktivnu cenu, ktora PRED S17 aktivna nebola (aj riadok vytvoreny S17), az potom zapnut
      # povodne aktivne -> nikdy 2 aktivne ceny naraz (unikatny index). Riadok mapovania S17 ostava (neaktivny).
      $prevActive = @(@($st.prev_prices) | Where-Object { $_ -and [bool]$_.active } | ForEach-Object { [string]$_.price })
      $nowActive = @(Get-Rows "billing_provider_prices?provider=eq.stripe&environment=eq.test&active=eq.true&select=provider_price_id")
      foreach ($r in $nowActive) {
        if ($prevActive -notcontains [string]$r.provider_price_id) {
          Invoke-Staging "PATCH" "billing_provider_prices?provider=eq.stripe&environment=eq.test&provider_price_id=eq.$($r.provider_price_id)" @{ active = $false } | Out-Null
        }
      }
      foreach ($pid0 in $prevActive) {
        Invoke-Staging "PATCH" "billing_provider_prices?provider=eq.stripe&environment=eq.test&provider_price_id=eq.$pid0" @{ active = $true } | Out-Null
      }
      $st.restored = $true
      Save-S17State $st
    } catch { $errors += "konfiguracia: $($_.Exception.Message)" }
  }
  try { $d["event_cursor"] = Restore-S17EventCursor $st } catch { $errors += "kurzor udalosti: $($_.Exception.Message)" }
  try {
    # Zamer checkoutu QA-STRIPE D z tohto behu, ktory po zlyhani ostal 'created'/'open' -> expired (iba od zaciatku S17).
    if ($st.started_at) {
      $since = [Uri]::EscapeDataString([string]$st.started_at)
      $ex = @(Invoke-Staging "PATCH" "billing_checkout_sessions?company_id=eq.$CompanyD&status=in.(created,open)&created_at=gte.$since" @{ status = "expired" } | ForEach-Object { $_ })
      $d["checkout_intents_expired"] = $ex.Count
    }
  } catch { $errors += "zamer checkoutu: $($_.Exception.Message)" }
  try {
    $cfg = @(Get-Rows "billing_runtime_config?select=web_provider,environment")[0]
    $act = @(Get-Rows "billing_provider_prices?provider=eq.stripe&environment=eq.test&active=eq.true&select=provider_price_id")
    $d["web_provider"] = [string]$cfg.web_provider
    $d["active_stripe_test_prices"] = $act.Count
    if ($st.enabled) {
      $expActive = @(@($st.prev_prices) | Where-Object { $_.active }).Count
      $prevActiveIds = @(@($st.prev_prices) | Where-Object { $_ -and [bool]$_.active } | ForEach-Object { [string]$_.price })
      $unexpected = @($act | Where-Object { $prevActiveIds -notcontains [string]$_.provider_price_id })
      if ([string]$cfg.web_provider -ne [string]$st.prev_web_provider -or $act.Count -ne $expActive -or $unexpected.Count -gt 0) { $errors += "konfiguracia: web_provider=$($cfg.web_provider) (povodne $($st.prev_web_provider)), aktivnych cien $($act.Count) (povodne $expActive)" }
    }
  } catch { $errors += "kontrola konfiguracie: $($_.Exception.Message)" }
  $d["test_clocks_kept"] = @(@($st.clocks) | Where-Object { $_ }).Count
  if ($errors.Count -gt 0) {
    $d["errors"] = @($errors | ForEach-Object { Hide-S17 $_ })
    Say17 "RUCNE UPRATANIE: -Step s17-cleanup (alebo SQL na stagingu: web_provider='$($st.prev_web_provider)', ceny podla $S17StateFile)." "Red"
  }
  return $d
}

function Invoke-S17 {
  $S17Ctx.t0 = Get-UtcIso
  $S17Ctx.evidenceFile = Get-S17EvidenceFile
  $S17Evidence["test"] = "S17 - P4 billing na Stripe sandboxe (pripnuta verzia, doklady + snapshot, archiv PDF, refundacia dobropisom, zmeskana udalost, export, poplatok/cista suma)"
  $S17Evidence["started_at"] = $S17Ctx.t0
  $S17Evidence["project"] = $Project
  $S17Evidence["staging_ref"] = $StagingRef
  $S17Evidence["stripe_price"] = Get-ShortId $PriceId
  $S17Evidence["qa_company"] = "QA-STRIPE D ($($CompanyD.Substring(0, 8))...)"
  $S17Evidence["overall"] = "RUNNING"
  Say17 "Dokazy (bez tajomstiev): $($S17Ctx.evidenceFile)"
  if ((Invoke-Git @("check-ignore", "-q", "release-backups/s17/s17-evidence.json")).code -ne 0) { Say17 "POZOR: release-backups/ nie je v git exclude - subor dokazov necommitovat." "Yellow" }

  # Stav pre upratanie (aj po padnuti: -Step s17-cleanup). Neupratany predchadzajuci beh = stop.
  $clocks = @()
  if (Test-Path $S17StateFile) {
    $old = Get-Content $S17StateFile -Raw | ConvertFrom-Json
    if ($old.enabled -and -not $old.restored) { Fail "Predchadzajuci beh S17 neupratal staging - spusti najprv -Step s17-cleanup." }
    if ($old.cursor_reset -and -not $old.cursor_restored) { Fail "Predchadzajuci beh S17 neobnovil kurzor udalosti (zaloha je iba v $S17StateFile) - spusti najprv -Step s17-cleanup." }
    if ($old.subscription) { Fail "Predchadzajuci beh S17 nema dokonceny cleanup (predplatne $(Get-ShortId ([string]$old.subscription))) - spusti najprv -Step s17-cleanup." }
    $clocks = @(@($old.clocks) | Where-Object { $_ })
  }
  $st = [ordered]@{ started_at = $S17Ctx.t0; enabled = $false; restored = $false; prev_web_provider = $null; prev_prices = @(); clocks = $clocks; clock = $null; customer = $null; subscription = $null; invoice = $null; cursor_account = $null; prev_cursor = $null; cursor_reset = $false; cursor_restored = $false }
  $S17Ctx.state = $st
  Save-S17State $st
  $failed = $false

  try {
    Invoke-S17Step "1" "Preflight (test mode, staging, HEAD = origin/main) + zapnutie billingu na stagingu" {
      param($d)
      $kind = "?"
      if ($env:STRIPE_API_KEY -match "^rkcs_test_") { $kind = "rkcs_test" } elseif ($env:STRIPE_API_KEY -match "^rk_test_") { $kind = "rk_test" } elseif ($env:STRIPE_API_KEY -match "^sk_test_") { $kind = "sk_test" }
      if ($kind -eq "?") { Fail "Stripe kluc nie je testovaci (sk_test_/rk_test_/rkcs_test_)." }
      $d["stripe_key_kind"] = $kind
      if ($StagingUrl -notmatch $StagingRef -or $StagingUrl -match $ProdRef) { Fail "Supabase URL nie je staging $StagingRef." }
      Get-ServiceRole | Out-Null
      $d["supabase"] = "staging $StagingRef (produkcia $ProdRef odmietnuta)"
      $S17Ctx.pinned = Get-S17PinnedVersion
      $d["pinned_api_version"] = $S17Ctx.pinned
      try { $acct = Invoke-StripeApi "GET" "/account"; $d["stripe_account"] = Get-ShortId ([string]$acct.id) } catch { $d["stripe_account"] = "neoverene (kluc bez Account: read)" }
      $hi = Get-S17HeadInfo
      $S17Evidence["git"] = $hi
      $d["head"] = $hi.head
      $d["origin_main"] = $hi.origin_main
      $d["app_matches_expected_main"] = $hi.app_matches
      Say17 "    HEAD $($hi.head) | origin/main $(if ($hi.origin_main) { $hi.origin_main } else { '-' }) | ocakavany $S17ExpectedMain"
      Say17 "    aplikacny kod = ocakavany: $($hi.app_matches) (zmenene app subory $($hi.app_files_changed), necommitnute $($hi.app_files_uncommitted), harness/docs $($hi.harness_or_docs_files_changed))"
      $headProblems = @()
      if (-not $hi.expected_main_present) { $headProblems += "commit $S17ExpectedMain lokalne chyba (git fetch origin)" }
      if (-not $hi.app_matches) { $headProblems += "aplikacny kod HEAD sa lisi od $S17ExpectedMain ($(($hi.app_changed_sample + $hi.app_uncommitted_sample) -join ', '))" }
      if ($hi.origin_main -ne $S17ExpectedMain) { $headProblems += "origin/main = $(if ($hi.origin_main) { $hi.origin_main } else { 'nezname' }) (ocakavany $S17ExpectedMain)" }
      if (-not (Test-Path $HeadFile)) { $headProblems += "okno 1 nebezi s touto verziou skriptu (chyba $HeadFile)" }
      else {
        $w1 = Get-Content $HeadFile -Raw | ConvertFrom-Json
        $d["window1_head"] = [string]$w1.head
        if ([string]$w1.head -ne $hi.head -or [string]$w1.repo -ne $RepoRoot) { $headProblems += "okno 1 bezi z ineho checkoutu/commitu ($([string]$w1.head), $([string]$w1.repo))" }
      }
      if ($headProblems.Count -gt 0) {
        if (-not $Force) { Fail ("S17 odmieta bezat: " + ($headProblems -join "; ") + ". Postup: docs par. 8.14 (worktree na origin/main), alebo -Force.") }
        Say17 ("    POZOR -Force: " + ($headProblems -join "; ")) "Yellow"
        $d["head_check"] = "FORCED: " + ($headProblems -join "; ")
      } else { $d["head_check"] = "OK" }
      if (-not (Test-Path $CronFile)) { Fail "Okno 1 nebezi (chyba lokalny CRON_SECRET) - spusti okno 1: -Step start." }
      if ($kind -eq "rkcs_test") { Fail "Kluc rkcs_test_ (neprevzaty sandbox) nema pravo vytvarat Test Clocks - pouzi Secret key prevzateho sandboxu." }
      $null = Test-StripeKeyAccess $env:STRIPE_API_KEY (Get-S17PinnedVersion)
      if (Test-Path $NoListenFile) {
        $d["stripe_listen"] = "NIE (-NoListen): udalosti iba cez dotahovanie /v1/events (ta ista pipeline processVerifiedEvent); overenie podpisu webhooku pokryva S12/S16 + unit testy (kod podpisu bez zmeny od S15)"
      } else {
        if ($NoListenOnly) { Fail "Profil '$Project' ma zverejnene whsec_ - S17 iba s oknom 1 -NoListen (s17-auto to nastavi samo)." }
        if (-not (Test-S17ListenAlive)) { Fail "stripe listen v okne 1 nebezi - restartuj okno 1 (-Step start)." }
        $d["stripe_listen"] = "bezi"
      }
      $en = Enable-S17Billing $S17Ctx.state
      $d["staging_billing"] = $en
      Say17 "    staging: web_provider $($en.prev_web_provider) -> stripe, aktivna cena $($en.now_active_price) (povodny stav ulozeny pre obnovu)"
    }

    Invoke-S17Step "2" "Pripnuta verzia Stripe API + dotahovanie (lokalny cron billing-stripe-events)" {
      param($d)
      $r = Invoke-S17Catchup
      $retryCode = $null
      if ($r.retry) { $retryCode = $r.retry.code }
      $d["cron"] = [ordered]@{ success = $r.success; configured = $r.configured; result = $r.result; processed = $r.processed; outcomes = $r.outcomes; code = $r.code; retry_code = $retryCode }
      Say17 "    dotahovanie: result=$($r.result) processed=$($r.processed) outcomes=$(($r.outcomes | ConvertTo-Json -Compress)) code=$($r.code) retry=$retryCode"
      if (-not $r.configured) { Fail "Dotahovanie nie je nakonfigurovane (okno 1 ESBLU_BILLING_MODE / DB web_provider)." }
      if (-not $r.success -or ($r.result -ne "ok" -and $r.result -ne "partial")) { Fail "Dotahovanie skoncilo result=$($r.result) code=$($r.code)." }
      if ("$($r.code) $retryCode" -match "VERSION|NOT_CONFIGURED") { Fail "Chyba verzie Stripe API / konfiguracie: $($r.code) $retryCode." }
      if ($r.code) { Fail "Dotahovanie vratilo kod $($r.code)." }
      $ev = Invoke-StripeApi "GET" "/events" ([ordered]@{ limit = 1 })
      $first = @($ev.data | ForEach-Object { $_ })[0]
      $evVer = ""
      if ($first) { $evVer = [string]$first.api_version }
      $d["latest_event_api_version"] = $evVer
      $d["account_events_match_pinned"] = ($evVer -eq $S17Ctx.pinned)
      try {
        $we = Invoke-StripeApi "GET" "/webhook_endpoints" ([ordered]@{ limit = 20 })
        $eps = @($we.data | ForEach-Object { $_ })
        $d["webhook_endpoints"] = $eps.Count
        $d["webhook_endpoint_versions"] = @($eps | ForEach-Object { if ($_.api_version) { [string]$_.api_version } else { "predvolena_uctu" } } | Select-Object -Unique)
      } catch { $d["webhook_endpoints"] = "neoverene (kluc bez Webhook Endpoints: read)" }
      $al = @(Get-Rows "billing_ops_alerts?environment=eq.test&code=eq.WEBHOOK_API_VERSION_MISMATCH&select=occurrences,state,last_seen_at&order=last_seen_at.desc&limit=1")
      $S17Ctx.versionAlertBefore = $(if ($al.Count) { "$($al[0].last_seen_at)|$($al[0].occurrences)" } else { "" })
      $d["listen_semantics"] = "stripe listen (bez --latest) preposiela udalosti vo verzii predvolenej pre ucet sandboxu; Esblu stav predplatneho vzdy nacita znova z API s pripnutou verziou, doklad uklada z tela udalosti (+ /v1/invoice_payments s pripnutou verziou); nezhoda = ops alert WEBHOOK_API_VERSION_MISMATCH (warning), spracovanie pokracuje"
      Say17 "    pripnuta verzia Esblu: $($S17Ctx.pinned); verzia udalosti uctu: $(if ($evVer) { $evVer } else { '-' }); webhook endpointy: $($d['webhook_endpoints'])"
      if ($evVer -and $evVer -ne $S17Ctx.pinned) { Say17 "    INFO: verzia udalosti uctu != pripnuta -> webhook z stripe listen vyvola ops alert WEBHOOK_API_VERSION_MISMATCH (ocakavane, overi sa v kroku 3)." "Yellow" }
    }

    Invoke-S17Step "3" "Nakup bez zadavania karty (Test Clock, pm_card_visa, zamer Esblu) -> invoice.paid spracovane" {
      param($d)
      $st = $S17Ctx.state
      Invoke-Staging "PATCH" "billing_checkout_sessions?company_id=eq.$CompanyD&status=in.(created,open)" @{ status = "expired" } | Out-Null
      $row = Invoke-Staging "POST" "billing_checkout_sessions" @{ company_id = $CompanyD; created_by = $OwnerD; provider = "stripe"; environment = "test";
        plan_code = "esblu_complete"; billing_interval = "month"; provider_price_id = $PriceId; expires_at = (Get-Date).ToUniversalTime().AddHours(1).ToString("o") }
      $checkoutId = [string](@($row)[0].id)
      if ($checkoutId -notmatch "^[0-9a-f-]{36}$") { Fail "Zamer checkoutu pre QA-STRIPE D nevznikol." }
      $tag = "s17-" + [Guid]::NewGuid().ToString("N").Substring(0, 12)
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
      $clock = Invoke-StripeApi "POST" "/test_helpers/test_clocks" ([ordered]@{ frozen_time = $now; name = "Esblu S17" }) "$tag-clock"
      $st.clock = [string]$clock.id
      $st.clocks = @(@($st.clocks) + [string]$clock.id | Where-Object { $_ })
      Save-S17State $st
      $cus = Invoke-StripeApi "POST" "/customers" ([ordered]@{ test_clock = $clock.id; name = "QA-STRIPE D S17"; "metadata[esblu_qa]" = "s17" }) "$tag-cus"
      $st.customer = [string]$cus.id
      Save-S17State $st
      $pm = Invoke-StripeApi "POST" "/payment_methods/pm_card_visa/attach" ([ordered]@{ customer = $cus.id }) "$tag-pm"
      $S17Ctx.pmOk = [string]$pm.id
      Invoke-StripeApi "POST" "/customers/$($cus.id)" ([ordered]@{ "invoice_settings[default_payment_method]" = $pm.id }) "$tag-cus-pm" | Out-Null
      $sub = Invoke-StripeApi "POST" "/subscriptions" ([ordered]@{ customer = $cus.id; "items[0][price]" = $PriceId; "metadata[esblu_checkout_id]" = $checkoutId; default_payment_method = $pm.id }) "$tag-sub"
      $st.subscription = [string]$sub.id
      Save-S17State $st
      $S17Ctx.sub = [string]$sub.id
      $S17Ctx.customer = [string]$cus.id
      $s = $null; $inv = $null
      for ($i = 0; $i -lt 40; $i++) {
        $s = Invoke-StripeApi "GET" "/subscriptions/$($sub.id)" ([ordered]@{ "expand[]" = "latest_invoice" })
        $inv = $s.latest_invoice
        if ($inv -and $inv.id -and $inv.status -eq "paid" -and $s.status -eq "active") { break }
        Start-Sleep -Seconds 3
      }
      if (-not $inv -or $inv.status -ne "paid" -or $s.status -ne "active") { Fail "Stripe: prva faktura nie je zaplatena / predplatne nie je active (stav=$($s.status))." }
      $S17Ctx.inv = [string]$inv.id
      $st.invoice = [string]$inv.id
      Save-S17State $st
      $line = @($inv.lines.data | ForEach-Object { $_ }) | Where-Object { $_.period } | Select-Object -First 1
      $S17Ctx.period = @{ start = [long]$line.period.start; end = [long]$line.period.end }
      $parentSub = ""
      if ($inv.parent -and $inv.parent.subscription_details) { $parentSub = [string]$inv.parent.subscription_details.subscription }
      $d["pinned_invoice_shape"] = $(if ($parentSub -eq $sub.id) { "OK (invoice.parent.subscription_details)" } else { "CHYBA" })
      if ($parentSub -ne $sub.id) { Fail "Faktura nacitana s pripnutou verziou nema invoice.parent.subscription_details.subscription = predplatne." }
      Say17 "    Stripe: $(Get-ShortId $sub.id) active, faktura $(Get-ShortId $inv.id) zaplatena $(Format-Eur ([long]$inv.amount_paid) ([string]$inv.currency)), obdobie $(Utc $S17Ctx.period.start) -> $(Utc $S17Ctx.period.end)"
      $acc = Wait-Esblu $sub.id { param($a) $a.status -eq "active" } "aktivacia predplatneho"
      if ([string]$acc.company_id -ne $CompanyD) { Fail "Esblu: predplatne patri firme $($acc.company_id), ocakavana QA-STRIPE D." }
      $e = Find-StripeEvent "invoice.paid" $inv.id
      $S17Ctx.events["invoice.paid"] = [string]$e.id
      $row = Wait-BillingEvent $e.id 90
      if (-not $row) { Fail "Esblu DB: invoice.paid $(Get-ShortId $e.id) sa do 90 s nespracovala (okno 1 / stripe listen)." }
      if ($row.status -ne "processed") { Fail "Esblu DB: invoice.paid status=$($row.status) chyba=$($row.error_code)." }
      $al = @(Get-Rows "billing_ops_alerts?environment=eq.test&code=eq.WEBHOOK_API_VERSION_MISMATCH&select=occurrences,state,last_seen_at&order=last_seen_at.desc&limit=1")
      $after = $(if ($al.Count) { "$($al[0].last_seen_at)|$($al[0].occurrences)" } else { "" })
      $d["test_clock"] = Get-ShortId $clock.id
      $d["customer"] = Get-ShortId $cus.id
      $d["subscription"] = Get-ShortId $sub.id
      $d["invoice"] = Get-ShortId $inv.id
      $d["amount_paid_minor"] = [long]$inv.amount_paid
      $d["stripe_subscription_status"] = [string]$s.status
      $d["esblu_account_status"] = [string]$acc.status
      $d["invoice_paid_event"] = Get-ShortId $e.id
      $d["invoice_paid_event_api_version"] = [string]$e.api_version
      $d["invoice_paid_event_status"] = [string]$row.status
      $d["webhook_version_alert_raised_during_test"] = ($after -ne "" -and $after -ne $S17Ctx.versionAlertBefore)
      Say17 "    Esblu: ucet active (QA-STRIPE D), invoice.paid $(Get-ShortId $e.id) processed; verzia udalosti $($e.api_version); ops alert verzie pocas testu: $($d['webhook_version_alert_raised_during_test'])"
    }

    Invoke-S17Step "4" "Uctovna kopia faktury (billing_invoice_documents + nemenny snapshot odberatela)" {
      param($d)
      $doc = Wait-Doc $S17Ctx.inv { param($r) $r.status -eq "paid" -and $r.company_id } 90
      if (-not $doc) {
        $last = @(Get-DocRows $S17Ctx.inv)
        if ($last.Count -eq 0) { Fail "Doklad $(Get-ShortId $S17Ctx.inv) v billing_invoice_documents chyba." }
        Fail "Doklad $(Get-ShortId $S17Ctx.inv): status=$($last[0].status) company_id=$($last[0].company_id) (ocakavane paid + QA-STRIPE D)."
      }
      $pay = Invoke-StripeApi "GET" "/invoice_payments" ([ordered]@{ invoice = $S17Ctx.inv; limit = 3 })
      $p0 = @($pay.data | ForEach-Object { $_ }) | Where-Object { $_.status -eq "paid" } | Select-Object -First 1
      $piStripe = ""
      if ($p0 -and $p0.payment) { $piStripe = [string]$p0.payment.payment_intent; if ($p0.payment.payment_intent.id) { $piStripe = [string]$p0.payment.payment_intent.id } }
      $S17Ctx.pi = $piStripe
      $bad = @()
      if ($doc.kind -ne "invoice") { $bad += "kind=$($doc.kind)" }
      if ($doc.status -ne "paid") { $bad += "status=$($doc.status)" }
      if ([string]$doc.company_id -ne $CompanyD) { $bad += "company_id iny ako QA-STRIPE D" }
      if ([string]$doc.provider_subscription_id -ne $S17Ctx.sub) { $bad += "provider_subscription_id" }
      if ([string]$doc.provider_customer_id -ne $S17Ctx.customer) { $bad += "provider_customer_id" }
      if ([string]$doc.currency -ne "EUR") { $bad += "currency=$($doc.currency)" }
      if ([long]$doc.total_minor -ne 1590 -or [long]$doc.amount_paid_minor -ne 1590) { $bad += "suma $($doc.total_minor)/$($doc.amount_paid_minor) (ocakavane 1590)" }
      if (-not $piStripe -or [string]$doc.payment_intent_id -ne $piStripe) { $bad += "payment_intent_id nesedi s /v1/invoice_payments" }
      $ps = ConvertTo-UtcDate $doc.service_period_start; $pe = ConvertTo-UtcDate $doc.service_period_end
      if ($ps -ne [DateTimeOffset]::FromUnixTimeSeconds($S17Ctx.period.start).UtcDateTime -or $pe -ne [DateTimeOffset]::FromUnixTimeSeconds($S17Ctx.period.end).UtcDateTime) { $bad += "obdobie sluzby nesedi so Stripe" }
      if (-not $doc.issued_at) { $bad += "issued_at chyba" }
      if (-not $doc.pdf_url) { $bad += "pdf_url chyba" }
      if ([string]$doc.customer_company_id -ne $CompanyD) { $bad += "snapshot customer_company_id" }
      if (-not ([string]$doc.customer_legal_name).Trim()) { $bad += "snapshot customer_legal_name prazdne" }
      if (-not $doc.customer_snapshot_at) { $bad += "snapshot customer_snapshot_at chyba" }
      if ([string]$doc.customer_snapshot_source -ne "company") { $bad += "snapshot_source=$($doc.customer_snapshot_source) (ocakavane company)" }
      $optional = [ordered]@{ ico = [bool]$doc.customer_ico; dic = [bool]$doc.customer_dic; ic_dph = [bool]$doc.customer_ic_dph; registration_id = [bool]$doc.customer_registration_id; address = [bool]$doc.customer_address; billing_country = [bool]$doc.customer_billing_country }
      $d["document"] = Get-ShortId $S17Ctx.inv
      $d["kind"] = [string]$doc.kind
      $d["status"] = [string]$doc.status
      $d["company_is_qa_d"] = ([string]$doc.company_id -eq $CompanyD)
      $d["subscription_matches"] = ([string]$doc.provider_subscription_id -eq $S17Ctx.sub)
      $d["payment_intent"] = Get-ShortId $piStripe
      $d["total_minor"] = [long]$doc.total_minor
      $d["service_period"] = "$(Utc $S17Ctx.period.start) -> $(Utc $S17Ctx.period.end)"
      $d["snapshot_source"] = [string]$doc.customer_snapshot_source
      $d["snapshot_required_fields"] = "customer_company_id, customer_legal_name, customer_snapshot_at: $(if ($bad | Where-Object { $_ -like 'snapshot*' }) { 'CHYBA' } else { 'vyplnene' })"
      $d["snapshot_optional_present"] = $optional
      $d["first_event"] = Get-ShortId ([string]$doc.first_event_id)
      Say17 "    doklad $(Get-ShortId $S17Ctx.inv): invoice/paid, firma QA-STRIPE D, predplatne OK, 1590 EUR centov, PI $(Get-ShortId $piStripe), snapshot=$($doc.customer_snapshot_source) (volitelne: $(($optional.GetEnumerator() | Where-Object { $_.Value } | ForEach-Object { $_.Key }) -join ','))"
      if ($bad.Count -gt 0) { Fail ("Uctovna kopia nesedi: " + ($bad -join "; ")) }
    }

    Invoke-S17Step "5" "Archiv PDF (lokalny cron billing-documents) + SHA-256 objektu v staging storage" {
      param($d)
      $runs = @()
      $doc = $null
      for ($i = 0; $i -lt 4; $i++) {
        $r = Invoke-LocalCron "billing-documents"
        $runs += [ordered]@{ configured = $r.configured; claimed = $r.claimed; archived = $r.archived; failed = $r.failed; code = $r.errorCode }
        Say17 "    billing-documents #$($i + 1): claimed=$($r.claimed) archived=$($r.archived) failed=$($r.failed) code=$($r.errorCode)"
        if (-not $r.configured) { Fail "Cron billing-documents nie je nakonfigurovany (okno 1)." }
        $doc = @(Get-DocRows $S17Ctx.inv)[0]
        if ($doc.pdf_sha256 -or $doc.pdf_archive_error) { break }
        Start-Sleep -Seconds 5
      }
      $d["cron_runs"] = $runs
      if (-not $doc.pdf_sha256) { Fail "PDF faktury nebolo archivovane (pokusy=$($doc.pdf_archive_attempts) chyba=$($doc.pdf_archive_error))." }
      $re = "^test/\d{4}/\d{2}/invoice/" + [regex]::Escape($S17Ctx.inv) + "\.pdf$"
      if ([string]$doc.pdf_storage_path -notmatch $re) { Fail "Neocakavana cesta archivu: $($doc.pdf_storage_path)." }
      $dl = Get-S17StorageSha ([string]$doc.pdf_storage_path)
      $d["pdf_storage_path"] = [string]$doc.pdf_storage_path
      $d["pdf_sha256_db"] = [string]$doc.pdf_sha256
      $d["pdf_sha256_storage"] = $dl.sha256
      $d["pdf_bytes"] = $dl.bytes
      $d["pdf_magic_ok"] = $dl.is_pdf
      Say17 "    $($doc.pdf_storage_path): $($dl.bytes) B, SHA-256 DB $(([string]$doc.pdf_sha256).Substring(0, 16))... / storage $($dl.sha256.Substring(0, 16))..."
      if (-not $dl.is_pdf) { Fail "Objekt v storage nie je PDF." }
      if ($dl.sha256 -ne [string]$doc.pdf_sha256) { Fail "SHA-256 objektu v storage != pdf_sha256 v DB." }
    }

    Invoke-S17Step "6" "Ciastocna refundacia dobropisom (credit note + refund) -> doklad, pozorovanie refundacie, predplatne active" {
      param($d)
      $cn = Invoke-StripeApi "POST" "/credit_notes" ([ordered]@{ invoice = $S17Ctx.inv; amount = 500; refund_amount = 500; reason = "order_change"; memo = "Esblu S17 QA ciastocna refundacia" }) "s17-cn1-$($S17Ctx.sub)"
      $S17Ctx.cn1 = [string]$cn.id
      if ($cn.status -ne "issued" -or [long]$cn.total -ne 500) { Fail "Stripe dobropis $(Get-ShortId $cn.id): status=$($cn.status) total=$($cn.total)." }
      $pi = $null
      for ($i = 0; $i -lt 20; $i++) {
        $pi = Invoke-StripeApi "GET" "/payment_intents/$($S17Ctx.pi)" ([ordered]@{ "expand[]" = "latest_charge" })
        if ([long]$pi.latest_charge.amount_refunded -eq 500) { break }
        Start-Sleep -Seconds 3
      }
      if ([long]$pi.latest_charge.amount_refunded -ne 500) { Fail "Stripe: platba nema refundovanych 5,00 EUR (amount_refunded=$($pi.latest_charge.amount_refunded))." }
      $S17Ctx.charge = [string]$pi.latest_charge.id
      Say17 "    Stripe: dobropis $(Get-ShortId $cn.id) 5,00 EUR s refundaciou; charge $(Get-ShortId $S17Ctx.charge) refundovane $(Format-Eur ([long]$pi.latest_charge.amount_refunded)) z $(Format-Eur ([long]$pi.latest_charge.amount))"
      $eCn = Find-StripeEvent "credit_note.created" $cn.id
      $eRf = Find-StripeEvent "charge.refunded" $S17Ctx.charge
      $S17Ctx.events["credit_note.created#1"] = [string]$eCn.id
      $S17Ctx.events["charge.refunded"] = [string]$eRf.id
      $via = $(if (Test-Path $NoListenFile) { "dotahovanie (-NoListen)" } else { "webhook (stripe listen)" })
      $rCn = Wait-BillingEvent $eCn.id 90
      $rRf = Wait-BillingEvent $eRf.id 30
      if (-not $rCn -or -not $rRf) {
        $via = "dotahovanie (webhook sa do 90 s nedorucil - skontroluj zoznam udalosti stripe listen v okne 1)"
        Invoke-S17Catchup | Out-Null
        $rCn = Wait-BillingEvent $eCn.id 30
        $rRf = Wait-BillingEvent $eRf.id 30
      }
      if (-not $rCn) { Fail "Esblu DB: credit_note.created $(Get-ShortId $eCn.id) sa nespracovala." }
      if (-not $rRf) { Fail "Esblu DB: charge.refunded $(Get-ShortId $eRf.id) sa nespracovala." }
      if ($rCn.status -notin @("processed", "ignored")) { Fail "credit_note.created status=$($rCn.status) chyba=$($rCn.error_code)." }
      if ($rRf.status -notin @("processed", "ignored")) { Fail "charge.refunded status=$($rRf.status) chyba=$($rRf.error_code)." }
      $doc = Wait-Doc $S17Ctx.cn1 { param($r) $r.related_invoice_id -and $r.company_id } 60
      if (-not $doc) { Fail "Doklad dobropisu $(Get-ShortId $S17Ctx.cn1) chyba alebo nema vazbu na fakturu / firmu." }
      $bad = @()
      if ($doc.kind -ne "credit_note") { $bad += "kind=$($doc.kind)" }
      if ([string]$doc.related_invoice_id -ne $S17Ctx.inv) { $bad += "related_invoice_id nesedi" }
      if ([string]$doc.company_id -ne $CompanyD) { $bad += "company_id iny ako QA-STRIPE D" }
      if ([string]$doc.status -ne "issued") { $bad += "status=$($doc.status)" }
      if ([long]$doc.total_minor -ne 500) { $bad += "total=$($doc.total_minor)" }
      if ([string]$doc.customer_company_id -ne $CompanyD -or -not $doc.customer_snapshot_at) { $bad += "snapshot odberatela chyba" }
      $obs = $null
      for ($i = 0; $i -lt 10; $i++) {
        $obs = @(Get-Rows "billing_refund_observations?environment=eq.test&payment_intent_id=eq.$($S17Ctx.pi)&select=amount_refunded_minor,currency,first_observed_at,last_observed_at")[0]
        if ($obs -and [long]$obs.amount_refunded_minor -eq 500) { break }
        Start-Sleep -Seconds 3
      }
      if (-not $obs -or [long]$obs.amount_refunded_minor -ne 500) { $bad += "pozorovanie refundacie (billing_refund_observations) chyba / suma $($obs.amount_refunded_minor)" }
      $s = Invoke-StripeApi "GET" "/subscriptions/$($S17Ctx.sub)"
      $acc = Get-EsbluAccount $S17Ctx.sub
      if ($s.status -ne "active") { $bad += "Stripe predplatne $($s.status)" }
      if (-not $acc -or $acc.status -ne "active") { $bad += "Esblu ucet $($acc.status)" }
      $ents = Get-ActiveSubEnts $CompanyD
      if ($ents -lt 1) { $bad += "firma bez ucinnych narokov po ciastocnej refundacii" }
      $d["credit_note"] = Get-ShortId $S17Ctx.cn1
      $d["credit_note_total_minor"] = [long]$doc.total_minor
      $d["related_invoice_matches"] = ([string]$doc.related_invoice_id -eq $S17Ctx.inv)
      $d["company_is_qa_d"] = ([string]$doc.company_id -eq $CompanyD)
      $d["snapshot_source"] = [string]$doc.customer_snapshot_source
      $d["credit_note_event"] = "$(Get-ShortId $eCn.id) $($rCn.status)"
      $d["charge_refunded_event"] = "$(Get-ShortId $eRf.id) $($rRf.status)"
      $d["delivered_via"] = $via
      $d["refund_observation_minor"] = $(if ($obs) { [long]$obs.amount_refunded_minor } else { $null })
      $d["stripe_subscription_status"] = [string]$s.status
      $d["esblu_account_status"] = $(if ($acc) { [string]$acc.status } else { "none" })
      $d["active_entitlements"] = $ents
      Say17 "    Esblu: dobropis -> doklad credit_note (vazba na fakturu, firma D, snapshot $($doc.customer_snapshot_source)); pozorovanie refundacie $($d['refund_observation_minor']); Stripe $($s.status), Esblu $($d['esblu_account_status']), narokov $ents; cez $via"
      if ($bad.Count -gt 0) { Fail ("Ciastocna refundacia: " + ($bad -join "; ")) }
    }

    Invoke-S17Step "7" "Zmeskana udalost (stripe listen zastaveny) -> dotahovanie spracuje presne raz, opakovanie bez zmeny" {
      param($d)
      $k = Stop-S17Listen
      $d["listen_processes_stopped"] = $k.killed
      if ($k.remaining -gt 0) { Fail "stripe listen sa nepodarilo zastavit ($($k.remaining) procesov bezi)." }
      Say17 "    stripe listen ZASTAVENY (okno 1: Esblu bezi dalej, webhooky sa uz nedorucuju)" "Yellow"
      $cn2 = Invoke-StripeApi "POST" "/credit_notes" ([ordered]@{ invoice = $S17Ctx.inv; amount = 100; out_of_band_amount = 100; reason = "order_change"; memo = "Esblu S17 QA zmeskana udalost" }) "s17-cn2-$($S17Ctx.sub)"
      $S17Ctx.cn2 = [string]$cn2.id
      $e2 = Find-StripeEvent "credit_note.created" $cn2.id
      $S17Ctx.events["credit_note.created#2"] = [string]$e2.id
      Say17 "    Stripe: dobropis $(Get-ShortId $cn2.id) 1,00 EUR (mimo Stripe, bez refundacie), udalost $(Get-ShortId $e2.id)"
      Start-Sleep -Seconds 20
      $pre = @(Get-BillingEventRows $e2.id)
      $preDoc = @(Get-DocRows $cn2.id)
      $d["arrived_without_listen"] = ($pre.Count + $preDoc.Count)
      if ($pre.Count -ne 0 -or $preDoc.Count -ne 0) { Fail "Udalost/doklad dorazili aj bez stripe listen (listen stale bezi?)." }
      Say17 "    po 20 s: udalost v Esblu 0, doklad 0 (nedorucene - OK)"
      $r1 = Invoke-S17Catchup
      $row = $null
      for ($i = 0; $i -lt 10; $i++) {
        $rows = @(Get-BillingEventRows $e2.id)
        if ($rows.Count -ge 1 -and $rows[0].status -ne "received") { $row = $rows[0]; break }
        Start-Sleep -Seconds 3
        $r1 = Invoke-S17Catchup
      }
      if (-not $row) { Fail "Dotahovanie udalost $(Get-ShortId $e2.id) nespracovalo." }
      if ($row.status -notin @("processed", "ignored")) { Fail "Dotiahnuta udalost status=$($row.status) chyba=$($row.error_code)." }
      $doc2 = Wait-Doc $S17Ctx.cn2 { param($r) $r.related_invoice_id -and $r.company_id } 30
      if (-not $doc2) { Fail "Doklad dobropisu $(Get-ShortId $S17Ctx.cn2) po dotahovani chyba." }
      if ([string]$doc2.related_invoice_id -ne $S17Ctx.inv -or [string]$doc2.company_id -ne $CompanyD -or [long]$doc2.total_minor -ne 100) { Fail "Doklad dobropisu #2 nesedi (vazba/firma/suma)." }
      $n1 = @(Get-BillingEventRows $e2.id).Count
      Say17 "    dotahovanie #1: result=$($r1.result) processed=$($r1.processed) outcomes=$(($r1.outcomes | ConvertTo-Json -Compress)); udalost $($row.status), riadkov $n1; doklad cn #2 OK"
      $r2 = Invoke-S17Catchup
      $rows2 = @(Get-BillingEventRows $e2.id)
      $doc2b = @(Get-DocRows $S17Ctx.cn2)
      $applied2 = 0
      if ($r2.outcomes -and $r2.outcomes.applied) { $applied2 = [int]$r2.outcomes.applied }
      Say17 "    dotahovanie #2: result=$($r2.result) processed=$($r2.processed) outcomes=$(($r2.outcomes | ConvertTo-Json -Compress)); riadkov udalosti $($rows2.Count), dokladov $($doc2b.Count)"
      $d["missed_event"] = Get-ShortId $e2.id
      $d["catchup_1"] = [ordered]@{ result = $r1.result; processed = $r1.processed; outcomes = $r1.outcomes }
      $d["event_status"] = [string]$row.status
      $d["event_rows_after_1"] = $n1
      $d["catchup_2"] = [ordered]@{ result = $r2.result; processed = $r2.processed; outcomes = $r2.outcomes }
      $d["event_rows_after_2"] = $rows2.Count
      $d["doc_rows_after_2"] = $doc2b.Count
      $d["credit_note_2"] = Get-ShortId $S17Ctx.cn2
      $d["listen_state_after"] = "ZASTAVENY - pre dalsie webhooky restartuj okno 1"
      if ($n1 -ne 1 -or $rows2.Count -ne 1) { Fail "Udalost nie je zapisana presne raz ($n1 / $($rows2.Count))." }
      if ($doc2b.Count -ne 1) { Fail "Doklad dobropisu #2 nie je presne 1x." }
      if ("$($rows2[0].processed_at)" -ne "$($row.processed_at)" -or "$($doc2b[0].updated_at)" -ne "$($doc2.updated_at)") { Fail "Opakovane dotahovanie zmenilo spracovanu udalost alebo doklad." }
      if ($applied2 -gt 0) { $d["note"] = "druhy beh aplikoval $applied2 inych (novych) udalosti - nie S17 udalost" }
      Say17 "    stripe listen ostava ZASTAVENY. Esblu v okne 1 bezi; webhooky obnovis restartom okna 1 (Ctrl+C a -Step start)." "Yellow"
    }

    Invoke-S17Step "8" "Mesacny uctovny export bez prihlasenia (kod aplikacie, pripnuta verzia) -> CSV lokalne + suhrn" {
      param($d)
      $m = $Month
      if (-not $m) { $m = [DateTime]::UtcNow.ToString("yyyy-MM") }
      if ($m -notmatch '^\d{4}-(0[1-9]|1[0-2])$') { Fail "Neplatny -Month $m (YYYY-MM)." }
      $outDir = Join-Path $env:USERPROFILE "esblu-backups\s17"
      if ($outDir -match "(?i)onedrive") { Fail "Priecinok CSV $outDir je v OneDrive - odmietnute." }
      New-Item -ItemType Directory -Force -Path $outDir | Out-Null
      Get-ServiceRole | Out-Null
      $env:S17_SUPABASE_URL = $StagingUrl
      $lines = @()
      $code = $null
      Push-Location $RepoRoot
      try {
        $ErrorActionPreference = "Continue"
        $lines = @(& node --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs scripts/s17-accounting-export.ts --month $m --out-dir $outDir --invoice $S17Ctx.inv --payment-intent $S17Ctx.pi 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = "Stop"
        Pop-Location
        Remove-Item Env:S17_SUPABASE_URL -ErrorAction SilentlyContinue
      }
      $resLine = $lines | Where-Object { $_ -like "S17_RESULT *" } | Select-Object -Last 1
      if (-not $resLine) { Fail "Helper exportu nevratil vysledok (exit $code): $(($lines | Select-Object -Last 5) -join ' | ')" }
      $res = $resLine.Substring(11) | ConvertFrom-Json
      if (-not $res.ok) { Fail "Export zlyhal: $($res.code) (exit $code)." }
      $S17Ctx.export = $res
      $d["month"] = $res.month
      $d["api_version"] = $res.api_version
      $d["ledger_import"] = $res.import
      $d["ledger"] = $res.ledger
      if ($res.ledger -eq "PERMISSION_DENIED") { Say17 "    INFO: import balance transactions = 403 (opravnenie kluca sandboxu) - export dokladov pokracuje, poplatok/net v S17-9 = LIMITATION" "Yellow" }
      $d["rows"] = $res.rows
      $d["rows_by_type"] = $res.rows_by_type
      $d["totals_minor"] = $res.totals_minor
      $d["payouts"] = $res.payouts
      $d["csv_location"] = "%USERPROFILE%\esblu-backups\s17\" + [string]$res.csv_file
      $d["csv_sha256"] = $res.csv_sha256
      $d["csv_bytes"] = $res.csv_bytes
      $d["invoice_row_found"] = [bool]$res.invoice.found
      $d["credit_note_rows_for_invoice"] = @($res.credit_notes).Count
      $d["content"] = "iba synteticke QA data stagingu (firma QA-STRIPE D)"
      Say17 "    export $($res.month): $($res.rows) riadkov $(($res.rows_by_type | ConvertTo-Json -Compress)); BT spolu gross=$($res.totals_minor.gross) fee=$($res.totals_minor.fee) net=$($res.totals_minor.net) refundacie=$($res.totals_minor.refunds) (centy); vyplaty: $($res.payouts.present)"
      Say17 "    CSV: %USERPROFILE%\esblu-backups\s17\$($res.csv_file) (SHA-256 $(([string]$res.csv_sha256).Substring(0, 16))...)"
      if ($res.api_version -ne $S17Ctx.pinned) { Fail "Export nepouzil pripnutu verziu ($($res.api_version))." }
      if ($res.import.truncated) { Fail "Import balance transactions bol orezany (truncated)." }
      if (-not $res.invoice.found) { Fail "Faktura S17 v exporte mesiaca $($res.month) chyba." }
      if (@($res.credit_notes).Count -lt 2) { Fail "V exporte chybaju dobropisy S17 (najdene $(@($res.credit_notes).Count), ocakavane 2)." }
    }

    Invoke-S17Step "9" "Poplatok / cista suma: export vs. Stripe balance transaction platby" {
      param($d)
      if ($S17Ctx.export.ledger -eq "PERMISSION_DENIED" -or $env:S17_LEDGER_ACCESS -eq "permission_denied") {
        $d["_status"] = "LIMITATION"
        $d["reason"] = "kluc sandboxu (CLI kluc claimable sandboxu) nema pravo Balance transactions: read (Stripe 403) - poplatok, cista suma a vyplaty sa v sandboxe overit nedaju"
        $d["consequence"] = "hruba suma dokladov (faktura, dobropis) je overena v S17-4/6/8; poplatok/net/payout overuju iba DB testy (test:billing-ops-db); pred LIVE: overit s restricted reporting klucom (Balance transactions read + Payouts read) pri prvej internej platbe"
        Say17 "    LIMITATION: $($d['reason'])" "Yellow"
        $S17Ctx.payoutPresent = $false
        return
      }
      $pi = Invoke-StripeApi "GET" "/payment_intents/$($S17Ctx.pi)" ([ordered]@{ "expand[]" = "latest_charge.balance_transaction" })
      $bt = $pi.latest_charge.balance_transaction
      if (-not $bt -or -not $bt.id) { Fail "Stripe: platba nema balance transaction." }
      $g = [long]$bt.amount; $f = [long]$bt.fee; $n = [long]$bt.net
      $x = $S17Ctx.export.invoice
      $rf = Invoke-StripeApi "GET" "/refunds" ([ordered]@{ charge = $S17Ctx.charge; limit = 10; "expand[]" = "data.balance_transaction" })
      $refundSum = 0
      foreach ($r in @($rf.data | ForEach-Object { $_ })) { if ($r.balance_transaction -and $r.balance_transaction.id) { $refundSum += [long]$r.balance_transaction.amount } }
      $cn1 = @($S17Ctx.export.credit_notes) | Where-Object { $_.id -eq $S17Ctx.cn1 } | Select-Object -First 1
      $d["stripe_balance_transaction"] = Get-ShortId ([string]$bt.id)
      $d["stripe_minor"] = [ordered]@{ gross = $g; fee = $f; net = $n; currency = ([string]$bt.currency).ToUpper(); status = [string]$bt.status }
      $d["export_minor"] = [ordered]@{ gross = $x.gross_minor; fee = $x.fee_minor; net = $x.net_minor }
      $d["export_bt_linked"] = (@($x.bt_ids) -contains [string]$bt.id)
      $d["stripe_refund_bt_minor"] = $refundSum
      $d["export_credit_note_gross_minor"] = $(if ($cn1) { $cn1.gross_minor } else { $null })
      Say17 "    Stripe BT $(Get-ShortId ([string]$bt.id)): gross=$g fee=$f net=$n ($($bt.status)); export: gross=$($x.gross_minor) fee=$($x.fee_minor) net=$($x.net_minor); refund BT=$refundSum, export dobropis=$($d['export_credit_note_gross_minor'])"
      $bad = @()
      if ($f -le 0) { $bad += "Stripe poplatok nie je > 0" }
      if ($n -ne ($g - $f)) { $bad += "net != gross - fee v Stripe" }
      if ($null -eq $x.gross_minor -or [long]$x.gross_minor -ne $g -or [long]$x.fee_minor -ne $f -or [long]$x.net_minor -ne $n) { $bad += "export gross/fee/net != Stripe" }
      if (-not $d["export_bt_linked"]) { $bad += "export neobsahuje BT platby" }
      if (-not $cn1 -or $null -eq $cn1.gross_minor -or [long]$cn1.gross_minor -ne $refundSum) { $bad += "export dobropisu (refund BT) != Stripe refund BT" }
      if ($bad.Count -gt 0) { Fail ($bad -join "; ") }
      $S17Ctx.payoutPresent = ((@($x.payout_ids).Count -gt 0) -or [bool]$S17Ctx.export.payouts.present)
    }
    $pd = [ordered]@{ export_payout_ids_for_invoice = @($S17Ctx.export.invoice.payout_ids).Count; export_payouts_distinct = $S17Ctx.export.payouts.distinct }
    if ($S17Ctx.payoutPresent) {
      $pd["note"] = "vyplata naviazana (ID iba v CSV)"
      Add-S17Result "9b" "Vyplata (payout) naviazana na platbu" "INFO" $pd
    } else {
      $pd["note"] = "sandbox zvycajne nevytvara vyplaty (alebo az po dnoch) - vazba BT -> payout overena iba DB testami (test:billing-ops-db), nie skutocnym Stripe"
      Add-S17Result "9b" "Vyplata (payout) - v sandboxe nie je" "LIMITATION" $pd
    }

    # ------------------------------------------------------------------- S17-12..14 (2026-11-20): doklady pri obnove,
    # zlyhanej platbe s opakovanim a uplnej refundacii dobropisom. Vsetko na Test Clock zakaznika S17 (ziadne nove ucty).
    Invoke-S17Step "12" "Obnovenie predplatneho (Test Clock) -> nova faktura, doklad, cislovanie, obdobie" {
      param($d)
      $clockId = [string]$S17Ctx.state.clock
      $to = [long]$S17Ctx.period.end + 3600
      Invoke-StripeApi "POST" "/test_helpers/test_clocks/$clockId/advance" ([ordered]@{ frozen_time = $to }) | Out-Null
      for ($i = 0; $i -lt 60; $i++) { $c = Invoke-StripeApi "GET" "/test_helpers/test_clocks/$clockId"; if ($c.status -eq "ready") { break }; if ($c.status -eq "internal_failure") { Fail "Test Clock internal_failure" }; Start-Sleep -Seconds 2 }
      $inv2 = $null
      for ($i = 0; $i -lt 40; $i++) {
        $list = Invoke-StripeApi "GET" "/invoices" ([ordered]@{ subscription = $S17Ctx.sub; limit = 5 })
        $inv2 = @($list.data | Where-Object { $_.id -ne $S17Ctx.inv -and $_.billing_reason -eq "subscription_cycle" } | Select-Object -First 1)[0]
        if ($inv2 -and $inv2.status -eq "paid") { break }
        Start-Sleep -Seconds 3
      }
      if (-not $inv2 -or $inv2.status -ne "paid") { Fail "Stripe: faktura obnovy nie je zaplatena (stav=$($inv2.status))." }
      $S17Ctx.inv2 = [string]$inv2.id
      $inv1 = Invoke-StripeApi "GET" "/invoices/$($S17Ctx.inv)"
      $e = Find-StripeEvent "invoice.paid" $inv2.id
      $S17Ctx.events["invoice.paid#renewal"] = [string]$e.id
      $row = Wait-BillingEvent $e.id 90
      if (-not $row -or $row.status -ne "processed") { Fail "Esblu DB: invoice.paid obnovy $(Get-ShortId $e.id) status=$($row.status)." }
      $doc = Wait-Doc $S17Ctx.inv2 { param($r) $r.status -eq "paid" -and $r.customer_snapshot_at } 90
      if (-not $doc) { Fail "Doklad faktury obnovy chyba alebo nie je zaplateny." }
      $bad = @()
      $p1 = [regex]::Match([string]$inv1.number, '^(.*)-(\d+)$'); $p2 = [regex]::Match([string]$inv2.number, '^(.*)-(\d+)$')
      if (-not $p1.Success -or -not $p2.Success) { $bad += "cislo faktury nema tvar PREFIX-NNNN" }
      elseif ($p1.Groups[1].Value -ne $p2.Groups[1].Value) { $d["numbering"] = "customer-level (rozne prefixy) - v SK/EU sa ocakava account-level, nastavenie Dashboardu" }
      elseif ([long]$p2.Groups[2].Value -le [long]$p1.Groups[2].Value) { $bad += "cislo faktury obnovy nie je vyssie" }
      else { $d["numbering"] = "account-level, rastuce" }
      $line = @($inv2.lines.data | ForEach-Object { $_ }) | Where-Object { $_.period } | Select-Object -First 1
      if ([long]$line.period.start -ne [long]$S17Ctx.period.end) { $bad += "obdobie obnovy nenadvazuje" }
      $ps = ConvertTo-UtcDate $doc.service_period_start
      if ($ps -ne [DateTimeOffset]::FromUnixTimeSeconds([long]$line.period.start).UtcDateTime) { $bad += "obdobie dokladu != Stripe" }
      if ([long]$doc.total_minor -ne [long]$inv2.total -or [string]$doc.currency -notmatch '^(?i)eur$') { $bad += "suma/mena dokladu" }
      if ([string]$doc.company_id -ne $CompanyD) { $bad += "doklad inej firme" }
      $periodEnd = [DateTimeOffset]::FromUnixTimeSeconds([long]$line.period.end).UtcDateTime.AddMinutes(-5)
      $acc = Wait-Esblu $S17Ctx.sub { param($a) $a.status -eq "active" -and (ConvertTo-UtcDate $a.current_period_end) -ge $periodEnd } "posun obdobia po obnove"
      $S17Ctx.period2 = @{ start = [long]$line.period.start; end = [long]$line.period.end }
      $d["renewal_invoice"] = Get-ShortId $S17Ctx.inv2
      $d["renewal_period"] = "$(Utc $line.period.start) -> $(Utc $line.period.end)"
      $d["invoice_numbers_prefix_equal"] = ($p1.Groups[1].Value -eq $p2.Groups[1].Value)
      $d["doc_total_minor"] = [long]$doc.total_minor
      $d["tax_lines"] = @($inv2.total_taxes | Where-Object { $_ }).Count
      $d["esblu_status"] = [string]$acc.status
      Say17 "    obnova: faktura $(Get-ShortId $S17Ctx.inv2) zaplatena, doklad OK, obdobie $($d['renewal_period']), cislovanie $($d['numbering'])"
      if ($bad.Count) { Fail ($bad -join "; ") }
    }

    Invoke-S17Step "13" "Zlyhana platba pri obnove -> past_due, doklad otvoreny; opakovanie platby -> paid, 1 doklad" {
      param($d)
      $tag = "s17-fail-" + $S17Ctx.sub
      $badPm = Invoke-StripeApi "POST" "/payment_methods/pm_card_chargeCustomerFail/attach" ([ordered]@{ customer = $S17Ctx.state.customer }) "$tag-pm"
      Invoke-StripeApi "POST" "/subscriptions/$($S17Ctx.sub)" ([ordered]@{ default_payment_method = $badPm.id }) "$tag-sub" | Out-Null
      $clockId = [string]$S17Ctx.state.clock
      Invoke-StripeApi "POST" "/test_helpers/test_clocks/$clockId/advance" ([ordered]@{ frozen_time = [long]$S17Ctx.period2.end + 3600 }) | Out-Null
      for ($i = 0; $i -lt 60; $i++) { $c = Invoke-StripeApi "GET" "/test_helpers/test_clocks/$clockId"; if ($c.status -eq "ready") { break }; Start-Sleep -Seconds 2 }
      $inv3 = $null
      for ($i = 0; $i -lt 40; $i++) {
        $list = Invoke-StripeApi "GET" "/invoices" ([ordered]@{ subscription = $S17Ctx.sub; limit = 5 })
        $inv3 = @($list.data | Where-Object { $_.id -ne $S17Ctx.inv -and $_.id -ne $S17Ctx.inv2 -and $_.billing_reason -eq "subscription_cycle" } | Select-Object -First 1)[0]
        if ($inv3 -and $inv3.status -eq "open" -and [int]$inv3.attempt_count -ge 1) { break }
        Start-Sleep -Seconds 3
      }
      if (-not $inv3 -or $inv3.status -ne "open") { Fail "Stripe: faktura so zlyhanou platbou nie je open (stav=$($inv3.status))." }
      $S17Ctx.inv3 = [string]$inv3.id
      $ef = Find-StripeEvent "invoice.payment_failed" $inv3.id
      $S17Ctx.events["invoice.payment_failed"] = [string]$ef.id
      $rf = Wait-BillingEvent $ef.id 90
      if (-not $rf -or $rf.status -notin @("processed", "ignored")) { Fail "Esblu DB: invoice.payment_failed status=$($rf.status)." }
      $acc = Wait-Esblu $S17Ctx.sub { param($a) $a.status -in @("past_due", "grace_period", "unpaid") } "stav po zlyhanej platbe"
      $d["after_failure_status"] = [string]$acc.status
      $d["after_failure_entitlements"] = Get-ActiveSubEnts $CompanyD
      $docOpen = Wait-Doc $S17Ctx.inv3 { param($r) $r.status -eq "open" } 60
      $d["doc_status_after_failure"] = $(if ($docOpen) { "open" } else { "chyba" })
      # Opakovanie: platna karta + POST /invoices/{id}/pay (ako Smart Retry / zakaznik v portali)
      Invoke-StripeApi "POST" "/subscriptions/$($S17Ctx.sub)" ([ordered]@{ default_payment_method = $S17Ctx.pmOk }) "$tag-sub-ok" | Out-Null
      $paid = Invoke-StripeApi "POST" "/invoices/$($S17Ctx.inv3)/pay" ([ordered]@{ payment_method = $S17Ctx.pmOk }) "$tag-pay"
      if ($paid.status -ne "paid") { Fail "Stripe: opakovana platba nepresla (stav=$($paid.status))." }
      $ep = Find-StripeEvent "invoice.paid" $S17Ctx.inv3
      $S17Ctx.events["invoice.paid#retry"] = [string]$ep.id
      $rp = Wait-BillingEvent $ep.id 90
      if (-not $rp -or $rp.status -ne "processed") { Fail "Esblu DB: invoice.paid po opakovani status=$($rp.status)." }
      $acc2 = Wait-Esblu $S17Ctx.sub { param($a) $a.status -eq "active" } "aktivacia po opakovanej platbe"
      $doc = Wait-Doc $S17Ctx.inv3 { param($r) $r.status -eq "paid" } 60
      $rows = @(Get-DocRows $S17Ctx.inv3)
      $problems = @()
      if (-not $docOpen) { $problems += "doklad pred zaplatenim nebol open" }
      if (-not $doc) { $problems += "doklad po zaplateni nie je paid" }
      if ($rows.Count -ne 1) { $problems += "doklad faktury $($rows.Count)x" }
      if ($d["after_failure_entitlements"] -lt 1) { $problems += "naroky odobrate uz pri prvom zlyhani (ocakavana 7-dnova lehota)" }
      $d["failed_invoice"] = Get-ShortId $S17Ctx.inv3
      $d["final_status"] = [string]$acc2.status
      $d["document_rows"] = $rows.Count
      Say17 "    zlyhanie: Esblu $($d['after_failure_status']) (naroky $($d['after_failure_entitlements'])), doklad open; po opakovani Stripe paid, Esblu $($acc2.status), doklad 1x paid"
      if ($problems.Count) { Fail ($problems -join "; ") }
    }

    Invoke-S17Step "14" "Uplna refundacia aktualneho obdobia dobropisom -> credit note doklad, Esblu refunded, Stripe ukoncene" {
      param($d)
      $inv3 = Invoke-StripeApi "GET" "/invoices/$($S17Ctx.inv3)"
      $amount = [long]$inv3.amount_paid
      $cn = Invoke-StripeApi "POST" "/credit_notes" ([ordered]@{ invoice = $S17Ctx.inv3; amount = $amount; refund_amount = $amount; reason = "order_change"; memo = "Esblu S17 QA uplna refundacia" }) "s17-cn3-$($S17Ctx.sub)"
      $S17Ctx.cn3 = [string]$cn.id
      if ($cn.status -ne "issued" -or [long]$cn.total -ne $amount) { Fail "Stripe dobropis: status=$($cn.status) total=$($cn.total) (ocakavane $amount)." }
      $ecn = Find-StripeEvent "credit_note.created" $cn.id
      $S17Ctx.events["credit_note.created#3"] = [string]$ecn.id
      $rcn = Wait-BillingEvent $ecn.id 90
      if (-not $rcn -or $rcn.status -notin @("processed", "ignored")) { Fail "credit_note.created status=$($rcn.status)." }
      $doc = Wait-Doc $S17Ctx.cn3 { param($r) $r.related_invoice_id -and $r.company_id } 60
      $acc = Wait-Esblu $S17Ctx.sub { param($a) $a.status -in @("refunded", "canceled") } "ukoncenie po uplnej refundacii"
      $s = $null
      for ($i = 0; $i -lt 20; $i++) { $s = Invoke-StripeApi "GET" "/subscriptions/$($S17Ctx.sub)"; if ($s.status -eq "canceled") { break }; if (Test-Path $NoListenFile) { Invoke-S17Catchup | Out-Null }; Start-Sleep -Seconds 3 }
      $ents = Get-ActiveSubEnts $CompanyD
      $problems = @()
      if (-not $doc) { $problems += "doklad dobropisu chyba" }
      elseif ([string]$doc.kind -ne "credit_note" -or [long]$doc.total_minor -ne $amount -or [string]$doc.related_invoice_id -ne $S17Ctx.inv3) { $problems += "doklad dobropisu nesedi (druh/suma/vazba)" }
      if ($acc.status -ne "refunded") { $problems += "Esblu stav $($acc.status) (ocakavane refunded)" }
      if ($s.status -ne "canceled") { $problems += "Stripe predplatne $($s.status) (ocakavane canceled - inak by sa dalej uctovalo)" }
      if ($ents -ne 0) { $problems += "firma ma $ents ucinnych narokov po uplnej refundacii" }
      $d["credit_note"] = Get-ShortId $S17Ctx.cn3
      $d["refunded_minor"] = $amount
      $d["esblu_status"] = [string]$acc.status
      $d["stripe_subscription_status"] = [string]$s.status
      $d["active_entitlements"] = $ents
      Say17 "    uplna refundacia: dobropis $(Get-ShortId $S17Ctx.cn3) $(Format-Eur $amount), Esblu $($acc.status), Stripe $($s.status), naroky $ents"
      if ($problems.Count) { Fail ($problems -join "; ") }
    }

    Invoke-S17Step "10" "Izolacia a duplicity (1 doklad / Stripe doklad, 1 udalost / Stripe udalost, iba firma QA-STRIPE D)" {
      param($d)
      $cus = $S17Ctx.state.customer
      $docs = @(Get-Rows "billing_invoice_documents?provider=eq.stripe&environment=eq.test&provider_customer_id=eq.$cus&select=provider_document_id,kind,company_id,customer_company_id")
      $dupDocs = @($docs | Group-Object provider_document_id | Where-Object { $_.Count -gt 1 })
      $foreign = @($docs | Where-Object { [string]$_.company_id -ne $CompanyD -or [string]$_.customer_company_id -ne $CompanyD })
      $bad = @()
      foreach ($id in @(@($S17Ctx.inv, $S17Ctx.cn1, $S17Ctx.cn2, $S17Ctx.inv2, $S17Ctx.inv3, $S17Ctx.cn3) | Where-Object { $_ })) {
        $c = @($docs | Where-Object { $_.provider_document_id -eq $id }).Count
        if ($c -ne 1) { $bad += "doklad $(Get-ShortId $id): $c riadkov" }
      }
      $dDocs = @(Get-Rows "billing_invoice_documents?provider=eq.stripe&environment=eq.test&company_id=eq.$CompanyD&created_at=gte.$($S17Ctx.t0)&select=provider_document_id,provider_customer_id")
      $otherCus = @($dDocs | Where-Object { [string]$_.provider_customer_id -ne $cus })
      $evRes = [ordered]@{}
      foreach ($kv in $S17Ctx.events.GetEnumerator()) {
        $rows = @(Get-BillingEventRows $kv.Value)
        $evRes[$kv.Key] = $rows.Count
        if ($rows.Count -ne 1) { $bad += "udalost $($kv.Key): $($rows.Count) riadkov" }
        foreach ($r in $rows) { if ($r.company_id -and [string]$r.company_id -ne $CompanyD) { $bad += "udalost $($kv.Key) patri inej firme" } }
      }
      $recent = @(Get-Rows "billing_events?provider=eq.stripe&environment=eq.test&received_at=gte.$($S17Ctx.t0)&select=provider_event_id,company_id")
      $dupEv = @($recent | Group-Object provider_event_id | Where-Object { $_.Count -gt 1 })
      $foreignEv = @($recent | Where-Object { $_.company_id -and [string]$_.company_id -ne $CompanyD })
      if ($dupDocs.Count) { $bad += "duplicitne doklady: $($dupDocs.Count)" }
      if ($foreign.Count) { $bad += "doklady zakaznika S17 s inou firmou: $($foreign.Count)" }
      if ($otherCus.Count) { $bad += "nove doklady firmy D od ineho zakaznika: $($otherCus.Count)" }
      if ($dupEv.Count) { $bad += "duplicitne udalosti od zaciatku S17: $($dupEv.Count)" }
      $d["documents_for_s17_customer"] = $docs.Count
      $d["duplicate_documents"] = $dupDocs.Count
      $d["documents_other_company"] = $foreign.Count
      $d["new_company_d_documents_other_customer"] = $otherCus.Count
      $d["s17_event_rows"] = $evRes
      $d["events_since_start"] = $recent.Count
      $d["duplicate_events_since_start"] = $dupEv.Count
      $d["events_since_start_other_company"] = $foreignEv.Count
      Say17 "    doklady zakaznika S17: $($docs.Count) (duplicity $($dupDocs.Count), ina firma $($foreign.Count)); udalosti S17 $(($evRes | ConvertTo-Json -Compress)); od zaciatku $($recent.Count) udalosti, duplicity $($dupEv.Count), inej firmy $($foreignEv.Count)"
      if ($foreignEv.Count) { $d["note"] = "udalosti inych firiem od zaciatku S17 (napr. QA E) - mimo S17, iba informacia" }
      if ($bad.Count -gt 0) { Fail ($bad -join "; ") }
    }
  } catch {
    $failed = $true
    Say17 "S17 prerusene: $($_.Exception.Message)" "Red"
  } finally {
    $rd = $null
    try {
      Say17 ""
      Say17 "=== S17-11 Obnova stagingu (billing OFF, ceny neaktivne, QA predplatne ukoncene; dokazy ostavaju) ==="
      $rd = Restore-S17Staging $S17Ctx.state
      $status = "PASS"
      if ($rd.Contains("errors")) { $status = "FAIL"; $failed = $true }
      Add-S17Result "11" "Obnova stagingu" $status $rd
    } catch {
      $failed = $true
      $ed = [ordered]@{ error = (Hide-S17 $_.Exception.Message) }
      Add-S17Result "11" "Obnova stagingu" "FAIL" $ed
    }
    $fails = @($S17Steps | Where-Object { $_.status -eq "FAIL" }).Count
    $lims = @($S17Steps | Where-Object { $_.status -eq "LIMITATION" }).Count
    $S17Evidence["overall"] = $(if ($failed -or $fails -gt 0) { "FAIL" } else { "PASS" })
    $S17Evidence["limitations"] = $lims
    $S17Evidence["finished_at"] = Get-UtcIso
    Save-S17Evidence
    Say17 ""
    Say17 "=================================================================="
    foreach ($s in $S17Steps) { Say17 ("  S17-{0,-3} {1,-11} {2}" -f $s.step, $s.status, $s.name) }
    Say17 ("S17 celkovo: {0} (LIMITATION: {1})" -f $S17Evidence["overall"], $lims) $(if ($S17Evidence["overall"] -eq "PASS") { "Green" } else { "Red" })
    Say17 "Dokazy: $($S17Ctx.evidenceFile)"
    Say17 "stripe listen: $(if (Test-S17ListenAlive) { 'bezi' } else { 'ZASTAVENY (restart okna 1 pre webhooky)' }); Test Clock ostava pre audit -> -Step s17-cleanup ho zmaze."
    Say17 "=================================================================="
  }
  if ($failed -or $S17Evidence["overall"] -ne "PASS") { exit 1 }
}

function Invoke-S17Cleanup {
  if (-not (Test-Path $S17StateFile)) { Say17 "Ziadny stav S17 ($S17StateFile) - nie je co upratat."; return }
  $st = Get-Content $S17StateFile -Raw | ConvertFrom-Json
  $S17Ctx.pinned = Get-S17PinnedVersion
  $S17Ctx.state = $st
  $null = Assert-StagingAccess   # READ-ONLY pred obnovou stagingu
  Say17 "S17 cleanup: predplatne $(Get-ShortId ([string]$st.subscription)), staging konfiguracia (enabled=$($st.enabled) restored=$($st.restored)), Test Clocks $(@(@($st.clocks) | Where-Object { $_ }).Count)"
  $d = Restore-S17Staging $st
  $deleted = @()
  # Pri chybe obnovy sa Test Clocks NEMAZU (zmazanie odstrani aj predplatne -> opakovany cleanup by nemal co overit).
  $clocksToDelete = $(if ($d.Contains("errors")) { @() } else { @(@($st.clocks) | Where-Object { $_ }) })
  foreach ($c in $clocksToDelete) {
    try {
      Invoke-StripeApi "DELETE" "/test_helpers/test_clocks/$c" | Out-Null
      $deleted += (Get-ShortId $c)
    } catch {
      if ($_.Exception.Message -match "HTTP 404") { $deleted += ((Get-ShortId $c) + " (uz neexistoval)") } else { throw }
    }
  }
  $d["test_clocks_deleted"] = $deleted
  Say17 "    Test Clocks zmazane: $($deleted -join ', ')"
  $ev = Get-S17EvidenceFile
  if (Test-Path $ev) {
    $j = Get-Content $ev -Raw | ConvertFrom-Json
    $j | Add-Member -NotePropertyName cleanup -NotePropertyValue ([ordered]@{ at = (Get-UtcIso); result = $d }) -Force
    Set-Content -Path $ev -Value (Hide-S17 ($j | ConvertTo-Json -Depth 12)) -Encoding UTF8
  }
  if ($d.Contains("errors")) { Fail ("S17 cleanup neuplny: " + ($d["errors"] -join "; ")) }
  Remove-Item $S17StateFile -Force
  Say17 "OK: S17 upratane (staging billing vrateny, predplatne ukoncene, Test Clocks zmazane; dokazy v DB ostavaju)." "Green"
}

# ----------------------------------------------------------------------------- scenare (okno 2)
function Assert-HarnessCheckout {
  # 2026-11-20: worktree s pokazenymi git metadatami ("fatal: not a git repository") + PowerShell ';' pokracoval
  # po zlyhanom `git checkout` -> bezala STARA verzia skriptu. Kazdy S17 krok preto overi, ze (1) priecinok je funkcny
  # git checkout a (2) bezi presne commit vetvy ops/s17-sandbox (inak STOP; -Force iba vedome).
  $r = Invoke-Git @("rev-parse", "--is-inside-work-tree")
  if ($r.code -ne 0 -or $r.out -ne "true") { Fail "Priecinok $RepoRoot nie je funkcny git checkout (git: $($r.out)). Oprava worktree: docs par. 8.14i." }
  $h = Invoke-Git @("rev-parse", "HEAD")
  $t = Invoke-Git @("rev-parse", "--verify", "--quiet", "refs/heads/ops/s17-sandbox")
  if ($h.code -ne 0) { Fail "git rev-parse HEAD zlyhal ($($h.out))." }
  if ($t.code -ne 0) { Fail "Vetva ops/s17-sandbox v repozitari chyba." }
  if ($h.out -ne $t.out) {
    if (-not $Force) { Fail "Skript bezi z commitu $($h.out.Substring(0, 7)), vetva ops/s17-sandbox je $($t.out.Substring(0, 7)) - najprv: git checkout --detach ops/s17-sandbox (a over vysledok)." }
    Say "POZOR -Force: skript bezi z $($h.out.Substring(0, 7)) namiesto ops/s17-sandbox $($t.out.Substring(0, 7))."
  }
  return $h.out
}
if (@("start", "s17-preflight", "s17-auto", "s17", "s17-cleanup") -contains $Step) {
  $HarnessHead = Assert-HarnessCheckout
  Say "Harness: commit $($HarnessHead.Substring(0, 7)) = ops/s17-sandbox (git OK)"
}

if ($Step -eq "mark-exposed") {
  # Bez platieb a bez vypisu tajomstva: overi Stripe CLI a ulozi SHA-256 aktualneho whsec_ profilu '$Project'
  # medzi kompromitovane -> -Step start s tymto profilom sa uz nespusti (treba novy sandbox: -Step new-sandbox).
  Say "Stripe CLI: $($StripeCliBase -join ' ')"
  $ver = Invoke-StripeRaw $StripeCliBase @("version")
  Say "    verzia: $((($ver -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1))"
  Get-StripeTestKey | Out-Null
  $w = Get-ListenSecret $StripeCli
  if (-not $w) { Fail "Profil '$Project': whsec_ sa nepodarilo ziskat (diagnostika vyssie)." }
  $h = Get-Sha256 $w
  Add-ExposedHash $h
  Say "OK: whsec_*** profilu '$Project' (SHA-256 $($h.Substring(0,8))...) je oznaceny ako kompromitovany; evidovane odtlacky: $(@(Get-ExposedHashes).Count)."
  Say "    Dalej: novy sandbox v samostatnom profile, napr. -Step new-sandbox -Project esblu-qa3 -Email <adresa> (az po schvaleni)."
  exit 0
}

if ($Step -eq "s17-auto" -or $Step -eq "s17-preflight") {
  # s17-preflight = IBA CITANIE (git, Stripe kluc/ucet/opravnenia vratane sondy zapisu bez vytvorenia objektu,
  # staging konfiguracia, kurzor, ceny). Ziadny zapis do Stripe ani stagingu, Esblu sa nespusta.
  # JEDEN prikaz: (a) existujuci sandbox s cenou (nove sa nezakladaju), (b) okno 1 v novom okne, (c) S17, (d) upratanie, (e) stop okna 1.
  # Tajomstva sa zadaju raz (skryta vyzva) a podprocesy ich zdedia iba cez premenne tohto procesu.
  $self = $PSCommandPath
  $ps = (Get-Process -Id $PID).Path
  Say "S17-auto: profil '$Project', CLI $($StripeCliBase -join ' ')"
  Register-CompromisedProfileKeys
  $null = Get-ServiceRole
  $null = Assert-StagingAccess
  if (-not $PriceId) {
    Fail "Profil '$Project' nema cenu (sandbox-$Project.json) - nove sandboxy sa nezakladaju."
  }
  $k = Get-StripeTestKey
  Assert-StripeAccount $k
  $acc = Test-StripeKeyAccess $k (Get-S17PinnedVersion)
  if ($Step -eq "s17-preflight") {
    $hi = Get-S17HeadInfo
    $cfg = @(Get-Rows "billing_runtime_config?select=web_provider,environment")[0]
    $prices = @(Get-Rows "billing_provider_prices?provider=eq.stripe&environment=eq.test&select=provider_price_id,active")
    $cur = @(Get-Rows "billing_event_cursors?provider=eq.stripe&environment=eq.test&select=account_ref,last_error_code,lease_until")[0]
    $open = @(Get-Rows "billing_checkout_sessions?company_id=eq.$CompanyD&status=in.(created,open)&select=id")
    $pre = [ordered]@{
      at = (Get-UtcIso); project = $Project; harness_head = $HarnessHead; app_matches_expected_main = $hi.app_matches
      stripe_account = $SandboxAccount; key_kind = $(if ($k -match "^sk_test_") { "sk_test" } elseif ($k -match "^rk_test_") { "rk_test" } else { "?" })
      stripe_probe = "citanie OK + zapis Test Clocks opravneny (400 bez vytvorenia)"; balance_transactions = $acc["balance_transactions"]; payouts = $acc["payouts"]
      delivery = $(if ($NoListen -or $NoListenOnly) { "iba dotahovanie (-NoListen)" } else { "stripe listen" })
      staging_web_provider = [string]$cfg.web_provider; staging_environment = [string]$cfg.environment
      staging_price_row_exists = (@($prices | Where-Object { $_.provider_price_id -eq $PriceId }).Count -eq 1)
      staging_active_prices = @($prices | Where-Object { $_.active } | ForEach-Object { Get-ShortId ([string]$_.provider_price_id) })
      cursor_account = $(if ($cur) { [string]$cur.account_ref } else { "-" })
      cursor_action_in_s17 = $(if (-not $cur) { "zalozi cron" } elseif ([string]$cur.account_ref -eq $SandboxAccount) { "ziadny reset" } else { "reset + obnova" })
      qa_d_open_checkout_intents = $open.Count
      node_modules = (Test-Path (Join-Path $RepoRoot "node_modules\next\package.json"))
    }
    $problems = @()
    if (-not $hi.app_matches) { $problems += "aplikacny kod != $($S17ExpectedMain.Substring(0, 7))" }
    if ($pre.staging_web_provider -ne "none") { $problems += "staging web_provider=$($pre.staging_web_provider) (ocakavane none)" }
    if (-not $pre.staging_price_row_exists) { $problems += "staging nema riadok ceny $(Get-ShortId $PriceId) (S17-1 ho vytvori)" }
    $pre["result"] = $(if ($problems.Count) { "POZOR: " + ($problems -join "; ") } else { "OK - S17 moze bezat" })
    $pf = Join-Path (Split-Path -Parent (Get-S17EvidenceFile)) "s17-preflight.json"
    Set-Content -Path $pf -Value (Hide-S17 ($pre | ConvertTo-Json -Depth 6)) -Encoding UTF8
    Say ""
    Say "S17 PREFLIGHT (iba citanie): $($pre.result)"
    Say "    dokaz: $pf"
    if ($problems | Where-Object { $_ -notmatch "S17-1 ho vytvori" }) { exit 1 }
    exit 0
  }
  if (-not (Test-Path (Join-Path $RepoRoot "node_modules\next\package.json"))) {
    Say "node_modules chyba -> npm ci (jednorazovo, niekolko minut)..."
    Push-Location $RepoRoot; try { & npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { Fail "npm ci zlyhal." } } finally { Pop-Location }
  }
  $fwd = @()
  if ($Force) { $fwd += "-Force" }
  if ($Month) { $fwd += @("-Month", $Month) }
  $busy = $false
  try { Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 3 | Out-Null; $busy = $true } catch { if ($_.Exception.Response) { $busy = $true } }
  if ($busy) { Fail "Port $Port uz pouziva iny server (stare okno 1?) - zatvor ho, inak by test bezal proti nemu." }
  Say "Okno 1 (Esblu) sa spusta v novom okne..."
  $w1Args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$self`"", "-Step", "start", "-Project", $Project, "-Port", "$Port") + $fwd
  if ($NoListen -or $NoListenOnly) { $w1Args += "-NoListen"; Say "    okno 1 BEZ stripe listen (-NoListen): udalosti iba cez dotahovanie" }
  $w1 = Start-Process -FilePath $ps -ArgumentList $w1Args -PassThru
  $ready = $false
  for ($i = 0; $i -lt 120; $i++) {
    if ($w1.HasExited) { break }
    try { $r = Invoke-WebRequest -Uri "http://localhost:$Port/login" -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch { }
    Start-Sleep -Seconds 5
  }
  $s17Exit = 1; $cleanExit = 1
  try {
    if (-not $ready) { Fail "Okno 1 nenabehlo do 10 min (pozri okno 1) - S17 sa nespustil." }
    Start-Sleep -Seconds 10   # stripe listen sa pripaja
    if ($w1.HasExited) { Fail "Okno 1 skoncilo hned po starte (pozri okno 1) - S17 sa nespustil." }
    & $ps -NoProfile -ExecutionPolicy Bypass -File $self -Step s17 -Project $Project -Port $Port @fwd
    $s17Exit = $LASTEXITCODE
  } finally {
    if ($ready) {
      & $ps -NoProfile -ExecutionPolicy Bypass -File $self -Step s17-cleanup -Project $Project -Port $Port @fwd
      $cleanExit = $LASTEXITCODE
    }
    if (-not $w1.HasExited) { $ErrorActionPreference = "Continue"; & taskkill.exe /PID $w1.Id /T /F 2>&1 | Out-Null }
    # taskkill nespusti finally okna 1 -> logy stripe listen (whsec_) a lokalny CRON_SECRET zmazat tu
    Remove-Item (Join-Path $StateDir "listen*.log"), $CronFile, $NoListenFile, $ListenPidFile, $HeadFile -Force -ErrorAction SilentlyContinue
  }
  Say "S17-auto: S17 exit $s17Exit, upratanie exit $cleanExit. Dokazy: release-backups\s17\s17-evidence.json (bez tajomstiev)."
  if ($s17Exit -ne 0 -or $cleanExit -ne 0) { exit 1 }
  exit 0
}

if ($Step -eq "new-sandbox") {
  if ($Email -notmatch "^[^@\s]+@[^@\s]+\.[^@\s]+$") { Fail "Zadaj -Email <adresa> (predvyplni registraciu pri neskorsom claim)." }
  # 0) Zdedeny STRIPE_API_KEY by mal prednost pred profilom -> pre novy sandbox sa ignoruje (iba tento proces).
  if ($env:STRIPE_API_KEY) { Remove-Item Env:STRIPE_API_KEY; Say "    zdedena premenna STRIPE_API_KEY ignorovana (novy sandbox pouzije iba kluc z profilu '$Project')" }
  Say "0/5 Kontroly pred zapisom (Stripe CLI: $($StripeCliBase -join ' '))"
  # 1) Kompromitovane tajomstva: esblu-qa2 musi byt evidovane; default profil sa prida (lokalny subor).
  $known = @(Get-ExposedHashes)
  $qa2 = Get-ListenSecret (@($StripeCliBase) + @("--project-name", "esblu-qa2")) -Quiet
  if ($qa2) {
    if ($known -notcontains (Get-Sha256 $qa2)) { Fail "Tajomstvo profilu esblu-qa2 NIE JE evidovane ako kompromitovane - spusti najprv -Step mark-exposed -Project esblu-qa2." }
    Say "    esblu-qa2: whsec_*** evidovane ako kompromitovane (SHA-256 $((Get-Sha256 $qa2).Substring(0,8))...)"
  } elseif ($known.Count -lt 2) { Fail "Neviem overit tajomstvo esblu-qa2 a evidovane su len $($known.Count) odtlacky - spusti -Step mark-exposed -Project esblu-qa2." }
  else { Say "    esblu-qa2: tajomstvo sa nedalo nacitat, evidovane odtlacky: $($known.Count) (z mark-exposed)" }
  # Povodne vystavene tajomstvo = profil "default" (vyslovne, nie aktualny project-name CLI).
  if ($Project -ne "default") {
    $exposed = Get-ListenSecret $StripeDefaultCli -Quiet
    if ($exposed) { Add-ExposedHash (Get-Sha256 $exposed) }
  }
  # 2) Ucty existujucich profilov (novy sandbox sa od nich musi lisit).
  $oldAccounts = @(@((Get-ProfileAccountId $StripeDefaultCli)) + @($CompromisedProjects | ForEach-Object { Get-ProfileAccountId (@($StripeCliBase) + @("--project-name", $_)) }) | Where-Object { $_ })
  Register-CompromisedProfileKeys
  # 3) Staging READ-ONLY (URL, service_role, billing test) - pred prvym zapisom.
  $null = Assert-StagingAccess
  # 4) Novy profil musi byt prazdny, inak by `sandboxes create` iba otvoril Dashboard povodneho uctu.
  $cfg = Invoke-StripeRaw $StripeCli @("config", "--list")
  $acctBefore = Get-ProfileAccountId $StripeCli   # ucet profilu PRED zapisom (pokracovanie = ten isty ucet)
  $resume = $false
  if ($cfg -match "(?:sk|rk|rkcs)_live_") { Fail "Profil '$Project' obsahuje LIVE kluc." }
  if ($cfg -match "(?:sk|rk|rkcs)_test_" -or $cfg -match "account_id\s*=\s*['`"]?acct_") {
    # Pokracovanie: profil uz ma sandbox z predchadzajuceho behu, ale este nema cenu (sandbox-$Project.json).
    if (Test-Path $SandboxFile) { Fail "Profil '$Project' uz ma sandbox aj cenu - pouzi -Step s17-auto / map-price." }
    $resume = $true
    Say "1/5 Profil '$Project' uz ma sandbox z predchadzajuceho behu - POKRACOVANIE bez noveho sandboxu."
  } else {
    Say "1/5 Novy anonymny sandbox v profile '$Project' (prvy zapis)..."
    Invoke-Stripe @("sandboxes", "create", "--email", $Email, "--non-interactive") | Out-Null
  }
  # 2/5 Identita noveho sandboxu: ucet z profilu, kluc IBA z profilu (ziadna vyzva, ziadna premenna), /v1/account.
  $acct = Get-ProfileAccountId $StripeCli
  if (-not $acct) { Fail "Profil '$Project' po vytvoreni nema account_id - sandbox nevznikol." }
  # Identita: nikdy ucet profilu default ani kompromitovanych profilov (esblu-qa2, esblu-qa3).
  if ($oldAccounts -contains $acct) { Fail "Profil '$Project' ukazuje na ucet profilu default/kompromitovaneho profilu ($acct) - zastavene pred vytvorenim ceny." }
  if ($resume) {
    # Pokracovanie: povoleny IBA ucet, ktory profil mal uz pred tymto behom (ziadna zmena uctu).
    if (-not $acctBefore -or $acct -ne $acctBefore) { Fail "Pokracovanie: ucet profilu '$Project' sa zmenil ($acctBefore -> $acct) - zastavene." }
    $idMode = "pokracovanie na existujucom ucte profilu"
  } else {
    if ($acctBefore) { Fail "Profil '$Project' mal ucet uz pred vytvorenim - zastavene." }
    $idMode = "novy ucet"
  }
  $cfg = Invoke-StripeRaw $StripeCli @("config", "--list")
  if ($cfg -match "test_mode_api_key\s*=\s*['`"]?(?:sk|rk|rkcs)_live_") { Fail "V profile je LIVE kluc." }
  $km = [regex]::Match($cfg, "test_mode_api_key\s*=\s*['`"]?((?:sk|rk|rkcs)_test_[A-Za-z0-9]+)")
  if (-not $km.Success) { Fail "Profil '$Project' nema citatelny testovaci kluc - identitu noveho sandboxu neviem overit (zastavene pred cenou)." }
  $newKey = $km.Groups[1].Value
  $env:STRIPE_API_KEY = $newKey   # iba tento proces; dalsie volania CLI idu do noveho uctu
  if (@(Get-CompromisedKeyHashes) -contains (Get-Sha256 $newKey)) { Fail "Kluc noveho profilu je evidovany ako kompromitovany - zastavene." }
  $a = $null; $code = $null
  try { $a = Invoke-RestMethod -Uri "https://api.stripe.com/v1/account" -Headers @{ Authorization = "Bearer $newKey" } -Method Get }
  catch { try { $code = [int]$_.Exception.Response.StatusCode } catch { } }
  if ($a) {
    if ($a.id -ne $acct) { Fail "Kluc profilu patri uctu $($a.id), profil hlasi $acct - zastavene." }
    $idNote = "/v1/account = $acct"
  } elseif ($code -eq 403) { $idNote = "kluc profilu bez prava na /v1/account (403) - identita podla account_id profilu $acct" }
  else { Fail "Overenie uctu noveho sandboxu zlyhalo (HTTP $code)." }
  $w = Get-ListenSecret $StripeCli
  if (-not $w) { Fail "stripe listen --print-secret v novom profile nevratil whsec_." }
  $wh = Get-Sha256 $w
  if (@(Get-ExposedHashes) -contains $wh) {
    if ($resume -and $ReleaseAutoMarked -and ($CompromisedProjects -notcontains $Project)) {
      $keep = @(Get-ExposedHashes | Where-Object { $_ -ne $wh })
      Set-Content -Path $ExposedFile -Value $keep -Encoding ASCII
      Add-Content -Path (Join-Path $StateDir "exposed-released.log") -Value ("{0} {1} {2} auto-marked by default-profile bug, operator confirmed not disclosed (-ReleaseAutoMarked)" -f (Get-Date).ToUniversalTime().ToString("o"), $Project, $wh.Substring(0, 8)) -Encoding ASCII
      Say "    whsec_*** profilu '$Project' (SHA-256 $($wh.Substring(0,8))...) bolo v zozname omylom (chyba default profilu) - odstranene, zaznam v exposed-released.log"
    } else {
      Fail "Tajomstvo profilu '$Project' je v zozname kompromitovanych. Ak ho NIKTO nezverejnil a pridala ho iba chyba default profilu (2026-11-20), spusti znova s -ReleaseAutoMarked; inak novy sandbox."
    }
  }
  Say "2/5 identita OK ($idMode): ucet $acct (nie default ani kompromitovany: $($oldAccounts.Count) kontrolovanych), $idNote; whsec_*** (SHA-256 $($wh.Substring(0,8))...) nie je kompromitovane"
  $null = Test-StripeKeyAccess $newKey (Get-S17PinnedVersion)
  # 3/5 Cena Esblu Komplet 15,90 EUR / mesiac v novom sandboxe + kontrola, ze ju vidi kluc noveho uctu.
  # Bez duplicity: existujuca aktivna cena 15,90 EUR / mesiac s lookup_key S17 sa pouzije znova.
  $lk = "esblu_complete_month_s17"
  $found = Get-StripeJson @("prices", "list", "-d", "lookup_keys[]=$lk", "-d", "active=true", "--limit", "10")
  $cands = @(@($found.data) | Where-Object { $_ -and $_.unit_amount -eq 1590 -and $_.currency -eq "eur" -and $_.recurring.interval -eq "month" -and -not $_.livemode })
  if ($cands.Count -gt 1) { Fail "V sandboxe je viac cien s lookup_key $lk - zastavene (vyries rucne)." }
  if ($cands.Count -eq 1) { $price = $cands[0]; Say "    existujuca cena $($price.id) sa pouzije znova (bez duplicity)" }
  else { $price = Get-StripeJson @("prices", "create", "-d", "currency=eur", "-d", "unit_amount=1590", "-d", "recurring[interval]=month", "-d", "lookup_key=$lk", "-d", "product_data[name]=Esblu Komplet (test)") }
  if ($price.livemode) { Fail "Cena je live." }
  $script:PriceId = $price.id
  # Ulozit hned (nie je tajne) - ak by dalsia kontrola zlyhala, staging sa nemeni a pokracuje sa cez -Step map-price.
  @{ price = $price.id; account = $acct; created = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -Path $SandboxFile -Encoding ASCII
  Assert-StripeAccount $newKey
  Say "3/5 cena $($price.id) = 15,90 EUR / mesiac (ucet $acct)"
  # 4/5 Staging mapovanie - obnovitelne (pri chybe sa vrati predchadzajuci stav).
  Say "4/5 staging mapovanie ceny..."
  Set-StagingPriceMapping $price.id
  Say "5/5 OK: novy sandbox pripraveny (profil '$Project'). Dalej vzdy s -Project $Project."
  exit 0
}

if ($Step -eq "map-price") {
  # Opakovanie iba kroku 4/5 (napr. po chybe stagingu), cena z profilu; bez zapisu do Stripe.
  if (-not $PriceId) { Fail "Profil '$Project' nema cenu (sandbox-$Project.json)." }
  $null = Assert-StagingAccess
  $k = Get-StripeTestKey
  Assert-StripeAccount $k
  Set-StagingPriceMapping $PriceId
  exit 0
}

if ($Step -ne "start") {
  if (-not $PriceId) { Fail "Pre profil '$Project' chyba cena - spusti najprv -Step new-sandbox -Email <adresa>." }
  $k = Get-StripeTestKey
  Assert-StripeAccount $k
  switch ($Step) {
    "clock-setup" {
      if (-not $CheckoutId) {
        # Novy zamer firmy D pre aktualnu cenu (stare otvorene zamery D sa uzavru; 1 otvoreny na firmu).
        Invoke-Staging "PATCH" "billing_checkout_sessions?company_id=eq.$CompanyD&status=in.(created,open)" @{ status = "expired" } | Out-Null
        $row = Invoke-Staging "POST" "billing_checkout_sessions" @{ company_id = $CompanyD; created_by = $OwnerD; provider = "stripe"; environment = "test";
          plan_code = "esblu_complete"; billing_interval = "month"; provider_price_id = $PriceId; expires_at = (Get-Date).ToUniversalTime().AddHours(1).ToString("o") }
        $CheckoutId = @($row)[0].id
        Say "    novy zamer firmy QA-STRIPE D: $CheckoutId (plati 1 h)"
      }
      if ($CheckoutId -notmatch "^[0-9a-f-]{36}$") { Fail "Neplatne -CheckoutId." }
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
      $clock = Get-StripeJson @("test_helpers", "test_clocks", "create", "-d", "frozen_time=$now", "-d", "name=Esblu QA renewal")
      $cus = Get-StripeJson @("customers", "create", "-d", "test_clock=$($clock.id)", "-d", "email=qa-stripe-d@example.invalid", "-d", "name=QA-STRIPE D")
      $pm = Get-StripeJson @("payment_methods", "attach", "pm_card_visa", "-d", "customer=$($cus.id)")
      Invoke-Stripe @("customers", "update", $cus.id, "-d", "invoice_settings[default_payment_method]=$($pm.id)") | Out-Null
      $sub = Get-StripeJson @("subscriptions", "create", "-d", "customer=$($cus.id)", "-d", "items[0][price]=$PriceId",
        "-d", "metadata[esblu_checkout_id]=$CheckoutId", "-d", "default_payment_method=$($pm.id)")
      @{ clock = $clock.id; customer = $cus.id; subscription = $sub.id } | ConvertTo-Json | Set-Content -Path $ClockFile -Encoding ASCII
      $s = Wait-StripeInvoice $sub.id "subscription_create" "paid" 0
      $p = Get-Period $s
      Say "Stripe: $($sub.id) stav=$($s.status) obdobie $(Utc $p.start) -> $(Utc $p.end), faktura subscription_create zaplatena (clock $($clock.id))"
      $acc = Wait-Esblu $sub.id { param($a) $a.status -eq "active" } "aktivacia predplatneho"
      Say "Esblu: stav=$($acc.status) plan=$($acc.plan_code) koniec=$($acc.current_period_end)"
      Say "OK: predplatne na test clock aktivne v Stripe aj v Esblu."
    }
    "renew" {
      $st = Get-ClockState; $subId = if ($Subscription) { $Subscription } else { $st.subscription }
      $before = Get-Period (Get-Sub $subId)
      Move-Clock $st.clock ($before.end + 7200)
      $s = Wait-StripeInvoice $subId "subscription_cycle" "paid" $before.end
      $after = Get-Period $s
      if ($after.end -le $before.end) { Fail "Stripe: obdobie sa neposunulo." }
      Say "Stripe: nova faktura $($s.latest_invoice.id) subscription_cycle zaplatena; obdobie $(Utc $after.start) -> $(Utc $after.end) (predtym koniec $(Utc $before.end))"
      $expected = [DateTimeOffset]::FromUnixTimeSeconds($after.end).UtcDateTime
      $acc = Wait-Esblu $subId { param($a) $a.status -eq "active" -and ([DateTime]::Parse($a.current_period_end).ToUniversalTime() -eq $expected) } "posun obdobia"
      Say "Esblu: stav=$($acc.status) koniec=$($acc.current_period_end)"
      Say "OK: obnova overena v Stripe aj v Esblu."
    }
    "fail-renew" {
      $st = Get-ClockState; $subId = if ($Subscription) { $Subscription } else { $st.subscription }
      $before = Get-Period (Get-Sub $subId)
      $pm = Get-StripeJson @("payment_methods", "attach", "pm_card_chargeCustomerFail", "-d", "customer=$($st.customer)")
      Invoke-Stripe @("customers", "update", $st.customer, "-d", "invoice_settings[default_payment_method]=$($pm.id)") | Out-Null
      Invoke-Stripe @("subscriptions", "update", $subId, "-d", "default_payment_method=$($pm.id)") | Out-Null
      Move-Clock $st.clock ($before.end + 7200)
      $s = Wait-StripeInvoice $subId "subscription_cycle" "open" $before.end
      for ($i = 0; $i -lt 20 -and $s.status -ne "past_due"; $i++) { Start-Sleep -Seconds 3; $s = Get-Sub $subId }
      if ($s.status -ne "past_due") { Fail "Stripe: predplatne nie je past_due (stav=$($s.status))." }
      Say "Stripe: faktura $($s.latest_invoice.id) subscription_cycle neuhradena (open), predplatne past_due"
      $acc = Wait-Esblu $subId { param($a) $a.status -eq "past_due" } "stav past_due"
      Say "Esblu: stav=$($acc.status) (pristup do grace_until), koniec=$($acc.current_period_end)"
      Say "OK: neuspesna obnova overena v Stripe aj v Esblu."
    }
    "fix-payment" {
      $st = Get-ClockState; $subId = if ($Subscription) { $Subscription } else { $st.subscription }
      $pm = Get-StripeJson @("payment_methods", "attach", "pm_card_visa", "-d", "customer=$($st.customer)")
      Invoke-Stripe @("customers", "update", $st.customer, "-d", "invoice_settings[default_payment_method]=$($pm.id)") | Out-Null
      Invoke-Stripe @("subscriptions", "update", $subId, "-d", "default_payment_method=$($pm.id)") | Out-Null
      $inv = Get-StripeJson @("invoices", "list", "-d", "subscription=$subId", "-d", "status=open", "--limit", "1")
      if (-not $inv.data -or $inv.data.Count -eq 0) { Fail "Ziadna otvorena faktura - najprv -Step fail-renew." }
      Invoke-Stripe @("invoices", "pay", $inv.data[0].id) | Out-Null
      $s = Get-Sub $subId
      for ($i = 0; $i -lt 20 -and $s.status -ne "active"; $i++) { Start-Sleep -Seconds 3; $s = Get-Sub $subId }
      if ($s.status -ne "active") { Fail "Stripe: predplatne nie je active (stav=$($s.status))." }
      Say "Stripe: faktura $($inv.data[0].id) zaplatena, predplatne active"
      $acc = Wait-Esblu $subId { param($a) $a.status -eq "active" } "navrat do active"
      Say "Esblu: stav=$($acc.status) koniec=$($acc.current_period_end)"
      Say "OK: opakovanie platby overene v Stripe aj v Esblu."
    }
    { $_ -in @("refund-partial", "refund-full") } {
      $subId = if ($Subscription) { $Subscription } else { (Get-ClockState).subscription }
      $sub = Get-Sub $subId
      $ch = (Get-StripeJson @("charges", "list", "-d", "customer=$($sub.customer)", "--limit", "10")).data |
        Where-Object { $_.status -eq "succeeded" -and -not $_.refunded } | Select-Object -First 1
      if (-not $ch) { Fail "Ziadna zaplatena (nerefundovana) platba." }
      if ($Step -eq "refund-partial") {
        Invoke-Stripe @("refunds", "create", "-d", "charge=$($ch.id)", "-d", "amount=500") | Out-Null
        Say "Stripe: ciastocna refundacia 5,00 EUR z $($ch.id)"
        Start-Sleep -Seconds 6
        $acc = Wait-Esblu $subId { param($a) $a.status -eq "active" } "zachovanie pristupu"
        Say "Esblu: stav=$($acc.status) (ciastocna refundacia pristup nemeni)"
        Say "OK: ciastocna refundacia overena."
      } else {
        Invoke-Stripe @("refunds", "create", "-d", "charge=$($ch.id)") | Out-Null
        Say "Stripe: refundacia zvysku $($ch.id) (plna)"
        $acc = Wait-Esblu $subId { param($a) $a.status -eq "refunded" } "stav refunded"
        Say "Esblu: stav=$($acc.status) (pristup odvolany, data ostavaju)"
        Say "OK: plna refundacia overena."
      }
    }
    { $_ -in @("refund-old", "refund-current") } {
      $st = Get-ClockState; $subId = if ($Subscription) { $Subscription } else { $st.subscription }
      $sub = Get-Sub $subId
      $currentId = if ($sub.latest_invoice.id) { $sub.latest_invoice.id } else { $sub.latest_invoice }
      $paid = Get-PaidInvoices $subId
      if ($Step -eq "refund-old") {
        $inv = $paid | Where-Object { $_.id -ne $currentId } | Select-Object -First 1
        if (-not $inv) { Fail "Chyba starsia zaplatena faktura - najprv -Step renew." }
      } else {
        $inv = $paid | Where-Object { $_.id -eq $currentId } | Select-Object -First 1
        if (-not $inv) { Fail "Faktura aktualneho obdobia ($currentId) nie je zaplatena." }
      }
      $pi = Get-InvoicePaymentIntent $inv
      $cs = Get-ChargeRefundState $pi
      if ($cs.refunded -ge $cs.amount -and $cs.amount -gt 0) {
        # Opakovany beh: faktura uz je plne refundovana -> NErefundovat znova, iba overit vysledok.
        Say "Stripe: faktura $($inv.id) je uz plne refundovana (charge $($cs.charge), $(Format-Eur $cs.refunded) z $(Format-Eur $cs.amount)) - iba overenie, bez novej refundacie."
      } elseif ($cs.refunded -gt 0) {
        Fail "Faktura $($inv.id) je refundovana ciastocne ($(Format-Eur $cs.refunded) z $(Format-Eur $cs.amount)) - krok vyzaduje plnu refundaciu; pouzi inu fakturu/predplatne."
      } else {
        Invoke-Stripe @("refunds", "create", "-d", "payment_intent=$pi") | Out-Null
        Say "Stripe: plna refundacia faktury $($inv.id) ($($inv.billing_reason), obdobie $(Utc $inv.period_start) -> $(Utc $inv.period_end)); aktualna faktura predplatneho = $currentId"
      }
      # pockat na spracovanie charge.refunded v Esblu - podla faktury v audite (deterministicky)
      $ev = $null; $seen = $null
      for ($i = 0; $i -lt 40; $i++) {
        $seen = Get-RefundEventForInvoice $subId $inv.id
        if ($seen -and $seen.status -ne "received") { $ev = $seen; break }
        Start-Sleep -Seconds 3
      }
      if (-not $ev) {
        $diag = if ($seen) { "udalost $($seen.provider_event_id) pre fakturu je stale status=$($seen.status) (prijata, nespracovana -> okno 1)" } else { "pre fakturu $($inv.id) ziadna udalost (nedorucene -> okno 2 stripe listen); $(Get-LastRefundEventInfo)" }
        Fail "Esblu DB: charge.refunded pre fakturu $($inv.id) sa do 120 s nespracovala: $diag"
      }
      if ($ev.status -ne "processed") { Fail "Esblu DB: udalost $($ev.provider_event_id) skoncila status=$($ev.status) chyba=$($ev.error_code)." }
      $evAcc = if ($ev.summary.account_status) { $ev.summary.account_status } else { $ev.summary.status }
      Say "Esblu: charge.refunded $($ev.provider_event_id) spracovana (status=$($ev.status), prijata $($ev.received_at), spracovana $($ev.processed_at), stav uctu v udalosti=$evAcc)"
      # Stav platby v Stripe NACITAT ZNOVA - $cs je snimka pred refundaciou (refunded=0).
      $csNow = Get-ChargeRefundState $pi
      for ($i = 0; $i -lt 10 -and $csNow.refunded -lt $csNow.amount; $i++) { Start-Sleep -Seconds 2; $csNow = Get-ChargeRefundState $pi }
      if ($csNow.charge -ne $cs.charge) { Fail "Platba faktury sa zmenila ($($cs.charge) -> $($csNow.charge))." }
      if ($csNow.amount -le 0 -or $csNow.refunded -ne $csNow.amount) { Fail "Stripe: charge $($csNow.charge) nie je plne refundovana ($(Format-Eur $csNow.refunded) z $(Format-Eur $csNow.amount))." }
      Say "Stripe (po refundacii): charge $($csNow.charge) refundovane $(Format-Eur $csNow.refunded) z $(Format-Eur $csNow.amount)"
      # Vazba refundacie na fakturu a jej obdobie (riadok predplatneho).
      $line = @($inv.lines.data | ForEach-Object { $_ }) | Where-Object { $_.period } | Select-Object -First 1
      $expScope = if ($Step -eq "refund-old") { "older_invoice" } else { "current_period" }
      $r = $ev.summary.refund
      Say ("Esblu audit: faktura={0} rozsah={1} obdobie {2} -> {3} suma={4}" -f $r.invoice, $r.scope, $r.invoice_period_start, $r.invoice_period_end, (Format-Eur ([long]$r.amount_minor) ([string]$r.currency)))
      if ($r.invoice -ne $inv.id) { Fail "Audit odkazuje na fakturu $($r.invoice), refundovana bola $($inv.id)." }
      if ([string]$ev.summary.subscription -ne $subId) { Fail "Audit odkazuje na predplatne $($ev.summary.subscription), ocakavane $subId." }
      if ([string]$inv.subscription -ne $subId -and [string]$inv.parent.subscription_details.subscription -ne $subId) { Fail "Faktura $($inv.id) v Stripe nepatri predplatnemu $subId." }
      $accLink = Get-EsbluAccount $subId
      if (-not $accLink) { Fail "Esblu: ucet predplatneho $subId nenajdeny." }
      if ([string]$ev.company_id -ne [string]$accLink.company_id) { Fail "Udalost patri firme $($ev.company_id), predplatne firme $($accLink.company_id)." }
      if ([string]$r.currency -ne ([string]$inv.currency).ToUpper() -and [string]$r.currency -ne [string]$inv.currency) { Fail "Mena v audite $($r.currency) != mena faktury $($inv.currency)." }
      if ([long]$r.amount_minor -ne [long]$csNow.refunded) { Fail "Suma v audite $(Format-Eur ([long]$r.amount_minor)) != refundovane v Stripe $(Format-Eur $csNow.refunded) (centy: $($r.amount_minor) vs $($csNow.refunded))." }
      if ([long]$inv.amount_paid -ne [long]$csNow.amount) { Fail "Zaplatene na fakture $(Format-Eur ([long]$inv.amount_paid)) != suma platby $(Format-Eur $csNow.amount)." }
      Say "Vazby OK: faktura=$($inv.id) predplatne=$subId firma=$($accLink.company_id) suma=$(Format-Eur ([long]$r.amount_minor)) (Stripe charge $($csNow.charge))"
      if ($r.scope -ne $expScope) { Fail "Rozsah refundacie $($r.scope), ocakavany $expScope." }
      if ($line -and ([DateTime]::Parse($r.invoice_period_start).ToUniversalTime() -ne [DateTimeOffset]::FromUnixTimeSeconds($line.period.start).UtcDateTime)) { Fail "Obdobie v audite nesedi s obdobim faktury v Stripe." }
      if ($Step -eq "refund-old") {
        Start-Sleep -Seconds 5
        $s = Get-Sub $subId
        if ($s.status -ne "active") { Fail "Stripe: predplatne nie je active (stav=$($s.status))." }
        $acc = Wait-Esblu $subId { param($a) $a.status -eq "active" } "zachovanie pristupu"
        Say "Stripe: predplatne $subId stale active; Esblu: stav=$($acc.status) koniec=$($acc.current_period_end)"
        Say "OK: refundacia starsej faktury = iba uctovny zaznam, pristup aj obnovovanie pokracuju."
      } else {
        $acc = Wait-Esblu $subId { param($a) $a.status -eq "refunded" } "stav refunded"
        $s = Get-Sub $subId
        for ($i = 0; $i -lt 40 -and $s.status -ne "canceled"; $i++) { Start-Sleep -Seconds 3; $s = Get-Sub $subId }
        if ($s.status -ne "canceled") { Fail "Stripe: predplatne nebolo ukoncene (stav=$($s.status)) - Esblu by ho dalej uctoval." }
        Say "Esblu: stav=$($acc.status) (pristup odvolany); Stripe: predplatne $subId stav=$($s.status), ended_at=$(Utc $s.ended_at)"
        Assert-TerminalKept $subId "refunded"
        $n = Get-ActiveSubEnts $accLink.company_id
        if ($n -ne 0) { Fail "Firma ma stale $n ucinnych aktivnych narokov." }
        Say "Esblu: 0 ucinnych aktivnych narokov firmy $($accLink.company_id)"
        Say "OK: refundacia aktualneho obdobia ukoncila pristup aj dalsie uctovanie; refunded ostal aj po udalosti zrusenia."
      }
    }
    "reconcile" {
      $st = Get-ClockState; $subId = if ($Subscription) { $Subscription } else { $st.subscription }
      if (-not (Test-Path $CronFile)) { Fail "Okno 1 nebezi s novou verziou skriptu (chyba lokalny CRON_SECRET) - restartuj okno 1." }
      $cron = (Get-Content $CronFile -Raw).Trim()
      $res = Invoke-RestMethod -Uri "http://localhost:$Port/api/cron/billing-reconcile" -Headers @{ Authorization = "Bearer $cron" } -Method Get
      Say "Esblu reconciliation: checked=$($res.checked) summary=$(($res.summary | ConvertTo-Json -Compress))"
      $s = Get-Sub $subId
      for ($i = 0; $i -lt 20 -and $s.status -ne "canceled"; $i++) { Start-Sleep -Seconds 3; $s = Get-Sub $subId }
      $acc = Get-EsbluAccount $subId
      Say "Stripe: $subId stav=$($s.status) ended_at=$(if ($s.ended_at) { Utc $s.ended_at } else { '-' }); Esblu: stav=$($acc.status)"
      if ($s.status -ne "canceled") { Fail "Stripe predplatne stale bezi." }
      if ($acc.status -ne "refunded" -and $acc.status -ne "revoked") { Fail "Esblu stav sa zmenil na $($acc.status)." }
      Assert-TerminalKept $subId $acc.status
      Say "OK: reconciliation ukoncila predplatne u Stripe, Esblu ostava $($acc.status)."
    }
    "verify-terminal" {
      # Opakovatelne overenie: stav refunded/revoked, ziadny aktivny narok, udalost zrusenia stale,
      # opakovana reconciliation (Stripe canceled vs. Esblu refunded) stav nezmeni.
      $st = Get-ClockState; $subId = if ($Subscription) { $Subscription } else { $st.subscription }
      $acc0 = Get-EsbluAccount $subId
      if ($acc0.status -ne "refunded" -and $acc0.status -ne "revoked") { Fail "Esblu stav je $($acc0.status) - overenie plati pre refunded/revoked." }
      Assert-TerminalKept $subId $acc0.status
      if (-not (Test-Path $CronFile)) { Fail "Okno 1 nebezi (chyba lokalny CRON_SECRET)." }
      $cron = (Get-Content $CronFile -Raw).Trim()
      $accRow = (Get-Rows "subscription_accounts?provider_subscription_id=eq.$subId&select=id,ended_at")[0]
      if (-not $accRow) { Fail "Esblu: ucet $subId nenajdeny." }
      for ($k = 1; $k -le 2; $k++) {
        # Ucet QA naplanovat na okamzitu kontrolu (inak ho reconciliation 24 h preskakuje a checked=0 nic nedokazuje).
        # next_check_at je NOT NULL (null -> HTTP 400, 23502) -> nastavit do minulosti; last_checked_at null = najvyssia priorita.
        $due = [DateTime]::UtcNow.AddMinutes(-1).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        $upd = @(Invoke-Staging "PATCH" "billing_reconciliation?account_id=eq.$($accRow.id)" @{ last_checked_at = $null; next_check_at = $due } | ForEach-Object { $_ })
        if ($upd.Count -ne 1) { Fail "Naplanovanie kontroly: zmenenych riadkov $($upd.Count) (ocakavany 1)." }
        $t0 = [DateTime]::UtcNow
        try {
          $res = Invoke-RestMethod -Uri "http://localhost:$Port/api/cron/billing-reconcile" -Headers @{ Authorization = "Bearer $cron" } -Method Get
        } catch { Fail "GET /api/cron/billing-reconcile zlyhal: $(Get-HttpErrorText $_)" }
        if ([int]$res.checked -lt 1) { Fail "Reconciliation #$($k) nic neskontrolovala (checked=$($res.checked))." }
        $rec = (Get-Rows "billing_reconciliation?account_id=eq.$($accRow.id)&select=last_checked_at,last_result,last_error_code")[0]
        $acc = Get-EsbluAccount $subId
        $s = Get-Sub $subId
        Say "reconciliation #$($k): checked=$($res.checked) summary=$(($res.summary | ConvertTo-Json -Compress)); ucet QA: vysledok=$($rec.last_result) kod=$($rec.last_error_code) kontrola=$($rec.last_checked_at); Esblu stav=$($acc.status); Stripe stav=$($s.status)"
        if (-not $rec -or -not $rec.last_checked_at -or [DateTime]::Parse($rec.last_checked_at).ToUniversalTime() -lt $t0.AddSeconds(-5)) { Fail "Reconciliation ucet QA neskontrolovala." }
        if ($rec.last_result -ne "in_sync") { Fail "Reconciliation vysledok $($rec.last_result) (ocakavane in_sync)." }
        if ($acc.status -ne $acc0.status) { Fail "Reconciliation zmenila stav na $($acc.status)." }
        if ($s.status -ne "canceled") { Fail "Stripe predplatne nie je canceled (stav=$($s.status))." }
      }
      $n = Get-ActiveSubEnts $acc0.company_id
      if ($n -ne 0) { Fail "Firma ma $n ucinnych aktivnych narokov." }
      Say "Esblu: 0 ucinnych aktivnych narokov"
      $events = Get-SubEvents $subId ""
      Say "Udalosti predplatneho v Esblu ($($events.Count)):"
      $events | ForEach-Object { Say ("  {0}  {1,-34} {2,-10} {3}" -f $_.received_at, $_.event_type, $_.status, $_.error_code) }
      Say "OK: $($acc0.status) zachovany, ziadny aktivny narok, opakovane spracovanie bez zmeny."
    }
    "advance-check" {
      $st = Get-ClockState; $subId = if ($Subscription) { $Subscription } else { $st.subscription }
      $s = Get-Sub $subId; $p = Get-Period $s
      $c0 = Get-Counts $subId $st.customer
      $acc0 = Get-EsbluAccount $subId
      $clock = Get-StripeJson @("test_helpers", "test_clocks", "retrieve", $st.clock)
      $target = [Math]::Max([long]$clock.frozen_time, $p.end) + 35 * 86400
      Move-Clock $st.clock $target
      Start-Sleep -Seconds 15
      $s1 = Get-Sub $subId; $c1 = Get-Counts $subId $st.customer; $acc1 = Get-EsbluAccount $subId
      Say "Test clock: $(Utc $clock.frozen_time) -> $(Utc $target)"
      Say "Stripe: stav $($s.status) -> $($s1.status); faktury $($c0.invoices) -> $($c1.invoices) (posledna $($c0.latest) -> $($c1.latest)); uspesne platby $($c0.charges) -> $($c1.charges)"
      Say "Esblu: stav $($acc0.status) -> $($acc1.status)"
      if ($c1.invoices -ne $c0.invoices -or $c1.charges -ne $c0.charges) { Fail "Po posune hodin vznikla nova faktura alebo platba." }
      if ($acc1.status -ne $acc0.status) { Fail "Esblu stav sa zmenil." }
      Say "OK: dalsie obdobie bez faktury a bez platby; Esblu bez zmeny."
    }
    "qa-login" {
      # Nahodne heslo (kryptograficky RNG) -> Supabase Admin API stagingu. Heslo ide iba do schranky.
      $bytes = New-Object byte[] 18
      [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $pw = "Qa-" + ([Convert]::ToBase64String($bytes) -replace "[+/=]", "x")
      $k = Get-ServiceRole
      $h = @{ apikey = $k; Authorization = "Bearer $k" }
      $body = @{ password = $pw; ban_duration = "none"; email_confirm = $true } | ConvertTo-Json -Compress
      $u = Invoke-RestMethod -Uri "$StagingUrl/auth/v1/admin/users/$OwnerE" -Headers $h -Method Put -ContentType "application/json" -Body $body
      if ($u.email -ne $OwnerEEmail) { Fail "Admin API vratilo ineho pouzivatela." }
      Set-Clipboard -Value $pw
      $pw = $null
      Say "QA-STRIPE E: e-mail $OwnerEEmail, heslo je v SCHRANKE (nevypisuje sa; vlozte ho iba do prihlasenia http://localhost:$Port)."
    }
    "qa-check" {
      $intents = Get-Rows "billing_checkout_sessions?company_id=eq.$CompanyE&order=created_at.asc&select=id,status,provider,provider_session_id,plan_code,billing_interval,created_at,expires_at,completed_at"
      Say "Zamery checkoutu firmy E ($($intents.Count)):"
      foreach ($i in $intents) { Say ("  {0} {1,-10} {2} {3}/{4} vytvoreny {5} relacia {6}" -f $i.id, $i.status, $i.provider, $i.plan_code, $i.billing_interval, $i.created_at, $i.provider_session_id) }
      $open = @($intents | Where-Object { $_.status -in @("created", "open") })
      $done = @($intents | Where-Object { $_.status -eq "completed" })
      if ($open.Count -gt 1) { Fail "Firma E ma $($open.Count) otvorene zamery naraz." }
      if ($done.Count -gt 1) { Fail "Firma E ma $($done.Count) dokoncene zamery (dvojita platba)." }
      # Stripe: kazda relacia zo zamerov; zaplatena smie byt najviac jedna.
      $paid = 0
      foreach ($sid in @($intents | Where-Object { $_.provider_session_id } | ForEach-Object { $_.provider_session_id } | Select-Object -Unique)) {
        $cs = Get-StripeJson @("checkout", "sessions", "retrieve", $sid)
        Say ("  Stripe relacia {0}: status={1} payment_status={2} predplatne={3} expires={4}" -f $cs.id, $cs.status, $cs.payment_status, $cs.subscription, (Utc $cs.expires_at))
        if ($cs.payment_status -eq "paid") { $paid++ }
      }
      if ($paid -gt 1) { Fail "Stripe: $paid zaplatene relacie pre firmu E." }
      $acc = (Get-Rows "subscription_accounts?company_id=eq.$CompanyE&select=status,provider_subscription_id,provider_customer_id,current_period_end,cancel_at_period_end")[0]
      if ($acc -and $acc.provider_subscription_id) {
        # Po uspesnom nakupe: PRESNE 1 dokonceny zamer a PRESNE 1 zaplatena relacia (nie iba "najviac").
        if ($done.Count -ne 1) { Fail "Po nakupe ocakavany presne 1 dokonceny zamer, je $($done.Count)." }
        if ($paid -ne 1) { Fail "Po nakupe ocakavana presne 1 zaplatena Stripe relacia, je $paid." }
        Say "Nakup: presne 1 dokonceny zamer a 1 zaplatena relacia"
      }
      if ($acc) {
        Say "Esblu: stav=$($acc.status) predplatne=$($acc.provider_subscription_id) koniec=$($acc.current_period_end) cancel_at_period_end=$($acc.cancel_at_period_end)"
        if ($acc.provider_customer_id) {
          $subs = Get-StripeJson @("subscriptions", "list", "-d", "customer=$($acc.provider_customer_id)", "-d", "status=all", "--limit", "10")
          $live = @($subs.data | ForEach-Object { $_ } | Where-Object { $_.status -notin @("canceled", "incomplete_expired") })
          Say "Stripe: zakaznik ma $(@($subs.data | ForEach-Object { $_ }).Count) predplatne(-ych), neukoncenych $($live.Count)"
          if ($live.Count -gt 1) { Fail "Stripe: viac neukoncenych predplatnych pre firmu E." }
        }
        if ($acc.provider_subscription_id) {
          $s = Get-Sub $acc.provider_subscription_id
          $stripeCancel = [bool]$s.cancel_at_period_end -or [bool]$s.cancel_at
          Say "Stripe: $($s.id) stav=$($s.status) cancel_at_period_end=$($s.cancel_at_period_end) cancel_at=$(if ($s.cancel_at) { Utc $s.cancel_at } else { '-' })"
          if ([bool]$acc.cancel_at_period_end -ne $stripeCancel) { Fail "Zrusenie nesedi: Esblu cancel_at_period_end=$($acc.cancel_at_period_end), Stripe=$stripeCancel." }
          $n = Get-ActiveSubEnts $CompanyE
          Say "Esblu: ucinnych aktivnych narokov $n"
          if ($acc.status -eq "active" -and $n -lt 1) { Fail "Aktivne predplatne bez narokov." }
        }
      } else { Say "Esblu: firma E zatial nema predplatne." }
      Say "OK: firma E - najviac 1 otvoreny zamer; po nakupe presne 1 dokonceny zamer a 1 zaplatena relacia; Esblu a Stripe zhodne."
    }
    "s12-account" {
      # Ucet a kluc bez vypisu tajomstva: iba prefix typu kluca a ID uctu (nie je tajne).
      $h = @{ Authorization = "Bearer $k" }
      $kind = if ($k -match "^rkcs_test_") { "rkcs_test (claimable sandbox)" } elseif ($k -match "^rk_test_") { "rk_test (restricted)" } elseif ($k -match "^sk_test_") { "sk_test (secret)" } else { "?" }
      Say "Kluc: $kind (test mode; live kluce skript odmieta)"
      try { $acct = Invoke-RestMethod -Uri "https://api.stripe.com/v1/account" -Headers $h -Method Get }
      catch { Fail "GET /v1/account zlyhal: $(Get-HttpErrorText $_). Restricted kluc potrebuje opravnenie Account: Read (S12 kontrola uctu)." }
      if ($acct.id -notmatch "^acct_[A-Za-z0-9]+$") { Fail "Neplatne ID uctu." }
      Say "Ucet: $($acct.id) (zhoda s cenou profilu overena vyssie)"
      try { $ev = Invoke-RestMethod -Uri "https://api.stripe.com/v1/events?limit=1" -Headers $h -Method Get }
      catch { Fail "GET /v1/events zlyhal: $(Get-HttpErrorText $_). Restricted kluc potrebuje Events: Read." }
      $first = @($ev.data | ForEach-Object { $_ })[0]
      if ($first -and $first.livemode -ne $false) { Fail "Udalost nie je test mode." }
      Say "Udalosti: citanie OK (posledna livemode=$(if ($first) { $first.livemode } else { '-' }))"
      $cur = (Get-Rows "billing_event_cursors?provider=eq.stripe&environment=eq.test&select=account_ref,last_event_id,last_success_at,last_error_code,consecutive_failures")[0]
      if ($cur) {
        Say "Esblu kurzor: ucet=$($cur.account_ref) posledna=$($cur.last_event_id) uspech=$($cur.last_success_at) chyba=$($cur.last_error_code) zlyhania=$($cur.consecutive_failures)"
        if ($cur.account_ref -ne $acct.id) { Say "POZOR: kurzor patri inemu uctu ($($cur.account_ref)) -> dotahovanie vrati ACCOUNT_MISMATCH (ocakavane pri zmene sandboxu; reset kurzora iba vedome)." }
      } else { Say "Esblu kurzor: zatial nevznikol (prvy beh dotahovania = bootstrap)" }
      Say "OK: test mode, ucet a opravnenia na citanie uctu a udalosti."
    }
    "s12-events" {
      # Skutocne strankovanie Stripe: plny zoznam (od najnovsej) vs. prechod dopredu cez ending_before po 2.
      $h = @{ Authorization = "Bearer $k" }
      $all = @((Invoke-RestMethod -Uri "https://api.stripe.com/v1/events?limit=30" -Headers $h -Method Get).data | ForEach-Object { $_ })
      if ($all.Count -lt 6) { Fail "Malo udalosti ($($all.Count)) - spusti najprv clock-setup / renew." }
      $asc = @($all); [array]::Reverse($asc)
      $start = $asc[0]
      $cursor = $start.id; $walked = @()
      for ($i = 0; $i -lt 30; $i++) {
        $pg = Invoke-RestMethod -Uri "https://api.stripe.com/v1/events?limit=2&ending_before=$cursor" -Headers $h -Method Get
        $page = @($pg.data | ForEach-Object { $_ })
        if ($page.Count -eq 0) { break }
        [array]::Reverse($page)
        $walked += $page
        $cursor = $page[$page.Count - 1].id
        if (-not $pg.has_more) { break }
      }
      $expect = @($asc | Select-Object -Skip 1)
      $n = [Math]::Min($expect.Count, $walked.Count)
      for ($i = 0; $i -lt $n; $i++) {
        if ($walked[$i].id -ne $expect[$i].id) { Fail "Poradie sa lisi na pozicii $($i): $($walked[$i].id) vs $($expect[$i].id) (ending_before nevracia bezprostredne novsie udalosti)." }
        if ($i -gt 0 -and $walked[$i].created -lt $walked[$i - 1].created) { Fail "Udalosti nie su vzostupne podla casu." }
      }
      if ($walked.Count -lt $expect.Count) { Fail "Prechod dopredu nasiel $($walked.Count) z $($expect.Count) udalosti." }
      $dupes = @($walked | Group-Object id | Where-Object { $_.Count -gt 1 }).Count
      if ($dupes) { Fail "Duplicitne udalosti v prechode: $dupes." }
      Say "Stripe: $($all.Count) udalosti; prechod od najstarsej cez ending_before (strany po 2) = $($walked.Count) udalosti, rovnake poradie, bez medzier a duplicit"
      $badStatus = "200"
      try { Invoke-RestMethod -Uri "https://api.stripe.com/v1/events?limit=1&ending_before=evt_neexistuje000000000000" -Headers $h -Method Get | Out-Null }
      catch { $badStatus = (Get-HttpErrorText $_) }
      Say "Neexistujuci kurzor: $badStatus (Esblu ocakava 400/404 -> cursor_missing -> bootstrap)"
      if ($badStatus -notmatch "HTTP (400|404)") { Fail "Stripe pri neexistujucom kurzore nevratil 400/404 - upravit detekciu cursor_missing." }
      Say "OK: strankovanie a poradie zodpovedaju implementacii S12."
    }
    "s12-catchup" {
      # Prvy beh moze byt bootstrap realneho 30-dnoveho okna (limit 200 udalosti na beh) -> opakovat do "ok".
      $r1 = Invoke-Catchup
      for ($i = 0; $i -lt 10 -and $r1.result -eq "partial"; $i++) {
        Say "    ciastocny beh: processed=$($r1.processed) outcomes=$(($r1.outcomes | ConvertTo-Json -Compress)) -> pokracujem"
        $r1 = Invoke-Catchup
      }
      Say "Dotahovanie #1: result=$($r1.result) processed=$($r1.processed) outcomes=$(($r1.outcomes | ConvertTo-Json -Compress)) bootstrap=$($r1.bootstrap) cursorExpired=$($r1.cursorExpired) code=$($r1.code)"
      if (-not $r1.configured) { Fail "Dotahovanie nie je nakonfigurovane (ESBLU_BILLING_MODE / DB web_provider)." }
      if ($r1.result -ne "ok" -and $r1.result -ne "partial") { Fail "Dotahovanie skoncilo $($r1.result) ($($r1.code))." }
      $r2 = Invoke-Catchup
      Say "Dotahovanie #2: result=$($r2.result) processed=$($r2.processed) outcomes=$(($r2.outcomes | ConvertTo-Json -Compress))"
      $applied2 = if ($r2.outcomes.applied) { [int]$r2.outcomes.applied } else { 0 }
      if ($r1.result -eq "ok" -and $applied2 -ne 0) { Fail "Opakovany beh zmenil stav ($applied2 applied) - nie je idempotentny." }
      $cur = (Get-Rows "billing_event_cursors?provider=eq.stripe&environment=eq.test&select=account_ref,last_event_id,events_processed,last_success_at,last_error_code,consecutive_failures,lease_owner")[0]
      Say "Kurzor: ucet=$($cur.account_ref) posledna=$($cur.last_event_id) spracovanych=$($cur.events_processed) chyba=$($cur.last_error_code) zlyhania=$($cur.consecutive_failures) lease=$($cur.lease_owner)"
      if ($cur.lease_owner) { Fail "Lease ostal drzany po skonceni behu." }
      Say "OK: dotahovanie zo skutocneho Stripe API, opakovany beh bez zmeny."
    }
    "s12-cancel-at" {
      $st = Get-ClockState; $subId = if ($Subscription) { $Subscription } else { $st.subscription }
      $s = Get-Sub $subId
      if ($s.status -ne "active") { Fail "Predplatne $subId nie je active ($($s.status)) - spusti clock-setup." }
      $p = Get-Period $s
      $clock = Get-StripeJson @("test_helpers", "test_clocks", "retrieve", $st.clock)
      $cancelAt = [long]$clock.frozen_time + 3 * 86400
      if ($cancelAt -ge $p.end - 600) { Fail "Obdobie konci prilis skoro na test uprostred obdobia." }
      Invoke-Stripe @("subscriptions", "update", $subId, "-d", "cancel_at=$cancelAt", "-d", "proration_behavior=none") | Out-Null
      $s1 = Get-Sub $subId; $p1 = Get-Period $s1
      Say ("Stripe: cancel_at={0} cancel_at_period_end={1} obdobie {2} -> {3} (povodny koniec {4})" -f (Utc $s1.cancel_at), $s1.cancel_at_period_end, (Utc $p1.start), (Utc $p1.end), (Utc $p.end))
      $truncated = ($p1.end -ne $p.end)
      if ($truncated) { Say "ZISTENIE: Stripe skratil koniec obdobia na cancel_at -> Esblu to MUSI brat ako predcasny koniec (scheduled_end_at podla cancel_at_period_end=false)." }
      $acc = Wait-Esblu $subId { param($a) $a.scheduled_end_at } "ulozenie scheduled_end_at"
      $sched = [DateTime]::Parse($acc.scheduled_end_at).ToUniversalTime()
      if ($sched -ne [DateTimeOffset]::FromUnixTimeSeconds($cancelAt).UtcDateTime) { Fail "Esblu scheduled_end_at $($acc.scheduled_end_at) != cancel_at $(Utc $cancelAt)." }
      $ents = Get-Rows "company_entitlements?company_id=eq.$($acc.company_id)&source=eq.subscription&status=eq.active&select=valid_until"
      $okUntil = @($ents | Where-Object { [DateTime]::Parse($_.valid_until).ToUniversalTime() -eq $sched }).Count
      Say "Esblu: scheduled_end_at=$($acc.scheduled_end_at); naroky s valid_until = zvoleny datum: $okUntil / $($ents.Count)"
      if ($ents.Count -eq 0 -or $okUntil -ne $ents.Count) { Fail "Naroky nekoncia k zvolenemu datumu (bez 48 h)." }
      Move-Clock $st.clock ($cancelAt + 3600)
      $s2 = Get-Sub $subId
      for ($i = 0; $i -lt 30 -and $s2.status -ne "canceled"; $i++) { Start-Sleep -Seconds 3; $s2 = Get-Sub $subId }
      Say "Stripe po posune hodin: stav=$($s2.status) ended_at=$(if ($s2.ended_at) { Utc $s2.ended_at } else { '-' })"
      if ($s2.status -ne "canceled") { Fail "Stripe predplatne neukoncil k cancel_at." }
      $acc2 = Wait-Esblu $subId { param($a) $a.status -eq "canceled" } "ukoncenie k zvolenemu datumu"
      $n = Get-ActiveSubEnts $acc2.company_id
      Say "Esblu: stav=$($acc2.status), ucinnych narokov $n (ocakavane 0 - predcasny koniec bez 48 h)"
      if ($n -ne 0) { Fail "Po predcasnom konci ostali ucinne naroky." }
      Say "OK: cancel_at uprostred obdobia = pristup presne do datumu, po skonceni bez rezervy."
    }
    "s12-refund-missing" {
      if (-not (Test-Path $NoListenFile)) { Fail "Okno 1 musi bezat s -NoListen (webhook sa nesmie dorucit)." }
      $st = Get-ClockState; $subId = if ($Subscription) { $Subscription } else { $st.subscription }
      $sub = Get-Sub $subId
      if ($sub.status -ne "active") { Fail "Predplatne $subId nie je active." }
      $inv = (Get-PaidInvoices $subId) | Where-Object { $_.id -eq $sub.latest_invoice.id } | Select-Object -First 1
      if (-not $inv) { Fail "Aktualna faktura nie je zaplatena." }
      $pi = Get-InvoicePaymentIntent $inv
      Invoke-Stripe @("refunds", "create", "-d", "payment_intent=$pi") | Out-Null
      Say "Stripe: plna refundacia aktualnej faktury $($inv.id) (webhook sa NEdorucuje)"
      $acc = Wait-Esblu $subId { param($a) $a.status -eq "refunded" } "refundacia cez dotahovanie"
      $s = Get-Sub $subId
      for ($i = 0; $i -lt 20 -and $s.status -ne "canceled"; $i++) { Start-Sleep -Seconds 3; $s = Get-Sub $subId }
      $n = Get-ActiveSubEnts $acc.company_id
      Say "Esblu: stav=$($acc.status), ucinnych narokov $n; Stripe: $($s.status)"
      if ($s.status -ne "canceled" -or $n -ne 0) { Fail "Refundacia bez webhooku nebola uplne dotiahnuta." }
      $r = Invoke-Catchup
      $applied = if ($r.outcomes.applied) { [int]$r.outcomes.applied } else { 0 }
      Say "Opakovane dotahovanie: processed=$($r.processed) applied=$applied (refunded ostava: $((Get-EsbluAccount $subId).status))"
      if ((Get-EsbluAccount $subId).status -ne "refunded") { Fail "Stav sa zmenil po opakovanom dotahovani." }
      Say "OK: chybajuci webhook plnej refundacie dotiahnuty, pristup aj uctovanie ukoncene, opakovanie bez zmeny."
    }
    "s13-existing" {
      # Existujuce predplatne firmy E (z testu E1-E3), ziadne nove predplatne ani zakaznik.
      if (-not (Test-Path $NoListenFile)) { Fail "Okno 1 musi bezat s -NoListen (zmeny maju prist iba cez dotahovanie)." }
      $accE = (Get-Rows "subscription_accounts?company_id=eq.$CompanyE&select=provider_subscription_id,status")[0]
      $subId = if ($Subscription) { $Subscription } else { $accE.provider_subscription_id }
      if (-not $subId) { Fail "Firma E nema predplatne." }
      $s0 = Get-Sub $subId; $p0 = Get-Period $s0
      Say ("Stripe pred: {0} stav={1} cancel_at={2} cancel_at_period_end={3} obdobie {4} -> {5}" -f $subId, $s0.status, $(if ($s0.cancel_at) { Utc $s0.cancel_at } else { '-' }), $s0.cancel_at_period_end, (Utc $p0.start), (Utc $p0.end))
      if ($s0.status -ne "active") { Fail "Predplatne E nie je active ($($s0.status))." }
      $cancelAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 300
      Invoke-Stripe @("subscriptions", "update", $subId, "-d", "cancel_at=$cancelAt", "-d", "proration_behavior=none") | Out-Null
      $s1 = Get-Sub $subId; $p1 = Get-Period $s1
      Say ("Stripe po: cancel_at={0} cancel_at_period_end={1} obdobie {2} -> {3}" -f (Utc $s1.cancel_at), $s1.cancel_at_period_end, (Utc $p1.start), (Utc $p1.end))
      $truncated = ($p1.end -ne $p0.end)
      Say ("ZISTENIE S13: Stripe {0} koniec obdobia (povodny {1}, teraz {2}); cancel_at_period_end={3}" -f $(if ($truncated) { "SKRATIL" } else { "NESKRATIL" }), (Utc $p0.end), (Utc $p1.end), $s1.cancel_at_period_end)
      if ($s1.cancel_at_period_end -eq $true) { Fail "Stripe hlasi cancel_at_period_end=true pre datum uprostred obdobia - Esblu by to bralo ako riadny koniec (+48 h). OPRAVA NUTNA." }
      $acc = Wait-Esblu $subId { param($a) $a.scheduled_end_at } "ulozenie scheduled_end_at (dotahovanie)"
      $sched = [DateTime]::Parse($acc.scheduled_end_at).ToUniversalTime()
      if ($sched -ne [DateTimeOffset]::FromUnixTimeSeconds($cancelAt).UtcDateTime) { Fail "Esblu scheduled_end_at $($acc.scheduled_end_at) != cancel_at $(Utc $cancelAt)." }
      $ents = Get-Rows "company_entitlements?company_id=eq.$($acc.company_id)&source=eq.subscription&status=eq.active&select=valid_until"
      $okUntil = @($ents | Where-Object { [DateTime]::Parse($_.valid_until).ToUniversalTime() -eq $sched }).Count
      Say "Esblu: scheduled_end_at=$($acc.scheduled_end_at); naroky do zvoleneho datumu: $okUntil / $($ents.Count) (bez 48 h)"
      if ($ents.Count -eq 0 -or $okUntil -ne $ents.Count) { Fail "Naroky nekoncia k zvolenemu datumu." }
      Say "Cakam, kym Stripe predplatne ukonci (cancel_at $(Utc $cancelAt), max 30 min)..."
      $s2 = Get-Sub $subId
      for ($i = 0; $i -lt 60 -and $s2.status -ne "canceled"; $i++) { Start-Sleep -Seconds 30; $s2 = Get-Sub $subId; if ($i % 4 -eq 3) { Say "    stav $($s2.status) ($(Get-Date -Format HH:mm:ss))" } }
      if ($s2.status -ne "canceled") { Fail "Stripe predplatne do 30 min po cancel_at neukoncil." }
      Say ("Stripe: canceled, ended_at={0} (cancel_at {1}, koniec obdobia {2})" -f (Utc $s2.ended_at), (Utc $cancelAt), (Utc (Get-Period $s2).end))
      $acc2 = Wait-Esblu $subId { param($a) $a.status -eq "canceled" } "ukoncenie (dotahovanie customer.subscription.deleted)"
      $n = Get-ActiveSubEnts $acc2.company_id
      Say "Esblu: stav=$($acc2.status), scheduled_end_at=$($acc2.scheduled_end_at), ucinnych narokov $n (ocakavane 0)"
      if ($n -ne 0) { Fail "Po predcasnom konci ostali ucinne naroky (riziko +48 h)." }
      $r = Invoke-Catchup
      Say "Opakovane dotahovanie: processed=$($r.processed) outcomes=$(($r.outcomes | ConvertTo-Json -Compress)); Esblu stav=$((Get-EsbluAccount $subId).status)"
      if ((Get-EsbluAccount $subId).status -ne "canceled") { Fail "Stav sa zmenil po opakovanom dotahovani." }
      Say "OK: S13 na skutocnom Stripe - predcasny koniec bez 48 h, zmeny dorucene iba dotahovanim."
    }
    "s17" { Invoke-S17 }
    "s17-cleanup" { Invoke-S17Cleanup }
    "status" {
      $subId = if ($Subscription) { $Subscription } elseif (Test-Path $ClockFile) { (Get-ClockState).subscription } else { "" }
      if (-not $subId) { $subId = (Get-StripeJson @("subscriptions", "list", "--limit", "1", "-d", "status=all")).data[0].id }
      $s = Get-Sub $subId; $p = Get-Period $s; $li = $s.latest_invoice
      Say "Stripe: $subId stav=$($s.status) cancel_at_period_end=$($s.cancel_at_period_end) obdobie $(Utc $p.start) -> $(Utc $p.end)"
      if ($li) { Say "Stripe: posledna faktura $($li.id) $($li.billing_reason) stav=$($li.status) suma=$($li.amount_due/100) $($li.currency) vytvorena $(Utc $li.created)" }
      $acc = Get-EsbluAccount $subId
      if ($acc) { Say "Esblu: stav=$($acc.status) plan=$($acc.plan_code) koniec=$($acc.current_period_end) cancel=$($acc.cancel_at_period_end)" } else { Say "Esblu: ucet pre $subId nenajdeny" }
      Show-Logs
    }
  }
  exit 0
}

# ----------------------------------------------------------------------------- start (okno 1)
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo
Say "Repozitar: $Repo"
# S17: z akeho kodu bezi Esblu v tomto okne (okno 2 -Step s17 to porovna s origin/main; iba lokalny git, bez siete).
try {
  $hi = Get-S17HeadInfo
  Say ("HEAD: {0} | origin/main: {1} | aplikacny kod = {2}: {3}" -f $hi.head, $(if ($hi.origin_main) { $hi.origin_main } else { "-" }), $S17ExpectedMain.Substring(0, 7), $(if ($hi.app_matches) { "ANO" } else { "NIE" }))
  if (-not $hi.app_matches) { Say "    POZOR: -Step s17 vyzaduje checkout s aplikacnym kodom origin/main $($S17ExpectedMain.Substring(0, 7)) (docs par. 8.14)." }
  [ordered]@{ head = $hi.head; repo = $Repo; app_matches = $hi.app_matches; started_at = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json | Set-Content -Path $HeadFile -Encoding ASCII
} catch { Say "HEAD: nezistene ($($_.Exception.Message))"; Remove-Item $HeadFile -Force -ErrorAction SilentlyContinue }
foreach ($f in @(".env", ".env.local", ".env.development", ".env.development.local")) {
  if ((Test-Path $f) -and (Select-String -Path $f -Pattern $ProdRef -Quiet)) { Fail "$f odkazuje na PRODUKCNY Supabase ($ProdRef). Premenuj ho pred testom." }
}
# Stare logy mohli obsahovat predchadzajuce podpisove tajomstvo -> zmazat.
Remove-Item (Join-Path $StateDir "listen*.log") -Force -ErrorAction SilentlyContinue

Say "1/5 Stripe CLI (profil '$Project') a testovaci kluc..."
if (-not $PriceId) { Fail "Pre profil '$Project' chyba cena - spusti najprv -Step new-sandbox -Email <adresa>." }
$StripeKey = Get-StripeTestKey
Assert-StripeAccount $StripeKey

if ($NoListen) {
  # Bez stripe listen sa ziadny whsec_ uctu necita (esblu-qa2: zverejneny). Lokalny webhook dostane nahodne
  # jednorazove tajomstvo -> overovanie podpisu ostava zapnute a kazde volanie bez neho skonci 400.
  Say "2/5 -NoListen: whsec_ uctu sa necita; lokalny webhook ma nahodne jednorazove tajomstvo (podpis sa overuje)"
  $rngW = [Security.Cryptography.RandomNumberGenerator]::Create(); $bufW = New-Object byte[] 32; $rngW.GetBytes($bufW)
  $WhSec = "whsec_" + ([BitConverter]::ToString($bufW) -replace "-", "").ToLower()
} else {
Say "2/5 Podpisove tajomstvo stripe listen (viazane na sandbox profilu '$Project')..."
$WhSec = Get-ListenSecret $StripeCli
if (-not $WhSec) { Fail "stripe listen --print-secret nevratil whsec_." }
$newHash = Get-Sha256 $WhSec
if (@(Get-ExposedHashes) -contains $newHash) {
  Fail "Profil '$Project' pouziva VYSTAVENE tajomstvo. Vytvor novy sandbox: -Step new-sandbox -Email <adresa>."
}
if (@(Get-ExposedHashes).Count -eq 0) { Fail "Chyba odtlacok vystaveneho tajomstva - spusti najprv -Step new-sandbox -Email <adresa>." }
Say "    tajomstvo whsec_*** (SHA-256 $($newHash.Substring(0,8))...) - lisi sa od vystaveneho"
}

Say "3/5 Staging Supabase service role kluc (esblu-test)."
Say "    Supabase Dashboard -> projekt esblu-test -> Project Settings -> API Keys -> service_role (secret)."
$ServiceRole = Get-ServiceRole
# READ-ONLY overenie stagingu (URL esblu-test, service_role, billing environment=test) pred spustenim Esblu proti nemu.
$null = Assert-StagingAccess

# Iba premenne TOHTO procesu (dedi ich Next.js a nikam sa neukladaju).
$env:NEXT_PUBLIC_SUPABASE_URL = $StagingUrl
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = $StagingAnon
$env:SUPABASE_SERVICE_ROLE_KEY = $ServiceRole
$env:ESBLU_BILLING_MODE = "stripe_test"
$env:STRIPE_SECRET_KEY = $StripeKey
$env:STRIPE_WEBHOOK_SECRET = $WhSec
$env:ESBLU_BILLING_RETURN_ORIGIN = "http://localhost:$Port"
$env:NEXT_PUBLIC_ESBLU_BILLING_UI = "1"
# Lokalny CRON_SECRET pre reconciliation (nahodny, iba pocas behu; subor sa zmaze pri ukonceni).
$rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $buf = New-Object byte[] 32; $rng.GetBytes($buf)
$env:CRON_SECRET = ([BitConverter]::ToString($buf) -replace "-", "").ToLower()
Set-Content -Path $CronFile -Value $env:CRON_SECRET -Encoding ASCII
Remove-Item Env:VERCEL_ENV -ErrorAction SilentlyContinue

Say "4/5 Zavislosti..."
if (-not (Test-Path "node_modules\.bin\next.cmd")) { npm ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { Fail "npm ci zlyhal" } }

$listen = $null
if ($NoListen) {
  Set-Content -Path $NoListenFile -Value "1" -Encoding ASCII
  Remove-Item $ListenPidFile -Force -ErrorAction SilentlyContinue
  Say "5/5 BEZ stripe listen (-NoListen): webhooky sa nedorucia, synchronizacia iba cez /api/cron/billing-stripe-events"
} else {
  Remove-Item $NoListenFile -Force -ErrorAction SilentlyContinue
  Say "5/5 stripe listen -> http://localhost:$Port/api/billing/webhooks/stripe"
  $lArgs = @("listen", "--events", $Events, "--forward-to", "http://localhost:$Port/api/billing/webhooks/stripe") + $StripeProfileArgs
  if ($StripeCliBase[0] -eq "npx") { $lExe = "npx.cmd"; $lArgs = @(Get-CliRest $StripeCliBase) + $lArgs } else { $lExe = $StripeCliBase[0] }
  $listen = Start-Process -FilePath $lExe -ArgumentList $lArgs `
    -RedirectStandardOutput (Join-Path $StateDir "listen.out.log") -RedirectStandardError (Join-Path $StateDir "listen.log") -NoNewWindow -PassThru
  Set-Content -Path $ListenPidFile -Value $listen.Id -Encoding ASCII   # S17 (okno 2) zastavi listen pre test zmeskanej udalosti
}

Say ""
Say "=================================================================="
Say " Esblu bezi lokalne so Stripe SANDBOX a staging DB."
Say " Ked sa nizsie objavi 'Ready', otvor: http://localhost:$Port/login"
Say " Stav a logy (zamaskovane): -Step status v druhom okne."
Say " Ukoncenie: Ctrl+C (zastavi aj stripe listen a zmaze logy)."
Say "=================================================================="
try {
  npx next dev -p $Port
} finally {
  # cely strom (npx.cmd -> node -> stripe), nie iba prvy proces
  if ($listen -and -not $listen.HasExited) { $ErrorActionPreference = "Continue"; & taskkill.exe /PID $listen.Id /T /F 2>&1 | Out-Null }
  Remove-Item (Join-Path $StateDir "listen*.log"), $CronFile, $NoListenFile, $ListenPidFile, $HeadFile -Force -ErrorAction SilentlyContinue
  Remove-Item Env:CRON_SECRET, Env:STRIPE_SECRET_KEY, Env:STRIPE_API_KEY, Env:STRIPE_WEBHOOK_SECRET, Env:SUPABASE_SERVICE_ROLE_KEY, Env:ESBLU_QA_SERVICE_ROLE -ErrorAction SilentlyContinue
  Say "Zastavene."
}
