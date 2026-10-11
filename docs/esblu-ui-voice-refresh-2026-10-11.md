# Esblu — UI/UX refresh + voice hardening (2026-10-11)

Branch: `mobile-platform` (lokálny commit, nepushnuté). Žiadny production deploy, žiadny merge do `main`, žiadna zmena DB, billing, eInvoice ani secrets.

## 1. Čo bolo zle (audit)

**Vizuál a hustota**
- Nastavenia: každá sekcia bola samostatná karta `rounded-3xl p-5 sm:p-8 shadow-lg` s nadpisom `text-xl sm:text-2xl font-bold`.
  - Inputy `p-3`, tlačidlá `px-6 py-3`, náhľad loga `min-h-40`.
  - Právne odkazy boli šesť veľkých tlačidiel, ikona stránky mala 80 px.
  - Na telefón sa zmestili zhruba dve sekcie.
- Feedback sa riešil cez `window.alert()`, ktorý blokuje WebView a pôsobí ako chyba appky.
- Farby nesúviseli s ikonou.
  - Primárny akcent bol cyan `#22d3ee` s tmavým textom a cyan→blue gradientom s veľkým glow tieňom.
  - Ikona je elektrická modrá `#0181FD`.
  - Na niektorých miestach ostal `bg-blue-600`, inde `text-[#051221]` na cyane — appka pôsobila ako mix dvoch dizajnov.
- Dashboard:
  - pozdrav `text-3xl font-black` (desktop 44 px);
  - module cards s ikonou 80 px a číslom `text-4xl font-black`;
  - medzery `mt-9`/`mt-12`.
- Formuláre, prihlásenie, pozvánka a onboarding mali karty `p-8`, `rounded-2xl` a `shadow-xl`.
- Zdieľané tlačidlá mali `min-h-11` (44 px) aj na desktope.
- Mobilná verzia mala texty 16 px aj tam, kde to nebolo nutné (mimo inputov).
- Chýbali tokeny pre spacing a výšky ovládacích prvkov. Radiusy boli 24/28 px.

**Voice**
- Ani jeden fetch (transcribe, intent, execute) nemal časový limit. OpenAI klient bežal s defaultom SDK (10 min, 2 opakovania), takže relácia mohla visieť v „Spracúvam…".
- Každá chyba `getUserMedia` sa hlásila ako „Mikrofón nie je povolený" — aj obsadený mikrofón počas hovoru alebo chýbajúce zariadenie.
  - Pri trvalom zablokovaní chýbala cesta do nastavení.
  - Kľúč `search.voice.session.unsupported` neexistoval, takže sa zobrazoval surový kľúč.
- Potvrdenie akcie vo `VoiceLauncher` nekontrolovalo `response.ok`. Pri 400/403/500 (aj pri mazaní) zaznelo „Hotovo".
- Hlasový dialóg faktúry vytvoril draft hneď po poslednom údaji, bez otázky „áno/nie" — tichý zápis z hlasu.
- Mazanie (stroj, vozidlo, položka, priečinok) stačilo potvrdiť jedným hlasovým „áno".
- Nástenka pri 403 povedala „nerozumel som". 5xx sa v launcheri a na nástenke správali rôzne.
- Voice neodpočúval Capacitor `appStateChange`, iba `visibilitychange`, ktoré vo WebView nie je spoľahlivé.
- Bez haptiky a bez ochrany proti dvojitému ťuknutiu a dvojitému potvrdeniu (okrem `disabled` na tlačidle).
- Opakované zlyhanie siete viedlo do nekonečnej slučky „Spojenie zlyhalo… počúvam…".

## 2. Nový vizuálny smer

Tmavé „business" UI odvodené z master ikony (`mobile/icon-source/esblu-master-icon.png`). Kompaktná hustota ako v bežných produktových appkách (Linear, Stripe, systémové Nastavenia). Farba sa používa iba na akciu, stav a aktívnu navigáciu, nie na dekoráciu.

