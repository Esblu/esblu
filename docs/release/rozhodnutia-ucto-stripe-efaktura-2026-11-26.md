# Esblu — rozhodnutia pred spustením platieb a eFaktúry (2026-11-26)

Jeden podklad pre vlastníka a účtovníčku. Pri každom bode: otázka → môj návrh → zdroj. Nejde o daňové ani právne
stanovisko; body označené **Ú** potvrdzuje účtovníčka, **CLIA** advokátska kancelária, **V** vlastník.
Podrobný zoznam 30 otázok: `docs/accountant-questions-billing-2026-11-19.md`.

Fakty: Esblu s. r. o. je registrovaná podľa § 7a zákona č. 222/2004 Z. z. o DPH (nie je platiteľ podľa § 4);
predáva výlučne podnikateľom (VOP čl. 4); predplatné je elektronicky poskytovaná služba (SaaS).

## 1. Účtovné a daňové rozhodnutia (Ú)

| # | Rozhodnutie | Návrh | Zdroj / dôvod |
| --- | --- | --- | --- |
| Ú1 | Rozsah predaja pri spustení | **Iba podnikatelia so sídlom v SR** (IČO overené v registri, už implementované). EÚ a mimo EÚ technicky zablokovať, kým Ú neschváli texty dokladov. | Odstraňuje otázky reverse charge, súhrnného výkazu a OSS pri prvom predaji; zodpovedá B2B modelu VOP. |
| Ú2 | Ktorý doklad je daňový | **Variant A**: faktúra zo Stripe je jediný doklad; Esblu ju iba archivuje (implementované: `billing_invoice_documents`, PDF v `billing-documents`, snapshot odberateľa). Esblu nevystavuje druhý doklad. | Vylúči dvojitú fakturáciu; Stripe číslovanie je súvislé (nastaviť jeden rad na účet). |
| Ú3 | Text na doklade pre SK odberateľa | Bez DPH, text „Dodávateľ nie je platiteľom DPH.“; IČ DPH podľa § 7a **neuvádzať** pri tuzemskom predaji (Ú potvrdí). | § 74 ZDPH (náležitosti faktúry) sa vzťahuje na platiteľa; Esblu ním nie je. |
| Ú4 | DPH zo služieb od zahraničných dodávateľov (Stripe Payments Europe IE, Vercel, OpenAI, Supabase, Resend …) | Esblu ako osoba podľa § 7a **samozdaňuje 23 %** pri službách od zahraničných osôb s miestom dodania v SR a podáva daňové priznanie za obdobia, keď ich prijme; poplatky Stripe za platobné služby môžu byť oslobodené (Ú potvrdí). Rozpočtovo počítať s +23 % k cenám zahraničných SaaS. | § 7a, § 15 ods. 1, § 69 ods. 3 ZDPH; sadzba 23 % (§ 27 ZDPH od 1. 1. 2025). |
| Ú5 | Dobropisy a refundácie | Refundácia v Stripe = **Stripe credit note** k pôvodnej faktúre (implementované: dobropis, archív, väzba na platbu). Spor (chargeback) bez opravného dokladu, iba účtovný záznam poplatku. | S17 PASS (krok 14 – plná refundácia dobropisom). |
| Ú6 | 48 h ochranná lehota | Bezodplatné technické predĺženie prístupu, **nie samostatné plnenie**, bez dokladu. | VOP 1.3 čl. 16.4. |
| Ú7 | Mesačný export pre účtovníčku | CSV: doklad, hrubá suma, poplatok Stripe, čistá suma, ID výplaty (implementované, S17 krok 8). Termín: do 5. dňa nasledujúceho mesiaca. | `lib/billing/accounting-export.ts`. |
| Ú8 | Prah registrácie platiteľa DPH | Sledovať obrat; pri priblížení k prahu § 4 ZDPH (od 1. 1. 2025: 50 000 €, okamžite pri 62 500 €) zmeniť ceny/doklady. Ceny v Cenníku sú konečné. | § 4 ZDPH v znení účinnom od 1. 1. 2025 — Ú overí aktuálne znenie. |
| Ú9 | Povinná eFaktúra od 1. 1. 2027 pre vlastné doklady Esblu | Podľa môjho chápania sa povinnosť vydávať štruktúrovanú e-faktúru vzťahuje na **platiteľov DPH**; osoba podľa § 7a ju pri tuzemskom predaji nemá. **Ú/CLIA musia potvrdiť** — ak áno, Esblu potrebuje eFaktúru aj pre vlastný predaj. | Novela ZDPH (e-fakturácia od 1. 1. 2027), § 85o ods. 6 (prechodné ustanovenia citované v `docs/einvoice-*`). |

