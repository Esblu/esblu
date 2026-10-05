# CLIA delta — eFaktúra cez eFaktura.sk (API partner model), stav 6. 10. 2026

**Účel:** doplnok k `clia-delta-annexes-2026-10-04.md`, ktorý **nahrádza Prílohu 6** (eFaktúra / Peppol).
**Stav funkcie:** iba test (sandbox eFaktura.sk + testovacia databáza Esblu). V produkcii Esblu sa
eFaktúra nepoužíva, produkčný API kľúč ani zmluva s eFaktura.sk nie sú aktivované.
**Nie je to právne stanovisko.** Sekcia A obsahuje iba technické fakty overené Esblu. Všetko, čo je
právna kvalifikácia, je v sekcii C ako otázka pre CLIA. Úspešné testy nič právne nepotvrdzujú.

---

## A. Technické fakty (overené Esblu, syntetické dáta)

### A1. Model

- Esblu používa **Agent API eFaktura.sk ako API partner** (partnerský kľúč). White-label sa nepoužíva.
- Esblu **nie je** na portáli Finančnej správy (FS) zaregistrovaný ako poskytovateľ ani sprostredkovateľ.
  Klient si na portáli FS sám zvolí eFaktura.sk ako poskytovateľa a overovací kód FS zadá v Esblu.
- Esblu pre klienta založí organizáciu u eFaktura.sk (názov, IČO, DIČ, IČ DPH, adresa firmy) a aktivuje
  príjem (`enroll`) s overovacím kódom. **Overovací kód Esblu neukladá, nevracia ani neloguje** — použije
  sa v jednej požiadavke na eFaktura.sk.
- Stav príjmu sa vedie oddelene od odosielania (aktívny / čaká / iba odosielanie / zlyhal / deaktivovaný).

### A2. Tok údajov

| Krok | Esblu → eFaktura.sk | eFaktura.sk → Esblu |
| --- | --- | --- |
| Založenie organizácie | názov, IČO, DIČ, IČ DPH, adresa firmy | ID organizácie, stav |
| Aktivácia príjmu | FS overovací kód (iba v požiadavke) | výsledok; neskôr udalosť `participant.*` |
| Odoslanie faktúry | celý doklad UBL 2.1 (EN 16931 / Peppol BIS 3.0): dodávateľ a odberateľ (názov, adresa, IČO/DIČ/IČ DPH, kontakt, ak je vyplnený), bankové údaje, položky, sumy, DPH, poznámky | ID podania, stav, dôkaz doručenia |
| Príjem faktúry | — | pôvodné XML dokladu; udalosti `peppol.document.*` |
| Udalosti | — | webhook (podpísaný HMAC) a feed udalostí (90 dní u poskytovateľa) |

### A3. Čo ukladá Esblu

- Mapovanie firma ↔ organizácia u eFaktura.sk, stav príjmu, kód poslednej chyby.
- Odoslané a prijaté XML (súkromné úložisko, nemenné, SHA-256).
- Stav a dôkaz doručenia (iba povolené polia).
- Udalosti webhook/feed **bez tela správy** (iba SHA-256 tela, typ udalosti, firma, stav, počet pokusov).
- Pokusy o aktiváciu príjmu (firma, používateľ, čas, výsledok — **nie** kód) na 30 dní.
- Koncept prijatej faktúry a automaticky založený dodávateľ (názov, IČO, DIČ, IČ DPH, adresa, Peppol ID).

### A4. Čo bolo reálne overené proti sandboxu eFaktura.sk (5.–6. 10. 2026)

- založenie organizácie, aktivácia príjmu (úspech / neplatný kód / príjem drží iný poskytovateľ);
- odoslanie faktúry A → B, doručenie, dôkaz doručenia;
- príjem u B: XML zhodné s odoslaným (SHA-256), koncept na kontrolu, potvrdenie prevzatia;
- webhooky dokumentov aj účastníka doručené z eFaktura.sk, podpis, ochrana proti opakovaniu, idempotencia;
- izolácia firiem (iná firma ani zamestnanec bez finančných oprávnení nič nevidí).

### A5. Čo Esblu nesľubuje

- **Esblu zatiaľ nesľubuje zákonný dlhodobý archív dokladov.** Retencia XML v Esblu nie je finálne
  určená; hromadný export nie je implementovaný.
