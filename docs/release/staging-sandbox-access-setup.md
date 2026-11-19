# Bezpečné sandbox prístupy pre Preview/staging (návrh, 2026-11-19)

Cieľ: skutočné Stripe sandbox a eFaktura.sk sandbox testy na Preview deploymente `release/esblu8` + staging DB `esblu-test` (`cjbdijbbcujvmrzezusd`) bez oslabenia produkcie a bez kľúčov v chate.

## 1. Kľúče — kto, kde, ako
Pravidlo: hodnoty zadáva prevádzkovateľ iba do Vercel UI; Claude ich nikdy nečíta, nevypisuje ani neukladá. Overuje iba existenciu premennej (názov, cieľ, branch) a nie hodnotu (typ Sensitive je pre API nečitateľný).

Vercel → Project `esblu` → Settings → Environment Variables → **Add**: Environment = **Preview** iba, **Git Branch = `release/esblu8`**, typ **Sensitive**.

| Premenná | Zdroj | Poznámka |
|---|---|---|
| `ESBLU_BILLING_MODE` | `stripe_test` | nie secret |
| `ESBLU_BILLING_RETURN_ORIGIN` | URL preview vetvy (`https://esblu-git-release-esblu8-esblu.vercel.app`, vznikne po pushi vetvy na GitHub) | nie secret |
| `STRIPE_SECRET_KEY` | Stripe sandbox „Esblu s.r.o.“ → Developers → API keys → **Create restricted key** (test mode) | práva podľa § 2 |
| `STRIPE_WEBHOOK_SECRET` | Stripe sandbox → Webhooks → endpoint z § 3 → Signing secret (`whsec_…`) | |
| `ESBLU_EINVOICE_PROVIDER` / `ESBLU_EINVOICE_ENVIRONMENT` | `efaktura_sk` / `sandbox` | nie secret |
| `ESBLU_EFAKTURA_API_KEY` | portál eFaktura.sk sandbox (`efk_pk_test_…`) | nikdy produkčný kľúč |
| `ESBLU_EFAKTURA_WEBHOOK_SECRET` | portál eFaktura.sk sandbox → webhook z § 3 | |
**Nenastavovať** v Preview: `STRIPE_LIVE_*`, `ESBLU_BILLING_LIVE_APPROVED`, `ESBLU_EINVOICE_LIVE_ENABLED`, `RESEND_API_KEY`.
Staging `billing_runtime_config` ostáva `environment='test'`.

## 2. Stripe restricted test key — minimálne práva
Write: Checkout Sessions, Customers, Subscriptions, Customer portal, Credit notes, Refunds (iba pre test refundácie). Read: Events, Invoices, Charges, PaymentIntents, Prices, Products, Balance transactions, Payouts, Account. Žiadne Connect, Issuing, Treasury.
Pozn.: anonymný sandbox zo Stripe CLI (`acct_1UdBHR…`) vyprší 25. 11. 2026 — použiť pomenovaný sandbox „Esblu s.r.o.“.

## 3. Doručenie webhookov bez globálneho oslabenia ochrany (návrh)
Preview je chránený Vercel Authentication. Odporúčaný spôsob:
1. **Samostatný „Protection Bypass for Automation“ secret** s poznámkou `staging-webhooks-esblu8` (Vercel podporuje viac pomenovaných secretov). Ochrana ostáva zapnutá pre všetkých ostatných; prejde iba požiadavka so secretom.
2. Secret sa použije **iba v URL webhook endpointov v sandboxoch**: `https://esblu-git-release-esblu8-esblu.vercel.app/api/billing/webhooks/stripe?x-vercel-protection-bypass=<secret>` a obdobne `/api/einvoice/webhook?...`. Nikde inde (nie v repozitári, nie v dokumentácii, nie v produkcii).
3. Druhá vrstva: aplikácia overuje podpis Stripe (`STRIPE_WEBHOOK_SECRET`) a HMAC eFaktura; bez platného podpisu sa nič nespracuje.
4. Cron testy (catch-up, retry, ops monitor) volá Claude s hlavičkou bypass + `CRON_SECRET` Preview.
5. **Časové obmedzenie:** po skončení testov secret zrušiť (Vercel → Deployment Protection → revoke) a webhook endpointy v sandboxoch vypnúť. Rotácia aj pri podozrení na únik.
Zamietnuté alternatívy: vypnutie ochrany preview (globálne oslabenie), Deployment Protection Exception pre doménu (celá doména verejná), `stripe listen` na PC prevádzkovateľa (ručná práca, nefunguje pre eFaktúru).
Bypass secret môže po schválení vygenerovať Claude cez Vercel API a zapísať ho priamo do Vercelu; prevádzkovateľ ho potom vloží do webhook URL v sandboxoch (alebo ho Claude zapíše cez Stripe API z Preview — ak bude dostupné).

