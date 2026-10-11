# Esblu — Dashboard v3: nekonečný valec modulov (2026-10-11)

Branch: `mobile-platform`. Bez production deployu, bez merge do `main`, bez zmien v DB, billingu a eInvoice.

## 1. Návrh (UX + technika)

**Problém starej nástenky:** mriežka 2×3 malých dlaždíc, pod ňou prázdny spodok obrazovky, line ikonky ako hlavný vizuál a žiadny náznak, že moduly pokračujú.

**Koncept:** obrazovka bez scrollu.
- Hore je kompaktná hlavička (firma, pozdrav) a hľadanie.
- Zvyšnú výšku medzi hľadaním a spodnou lištou vyplní **valec modulov**.
- Moduly ležia na plášti neviditeľného valca s vodorovnou osou.
- Vpredu je jeden fokusovaný modul, nad a pod ním čiastočne susedia a ďalšie moduly ubiehajú dozadu.
- Valec sa točí dookola bez začiatku a konca.

### Architektúra

| Vrstva | Súbor | Úloha |
|---|---|---|
| Matematika valca (čistá) | `lib/dashboard/cylinder.ts` | kruhové posuny, 3D transformácia karty, snap, pružina, koliesko, klávesnica, varianty A/B, geometria FAB/fokus |
| Model modulov (čistý) | `lib/dashboard/modules.ts` | moduly z existujúcich rout + viditeľnosti + nárokov, poradie aktívne → zamknuté, akcia ťuknutia |
| Komponent | `app/components/dashboard/ModuleCylinder.tsx` | gestá, rAF animácia, prístupnosť, reduced motion, karta modulu |
| Integrácia | `app/components/Dashboard.tsx` | hlavička, hľadanie (výsledky nahradia valec), termíny STK/EK, dáta a navigácia |
| Ilustrácie | `scripts/generate-module-illustrations.py` → `public/images/modules/*.svg` | jedna vizuálna rodina modulov |
| Hooky | `hooks/use-media-query.ts` | media query / URL parameter cez `useSyncExternalStore` |

Biznis logika nástenky ostala bez zmeny:
- hľadanie a asistent (intent, voice);
- potvrdzovanie akcií;
- upozornenia STK/EK;
- bočné menu na desktope;
- viditeľnosť modulov podľa roly (`isModuleVisible`).

## 2. Nekonečný valec

- `position` je spojité, neohraničené číslo. Modul `i` má kruhový posun `offset = circularOffset(i − position, n) ∈ (−n/2, n/2]`.
- Uhol na valci je `θ = offset · angleStep`. Transformácia karty:
  - `y = R·sin θ`
  - `z = R·(cos θ − 1)`
  - `rotateX(−θ)`
  - mierka, priehľadnosť a stmavnutie podľa vzdialenosti od fokusu.
- **Bez skoku pri slučke:**
  - moduly sa neklonujú a pozícia sa nikdy neresetuje;
  - karta, ktorá prechádza zadnou stranou valca (`|offset| ≈ n/2`), je neviditeľná, lebo viditeľný rozsah je `< n/2 − 0.5`;
  - pri 6 moduloch je vidno fokus, 2 karty nad ním, 2 pod ním a jemne vyblednuté okraje.
- **Gestá:**
  - ťah prstom alebo myšou posúva valec 1:1 (ťah nahor = ďalší modul);
  - po pustení sa vypočíta snap na celú kartu podľa rýchlosti, max. 3 karty na jeden švih;
  - kriticky tlmená pružina dotiahne pozíciu bez cartoon bounce.
- **Koliesko a trackpad:** posun max. o 1 krok na udalosť, s krátkou pauzou medzi krokmi, aby trackpad nepreletel celý valec.
- **Klávesnica:** ↑/↓, PageUp/PageDown, Home. Enter/medzerník otvorí modul cez tlačidlo karty.
- **Ťuknutie:**
  - na susednú kartu ju natočí do fokusu kratšou cestou, aj „cez koniec";
  - na fokusovanú kartu otvorí modul;
  - na fokusovanú zamknutú kartu ukáže cestu k aktivácii.
- **Tlačidlá ▲/▼** nad valcom slúžia na ovládanie bez swipe.

## 3. Fokus, lift a hĺbka