### Brand tokeny (`app/globals.css`, `:root`)

| Token | Hodnota | Použitie |
|---|---|---|
| `--color-brand-500` | `#0181FD` | farba ikony: akcent, aktívne ikony, focus |
| `--color-brand-600` | `#0A6BE0` | primárne tlačidlo (biely text 5.0:1, AA) |
| `--color-brand-700` | `#0B5ED0` | hover / pressed |
| `--color-brand-300` | `#66AEFF` | odkazy a akcenty na tmavom pozadí (8:1) |
| `--color-brand-deep` | `#1236C8` | sekundárna brand farba (spodok ikony) |
| `--color-brand-sky` | `#38BDF8` | highlight / info (vrch ikony) |
| `--color-page-bg` → `surface-1` → `surface-2` → `surface-hover` | `#05080F` → `#0B1220` → `#111A2B` → `#172338` | rovnomerné kroky jasu s nádychom brand modrej |
| text primary / secondary / muted | `#EEF3FA` / `#A3B3CB` / `#7A8CA8` | kontrast na `surface-1`: 16 / 8.8 / 5.5 :1 |
| success / warning / danger / info | `#22C55E` / `#F59E0B` / `#F87171` / `brand-sky` | stavy |

Staré názvy sú namapované na brand, takže desiatky existujúcich tried fungujú bez prepisovania:
- `accent-cyan` → sky;
- `accent-blue` → brand-500;
- `accent-esblu` → brand-600 a `on-accent` je biely;
- `focus-ring` → brand-400;
- v Tailwind palete `blue-600` → brand-600 a `blue-700`/`blue-800` → svetlé brand odtiene pre odkazy.

### Typografia

| Rola | Veľkosť | Trieda |
|---|---|---|
| page title | 20 px (sm 22), 650 | `.ui-page-title` |
| section / card title | 15 px, 600 | `.ui-section-title`, `text-[15px]` |
| body / list row | 14 px | `.ui-row-title`, `text-sm` |
| sekundárny text | 13 px | `text-[13px]` |
| label / helper | 12 px | `.ui-label`, `.ui-help` |
| eyebrow / group label | 11 px uppercase | `.ui-eyebrow`, `.ui-group-label` |

Zmeny oproti predchádzajúcemu stavu:
- žiadne `font-black`;
- `text-2xl+` iba pri nadpisoch na marketingovom webe;
- inputy na mobile ostávajú 16 px (iOS zoom), čo vynucuje existujúce globálne pravidlo.

### Spacing, výšky, radius

- 4 px grid, tokeny `--space-1` až `--space-6`.
- Karta 12–16 px, medzera medzi skupinami 20 px.
- `--control-h`: 36 px desktop / 40 px dotyk. `--control-h-sm`: 32 / 36 px. `--row-min-h`: 44 / 48 px.
  - Dotykové minimum zabezpečuje `@media (pointer: coarse)`, nie plošné zväčšenie.
- Radius: karta 14 px, doc 12 px, ovládací prvok 8–10 px (predtým 24/28 px).
- Tiene ostali iba na overlayoch (modal, plávajúci panel).
- `prefers-reduced-motion` vypne animácie.

## 3. Komponenty

Nová vrstva `@layer components` v `app/globals.css`, zdieľaná webom aj mobilom:

- **Rozloženie stránky:** `.ui-page`, `.ui-page-title`.
- **Zoznamy a skupiny:** `.ui-group(-label)`, `.ui-row(-title/-sub/-value)`, `.ui-group-body`, `.ui-divided`.
- **Formuláre:** `.ui-label`, `.ui-input` (stavy disabled/readonly/invalid), `.ui-help`, `.ui-error-text`.
- **Tlačidlá:** `.ui-btn` + `-primary` / `-secondary` / `-ghost` / `-danger` / `-sm` / `-icon`.
- **Ostatné:** `.ui-segmented`, `.ui-switch`, `.ui-badge(-brand)`, `.ui-notice[data-tone]`, `.ui-card`.

