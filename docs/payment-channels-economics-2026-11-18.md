# Platobné kanály, DPH a ekonomika predplatného (2026-11-18)

Stav: **podklad na rozhodnutie vlastníka a potvrdenie účtovníčkou**. Nie je to daňové ani právne stanovisko.
Prepočet: `python3 scripts/payment-channel-economics.py` (sebatest `--check`). Ceny cudzích služieb stiahnuté
2026-11-18 z verejných stránok (odkazy v § 1); položky **NEOVERENÉ** sa musia potvrdiť dokladom alebo u dodávateľa.

Východisko: Esblu s.r.o. je od **16. 11. 2026 registrovaná pre DPH podľa § 7a** (nie je platiteľ podľa § 4).
Dôsledky, z ktorých výpočet vychádza (potvrdiť s účtovníčkou — otázky v § 6):

- na vlastný predaj Esblu DPH **neúčtuje**; cena Komplet **15,90 €** je pre SK zákazníka konečná,
- pri prijatej zdaniteľnej službe od dodávateľa z EÚ/tretej krajiny je Esblu osobou povinnou platiť daň (§ 69 ods. 3),
  priznanie do 25. dňa po mesiaci vzniku povinnosti, **bez nároku na odpočet** → DPH 23 % je náklad,
- pri službe dodanej podnikateľovi v inom štáte EÚ (napr. CZ firma s DIČ) — miesto dodania u príjemcu (§ 15 ods. 1),
  prenesenie daňovej povinnosti, **súhrnný výkaz** za štvrťrok,
