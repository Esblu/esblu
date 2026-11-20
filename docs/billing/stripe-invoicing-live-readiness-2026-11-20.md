# Esblu — Stripe Billing: faktúry zákazníkom, poplatky Stripe, S17 a príprava LIVE (2026-11-20)

Stav: LIVE vypnutý (produkcia `billing_runtime_config = none/test`, `VERCEL_ENV=production` → billing off). Nič sa neúčtovalo,
žiadne produkčné nastavenia Stripe sa nemenili. Ceny Stripe: stránka stripe.com/en-sk/pricing načítaná 20. 11. 2026.

## 1. Audit — čo už existuje (main `6506e11`, nasadené, billing vypnutý)
| Oblasť | Stav | Dôkaz |
|---|---|---|
| Predplatné cez Stripe Checkout (`mode=subscription`), Komplet 15,90 €/mes. | hotové | `lib/billing/providers/stripe.ts` `createCheckout`: `billing_address_collection=required`, `tax_id_collection[enabled]=true`, `locale=sk` |
| Modulárne nároky, 48 h ochranná lehota, terminálne stavy, refundácie, `cancel_at` | hotové, PASS | S12/S13/S16 (§ 8.10–8.13) — neopakuje sa |
| Pripnutá API verzia `2025-03-31.basil`, doťahovanie udalostí, retry, ops alerty | hotové (P4) | A1 nasadené 19. 11. |
| Účtovná kópia faktúr/dobropisov + snapshot odberateľa, archív PDF, mesačný export, poplatky/čistá suma | hotové (P4), **nie overené proti skutočnému Stripe** | S17-3…S17-10 |
| Zmena programu (proration) | **nie je v ponuke** — web má jednu cenu Stripe, portál „bez zmeny plánu“ | `stripe-live-audit` § 6.2 |

## 2. Ako budú vystavené faktúry zákazníkom
- **Vystavovateľ = Esblu s. r. o.** (obchodník na vlastnom Stripe účte). Stripe faktúru iba technicky generuje; na PDF je
  obchodné meno a adresa z *Public business information* a daňové identifikátory z *Invoice settings → Invoice tax information*.
- **Automaticky každé obdobie:** predplatné Stripe Billing vytvorí, finalizuje a stiahne platbu faktúry `subscription_create`
  (prvá) a `subscription_cycle` (obnova). Jedna faktúra na obdobie (kontrola duplicít S17-10).
- **Opravné doklady:** iba cez **dobropis (credit note)** s refundáciou — nie *Payments → Refund* (to dobropis nevytvorí;
  Esblu na to už má ops alert z P4). Čiastočne S17-6, úplne S17-14.
- **Doručenie:** e-mail s PDF prílohou (*Settings → Billing → Subscriptions and emails*: „Send finalized invoices“, „Send credit
  notes“; *Customer emails*: „Successful payments“), hosted invoice page a história faktúr v zákazníckom portáli (stiahnutie PDF).
- **Číslovanie:** v EÚ sa vyžaduje **account-level** (jedna súvislá rada) s vlastným prefixom (napr. `ESBLU`) a *Next invoice
  sequence* — nastavenie Dashboardu (*Invoice settings*). S17-12 overí, že rada pokračuje.
- **Jazyk/mena/dátumy:** EUR; dátum vystavenia = finalizácia; obdobie služby na riadku; jazyk podľa `preferred_locales` zákazníka
  (Checkout `locale=sk`) — **overiť v S17 na PDF** (prípadne nastaviť `preferred_locales=["sk"]` pri zákazníkovi).
- **Pätička/povinné údaje (návrh na potvrdenie účtovníčkou):** IČO, DIČ, IČ DPH (z registrácie podľa § 7a), zápis v OR,
  text o DPH (napr. „Dodávateľ nie je platiteľom DPH podľa § 4…“ alebo „prenesenie daňovej povinnosti“ pri EÚ B2B) — *Default footer*.