React primitíva `app/components/ui/SettingsList.tsx`:
- `SettingsSection`, `SettingsRow`, `SettingsLinkRow`;
- `SettingsDisclosure` (natívny `<details>`, kontrolovaný stav);
- `FormField` (label ↔ input cez `id`, `aria-invalid`, `aria-describedby`);
- `InlineNotice`.

Upravené zdieľané komponenty:
- **DocumentLayout:**
  - `docButton*` a `docField` používajú výšku z tokenu;
  - sekcie `p-3.5/4`, hlavička `text-lg/xl`, modal `px-4 py-3`;
  - metadáta sú na mobile v 2 stĺpcoch.
- **Primitives:** riadok registra `py-2.5`, toolbar, chips `min-h-8`, kompaktný empty state, skeleton `h-14`.
- **BackLink:** ghost odkaz so šípkou (predtým pilulka s tieňom).
- **LanguageSwitcher:** `.ui-segmented`.
- **PushNotificationSettings:** riadok s `role="switch"`.
- **AppDialog, UploadHero, ScrollTabs, IntentResultView, VoiceReplyToggle, VoiceSessionControl:**
  - ovládanie podľa tokenu;
  - spinner počas spracovania;
  - tlačidlo „Otvoriť nastavenia".
- **ModuleCard:** ikona 44–48 px, číslo `text-2xl`, popis `line-clamp-2`.
- **Mobilné prvky:**
  - **MobileTabBar:** aktívna položka v brand farbe, menší sheet „Viac".
  - **MobileChatFab:** brand-600 s bielou ikonou; 56 px ostáva (dotykové minimum).

## 4. Obrazovky

- **Nastavenia** — kompletný redesign (pozri §5).
- **Dashboard:**
  - pozdrav 20–28 px (predtým 30–44 px);
  - pole vyhľadávania ako kompaktné pole s mikrofónom;
  - module grid 2/3/4 stĺpce s medzerou 10 px;
  - STK/EK panel `p-3.5`;
  - kompaktnejší desktop sidebar (šírka 224 px, položky 13 px).
- **Prihlásenie, reset hesla, callback, onboarding firmy, pozvánka, social login:**
  - auth karta `max-w-sm p-4/6`, nadpis 20/22 px;
  - `.ui-input`, `.ui-btn`, správy cez `.ui-notice`.
- **Právne gate (DPA, legal acceptance), PublicLegalLayout, LegalMarkdown, kontakt, PlanLimitNotice:** kompaktná typografia a brand odkazy. Obsah textov je nezmenený.
- **Inbox (ai-evidencia):**
  - menší nadpis a sekcie;
  - ad-hoc inputy nahradené `docField`;
  - tlačidlá `docButton*`;
  - tokenové notice.
- **Faktúry (zoznam, nová, detail), obchodní partneri, vozidlá, priečinky, sklad, stroje:**
  - menšie riadky a karty;
  - sumy `tabular-nums`;
  - formuláre na `docField`/`docLabel`.
  - Žiadna zmena logiky faktúr, DPH ani eInvoice.
- **Chat (shell, zoznam, správy, plávajúci widget, pickery):**
  - bubliny `px-3 py-2`;
  - send/launcher v brand farbe;
  - ikonové tlačidlá 36 px.

## 5. Nastavenia — čo konkrétne

Nový grouped-list pattern s poradím: Jazyk → Firma → Logo → Používatelia → Heslo → Upozornenia → Spätná väzba → Právne → Súkromie a dáta → Zrušiť účet.