- sadzby DPH od 1. 1. 2025: 23 % / 19 % / 5 % ([Finančná správa – sadzby](https://www.financnasprava.sk/sk/podnikatelia/dane/dan-z-pridanej-hodnoty/sadzby-dane/)).

## 1. Ceny a fakturujúce entity

| Služba | Fakturujúca entita / krajina | Poplatok (2026-11-18) | Zdaňovací predpoklad pri § 7a | Doklad na overenie |
|---|---|---|---|---|
| Stripe Payments – karta EHP | Stripe (európske účty sú obsluhované z Írska; presný názov entity **NEOVERENÉ** — uvedený na mesačnej daňovej faktúre) | štandard 1,5 % + 0,25 €; prémiové/firemné 2,8 % + 0,25 €; UK 2,5 % + 0,25 €; mimo EHP 3,15 % + 0,25 €; +2 % konverzia meny | **sporné**: platobná služba môže byť oslobodená (§ 39 / čl. 135 ods. 1 písm. d smernice), inak reverse charge 23 % | Stripe Dashboard → Documents → mesačná daňová faktúra (k 10. dňu nasl. mesiaca) |
| Stripe SEPA Direct Debit | ako vyššie | 0,35 € / platba | sporné ako vyššie | ako vyššie |
| Stripe spor (dispute) | ako vyššie | 20 € pri prijatí; +20 € pri manuálnej odpovedi (vráti sa pri výhre); +20 € odvolanie | sporné | balance transaction typu `dispute` / `stripe_fee` |
| Stripe refund | — | bez poplatku; pôvodný poplatok sa **nevracia** | — | balance transaction `refund` |
| Stripe Billing (pay-as-you-go) | ako vyššie | 0,7 % z objemu Billing | softvérová služba → **zdaniteľná**, reverse charge 23 %, bez odpočtu | mesačná daňová faktúra |
| Stripe Tax / Radar plány / Invoicing | ako vyššie | Tax Basic 0,5 %/tx; Radar od 10 €/mes.; Invoicing Starter 0,4 % | zdaniteľné; **nepotrebujeme** (Esblu DPH neúčtuje; Radar Lite je v cene) | — |
| Stripe výplata (payout) | — | 0 € (EUR na SK účet); prvá výplata 7–14 dní, potom štandardne T+3 pracovné dni (**overiť** v Dashboarde) | — | payout report |
| Google Play – predaj predplatného | Google (Írsko) ako predajca spotrebiteľovi; Google určuje, účtuje a odvádza DPH pri nákupe cez Play Billing v EÚ | EHP auto-renew: 10 % service fee + 5 % billing fee = **15 %** z ceny bez DPH (od 30. 6. 2026) | provízia je zrážka z výnosu; či ide o prijatú službu (reverse charge) — **otázka pre účtovníčku** | Play Console → Download reports → Financial (earnings) + mesačný payment statement |
| Google Play – registrácia | Google | 25 $ jednorazovo — **už zaplatené** | historická položka | — |
| App Store – IAP | Apple Distribution International (Írsko) — **NEOVERENÉ pre EÚ model 2026** | nové EÚ podmienky od 1. 10. 2026: IAP 26 %, 15 % pre Small Business Program a predplatné po 1. roku; vlastný procesor v appke 20 %/10 %; odkaz von 15 %/10 % | ako pri Google — otázka pre účtovníčku | App Store Connect → Payments and Financial Reports |
| Apple Developer Program | Apple (EÚ entita **NEOVERENÉ**) | 99 $/rok, účtované v lokálnej mene (EUR suma **NEOVERENÉ**) | služba z EÚ → pravdepodobne reverse charge 23 % bez odpočtu | potvrdenie objednávky Apple |
| Xcode Cloud | Apple | 25 h/mes. v členstve; 100 h 49,99 $, 250 h 99,99 $ | ako Apple Developer | — |
| Codemagic (iOS build bez Macu) | Nevercode Ltd. (UK) — **NEOVERENÉ** | free 500 min M2/mes. (1 používateľ); potom 0,095 $/min | služba z tretej krajiny → § 69 ods. 3, 23 % | faktúra Codemagic (iba ak platená) |
| GitHub Actions macOS | GitHub (USA) | 0,062 $/min | ako vyššie | — |
| Comgate (alternatíva) | Comgate, a.s. (CZ), platobná inštitúcia | Easy: EÚ spotrebiteľské karty 1 %, firemné 2 %, 4 €/mes. (odpustené nad 4 000 €); Profi: 0,67 % + 0,04 € / 2 % + 0,04 €; refund 0,20 €, chargeback 40 €; výplaty denne zadarmo | platobná služba — pravdepodobne oslobodená; **potvrdiť** | faktúra Comgate |
| Mollie (alternatíva) | Mollie B.V. (NL) | karty EHP 1,8 % + 0,25 €; firemné 2,9 % + 0,25 €; SEPA DD 0,35 € | ako Stripe | — (prijímanie SK obchodníkov **NEOVERENÉ**) |
| Fio banka – podnikateľský účet | Fio banka, a.s., pobočka SK | vedenie 0 €; prichádzajúce SEPA: **NEOVERENÉ** (bežne 0 €) | bankové služby oslobodené | výpis |

Zdroje: [Stripe SK pricing](https://stripe.com/en-sk/pricing) · [Stripe Billing pricing](https://stripe.com/en-sk/billing/pricing) ·
[Stripe – DPH z poplatkov](https://support.stripe.com/questions/global-taxation-of-stripe-fees) · [Stripe payouts](https://docs.stripe.com/payouts) ·
[Google Play service fees](https://support.google.com/googleplay/android-developer/answer/112622) ·
[Apple – apps in the EU](https://developer.apple.com/support/apps-in-the-eu/) · [Apple Developer Program](https://developer.apple.com/programs/) ·
[Xcode Cloud](https://developer.apple.com/xcode-cloud/) · [Codemagic pricing](https://codemagic.io/pricing/) ·
[GitHub runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) · [Comgate SK cenník](https://www.comgate.eu/sk/cenniky-platobnej-brany) ·
[Mollie pricing](https://www.mollie.com/pricing) · [Fio podnikateľský účet](https://www.fio.sk/) · [Finančná správa – § 7a registrácia](https://www.financnasprava.sk/sk/podnikatelia/dane/dan-z-pridanej-hodnoty/registracia-dph).

**Neoverené (nedalo sa stiahnuť):** GoPay cenník, Tatra banka / SLSP / VÚB poplatky, text § 39 a zákona 384/2025 na Slov-Lex
(stránka vyžaduje JavaScript), presný názov Stripe a Apple EÚ entity.

## 2. Prevádzkové služby — platené vs. bezplatné

| Služba | Stav | Mesačne | Entita / krajina | DPH pri § 7a | Doklad / čo overiť |
|---|---|---|---|---|---|
| Supabase | **platené** — org „Esblu s.r.o.“ plán **pro** (overené cez Supabase API 2026-11-18); projekty `assetpilot` (eu-central-1), `esblu-test` (eu-west-1), `skitze-protokoly` INACTIVE | ≈ 35 $ (Pro 25 $ + staging compute ~10 $ nad kredit) | Supabase Inc. (USA) / Supabase Pte. Ltd. (SG) — **overiť na faktúre** | tretia krajina → § 69 ods. 3 23 % od 16. 11. 2026 | faktúry v Supabase Billing; firemné údaje a IČ DPH na faktúre |
| Vercel | **platené** — Pro, 1 seat; ledger 31. 10. 2026: 0,69 $/deň efektívne (licencia), usage 0,04 $/deň pokrytá kreditom | ≈ 20 $ | Vercel Inc. (USA) | ako vyššie | Vercel → Settings → Invoices |
| OpenAI API | **platené** podľa spotreby | podľa používania (unit economics § 5) | OpenAI Ireland Ltd. (zmluvný poskytovateľ podľa `/subprocessors`) — **overiť na faktúre** | EÚ dodávateľ → reverse charge 23 % | OpenAI → Billing → Invoices |
| Anthropic (Claude, vývoj) | **platené**? — doklad nemám | **TBD** | Anthropic PBC (USA) alebo Anthropic Ireland — **overiť** | ako vyššie | faktúry Claude / Console |
| GitHub | **TBD** (repo `Esblu/esblu`; Actions sa nepoužívajú) | 0 alebo plán | GitHub Inc. (USA) | ako vyššie | GitHub → Billing |
| Resend (SMTP pre Supabase Auth) | **používa sa** — doména `mail.esblu.com` overená (DNS: DKIM `resend._domainkey.mail.esblu.com`, SPF `send.mail.esblu.com` → amazonses), SMTP zapnuté 17. 11. 2026 | free tier alebo plán — **TBD** | Resend (Plus Five Five, Inc., USA) — **overiť** | ako vyššie | Resend → Billing |
| Namecheap (doména, Private Email) | **platené** ročne | **TBD** | Namecheap, Inc. (USA) | ako vyššie | Namecheap → Billing |
| Firebase FCM | bezplatné | 0 | Google | — | — |
| Google Play Console | jednorazovo zaplatené | 0 | Google | historická položka (pred 16. 11.) | potvrdenie platby |
| Apple Developer | **budúci náklad** (iOS) | 99 $/rok ≈ 7,50 €/mes. | Apple | reverse charge 23 % | — |
| Stripe | **budúci náklad** (zatiaľ žiadny účet ani premenné vo Verceli) | % z predaja | Stripe (IE) | § 1 | — |

**Staršie faktúry (pred 16. 11. 2026):** Esblu vtedy nebola registrovaná pre DPH. Pri každej faktúre od zahraničného
dodávateľa nech účtovníčka skontroluje: dátum dodania (pred/po 16. 11.), entitu a krajinu, či dodávateľ **účtoval DPH**
(napr. írska alebo nemecká DPH na faktúre) a či vznikla povinnosť registrácie podľa § 7a už skôr (prvé prijatie služby
z EÚ). Faktúry, ktoré mám k dispozícii: **žiadne** (v repozitári ani v projekte nie sú; Vercel a Supabase plány som overil cez API).

## 3. Prepočet kanálov (výstup skriptu)

Predpoklady: 15,90 € / firma / mesiac, mesačná platba; prevádzka 4,60 € / firma (baseline) a 6,20 € (konzervatívne) —
odvodené z `docs/esblu-unit-economics-2026-10-22.md` § 22; fix infra 50 €/mes. + scenár overheadu 150 €/mes.;
firemné karty 50 % platieb; žiadne spory ani refundy; Google/Apple cena 15,90 € **vrátane** DPH kupujúceho (obchod je predajca
a DPH odvádza sám), provízia z ceny bez DPH; DPH na poplatkoch Stripe ukázaná v oboch scenároch.

### A. Jedna platba — Komplet 15,90 €

| kanál (cena 15,90 €) | poplatok € | % z ceny | výplata € | DPH na popl. (všetko) € | DPH (iba softvér) € | fix €/mes. |
|---|---|---|---|---|---|---|
| Stripe karta (50 % firemné) + Billing | 0,70 | 4,42 % | 15,20 | 0,16 | 0,03 | 0,00 |
| Stripe karta (100 % firemné) + Billing | 0,81 | 5,07 % | 15,09 | 0,19 | 0,03 | 0,00 |
| Stripe SEPA inkaso + Billing | 0,46 | 2,90 % | 15,44 | 0,11 | 0,03 | 0,00 |
| Stripe karta bez Billing (vlastný engine) | 0,59 | 3,72 % | 15,31 | 0,14 | 0,00 | 0,00 |
| Comgate Easy (50 % firemné) | 0,24 | 1,50 % | 15,66 | 0,05 | 0,00 | 4,00 |
| SEPA prevod + faktúra (Fio) | 0,00 | 0,00 % | 15,90 | 0,00 | 0,00 | 0,00 |
| Google Play (15 %, cena 15,90 s DPH) | provízia 1,94 + DPH obchodu 2,97 | 30,89 % | 10,99 | 0,00 (?) | 0,00 (?) | 0,00 |
| App Store SBP (15 %, cena 15,90 s DPH) | provízia 1,94 + DPH obchodu 2,97 | 30,89 % | 10,99 | 0,00 (?) | 0,00 (?) | 0,00 |
| App Store 1. rok bez SBP (26 %) | provízia 3,36 + DPH obchodu 2,97 | 39,84 % | 9,57 | 0,00 (?) | 0,00 (?) | 0,00 |

V obchodoch zákazník zaplatí 15,90 € s DPH, Esblu dostane ~10,99 €. Rovnaká výplata ako na webe by vyžadovala cenu
v obchode ≈ **23,00 €** s DPH (15,90 / 0,85 × 1,23). „(?)“ = či je provízia obchodu prijatou službou s DPH, rozhodne účtovníčka.

### B. Modul 3,90 € — dopad fixného poplatku

| kanál (modul 3,90 €) | poplatok € | z toho fixná časť € | % z ceny | výplata € | DPH všetko € |
|---|---|---|---|---|---|
| Stripe karta (50 % firemné) + Billing | 0,36 | 0,25 | 9,26 % | 3,54 | 0,08 |
| Stripe karta (100 % firemné) + Billing | 0,39 | 0,25 | 9,91 % | 3,51 | 0,09 |
| Stripe SEPA inkaso + Billing | 0,38 | 0,35 | 9,67 % | 3,52 | 0,09 |
| Stripe karta bez Billing (vlastný engine) | 0,33 | 0,25 | 8,56 % | 3,57 | 0,08 |
| Comgate Easy (50 % firemné) | 0,06 | 0,00 | 1,50 % | 3,84 | 0,01 |
| SEPA prevod + faktúra (Fio) | 0,00 | 0,00 | 0,00 % | 3,90 | 0,00 |
| Stripe karta ročne (46,80 €) | 1,58 | 0,25 | 3,38 % | 45,22 | 0,36 |

Fixných 0,25 € je pri 3,90 € **6,4 % ceny** (pri Komplete 1,6 %). Odporúčanie: viac modulov a add-onov jednej firmy účtovať
**jednou platbou** (jedno predplatné s viacerými položkami — pozor, adaptér dnes prijíma iba 1 položku, `UNKNOWN_PRICE`)
a pri samostatnom module ponúknuť ročnú platbu.

### C. 10 / 50 / 100 platiacich firiem (mesačne, baseline prevádzka)

| kanál | firmy | hrubé € | poplatky € | DPH na popl. € (všetko / softvér) | čistá výplata € | prevádzka € | fix € (infra / +overhead) | výsledok € (infra) | výsledok € (+overhead) | marža % (infra) |
|---|---|---|---|---|---|---|---|---|---|---|
| Stripe karta (50 % firemné) + Billing | 10 | 159,00 | 7,03 | 1,62 / 0,26 | 151,97 | 46,00 | 50,00 / 200,00 | 54,35 | -95,65 | 34,18 % |
| Stripe karta (50 % firemné) + Billing | 50 | 795,00 | 35,16 | 8,09 / 1,28 | 759,84 | 230,00 | 50,00 / 200,00 | 471,76 | 321,76 | 59,34 % |
| Stripe karta (50 % firemné) + Billing | 100 | 1 590,00 | 70,31 | 16,17 / 2,56 | 1 519,68 | 460,00 | 50,00 / 200,00 | 993,51 | 843,51 | 62,49 % |
| Stripe SEPA inkaso + Billing | 10 | 159,00 | 4,61 | 1,06 / 0,26 | 154,39 | 46,00 | 50,00 / 200,00 | 57,33 | -92,67 | 36,05 % |
| Stripe SEPA inkaso + Billing | 50 | 795,00 | 23,06 | 5,30 / 1,28 | 771,93 | 230,00 | 50,00 / 200,00 | 486,63 | 336,63 | 61,21 % |
| Stripe SEPA inkaso + Billing | 100 | 1 590,00 | 46,13 | 10,61 / 2,56 | 1 543,87 | 460,00 | 50,00 / 200,00 | 1 023,26 | 873,26 | 64,36 % |
| SEPA prevod + faktúra (Fio) | 10 | 159,00 | 0,00 | 0,00 / 0,00 | 159,00 | 46,00 | 50,00 / 200,00 | 63,00 | -87,00 | 39,62 % |
| SEPA prevod + faktúra (Fio) | 50 | 795,00 | 0,00 | 0,00 / 0,00 | 795,00 | 230,00 | 50,00 / 200,00 | 515,00 | 365,00 | 64,78 % |
| SEPA prevod + faktúra (Fio) | 100 | 1 590,00 | 0,00 | 0,00 / 0,00 | 1 590,00 | 460,00 | 50,00 / 200,00 | 1 080,00 | 930,00 | 67,92 % |
| Google Play 15 % (cena s DPH) | 10 | 159,00 | 49,12 | 0 / 0 (?) | 109,88 | 46,00 | 50,00 / 200,00 | 13,88 | -136,12 | 8,73 % |
| Google Play 15 % (cena s DPH) | 50 | 795,00 | 245,61 | 0 / 0 (?) | 549,39 | 230,00 | 50,00 / 200,00 | 269,39 | 119,39 | 33,89 % |
| Google Play 15 % (cena s DPH) | 100 | 1 590,00 | 491,22 | 0 / 0 (?) | 1 098,78 | 460,00 | 50,00 / 200,00 | 588,78 | 438,78 | 37,03 % |
| App Store SBP 15 % (cena s DPH) | 10 | 159,00 | 49,12 | 0 / 0 (?) | 109,88 | 46,00 | 57,50 / 207,50 | 6,38 | -143,62 | 4,01 % |
| App Store SBP 15 % (cena s DPH) | 50 | 795,00 | 245,61 | 0 / 0 (?) | 549,39 | 230,00 | 57,50 / 207,50 | 261,89 | 111,89 | 32,94 % |
| App Store SBP 15 % (cena s DPH) | 100 | 1 590,00 | 491,22 | 0 / 0 (?) | 1 098,78 | 460,00 | 57,50 / 207,50 | 581,28 | 431,28 | 36,56 % |

SEPA prevod nemá poplatok, ale stojí čas (párovanie, upomienky) a nemá automatické obnovovanie — v tabuľke čas nie je.

### D. Bod zvratu (počet platiacich firiem)

| kanál | príspevok/firma € (baseline, DPH všetko) | BE infra 50 € | BE +150 € overhead | príspevok konzervatívny € | BE konzerv. (+overhead) |
|---|---|---|---|---|---|
| Stripe karta (50 % firemné) + Billing | 10,44 | 5 | 20 | 8,84 | 23 |
| Stripe karta (100 % firemné) + Billing | 10,31 | 5 | 20 | 8,71 | 23 |
| Stripe SEPA inkaso + Billing | 10,73 | 5 | 19 | 9,13 | 22 |
| Stripe karta bez Billing (vlastný engine) | 10,57 | 5 | 19 | 8,97 | 23 |
| Comgate Easy (50 % firemné) | 11,01 | 5 | 19 | 9,41 | 22 |
| SEPA prevod + faktúra (Fio) | 11,30 | 5 | 18 | 9,70 | 21 |
| Google Play 15 % | 6,39 | 8 | 32 | 4,79 | 42 |
| App Store SBP 15 % | 6,39 | 10 | 33 | 4,79 | 44 |

### E. Kedy sa poradie mení

- Stripe (karta 50/50 + Billing + 23 % DPH na celý poplatok) stojí **0,86 € na platbu ≈ 2,6 min práce pri 20 €/h**.
  Ak ručné párovanie a upomínanie prevodu trvá dlhšie, je SEPA prevod drahší než Stripe.
- Comgate Easy ušetrí ~0,57 € na platbu. Pri odhadovanej jednorazovej integrácii 1 500 € (nový adaptér, testy, zmluvy)
  je návratnosť: 50 firiem → 61 mes., 100 → 28 mes., 300 → 9 mes., 500 → 5 mes.
- Vypustenie Stripe Billing (vlastný engine Esblu už existuje + uložená karta) ušetrí 0,14 € na platbu — iba pri stovkách firiem.

## 4. Kvalitatívne porovnanie

| | Stripe (karta + SEPA DD) | SEPA prevod + faktúra | Comgate (opakované karty) | Google Play | App Store |
|---|---|---|---|---|---|
| Zriadenie | 0 €; KYC firmy, IBAN; v Esblu hotový adaptér (test) | 0 €; v Esblu fakturácia hotová, párovanie úhrad ručné | 0 € (Start/Easy); nový adaptér + zmluva | hotový účet; produkty, RTDN, service account | 99 $/rok, D-U-N-S, Mac/CI, StoreKit |
| Fix | 0 | 0 | 4 €/mes. (Easy, do 4 000 € obratu) | 0 | 99 $/rok |
| Variabilné | 1,5–2,8 % + 0,25 €; SEPA DD 0,35 €; Billing 0,7 % | 0 | 1–2 % (+0,04 € Profi) | 15 % z ceny bez DPH | 15 % (SBP) / 26 % |
| Kurz | iba pri inej mene (+2 %) | — | — | Google prepočet | Apple prepočet |
| Refund | poplatok sa nevracia | ručný prevod | 0,20 € | Google (zákazník žiada Google) | Apple |
| Spor | 20 € (+20 €) | — | 40 € | Google | Apple |
| Výplata | T+3 prac. dni, denne/týždenne/mesačne | okamžite | denne | mesačne | mesačne |
| Export / párovanie | výborné (balance transactions, payout reconciliation report, API) | výpis banky; potrebný import výpisu | CSV / API | finančné reporty mesačne | finančné reporty mesačne |
| Bankové náklady | prichádzajúca SEPA výplata (Fio 0 €) | 0 € | 0 € | 0 € | 0 € |
| DPH | reverse charge na zdaniteľnej časti poplatkov | — | pravdepodobne oslobodené | obchod odvádza DPH kupujúceho | obchod odvádza DPH kupujúceho |
| Podpora / čas | dobrá dokumentácia, e-mail/chat | vlastný čas | SK/CZ podpora | Play Console | App Store Connect |
| Implementácia v Esblu | **hotová v test režime** (§ subscriptions) — chýba test účet a staging kľúče | čiastočne (fakturácia áno, automatické párovanie nie) | nová | server hotový (fake), klient Java za flagom | server hotový (fake), StoreKit nekompilovaný |

## 5. Odporúčanie

1. **Spustiť ako prvý: Stripe na webe** (karta + SEPA inkaso, Stripe Billing). Najnižší celkový náklad pri automatickom
   obnovovaní, integrácia je hotová a otestovaná simuláciami, exporty pre účtovníčku sú najlepšie. Bod zvratu 5 firiem
   (infra) / ~20 firiem (s overheadom 150 €).
2. **Ručný SEPA prevod + faktúra** ponechať ako výnimku pre zákazníkov, ktorí chcú platiť prevodom (ideálne ročne).
   Mesačne sa neoplatí, ak párovanie trvá viac než ~2,6 min na platbu.
3. **Google Play / App Store nepredávať**, kým to nevyžadujú pravidlá obchodov pre konkrétny tok — čistá výplata je ~31 %
   nižšia a bod zvratu ~32–33 firiem. Aplikácie ostávajú bez nákupu (vc4 nemá žiadny nákupný tok ani cenník); pred iOS vydaním
   treba rozhodnúť podľa App Review 3.1.1 / 3.1.3 (iOS plán, § 4).
4. **Poradie sa mení:** Comgate pred Stripe pri ~300+ platiacich firmách (návratnosť integrácie < 1 rok); vypustenie Stripe
   Billing pri stovkách firiem; obchod (Play/Apple) iba ak by priniesol zákazníkov, ktorých web nezíska — pri cene 15,90 €
   s DPH v obchode stráca Esblu 4,9 € na firme mesačne oproti webu.

## 6. Otázky pre účtovníčku

1. **Režim § 7a:** potvrďte, že od 16. 11. 2026 Esblu odvádza DPH z prijatých služieb od zahraničných dodávateľov (Stripe,
   Vercel, Supabase, OpenAI, Anthropic, GitHub, Resend, Namecheap, Apple) bez nároku na odpočet; kedy podávame priznanie
   (iba za mesiace, keď vznikla povinnosť?), lehota 25 dní, úhrada; ako sa uplatní hranica 5 € pri odvode.
2. **Stripe poplatky:** je spracovanie kartovej platby (1,5–2,8 % + 0,25 €) oslobodená platobná služba (§ 39) alebo
   zdaniteľná služba? Stripe Billing (0,7 %) považujeme za zdaniteľnú. Ako sa zdaňujú poplatky strhnuté priamo zo zostatku
   (bez úhrady faktúry) — dátum vzniku povinnosti podľa mesačnej daňovej faktúry Stripe?
3. **Firemné údaje na dokladoch:** v Stripe/Vercel/Supabase/OpenAI a ďalších účtoch musí byť Esblu s.r.o., sídlo a IČ DPH
   (SK…, § 7a). Kto doplní IČ DPH do profilov dodávateľov a od kedy?
4. **Dodávateľ vyčíslil DPH** (napr. írsku 23 % alebo inú): postup — žiadať opravnú faktúru bez DPH po zadaní IČ DPH,
   alebo účtovať ako náklad? Návrh postupu v `docs/stripe-monthly-reconciliation-2026-11-18.md` § 5.
5. **Predaj Esblu:** Esblu ako predajca na webe vystavuje faktúru (alebo doklad zo Stripe Billing?) — aké náležitosti
   pri neplatiteľovi s § 7a; je potrebný text o DPH na faktúre pre SK B2B? Opravný doklad pri refunde?
6. **ČR B2B:** pri predaji CZ firme s DIČ — miesto dodania v CZ, faktúra s „prenesenie daňovej povinnosti“, súhrnný výkaz
   štvrťročne; ako overujeme a archivujeme DIČ (VIES)?
7. **Spotrebitelia / SZČO bez IČ DPH v inom štáte:** ak by sme predávali B2C mimo SK, vznikne registrácia/OSS (hranica
   10 000 € celkom za EÚ — **overiť**); je § 7a registrácia dostatočná pre OSS (pravdepodobne nie)?
8. **Google Play / Apple:** kto je predajcom zákazníkovi a aký doklad dostane Esblu (self-billing / payment statement)?
   Je provízia obchodu prijatou službou s reverse charge alebo sa vykazuje iba čistý výnos?
9. **Daň z finančných transakcií (od 2025, od 2026 iba právnické osoby):** prichádzajúce platby a výplaty zo Stripe sa
   nezdaňujú; zdaňujú sa odpisy z účtu (0,4 %, max. 40 €). Je zostatok v Stripe (poplatky strhnuté zo zostatku, refundy)
   „platobný účet v zahraničí“, z ktorého musí Esblu daň sama priznať?
   ([FAQ Finančnej správy](https://www.financnasprava.sk/sk/aktualne-dan-clo/faq/dan-financne-transakcie))
10. **Evidencia tržieb (zákon 384/2025 Z. z.):** vzťahuje sa na online platbu kartou alebo inkasom za SaaS medzi firmami?
    Podľa doterajšieho zákona 289/2008 bezhotovostné online platby do eKasy nepatrili — potvrdiť pre nový zákon.
11. **Účtovanie výplaty Stripe:** hrubý výnos, poplatok, refund a spor účtovať v hrubom (nie iba čistú výplatu) — potvrdiť
    analytiku a kurz (EUR, bez konverzie).
12. **Staršie faktúry pred 16. 11. 2026:** treba spätne posúdiť vznik povinnosti § 7a (prvé prijatie služby z EÚ, napr. OpenAI Ireland)?
