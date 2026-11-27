# Esblu — Stripe LIVE readiness (fáza 1) + zoznam krokov eFaktúra/Peppol (2026-11-27)

Východisko: produkcia `c11ea7e` (billing vypnutý: `billing_runtime_config` = `test` / `web_provider=none`, žiadne STRIPE_* env,
0 predplatných, 0 LIVE cien). Overené testy S12, S13, S16, S17 (PASS 22. 11.) sa neopakujú. Nič sa neaktivovalo, žiadna LIVE
platba, žiadna zmena produkcie. Oprava B1 aplikovaná iba na staging (`esblu-test`).

**Výsledok: NO-GO pre Stripe LIVE dnes** — 1 blokujúca chyba v kóde (B1, oprava pripravená a overená) + rozhodnutia/nastavenia
vlastníka (B2–B6). Po B1–B6 je možné obmedzené LIVE spustenie podľa § 4.

## A — hotové a preukázateľne overené

| Oblasť | Dôkaz |
|---|---|
| Checkout (Stripe hosted, `mode=subscription`, adresa povinná, IČ DPH, `locale=sk`), zákaznícky portál (zrušenie ku koncu obdobia) | `lib/billing/providers/stripe.ts`; S12/S13/S16 |
| Webhooky: podpis, pripnutá API verzia `2025-03-31.basil`, idempotencia, doťahovanie zmeškaných udalostí, retry + dead letter, reconciliation | S16, S17-2/7/11; `stripe-live-audit-2026-11-19` |
| Doklady: účtovná kópia faktúr/dobropisov + snapshot odberateľa, archív PDF (S3), väzba doklad → firma (`20261124100000`, v produkcii) | S17-3…6, 12–14 PASS |
| Refundácia dobropisom, zlyhaná platba → `past_due` → `/pay`, `cancel_at`, 48 h lehota | S13/S16/S17-13/14 |
| Export pre účtovníčku (CSV: hrubá suma, poplatok, čistá suma, výplata) | S17-8/9; `app/api/billing/admin/accounting-export` (iba `billing_ops_admins`) |
| Oddelenie test ↔ live (DB `environment`, env `ESBLU_BILLING_LIVE_APPROVED=true` povinné v produkcii, inak billing `off`) | `lib/billing/config.ts`; `20261119130000` |
| Obmedzenie prvých LIVE nákupov: trigger `esblu_billing_checkout_live_guard` (DB) odmietne LIVE checkout firmy mimo `billing_live_purchase_allowlist`, kým `live_purchase_scope='allowlist'` (produkcia: allowlist, 0 záznamov) | produkčná DB (overené dnes) |
| Vypnutie nových nákupov bez zastavenia webhookov: `billing_runtime_config.web_provider='none'` → `ESBLU_BILLING_DISABLED`; webhook, doťahovanie a reconciliation `web_provider` nečítajú | `stripe-live-audit` § R2; `subscriptions-lifecycle` test S15b |
| Android 1.0.3 neponúka nákup (bez `NEXT_PUBLIC_ESBLU_BILLING_UI`, Play pravidlá) | AAB vc6 overený 27. 11. |
| Stripe Tax nezapínať, ceny konečné (neplatiteľ DPH, § 7a) | `rozhodnutia-ucto-stripe-efaktura-2026-11-26` Ú2–Ú3 |

## B — blokery pred LIVE (v poradí)

| # | Bloker | Typ | Stav / návrh |
|---|---|---|---|
| **B1** | **Zaplatený Komplet nedá nároky.** Nároky kanonických plánov sa počítajú z `company_plan_selection`, ktorý vytváral iba staging mock. Reálny Stripe nákup riadok nevytvorí → `esblu_billing_plan_targets` = prázdne → zákazník platí a po konci trialu stratí prístup. S12–S17 mali kompozíciu vopred z mocku, preto to neodhalili. | kód | **Opravené** na vetve `fix/billing-komplet-provider-selection`, migrácia `20261130100000` (aditívna): sync doplní kompozíciu Komplet (`source='provider'`); poistka zakáže LIVE cenu pre `esblu_modular` a `esblu_complete_secondary`. PGlite 10/10 (bez migrácie 4/10 — chyba preukázaná), regresie billing/predplatné/ukončenie PASS, staging aplikované a overené (md5 = repo, funkčný test v transakcii s rollbackom). |
| B2 | **Cenník ponúka, čo sa nedá kúpiť.** Checkout predá 1 plán = 1 cenu; moduly 3,90 €, rozšírenia (AI, hlas, používatelia) a „Ďalšia firma 12,90 €“ nemajú nákupný tok (výber modulov, overenie cenovej úrovne). | rozhodnutie V | Návrh: spustiť **iba Komplet 15,90 €/mes.**; v Cenníku moduly, rozšírenia a ďalšiu firmu označiť „Pripravujeme“ (textová zmena SK/EN/DE). Alternatíva (implementácia viacpoložkového checkoutu a tier kontroly) = týždne, nie blokovať spustenie. |
| B3 | Stripe účet Esblu s. r. o. — LIVE aktivácia (overenie firmy, štatutár, IBAN, 2FA, statement descriptor `ESBLU`) | V | Stav neviem overiť (Stripe Dashboard nemám; 20. 11. bol neaktivovaný). |
| B4 | Účtovníčka: text dokladu (Ú3), predaj iba SK B2B (Ú1), samozdanenie poplatkov (Ú4) | Ú | Bez potvrdenia nenastavovať pätičku faktúr. |
| B5 | Stripe nastavenia LIVE: produkt + cena 15,90 €/mes., Invoice settings (jeden číselný rad s prefixom, pätička podľa Ú3, krajiny), e-maily (finalizované faktúry, dobropisy, zlyhané platby), Smart Retries ≤ 7 dní, portál (zrušenie ku koncu obdobia, bez zmeny plánu), webhook endpoint `https://www.esblu.com/api/billing/webhooks/stripe` (verzia `2025-03-31.basil`), restricted kľúč `rk_live_` (`stripe-live-audit` § 6.3) | V | Konfigurácia v Dashboarde vlastníkom. |
| B6 | Produkčné env (Sensitive): `STRIPE_LIVE_SECRET_KEY`, `STRIPE_LIVE_WEBHOOK_SECRET`, `STRIPE_LIVE_REPORTING_KEY`, `ESBLU_BILLING_MODE=stripe_live`, `ESBLU_BILLING_RETURN_ORIGIN=https://www.esblu.com`; `ESBLU_BILLING_LIVE_APPROVED=true` a `NEXT_PUBLIC_ESBLU_BILLING_UI=1` až v kroku 4.5 (build-time → redeploy) | V + ⛔ | `validateBillingEnv` / `provider-modes` hlási chýbajúce. |

