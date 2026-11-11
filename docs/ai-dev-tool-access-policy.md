# AI vývojové nástroje (Anthropic / Claude / Cowork) — pravidlá prístupu k údajom

Platné od: 2026-11-11 (J10.1). Základ: stanovisko CLIA z 11.11.2026 (Anthropic je opodstatnene uvedený ako ďalší
sprostredkovateľ, lebo pri servisných a diagnostických zásahoch môže dochádzať k spracúvaniu osobných údajov
Zákazníkov), DPA 1.3 príloha 3 bod 5, DPA príloha 1 §3, interná Smernica čl. 6.3, 7.2, 7.3, 9.3.

## Rozsah, v ktorom je Anthropic ďalší sprostredkovateľ

- vývoj, údržba, technický audit, diagnostika a **schválené servisné zásahy** do Aplikácie Esblu;
- **nie** je to AI funkcia Aplikácie pre Zákazníkov (tú poskytuje OpenAI) — v produkčnom kóde nie je žiadna
  závislosť, API kľúč ani volanie Anthropic (stráži `npm run test:clia-gdpr`);
- **nie** automatické ani plošné spracúvanie produkčných údajov.

## Predvolené pravidlá (default)

1. **Staging / syntetické údaje najprv.** Vývoj, testy a reprodukcia chýb prebiehajú na stagingu
   (`esblu-test`, syntetické účty `@esblu-qa.invalid`) alebo v PGlite. Produkcia iba ak cieľ nemožno dosiahnuť inak.
2. **Minimálny rozsah.** Prednostne schéma, metadáta, počty a časové rozsahy (agregácie) — nie obsahové riadky.
   Konkrétne riadky iba pri nevyhnutnom servisnom zásahu a iba stĺpce potrebné na účel.
3. **Žiadne plošné prehliadanie** zákazníckych údajov, žiadne `select *` nad obsahovými tabuľkami, žiadne dumpy
   tabuliek ani exporty mimo funkcií Aplikácie.
4. **Žiadne kopírovanie produkčných osobných údajov** do promptov, dokumentácie, commitov, issues, logov, reportov
   ani lokálnych súborov. Výstupy pre vlastníka obsahujú iba agregáty alebo identifikátory bez osobných údajov.
5. **Žiadne tajomstvá vo výstupoch** (kľúče, tokeny, heslá, service_role).
6. **Žiadne dlhodobé lokálne uchovávanie** produkčných údajov; dočasné pracovné kópie sa po zásahu odstránia
   (Smernica 9.3.1).
7. **Zápis / mazanie / migrácia v produkcii** iba s výslovným súhlasom vlastníka (hard stop).

## Produkčný servisný zásah

Pred zásahom: konkrétny účel, ohraničený rozsah (systém, tabuľky/objekty, iba čítanie vs. zápis), súhlas vlastníka
pri čomkoľvek inom ako read-only metadátach/agregáciách. Po zásahu: záznam v
`docs/ops/service-intervention-log.md` (bez osobných údajov). Technický prístup AI nástroja k produkcii sa
obmedzuje na nevyhnutné obdobie a rozsah (OWNER: pravidelne preverovať konektory a oprávnenia, Smernica 6.4.2).

## Kontrola

- `test:clia-gdpr` — v produktovom kóde nie je Anthropic integrácia.
- Git história `docs/ops/service-intervention-log.md` = nemenná evidencia zásahov.
- Pri zmene spôsobu používania (napr. Anthropic ako runtime AI pre Zákazníkov) → GDPR re-review, DPA príloha 3,
  15-dňová notifikácia Zákazníkom (DPA čl. IX).