## 2. Stripe — stav a čo zostáva

Technicky overené (neopakovať): S12, S13, S16 (Test Clocks, obnovy, zlyhania, refundy, webhooky, doťahovanie
udalostí, `cancel_at`) a **S17 PASS 22. 11. 2026** (pripnutá API verzia, doklady + snapshot, archív PDF cez S3, refundácia
dobropisom, zmeškaná udalosť, export, poplatok/čistá suma). Kód billing v RC = presne testovaný kód (`d785483`).

Produkčné predpoklady — **iba vlastník (V)**, potom agent:

1. Aktivácia Stripe účtu Esblu s. r. o. (overenie firmy, bankový účet, 2FA) — V.
2. Produkty a ceny v LIVE podľa Cenníka (moduly 3,90 €, Komplet, doplnky) — V alebo agent s restricted kľúčom.
3. Restricted kľúč `rk_live_` (oprávnenia podľa `docs/audits/stripe-live-audit-2026-11-19.md` § 6.3) + samostatný
   read-only reporting kľúč; webhook endpoint `https://www.esblu.com/api/billing/webhooks/stripe` s pripnutou verziou
   `2025-03-31.basil` — V vloží ako **Sensitive** env v Vercel production.
4. Nastavenia faktúr v Stripe: jeden číselný rad, text podľa Ú3, krajiny predaja podľa Ú1, Smart Retries 7 dní.
5. Interný nákup vlastnou kartou + refund (allowlist `billing_live_purchase_allowlist`), až potom
   `NEXT_PUBLIC_ESBLU_BILLING_UI=1` a `ESBLU_BILLING_LIVE_APPROVED=true` — samostatné schválenie.
6. VOP 1.3 musia byť zverejnené ≥ 30 dní pred tým, ako sa podmienky predplatného uplatnia na existujúcich zákazníkov
   (čl. 39.2); noví zákazníci ich prijímajú hneď.

## 3. eFaktúra (eFaktura.sk / Peppol) — rozhodovací bod

**Zmluva:** v partnerskom portáli je k podpisu **Zmluva o poskytovaní API a Peppol služieb č. PC-2026-0050**
(13 strán, dátum uzatvorenia vyplnený 22. 11. 2026), **nepodpísaná**. Prečítal som iba úvodné články (strany 1–3):
predmet, sandbox, produkčný prístup **až po pripísaní platby vopred** (čl. III ods. 3, čl. IX), konzultácie nad rámec
podpory **100 € bez DPH / hod.** (čl. IV ods. 5), garancia mesačnej dostupnosti produkčného API (čl. IV ods. 6),
povinnosti partnera (čl. V). Stav kontroly celej zmluvy: § 6.

**Náklady** (verejný cenník overený 12. 11. 2026, bez DPH; **overiť voči prílohe zmluvy**):

| Položka | Suma |
| --- | --- |
| Aktivácia / setup | 0 € (bez setup fee); LIVE kľúč až po úhrade zálohovej faktúry (splatnosť 14 dní) |
| Minimum od produkčnej aktivácie | 10 €/mes. aj bez transakcií; ročný program vopred 120 €/rok (×1,00), mesačný 12 €/mes. (×1,20) |
| Transakcia (≤ 1 000/mes.) | 0,055 € odoslaná faktúra/dobropis; prijatá 0,5 tx = 0,0275 € |
| DPH | eFaktura s. r. o. je platiteľ (IČ DPH SK2122749607) → +23 %, pre Esblu (§ 7a) neodpočítateľná: **ročný program 147,60 € s DPH** |
| Príklad | 100 odoslaných + 200 prijatých/mes. = 200 tx × 0,055 = 11 €/mes. (nad minimom) → 132 €/rok bez DPH |

