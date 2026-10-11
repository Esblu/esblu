# 02 — Play Store grafika a screenshoty (aktualizované 2026-10-11)

Všetko je odvodené zo **schválenej** master ikony `mobile/icon-source/esblu-master-icon.png`: modrá dlaždica, biely symbol, „Esblu". Žiadny nový brand smer.

## 1. Kontrola assetov

| Asset | Požiadavka Play | Súbor | Kontrola 2026-10-11 |
|---|---|---|---|
| App icon | 512×512, 32-bit PNG s alfou, ≤ 1 MB | `release/play-assets/play-icon-512.png` (RGBA, 264 KB) | **OK** — rozmer, formát, veľkosť. Rohy sú biele nepriehľadné (z mastra); Play aplikuje masku, tenký svetlý okraj môže byť v rohoch viditeľný. Vlastník schváli alebo dodá master bez okraja |
| Feature graphic SK (svetlý) | 1024×500, 24-bit PNG / JPG bez alfy | `feature-graphic-1024x500-sk.png` (RGB) | OK technicky; **vizuálne nesedí s appkou** (biele pozadie, appka je tmavá navy) |
| Feature graphic EN (svetlý) | dtto | `feature-graphic-1024x500-en.png` | dtto |
| **Feature graphic SK (tmavý, NOVÝ draft)** | dtto | `feature-graphic-1024x500-sk-dark.png` (RGB) | **odporúčaný** — rovnaká kompozícia a text, plochy z tokenov appky (`page-bg #05080f`, `surface-1 #0b1220`, žiara `brand-500 #0181fd`), Geist SemiBold, text `#eef3fa` |
| **Feature graphic EN (tmavý, NOVÝ draft)** | dtto | `feature-graphic-1024x500-en-dark.png` | dtto |
| Phone screenshots | min. 2, odporúčané 4–8; 24-bit PNG/JPG; 9:16 alebo 9:20; strana 320–3840 px | `release/play-assets/screenshots/phone/{sk,en}/` | **chýbajú** — iba z reálnej appky (plán nižšie) |

**Texty listingu (SK/EN)** v `01-store-listing.md` zodpovedajú aktuálnemu rozsahu appky:
- moduly Inbox, Vozidlá, Stroje, Sklad, Partneri, Faktúry, Chat;
- AI vždy iba navrhuje;
- bez platieb.

Doplniť netreba. Hlas je v aplikácii **platená** schopnosť (nárok `voice`), preto ho listing nesľubuje ako súčasť každého účtu.

**Rozhodnutie vlastníka:** svetlý alebo tmavý feature graphic. Odporúčanie: **tmavý** (zhoda s tým, čo používateľ uvidí po otvorení appky a so screenshotmi).

## 2. Screenshot plán (8 kusov, reálna appka, demo účet)

**Spoločné pravidlá:**
- **Zdroj:**
  - Play-nainštalovaná appka (Internal testing) na reálnom telefóne;
  - účet `play-review@esblu.com`;
  - firma „Esblu Demo s.r.o." s dátami z `03-app-access-reviewer.md` §4.
  - **Žiadny mockup, žiadne úpravy obsahu.** Povolené je iba orezanie stavového riadku, ak by v ňom bolo niečo osobné.
- **Zariadenie:** 1080×2400 (alebo 1080×1920), jazyk SK. EN sada rovnako po prepnutí jazyka (Nastavenia → Jazyk).
- **Stavový riadok:**
  - čas 9:41, plná batéria, žiadne notifikácie, režim Nerušiť;
  - Android demo mód: `adb shell settings put global sysui_demo_allowed 1` + `am broadcast -a com.android.systemui.demo -e command enter`.
- **Capture:** `adb exec-out screencap -p > NN-nazov.png`, potom kontrola: 24-bit PNG bez alfy.
- **Nikdy viditeľné:**
  - reálne mená, e-maily, IČO, IBAN, EČV ani adresy;
  - push notifikácie, Build ID, debug/staging označenia;
  - systémové dialógy, klávesnica (okrem #7), „Viac" panel.

| # | Súbor (`…/phone/sk/`) | Obrazovka | Čo má byť na obrazovke | Demo dáta | Nesmie byť viditeľné |
|---|---|---|---|---|---|
| 1 | `01-prehlad-valec.png` | Prehľad — valec modulov | fokus na **Faktúry** (alebo Vozidlá), susedia čitateľní, počty modulov, hľadanie, chat FAB | všetky moduly aktívne (granty), počty ≥ 1 | zamknuté moduly, skeleton, chybové pruhy |
| 2 | `02-faktury.png` | Faktúry — zoznam alebo detail finalizovanej | 3 faktúry so stavmi (koncept / neuhradená / uhradená), sumy | §4.3 | reálny IBAN (iba ilustračný vzor), čísla reálnych firiem |
| 3 | `03-partneri.png` | Obchodní partneri | 3 fiktívni partneri s IČO a mestom | §4.2 | výsledky lookupu reálnej firmy |
| 4 | `04-vozidla.png` | Vozidlá — detail Octavie | termíny STK/EK/PZP, upozornenie na blížiacu sa STK, servis | §4.4 | reálna EČV, fotka s EČV |
| 5 | `05-stroje.png` | Stroje — zoznam alebo detail Kubota | 2 stroje, servisný záznam | §4.4 | |
| 6 | `06-sklad.png` | Sklad | 4 položky, Geotextília označená pod minimom | §4.4 | |
| 7 | `07-chat.png` | Firemný chat | 4 správy zo §4.6, mená „Owner"/„Zamestnanec" (alebo fiktívne krstné mená) | §4.6 | reálne mená/e-maily, klávesnica |
| 8 | `08-hlas.png` | Hlasový asistent | po príkaze „Vytvor faktúru pre Lesy Horehronie, položka kopanie, 300 eur, 23 percent": **súhrn návrhu** s tlačidlami Áno/Nie (pred potvrdením) | nárok `voice` + funkčný prepis | potvrdený/vytvorený doklad zo screenshot sessionu (po zachytení dať „Nie") |

**Náhrada:** ak hlas pre demo firmu nebude zapnutý, ako #8 použiť `08-nastavenia.png` (Nastavenia: Notifikácie a Ochrana údajov, bez osobného e-mailu v hlavičke; e-mail reviewer účtu je v poriadku).

**Poradie v Play Console:** 1 → 8. Prvé tri sú v náhľade vyhľadávania najviditeľnejšie.
