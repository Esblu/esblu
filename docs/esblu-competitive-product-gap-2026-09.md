# Esblu — konkurenčný produktový audit a gap analýza

**Dátum:** 2026-09-20
**Autor:** Cowork (Claude Opus 5)
**Stav:** interný pracovný dokument, nie marketingový materiál

---

## 0. Metodika a jej limity

Audit vychádza **výlučne z verejne dostupných stránok výrobcov**, načítaných 20. 9. 2026.

**Obmedzenia, ktoré treba brať vážne pri čítaní:**

- Webové vyhľadávanie nebolo v prostredí dostupné (HTTP 403 z proxy). Výskum prebehol priamou navigáciou z domovských stránok výrobcov, sitemap a Google Play. To znamená: **„nenašli sme / nebolo zjavne publikované" neznamená „neexistuje"** — znamená, že to touto cestou nebolo nájdené.
- `stavario.com` je klientsky renderovaná JS aplikácia. Telo stránok (vrátane cenníkovej tabuľky a plného znenia právnych dokumentov) sa nepodarilo načítať. Údaje o Stavariu sú z `<title>`, `meta description`, OG textov a Google Play listingu.
- Domény `stavario.cz` a `stavario.sk` boli z prostredia nedostupné.

**Pravidlo, ktoré tento dokument dodržiava a musí dodržiavať aj každá jeho budúca verzia:**

> Nikde netvrdíme ani nenaznačujeme, že konkurent porušuje GDPR alebo akýkoľvek právny predpis. Popisujeme výlučne, čo je alebo nie je **verejne publikované**. Absencia publikovaného dokumentu nie je dôkaz o absencii dokumentu ani o porušení povinnosti.

---

## 1. Identifikácia hráčov

| Produkt | Vendor | Jurisdikcia | Kategória |
|---|---|---|---|
| **AI BOS** | Cobra Bauart s.r.o. (uvedené v pätke aibos.sk) | SK | AI-first firemný systém pre stavebné a projekčné firmy |
| **Stavario** | Vím o všem s.r.o., IČO 06935338 (ARES) | CZ | Riadenie stavby, terén ↔ kancelária ↔ investor |
| **FLOWii** | FLOWii s.r.o., IČO 46 383 913 | SK | SMB ERP/CRM naprieč odvetviami |
| **KROS** | KROS a.s. | SK | Účtovný a ERP dom (OMEGA, ALFA plus, Fakturácia, KROS Firma, Digitálna kancelária, ONIX) |
| **iDoklad** | Seyfor a.s. (CZ) + Seyfor Slovensko a.s. | CZ/SK | Online fakturácia pre malé firmy |
| **POHODA / mPOHODA** | STORMWARE s.r.o., IČ 25313142 | CZ/SK | Desktop účtovný systém + mobilný doplnok |

**Poznámka k AI BOS:** vendor bol potvrdený z pätky webu (`© 2026 AI BOS · Cobra Bauart s.r.o.`). IČO/sídlo sa na verejnom webe produktu nenašlo. `aibos.cz` robí 302 redirect na `www.aibos.sk`.

---

## 2. Kde Esblu dnes stojí (baseline pre porovnanie)

Overené z produkčnej DB `assetpilot` (ref `fkpgvgvsmbpieduoatrt`) k 20. 9. 2026 a zo zadania:

**Máme:**
- Fakturačný core: `invoices` (direction issued/received, kind regular/payment_received/credit_note/debit_note), `invoice_items`, `invoice_parties` (snapshot seller/buyer), `invoice_tax_breakdowns`, `invoice_payments`, `invoice_events`
- Immutable finalized invoice (3 blokovacie triggery), concurrency-safe numbering, DB-authoritative VAT (kategórie S/Z/E/AE)
- PDF finalizovanej faktúry, finance.view / finance.manage permissions, company-scoped RLS na všetkých tabuľkách
- AI Inbox (`documents` s `extracted_fields`, `field_confidence`, `ai_raw_output`), `document_links`, `document_attachments`, `document_review_log`
- Vozidlá (+ servisy, známky, fotky), Stroje (+ servisy, fotky), Sklad (`inventory_items`), Obchodní partneri, Firemný chat, Deadline engine, Secure assistant action confirmation engine
- EN16931 P0: `invoice_items.unit_code`, `invoice_tax_breakdowns.vat_exemption_reason_code` / `_text`

**Nemáme (relevantné pre toto porovnanie):**
- Prijaté faktúry ako reálny flow (v produkcii **0 riadkov** s `direction='received'`)
- Akýkoľvek eInvoice XML renderer (ani outbound, ani inbound)
- Dedupe model (žiadny source hash, fingerprint ani transport ID v schéme)
- Elektronické adresy a scheme ID na `invoice_parties` (je tam len `peppol_identifier` ako voľný text)
- Zákazky/projekty, dochádzku, mzdy, Gantt, BI
- Verejné API, bankové napojenie

**Objem produkčných dát:** 3 firmy, 1 faktúra, 1 obchodný partner. **To je zásadné pre rozhodovanie o schéme** — nemáme historický balast, takže expand-only zmeny sú lacné a bezpečné. Tento stav však nevydrží dlho; okno na „lacné" schema rozhodnutia sa zatvára s prvými reálnymi zákazníkmi.