**Technická pripravenosť:** sandbox A↔B PASS, webhook HMAC, izolácia, karanténa a R3 (P1-4), limit partnerského
kľúča (`20261126100000`, na stagingu aplikovaná a overená 2026-11-26), mandát s bránou odosielania. V produkcii je
eFaktúra vypnutá (žiadne env), Cenník ju zobrazuje ako „Pripravujeme“.

**Právne:** VOP čl. 22 rozlišuje Esblu (rozhranie a integrácia) / poskytovateľa prístupového bodu / zákazníka (správnosť
údajov) — zhodné s implementáciou. Otvorené: text poverenia (mandátu) je DRAFT (`MANDATE_STATEMENT_NOT_APPROVED`),
eFaktura.sk ako ďalší sprostredkovateľ → oznámenie zákazníkom **≥ 15 dní** pred prvým produkčným prenosom (DPA 1.3
čl. 9.3), doplnenie do Zásad a `/subprocessors`.

**Návrh:** eFaktúru **nespúšťať spolu s platbami**. Najskôr Stripe (SK B2B). eFaktúru spustiť ako druhú vlnu:
(1) celá kontrola PC-2026-0050 + DPA, (2) podpis a úhrada ročného programu 147,60 €, (3) DPA 1.4 + oznámenie existujúcim firmám podľa § 4,
(4) LIVE kľúč + WAF + G1–G12, (5) interný test na vlastnej firme. Povinnosť 1. 1. 2027 sa týka zákazníkov-platiteľov,
preto je cieľový termín spustenia **do 15. 12. 2026**. Firmy, ktoré pri aktivácii eFaktúry prijmú DPA 1.4, nečakajú;
lehota 15 dní (§ 4) beží iba voči ostatným existujúcim firmám a nemusí oddialiť spustenie.

## 4. Lehoty 30 a 15 dní — odkiaľ vyplývajú (doplnené 2026-11-26)

Nejde o zákonné lehoty. Obe sú **zmluvné** (VOP / DPA Esblu); predaj je výlučne B2B (Obchodný zákonník, VOP čl. 4.2),
spotrebiteľské lehoty sa neuplatňujú. Právne posúdenie nie je stanovisko advokáta.

| Lehota | Ustanovenie | Na koho | Na koho nie | Dopad na spustenie |
| --- | --- | --- | --- | --- |
| 30 dní pred účinnosťou zmeny VOP | **VOP 1.2 čl. 39.2** (podstatná nevýhodná zmena; Vlastník môže prijať skôr); priaznivé/technické zmeny čl. 39.3 = účinné zverejnením | existujúci zákazníci (v prod. 4 firmy vrátane interného účtu Esblu; **0 predplatných**) | **noví zákazníci** — prijímajú VOP 1.3 pri uzatvorení zmluvy (čl. 8.1, 44.5) | **Neblokuje Stripe.** Predplatné upravuje už VOP 1.2 (čl. 10–16), predaj podľa nich je pokrytý; 1.3 iba spresňuje. Odporúčanie pre vlnu Stripe: pred checkoutom vyžadovať prijatie aktuálnych VOP Vlastníkom (dnes sa nekontroluje — `purchase-intent` overuje iba rolu a stav), čím sa lehota pre kupujúcich prakticky skráti na okamih prijatia. |
| 15 dní pred zapojením nového sprostredkovateľa + 10 dní na námietku | **DPA 1.3 čl. 9.3 a 9.4** (napĺňa čl. 28 ods. 2 GDPR — povinnosť informovať a umožniť námietku; GDPR konkrétnu lehotu neurčuje) | firmy, ktoré už prijali DPA 1.3 | firmy, ktoré prijmú novú verziu DPA (s eFaktura.sk v prílohe 3) — tie súhlasia vopred | **Blokuje eFaktúru iba pre existujúce firmy.** Najrýchlejšia cesta: DPA 1.4 (eFaktura.sk v prílohe 3 + Android v TOM podľa DPA 2.0 CLIA) a aktivácia eFaktúry podmienená prijatím DPA 1.4 Vlastníkom → bez čakania; súčasne oznámenie ostatným firmám (D-15). Potvrdí CLIA. |