- **Stripe Tax: NEZAPÍNAŤ.** Esblu nie je platiteľ DPH v SR; bez registrácií Stripe Tax nič nepočíta a stojí 0,5 %/transakciu.

## 3. Faktúry Stripe za poplatky (pre Esblu)
- Poplatky si Stripe strháva z každej platby; mesačné doklady za poplatky sú v Dashboarde (*Settings → Documents / tax invoices*)
  — **presnú cestu a e-mailové doručenie som nevedel overiť** (stránka podpory Stripe sa nenačítala; prihlásenie do Dashboardu nemám).
- Pre správne doklady: *Settings → Business → Tax details*: obchodné meno, adresa, **IČ DPH (SK…) z § 7a** → Stripe (Stripe
  Payments Europe, Írsko) fakturuje bez DPH (prenesenie). **Esblu ako § 7a osoba musí z poplatkov priznať a zaplatiť 23 % DPH
  v SR bez nároku na odpočet** (rovnako za Supabase, Vercel, OpenAI) — potvrdiť účtovníčkou.
- Výpisy pre účtovníčku bez platenej služby: reporty *Balance*, *Payout reconciliation* (Dashboard, CSV, zadarmo) a vlastný
  mesačný export Esblu (P4: `billing_balance_transactions` → CSV gross/fee/net, S17-8/9). Stripe Sigma (13 €/mes.) netreba.

## 4. Skutočný cenník Stripe pre túto konfiguráciu (stripe.com/en-sk/pricing, 20. 11. 2026)
| Položka | Sadzba | Uplatní sa? |
|---|---|---|
| Platby kartou — štandardné EHP | 1,5 % + 0,25 € | áno (väčšina SK zákazníkov) |
| Prémiové (firemné) karty EHP | 2,8 % + 0,25 € | áno pri firemných kartách |
| UK karty / medzinárodné | 2,5 % + 0,25 € / 3,15 % + 0,25 € (+2 % pri konverzii meny) | zriedka |
| Stripe Billing (pay-as-you-go) | 0,7 % z objemu predplatného | **áno** (všetky faktúry predplatného) |
| Stripe Invoicing Starter | 0,4 % za zaplatenú jednorazovú faktúru | nie (iba jednorazové faktúry) |
| Stripe Tax Basic | 0,5 %/transakciu tam, kde ste registrovaný | **nie** (nezapína sa) |
| Spory (chargeback) | 20 € prijatý + 20 € pri odpovedi (vrátené pri výhre) | iba pri spore |
| Zákaznícky portál, e-maily, PDF, reporty | bez poplatku | áno |
| Výplaty na SEPA účet | bez poplatku (štandardné) | áno |

**Príklad 15,90 €/mesiac:** štandardná karta 0,24 + 0,25 + Billing 0,11 = **≈ 0,60 € (3,8 %)**; prémiová karta ≈ **0,81 € (5,1 %)**.
Ak sa na poplatky vzťahuje samozdanenie 23 % DPH bez odpočtu (§ 3), reálne +0,14 až 0,19 €.

## 5. S17 — stav
| Krok | Obsah | Stav |
|---|---|---|
| 1, 2, 11 | preflight, pripnutá verzia + doťahovanie, obnova stagingu (+ reset/obnova kurzora) | **PASS** (20. 11., `esblu-qa4`) |
| 3 | prvé predplatné → faktúra, doklad | čaká na beh (`qa4`: kľúč neprevzatého sandboxu nesmie Test Clock — prechod na prevzatý `esblu-qa2`) |
| 4–5 | účtovná kópia + snapshot, archív PDF | čaká |
| 6 | čiastočná refundácia dobropisom | čaká |
| 7 | zmeškaná udalosť, idempotencia doťahovania | čaká |
| 8–9 | export, poplatok/čistá suma | čaká (s plným kľúčom môže byť PASS namiesto LIMITATION) |
| **12 (nové)** | obnova predplatného → faktúra `subscription_cycle`, číslovanie, obdobie, doklad | pripravené |
| **13 (nové)** | zlyhaná platba → `past_due` bez okamžitého odobratia nárokov, doklad `open` → opakovanie `/pay` → `paid`, doklad 1× | pripravené |
| **14 (nové)** | úplná refundácia dobropisom → doklad, Esblu `refunded`, Stripe `canceled`, 0 nárokov | pripravené |
| 10 | izolácia a duplicity (vrátane dokladov 12–14) | čaká |