---

## 3. Porovnanie podľa oblastí

### 3.1 Fakturácia — vydané doklady

| | Esblu | AI BOS | Stavario | FLOWii | KROS | iDoklad | POHODA |
|---|---|---|---|---|---|---|---|
| Vydané faktúry | ✅ | ✅ | ❌ nenašli sme | ✅ | ✅ | ✅ | ✅ |
| Zálohové / proforma | ⚠️ `payment_received_invoice` | nenašli sme | — | ✅ | ✅ | ✅ | ✅ |
| Dobropisy / opravné | ✅ credit/debit note | nenašli sme | — | ✅ | ✅ | ✅ | ✅ |
| Viacmenovosť | ⚠️ pole `currency` je, kurzový mechanizmus nie | nenašli sme | — | ✅ 6 jazykov dokladu | ✅ OMEGA auto kurz | ✅ auto kurz ČNB | ✅ |
| Opakované faktúry | ❌ | nenašli sme | — | nenašli sme | ✅ (1,90 €/mes.) | ✅ | ✅ (mPohoda Pro) |
| Upomienky | ❌ | nenašli sme | — | nenašli sme | ✅ | ✅ | ✅ 3 stupne |
| QR platba | ❌ | nenašli sme | — | nenašli sme | ✅ | ✅ | ✅ |

**Hodnotenie:** Esblu má **správnejší základ** než väčšina (canonical model, immutabilita, DB-authoritative VAT, party snapshot), ale **chýbajú mu bežné „hygienické" funkcie**, ktoré každý zákazník očakáva ako samozrejmosť: QR kód na úhradu, opakované faktúry, upomienky, kurzový mechanizmus.

To je nebezpečná kombinácia. Architektonická prevaha je pre zákazníka neviditeľná; chýbajúci QR kód je viditeľný okamžite.

### 3.2 Prijaté faktúry a ich automatizácia — **hlavné bojisko**

| | Esblu | AI BOS | Stavario | FLOWii | KROS | iDoklad | POHODA |
|---|---|---|---|---|---|---|---|
| Evidencia prijatých faktúr | ⚠️ schéma áno, flow nie | ⚠️ nerozlíšené verejne | ❌ | ⚠️ len príjmy/výdavky | ✅ | ✅ (Basic+) | ✅ |
| AI/OCR vyťaženie dokladu | ⚠️ AI Inbox áno, → faktúra nie | ✅ fotka → partner, sumy, DPH, predkontácia | ✅ extrakcia z faktúr (Play Store) | ❌ nenašli sme | ✅ Digitálna kancelária | ⚠️ Rossum Ltd ako subprocesor, nemarketované | ⚠️ len QR kód |
| Mobilné foto dokladu | ✅ | ✅ | ✅ | ❌ | ✅ KROS Firma | nenašli sme | nenašli sme |
| E-mailová schránka na doklady | ❌ | ❌ nenašli sme | ❌ | ❌ | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme |
| Bankové napojenie + párovanie | ❌ | ✅ import výpisov | ❌ | ✅ 7 bánk SK/CZ | ✅ | ✅ 7 bánk | ✅ homebanking |
| **Detekcia duplicít** | ❌ | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme |

**Najdôležitejšie zistenie celého auditu:**

> **Ani jeden z porovnávaných produktov verejne nemarketuje deterministickú detekciu duplicitných prijatých dokladov.**

Toto je pri AI-first vyťažovaní dokladov reálny prevádzkový problém. Firma odfotí faktúru na stavbe, ten istý PDF príde mailom účtovníčke, a od 2027 príde ten istý doklad tretíkrát ako Peppol XML. Bez dedupe vzniknú tri záznamy jednej faktúry — a to je chyba, ktorá sa prejaví až v účtovníctve a v DPH.

Zároveň **e-mailovú schránku na príjem dokladov nemá verejne nikto**, hoci ide o najprirodzenejší kanál pre dodávateľské faktúry.

Tieto dve medzery sú pre Esblu strategicky najzaujímavejšie — nie preto, že ich konkurencia nemá, ale preto, že sú **priamym dôsledkom architektúry, ktorú už Esblu má** (canonical model + source_document_id + AI Inbox).

### 3.3 eFaktúra / štruktúrovaná elektronická fakturácia — **najväčšie riziko**

Kontext: na Slovensku je elektronická fakturácia v štruktúrovanom formáte **povinná od 1. 1. 2027** pre tuzemské B2B a B2G (podľa toho, čo o tom verejne publikujú KROS aj STORMWARE). Platitelia DPH musia eFaktúry vystavovať aj prijímať; neplatitelia musia byť schopní prijímať.

