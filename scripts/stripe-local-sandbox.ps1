<#
  Esblu - lokalny test predplatneho cez Stripe SANDBOX (test mode) + staging DB esblu-test.

  Spustenie (PowerShell, z korena repozitara alebo odkialkolvek):
    powershell -ExecutionPolicy Bypass -File .\scripts\stripe-local-sandbox.ps1
  Scenare v druhom okne (po nakupe):
    powershell -ExecutionPolicy Bypass -File .\scripts\stripe-local-sandbox.ps1 -Step renew
      Kroky: status | renew | fail-renew | fix-payment | refund-partial | refund-full

  Bezpecnost:
  - Stripe kluc sa cita z profilu Stripe CLI (sandbox z `stripe sandboxes create`), webhook secret
    z `stripe listen --print-secret`; staging service role kluc sa zadava skryto (Read-Host).
    Vsetko ostava iba v premennych tohto procesu - nic sa nezapisuje na disk ani do repozitara.
  - Iba test mode: skript odmietne sk_live_/rk_live_ kluc a produkcny Supabase ref.
  - Databaza: Supabase staging `cjbdijbbcujvmrzezusd` (esblu-test). Produkcia sa nepouziva.
#>
param(
  [ValidateSet("start", "status", "renew", "fail-renew", "fix-payment", "refund-partial", "refund-full")]
  [string]$Step = "start",
  [int]$Port = 3000
)
$ErrorActionPreference = "Stop"

$StripeCli = @("npx", "--yes", "@stripe/cli@1.55.12")
$StagingRef = "cjbdijbbcujvmrzezusd"
$ProdRef = "fkpgvgvsmbpieduoatrt"
$StagingUrl = "https://$StagingRef.supabase.co"
# Verejny (anon) kluc stagingu - nie je tajny (je v kazdom klientskom bundli).
$StagingAnon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqYmRpamJiY3Vqdm1yemV6dXNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NTMxMDgsImV4cCI6MjEwMjEyOTEwOH0.gxhb1j2a5lmQnkeDHYOD2KEAe_zN44p-nSDUqIqkJbM"
$PriceId = "price_1UdBoJB5dmk5ax59ZKBBoWfY"   # Esblu Komplet (test) 15,90 EUR / mesiac
$Events = @(
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "checkout.session.expired", "customer.subscription.created", "customer.subscription.updated",
  "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required",
  "charge.refunded", "charge.dispute.created", "charge.dispute.closed"
) -join ","

function Invoke-Stripe([string[]]$StripeArgs) {
  $cmd = $StripeCli[0]; $rest = $StripeCli[1..($StripeCli.Length - 1)] + $StripeArgs
  # Windows PowerShell 5.1: stderr nativneho prikazu pri 2>&1 nesmie ukoncit skript.
  $ErrorActionPreference = "Continue"
  $out = & $cmd @rest 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw "stripe $($StripeArgs -join ' ') zlyhal:`n$out" }
  return ($out | Out-String)
}
function Get-StripeJson([string[]]$StripeArgs) {
  # npx / CLI moze pridat riadky (napr. upozornenie na novu verziu) - JSON je od prvej { po poslednu }.
  $text = Invoke-Stripe $StripeArgs
  $a = $text.IndexOf("{"); $b = $text.LastIndexOf("}")
  if ($a -lt 0 -or $b -le $a) { throw "Stripe CLI nevratil JSON pre: $($StripeArgs -join ' ')" }
  return ($text.Substring($a, $b - $a + 1) | ConvertFrom-Json)
}

function Get-StripeTestKey {
  # Kluc sa NIKDY nevypisuje. Poradie: STRIPE_API_KEY (ak je nastaveny) -> aktualny profil Stripe CLI.
  # Prefixy: sk_test_ / rk_test_ / rkcs_test_ (restricted kluc claimable sandboxu).
  $testRe = "(?:sk|rk|rkcs)_test_[A-Za-z0-9]+"
  $liveRe = "(?:sk|rk|rkcs)_live_"
  if ($env:STRIPE_API_KEY) {
    if ($env:STRIPE_API_KEY -match "^$liveRe") { throw "STRIPE_API_KEY je LIVE kluc - skript pracuje iba s test mode." }
    if ($env:STRIPE_API_KEY -match "^$testRe$") { Write-Host "    kluc: STRIPE_API_KEY (test mode)"; return $env:STRIPE_API_KEY }
  }
  $cfg = Invoke-Stripe @("config", "--list")
  if ($cfg -match "test_mode_api_key\s*=\s*['`"]?$liveRe") { throw "V profile je LIVE kluc - skript pracuje iba s test mode." }
  $m = [regex]::Match($cfg, "test_mode_api_key\s*=\s*['`"]?($testRe)")
  if (-not $m.Success) {
    throw "V aktualnom profile Stripe CLI nie je testovaci kluc (sk_test_/rk_test_/rkcs_test_). Over: npx @stripe/cli@1.55.12 config --list (kluc nikam nekopiruj)."
  }
  $prefix = $m.Groups[1].Value.Substring(0, $m.Groups[1].Value.IndexOf("_test_") + 6)
  Write-Host "    kluc: profil Stripe CLI ($prefix***)"
  return $m.Groups[1].Value
}

