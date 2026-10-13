# E-Faktúra (Peppol) — change request pre CLIA

**Dátum:** 2026-10-02
**Účel:** podklad pre právne / GDPR posúdenie novej funkcie
**Stav:** technický opis. **Nie je** to právne stanovisko ani návrh finálneho znenia.

Právne dokumenty (Privacy Policy 1.3, DPA 1.2, Podmienky 1.x, Cookies 1.0, zoznam
subprocesorov) sa v tejto fáze **nemenia**. Ich verzie sa nezvyšujú. Tento dokument
nadväzuje na `docs/invoicing-compliance-delta-for-clia.md` (2026-09-20), kde bol
Peppol uvedený ako „zatiaľ nevybraný poskytovateľ“. Poskytovateľ je teraz vybraný
(eFaktura.sk Agent API) a funkcia je implementovaná. V produkcii zatiaľ **nie je
aktivovaná**.

---

## 1. Faktický opis novej funkcionality

Modul **E-Faktúra** (platený nárok `einvoice`, sprístupňuje sa iba firmám na
serverovom allowliste):

1. **Odoslanie e-faktúry.** Finalizovanú vydanú faktúru môže používateľ s právom
   finance.manage (owner, accountant, admin s explicitným finančným oprávnením)
   **na explicitné potvrdenie** odoslať cez sieť Peppol. Esblu vytvorí nemenný
   dokument UBL 2.1 (Peppol BIS Billing 3.0 / EN 16931) z uloženého snapshotu
   faktúry a uloží jeho presné bajty so SHA-256. Potom ho odovzdá poskytovateľovi
   eFaktura.sk, ktorý ho doručí do Peppol siete príjemcovi.
2. **Stav a dôkaz doručenia.** Esblu priebežne zisťuje stav u poskytovateľa
   (zaradené → odoslané → doručené / odmietnuté / zlyhalo). Ukladá aj obmedzený
   dôkaz doručenia: stav, čas, počet prenosov a hash dokumentu.
3. **Príjem e-faktúr.** Faktúry doručené firme cez Peppol si Esblu stiahne od
   poskytovateľa a uloží byte-identicky ako pôvodné XML so SHA-256. Z XML
   automaticky vytvorí **koncept** prijatej faktúry. Ak dodávateľ ešte nie je
   v evidencii, založí ho ako nového obchodného partnera. Potom poskytovateľovi
   potvrdí prevzatie (ACK). Koncept musí používateľ skontrolovať. Nič sa
   automaticky nefinalizuje ani neplatí.
4. **História a stiahnutie.** Odoslané UBL a prijaté XML si používateľ s finančným
   prístupom môže stiahnuť aj po skončení predplatného. Stráca iba možnosť nových
   odoslaní.
5. **Operátorské akcie.** Overenie stavu u poskytovateľa, nový pokus po odmietnutí,
   opätovné spracovanie, opakovanie ACK. Každá akcia sa zapíše do auditu.

**Esblu nie je zákonný dlhodobý archív** účtovných dokladov, kým to CLIA
výslovne nepotvrdí (pozri otázku Q7). Poskytovateľ uvádza 10-ročnú archiváciu
prijatých dokladov na svojej strane.

## 2. Data-flow

```
Používateľ (web / Android)  ──HTTPS──▶  Esblu API (Vercel, fra1)
        │                                   │ user JWT → RLS (Supabase eu-central-1)
        │                                   │ server-only: UBL generovanie, SHA-256
        │                                   ▼
        │                         Supabase Storage (privátny bucket einvoice-documents)
        │                         Supabase Postgres (einvoice_* tabuľky, audit udalosti)
        │                                   │
        │                     cron worker (Vercel) ──HTTPS X-API-Key──▶ eFaktura.sk Agent API
        │                                                              │
        │                                                              ▼
        │                                                 Peppol Access Point (AS4) ──▶ AP príjemcu ──▶ príjemca
        │
        ◀── webhook (HMAC) / poll ── eFaktura.sk ◀── Peppol ◀── dodávateľ (prijaté faktúry)
```

- **Esblu → eFaktura.sk:**
  - celý UBL dokument (base64) a Peppol ID príjemcu,
  - pri onboardingu firmy: názov, IČO, DIČ, IČ DPH, adresa (`POST /organizations`).
- **eFaktura.sk → Esblu:**
  - stav prenosu a obmedzený dôkaz doručenia,
  - prijaté XML,
  - webhook notifikácie (z tela sa použijú iba identifikátory: ID organizácie,
    ID dokladu, typ udalosti).
- **eFaktura.sk ↔ Peppol / FS:**
  - doručenie AS4 a SMP registrácia (`0245:DIČ`),
  - mandát firmy cez portál Finančnej správy (PDS voľba).
  - Finančná správa SR je súčasťou slovenského e-Faktúra modelu (mandát, prípadné
    reportovanie). Rozsah reportovania zo strany poskytovateľa je **otázka Q9**.