| Vendor | Stav k 9/2026 (verejne) | Formát | Access Point | Cena |
|---|---|---|---|---|
| **KROS** | ✅ **certifikovaný digitálny poštár (Peppol AP)** | Peppol, XML, ISDOC (OMEGA) | vlastný, infraštruktúra od **eConnect International B.V.** (ISO 27001) | príjem zdarma neobmedzene; 50 odoslaných/mes. zdarma, potom 5,90 €/50 alebo 59,90 €/2000 |
| **POHODA/mPOHODA** | ✅ **akreditovaný Peppol AP** | XML **BIS3**, validácia, ISDOC | vlastný | príjem zdarma neobmedzene; odosielanie zdarma **do 600 faktúr/rok** na účtovnú jednotku |
| **AI BOS** | ⚠️ deklaruje pripravenosť | „e-Faktúra **UBL BIS 3 XML** (pripravené na povinnosť od 2027)" | nenašli sme | nenašli sme |
| **FLOWii** | ⚠️ **publikovaný plán, nie funkcia** | deklaruje **EN16931** + Peppol | nenašli sme | avizovaný freemium, ceny „v príprave" |
| **iDoklad** | ❌ vyhlásenie k 2027/Peppol nenašli sme | ISDOC export | — | — |
| **Stavario** | ❌ nenašli sme | — | — | — |
| **Esblu** | ❌ **žiadny XML renderer** | — | — | — |

**Toto je najtvrdšie zistenie dokumentu.**

Dvaja najväčší slovenskí hráči (KROS, STORMWARE) už majú **akreditovaný Peppol Access Point v produkcii**, nie v pláne. Obaja ponúkajú **príjem eFaktúr zdarma a bez limitu** — čo znamená, že cena za prijímanie eFaktúr je na trhu už teraz nulová a Esblu na nej nikdy nezarobí.

Esblu má do povinnosti **~15 mesiacov** a nemá ani prvý riadok XML mapperu. Zároveň platí pozitívum: **canonical model, ktorý Esblu má, je presne to, z čoho sa XML renderuje správne.** Konkurenti, ktorí postavili eFaktúru na starších schémach, budú mať s EN16931 mandatory fields viac problémov než Esblu — ak Esblu tie polia doplní teraz, kým má 1 faktúru v produkcii.

**Dôležité pre rozhodovanie:** Esblu **nemusí byť vlastný Peppol AP.** KROS aj STORMWARE si AP postavili cez partnera (KROS explicitne cez eConnect International B.V.). Pluggable provider adapter — ako to zadanie správne požaduje — je správna odpoveď. Nevyberať providera teraz je správne rozhodnutie; **nemať pripravený canonical → UBL mapping je naopak riziko.**

### 3.4 Obchodní partneri a kmeňové dáta

| | Esblu | AI BOS | FLOWii | KROS | iDoklad | POHODA |
|---|---|---|---|---|---|---|
| Evidencia partnerov | ✅ | ✅ 10 000+ záznamov | ✅ + kontaktné osoby, história | ✅ | ✅ | ✅ adresár |
| Doťahovanie z registrov | ❌ | ✅ „verejné registre" (SKSI, ZSPS, e-obce) | ❌ nenašli sme | ✅ Register firiem a živnostníkov SR | ✅ **ARES** + kontrola nespoľahlivého platiteľa DPH + insolvencia | ❌ nenašli sme |
| Import z iCloud/Outlook | ❌ | ✅ | ✅ import z iných systémov | ❌ | ❌ | ❌ |
| Electronic address / scheme ID | ❌ (len `peppol_identifier` free text) | nenašli sme | nenašli sme | implicitne cez Peppol AP | ❌ | implicitne cez Peppol AP |

**Hodnotenie:** iDoklad má tu najsilnejšiu verejne popísanú funkciu — **automatická kontrola nespoľahlivého platiteľa DPH a insolvencie**. To je funkcia, ktorá reálne chráni peniaze zákazníka a Esblu ju nemá.

Doťahovanie z ORSR/Finstat je pre Esblu **must have pre 2027**: bez IČ DPH a registračných identifikátorov v správnej štruktúre nebude EN16931 výstup validný, a ručné zadávanie týchto polí je presne to, na čom AI-first produkt prehráva.

### 3.5 Moduly mimo fakturácie

| Modul | Esblu | AI BOS | Stavario | FLOWii | KROS | iDoklad | POHODA |
|---|---|---|---|---|---|---|---|
| Sklad | ✅ | ❌ | ✅ (zdarma) | ✅ | ✅ | ⚠️ cenník položiek | ✅ |
| Majetok | ⚠️ cez stroje/vozidlá | ❌ | ✅ náradie + QR | ❌ | ✅ | ❌ | ✅ |
| **Vozidlá** | ✅ **+ servisy, známky, fotky** | ❌ | ⚠️ vo vývoji | ❌ | ⚠️ kniha jázd | ❌ | ⚠️ kniha jázd |
| **Stroje** | ✅ **+ servisy, fotky** | ❌ | ⚠️ náradie | ❌ | ❌ | ❌ | ❌ |
| Projekty / zákazky | ❌ | ✅ fázy, čas, náklady | ✅ | ✅ + rozpočet | ✅ ONIX | ⚠️ štítky | ❌ |
| Úlohy / Kanban | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Dochádzka | ❌ | ✅ QR zapichnutie | ✅ **GPS + fotka** | ✅ 2 €/user/mes. | ✅ (partner Alveno) | ❌ | ⚠️ PAMICA |
| Mzdy | ❌ | ✅ | ❌ | ❌ | ✅ OLYMP | ❌ | ✅ |
| Tímový chat | ✅ | ✅ + WebRTC hovory | ✅ skupiny po stavbách | ✅ | ❌ | ❌ | ❌ |
| Reporting / BI | ⚠️ základ | ✅ AI týždenné zhrnutie | ✅ | ✅ | ✅ BI v ONIX | ✅ dashboard | ✅ BI (10 980 Kč) |
| Gantt / plánovanie | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |

