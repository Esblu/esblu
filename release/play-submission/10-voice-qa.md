# 10 — Hlas: QA na reálnom zariadení, AI E2E a súkromie (2026-10-11)

Hlas má dve úplne oddelené vrstvy. Testujú sa oddelene:

| Vrstva | Čo to je | Kde sa dá overiť teraz |
|---|---|---|
| **A. Natívny hlas** | mikrofón, povolenia, haptika, štart/stop/zrušenie, životný cyklus, offline/chyby | staging APK na telefóne (nepotrebuje OpenAI) |
| **B. AI hlas** | prepis reči (OpenAI), interpretácia príkazu, navigácia, čítanie, návrh zápisu + potvrdenie, ochrana kritických akcií | prepis: iba prostredie s OpenAI kľúčom; interpretácia + zápisy: automatický harness `npm run test:voice-e2e` |

**Staging má OpenAI zámerne vypnuté.** Kľúč sa do stagingu nekopíruje a staging sa nemieša s produkčným backendom. Od tohto buildu staging s vypnutou AI (premenná `OPENAI_API_KEY` chýba alebo nemá tvar `sk-…`, napr. zástupná hodnota pre build):

- `/api/assistant/transcribe` vráti **503 `AI_UNAVAILABLE`**. Relácia sa hneď ukončí s hláškou „Hlasový prepis je teraz nedostupný… príkaz môžete napísať". Predtým to bolo 3× „Spojenie zlyhalo".
- `/api/assistant/intent` funguje ďalej. **Písané príkazy** (navigácia, čítanie, návrh faktúry) idú cez deterministický parser. Predtým route bez kľúča padal pri importe s chybou 500, aj pri písaní.

Ak neviete, či má staging prepis zapnutý, ťuknite raz na mikrofón a povedzte „otvor faktúry":
- „Hlasový prepis je teraz nedostupný" znamená, že AI je vypnutá. Natívne body A1–A22 sa dajú otestovať aj tak, s výnimkou A10 a časti A18/A22 (zrušenie počas „Spracúvam…", strata siete počas spracovania, 3 zlyhania po sebe), ktoré potrebujú bežiaci prepis.
- Inak beží celý reťazec.

---

## A. Natívny hlas — checklist pre reálny Android telefón