## 3. Nové kategórie údajov

| Kategória | Príklady | Kde | Dotknuté osoby |
| --- | --- | --- | --- |
| Obsah e-faktúry (UBL/XML) | Názvy, adresy, IČO / DIČ / IČ DPH, IBAN / BIC, položky, sumy. Voliteľne **kontaktná osoba, e-mail, telefón** dodávateľa / odberateľa, poznámky, prílohy embedované v XML. | Supabase Storage, eFaktura.sk, Peppol AP príjemcu | Zástupcovia, zamestnanci a SZČO odberateľov / dodávateľov |
| Peppol identifikátory | `0245:DIČ` (participant), SBDH / AS4 ID (v dôkaze iba počet transakcií) | Postgres | Firmy, SZČO (DIČ fyzickej osoby) |
| Prevádzkové / auditné údaje | Stav, časy, chybové kódy, idempotenčný kľúč, ID podania u poskytovateľa, **UUID používateľa**, ktorý odoslanie alebo akciu vyžiadal | `einvoice_outbound`, `einvoice_events`, `invoice_events` | Používatelia Esblu |
| Webhook metadáta | ID doručenia, typ udalosti, ID organizácie u poskytovateľa, SHA-256 tela (telo sa **neukladá**), stav spracovania | `einvoice_webhook_events` | (nepriamo) firmy |
| Počítadlá odmietnutých webhookov | iba agregát (dôvod, hodinový bucket, počet), bez IP a tiel | `einvoice_webhook_rejections` | — |
| Organizácia u poskytovateľa | ID organizácie, participant ID, stavy, snapshot firemných údajov poslaných pri onboardingu | `einvoice_organizations` | Firmy, prípadne SZČO |
| Automaticky založení dodávatelia | Názov, IČO, IČ DPH, adresa a elektronická adresa z prijatého XML | `business_partners` | Dodávatelia (aj SZČO) |

Esblu v module E-Faktúra **neukladá** IP adresy ani user-agent. Platformové
logy Vercelu (requesty) a Supabase spadajú pod existujúce subprocesory a ich
retenciu. AI (OpenAI) sa v toku E-Faktúry **nepoužíva**: parsovanie XML je
deterministické.

## 4. Nový poskytovateľ / subprocesor

- **eFaktura.sk** (Agent API, partner API integrátor). Právnická osoba, IČO,
  sídlo, lokalita hostingu a sub-sprostredkovatelia **nie sú v dokumentácii pre
  vývojárov uvedené** (PROVIDER QUESTION P10, P11).
- **Peppol siete a Access Pointy príjemcov / odosielateľov** sú určené
  príjemcom (jeho voľbou PDS), nie Esblu. Kvalifikáciu treba posúdiť (Q3).
- **Finančná správa SR** sa zúčastňuje na mandáte a registrácii, voči Esblu
  priamo nie (Q9).
- Existujúci subprocesori (Supabase, Vercel) spracúvajú nové kategórie v rámci
  doterajšieho účelu (hosting, DB, storage).

## 5. Retencia (technický stav)

| Údaj | Automatické mazanie v Esblu | Poznámka |
| --- | --- | --- |
| UBL / XML (storage) | **Nie** | Nemenné, viazané na faktúru. Cesty a hash sú v DB chránené proti zmene. |
| `einvoice_outbound` / `einvoice_inbound` / `einvoice_events` | **Nie** | Udalosti sú append-only (UPDATE, DELETE a TRUNCATE sú blokované). |
| `einvoice_webhook_events`, `einvoice_webhook_rejections` | Áno, po ≥ 30 dňoch (odporúčané 90), iba uzavreté záznamy | Maintenance cron (zatiaľ nenaplánovaný). |
| Vymazanie firmy | `on delete cascade` z `companies` | Zmaže DB riadky. **Objekty v storage** a údaje u poskytovateľa treba riešiť samostatne (otázky Q5, Q6). |
| Poskytovateľ | 10 rokov archív prijatých dokladov (docs) | Odoslané: P12. |

## 6. Medzinárodné prenosy

- Supabase `eu-central-1` (Frankfurt) a Vercel `fra1` (Frankfurt), ako doteraz.
- eFaktura.sk: lokalita **neznáma** (P11).
- Peppol: príjemca môže mať Access Point v ktorejkoľvek krajine siete (EÚ aj
  mimo nej). Dokument teda môže odísť mimo EHP na **pokyn odosielateľa (zákazníka
  Esblu)**, keď vyberie príjemcu (Q4).

## 7. Otázky, ktoré musí CLIA právne potvrdiť