- **Fokus:**
  - mierka `focusScale` (A: 1.0, B: 1.03), plná priehľadnosť, bez stmavnutia, `z = 0`;
  - brand rám a modrý „lift" tieň (`.cyl-card-focused`);
  - na karte je šípka (otvoriť) a CTA pri zamknutom module.
- **Mimo fokusu:**
  - každý krok zmenší kartu a zníži jej priehľadnosť;
  - pribudne tmavý overlay (lacný `opacity` na jednom divu, žiadny CSS filter);
  - karta je hlbšie v `z` a natočená po plášti.
- Horná a dolná hrana valca jemne vyblednú statickým gradientom (bez blur).

## 4. Variant A vs. B

| | A — `subtle` (predvolený, **odporúčaný**) | B — `spatial` (`?cylinder=spatial`) |
|---|---|---|
| Uhol medzi kartami | 21° | 30° |
| Perspektíva | 1400 px | 900 px |
| Lift fokusu | 1.00 | 1.03 |
| Susedia | čitateľní (opacity 0.76) | výraznejšie vyblednutí (0.68) |
| Pocit | business / SaaS, rýchle skenovanie | prémiový „wow" |

**Odporúčanie: A.** Esblu je pracovný nástroj. Moduly mimo fokusu musia ostať čitateľné (počty, upozornenia) a menšia perspektíva zachová ostré texty aj na lacnejších Android telefónoch. B je len token (`CYLINDER_VARIANTS`), nie druhá aplikácia.

## 5. Ilustrácie modulov

- Jedna rodina v izometrickom „soft 3D" štýle, generovaná skriptom (`scripts/generate-module-illustrations.py`):
  - spoločná tmavá podstava s brand hranou, kruhová brand žiara a tieň;
  - objekt z brand gradientov (vrch svetlý, steny stredná/tmavá modrá), papier `#EAF4FF`, akcent `#38BDF8`.
- Iba Esblu farby, žiadne cudzie, stiahnuté ani rastrové assety.
- Vektor 5–9 kB na modul, ostrý na každom DPI.

| Modul | Motív |
|---|---|
| Inbox | podnos so stohom dokladov + AI iskra |
| Faktúry | doklad s hlavičkou, riadkami a súčtom + stĺpec mincí |
| Vozidlá | dodávka s presklenou kabínou a brand pásom |
| Stroje | pásový bager s ramenom a lyžicou |
| Sklad | paleta s krabicami a páskou |
| Obchodní partneri | dve firemné budovy prepojené vzťahom |

## 6. Aktívne a zamknuté moduly

- **Poradie:** najprv dostupné moduly, potom zamknuté. V rámci skupiny pevné poradie: Inbox, Faktúry, Vozidlá, Stroje, Sklad, Partneri.
- **Zamknutý modul:**
  - ostáva viditeľný: zámok, prerušovaný rám, tlmená ilustrácia a štítok „Nie je súčasťou vášho balíka" (pri `TRIAL_EXPIRED` „Skúšobné obdobie skončilo");
  - **neotvorí sa ako aktívny modul.** Fokusovaná karta ponúkne „Požiadať o aktiváciu", čo vedie na `/kontakt`;
  - zámerne nie je pridaný nákupný tok, lebo billing nie je live a moduly sa dnes aktivujú ručne. Text to hovorí pravdivo.

## 7. Nároky — čo reálne existuje a čo čaká na predplatné

**Existuje:** `esblu_get_my_company_entitlements()` → `lib/entitlements.ts`.
- Kľúče: `invoicing`, `ai_documents`, `vehicles`, `machines`, `inventory`, `voice`, `team_members`.
- Zdroj nároku: trial, ručný grant, beta kompatibilita alebo (budúce) `subscription`.
- Nástenka ho iba číta.

**Mapovanie modul → nárok:**

| Modul | Nárok |
|---|---|
| Inbox | `ai_documents` |
| Faktúry | `invoicing` |
| Obchodní partneri | `invoicing` |
| Vozidlá | `vehicles` |
| Stroje | `machines` |
| Sklad | `inventory` |

**Fallback:** keď sa nároky načítavajú alebo RPC zlyhá, stav je `unknown` → **bez zámku**.
- Falošné „nie je v balíku" pri výpadku siete by klamalo.
- Platené akcie aj tak vynúti server (RLS, DB triggery, route guardy).

