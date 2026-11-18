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
      status       - stav v Stripe aj v Esblu + posledne riadky stripe listen (tajomstva zamaskovane)
    Kazdy krok vypise OK AZ ked je vysledok overeny v Stripe AJ v testovacej DB Esblu.

  Bezpecnost:
  - Stripe kluc sa cita z profilu Stripe CLI, nikdy sa nevypisuje. Iba test mode (sk_/rk_/rkcs_test_).
  - Webhook secret zo `stripe listen` je viazany na Stripe UCET (sandbox), nie na zariadenie. Novy secret
    = novy sandbox (-Step new-sandbox). Skript porovnava iba SHA-256 s odtlackom vystaveneho tajomstva
    (exposed.sha256) a nespusti sa, kym sa zhoduju. Stare logy sa mazu.
  - Vsetky vypisy prechadzaju maskovanim (whsec_*, *_test_*, *_live_*, JWT).
  - Staging service role kluc: skryte zadanie (Read-Host) alebo $env:ESBLU_QA_SERVICE_ROLE v okne 2.
  - Databaza: Supabase staging `cjbdijbbcujvmrzezusd` (esblu-test). Produkcia sa nepouziva.
#>
param(
  [ValidateSet("start", "status", "new-sandbox", "clock-setup", "renew", "fail-renew", "fix-payment", "refund-partial", "refund-full")]
  [string]$Step = "start",
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
$CompanyD = "5a5a0000-0000-4000-8000-0000000000d0"              # QA-STRIPE D (test clock)
$OwnerD = "5a5a0000-0000-4000-8000-000000000031"
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

function Get-StripeTestKey {
  $testRe = "(?:sk|rk|rkcs)_test_[A-Za-z0-9]+"
  $liveRe = "(?:sk|rk|rkcs)_live_"
  if ($env:STRIPE_API_KEY) {
    if ($env:STRIPE_API_KEY -match "^$liveRe") { Fail "STRIPE_API_KEY je LIVE kluc - skript pracuje iba s test mode." }
    if ($env:STRIPE_API_KEY -match "^$testRe$") { Say "    kluc: STRIPE_API_KEY (test mode)"; return $env:STRIPE_API_KEY }
  }
  $cfg = Invoke-Stripe @("config", "--list")
  if ($cfg -match "test_mode_api_key\s*=\s*['`"]?$liveRe") { Fail "V profile je LIVE kluc - skript pracuje iba s test mode." }
  $m = [regex]::Match($cfg, "test_mode_api_key\s*=\s*['`"]?($testRe)")
  if (-not $m.Success) { Fail "V aktualnom profile Stripe CLI nie je testovaci kluc (sk_test_/rk_test_/rkcs_test_)." }
  $prefix = $m.Groups[1].Value.Substring(0, $m.Groups[1].Value.IndexOf("_test_") + 6)
  Say "    kluc: profil Stripe CLI ($prefix***)"
  return $m.Groups[1].Value
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

function Invoke-Staging([string]$method, [string]$path, $body = $null) {
  $k = Get-ServiceRole
  $h = @{ apikey = $k; Authorization = "Bearer $k"; Prefer = "return=representation" }
  $u = "$StagingUrl/rest/v1/$path"
  if ($body -ne $null) { return Invoke-RestMethod -Uri $u -Headers $h -Method $method -ContentType "application/json" -Body ($body | ConvertTo-Json -Compress) }
  return Invoke-RestMethod -Uri $u -Headers $h -Method $method
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
  $u = "$StagingUrl/rest/v1/subscription_accounts?provider_subscription_id=eq.$subId&select=status,plan_code,current_period_end,cancel_at_period_end,company_id"
  $rows = Invoke-RestMethod -Uri $u -Headers $h -Method Get
  if ($rows -and $rows.Count -gt 0) { return $rows[0] } else { return $null }
}

function Wait-Esblu([string]$subId, [scriptblock]$ok, [string]$what) {
  for ($i = 0; $i -lt 40; $i++) {
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
  Get-StripeTestKey | Out-Null
  if (-not $PriceId) { Fail "Pre profil '$Project' chyba cena - spusti najprv -Step new-sandbox -Email <adresa>." }
  # Kluc musi patrit sandboxu, v ktorom existuje $PriceId (ceny su viazane na ucet) -> inak koniec.
  $pr = Get-StripeJson @("prices", "retrieve", $PriceId)
  if ($pr.livemode -or $pr.id -ne $PriceId) { Fail "Cena $PriceId nie je v sandboxe aktualneho kluca." }
  Say "    sandbox OK: kluc vidi cenu $PriceId ($($pr.unit_amount/100) $($pr.currency.ToUpper()) / $($pr.recurring.interval))"
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
$price = Get-StripeJson @("prices", "retrieve", $PriceId)
if ($price.livemode) { Fail "Cena je live - koniec." }
Say "    cena $PriceId = $($price.unit_amount/100) $($price.currency.ToUpper()) / $($price.recurring.interval)  (livemode=false)"

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
Remove-Item Env:VERCEL_ENV -ErrorAction SilentlyContinue

Say "4/5 Zavislosti..."
if (-not (Test-Path "node_modules\.bin\next.cmd")) { npm ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { Fail "npm ci zlyhal" } }

Say "5/5 stripe listen -> http://localhost:$Port/api/billing/webhooks/stripe"
$listen = Start-Process -FilePath "npx.cmd" -ArgumentList @("--yes", "@stripe/cli@1.55.12", "--project-name", $Project, "listen", "--events", $Events, "--forward-to", "http://localhost:$Port/api/billing/webhooks/stripe") `
  -RedirectStandardOutput (Join-Path $StateDir "listen.out.log") -RedirectStandardError (Join-Path $StateDir "listen.log") -NoNewWindow -PassThru

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
  Remove-Item (Join-Path $StateDir "listen*.log") -Force -ErrorAction SilentlyContinue
  Remove-Item Env:STRIPE_SECRET_KEY, Env:STRIPE_WEBHOOK_SECRET, Env:SUPABASE_SERVICE_ROLE_KEY, Env:ESBLU_QA_SERVICE_ROLE -ErrorAction SilentlyContinue
  Say "Zastavene."
}
