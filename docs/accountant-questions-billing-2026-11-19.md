# Otázky pre účtovníčku — doklady za predplatné Esblu cez Stripe (2026-11-19)

**Kontext (fakty, nie závery):** Esblu s. r. o. (IČO 57815941) je registrovaná podľa **§ 7a** zákona o DPH (nie je
platiteľ podľa § 4). Predáva SaaS predplatné „Esblu Komplet“ 15,90 EUR / mesiac cez Stripe (karta, Apple/Google Pay).
Stripe po každej platbe automaticky vytvorí faktúru (PDF, číslo, hosted stránka); refundácia môže vytvoriť dobropis
(credit note). Zákazník pri platbe zadáva fakturačnú adresu a voliteľne IČ DPH (Stripe ho dnes neoveruje vo VIES).
Stripe Tax ani daňové sadzby dnes nie sú nastavené — faktúra by bola bez riadku DPH. Technicky dokážeme obe cesty:
**A** = Stripe faktúra je daňový doklad; **B** = doklad vystavuje Esblu (vlastný rad, neskôr e-faktúra cez
eFaktura.sk / Peppol) a Stripe iba inkasuje (detail: `docs/billing-invoicing-architecture-2026-11-19.md`).
Prosíme o odpovede **ku každej otázke** — nič z nich sme nepredpokladali.

## A. Daňový režim a text na doklade

1. Je predaj predplatného slovenskému odberateľovi (podnikateľ aj nepodnikateľ) zo strany Esblu ako osoby registrovanej
   podľa § 7a zdaniteľné plnenie, pri ktorom Esblu **neúčtuje DPH**? Aký presný text má byť na doklade (napr. odkaz na
   ustanovenie zákona, „nie sme platiteľ DPH“ a pod.)?
2. Má sa na doklade uvádzať IČ DPH pridelené podľa § 7a? Ak áno, v akom tvare a s akým textom?
3. Predaj odberateľovi z **iného štátu EÚ s platným IČ DPH** (B2B služba): kde je miesto dodania, je to pre Esblu
   (§ 7a) plnenie s prenesením daňovej povinnosti, aký text musí byť na faktúre, vzniká povinnosť podávať **súhrnný
   výkaz**, a musíme IČ DPH odberateľa **overiť vo VIES a overenie archivovať** (kedy, ako často)?
4. Predaj **nepodnikateľovi alebo podnikateľovi bez IČ DPH z iného štátu EÚ** (B2C elektronická služba): vzniká Esblu
   povinnosť registrácie / OSS a od akej hranice? Odporúčate pri spustení predaj mimo SK alebo B2C **vylúčiť**?
5. Predaj mimo EÚ (napr. CH, UK, US): má sa pri spustení vôbec povoliť? Ak áno, aký text na doklade?
6. Ako postupovať, keď zákazník zadá IČ DPH, ktoré je neplatné / neoverené — vystaviť doklad ako B2C, alebo predaj
   zablokovať?
7. Má sa zapnúť **Stripe Tax** (automatický výpočet a evidencia), alebo stačí pevný text na faktúre podľa krajiny?
   Ak zapnúť, s akým `tax_behavior` ceny (s DPH / bez DPH / nešpecifikované)?

## B. Náležitosti a číslovanie

8. Stačí **číselný rad Stripe** (možnosti: jeden rad na celý účet, alebo rad na zákazníka; prefix nastaviteľný), alebo
   musí Esblu viesť vlastný rad nadväzujúci na iné doklady Esblu s. r. o.?
9. Ktoré náležitosti musí faktúra za predplatné obsahovať (dodávateľ: obchodné meno, sídlo, IČO, DIČ, IČ DPH; odberateľ;
   dátum vyhotovenia, **dátum dodania** pri mesačnom predplatnom, obdobie služby, jednotková cena, mena) — a čo z toho
   musí byť doplnené ako vlastné pole / pätička v Stripe?
10. Jazyk dokladu: musí byť slovensky pre SK odberateľov? Prípustný je dvojjazyčný doklad pre zahraničných?
11. Mena: predávať iba v EUR? Ak by Stripe zobrazil inú menu, aký kurz a evidencia?