- Dobropisy (opravné doklady) v príjme zatiaľ nie sú podporované (idú na ručné spracovanie).
- Prijatý doklad vzniká iba ako **koncept**; Esblu ho automaticky neúčtuje.

---

## B. Čo musí zabezpečiť zmluva / DPA s eFaktura.sk (vstup pre CLIA)

1. Rola eFaktura.sk voči Esblu a voči klientom Esblu (sprostredkovateľ Esblu / ďalší sprostredkovateľ /
   samostatný prevádzkovateľ vo vzťahu ku klientovi).
2. DPA: predmet, kategórie údajov (sekcia A2), doba, bezpečnosť, audit, notifikácia incidentov.
3. Subprocesori eFaktura.sk (hosting, Peppol Access Point, ďalší), lokalita, prenosy mimo EHP.
4. Retencia u eFaktura.sk (dokumentácia uvádza archív 10 rokov, feed udalostí 90 dní) — zmluvne a po skončení zmluvy.
5. Export / prenositeľnosť dokladov pre klienta pri ukončení zmluvy alebo zmene poskytovateľa.
6. SLA a zodpovednosť za doručenie / nedoručenie.
7. Cena a záväzky (program, minimálne platby) — rozhodnutie vlastníka, mimo CLIA.

---

## C. Otázky pre CLIA

1. Je model „klient zvolí eFaktura.sk na portáli FS, Esblu prenesie overovací kód a aktivuje príjem cez API“
   v súlade s pravidlami FS a nevyžaduje registráciu Esblu ako sprostredkovateľa?
2. Aká je rola Esblu a eFaktura.sk z pohľadu GDPR (sekcia B1) a aký zmluvný reťazec je potrebný
   (Esblu ↔ klient DPA, Esblu ↔ eFaktura.sk DPA / priamy vzťah klient ↔ eFaktura.sk)?
3. Treba doplniť eFaktura.sk a jeho subprocesorov do zoznamu subprocesorov Esblu a do informácií o spracúvaní?
4. Postačuje text súhlasu v UI („potvrdzujem, že som v portáli FS zvolil eFaktura.sk…“) a informácia,
   že overovací kód sa použije jednorazovo a neuloží?
5. Zodpovednosť Esblu pri chybnom alebo oneskorenom doručení, odmietnutí sieťou a výpadku poskytovateľa.
6. Ako formulovať vo VOP, že **Esblu neposkytuje zákonný archív** (kým nebude retencia a export dokončený)?
7. Retencia technických údajov v Esblu (XML, udalosti bez tela 90 dní, pokusy o aktiváciu 30 dní) —
   primeraná doba a právny základ?
8. Prenos osobných údajov fyzických osôb v dokladoch (SZČO, kontakty) — potrebné informačné povinnosti?

## D. Otázky pre slovenskú účtovníčku

1. Je účtovným dokladom pôvodné XML (UBL) prijaté cez Peppol, a vizualizácia v Esblu je iba pomôcka?
2. Postup kontroly konceptu prijatej faktúry pred zaúčtovaním — čo musí používateľ overiť?
3. Automaticky založený dodávateľ (IČO, DIČ, IČ DPH z XML) — stačí, alebo je potrebná ručná kontrola pri prvom doklade?
4. Mapovanie DPH: kategórie S, Z, E, AE, K, G, O, sadzby, rozpis DPH podľa XML, zaokrúhlenie — správne pre bežné prípady?
5. Dátumy: dodanie, DUZP (ak chýba v XML), splatnosť — aké pravidlá platia, keď XML pole neobsahuje?
6. Dobropisy a opravné faktúry cez Peppol — ako ich spracovať, kým ich Esblu automaticky nepodporuje?
7. Archivácia: ako dlho a v akej forme musí klient uchovávať XML, a či stačí archív poskytovateľa?
8. Číslovanie a nemennosť vydaných faktúr v Esblu (číslo pri finalizácii, nemenný snapshot) — vyhovuje?

## E. Zmeny voči podkladu zo 4. 10. 2026

- Model je potvrdený ako **API partner** s povinnou aktiváciou príjmu FS kódom (nie automatická registrácia).
- Doplnené: UI aktivácie príjmu, limit pokusov o aktiváciu, auditovateľný stav zlyhaných udalostí,
  DIČ dodávateľa z XML, kurzor feedu udalostí.
- Výsledky sandboxu (sekcia A4).
- Stav: stále iba test; produkčná aktivácia čaká na sekcie B, C a D.
