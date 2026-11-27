# VOP 1.4 — NÁVRH (nezverejnené)

Stav: **návrh na schválenie vlastníkom**. Súbory sú mimo `legal/`, aplikácia ich nenačíta ani nezverejní.
Dôvod: samoobslužné ukončenie firmy je od release 2026-11-26 vypnuté (`ESBLU_COMPANY_SELF_TERMINATION`),
VOP 1.3 čl. 20.1 však uvádza výmaz firmy iba v Aplikácii.

## Zmeny oproti 1.3 (SK/EN/DE)

1. **čl. 20.1** — výmaz Firmy Vlastníkom v Aplikácii (ak je funkcia dostupná) **alebo** žiadosťou na info@esblu.com
   z prihlasovacej e-mailovej adresy Vlastníka; primerané overenie totožnosti a oprávnenia (potvrdenie na tú adresu
   alebo v Aplikácii, pri odôvodnených pochybnostiach ďalšie nevyhnutné údaje); vybavenie bez zbytočného odkladu,
   najneskôr do 30 dní od doručenia; postup primerane podľa čl. 20.6 (export, potvrdenie nevratnosti, ukončenie
   registrácie e-faktúry, rozsah uchovaných údajov).
2. **čl. 44.5** — „nahrádzajú VOP vo verzii 1.3“ (prechodné ustanovenie rovnakým modelom ako 1.3).
3. Pätička „Verzia 1.4“. Ostatný text je zhodný s 1.3 (overené `diff`).

SHA-256 `1.4.md` (SK, záväzné znenie): `70031be4a67967d3707a1163a8b3969d249fb7c2273d6c5124202a8c25eb77a1`

## Súlad

| Článok / predpis | Posúdenie |
|---|---|
| 17.2 (výpoveď) | Bez zmeny. Výpoveď na info@esblu.com ostáva; „vymazaním Firmy v Aplikácii podľa článku 20“ je s „ak je dostupná“ v 20.1 konzistentné. Žiadosť o výmaz podľa 20.1 je zároveň písomná výpoveď podľa 17.2 (účinnosť podľa 17.2 vety 2–4). |
| 20.2 | Bez zmeny. Obmedzenia (b) sa týkajú samoobslužného výmazu; žiadosť podľa 20.1 sa vybaví postupom 20.6. Predplatné (a): pri žiadosti sa postupuje podľa 20.3 / 17.2 (nevracia sa zaplatené obdobie bez potvrdenia Vlastníka). |
| 20.4 | Bez zmeny. „Zrušenie jeho účtu je možné až po vymazaní ním vlastnených Firiem“ — vymazanie môže prebehnúť aj na žiadosť podľa 20.1, Vlastník teda nie je zablokovaný. |
| 20.6 | Bez zmeny; 20.1 naň odkazuje „primerane“, aby rovnaké záruky (export, potvrdenie nevratnosti, deregistrácia e-faktúry, minimálne uchovanie) platili aj pre firmy bez dokladov. |
| 39.2 / 39.3 | Zmena pridáva spôsob výmazu, ale zároveň podmieňuje výmaz v Aplikácii dostupnosťou funkcie → odporúčanie: postup **39.2** (oznámenie 30 dní, `required=false`, `reaccept_notice_days=30`), rovnako ako 1.3. 1.4 môže nahradiť 1.3 aj počas plynúcej lehoty 1.3 — Vlastník, ktorý 1.3 neprijal, prijme priamo 1.4. |
| GDPR čl. 12 ods. 3 a 6, čl. 17 | Údaje Firmy spracúva Esblu ako sprostredkovateľ (DPA) — výmaz je zmluvný pokyn Zákazníka, nie žiadosť dotknutej osoby; lehota 30 dní je kratšia/rovná mesiacu podľa čl. 12 ods. 3. Overenie totožnosti iba „primerané“ a pri „odôvodnených pochybnostiach“ ďalšie údaje — zodpovedá čl. 12 ods. 6 a minimalizácii (nežiadame doklad totožnosti plošne). Žiadosti Používateľov ako dotknutých osôb (privacy@esblu.com, Zásady 1.5) ostávajú samostatným postupom; zrušenie osobného účtu v Aplikácii je naďalej dostupné. |

## Zverejnenie (až po schválení)

1. `git mv docs/legal-drafts/terms-1.4/1.4*.md legal/terms/`
2. `lib/legal-config.ts`: `termsVersion: "1.4"` + zoznam verzií.
3. Migrácia `supabase/migrations/<ts>_terms_1_4_company_deletion_request.sql`:
   `insert into public.legal_documents (type, version, effective_at, required, content_hash, canonical_path, reaccept_notice_days) values ('terms','1.4',now(),false,'<sha256 1.4.md>','/podmienky-pouzivania',30) on conflict (type, version) do nothing;`
   + rollback súbor (fail closed pri prijatiach 1.4).
4. Testy (legal hash, i18n), Preview, produkčná migrácia bezprostredne pred nasadením kódu.

Ak sa samoobslužné ukončenie firmy znova zapne (`ESBLU_COMPANY_SELF_TERMINATION=on`), treba vrátiť aj texty
`settings.deleteAccount.ownerDescription`, `settings.deleteModal.globalBlockedOwns` a `legal.accountDeletionPage.intro`.