## 4. Čo Claude spraví po nastavení (bez ďalších zásahov)
Staging smoke test `docs/release/staging-smoke-test-esblu8.md` § 2–4: pripnutá API verzia (`Stripe-Version` vs verzia webhook endpointu), checkout test kartou 4242 v prehliadači, replay zlyhanej udalosti, faktúra → účtovná kópia + PDF archív, dobropis po ukončení firmy, export; eFaktura mandát → enroll → odoslanie → odvolanie → deregistrácia, opakovaný webhook, duplicitné odoslanie, cudzia firma (RLS). Výsledky iba ako stavy/kódy/počty/prefixy hashov.

## 5. Stav 2026-11-19 (vykonané po schválení prevádzkovateľa)
- **Bypass secret vytvorený** cez Vercel API: typ `automation-bypass`, poznámka `staging-webhooks-esblu8 (2026-11-19, Stripe/eFaktura sandbox only; revoke after tests)`, jediný secret v projekte. Hodnota nebola vypísaná ani uložená (pri použití sa číta z Vercel API priamo do požiadavky). Nájdete ju vo Vercel → Settings → Deployment Protection → Protection Bypass for Automation.
- **Rozsah:** Vercel viaže bypass na projekt (všetky Preview deploymenty), nie na jednu vetvu. Mitigácia: všetky Preview používajú staging DB `esblu-test` a nemajú Stripe/eFaktura live kľúče; secret sa použije iba vo webhook URL sandboxov; po testoch sa zruší.
- **Overenie ochrany (deployment `dpl_GCPCUpFv…`):**
  | Požiadavka | Výsledok |
  |---|---|
  | bez bypass: `GET /login`, `POST /api/billing/webhooks/stripe` | 302 na prihlásenie Vercel (ochrana zachovaná) |
  | s bypass: `GET /login` | 200 |
  | s bypass: Stripe webhook bez podpisu / so zlým podpisom | 404 (billing na Preview nie je nakonfigurovaný → fail closed, nič sa nespracuje) |
  | s bypass: eFaktura webhook bez podpisu | 503 `NOT_CONFIGURED` |
  | s bypass: cron bez `CRON_SECRET` | 401 |
  Overenie podpisu po nastavení kľúčov: Stripe `stripe-signature` (HMAC, tolerancia času) a eFaktura HMAC + časové okno + replay ochrana — nezávislé od bypass secretu; offline testy `stripe-adapter`, `webhook-idempotency`, `einvoice-reception` PASS.
- **Deaktivácia po testoch:** `PATCH /v1/projects/{id}/protection-bypass` s `{"revoke":{"secret":<hodnota>,"regenerate":false}}` (vykoná Claude cez API) + vypnutie webhook endpointov v sandboxoch.

## 6. Zostávajúce predpoklady pre skutočný sandbox test
1. **Push vetvy** z PC prevádzkovateľa — premenné so scope „Git Branch = release/esblu8“ sa uplatnia iba na Git deploymenty tejto vetvy (deployment vytvorený cez API ich nedostane).
2. **Kľúče** podľa § 1 (Stripe sandbox „Esblu s.r.o.“, eFaktura sandbox).
3. **Iniciovanie platieb:** Stripe Checkout s testovacou kartou vyžaduje prihlásenie do Preview syntetickým QA účtom a zadanie testovacej karty v prehliadači. Doména `*.vercel.app` nie je označená ako testovacia → Claude na nej nezadáva heslá ani kartové údaje. Možnosti: (a) prevádzkovateľ pridá Preview doménu s označením testu (napr. `staging.esblu.com` → Preview vetvy `release/esblu8`) a výslovne ju určí na testy, alebo (b) scenáre s test clock spustí existujúci skript `scripts/stripe-local-sandbox.ps1` na PC prevádzkovateľa (S12/S13 postup z 18.–19. 11.) s kódom `release/esblu8`. Overenie pripnutej API verzie, doťahovania udalostí a ops monitora (iba čítanie zo Stripe) Claude spraví cez Preview crony aj bez platby.
