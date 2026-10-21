# Esblu — produktové doladenie: positioning, onboarding, „Dnes“ (2026-10-22)

Branch `preprod-release-candidate` (base `1fc2764`). Bez nových modulov, providerov, dátového modelu, trackingu,
zmien oprávnení, retencie či právnych textov. Produkcia, `main`, live eInvoice a live billing nedotknuté.

## A. Audit pred zmenou

| otázka | stav pred | prečo |
|---|---|---|
| Do 10 s je jasné, čo Esblu robí? | čiastočne | landing „Firemná evidencia a fakturácia na jednom mieste.“ — znie ako ďalšia fakturačka/evidencia |
| Komu je určené? | čiastočne | „menšie stavebné, servisné, dopravné a technické firmy“ — chýba veľkosť firmy a typická situácia |
| Prečo nie iDoklad/KROS/SuperFaktúra? | nie | nikde nezaznie, že ide o faktúry **+** majetok, sklad, dokumenty a termíny v jednom |
| Prečo nie Excel + WhatsApp? | iba v CTA pri videu | v hlavnej správe chýba |
| Čo urobiť ako prvé? | nie | po registrácii rovno valec modulov s „0 vozidiel“; žiadny checklist, prázdne stavy „Zatiaľ nie je uložené žiadne vozidlo.“ |
| Dashboard odpovedá „čo dnes riešiť“? | nie | iba STK/EK/známky vozidiel; faktúry po splatnosti, prijaté faktúry, servis strojov, sklad nikde |
| Multi-company na webe | slabé | prepínač firmy iba v Nastaveniach (na mobile v „Viac“), nie na nástenke |
| Pricing dojem | riziko | „Počet používateľov… upresníme“ pôsobí ako cena za login; „Požiadať o aktiváciu“ videli aj zamestnanci/admin |
| Navigácia | plochý zoznam 9 položiek | bez oblastí; „Prehľad“ |

## B. Čo bolo nejasné
Hlavný claim (evidencia vs. „firma pod kontrolou“), cieľová persona, rozdiel oproti fakturačkám a Excelu, prvý krok
po registrácii, dashboard bez finančných a skladových upozornení, kto platí (firma vs. login, vlastník vs. admin).

## C. Čo bolo zbytočné
- `app/components/sidebar.tsx` — mŕtvy komponent (nikde importovaný, emoji, „Servisy/STK“ placeholdery) → **odstránený**.
- Dva duplicitné bloky STK/EK alertov v `Dashboard.tsx` (mobil + desktop) → nahradené jedným „Dnes“ panelom.
- Výzva „Požiadať o aktiváciu“ pre roly, ktoré nemôžu platiť → nahradená vysvetlením.

## D. Persona prvého zákazníka
Slovenská firma 2–15 ľudí (stavebná, elektro, montážna, servisná, údržba, záhradnícka, remeselná) s niekoľkými
autami, strojmi/náradím, menším skladom, externým účtovníkom; dnes Excel + WhatsApp + e-mail + kalendár + priečinky +
jednoduchá fakturačka. Nie freelancer-only, nie enterprise ERP.

## E. Positioning (finálny text)
- **Hlavný:** „Firma pod kontrolou.“
- **Podnadpis:** „Faktúry, autá, stroje, sklad, dokumenty a termíny na jednom mieste. Esblu vám ukáže, čo vo firme
  potrebuje pozornosť — a pomôže to rovno vybaviť.“
- **Diferenciácia:** „Jeden systém namiesto Excelu, WhatsAppu a fakturačky. Nie ďalšia fakturačka ani veľké ERP.“
- **Bez sľubov:** žiadny zákonný archív, automatické účtovníctvo, bankové párovanie; eFaktúra ostáva „pripravujeme“;
  AI iba existujúce schopnosti.

## F. Návrh „Dnes“
Jedna otázka: *Čo dnes musím riešiť?* Agregácia existujúcich dát aktívnej firmy, štyri úrovne:

| úroveň | čo |
|---|---|
| Urgentné | faktúra (vydaná/prijatá) po splatnosti; STK/EK/známka/servis po termíne |
| Dnes | splatnosť dnes; prijatá faktúra / eFaktúra (koncept) na kontrolu; prijatá oprava/záloha v review; vypredaná položka; termín dnes; koniec trialu ≤ 1 d (vlastník) |
| Čoskoro | splatnosť do 7 d; termíny do 14 d; nízky stav skladu; koniec trialu ≤ 5 d (vlastník) |
| Info | termíny 15–30 d; rozpracované faktúry; doklady v Inboxe; neprečítaný chat |