**Príprava:**
- staging build z kitu (Build ID je vo „Viac");
- účet s rolou owner alebo admin;
- firma s nárokom `voice`. Bez neho sa mikrofón nezobrazí a server vráti 403.

Mikrofón je v poli hľadania na nástenke a v paneli asistenta.

| # | Krok | Očakávaný výsledok |
|---|---|---|
| A1 | **Prvé ťuknutie** na mikrofón (povolenie ešte nebolo udelené) | Zobrazí sa systémový dialóg Androidu „Povoliť Esblu nahrávať zvuk?". Appka nespadne a indikátor ukazuje „Zapínam…" |
| A2 | **Povoliť** („Pri používaní aplikácie") | Krátka haptika štartu. Pulzujúci krúžok a text „Počúvam…" |
| A3 | Odinštalovať/vymazať dáta → prvé ťuknutie → **Nepovoliť** | Relácia skončí: „Mikrofón nie je povolený. Hlasový režim som ukončil." Haptika chyby. Zobrazí sa tlačidlo **Otvoriť nastavenia** (natívne). Žiadna slučka |
| A4 | Ťuknúť znova → **Nepovoliť** druhýkrát (Android 11+ = **trvalé zamietnutie**) | Systémový dialóg sa už nezobrazí, text „Mikrofón je pre Esblu zablokovaný…" a tlačidlo **Otvoriť nastavenia** |
| A5 | **Otvoriť nastavenia** | Otvorí sa systémová stránka *Informácie o aplikácii* Esblu (Povolenia) |
| A6 | V Settings povoliť Mikrofón → späť do appky → ťuknúť na mikrofón | Stará chybová hláška pri návrate **zmizne** (`CLEAR_MIC_ERROR`). Ťuknutie spustí počúvanie bez dialógu |
| A7 | Počas bežiacej appky **odobrať** povolenie v Android Settings → späť | Android proces reštartuje. Appka sa otvorí bez aktívnej relácie, mikrofón nie je zapnutý. Ďalšie ťuknutie postupuje ako A1 alebo A4 |
| A8 | **Štart** (ťuknutie) | Haptika štartu iba pri prvom kole. Systémový indikátor mikrofónu (zelená bodka vpravo hore) svieti |
| A9 | **Stop**: ťuknutie na aktívny mikrofón, tlačidlo ukončenia alebo veta „koniec" | Haptika stopu. Indikátor mikrofónu **zhasne do ~1 s**. Stav „idle" |
| A10 | **Zrušiť** počas „Spracúvam…" (ťuknutie / tlačidlo) | Upload prepisu sa zruší a výsledok sa nespustí. Nič sa nezapíše |
| A11 | **Dvojité ťuknutie** (rýchlo 2×) | Iba jeden štart (debounce 450 ms). Žiadne dvojité oznámenie ani dvojitý dialóg |
| A12 | **Haptika štart** | Jedna krátka vibrácia pri začatí počúvania. Pri „Odstrániť animácie" (reduced motion) žiadna |
| A13 | **Haptika stop** | Jedna krátka vibrácia pri ukončení aktívnej relácie (aj pri odchode do pozadia) |
| A14 | **Home** počas „Počúvam…" | Relácia sa okamžite zastaví a indikátor mikrofónu zhasne. Žiadne oznámenie nahlas |
| A15 | **Zamknutie obrazovky** počas počúvania | Rovnako ako A14. Po odomknutí nič nebeží |
| A16 | **Návrat do popredia** | Relácia sa **sama nespustí**. Mikrofón je vypnutý, treba nové ťuknutie |
| A17 | **Režim lietadlo**, potom ťuknutie a hovor | „Ste offline. Hlasový režim som ukončil." **Raz**, bez 3× „Spojenie zlyhalo" (offline sa teraz rozpozná aj počas čakania na server; `ACCESS_NETWORK_STATE` je v manifeste explicitne, predtým iba cez Firebase merge) |
| A18 | **Strata siete počas počúvania alebo spracovania** (vypnúť Wi-Fi/dáta) | Relácia skončí s „Ste offline…". Mikrofón zhasne a nič sa neopakuje automaticky |
| A19 | **Zmena obrazovky** počas počúvania (ťuknutie na spodnú lištu, Chat, Späť) | Relácia sa zastaví (odmontovanie), indikátor zhasne. Na novej obrazovke nič nepočúva |
| A20 | **Klávesnica**: počas počúvania ťuknúť do poľa hľadania a písať | Hlas prejde do ručného režimu (stop „manual"), mikrofón zhasne. Po zatvorení klávesnice sa nič samo nespustí |
| A21 | **Indikátory** | Počúva: pulzujúci krúžok a „Počúvam…". Spracúva: spinner a „Spracúvam…". Esblu hovorí: „Hovorím…". Chyba: tlmená červená a text chyby |
| A22 | **Chybové stavy** (príliš dlhá veta > 20 s, ticho, opakované zlyhanie) | > 20 s: „Veta bola príliš dlhá…". Ticho: výzva a potom ukončenie. 3 zlyhania po sebe: „Opakovane sa nedarí spojenie…" a koniec. **Nikdy nekonečná slučka** |

**Pri každom bode zapíšte:** model telefónu, verziu Androidu, Build ID, PASS/FAIL a pri FAIL screenshot plus presný postup.

**Mimo rozsahu:** iOS (haptika a nastavenia neoverené) a tablet.

---

## B. AI hlas — automatický bezpečný E2E harness

`npm run test:voice-e2e` (`scripts/voice-e2e-contract-tests.ts`) prechádza tou istou cestou ako reálny hlas **po prepise**:
- **cesta:** text → parser a orchestrátor → brány oprávnení a nárokov → handlery → pamäťová DB;
- **pamäťová DB** emuluje RLS jednej firmy, jednorazový claim konverzácie a `esblu_save_invoice_draft`;
- **AI klasifikátor** je stub, takže sa overuje aj to, že bez AI nič nezapíše omylom;
- **nepoužíva** OpenAI, produkčnú DB ani sieť;
- **dáta** sú fiktívne (Lesy Horehronie s.r.o., Stavby Kysuce s.r.o., …).

| Oblasť | Prípady | Výsledok |
|---|---|---|
| Navigácia | „Otvor faktúry" → `/faktury`, „Choď na partnerov" → `/obchodni-partneri`, „Otvor sklad" → `/sklad`, rola employee faktúry neotvorí | PASS |
| Read-only | „Koľko mám neuhradených faktúr", „Nájdi partnera Lesy Horehronie" (otvorí sa), „Nájdi partnera Stavby" (výber z dvoch), „Koľko mám vozidiel" (zoznam + hlas „Vozidlá: 2") | PASS |
| Zápis | „Vytvor faktúru pre Lesy Horehronie, položka kopanie, 300 eur, 23 percent" → **iba návrh** → súhrn (partner, položka, 300 €, **DPH 23 %**) a tlačidlá Áno/Nie, 0 dokladov → „áno" → presne 1 draft → opakované „áno" bez duplicity → **súbežné** dvojité „áno" stále 1 draft. Draft nemá číslo, splatnosť ani VS | PASS |
| Nejasnosti | nejasná suma, nejednoznačný partner, neznámy partner, číslo faktúry v príkaze, chýbajúci lokálny dátum, IBAN/dátum/suma namiesto „áno", nečitateľná DPH → **nikdy zápis** | PASS |
| Kritické | mazanie: hlasové „áno" → `tap_required`; AI nesmie vyrobiť DELETE; „Zmaž môj účet" a platba hlasom neexistujú (žiadny náhľad ani akcia); execute berie iba jednorazové `confirmationId` | PASS |

**Opravené chyby nájdené pri audite** (v tomto commite):
1. Presná veta zo zadania („…, **položka** kopanie, 300 eur, 23 percent") vytvárala riadok „položka kopanie" bez ceny a pýtala sa na sumu. Teraz sa slovo „položka" z popisu odstráni a „popis, 300 eur" oddelené čiarkou sa spojí do jedného riadku.
2. „dvadsať celých päť" sa čítalo ako **20** (pri DPH by to bola tichá zmena sadzby). Teraz 20,5. Nečitateľná desatinná časť znamená otázku, nie odhad.
3. DPH vyslovená slovami za sumou („300 eur, dvadsaťtri percent") sa nenašla. Teraz sa nájde.
4. Súhrn pred potvrdením neobsahoval sadzbu DPH. Teraz „…, spolu 300 €, DPH 23 %. Mám ho vytvoriť?".
5. „Koľko mám vozidiel / strojov" bez AI = „nerozumel som" (alebo hľadanie textu „kolko mam"). Teraz read-only zoznam a hlas povie počet.

**Ostáva pre živý AI test** (prostredie s kľúčom):
- skutočná kvalita prepisu gpt-4o-transcribe (sekcia C);
- AI klasifikátor pre vety mimo deterministickej gramatiky.

---

## C. Slovenský prepis — pokrytie

**Prompt** (`app/api/assistant/transcribe/route.ts`, model `gpt-4o-transcribe`, `language: sk`):
- vynucuje doslovný prepis a slovník domény (IČO, DIČ, IČ DPH, IBAN, číslo faktúry, splatnosť, s.r.o., a.s., STK, EK, ŠPZ …);
- žiada „sumy, dátumy, čísla dokladov, IČO, DIČ, IČ DPH a IBAN zapíš číslicami presne tak, ako zazneli";
- pri diktovaní faktúry pridá kontext faktúry;
- **neobsahuje žiadne firemné ani zákaznícke dáta** (overené testom).

**Overené v harnesse** (deterministická vrstva po prepise):

| Prípad | Príklad | Výsledok |
|---|---|---|
| firmy | „Lesy Horehronie s.r.o.", „Stavby Kysuce s.r.o." vs. „Stavby Kysuce Servis a.s." | presná zhoda sa použije, ale súhrn vysloví celý názov **aj IČO**. Nejednoznačná zhoda = výber |
| osoby | „Pridaj nového partnera Ján Novák" | PARTNER_CREATE s menom (cez potvrdenie) |
| IČO | „IČO 51 234 567" | `51234567` (medzery z prepisu odstránené) |
| DIČ | „DIČ 2023456789" | presne 10 číslic |
| IČ DPH | „IČ DPH SK 2023456789" | `SK2023456789` |
| IBAN | odpoveď „SK31 1200 …" pri potvrdení | nikdy nepotvrdí. Hlas IBAN do dokladu nezapisuje (zámerne) |
| čísla faktúr | „Otvor faktúru FA-2026-7" | vyhľadanie dokladu (read-only). Číslo v príkaze na vytvorenie sa **nepoužije** |
| dátumy | „15. 10. 2026" pri potvrdení | nepotvrdí. Dátum vystavenia = overený lokálny deň (±1 deň), inak fail-closed |
| sumy EUR | „1 250,50 €", „tisíc dvesto eur", „dvesto celých päťdesiat eur" | 1250,50 / 1200 / 200,50 |
| DPH | 23 %, 20 %, 19 %, 5 %, 0 %, „dvadsaťtri percent", „dvadsať celých päť percent" | správne. „300 eur percent" nie je sadzba |
| „tisíc dvesto" vs. „dvanásť tisíc" | | 1200 vs. 12000 |
| desatinné | „dvadsať celých päť", „tri celé dva", „sto celých nula päť", „300,50", „1.234,50" | 20,5 / 3,2 / 100,05 / 300,5 / 1234,5 |

**Známe limity:**
- Prompt je statický: nemá per-firma slovník mien partnerov, zámerne kvôli súkromiu.
- Zriedkavé priezviská a názvy firiem môžu prepisom prísť skomolené. Ochranou je overenie partnera proti evidencii a súhrn pred „áno".

---

## D. Súkromie hlasu — overené z kódu

| Požiadavka | Stav | Kde |
|---|---|---|
| audio iba v pamäti | **OK** — Blob → FormData. Žiadny súbor, IndexedDB, localStorage ani object URL | `utterance-capture.ts`, `use-voice-session.ts` |
| žiadne trvalé temp súbory | **OK** — server posiela `File` priamo do OpenAI, nič neukladá | `transcribe/route.ts` |
| upratanie audio zdrojov | **OK + oprava**: neskoro dokončená nahrávka zastaveného kola sa už neuloží a na konci relácie sa blob vždy zahodí. AudioContext sa zatvára. Source node sa odpája po každom kole | `use-voice-session.ts` |
| transcript sa neloguje | **OK** — intent route loguje iba `textLength` a typ intentu | `intent/route.ts` |
| audio sa neloguje | **OK** — iba MIME typ pri zamietnutí | `transcribe/route.ts` |
| token/secret v logoch | **Opravené**: chyba OpenAI pri 401 obsahuje maskovaný fragment kľúča a predtým sa logoval `error.message`. Teraz iba `{name, status, code, type}` (`safeAiErrorMeta`) | `lib/ai/openai-runtime.ts`, `transcribe/route.ts`, `ai-fallback.ts` |
| mikrofón sa vždy zastaví | **OK** — stop, zrušenie, chyba, timeout, max. dĺžka, ticho, odmontovanie, `visibilitychange`, `freeze`, `pagehide`, natívne pozadie, offline, odhlásenie | `voice-session.ts`, `use-voice-session.ts` |
| diagnostika | iba `{t, kind, name, gen}`, nikdy text ani audio, nič sa neposiela na server | `voice-diagnostics.ts` |

---

## E. Produkčný hlasový test — LEN READ-ONLY (voliteľné)

Ak je jediný reálny round-trip s OpenAI produkčná beta appka, smie sa testovať **iba** toto. Vykonáva vlastník na vlastnom účte. Nevytvárajú sa doklady, nič sa nemaže ani nemení.

| # | Povedať | Očakávané | Zapísať |
|---|---|---|---|
| P1 | „Otvor faktúry" | otvorí Faktúry | prepis presne? |
| P2 | „Choď na partnerov" | Obchodní partneri | |
| P3 | „Otvor sklad" | Sklad | |
| P4 | „Koľko mám neuhradených faktúr?" | odpoveď s počtom / „všetky uhradené" | |
| P5 | „Nájdi partnera <existujúci partner>" | otvorí detail alebo výber | prepis mena firmy |
| P6 | „Koľko mám vozidiel?" | zoznam a hlas „Vozidlá: N" | |
| P7 | „Ukáž neuhradené faktúry za september" | zoznam | prepis mesiaca |
| P8 | Diktovanie bez potvrdenia: „Vytvor faktúru pre <partner>, položka test, tisíc dvesto eur, 23 percent" → na otázku **„Mám ho vytvoriť?" povedať „Nie"** | súhrn: 1 200 €, DPH 23 %, potom „Nie" a nič sa nevytvorí | prepis sumy a sadzby. **Nikdy nepovedať „áno"** |
| P9 | Režim lietadlo → ťuknúť a hovoriť | „Ste offline…" | |
| P10 | Hovoriť 25 s bez prestávky | „Veta bola príliš dlhá…" | |

**Zakázané v produkcii:** „áno" na akýkoľvek návrh zápisu, mazanie, vytváranie partnerov, skladové pohyby, akékoľvek platobné alebo zápisové testy. Write a critical flow ostávajú overené harnessom (sekcia B), kým nebude bezpečný staging s AI.

---

## F. Mikrofón chýbal na reálnom telefóne (build 2026-10-11T17:36:58Z)

### Príčina

- `VoiceSessionControl` vracal `null`, keď firma nemala nárok `voice`. Rovnako sa skryl aj počas načítania nárokov a pri chybe ich načítania.
- Hlas **nie je súčasťou 14-dňového trialu** (`entitlement_catalog.voice.included_in_trial = false`).
- Staging firma **Anchar Bau (STAGING)** (esblu-test `cjbdijbbcujvmrzezusd`) je v triali do 2026-10-23 a nemala žiadny grant. RPC `esblu_get_my_company_entitlements` vracalo `voice: active=false, reason=VOICE_ENTITLEMENT_REQUIRED`.
- Mikrofón preto bez vysvetlenia **vôbec nebol v DOM**. Nebolo to CSS ani detekcia platformy.

### Oprava UI (`lib/voice/mic-gate.ts`)

| Stav | Kedy | UI |
|---|---|---|
| ready | oprávnená rola + nárok | funkčný mikrofón (idle / počúva / spracúva / chyba) |
| pending | načítava sa členstvo alebo nároky | neaktívny mikrofón na stabilnom mieste |
| locked | bez nároku `voice` | mikrofón so zámkom. Ťuknutie ukáže „Hlasové ovládanie nie je súčasťou vášho balíka…" a „Požiadať o aktiváciu" |
| unavailable | chyba načítania nárokov | ťuknutie = skúsiť znova a vysvetlenie |
| hidden | rola bez hlasu (zamestnanec) | nič (politika rolí bez zmeny) |

- Zamknutý ani čakajúci mikrofón **nikdy nespustí reláciu**.
- Server ostáva autoritou: `guardTranscription` → `esblu_require_my_entitlement('voice')`.

### Staging-only testovací grant (vykonané 2026-10-11 18:03 UTC)

| Položka | Hodnota |
|---|---|
| Projekt | **esblu-test** `cjbdijbbcujvmrzezusd` (staging). **Nie** produkcia `fkpgvgvsmbpieduoatrt` |
| Firma | `00d01023-94e4-4f0a-8616-bf76a5019d8b` „Anchar Bau (STAGING)" |
| Mechanizmus | existujúca tabuľka `company_entitlements` (bez nového billing modelu) |
| Riadok | id `189d17e2-aa67-4f42-9d80-5bdbb4b048a5` |
| Hodnoty | `entitlement_key='voice'`, `source='manual'`, `status='active'`, `valid_until=2026-12-31 23:59:59+00` |
| Poznámka | `STAGING-ONLY QA test grant 2026-10-11: native voice QA …` |

**Overenie** (impersonácia `roia.juris@gmail.com` v read-only transakcii):
- `esblu_get_my_company_entitlements` → `voice active=true source=manual`;
- `esblu_require_my_entitlement('voice')` → `active=true`.

**Zápis:**

```sql
insert into public.company_entitlements (company_id, entitlement_key, source, status, valid_until, note)
select c.id, 'voice', 'manual', 'active', timestamptz '2026-12-31 23:59:59+00',
       'STAGING-ONLY QA test grant 2026-10-11: native voice QA (mic permission/start/stop/haptics). Reversible: set status=revoked. Not billing.'
from public.companies c
where c.id = '00d01023-94e4-4f0a-8616-bf76a5019d8b' and c.name = 'Anchar Bau (STAGING)'
  and not exists (select 1 from public.company_entitlements e
                  where e.company_id = c.id and e.entitlement_key = 'voice' and e.status = 'active');
```

**Rollback** (iba staging, nič sa nemaže):

```sql
update public.company_entitlements set status = 'revoked', updated_at = now()
where id = '189d17e2-aa67-4f42-9d80-5bdbb4b048a5';
```

Grant navyše sám vyprší 2026-12-31.

**Po rollbacku musí mikrofón ostať viditeľný so zámkom.** To je zároveň test stavu „locked".