## C — vylepšenia, ktoré nesmú zdržať spustenie

1. Pred checkoutom vyžadovať prijatie aktuálnych VOP vlastníkom (dnes sa nekontroluje; predaj kryjú VOP 1.2/1.3 čl. 10–16).
2. Nákup počas trialu: Stripe účtuje hneď (bez `trial_end`), zvyšok trialu prepadne — zvážiť `subscription_data[trial_end]` = koniec trialu firmy.
3. Moduly, rozšírenia, ďalšia firma (B2 alternatíva), ročná platba.
4. VOP 1.4 (čl. 20.1 — výmaz firmy cez podporu), samostatne.

## 4 — Plán bezpečnej LIVE aktivácie (každý ⛔ krok = samostatné schválenie)

1. ⛔ Merge `fix/billing-komplet-provider-selection` → Preview → produkčná migrácia `20261130100000` → deploy (billing ostáva vypnutý).
2. B2 textová zmena Cenníka (ak schválená) — rovnakým postupom.
3. Vlastník: B3–B5 v Stripe Dashboarde; agent overí nastavenia (bez zmien) podľa zoznamu.
4. ⛔ Produkčná DB (dáta, nie schéma): `billing_provider_prices` LIVE `esblu_complete` (mesiac, price ID z Dashboardu);
   `billing_live_purchase_allowlist` = interná firma Esblu; `billing_ops_admins` = účet vlastníka;
   `billing_runtime_config` → `environment='live'`, `web_provider='stripe'`, `live_purchase_scope='allowlist'`.
5. ⛔ Env B6 vrátane `ESBLU_BILLING_LIVE_APPROVED=true` a `NEXT_PUBLIC_ESBLU_BILLING_UI=1` → redeploy → `validateBillingEnv` OK,
   webhook test event (Dashboard „Send test webhook“) → 200 + záznam v `billing_events`.
6. ⛔ **Prvý reálny nákup** (interná firma, karta vlastníka, Komplet 15,90 €):
   checkout → `subscription_accounts` `active`/`live` → `company_plan_selection` `complete/provider` → nároky `subscription` (9) →
   faktúra v Stripe (číslo z jedného radu, pätička Ú3, PDF e-mail) → `billing_invoice_documents` + PDF v archíve + snapshot →
   portál (história faktúr) → export CSV (hrubá/poplatok/čistá).
7. ⛔ Dobropis + plná refundácia toho nákupu → dobropis v archíve, nároky odvolané, export → kontrola účtovníčkou.
8. ⛔ Otvorenie predaja: `live_purchase_scope='all'` (allowlist zostáva ako núdzový režim). Núdzové zastavenie predaja:
   `web_provider='none'` (webhooky bežia ďalej).

## 5 — eFaktúra.sk / Peppol (druhá vlna, po Stripe)

1. Uložiť PDF zmluvy PC-2026-0050 + prílohy (DPA, technické podmienky) → kontrola čl. VI–XIII (zodpovednosť, limit náhrady, GDPR
   roly, ukončenie, prenositeľnosť) — dnes prečítané iba čl. I–V.
2. Ú/CLIA: povinnosť eFaktúry pre vlastné doklady Esblu od 1. 1. 2027 (Ú9) a text poverenia (mandát je DRAFT).
3. ⛔ Podpis zmluvy + úhrada ročného programu (147,60 € s DPH) → LIVE kľúč.
4. DPA 1.4 (eFaktura.sk ako sprostredkovateľ, príloha 3) + Zásady + `/subprocessors`; aktivácia podmienená prijatím DPA 1.4,
   ostatným firmám oznámenie D-15 (DPA 1.3 čl. 9.3).
5. Produkčné env eFaktúry (Sensitive), webhook HMAC, WAF, `einvoice_sellable` a Cenník „eFaktúra“ až po teste; limit partnerského kľúča
   (`20261126100000`, v produkcii).
6. ⛔ Interný test na vlastnej firme: registrácia, odoslanie, príjem → karanténa/R3 overenie, mandát, deregistrácia.
7. Cieľ: spustenie do 15. 12. 2026 (povinnosť zákazníkov-platiteľov od 1. 1. 2027).