**Kde je Esblu jedinečné:** **vozidlá a stroje ako plnohodnotné agendy so servisnou históriou, termínmi (PZP/STK/servis) a fotodokumentáciou.**

Toto nemá v tejto kombinácii **nikto z porovnávaných**. Stavario má náradie s QR kódmi a avizuje monitoring vozového parku ako modul **vo vývoji**. KROS a POHODA majú knihu jázd (daňová agenda, nie prevádzková). AI BOS, FLOWii a iDoklad nemajú nič.

Pre výkopovú, dopravnú alebo servisnú firmu je bager a Avia to, čím firma zarába. Že im systém povie „za 12 dní končí STK" je hodnota, ktorú konkurencia neponúka.

**Kde Esblu najviac zaostáva:** **zákazky.** AI BOS, Stavario, FLOWii aj KROS ONIX ich majú. Pre stavebnú firmu je zákazka prirodzená os, okolo ktorej sa točí všetko ostatné — faktúry, dokumenty, stroje, ľudia, náklady. Bez nej zostane Esblu súborom nespojených agend.

### 3.6 AI a hlas

| | Esblu | AI BOS | Stavario | FLOWii | KROS | iDoklad | POHODA |
|---|---|---|---|---|---|---|---|
| AI extrakcia dokladov | ✅ AI Inbox | ✅ | ✅ | ❌ | ✅ | ⚠️ nemarketované | ❌ |
| AI asistent nad firmou | ⚠️ intent engine + action confirmation | ✅ | ✅ Copilot naprieč modulmi | ⚠️ len písanie e-mailov (ChatGPT) | ❌ | ❌ | ❌ |
| Hlasové ovládanie | ⚠️ transkripcia áno, orchestrátor nie | ✅ „celú firmu ovládate hlasom" | ✅ | ❌ | ❌ | ❌ | ❌ |
| Hlasový vstup do záznamov | ❌ | ✅ | ✅ + **WhatsApp kanál** | ❌ | ❌ | ❌ | ❌ |
| AI telefónna ústredňa | ❌ | ✅ (od 19. 9. 2026) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Menovaný poskytovateľ AI | — | „GPT-5.6" v changelogu | nenašli sme | „technológia ChatGPT" | nenašli sme | Azure/ChatGPT v privacy policy | — |

**Hodnotenie:** AI BOS a Stavario sú v hlase a AI asistentovi **pred Esblu**, nie za ním. AI BOS pridáva funkcie rýchlym tempom (changelog: 8. 7., 11. 7., 17. 7., 23. 8., 2. 9., 12. 9., 14. 9., 19. 9. 2026).

**Kde má Esblu prevahu, ktorú nikto iný verejne nemá:** **secure assistant action confirmation engine.**

Ani AI BOS, ani Stavario verejne nepopisujú, ako zabraňujú tomu, aby AI vykonala nesprávnu akciu nad firemnými dátami. „Celú firmu ovládate hlasom" je bez potvrdzovacej vrstvy s canonical args, nonce a server proof veľmi odvážne tvrdenie pri akciách, ktoré menia účtovné dáta.

Toto je Esblu differentiator — ale len vtedy, ak sa o ňom hovorí. Dnes je to implementačný detail, o ktorom zákazník nevie.

### 3.7 Mobil

| | Riešenie |
|---|---|
| **Esblu** | PWA |
| **AI BOS** | web/PWA, natívnu appku sme nenašli |
| **Stavario** | **natívny Android** (`com.stavario.stavario`, 10 000+ inštalácií, aktualizácia 3. 9. 2026); iOS neoverené |
| **FLOWii** | responzívny web; vendor **explicitne uvádza, že dedikovanú appku nemá** (okrem tabletu na dochádzku) |
| **KROS** | mobilná dostupnosť KROS Firma a Digitálnej kancelárie; Dochádzka má iOS/Android |
| **iDoklad** | **natívne iOS + Android**, v katalógu rozšírení, v cene aj vo Free balíku |
| **POHODA** | **mPOHODA natívne iOS/Android/Huawei** + web; POHODA samotná je desktop Windows |

**Hodnotenie:** PWA je pre Esblu obhájiteľná voľba a nie je hendikep voči FLOWii ani AI BOS. Voči Stavariu v teréne áno — natívna appka lepšie zvláda offline, fotoaparát a push notifikácie na stavbe so slabým signálom.

### 3.8 Cenový model

| Produkt | Model | Vstupná cena |
|---|---|---|
| **FLOWii** | **per-user** | FREE / CRM 11 € / PREMIUM 26 € za používateľa/mes.; dochádzka +2 €/user |
| **iDoklad** | **per-company s balíkom používateľov** | SK: Free / Basic 5 € / Popular 8,30 € / Premium 11,60 € mes. (ročne) |
| **KROS** | per-company + doplatky | Fakturácia free / 5,90 € / 11 €; OMEGA 10,18–46,16 €; +2,98 € za používateľa; Digitálna kancelária od 25,90 €/firma |
| **POHODA** | **jednorazová licencia + ročný SERVIS** | SK: Mini 130 € … Komplet 870 €; SERVIS 40–261 €/rok. mPOHODA: free / 166 Kč / 298 Kč mes. |
| **Stavario** | modulárny | „od 24 €/mes." (SK) / „od 599 Kč/měsíc" (CZ); per-user vs per-company nenašli sme |
| **AI BOS** | **žiadny verejný cenník** (`/cennik.html` → 404) | — |
| **Esblu** | company-scoped plan + plan_limits | Closed Beta |