**Čaká na subscriptions (mimo tejto úlohy):**
- reálny nákup alebo aktivácia (Stripe / Apple / Google);
- cenník s „Odomknúť" v appke;
- `subscription` zdroj nárokov v produkcii.

Kontrakt pre UI je pripravený: `DashboardModule.access` je `active` / `unknown` / `locked` (+`reason`) a CTA je jedno miesto (`onLockedAction`).

## 8. Mobil

**Rozloženie:** hlavička → hľadanie → (pruh termínov, ak niečo hrozí) → riadok „n / N ▲▼" → valec.
- Výška sekcie je `100dvh − spodná lišta`, takže stránka sa nescrolluje a valec vyplní zvyšok.
- Karta má výšku `stage/4.6` (96–140 px). Ilustrácia je vľavo (≈ 86 % výšky karty); vpravo názov 17 px, popis 12.5 px a štítky (počet, upozornenia, zámok).

**Hľadanie:** text v poli nahradí valec výsledkami (scroll v tej istej ploche).

**Chat FAB a spodná lišta:**
- Chat FAB ostáva ťahateľný, s badge a iba na nástenke. V predvolenej polohe vpravo dole sa neprekrýva s fokusovanou kartou ani s ovládaním (overené pre 360–430 px).
- Spodná lišta je funkčne rovnaká (56 px, brand pilulka aktívnej položky, safe area).

## 9. Web

- **Desktop:** bočné menu ostáva. Vpravo je hlavička a hľadanie (max. 672 px), pod nimi väčší valec (karta do 176 px, väčšia ilustrácia a typografia) a bočný panel „Termíny".
- **Ovládanie:** koliesko myši / trackpad, šípky, ▲/▼.
- **Úzky web (telefón v prehliadači):** rovnaký valec ako v appke, bez spodnej lišty.

## 10. Prístupnosť a reduced motion

- **ARIA:**
  - `section aria-roledescription="carousel"`, karty `role="group" aria-roledescription="slide"` s názvom „Vozidlá — 3 z 6";
  - aktívna karta má `aria-current`, ostatné sú `aria-hidden` a mimo tab poradia;
  - živé oznámenie aktuálneho modulu (`aria-live="polite"`) vrátane zamknutého stavu;
  - tlačidlá ▲/▼ s popisom.
- **Fokus:** po zmene klávesnicou sa fokus presunie na novú aktívnu kartu.
- **Ovládanie:** karta je skutočné `<button>` a dotyková plocha je celá karta.
- **Reduced motion:** `prefers-reduced-motion: reduce` → statický zoznam kariet bez 3D, kolieska, ťahu a animácie (`data-cylinder="reduced"`).

## 11. Výkon

- Počas ťahu a animácie React nerenderuje. rAF zapisuje iba `transform` + `opacity` do DOM kariet (GPU kompozícia).
- React stav sa mení len pri zmene fokusu.
- rAF slučka beží iba počas pohybu a po usadení pružiny sa zastaví.
- Pružina má obmedzený `dt` (stabilita pri trhanom frame).
- Žiadny blur ani filter na animovaných prvkoch. Prechody tieňov sú iba na fokus kartu (CSS transition, nie per-frame).
- Ilustrácie sú malé vektory, bez veľkých obrázkov.
- `will-change: transform`, `backface-visibility: hidden`, `touch-action: none` iba na ploche valca.

## 12. Testy

`npm run test:dashboard-cylinder` (25 testov):
- kruhové poradie, slučka bez straty modulu a bez skoku;
- fokus, lift a hĺbka; varianty A/B;
- swipe a pružina, rýchly swipe, koliesko, klávesnica;
- ťuknutie otvorí správnu routu; zamknutý modul sa neotvorí;
- aktívne pred zamknutými; fallback nárokov; dedenie nároku partnerov;
- zachovaná viditeľnosť podľa roly; počty bez nového dopytu;
- reduced motion, ARIA kontrakty, výkonové pravidlá;
- rodina ilustrácií; FAB vs. fokus a ovládanie; žiadne horizontálne pretečenie; výška bez prázdneho spodku.

Upravený test: `mobile-m1` (routy modulov sú v `MODULE_ROUTES`).

## 13. Manuálne overenie na telefóne

