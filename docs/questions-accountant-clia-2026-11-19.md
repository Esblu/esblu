# Otázky — účtovníčka (Stripe fakturácia) a CLIA (retenčný archív)
INTERNÝ PODKLAD — neodosielať bez schválenia prevádzkovateľa. Podrobnosti: `docs/accountant-questions-billing-2026-11-19.md`, `docs/clia-gdpr-delta-consolidated-2026-11-19.md`.

## Účtovníčka — fakturácia predplatného cez Stripe
1. Môže byť faktúra vystavená Stripe Billing (vlastné číslovanie Stripe, PDF zo Stripe) jediným daňovým dokladom Esblu s. r. o.? Ak nie, aké číslovanie a náležitosti musí mať doklad z Esblu?
2. Esblu je registrovaná podľa § 7a, nie je platiteľ DPH: aký text má byť na faktúre pre SK odberateľa a pre odberateľa z iného členského štátu (B2B, služba)? Vzniká pri prijatí platby od EÚ firmy povinnosť platiť DPH v SR (reverse charge v opačnom smere) alebo podávať súhrnný výkaz?
3. Predávame aj fyzickým osobám (B2C) mimo SR? Ak áno — OSS / limit 10 000 €?
4. Refundácia: stačí dobropis zo Stripe (credit note) ako opravný doklad? Kedy refundovať a kto smie?
5. 48-hodinová lehota po skončení obdobia: vzniká tým plnenie/doklad?
6. Mesačný export (hrubé platby, Stripe poplatky, refundácie, výplaty na účet): stačí CSV z Esblu, alebo potrebujete aj Stripe reporty/PDF? Ako účtovať Stripe poplatky (zahraničná služba — samozdanenie pri § 7a)?
7. Lehota uchovania účtovných kópií Esblu (navrhujeme 10 rokov od konca roka dokladu) — potvrdiť.
8. Ak firma po vystavení faktúry doplní IČ DPH, má sa snapshot odberateľa na doklade meniť? (navrhujeme nie)
9. Bude Esblu povinná posielať štruktúrované e-faktúry (Peppol) za predplatné a odkedy? Ak áno, je Stripe faktúra + e-faktúra s tým istým číslom prípustná?

## CLIA — retenčný archív pri ukončení firmy (vlna B)
1. Smie Esblu po ukončení zmluvy s firmou-zákazníkom uchovávať jej finalizované faktúry, XML e-faktúr a dôkazy doručenia v uzavretom archíve (namiesto výmazu), vzhľadom na čl. 28 ods. 3 písm. g) GDPR a DPA (vrátenie alebo výmaz)? Na akom právnom základe a v akej role (sprostredkovateľ/prevádzkovateľ)?
2. Ak áno: lehota (navrhujeme 10 rokov od konca roka dokladu), kto môže žiadať o výdaj (bývalý zákazník, úrad) a ako to uviesť v DPA/Zásadách (DRAFT znenia v CLIA podklade)?
3. Režim „bez exportu“ (`waived`): je prípustné, aby zákazník odmietol export a Esblu doklady aj tak uchovala?
4. Dôkazy o prenosoch e-faktúr a o elektronickom poverení (hash IP/UA) po ukončení firmy — lehota a právny základ?
5. Účtovné kópie Esblu so snapshotom odberateľa (meno a adresa SZČO) — postačuje zákonná povinnosť Esblu (čl. 6 ods. 1 písm. c) a ako to uviesť v Zásadách?
6. Od 12. 11. 2026 produkčné ukončenie firmy mazalo doklady; použité bolo iba 5× na syntetické testovacie firmy (19. 11.), reálne doklady zákazníkov dotknuté neboli — treba túto informáciu CLIA formálne opraviť (podklad z 10. 11.)?
