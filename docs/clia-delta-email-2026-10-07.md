# CLIA — delta k aktualizácii zo 4. 10. 2026 (návrh 7. 10. 2026)

**Stav:** pripravené na odoslanie, NEODOSLANÉ. Odosiela vlastník.
**Nadväzuje na:** e-mail a 12-stranovú prílohu zo 4. 10. 2026 (`clia-delta-annexes-2026-10-04.md` vo vetve
`main`, Príloha 6 eFaktúra, Príloha 7 uchovávanie). Pôvodný balík sa znovu NEPOSIELA.
**Príloha:** nie je potrebná — delta je krátka a nové dátové kategórie ani príjemcovia nepribudli.
E-mail neobsahuje heslá, kľúče, tokeny ani interné identifikátory.

Interné poznámky (do e-mailu nepatria):
- Technické detaily bez vplyvu na GDPR/právny model sa zámerne vynechávajú: kurzy ECB, § 73 lehoty,
  monitoring, crony, formát XML.
- Retenčné tvrdenia zodpovedajú kódu. Doklady sa nemažú. Zrušenie firmy s účtovnými dokladmi je odmietnuté
  pred akýmkoľvek mazaním (commit `4947ba1`).

---

**Predmet:** Esblu — doplnenie k aktualizácii zo 4. 10. 2026 (eFaktúra a uchovávanie dokladov)

Dobrý deň,

nadväzujeme na našu konsolidovanú aktualizáciu zo 4. 10. 2026. Odvtedy sme dokončili eFaktúru. Ide stále
iba o testovacie prostredie: v produkcii nie je aktivovaná a zmluva s eFaktura.sk nie je podpísaná. Zároveň
sme upravili jedno pravidlo pri rušení firmy. Posielame iba zmeny, ktoré sa podľa nás môžu týkať GDPR alebo
zmluvnej dokumentácie. Ostatné body prílohy zo 4. 10. platia bez zmeny.

**Čo sa zmenilo od 4. 10. 2026**

1. **eFaktúra — model je finálny (Príloha 6).** Platí API model s eFaktura.sk, ako sme ho opísali 4. 10.:
   - klient si na portáli Finančnej správy zvolí eFaktura.sk a overovací kód zadá v Esblu;
   - Esblu nie je vedené ako sprostredkovateľ.

   Novinky sú tri:
   - Esblu cez poskytovateľa odosiela aj prijíma štruktúrované faktúry vrátane faktúry k prijatej platbe
     (záloha) a dobropisov a ťarchopisov s väzbou na pôvodnú faktúru. Prijíma aj konečné faktúry
     s odpočtom záloh; ich odosielanie dokončujeme. Rozsah údajov sa tým nemení.
   - Prijaté doklady sa ukladajú v pôvodnom XML. Esblu navrhne väzbu (oprava → pôvodná faktúra,
     konečná faktúra → záloha), ale iba v rámci tej istej firmy a od toho istého dodávateľa. Väzbu
     vždy potvrdí alebo zamietne človek s finančným oprávnením. Esblu automaticky nerozhoduje o DPH
     ani o nároku na odpočet.
   - Poskytovateľ posiela Esblu udalosti (stav doručenia, prijatý doklad) cez webhook a periodické
     načítanie zoznamu udalostí. Z udalostí si Esblu ukladá iba technické metadáta (stav, kontrolný
     odtlačok, čas) a maže ich po 90 dňoch.

   Nové kategórie osobných údajov ani noví príjemcovia oproti 4. 10. nepribudli.
2. **Prístup.** Nové role nepribudli. eFaktúru, úhrady a export vidí a spravuje iba vlastník, účtovník
   alebo člen s finančným oprávnením v rámci svojej firmy. Zamestnanec bez finančného oprávnenia k nim
   prístup nemá.
3. **Úhrady.** Stav doručenia e-faktúry je oddelený od stavu úhrady: doručenie neznamená zaplatenie.
   Bankové napojenie nemáme. Úhrady, vrátenia a preplatky eviduje používateľ ručne.
4. **Export pre účtovníka.** Balík za obdobie obsahuje pôvodné XML s kontrolou neporušenosti, PDF
   a prehľady úhrad, opráv a záloh. Vytvára ho iba oprávnený používateľ vlastnej firmy a Esblu ho neukladá.
5. **Zrušenie firmy — zmena oproti Prílohe 7.** Firmu, ktorá má finalizované účtovné doklady alebo
   e-faktúry, už nemožno zrušiť samoobslužne. Žiadosť sa odmietne skôr, než sa čokoľvek zmaže, a používateľ
   dostane výzvu na export a kontakt na podporu. Dôvod: doklady sa zámerne nemažú a predchádzajúci postup
   by zmazal súbory, ale doklady by v databáze ostali (čiastočné zmazanie). Firmy bez účtovných dokladov
   sa rušia ako doteraz.
6. **Archív.** E-faktúry sa v Esblu automaticky nemažú. Esblu však nesľubuje zákonný 10-ročný archív,
   kým to nebude výslovne zmluvne definované. Povinnosť uchovávať doklady má podľa zákona klient
   (zákon o účtovníctve § 35, zákon o DPH § 76).

**Prosíme o stanovisko k týmto otázkam**

1. **Zrušenie firmy s účtovnými dokladmi.** Pri ukončení zmluvy má Esblu ako sprostredkovateľ údaje
   vrátiť alebo vymazať (čl. 28 ods. 3 písm. g) GDPR). Klient má však zákonnú povinnosť doklady uchovávať
   10 rokov. Ako má Esblu postupovať?
   - Stačí export a následné vymazanie?
   - Smieme na žiadosť klienta doklady ďalej uchovávať v režime iba na čítanie? Na akom zmluvnom
     základe a ako dlho?
   - Čo z toho musí byť v Podmienkach používania a v DPA?
2. **Doba uchovávania v Esblu.** Akú dobu uchovávania máme určiť pre e-faktúry (XML) a ich metadáta
   počas trvania zmluvy a po ňom? Postačuje formulácia, že Esblu nie je zákonným archívom, alebo treba
   viac?
3. **eFaktura.sk.** Rola poskytovateľa, DPA a subdodávatelia (otázky z Prílohy 6) ostávajú otvorené.
   Poskytovateľovi sme ich položili a jeho odpovede Vám pošleme. Prosíme o potvrdenie, či ste pripravení
   ich posúdiť pred produkčným spustením a či treba pred spustením aktualizovať Zásady ochrany osobných
   údajov, DPA a zoznam subprocesorov.

Produkčné spustenie eFaktúry neuskutočníme pred Vaším stanoviskom k týmto bodom.

S pozdravom

Jaroslav Juriš
konateľ
Esblu s. r. o.
info@esblu.com