**Pozorovanie:** trh je rozdelený. FLOWii ide per-user (pre firmu s 15 chlapmi v teréne drahé). iDoklad a KROS idú per-company s balíkom používateľov (pre terénnu firmu oveľa priaznivejšie).

**Pre Esblu je to dôležité rozhodnutie.** Ak má Esblu cieliť na firmy, kde väčšina ľudí je v teréne a systém používa na foto dokladu a zapichnutie, **per-user model produkt zabije**. Esblu už má `company-scoped plan` — to je správny smer a treba pri ňom zostať.

### 3.9 Onboarding

| Produkt | Model |
|---|---|
| **iDoklad** | **najsilnejší** — self-serve, bez karty, CZ 60 dní / SK 30 dní Premium + trvalý free tier (do 5 odberateľov) + garancia vrátenia peňazí |
| **FLOWii** | self-serve, 30 dní všetko bez karty, + FREE a FLEXII tier |
| **KROS** | 30 dní (OMEGA, ONIX) + trvalý free tier vo Fakturácii; ONIX sales-led s migráciou |
| **POHODA** | e-shop / sales-led; mPOHODA má free tier; trial POHODA nenašli sme |
| **Stavario** | trial/demo nenašli sme; platené školenia a platená technická podpora |
| **AI BOS** | **„Nový účet schvaľuje administrátor vašej firmy"** — žiadny self-serve trial |
| **Esblu** | **Closed Beta** |

**Hodnotenie:** Esblu je v Closed Beta, čo je legitímne pre aktuálnu fázu. Ale **iDoklad nastavil na tomto trhu očakávanie: vyskúšaj zadarmo, bez karty, hneď.** Keď sa Closed Beta otvorí, čokoľvek s trením („napíšte nám", „schvaľujeme účty") bude proti trhovému štandardu.

Pozitívne: AI BOS a Stavario sú na tom rovnako alebo horšie, takže v tomto segmente to nie je okamžitá nevýhoda.

### 3.10 Integrácie

| | Esblu | AI BOS | Stavario | FLOWii | KROS | iDoklad | POHODA |
|---|---|---|---|---|---|---|---|
| Banky | ❌ | ⚠️ import výpisov | ❌ | ✅ 7 bánk | ✅ | ✅ 7 bánk | ✅ |
| Účtovný softvér | ❌ | ✅ OBERON | ❌ | ✅ Pohoda, Omega | ✅ (vlastné + Pohoda) | ✅ Money, Pohoda, Vario | — |
| E-shop | ❌ | ❌ | ❌ | ✅ WooCommerce | ✅ Shoptet, WooCommerce | ✅ Shopify, WooCommerce, PrestaShop | ⚠️ |
| Verejné API | ❌ | ❌ nenašli sme | ❌ nenašli sme | ✅ REST, 25 000/deň, **len platená licencia** | ✅ 4,90 €/mes. | ✅ developer portál, 7 500–75 000 req/mes. | ✅ XML API + mPohoda REST |
| Automatizácia (Make/Zapier) | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ Integromat, Dativery | ❌ |

**Hodnotenie:** **Export do účtovného softvéru je pre Esblu must have a dnes chýba.** Firma s 8 ľuďmi nemá vlastnú účtovníčku — má externú, ktorá pracuje v OMEGA alebo POHODA. Ak z Esblu nevie dostať doklady, Esblu z jej pohľadu nefunguje, nech je vnútri akokoľvek správne.

FLOWii aj iDoklad to vyriešili exportom do Pohoda a Omega. To je relatívne lacná funkcia s veľkým dopadom na predaj.

---

## 4. Audit verejnej transparentnosti (GDPR / legal / security)

**Opakovane a dôrazne:** nasledujúce je porovnanie toho, **čo je verejne publikované na weboch**. Nie je to právne hodnotenie, nie je to tvrdenie o súlade ani nesúlade s GDPR, a nesmie sa tak interpretovať ani citovať.