## 5. Resend — zmluvné podklady (overené 2026-11-26)

| Bod | Zistenie | Zdroj |
| --- | --- | --- |
| Zmluvná strana | Plus Five Five, Inc., 2261 Market Street #5039, San Francisco (USA) | resend.com/legal/dpa (posledná zmena 31. 12. 2025) |
| DPA | súčasť Terms of Service, záväzná prijatím Terms (žiadny samostatný podpis); Resend = sprostredkovateľ, pre údaje účtu samostatný prevádzkovateľ | DPA čl. 2, 9, preambula |
| Prenos | EU SCC (rozh. 2021/914) moduly 2/3, írske právo; EU-US DPF certifikácia (podľa DPA čl. 11 — v zozname DPF nezávisle neoverené) | DPA čl. 6, 11 |
| Lokalita | **Všetky údaje účtu vrátane metadát e-mailov a logov sú uložené v USA bez ohľadu na región.** Región `eu-west-1` určuje iba odkiaľ sa e-mail odosiela. Esblu doména `mail.esblu.com` má DNS záznamy Amazon SES `eu-west-1` (odosielanie z Írska) — región treba potvrdiť v Resend → Domains. | resend.com/docs/dashboard/domains/regions; DNS |
| Ďalší sprostredkovatelia | 22, všetci USA (AWS, Supabase, Vercel, Datadog, Anthropic …) | resend.com/legal/subprocessors (5. 11. 2026) |
| Uchovanie | výmaz údajov zákazníka do 90 dní po zrušení účtu Resend | DPA príloha A |
| Texty Esblu | Zásady 1.5 (znenie CLIA 2.0: „spracúvanie … v USA“, SCC + DPF) a `/subprocessors` (oprava 26. 11.: dáta v USA, EÚ iba trasa odoslania) — v súlade | `legal/privacy/1.5.md`, `lib/i18n` |
| Chýba | potvrdenie vlastníka: región domény v dashboarde Resend a že Terms/DPA prijala firma Esblu s. r. o. (nie súkromná osoba) | — |

## 6. Zmluva eFaktura.sk PC-2026-0050 — stav kontroly

- Aktuálna verzia v partnerskom portáli: „Zmluva o poskytovaní API a Peppol služieb“ č. **PC-2026-0050**, 13 strán,
  vygenerovaná 22. 11. 2026, **nepodpísaná** (formulár podpisu s e-mailovým kódom). Prílohy: zmluva odkazuje na
  Prílohu č. 1 (technické podmienky / endpointy, dohodnutý reakčný čas) a podľa e-mailov aj na DPA.
- Prečítané: čl. I–V (str. 1–4): produkcia až po úhrade vopred (čl. III.3 → čl. IX ods. 6–7), konzultácie 100 € bez DPH/h
  (čl. IV.5), mesačná garancia dostupnosti s výnimkami a bez zmluvných pokút (čl. IV.6), povinnosti Partnera (čl. V:
  správnosť údajov, ochrana kľúča, zákaz podvodných dokladov, hlásenie incidentov).
- **Neprečítané: čl. VI a ďalšie (str. 5–13) vrátane zodpovednosti, limitu náhrady škody, GDPR rolí, ukončenia,
  prenositeľnosti a všetkých príloh.** PDF z portálu sa v nástrojoch agenta nedá extrahovať (prehliadač zobrazí iba
  orezaný náhľad, priame stiahnutie zlyhá na dĺžke podpísaného odkazu).
- Potrebné: uložiť PDF (tlačidlo „Zobraziť návrh zmluvy (PDF)“ v portáli) a prílohy do `assetpilot/legal-inbox/efaktura-PC-2026-0050/`.
  Zmluva **nie je schválená**.