function Get-QaSubscription {
  $subs = Get-StripeJson @("subscriptions", "list", "--limit", "1", "-d", "status=all")
  if (-not $subs.data -or $subs.data.Count -eq 0) { throw "V sandboxe nie je ziadne predplatne - najprv dokonci nakup v prehliadaci." }
  return $subs.data[0]
}

# ----------------------------------------------------------------------------- scenare (druhe okno)
if ($Step -ne "start") {
  $sub = Get-QaSubscription
  Write-Host "Predplatne $($sub.id)  stav=$($sub.status)  cancel_at_period_end=$($sub.cancel_at_period_end)"
  switch ($Step) {
    "status" {
      # Obdobie (nove API: na polozke predplatneho), posledna faktura, posledne riadky stripe listen. Ziadne kluce.
      $full = Get-StripeJson @("subscriptions", "retrieve", $sub.id, "--expand", "latest_invoice")
      $item = $full.items.data[0]
      $ps = if ($item.current_period_start) { $item.current_period_start } else { $full.current_period_start }
      $pe = if ($item.current_period_end) { $item.current_period_end } else { $full.current_period_end }
      Write-Host ("Obdobie (UTC): {0} -> {1}" -f [DateTimeOffset]::FromUnixTimeSeconds($ps).UtcDateTime.ToString("u"), [DateTimeOffset]::FromUnixTimeSeconds($pe).UtcDateTime.ToString("u"))
      $li = $full.latest_invoice
      if ($li) { Write-Host ("Posledna faktura: {0}  stav={1}  suma={2} {3}  vytvorena={4}  billing_reason={5}" -f $li.id, $li.status, ($li.amount_due/100), $li.currency, [DateTimeOffset]::FromUnixTimeSeconds($li.created).UtcDateTime.ToString("u"), $li.billing_reason) }
      foreach ($name in @("listen.out.log", "listen.log")) {
        $log = Join-Path (Join-Path $env:TEMP "esblu-stripe-qa") $name
        if (Test-Path $log) { Write-Host "--- posledne riadky $name ---"; Get-Content $log -Tail 12 }
        else { Write-Host "$name neexistuje - bezi okno so skriptom (start)?" }
      }
    }
    "renew" {
      # Obnova: nove fakturacne obdobie hned (invoice.paid -> Esblu posunie koniec obdobia).
      Invoke-Stripe @("subscriptions", "update", $sub.id, "-d", "billing_cycle_anchor=now", "-d", "proration_behavior=none") | Out-Null
      Write-Host "OK: obnova spustena (invoice.paid)."
    }
    "fail-renew" {
      # Zlyhanie obnovy: karta, ktora sa da pripojit, ale platba zlyha (pm_card_chargeCustomerFail).
      $pm = Get-StripeJson @("payment_methods", "attach", "pm_card_chargeCustomerFail", "-d", "customer=$($sub.customer)")
      Invoke-Stripe @("subscriptions", "update", $sub.id, "-d", "default_payment_method=$($pm.id)") | Out-Null
      try { Invoke-Stripe @("subscriptions", "update", $sub.id, "-d", "billing_cycle_anchor=now", "-d", "proration_behavior=none", "-d", "payment_behavior=allow_incomplete") | Out-Null } catch { Write-Host "(Stripe vratil chybu platby - ocakavane)" }
      Write-Host "OK: obnova so zlyhanou platbou (invoice.payment_failed -> past_due)."
    }
    "fix-payment" {
      # Opakovanie platby: platna karta + zaplatit otvorenu fakturu.
      $pm = Get-StripeJson @("payment_methods", "attach", "pm_card_visa", "-d", "customer=$($sub.customer)")
      Invoke-Stripe @("subscriptions", "update", $sub.id, "-d", "default_payment_method=$($pm.id)") | Out-Null
      $inv = Get-StripeJson @("invoices", "list", "-d", "subscription=$($sub.id)", "-d", "status=open", "--limit", "1")
      if ($inv.data.Count -gt 0) { Invoke-Stripe @("invoices", "pay", $inv.data[0].id) | Out-Null; Write-Host "OK: otvorena faktura zaplatena (invoice.paid -> active)." }
      else { Write-Host "Ziadna otvorena faktura." }
    }
    "refund-partial" {
      $ch = (Get-StripeJson @("charges", "list", "-d", "customer=$($sub.customer)", "--limit", "1")).data[0]
      Invoke-Stripe @("refunds", "create", "-d", "charge=$($ch.id)", "-d", "amount=500") | Out-Null
      Write-Host "OK: ciastocna refundacia 5,00 EUR z $($ch.id) (pristup sa nemeni)."
    }
    "refund-full" {
      $ch = (Get-StripeJson @("charges", "list", "-d", "customer=$($sub.customer)", "--limit", "1")).data[0]
      Invoke-Stripe @("refunds", "create", "-d", "charge=$($ch.id)") | Out-Null
      Write-Host "OK: refundacia zvysku $($ch.id) (plna -> Esblu refunded, pristup OFF)."
    }
  }
  exit 0
}