| | Privacy | Terms | Cookies | DPA | Zoznam subprocesorov | AI transparency | Data residency | Certifikácie |
|---|---|---|---|---|---|---|---|---|
| **Esblu** | ✅ | ✅ | ✅ | ✅ + acceptance tracking v DB | ✅ | (CLIA review prebieha) | — | — |
| **iDoklad** | ✅ | ✅ | ✅ samostatná | ✅ (privacy = DPA podľa čl. 28) | ✅ **menovitý zoznam ~16 subjektov** | ⚠️ zmienka o Azure/ChatGPT | ✅ **Azure, výhradne EÚ, 2 centrá + failover** | ⚠️ ISO/IEC 27018 u Microsoftu |
| **POHODA** | ✅ | ✅ | ⚠️ v rámci privacy | ✅ **samostatná zpracovatelská smlouva** | ⚠️ menovaní v privacy + DPA | ❌ **žiadna zmienka o AI** | ✅ ČR/EÚ, tretie krajiny cez EU–US DPF | ⚠️ ISO 27001 u TeamViewer |
| **FLOWii** | ✅ | ✅ | ✅ | ✅ (čl. 7 licenčných podmienok) | ⚠️ CloudVPS B.V., GeoTrust, nie samostatný zoznam | ⚠️ „technológia ChatGPT" v novinke | ✅ **Holandsko (TransIP), zálohy AWS, „iba v rámci EHP"** | ❌ nenašli sme |
| **KROS** | ✅ 4 PDF | ✅ | ⚠️ len cookie lišta | ✅ ale len pre eFaktúru (PDF) | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme u KROS (ISO 27001 uvedené u partnera eConnect) |
| **Stavario** | ✅ | ✅ | ✅ | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme |
| **AI BOS** | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme | ❌ nenašli sme |

*(Pri AI BOS boli testované URL `/privacy.html`, `/ochrana-osobnych-udajov.html`, `/gdpr.html`, `/podmienky.html`, `/cookies.html` — všetky vrátili HTTP 404, a pätka homepage neobsahuje žiadne právne odkazy. Pri Stavariu existujú vlastné `<title>` pre všetky tri dokumenty, ale telo sa pre JS rendering nepodarilo načítať, takže o ich obsahu nevieme nič.)*

**Čo z toho vyplýva pre Esblu:**

1. **iDoklad je v transparentnosti najďalej** a je to realistický benchmark. Menovitý zoznam subprocesorov priamo v privacy policy je to, čo pri B2B predaji odblokuje rozhovor s protistranou, ktorá má vlastného DPO.

2. **AI transparency je na tomto trhu prakticky prázdne miesto.** Nikto z porovnávaných nemá samostatné AI transparency vyhlásenie, hoci traja AI aktívne používajú. Pri produkte, ktorý AI marketuje ako hlavnú hodnotu a ktorý ju púšťa na účtovné dáta, je to publikovateľný rozdiel — a je lacný, lebo je to text, nie funkcia.

3. **Data residency publikujú traja (iDoklad, POHODA, FLOWii), a dvaja z nich mimo SK.** FLOWii hostuje v Holandsku, iDoklad na Azure v EÚ. Esblu beží na Supabase v **eu-central-1**. Ak sa to publikuje jasne, je to rovnocenné tvrdenie — nie slabina.

---

## 5. Klasifikácia medzier

Podľa zadania: každá medzera dostane jednu zo štyroch kategórií. **Cieľ nie je „konkurencia to má, pridajme to".**

### A. MUST HAVE — bez toho produkt neobstojí

| # | Medzera | Prečo must have | Termín |
|---|---|---|---|
| A1 | **Prijaté faktúry ako reálny flow** | Bez nich nie je Esblu fakturačný systém, ale fakturačná appka. Každý konkurent ich má. Schéma už existuje (`direction='received'`), chýba flow. | Q4 2026 |
| A2 | **Deterministický dedupe** | Priamy dôsledok A1 + AI Inbox + budúceho XML. Bez toho AI Inbox aktívne škodí. | spolu s A1 |
| A3 | **EN16931 P1 polia + canonical → UBL 2.1 mapper** | Povinnosť 1. 1. 2027. KROS aj STORMWARE sú už v produkcii. ~15 mesiacov. | Q4 2026 – Q1 2027 |
| A4 | **Inbound structured eInvoice (UBL → canonical)** | Od 2027 musia prijímať aj neplatitelia DPH. Prijímanie je na trhu zdarma — nie je to prémiová funkcia, je to vstupenka. | Q1 2027 |
| A5 | **Elektronické adresy + scheme ID na partneroch a billing profile** | Bez nich nebude XML validný. Dnes je tam len `peppol_identifier` ako voľný text. | ihneď, so schémou |
| A6 | **Export do OMEGA / POHODA** | Externá účtovníčka je gatekeeper predaja. FLOWii aj iDoklad to majú. | Q1 2027 |
| A7 | **QR kód na úhradu, upomienky, opakované faktúry** | Hygienické minimum. Každý konkurent to má; absencia je viditeľná v prvých 5 minútach dema. | Q4 2026 |

### B. STRATEGIC DIFFERENTIATOR — tu sa dá vyhrať