1. Valec vyplní plochu medzi hľadaním a spodnou lištou a na spodku nie je prázdne miesto.
2. Ťah hore a dole je plynulý a snap prirodzený. Rýchly švih posunie max. o 3 moduly.
3. Po poslednom module plynule nasleduje prvý, bez skoku.
4. Ťuknutie na suseda ho natočí, ťuknutie na fokus otvorí modul. Tlačidlá ▲/▼ fungujú.
5. Zamknutý modul (ak ho firma nemá) je na konci, má zámok a CTA vedie na kontakt.
6. Chat FAB neprekrýva fokus a dá sa ťahať. Upozornenia STK/EK sa rozbalia z pruhu.
7. Android „Odstrániť animácie" (reduced motion) → statický zoznam.
8. Web: koliesko a trackpad, šípky, bočný panel termínov.

## 14. Regresia na Androide: neviditeľné karty (build 745c833) — root cause a oprava

**Symptóm:** hlavička, hľadanie, počítadlo „1 / 6", tlačidlá ▲/▼, FAB aj spodná lišta sa zobrazili, ale všetkých 6 kariet bolo neviditeľných.

**Root cause (deterministická, overená meraním v Chromiu pri šírke 390 px):**
1. Sekcia nástenky mala `flex-1` a výšku cez `h-[calc(100dvh-…)]`.
2. Jej rodič je na mobile **stĺpcový** flex kontajner (`flex-col`) s neurčitou výškou.
3. `flex-1` = `flex: 1 1 0%`. V stĺpci flex-basis prebije `height` a percentuálny basis pri neurčitej výške rodiča znamená „content". Sekcia sa preto zmrštila na výšku obsahu (zmerané **136 px**).
4. Plocha valca (`flex-1 min-h-0`) obsahuje iba absolútne pozicované karty, takže dostala **0 px**. Na ploche je `overflow: hidden`, ktorý orezal všetky karty.

Počítadlo a tlačidlá sú v normálnom toku, preto boli vidieť. Dáta a nároky boli v poriadku.

**Prečo to „fungovalo" pri overovaní:**
- Na desktope (≥ 1024 px) je rodič `lg:flex-row`, takže `height` platí a sekcia mala plnú výšku.
- Moja kontrola na 375 px bola replika s vlastnou sekciou s inline výškou, bez skutočného flex rodiča, a chybu preto nezachytila.
- Chyba sa týkala **každého** prehliadača pod 1024 px, nielen Android WebView.

**Oprava:**
- **Sekcia:** `flex-none` na mobile (`lg:flex-1` iba pre desktopový riadok). Výška je v CSS triede `.dash-screen`:
  - `calc(100vh − lišta)` ako fallback pre WebView bez jednotky `dvh`;
  - `@supports (height: 100dvh)` → `100dvh`;
  - desktop `100vh`.
- **Plocha valca:** `min-h-[180px]` (nikdy 0 px).
- **Android-safe vykresľovanie:** valec je teraz 2D projekcia (`translate3d(0,y,0) scale(sx, sy)` s `sy` podľa cos θ). Bez `perspective`, `preserve-3d`, `translateZ`, `rotateX` a `backface-visibility` — žiadne riziko „flatteningu" ani zmiznutých 3D vrstiev na GPU telefónov. Vizuálny dojem valca ostáva.

**Obrana: nikdy prázdna nástenka.** Valec prejde na bezpečný zvislý zoznam kariet (`data-cylinder="fallback"`, `data-fallback-reason`, vlastné `min-h-[240px]`) pri:
- výške plochy < 180 px alebo neplatnej (NaN);
- neplatnej výške karty;
- nekonečnej transformácii;
- kontrole nad skutočným DOM po vykreslení: fokusovaná karta je vo vnútri plochy na < 60 % alebo má opacity ≤ 0.5.

Keď sa výška neskôr opraví (rotácia, klávesnica), valec sa sám vráti.

**Testy (+5, spolu 31):**
- root-cause guard: sekcia bez `flex-1` na mobile, `.dash-screen` s fallbackom 100vh;
- 2D projekcia bez 3D CSS a s konečnými hodnotami;
- fokusovaná karta je vždy viditeľná (opacity 1, y = 0) pre n = 1–7, výšky 96–176 a oba varianty;
- Android viewporty 360–430 px: platná geometria, fokus celý v ploche, susedia viditeľní;
- fallback pri 0 px, NaN, nízkej ploche a príliš vysokej karte.