- **Jazyk:** jeden riadok s názvom jazyka a segmented SK/DE/EN. Popis je ako pätička skupiny.
- **Firma:**
  - súhrnný riadok (obchodné meno, IČO, mesto);
  - formulár v rozbaľovacom riadku „Firemné a fakturačné údaje" so štyrmi skupinami polí (Identifikácia / Adresa / Banka / Fakturácia);
  - krátke polia v 2–3 stĺpcoch aj na mobile;
  - nevyplnený profil alebo chyba validácie formulár automaticky otvorí.
- **Logo:** náhľad 48 px, tlačidlá „Zmeniť logo" (sm) a ikona koša (sm danger). Hint je v pätičke.
- **Používatelia:**
  - riadky s e-mailom a role badge;
  - pozvánky so stavovým badge;
  - formulár pozvánky v rozbaľovacom riadku: e-mail + select role, pod ním hint vybranej roly (namiesto troch veľkých radio kariet).
- **Heslo:** rozbaľovací riadok, 2 polia vedľa seba na `sm`.
- **Upozornenia:** riadok s prepínačom (switch).
- **Spätná väzba:** jeden riadok-odkaz.
- **Právne a súkromie:** zoznam riadkov-odkazov so šípkou. Potvrdené dokumenty sú riadky s verziou ako badge.
- **Zrušiť účet:** malé danger tlačidlo. Modal je kompaktný a so `role="dialog"`.

Ďalšie zmeny:
- Všetky `window.alert()` nahradila inline `.ui-notice` priamo v sekcii (`role="status"`/`alert`).
- Logika ostala nezmenená: Finance Access Hardening (billing polia iba pri `financeView`), IBAN/BIC iba vlastník, logo flow, mazanie účtu.

## 6. Voice — architektúra a stavový model

**Tok:**
1. `VoiceSessionControl` (ťuknutie, debounce 450 ms).
2. `useVoiceSession` (`hooks/use-voice-session.ts`).
3. `MicSession` (`lib/voice/utterance-capture.ts`): `getUserMedia` a `MediaRecorder` do pamäte, VAD.
4. `/api/assistant/transcribe` (gpt-4o-transcribe, SK/DE/EN prompt).
5. `onUtterance`, teda `/api/assistant/intent` (orchestrátor).
6. Odpoveď cez `speakAndWait`.
7. Mikrofón sa znova otvorí.

**Stavy (`lib/voice/voice-session.ts`, čistý reducer):**
- `idle`, `starting` (= requesting_permission / otváranie mikrofónu), `listening`, `transcribing` / `waiting_server` (= processing), `speaking`, `stopped` (= cancelled / success koniec), `error`.
- Úspech sa ukáže ako výsledok kola (`TURN_RESULT`), chyba ako `noticeKey`.

**Nové:**
- **WATCHDOG:** strážny časovač podľa stavu — starting 30 s, transcribing 25 s, waiting_server 30 s. Nesie generáciu, takže neskorá odpoveď sa zahodí.
- **Limit zlyhaní:** `MAX_CONSECUTIVE_FAILURES = 3`. Prepis počítadlo nenuluje, nuluje ho iba úspešná odpoveď servera. Po limite relácia skončí s „tooManyFailures".
- **Dôvody zlyhania mikrofónu:** `MicFailureReason` = `denied | blocked | not_found | busy | unsupported` (`lib/voice/mic-errors.ts`). Hodnotu `blocked` určí Permissions API „denied" alebo odmietnutie do 450 ms bez výzvy.
- **Typované chyby prepisu:** `TRANSCRIBE_FAILED.kind`.
  - 401 → koniec + „prihlásenie vypršalo";
  - 403 → koniec + „hlas nie je dostupný";
  - offline → koniec;
  - 413 → „príliš dlhé";
  - 5xx/sieť/timeout → povie a počúva ďalej.
