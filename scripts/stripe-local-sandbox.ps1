<#
  Esblu - lokalny test predplatneho cez Stripe SANDBOX (test mode) + staging DB esblu-test.

  Okno 1 (Esblu + stripe listen):
    powershell -ExecutionPolicy Bypass -File .\scripts\stripe-local-sandbox.ps1
  Okno 2 (scenare):
    powershell -ExecutionPolicy Bypass -File .\scripts\stripe-local-sandbox.ps1 -Step <krok> [-CheckoutId <uuid>] [-Subscription <sub_...>]
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
    Kazdy krok vypise OK AZ ked je vysledok overeny v Stripe AJ v testovacej DB Esblu.

  Bezpecnost:
  - Stripe kluc: $env:STRIPE_API_KEY -> profil CLI -> skryta vyzva (po prevzati sandboxu). Nikdy sa nevypisuje.
    Overenie: kluc vidi cenu profilu (spravny ucet) a ma pristup k Test Clocks. Iba test mode.
  - Webhook secret zo `stripe listen` je viazany na Stripe UCET (sandbox), nie na zariadenie. Novy secret
    = novy sandbox (-Step new-sandbox). Skript porovnava iba SHA-256 s odtlackom vystaveneho tajomstva
    (exposed.sha256) a nespusti sa, kym sa zhoduju. Stare logy sa mazu.
  - Vsetky vypisy prechadzaju maskovanim (whsec_*, *_test_*, *_live_*, JWT).
  - Staging service role kluc: skryte zadanie (Read-Host) alebo $env:ESBLU_QA_SERVICE_ROLE v okne 2.
  - Databaza: Supabase staging `cjbdijbbcujvmrzezusd` (esblu-test). Produkcia sa nepouziva.
#>
param(
  [ValidateSet("start", "status", "new-sandbox", "clock-setup", "renew", "fail-renew", "fix-payment", "refund-partial", "refund-full",
               "refund-old", "refund-current", "reconcile", "advance-check", "verify-terminal", "qa-login", "qa-check",
               "s12-account", "s12-events", "s12-catchup", "s12-cancel-at", "s12-refund-missing", "s13-existing")]
  [string]$Step = "start",
  # Okno 1 BEZ stripe listen: ziadny webhook sa nedoruci, synchronizacia iba cez dotahovanie (S12).
  [switch]$NoListen,
  [string]$Project = "esblu-qa2",
  [string]$Email = "",
  [string]$CheckoutId = "",
  [string]$Subscription = "",
  [int]$Port = 3000
)
$ErrorActionPreference = "Stop"

$StripeCliBase = @("npx", "--yes", "@stripe/cli@1.55.12")
# Samostatny profil Stripe CLI pre QA sandbox (default profil = povodny sandbox s vystavenym tajomstvom).
$StripeCli = $StripeCliBase + @("--project-name", $Project)
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
$CompanyD = "5a5a0000-0000-4000-8000-0000000000d0"              # QA-STRIPE D (test clock)
$OwnerD = "5a5a0000-0000-4000-8000-000000000031"
$CompanyE = "5a5a0000-0000-4000-8000-0000000000e0"              # QA-STRIPE E (dve karty + zrusenie v aplikacii)
$OwnerE = "5a5a0000-0000-4000-8000-000000000041"
$OwnerEEmail = "qa-stripe-e-owner@example.invalid"
$PriceId = $null
if (Test-Path $SandboxFile) { $PriceId = (Get-Content $SandboxFile -Raw | ConvertFrom-Json).price }
$Events = @(
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "checkout.session.expired", "customer.subscription.created", "customer.subscription.updated",
  "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required",
  "charge.refunded", "charge.dispute.created", "charge.dispute.closed"
) -join ","
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# ----------------------------------------------------------------------------- pomocne funkcie
function Hide-Secrets([string]$s) {
  if (-not $s) { return $s }
  $s = $s -replace "whsec_[A-Za-z0-9]+", "whsec_***"
  $s = $s -replace "((?:sk|rk|rkcs|pk)_(?:test|live)_)[A-Za-z0-9]+", '$1***'
  $s = $s -replace "eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "eyJ***"
  return $s
}
function Say([string]$s) { Write-Host (Hide-Secrets $s) }
function Fail([string]$s) { throw (Hide-Secrets $s) }
function Format-Eur([long]$minor, [string]$cur = "EUR") {
  # Sumy sa porovnavaju v centoch (long); zobrazenie 1590 -> "15,90 EUR".
  $sign = if ($minor -lt 0) { "-" } else { "" }; $a = [Math]::Abs($minor)
  return ("{0}{1},{2:D2} {3}" -f $sign, [Math]::Floor($a / 100), ($a % 100), $cur.ToUpper())
}
function Utc([long]$ts) { return [DateTimeOffset]::FromUnixTimeSeconds($ts).UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss 'UTC'") }

function Invoke-Stripe([string[]]$StripeArgs) {
  $cmd = $StripeCli[0]; $rest = $StripeCli[1..($StripeCli.Length - 1)] + $StripeArgs
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

function Get-Rows([string]$path) {
  # Windows PowerShell 5.1: Invoke-RestMethod vrati JSON pole ako JEDEN objekt (nerozbaleny).
  # @(...) by potom malo vzdy Count = 1 (aj pre prazdne pole) -> rozbalit cez ForEach-Object.
  return @(Invoke-Staging "GET" $path | ForEach-Object { $_ })
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
  if ($env:STRIPE_API_KEY) {
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
    $sec = Read-Host -AsSecureString "    Vloz testovaci Secret key (nezobrazi sa)"
    $key = ([Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))).Trim()
    if ($key -match "^$liveRe") { Fail "Zadany kluc je LIVE - skript pracuje iba s test mode." }
    if ($key -notmatch "^$testRe$") { Fail "Zadany kluc nie je testovaci Stripe kluc (sk_test_/rk_test_/rkcs_test_)." }
    $src = "skryta vyzva"
  }
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
  Say "    ucet OK: kluc vidi cenu $PriceId (15,90 EUR / mesiac, test) a ma pristup k Test Clocks"
}

function Get-Sha256([string]$s) {
  $sha = [Security.Cryptography.SHA256]::Create()
  return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s))) -replace "-", "").ToLower()
}