Každá položka: čo + prečo (text), ktorá firma (hlavička panelu „Firma · rola“), akcia (Otvoriť faktúru /
Skontrolovať úhradu / Označiť úhradu / Skontrolovať / Otvoriť vozidlo / Otvoriť stroj / Doplniť sklad / Otvoriť
Inbox / Otvoriť chat / Predplatné).

Nezaradené zámerne (vyžadovali by nový model alebo nové volanie): „pripraviť podklady pre účtovníka“ ako úloha,
čakajúce AI potvrdenia (krátkodobé, server-side), eInvoice inbound `needs_review` bez vzniknutej faktúry (iba cez
eInvoice API) — ostávajú na existujúcich obrazovkách.

## G. Implementované zmeny dashboardu
- `lib/dashboard/today.ts` — čistá agregácia + závažnosti + poradie + prvé kroky.
- `app/components/dashboard/TodayPanel.tsx` — mobil kompaktne (2 položky, celé riadky ťukacie, „Zobraziť všetko“),
  desktop bočný panel (súhrn podľa úrovní, akcia pri každej položke, overené otázky asistenta).
- `Dashboard.tsx` — `loadToday()` (faktúry iba s finance view, servisy iba prevádzka, Inbox, unread chat, profil
  a tím iba vlastník/správca; všetko `.eq("company_id", aktívna)` + RLS; zlyhanie zdroja nezhodí panel).
- `/faktury?section=…` — odkaz z „Dnes“ otvorí sekciu (voľba používateľa má prednosť).

## H. Onboarding
Bez wizardu. „Prvé kroky“ v paneli „Dnes“ pre vlastníka/správcu, kým nie sú hotové povinné kroky:
firma ✓ → firemné údaje (iba kto ich vidí) → prvý záznam (vozidlo/stroj/faktúra/partner podľa roly) → pozvať
kolegu/účtovníka (voliteľné) → „Dnes“. Stav sa odvodzuje z dát; „Skryť“ si pamätá iba zariadenie (localStorage,
kľúč podľa firmy). Žiadne falošné dáta.

## I. Empty states
Vozidlá, stroje, sklad, faktúry, partneri, priečinky: titulok = prvý krok, popis = čo modul robí a prečo; pri
roli bez zápisu „Záznamy pridáva vlastník alebo správca firmy.“; prázdny filter má vlastný text.

## J. Navigácia
Bez redesignu: „Prehľad“ → **„Dnes“** (web aj mobilná lišta); desktop sidebar a mobilné webové menu zoskupené do
**Dokumenty · Financie · Prevádzka · Nastavenia**; viditeľnosť modulov nezmenená (rovnaké `isModuleVisible`).

## K. Role
Owner: všetko + koniec trialu + aktivácia. Admin: prevádzka (+ financie iba s finance oprávnením), bez billing
výziev. Účtovník: faktúry/doklady, bez flotily/skladu. Zamestnanec: termíny a sklad, žiadne financie, žiadne tipy
asistenta (asistent iba v Inboxe). Permission model nezmenený.

## L. Multi-company
Prepínač (firma + rola + „Pridať vlastnú firmu“) v desktop sidebari aj mobilnom webovom menu; natívna appka ho má v
„Viac“. „Dnes“ = výhradne aktívna firma; prepnutie robí hard reload (existujúce správanie).

## M. Web / mobil
Rovnaký produkt, rovnaký obsah „Dnes“. Mobil: Dnes + rýchle akcie + hlas nad valcom modulov. Web: širší panel,
financie, dokumenty, nastavenia.

## AI a hlas
Tipy v paneli iba pre vety, ktoré deterministický parser rozpozná a rola smie vykonať (test pre sk/en/de):
„Ktoré faktúry sú po splatnosti?“, „Aké termíny sa blížia?“, „Čo dochádza na sklade?“, „Ukáž nepriradené doklady“.
„Čo dnes musím riešiť?“ a „Priprav podklady pre účtovníka“ parser nerozpozná → **neprezentované**; na prvú
odpovedá samotný panel. Hlas: bez zmeny UX; mikrofón ostáva v poli „Hľadajte alebo sa opýtajte“, placeholder
naznačuje, že pole je aj asistent; zamknutý hlas ponúka aktiváciu iba vlastníkovi.

## N. GDPR impact
| zmena | GDPR IMPACT |
|---|---|
| landing / cenník texty | NONE |
| „Dnes“ agregácia (existujúce dáta, existujúce RLS, rovnaký používateľ) | NONE |
| Prvé kroky (odvodené; lokálny UI flag bez osobných údajov) | NONE |
| empty states, navigácia, prepínač firmy, role-aware výzvy | NONE |
| odstránenie mŕtveho `sidebar.tsx` | NONE |
Žiadny nový tracking/analytics, provider, typ údajov, účel, retencia ani prístup → CLIA review nie je potrebné.