- **Zastavenie z dôvodu, ktorý používateľ nečakal (offline, stratený mikrofón):** relácia to povie. Zámerné zastavenie (ťuknutie, pozadie, navigácia) je tiché.
- **`lib/voice/assistant-http.ts`:**
  - `fetchJsonWithTimeout`: timeout, offline kontrola, externé zrušenie, bezpečné parsovanie JSON;
  - `classifyHttpStatus` a `failureMessageKey` vracajú preložené správy, nikdy stavový kód;
  - nikdy automaticky neopakuje.
- **Životný cyklus:**
  - `visibilitychange`, `pagehide`, `freeze`, `offline`;
  - nová udalosť `esblu:app-state` z `AppLifecycleBridge` (Capacitor `appStateChange`), ktorá pri pozadí alebo zamknutí uvoľní mikrofón;
  - pri odmontovaní (route change) sa zruší watchdog aj upload prepisu a mikrofón sa zavrie.
- **Haptika (`lib/voice/device-feedback.ts`):**
  - Android appka: `EsbluAppConfig.haptic`, teda `View.performHapticFeedback` (bez povolenia VIBRATE);
  - web: `navigator.vibrate`;
  - rešpektuje reduced-motion.
- **Trvalé zablokovanie mikrofónu:** tlačidlo „Otvoriť nastavenia".
  - Android: `EsbluAppConfig.openAppSettings`, teda `ACTION_APPLICATION_DETAILS_SETTINGS`.
  - iOS: `app-settings:`.
  - Na webe sa namiesto tlačidla zobrazí návod.
- **Potvrdenie akcie:**
  - in-flight poistka (`confirmInFlightRef`) v launcheri aj na nástenke;
  - úspech iba pri 2xx + `success` + `result`;
  - timeout pri potvrdení → „neviem overiť, či sa zmena uložila — neopakujem automaticky".
- **Server (`transcribe/route.ts`):**
  - OpenAI `timeout: 18 s`, `maxRetries: 1`, `maxDuration = 30`;
  - SK/DE/EN prompt rozšírený o IČO, DIČ, IČ DPH, IBAN, číslo faktúry, VS, splatnosť a s.r.o./a.s.;
  - pokyn zapisovať sumy, dátumy a identifikátory číslicami a nedopĺňať chýbajúce číslice.

## 7. Bezpečnostný model príkazov (`lib/voice/command-safety.ts`)

| Kategória | Príklad | Správanie |
|---|---|---|
| A. navigation | „otvor faktúry" | vykoná sa hneď (iba presun) |
| B. read | „koľko mám neuhradených faktúr" | odpovie hneď |
| C. write | „vytvor faktúru", „pridaj stroj" | **návrh + potvrdenie**: `action_preview` s jednorazovým podpísaným `confirmationId`; návrh faktúry hlasom má nový krok „Pripravil som návrh faktúry — Tester1: kopanie, spolu 300 €. Mám ho vytvoriť?" (`CONFIRM_DRAFT_FIELD`) |
| D. critical | mazanie, odobratie, `destructive` | **nikdy iba hlasom**: vyslovené „áno" vráti `tap_required` → „ťuknite na tlačidlo potvrdenia"; zrušiť sa dá aj hlasom |