function Get-ServiceRole {
  if ($env:ESBLU_QA_SERVICE_ROLE) { $k = $env:ESBLU_QA_SERVICE_ROLE }
  else {
    $sec = Read-Host -AsSecureString "Staging service_role kluc (esblu-test, nezobrazi sa)"
    $k = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
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
  # Bez kontroly chyb (napr. prazdny profil); vystup sa nikdy nevypisuje priamo.
  $cmd = $cli[0]; $rest = $cli[1..($cli.Length - 1)] + $StripeArgs
  $ErrorActionPreference = "Continue"
  return ((& $cmd @rest 2>&1 | ForEach-Object { "$_" }) | Out-String)
}
function Get-ListenSecret([string[]]$cli) {
  return [regex]::Match((Invoke-StripeRaw $cli @("listen", "--print-secret")), "whsec_[A-Za-z0-9]+").Value
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

# ----------------------------------------------------------------------------- scenare (okno 2)
if ($Step -eq "new-sandbox") {
  if ($Email -notmatch "^[^@\s]+@[^@\s]+\.[^@\s]+$") { Fail "Zadaj -Email <adresa> (predvyplni registraciu pri neskorsom claim)." }
  # 1) Odtlacok VYSTAVENEHO tajomstva = secret povodneho (default) profilu CLI.
  $exposed = Get-ListenSecret $StripeCliBase
  if ($exposed) { Set-Content -Path $ExposedFile -Value (Get-Sha256 $exposed) -Encoding ASCII; Say "    odtlacok vystaveneho tajomstva ulozeny (SHA-256 $((Get-Sha256 $exposed).Substring(0,8))...)" }
  elseif (-not (Test-Path $ExposedFile)) { Fail "Neviem urcit vystavene tajomstvo (default profil bez kluca)." }
  # 2) Novy profil musi byt prazdny, inak by `sandboxes create` iba otvoril Dashboard povodneho uctu.
  $cfg = Invoke-StripeRaw $StripeCli @("config", "--list")
  if ($cfg -match "(?:sk|rk|rkcs)_test_") { Fail "Profil '$Project' uz ma kluc. Pouzi iny -Project (napr. esblu-qa3)." }
  Say "1/4 Novy anonymny sandbox v profile '$Project'..."
  Invoke-Stripe @("sandboxes", "create", "--email", $Email, "--non-interactive") | Out-Null
  Get-StripeTestKey | Out-Null
  # 3) Novy ucet => nove tajomstvo; musi sa lisit od vystaveneho.
  $w = Get-ListenSecret $StripeCli
  if (-not $w) { Fail "stripe listen --print-secret v novom profile nevratil whsec_." }
  if ((Get-Sha256 $w) -eq (Get-Content $ExposedFile -Raw).Trim()) { Fail "Novy sandbox ma rovnake tajomstvo ako vystavene - sandbox nevznikol." }
  Say "2/4 nove tajomstvo whsec_*** sa lisi od vystaveneho (SHA-256 $((Get-Sha256 $w).Substring(0,8))...)"
  # 4) Cena Esblu Komplet 15,90 EUR / mesiac v novom sandboxe.
  $price = Get-StripeJson @("prices", "create", "-d", "currency=eur", "-d", "unit_amount=1590", "-d", "recurring[interval]=month", "-d", "product_data[name]=Esblu Komplet (test)")
  if ($price.livemode) { Fail "Cena je live." }
  @{ price = $price.id; created = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -Path $SandboxFile -Encoding ASCII
  Say "3/4 cena $($price.id) = 15,90 EUR / mesiac"
  # 5) Mapovanie ceny na stagingu (iba test): stara cena neaktivna, nova aktivna.
  Invoke-Staging "PATCH" "billing_provider_prices?provider=eq.stripe&environment=eq.test&plan_code=eq.esblu_complete&billing_interval=eq.month&active=eq.true" @{ active = $false } | Out-Null
  Invoke-Staging "POST" "billing_provider_prices" @{ provider = "stripe"; environment = "test"; plan_code = "esblu_complete"; billing_interval = "month"; provider_price_id = $price.id; active = $true } | Out-Null
  Say "4/4 staging: esblu_complete/month -> $($price.id)"
  Say "OK: novy sandbox pripraveny (profil '$Project'). Spusti okno 1 znova."
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
foreach ($f in @(".env", ".env.local", ".env.development", ".env.development.local")) {
  if ((Test-Path $f) -and (Select-String -Path $f -Pattern $ProdRef -Quiet)) { Fail "$f odkazuje na PRODUKCNY Supabase ($ProdRef). Premenuj ho pred testom." }
}
# Stare logy mohli obsahovat predchadzajuce podpisove tajomstvo -> zmazat.
Remove-Item (Join-Path $StateDir "listen*.log") -Force -ErrorAction SilentlyContinue

Say "1/5 Stripe CLI (profil '$Project') a testovaci kluc..."
if (-not $PriceId) { Fail "Pre profil '$Project' chyba cena - spusti najprv -Step new-sandbox -Email <adresa>." }
$StripeKey = Get-StripeTestKey
Assert-StripeAccount $StripeKey

Say "2/5 Podpisove tajomstvo stripe listen (viazane na sandbox profilu '$Project')..."
$WhSec = Get-ListenSecret $StripeCli
if (-not $WhSec) { Fail "stripe listen --print-secret nevratil whsec_." }
$newHash = Get-Sha256 $WhSec
if ((Test-Path $ExposedFile) -and ($newHash -eq (Get-Content $ExposedFile -Raw).Trim())) {
  Fail "Profil '$Project' pouziva VYSTAVENE tajomstvo. Vytvor novy sandbox: -Step new-sandbox -Email <adresa>."
}
if (-not (Test-Path $ExposedFile)) { Fail "Chyba odtlacok vystaveneho tajomstva - spusti najprv -Step new-sandbox -Email <adresa>." }
Say "    tajomstvo whsec_*** (SHA-256 $($newHash.Substring(0,8))...) - lisi sa od vystaveneho"

Say "3/5 Staging Supabase service role kluc (esblu-test)."
Say "    Supabase Dashboard -> projekt esblu-test -> Project Settings -> API Keys -> service_role (secret)."
$ServiceRole = Get-ServiceRole

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
  Say "5/5 BEZ stripe listen (-NoListen): webhooky sa nedorucia, synchronizacia iba cez /api/cron/billing-stripe-events"
} else {
  Remove-Item $NoListenFile -Force -ErrorAction SilentlyContinue
  Say "5/5 stripe listen -> http://localhost:$Port/api/billing/webhooks/stripe"
  $listen = Start-Process -FilePath "npx.cmd" -ArgumentList @("--yes", "@stripe/cli@1.55.12", "--project-name", $Project, "listen", "--events", $Events, "--forward-to", "http://localhost:$Port/api/billing/webhooks/stripe") `
    -RedirectStandardOutput (Join-Path $StateDir "listen.out.log") -RedirectStandardError (Join-Path $StateDir "listen.log") -NoNewWindow -PassThru
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
  if ($listen -and -not $listen.HasExited) { Stop-Process -Id $listen.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item (Join-Path $StateDir "listen*.log"), $CronFile, $NoListenFile -Force -ErrorAction SilentlyContinue
  Remove-Item Env:CRON_SECRET, Env:STRIPE_SECRET_KEY, Env:STRIPE_API_KEY, Env:STRIPE_WEBHOOK_SECRET, Env:SUPABASE_SERVICE_ROLE_KEY, Env:ESBLU_QA_SERVICE_ROLE -ErrorAction SilentlyContinue
  Say "Zastavene."
}
