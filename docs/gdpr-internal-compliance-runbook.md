# GDPR — interný compliance runbook (organizačné opatrenia)

Vznik: J10 CLIA GDPR reconciliation (2026-11-10), podľa Manuálu implementácie Nariadenia GDPR CLIA v1.0
(09.11.2026), čl. IV, V a VII. Tento runbook **neobsahuje** text internej Smernice, testov proporcionality ani
záznamov o spracovateľských činnostiach — tie sú interné a do repa ani na web sa nekopírujú.

> Claude / Cowork nesmie podpísať, datovať ani „schváliť“ žiadny dokument v mene konateľa. Všetky kroky
> označené **[KONATEĽ]** vykonáva výlučne štatutárny orgán Esblu s. r. o.

## 1. Schválenie internej Smernice o ochrane osobných údajov

1. **[KONATEĽ]** prečíta finálnu verziu CLIA (v1.0, 09.11.2026) a rozhodne o schválení.
2. **[KONATEĽ]** doplní do histórie verzií: dátum schválenia, verziu, autora a do čl. 13 dátum + podpis.
   Dátum účinnosti = deň schválenia (Smernica 13.1).
3. Podpísaný originál (PDF sken + DOCX) uložiť do internej GDPR zložky (§3). Nie do repa, nie na web.
4. Do `docs/MASTER-PRELAUNCH-CHECKLIST.md` J10 zapísať iba: „Smernica v1.0 schválená dňa …“ (bez obsahu).
5. Každá zmena = nová verzia so zápisom v histórii verzií a novým schválením (Smernica 13.2).

## 2. Oboznámenie osôb

- Dnes k OÚ pristupuje iba konateľ. Pri prvej ďalšej osobe (zamestnanec, externista, účtovník s prístupom do
  produkcie) **[KONATEĽ]**: oboznámenie so Smernicou (prístupy, vývoj a testovanie, podpora, exporty, incidenty),
  záväzok mlčanlivosti, záznam „kto / kedy / verzia“ v internej zložke.
- AI vývojové nástroje (Claude/Cowork): iba repo + staging so syntetickými dátami. Prístup k produkčným osobným
  údajom Zákazníkov sa nepoužíva (podmienka alternatívy A pre Anthropic — `docs/clia-gdpr-reconciliation-2026-11-10.md`
  §8); produkčné operácie iba read-only metadáta / schéma a iba s výslovným súhlasom vlastníka.

## 3. Interné úložisko GDPR dokumentácie

- Jedna privátna zložka (napr. firemný cloud s 2FA), prístup iba konateľ. Obsah: Smernica (podpísaná), 6 testov
  proporcionality, 2 záznamy o spracovateľských činnostiach (XLSX), manuál CLIA, uzatvorené DPA so Zákazníkmi
  (ak sa uzatvárajú mimo appky), log zásahov (§4), register incidentov (§5), register žiadostí (§6).
- Lokálna kópia balíka pre vývoj: `legal-inbox/clia-2026-11-09/` (vylúčené z gitu cez `.git/info/exclude`).
  Po uložení do internej zložky lokálnu kópiu odporúčame zmazať.

## 4. Log administrátorských zásahov a exportov (Smernica 6.3.2, 9.2.2)

Technický audit log neexistuje → manuálny záznam (tabuľka v internej zložke), uchovávať **najviac 12 mesiacov**:

| dátum a čas | kto | systém (Supabase / Vercel / Storage) | Zákazník | dôvod | rozsah (aké dáta) | výsledok | export? príjemca |
|---|---|---|---|---|---|---|---|

Zapisuje sa každý prístup k produkčným osobným údajom mimo funkcionalít appky (SQL nad obsahovými tabuľkami,
Storage objekty, ručné úpravy, exporty). Ak sa dá úkon vykonať bez obsahu OÚ (schéma, počty), uprednostniť to.

## 5. Bezpečnostné udalosti a porušenia (Smernica 10.3)

- Postup: `docs/data-breach-procedure.md`. Register udalostí: bez porušenia ≤ 12 mesiacov od uzavretia
  preverovania; potvrdené porušenia ≤ 5 rokov od uzavretia.
- Porušenie týkajúce sa dát Zákazníka → oznámiť Zákazníkovi bez zbytočného odkladu (DPA 6.3.7) na e-mail z účtu.

## 6. Žiadosti dotknutých osôb a zákaznícka podpora

- Vstup: privacy@esblu.com / info@esblu.com (Namecheap). Lehota odpovede 1 mesiac (+2 pri odôvodnení).
- Register žiadostí: dátum prijatia, žiadateľ, právo, overenie totožnosti, úkony, odpoveď, dátum → uchovávať
  **≤ 3 roky** od vybavenia. Žiadosť k dátam Zákazníka → postúpiť Zákazníkovi + súčinnosť.
- Podpora: e-maily vybavených požiadaviek v schránke **≤ 12 mesiacov** od vybavenia — **[KONATEĽ]** raz za
  štvrťrok premazať staršie vlákna (okrem tých, ktoré treba pre právny nárok alebo účtovníctvo).
- Súkromné účty (napr. Gmail) sa na komunikáciu so Zákazníkmi nepoužívajú (Smernica 10.1.3), pokiaľ ich CLIA
  nedoplní do PP a registra.

## 7. Kedy znovu preveriť dokumentáciu (Manuál 7.3, Smernica 12.5)

Povinný GDPR re-review (PP, DPA príloha 3 + 15-dňová notifikácia Zákazníkom, registre, LIA, DPIA potreba) pred:

- aktiváciou eFaktura.sk, Stripe, Google Play / Apple billingu, APNs, Sign in with Apple;
- novým AI modelom/providerom alebo rozšírením AI na nové dáta;
- zapnutím náhľadu správ v push notifikáciách;
- akoukoľvek analytikou, marketingom alebo vloženým obsahom tretích strán (→ CMP / súhlasová lišta);
- zmenou regiónu infraštruktúry alebo novým e-mailovým providerom (custom SMTP).