**Nejasnosť:**
- Krátka nejasná veta, číslo, suma, IBAN alebo otázka („áno?") nie je súhlas. Esblu sa spýta znova.
- Pri potvrdení faktúry oprava („zmeň kopanie na 350 eur") prepočíta súhrn a pýta sa znova. Nový príkaz návrh zahodí.
- Opakované „áno" po vytvorení nevytvorí druhý doklad (atomický claim).

Server ostáva autoritou: `registry.ts requiresConfirmation`, HMAC confirmation, single-use claim, RLS.

## 8. Privacy / audio

- Audio je iba v pamäti: `Blob` z chunkov `MediaRecorder` ide priamo do `FormData`. Nevzniká žiadny súbor, object URL ani perzistentné úložisko.
- Stopy mikrofónu sa zastavia po každej vete (počas reči Esblu je mikrofón vypnutý), pri stope, na pozadí, pri odmontovaní a pri strate stopy. `AudioContext` sa zavrie na konci relácie.
- Neskoré `getUserMedia` po zastavení stream okamžite zastaví (`openToken`).
- Prepis ani audio sa nelogujú. Klient loguje iba `error.message`; launcher predtým logoval celý objekt chyby. Server loguje iba MIME a chybovú správu OpenAI.
- Mikrofón sa pýta iba pri ťuknutí na mikrofón, nie pri štarte appky.
- Na odpovedi prepisu nie je `Cache-Control: no-store`, pretože POST sa necachuje. Je to v pokračovaniach.

## 9. Testy

Nové:
- **`npm run test:voice-hardening`** (34 testov):
  - stavový model: duplicate start, debounce, stop/cancel, neskoré dokončenia, permission denied/blocked, klasifikácia getUserMedia;
  - watchdog/timeout, limit zlyhaní, offline, 401/403;
  - pozadie a route change;
  - `fetchJsonWithTimeout`: offline, timeout, cancel, 4xx/5xx, HTML odpoveď, bez opakovania;
  - preklady chýb, duplicate submit;
  - bezpečnostný model (navigation/read/write/critical, tap_required, ambiguous numeric);
  - návrh faktúry iba po „áno": nejasné, „nie", oprava, retry bez duplicity, nový príkaz;
  - privacy a serverový timeout/prompt.
- **`npm run test:ui-tokens`** (8 testov):
  - brand tokeny z ikony;
  - WCAG AA kontrast textu a primárneho tlačidla;
  - kompaktné výšky s dotykovým minimom;
  - existencia `.ui-*`;
  - Nastavenia bez obrích tried a `alert()`, poradie skupín, finance gating.

Upravené (kontrakt sa zmenil zámerne):
- `assistant-orchestrator-tests` a `voice-conversation-tests`: draft až po „áno".
- `voice-confirmation-flow-tests`: `decideVoiceReplyForPreview` + `tap_required`.
- `mobile-m1-tests`: trieda BackLink.

Výsledok: všetky `test:*` skripty prešli okrem `*-db` / `p0-bank-sql`. Tie vyžadujú `@electric-sql/pglite`, ktorý v sandboxe nie je nainštalovaný. Tento stav platí aj na pôvodnom commite a tieto testy sa zmien netýkajú.

Ďalšie kontroly:
- `tsc --noEmit` OK.
- `eslint`: 37 chýb a 27 varovaní. Pôvodný commit mal 37 chýb a 30 varovaní, žiadna nová chyba.
- `next build` web OK. Next/font nemal v sandboxe sieť, preto sa build robil s lokálnym stubom fontu a placeholder env — zmena nie je v repe.
- `mobile next build` (static export) OK.
- `verify:mobile-bundle` OK.

## 10. Manuálny checklist

**Mobile (reálne zariadenie, debug/staging build):**
- [ ] Dashboard — prvý dojem: menší pozdrav, kompaktné pole hľadania s mikrofónom, 2-stĺpcová mriežka modulov bez obrovských ikon.
- [ ] Bottom nav — aktívna položka v brand modrej, sheet „Viac" kompaktný.
- [ ] Plávajúci chat button — brand modrý, presúvanie a prichytenie k okraju funguje, neprekrýva tab bar.
- [ ] Nastavenia — scanovateľnosť: na prvú obrazovku sa zmestí Jazyk + Firma + Logo + začiatok Používateľov.
- [ ] Veľkosti inputov a tlačidiel (40 px dotyk), pri fokuse inputu bez zoomu (iOS).
- [ ] Logo — pridať / zmeniť / vymazať (potvrdzovací dialóg), inline správa namiesto alertu.
- [ ] Právne info — 6 riadkov so šípkou, každý otvorí správnu stránku.
- [ ] Upozornenia — switch zapne/vypne push, povolenie sa pýta až po ťuknutí.
- [ ] Spätná väzba — riadok otvorí e-mail.
- [ ] Voice start / stop / cancel: ťuknutie, „koniec", tlačidlo Ukončiť. Dvojité ťuknutie nezastaví hneď po štarte. Haptika pri štarte a konci (Android).
- [ ] Permission: prvé odmietnutie → „Mikrofón nie je povolený"; „Nepýtať sa znova" → „zablokovaný" + „Otvoriť nastavenia" otvorí systémové nastavenia appky; povolenie odobraté v systéme počas relácie → koniec + „mikrofón sa odpojil".
- [ ] Offline (letový režim počas počúvania) → „Ste offline…" a mikrofón zhasne. Pomalá sieť → najneskôr do ~25 s „Odpoveď trvala príliš dlho" a po 3 zlyhaniach koniec.
- [ ] Pozadie / zamknutie počas počúvania → indikátor mikrofónu zhasne; po návrate žiadny phantom „Počúvam".
- [ ] Hlasová navigácia „otvor faktúry" → hneď. Read-only „koľko mám neuhradených faktúr" → odpoveď.
- [ ] Zápis „vytvor faktúru pre Tester1 za kopanie 300 eur, 23 percent" → súhrn + „Mám ho vytvoriť?". „Hm" alebo „300" → otázka znova. „Áno" → draft. „Áno" znova → bez duplicity.
- [ ] Mazanie hlasom „zmaž stroj X" → náhľad; „áno" → „ťuknite na tlačidlo"; ťuknutie → zmazané.

**Web:**
- [ ] Dashboard (desktop sidebar 224 px, mriežka 4 stĺpce), navigácia.
- [ ] Formuláre (faktúra nová, partner, vozidlo) — výšky 36 px, chybové stavy.
- [ ] Nastavenia — rovnaký vzhľad ako mobil, max šírka 672 px.
- [ ] Hustota obsahu v zoznamoch (faktúry, partneri, Inbox).
- [ ] Tlačidlá a inputy — primárne brand-600 s bielym textom, focus ring viditeľný pri Tab.
- [ ] Breakpointy: 1440 / 1280 / 1024 (tablet) / 768 / 390 / 360 px — žiadny horizontálny scroll.
- [ ] Vizuálna konzistencia s mobilom (rovnaké farby, radiusy, typografia).
- [ ] Prihlásenie, pozvánka, onboarding, právne stránky.

## 11. Známe limity / follow-ups

- **iOS haptika:** vyžaduje natívny plugin pridaný do Xcode projektu. `app-settings:` na iOS treba overiť na zariadení.
- **Android `openAppSettings` a `haptic`:** nová natívna metóda v `EsbluAppConfigPlugin.java`. Treba overiť Gradle build a zariadenie, sandbox nemá Android SDK.
- **Detekcia trvalého zablokovania na Android WebView** je heuristická (odmietnutie do 450 ms). Spoľahlivejšie riešenie je natívny `shouldShowRequestPermissionRationale`.
- **`hooks/use-voice-capture.ts`** je mŕtvy kód (jednorazový mikrofón). Odporúčam ho odstrániť samostatne.
- **Landing a cenník (marketing):** prešli iba tokenovou zmenou farieb a tlačidiel. Ich layout je zámerne väčší (hero), detailný pass je v pokračovaniach.
- **AI intent klasifikátor (`lib/intents/ai-fallback.ts`):** prompt som nemenil. Sumy, IČO a IBAN parsujú deterministické parsery a model nemôže vrátiť mazanie.
- **Sklad a stroje:** iba zdieľané primitíva, bez vlastného passu.
- **Lint:** 37 existujúcich chýb (`react-hooks/immutability` a `no-explicit-any` z pôvodného kódu) ostáva.
- **Commit:** iba lokálne na `mobile-platform`, nepushnutý. Push spustí staging preview na Verceli (nie production).

## 12. Polish pass 2 — podľa reálneho Android telefónu (2026-10-11)

Optimalizované pre 360–390 px, Samsung-style system bars, predvolená veľkosť písma.

- **Dashboard**
  - **Dlaždice modulov:** výška ≈ 150 px → ≈ 76 px. Rozloženie: ikona 32 px + názov + počet v jednom riadku, pod tým jednoriadkový popis. Padding `px-3 py-2.5`, medzera 8 px.
  - **Ikony:** iba jedna sada line ikon (`app/components/icons`). Hrúbka ťahu 1.8 v celej appke (AppIcons 1.6 → 1.8, vlastné 2.2 → 1.8). Rovnaký kontajner 32 px (`bg-brand-500/12 text-brand-300`).
    - Rastrové van/excavator/warehouse obrázky a emoji 👤 sú preč (aj v bočnom menu).
  - **Farby:** moduly nemajú vlastné farby (cyan/orange/teal/blue). Všetky sú brand modré, `accent` sa ignoruje. STK/EK upozornenia používajú stavové tokeny (`danger` / `warning`).
  - **Typografia:**
    - názov firmy 11 px tlmený;
    - pozdrav 16 px semibold v jednom riadku s logom (desktop 20 px);
    - názov modulu 14 px semibold v sentence case (žiadne „VOZIDLÁ" verzus „Faktúry");
    - počet 16 px semibold tabular;
    - popis 12 px.
  - **Search bar:** ≈ 48 → 40 px, mikrofón 32 px, text 14 px.
- **Chat FAB:** 56 → 48 px (`CHAT_FAB_SIZE`, hranice ťahania sa prepočítajú), ikona 20 px, jemný tmavý tieň namiesto modrého glow. Badge aj ťahanie ostávajú.
- **Spodná lišta:** výška 60 → 56 px, položka min. 48 px, ikony 20 px. Aktívna položka má brand „pilulku" za ikonou a text v brand-300. Safe-area padding je nezmenený.
- **Login:**
  - nadpis 18/20 px, menšie medzery (`mt-3`, `space-y-2.5`);
  - tichý jazykový prepínač (`LanguageSwitcher subtle`: bez rámu a bez modrej výplne, 28 px) — aj na pozvánke, právnych stránkach a v právnom gate;
  - právne odkazy ostávajú 28 px vysoké.
- **Nastavenia:**
  - riadok skupiny 40 px desktop / 44 px dotyk (predtým 44/48), padding riadku 6×12 px, medzera skupín 16 px;
  - **Firma:** jeden rozbaľovací riadok (názov + IČO · mesto) namiesto súhrnu a samostatného riadku;
  - náhľad loga 40 px;
  - riadok „Vaše členstvo" iba keď sa nezobrazuje zoznam členov; e-maily sú v jednom riadku (truncate), bez ikon;
  - **Upozornenia:** popis max. 2 riadky;
  - **Spätná väzba:** jeden riadok bez dlhého popisu (súkromie ostáva v pätičke);
  - **Právne:** bez úvodnej pätičky;
  - **Potvrdené dokumenty:** v rozbaľovacom riadku (počet ako podtitul);
  - **Zrušiť účet:** jeden riadok (červený názov + popis max. 2 riadky).
  - Zmeny sú iba v rozložení a skrytých/presunutých pomocných textoch, logika sa nemenila.
- **Formuláre na telefóne:** 16 px písmo iba na iOS (`@supports (-webkit-touch-callout: none)` — auto-zoom). Android/Chrome má 15 px.
- **Testy:**
  - `mobile-m1`: nástenka bez rastrových modulov, pravidlo iOS 16 px / ostatné 15 px;
  - `mobile-platform`: FAB hranice podľa `CHAT_FAB_SIZE ≥ 48`;
  - `ui-tokens`: riadok 40/44 px.