## C. Ktorý doklad je daňový (variant A / B) a e-faktúra

12. Prijímate **variant A** (Stripe faktúra = jediný daňový doklad, Esblu iba archivuje kópiu)? Ak nie, prečo — a
    akceptujete variant B s textom na Stripe dokumente „nie je daňový doklad“ (presná formulácia)?
13. Vzťahuje sa na Esblu (§ 7a) povinnosť **štruktúrovanej elektronickej faktúry** (eFaktúra / Peppol) pri predaji
    predplatného slovenským platiteľom DPH alebo iným podnikateľom, a od akého dátumu?
14. Ak áno: je prípustné, aby štruktúrovaná e-faktúra bola elektronickou podobou **tej istej** Stripe faktúry (rovnaké
    číslo, sumy, dátumy) — teda jeden doklad v dvoch formátoch? Alebo musí byť jediným originálom e-faktúra a PDF zo Stripe
    sa nesmie zákazníkovi posielať?
15. Ak zákazník (firma) dostane PDF zo Stripe aj e-faktúru, ako zabezpečiť, aby sa nepovažovali za dva doklady?

## D. Refundácie, spory, ochranná lehota

16. Plná refundácia aktuálneho obdobia: je **Stripe credit note** (dobropis k pôvodnej faktúre, s vrátením peňazí na
    kartu) správny opravný doklad? Aký text / dôvod?
17. Čiastočná refundácia (prístup sa nemení): rovnaký postup? Musí dobropis uvádzať dôvod a pôvodné číslo faktúry?
18. Refundácia staršej faktúry (nie aktuálneho obdobia): rovnaký postup?
19. **Spor (chargeback)** — peniaze strhne banka zákazníka, Stripe účtuje poplatok (napr. 20 EUR): treba vystaviť opravný
    doklad? Ak spor vyhráme, čo s ním? Ako účtovať poplatok za spor?
20. Bezplatná 48-hodinová ochranná lehota po skončení zaplateného obdobia (služba beží ďalej bez platby): je to
    bezodplatné plnenie s vplyvom na DPH alebo doklad? Treba ju uvádzať na faktúre?
21. Zlyhaná obnova (karta zamietnutá, 7-dňová lehota): Stripe faktúra ostane „open“ / „uncollectible“ / „void“ — ktorý
    z týchto stavov je pre vás daňový doklad, ktorý treba stornovať, a ako?

## E. Poplatky Stripe, výplaty, párovanie

22. Poplatky Stripe (Stripe Payments Europe, Írsko): sú oslobodené (§ 39) alebo zdaniteľné; vzniká Esblu (§ 7a)
    povinnosť **samozdanenia** z mesačnej daňovej faktúry Stripe a podania daňového priznania / súhrnného výkazu?
23. Účtovanie: postačuje mesačný export (pre každý doklad: hrubá suma, poplatok Stripe, čistá suma, ID výplaty; plus
    všetky balance transactions mesiaca — refundácie, spory, výplaty, úpravy) v CSV? Aké stĺpce chýbajú?
24. Ako chcete párovať výplatu (payout) na bankový výpis — jedna položka na výplatu, alebo rozpis po dokladoch?
25. Do akého dňa v mesiaci potrebujete export za predchádzajúci mesiac?

## F. Archivácia a prístup

26. Je potrebný vlastný archív PDF dokladov v Esblu (nezávislý od Stripe účtu) a na akú dobu (10 rokov)? Stačí PDF +
    SHA-256 + metadáta v našej DB, alebo vyžadujete aj iný formát?
27. Má mať účtovníčka priamy prístup do Stripe Dashboardu (rola „View only“ / „Analyst“), alebo iba exporty?
28. Kto (meno / rola) smie vystavovať dobropisy a refundácie v Stripe?

## G. Rozsah spustenia

29. Odporúčate pri spustení predaj **iba SK B2B** (s IČO) a ostatných zákazníkov technicky blokovať, kým sa nevyriešia
    otázky 3–7?
30. Je niečo, čo musí byť nastavené alebo podané (registrácia, oznámenie DÚ) **pred** prvou platbou cez Stripe?