| # | Príležitosť | Prečo je to skutočný differentiator |
|---|---|---|
| B1 | **Dedupe ako publikovaná funkcia** | Nikto ju verejne nemá. Priamy dôsledok architektúry, ktorú Esblu už má. Predajná story: „odfoť to na stavbe, pošli to mailom aj cez Peppol — vznikne jedna faktúra." |
| B2 | **Vozidlá + stroje so servisnými termínmi** | Nikto to v tejto kombinácii nemá. Pre výkopovú/dopravnú firmu je to dôvod, prečo si vybrať Esblu namiesto iDokladu. |
| B3 | **Structured-first pipeline** | Zásada „ak príde validný XML, nepúšťaj ho do OCR" je architektonicky správna a nikto ju verejne nedeklaruje. Od 2027, keď XML začne chodiť masovo, bude to rozdiel v presnosti. |
| B4 | **Secure action confirmation pri AI/hlase** | AI BOS aj Stavario sľubujú hlasové ovládanie firmy; ani jeden verejne nepopisuje potvrdzovaciu vrstvu. Esblu ju má implementovanú — treba o nej začať hovoriť. |
| B5 | **AI transparency + fail-closed pravidlá ako publikovaný záväzok** | „AI nikdy nerozhoduje o VAT kategórii, sadzbe ani právnom dôvode oslobodenia — navrhuje, používateľ potvrdzuje." Na trhu, kde traja používajú AI bez akéhokoľvek verejného vyhlásenia, je toto dôveryhodnostný náskok. |
| B6 | **Smart dashboard „čo treba riešiť"** | AI BOS má AI týždenné zhrnutie, ostatní majú klasické dashboardy. Read-only prioritizovaný zoznam naprieč faktúrami, STK/PZP, servismi, skladom a Inboxom nemá nikto. |

### C. NICE TO HAVE — má hodnotu, ale nie teraz

| # | Položka | Poznámka |
|---|---|---|
| C1 | Doťahovanie partnera z ORSR/Finstat | Posúva sa do MUST HAVE spolu s A3/A5 (scheme IDs), samostatne je to len pohodlie |
| C2 | Kontrola nespoľahlivého platiteľa DPH / insolvencie | iDoklad to má; reálne chráni peniaze; ale nie je to blocker |
| C3 | Bankové napojenie a párovanie platieb | Má to 5 zo 6 konkurentov. Zadanie správne hovorí „nerob teraz bankové API" — ale canonical model naň musí byť pripravený |
| C4 | E-mailová schránka na príjem dokladov | Nemá to verejne nikto; prirodzené rozšírenie AI Inboxu; po A1+A2 |
| C5 | Gantt / plánovanie | Až po zákazkách, ak vôbec |
| C6 | Verejné REST API | Až keď bude po čom siahať |
| C7 | Natívna mobilná appka | PWA stačí, kým sa neukáže, že offline na stavbe je reálny problém |

### D. DO NOT BUILD NOW — vedome nestaviame

| # | Položka | Prečo nie |
|---|---|---|
| D1 | **Mzdy** | AI BOS a KROS to majú. Je to regulačne ťažké, nízko diferencované a odvedie to celý tím od eFaktúry. |
| D2 | **Dochádzka** | Má to 4 zo 6. Vyzerá to lacno, ale GPS, súkromie zamestnancov a Zákonník práce z toho robia vlastný produkt. Nie pred 2027. |
| D3 | **Účtovníctvo a daňové priznania** | Súboj s KROS a STORMWARE na ich domácom ihrisku. Esblu má byť firemný systém, ktorý účtovníčke dáta **odovzdá** (A6), nie ju nahradí. |
| D4 | **BIM / Archicad / rendery** | AI BOS v tom investuje veľa. Pre výkopovú a servisnú firmu to nemá hodnotu. |
| D5 | **CRM sales pipeline** | FLOWii je CRM. Esblu nie je. |
| D6 | **Vlastný Peppol Access Point** | KROS si ho postavil cez eConnect. Pluggable adapter áno, vlastná akreditácia nie. |
| D7 | **AI telefónna ústredňa** | AI BOS to spustil 19. 9. 2026. Je to pôsobivé a pre Esblu irelevantné. |
| D8 | **Plný voice assistant teraz** | Zadanie to hovorí správne. Bez fakturačného core nemá hlas nad čím operovať. |
| D9 | **Kompletný modul Zákazky** | Napriek tomu, že je to najväčšia medzera v 3.5 — pred eFaktúrou by to bola strategická chyba. Len architektonický návrh. |

---

## 6. Kde je Esblu konkurencieschopné a kde zaostáva — zhrnutie

**Konkurencieschopné až lepšie:**
- Canonical invoice model, immutabilita, DB-authoritative VAT, party snapshot — architektonicky čistejšie než čokoľvek, čo konkurencia verejne popisuje
- Vozidlá a stroje so servisnou históriou a termínmi — unikátne
- Company-scoped RLS a fail-closed prístup na úrovni DB
- Secure action confirmation engine
- Firemný chat (má ho len AI BOS, Stavario a FLOWii)
- Legal gate a DPA acceptance tracking priamo v produkte

**Zaostáva:**
- **eFaktúra** — najväčšie riziko, dvaja konkurenti už v produkcii, ~15 mesiacov do povinnosti
- **Prijaté faktúry** — schéma bez flow
- Hygienické fakturačné funkcie (QR, upomienky, opakované)
- Export do účtovných systémov
- Bankové napojenie
- Doťahovanie partnera z registrov
- Zákazky
- AI asistent a hlas — AI BOS a Stavario sú vpredu a zrýchľujú

**Najväčšie nevyužité aktívum:** Esblu má architektúru, z ktorej sa dá postaviť správna eFaktúra rýchlejšie a čistejšie než z legacy schém konkurencie — ale len dovtedy, kým má v produkcii jednu faktúru. Toto okno sa zatvára.

---

## 7. Odporúčané poradie (next 5 highest-value)