Harness: `ops/s17-sandbox`, statické regresné testy 56/56. **Beh S17 z prostredia agenta nie je možný** (api.stripe.com je
zablokované; Stripe Dashboard bez prihlásenia). Spúšťa sa na PC prevádzkovateľa (sandbox `esblu-qa2`, bez stripe listen,
skrytá výzva na Secret key prevzatého sandboxu a staging service_role; žiadne nové účty ani sandboxy).

## 6. Otvorené daňové a právne otázky (účtovníčka / CLIA)
1. Text na faktúre pre SK zákazníkov (neplatiteľ DPH registrovaný podľa § 7a) — presné znenie a povinné náležitosti (§ 74).
2. Zákazníci z iných štátov EÚ, B2B: miesto dodania u odberateľa → faktúra s „prenesením daňovej povinnosti“ a oboma IČ DPH,
   **súhrnný výkaz**; má Esblu predávať mimo SR od spustenia?
3. EÚ B2C (elektronické služby): prah 10 000 € / OSS — predávať iba B2B? (Checkout už zbiera IČ DPH, ale nevynucuje ho.)
4. Mimo EÚ: predávať / nepredávať.
5. Poplatky Stripe (Írsko) a ďalšie služby zo zahraničia: samozdanenie 23 % DPH bez odpočtu, priznanie v daňovom priznaní pre § 7a.
6. Je PDF faktúra zo Stripe (vystavená v mene Esblu) postačujúcim daňovým dokladom; postup pri refundácii (dobropis = opravný doklad).
7. Archivácia vlastných dokladov 10 rokov: Stripe + archív PDF Esblu (P4) — postačuje?
8. VOP/Zásady (CLIA): podmienky predplatného, obnovy, refundácií, sporov; Stripe ako príjemca údajov platiteľa.

## 7. Zostávajúce kroky pred LIVE (v poradí; ⛔ = vyžaduje výslovné schválenie)
1. Odpovede účtovníčky (§ 6 body 1–7) a CLIA (bod 8).
2. **Beh S17 na `esblu-qa2`** (kroky 3–10, 12–14) → všetko PASS; vypnúť staging mapovanie ceny `qa4`.
3. Stripe LIVE účet Esblu s. r. o.: **aktivácia/overenie firmy** (dnes neaktivovaný — Stripe odmietol prevzatie sandboxu), štatutár,
   bankový účet (SEPA), 2FA, obchodné a kontaktné údaje, popis podnikania, statement descriptor `ESBLU`.
4. *Public business information*, *Invoice settings* (account-level číslovanie + prefix, pätička podľa účtovníčky, IČ DPH),
   *Subscriptions and emails* (finalizované faktúry, dobropisy, zlyhané platby, Smart Retries v súlade so 7-dňovou lehotou Esblu),
   zákaznícky portál (zrušenie ku koncu obdobia, bez zmeny plánu), branding.
5. Produkt + cena 15,90 €/mes. v LIVE, restricted kľúč `rk_live_` s minimálnymi oprávneniami, webhook endpoint (verzia
   `2025-03-31.basil`), premenné vo Verceli (Production, Sensitive) — ⛔.
6. ⛔ Interný nákup vlastnou kartou → faktúra, e-mail, PDF, dobropis + refundácia, export; potom allowlist a otvorenie predaja.

## 8. Vetvy a nasadenie
- `ops/s17-sandbox`: S17-12/13/14 + testy + tento dokument (nenasadzuje sa — je to testovací nástroj a dokumentácia).
- Produkcia bez zmeny (`main` `6506e11`). Kód predplatného a faktúr nepotreboval zmenu; prípadná úprava `preferred_locales` až podľa S17.