1. **Q1 — Role:**
   - Je Esblu pri odosielaní / prijímaní e-faktúr sprostredkovateľ zákazníka
     (čl. 28), ako pri ostatných dokladoch?
   - Je eFaktura.sk ďalší sprostredkovateľ Esblu, alebo samostatný prevádzkovateľ
     či poskytovateľ služby (PDS) so zmluvným vzťahom priamo k zákazníkovi (mandát
     cez FS je udelený firmou)?
2. **Q2 — Subprocesor:** Treba eFaktura.sk zaradiť do zoznamu subprocesorov
   a do DPA čl. 7 s predchádzajúcim oznámením a lehotou na námietku pred
   aktiváciou pre existujúce firmy?
3. **Q3 — Peppol AP príjemcu:** Je správne, že Access Point príjemcu nie je
   sprostredkovateľom Esblu (prenos na pokyn zákazníka príjemcovi)?
4. **Q4 — Prenosy mimo EHP:** Postačuje informácia, že dokument smeruje
   k príjemcovi zvolenému zákazníkom, vrátane príjemcov mimo EHP?
5. **Q5 — Vymazanie vs. zákonná archivácia:**
   - Ako postupovať pri žiadosti o vymazanie firmy / účtu, keď UBL / XML sú
     daňové doklady s povinnou archiváciou (zákon o DPH, zákon o účtovníctve)?
   - Má Esblu dokumenty vrátiť (export) a potom vymazať?
   - Alebo ich držať do konca lehoty (a na akom právnom základe)?
6. **Q6 — Údaje u poskytovateľa po ukončení:** Aké zmluvné záväzky má
   eFaktura.sk po ukončení partnerstva alebo klientskej firmy (vymazanie /
   vrátenie / ďalšia archivácia)?
7. **Q7 — Esblu nie je archív:** Možno v Podmienkach výslovne uviesť, že Esblu
   nie je zákonný dlhodobý archív dokladov a že zákazník si zodpovedá za
   archiváciu (export UBL / XML)? Prípadne v akej forme?
8. **Q8 — Zrušenie predplatného:** Je prijateľné ponechať historické dokumenty
   na čítanie a stiahnutie po skončení nároku `einvoice` (bez nových odoslaní)?
   Ako dlho?
9. **Q9 — Finančná správa:** Vzniká Esblu v slovenskom e-Faktúra modeli
   (mandát PDS, prípadné reportovanie FS) nejaká povinnosť alebo rola?
   Treba o tom informovať v Privacy / Podmienkach?
10. **Q10 — Automatické zakladanie dodávateľov:** Je potrebné osobitné
    informovanie, keď z prijatej faktúry vznikne záznam obchodného partnera
    (aj SZČO)?
11. **Q11 — Dátum vyhotovenia:** Pravidlo „BT-2 = deň odoslania“ od 1. 1. 2027
    (poskytovateľ odkazuje na § 85o zákona o DPH a FAQ FS). Ide o zákonnú
    povinnosť, ktorú má Esblu v UI komunikovať ako právnu, alebo iba ako
    technické obmedzenie poskytovateľa?
12. **Q12 — Zodpovednosť za obsah:** Esblu odosiela presne to, čo používateľ
    finalizoval a potvrdil. Treba v Podmienkach upraviť zodpovednosť za
    správnosť e-faktúry a za následky odmietnutia alebo nedoručenia?
13. **Q13 — Poplatky:** Ak bude nárok `einvoice` spoplatnený (tx poplatky
    poskytovateľa), treba zmenu Podmienok / cenníka a informačnú povinnosť pred
    aktiváciou?

## 8. Dokumenty, ktoré pravdepodobne vyžadujú aktualizáciu (po stanovisku CLIA)

| Dokument | Pravdepodobná zmena |
| --- | --- |
| Zoznam subprocesorov (`/subprocessors`) | Pridať eFaktura.sk (účel, kategórie, lokalita, DPA odkaz), po odpovedi na P10 / P11. |
| DPA (1.2) | Čl. 3 (nové kategórie: obsah e-faktúr, Peppol ID). Čl. 7 (nový subprocesor). Čl. 11 (prenosy na pokyn zákazníka cez Peppol). Čl. 12 (vymazanie vs. archivácia dokladov). |
| Privacy Policy (1.3) | Sekcia B (údaje z e-faktúr). Sekcia E (eFaktura.sk, Peppol). Sekcia H (retencia dokladov, „Esblu nie je archív“). |
| Podmienky používania | Opis E-Faktúry, explicitné potvrdenie odoslania, zodpovednosť za obsah, odmietnutie / nedoručenie, nárok a predplatné, historický prístup, archivácia. |
| Interné: `docs/gdpr-data-map.md`, `docs/gdpr-processing-register.md`, `docs/gdpr-retention-policy.md`, `docs/gdpr-subprocessors.md`, DPIA posúdenie | Doplniť nové spracovanie. Nové verzie až s právnym podkladom. |

Cookies Policy sa nemení: modul nepridáva cookies.