1. **Received invoice canonical flow + dedupe** (A1, A2, B1) — jeden blok, lebo jedno bez druhého je nebezpečné
2. **EN16931 P1 schema + party model rozšírenie** (A3, A5) — teraz, kým je 1 faktúra v produkcii
3. **canonical → UBL 2.1 outbound mapper + validačné vrstvy** (A3) — interný nástroj, žiadne verejné „Odoslať eFaktúru" tlačidlo
4. **Inbound UBL → canonical, structured-first pipeline** (A4, B3)
5. **Fakturačná hygiena + export do OMEGA/POHODA** (A6, A7)

**Paralelne, lacné a s vysokým dopadom:** publikovať AI transparency vyhlásenie a data residency (B5) — až po uzavretí CLIA review, podľa `docs/invoicing-compliance-delta-for-clia.md`.

---

## 8. Zdroje

Všetky nižšie uvedené URL boli v rámci auditu reálne načítané 20. 9. 2026.

**AI BOS:** https://aibos.sk/ · /funkcie.html · /navody.html · /novinky.html · https://aibos.cz/ (302→aibos.sk) · https://app.aibos.sk/
*404 pri: /cennik.html, /privacy.html, /ochrana-osobnych-udajov.html, /gdpr.html, /podmienky.html, /cookies.html, /kontakt.html, /sitemap.xml, /robots.txt*

**Stavario:** https://stavario.com/ · /sk · /sk/cennik · /cs/cenik · /en/pricing · /sk/cennik/svojpomocnici · /sk/cennik/technicka-podpora · /sk/kontakt · /sk/ochrana-osobnych-udajov · /sk/obchodne-podmienky · /sk/zasady-cookies · /sk/sluzby/stavebny-dennik · /sk/sluzby/dochadzkovy-system · /sk/sluzby/vyvoj-na-mieru · /sk/produkt/sklady-a-material · /sk/produkt/evidencia-naradia-a-majetku · /sk/produkt/reporty-a-prehlady · /sk/produkt/firemny-chat · /sk/novinky/{copilot-napric-stavario, ai-ve-stavebnim-deniku, dochazka-gps-fotka, raynet-crm-propojeni, stavebni-denik-pres-whatsapp, se-stavario-staci-mluvit, monitoring-majetku, sklady-zdarma, kros-slovensko-2021} · /robots.txt · /sitemap*.xml · https://play.google.com/store/apps/details?id=com.stavario.stavario · https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/06935338

**FLOWii:** https://www.flowii.com/sk/ · /cennik/ · /faktury-online/ · /blog/efaktura-vo-flowii-ako-bude-fungovat-od-roku-2027/ · /bezpecnost/ · /ochrana-osobnych-udajov/ · /licencne-podmienky/ · /cookies/ · /crm/ · /erp/ · /projektovy-manazment/ · /prijmy-a-vydavky/ · /skladova-evidencia/ · /dochadzkovy-system/ · /doplnky/ · /manual/ · /manual/api · /manual/partneri · /manual/fakturacia · /novinky/ai-asistent-pri-pisani-emailov-vo-flowii/ · https://flowii.betteruptime.com/

**KROS:** https://www.kros.sk/ · /cenniky · /omega/ · /omega/funkcie/ · /omega/cennik/ · /alfa-plus/ · /fakturacia/ · /fakturacia/cennik/ · /kros-firma/ · /kros-firma/cennik/ · /digitalna-kancelaria/ · /digitalna-kancelaria/cennik/ · /onix/ · /dochadzka/ · **/efaktura/** · /blog/ · /blog/efaktura-potrebuje-digitalneho-postara-takto-sme-si-ho-vyberali-my/ · /pravne-dokumenty/ · /pravne-informacie/ · /ochrana-osobnych-udajov/ · /licencne-podmienky/ · /obchodne-podmienky/ · /informacne-memorandum/

**iDoklad:** https://www.idoklad.cz/ · /cenik · /vlastnosti · /vlastnosti/vystavovani-faktur · /vlastnosti/sprava-kontaktu-a-obchodnich-pripadu · /vlastnosti/prehledy · /vlastnosti/doklady-pro-ucetni · /vlastnosti/propojeni-s-dalsimi-sluzbami · /api-a-doplnky-k-idokladu · /podminky-pouziti · /zasady-ochrany-osobnich-udaju · /bezpecnost-a-zalohovani · /cookie-policy · /blog · https://rozsireni.idoklad.cz/ · https://www.idoklad.sk/ · /cennik/

**STORMWARE (POHODA / mPOHODA):** https://www.stormware.cz/ · /pohoda/vlastnosti/ · /pohoda/cenik.aspx · /pohoda/rady/ · /pohoda/doplnky/ · /pohoda/novinky/ · /pohoda/hosting/ · **/e-fakturace/** · /podminky-uziti.aspx · /ochrana-osobnich-udaju.aspx · /zpracovatelska-smlouva.aspx · https://www.stormware.sk/pohoda/ · /pohoda/cenik.aspx · **/e-fakturacia/** · https://www.mpohoda.cz/ · /cenik/

**Interné (produkčná DB `assetpilot`, ref `fkpgvgvsmbpieduoatrt`):** `list_migrations`, `information_schema.columns`, `pg_constraint`, `pg_policy`, `pg_proc`, security advisors — všetko read-only, 20. 9. 2026.