# ----------------------------------------------------------------------------- start
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo
Write-Host "Repozitar: $Repo"
foreach ($f in @(".env", ".env.local", ".env.development", ".env.development.local")) {
  if ((Test-Path $f) -and (Select-String -Path $f -Pattern $ProdRef -Quiet)) {
    throw "$f odkazuje na PRODUKCNY Supabase ($ProdRef). Premenuj ho pred testom."
  }
}

Write-Host "1/5 Stripe CLI a testovaci kluc z profilu sandboxu..."
$StripeKey = Get-StripeTestKey
$price = Get-StripeJson @("prices", "retrieve", $PriceId)
if ($price.livemode) { throw "Cena je live - koniec." }
Write-Host "    cena $PriceId = $($price.unit_amount/100) $($price.currency.ToUpper()) / $($price.recurring.interval)  (livemode=false)"

Write-Host "2/5 Webhook secret pre stripe listen..."
$wm = [regex]::Match((Invoke-Stripe @("listen", "--print-secret")), "whsec_[A-Za-z0-9]+")
if (-not $wm.Success) { throw "stripe listen --print-secret nevratil whsec_." }
$WhSec = $wm.Value

Write-Host "3/5 Staging Supabase service role kluc (esblu-test)."
Write-Host "    Supabase Dashboard -> projekt esblu-test -> Project Settings -> API Keys -> service_role (secret)."
$sec = Read-Host -AsSecureString "    Vloz kluc (nezobrazi sa)"
$ServiceRole = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
if ($ServiceRole.Length -lt 20) { throw "Kluc je prilis kratky." }
if ($ServiceRole -match "^eyJ") {
  $payload = $ServiceRole.Split(".")[1].Replace("-", "+").Replace("_", "/"); while ($payload.Length % 4) { $payload += "=" }
  $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
  if ($claims -notmatch $StagingRef) { throw "Kluc nepatri stagingu $StagingRef." }
}

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

Write-Host "4/5 Zavislosti..."
if (-not (Test-Path "node_modules\.bin\next.cmd")) { npm ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm ci zlyhal" } }

Write-Host "5/5 stripe listen -> http://localhost:$Port/api/billing/webhooks/stripe"
$logDir = Join-Path $env:TEMP "esblu-stripe-qa"; New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$listen = Start-Process -FilePath "npx.cmd" -ArgumentList @("--yes", "@stripe/cli@1.55.12", "listen", "--events", $Events, "--forward-to", "http://localhost:$Port/api/billing/webhooks/stripe") `
  -RedirectStandardOutput (Join-Path $logDir "listen.out.log") -RedirectStandardError (Join-Path $logDir "listen.log") -NoNewWindow -PassThru

Write-Host ""
Write-Host "=================================================================="
Write-Host " Esblu bezi lokalne so Stripe SANDBOX a staging DB."
Write-Host " Ked sa nizsie objavi 'Ready', otvor: http://localhost:$Port/login"
Write-Host " Udalosti zo Stripe: $logDir\listen.log"
Write-Host " Ukoncenie: Ctrl+C (zastavi aj stripe listen)."
Write-Host "=================================================================="
try {
  npx next dev -p $Port
} finally {
  if ($listen -and -not $listen.HasExited) { Stop-Process -Id $listen.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item Env:STRIPE_SECRET_KEY, Env:STRIPE_WEBHOOK_SECRET, Env:SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
  Write-Host "Zastavene."
}
