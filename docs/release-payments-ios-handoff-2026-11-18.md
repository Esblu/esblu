# Esblu — Android ostrý koncept, predplatné, ekonomika a iOS (odovzdanie 2026-11-18)

Vetva `android-release-payments-ios-2026-11-18` z `origin/main` @ `12da726c843b` (worktree `.worktrees/release-payments-ios`).
Žiadna zmena produkčnej DB, Vercel konfigurácie, aplikácie ani právnych dokumentov. Ostré vydanie Androidu ostáva **koncept**.

## 1. Android — ostrý koncept

| Položka | Stav | Dôkaz |
|---|---|---|
| Verzia v ostrom koncepte | **4 (1.0.1) — Koncept**, kanál Ostrá verzia „Neaktívne“, 0 inštalácií | Play Console (účet vývojára Esblu 8050279484634120081), Ostrá verzia → Vydania, 2026-11-18 |
| Krajiny | **Slovensko** (1 zacielená krajina) | Ostrá verzia → Krajiny alebo regióny |
| Záznam v obchode SK | názov „Esblu“, krátky popis zhodný s repom; **úplný popis končil vetou o uzavretej bete** („Esblu je momentálne v uzavretej beta verzii…“) → **nahradené** textom z `docs/open-registration-2026-11-17.md` § 5 a **uložené ako koncept** (1186/4000 znakov, „Zmeny boli uložené“; neodoslané na kontrolu) | Predvolený záznam v obchode |
| Záznam v obchode EN | **neexistuje** — jediný jazyk je „Slovenčina – sk (predvolené)“; text EN je pripravený v `01-store-listing.md` C | jazykový výber záznamu |
| Nový build | **netreba** — žiadne zistenie nevyžaduje zmenu aplikácie | — |
| Popis SK/EN vs. aplikácia | texty v repe (`01-store-listing.md` C) sedia s modulmi vc4 (Inbox, vozidlá, stroje, sklad, partneri, faktúry s opravnými dokladmi a PDF, chat s prílohami a odkazmi na záznamy, push); bez zmienky o uzavretej bete; poznámky 1.0.1 (H2) bez bety | kód: `lib/chat.ts` (prílohy, referencie), `mobile/app/*` |
| Odkaz na zásady | `https://www.esblu.com/ochrana-osobnych-udajov` 200, verzia 1.4 (9. 11. 2026) | HTTPS GET 2026-11-18 |
| Stránka zrušenia účtu | `https://www.esblu.com/zrusenie-uctu` 200 (web + Android, žiadosť bez appky) | HTTPS GET |
| App access | účet `info+playreview@esblu.com` funkčný (potvrdený, owner demo firmy, 9 nárokov, posledné prihlásenie dnes). **Demo firma nemá faktúry, Inbox ani chat**, hoci pôvodný text ich sľubuje → text 6A (po doplnení dát) a 6B (dnešný stav) v `03-app-access-reviewer.md` | read-only metadáta, záznam v `docs/ops/service-intervention-log.md` |
| Data safety (živý formulár) | zhromažďuje: áno; šifrovanie pri prenose: áno; účty: meno+heslo a OAuth; URL zrušenia `/zrusenie-uctu`; čiastočné mazanie: áno → `/ochrana-osobnych-udajov`; **zdieľanie: žiadne**. Typy: Osobné (meno, e-mail, ID, adresa, telefón, ďalšie), Finančné **3 zo 4**, Správy 1, Fotky 1, Zvuk 1 (dočasné), Súbory 1, **Kontakty 1/1**, Aktivita v aplikácii **4 z 5** (pri prvej položke účel **Analytika**), ID zariadenia 1 | Obsah aplikácie → Zabezpečenie údajov (kroky 2, 3, 5 — iba čítanie, nič neuložené) |
| Data safety vs. vc4 | **sedí** — Kontakty, 3 finančné typy aj účel Analytika zodpovedajú skutočnému správaniu (prepracované 2026-11-18, `04-data-safety.md` § Prepracované body); pôvodný návrh na 3 opravy bol nesprávny | schéma produkčnej DB (iba stĺpce), manifest, `ai_usage_metering` |
| Finančné funkcie | „My app doesn't provide any financial features“ — sedí s vc4 (billing UI vypnuté, žiadny nákup ani cenník v appke) | `05-financial-features.md`, `app/nastavenia/page.tsx` (`NEXT_PUBLIC_ESBLU_BILLING_UI`) |
| Zverejnená dokumentácia vs. vc4 | **2 rozdiely**: Resend nie je v Zásadách/DPA a `/subprocessors` tvrdí opak; Zásady 1.4 a DPA 1.3 uvádzajú Google iba na webe | § 5 (CLIA) |

### 1.1 Položky pred odoslaním na kontrolu

1. **App access:** použiť text **6B** (overený stav demo účtu: 2 vozidlá, 1 stroj, 3 skladové položky, 1 partner;
   bez faktúr, Inboxu a chatu) — `03-app-access-reviewer.md` § 6B. Heslo zadáva iba vlastník.
2. **Data safety:** odpovede pre Kontakty, Finančné údaje a Aktivitu v aplikáciách sú pripravené po typoch (údaje, kam,
   účel, dôkaz, presná odpoveď) v `04-data-safety.md` § Prepracované body. Súčasný stav v Console im zodpovedá → **nemeniť**.
   „Žiadne zdieľanie“ je obhájiteľné (spracovatelia = výnimka); konzervatívny výklad pre OpenAI ostáva otázkou pre CLIA.
3. **Vlastník — EN záznam (voliteľné):** Záznamy v obchode → Spravovať jazyky → pridať English (United States) a vložiť text
   z `01-store-listing.md` C (EN). Bez neho sa anglickým používateľom zobrazí slovenský záznam.
4. **Zásady vs. appka:** rozhodnúť s CLIA (§ 5), či sa verejné vydanie odošle pred úpravou Zásad (Google login v appke, Resend).
5. Odoslanie na kontrolu — **iba po schválení vlastníkom** (zmena popisu SK je uložená ako koncept spolu s vydaním).

## 2. Platby — Stripe

- Stripe test účet ani kľúče **nie sú dostupné** (žiadne `STRIPE_*` vo Verceli, Stripe Dashboard neprihlásený) → podľa pokynu
  vlastníka sú **všetky testy priamo v Stripe označené ako NEOVERENÉ**; scenáre sú overené simuláciami (mock Stripe API +
  PGlite s produkčnými migráciami): `test:subscriptions` 28/28, `test:subscriptions-db` 60/60, `test:subscriptions-lifecycle-db`
  69/69 a 10 pomenovaných súborov PASS.
- Tabuľka scenárov S1–S10b, W1–W4, C1–C2, I1, R1, postupy vlastníka, runbook na reálny test a **vzor mesačného párovania**:
  `docs/stripe-test-and-reconciliation-2026-11-18.md`, CSV `docs/finance/stripe-monthly-reconciliation-template.csv`.
- Zistenia: dvojitá platba pri súbežnom nákupe potrebuje operátorský postup (refund); čiastočná refundácia nemení prístup
  (potvrdiť VOP); DB Esblu neukladá poplatky ani výplaty (párovanie zo Stripe reportov); adaptér prijíma 1 položku na predplatné.

## 3. Ekonomika a dane

`docs/payment-channels-economics-2026-11-18.md` + `scripts/payment-channel-economics.py` (sebatest OK).
Pri 15,90 €: Stripe karta ~0,70 € poplatok (+0,03–0,16 € DPH § 7a), výplata 15,20 €; Google Play / App Store pri cene
s DPH výplata ~10,99 €. Bod zvratu: Stripe 5 firiem (infra) / ~20 (s overheadom 150 €); obchody 8–10 / ~32–33.
**Odporúčanie:** prvý kanál Stripe na webe (karta + SEPA inkaso); SEPA prevod iba ako výnimka; obchody bez predaja;
Comgate pred Stripe až pri ~300+ firmách. 12 otázok pre účtovníčku v § 6 dokumentu.

## 4. iOS / TestFlight

**Nespustené** — chýba Apple Developer (organizácia, D-U-N-S), podpisovanie a Mac/CI. Presné kroky, cena (99 $/rok, build 0 €
cez Codemagic free tier alebo vlastný Mac), testovací plán Apple prihlásenia a dve chýbajúce implementácie (odvolanie Apple
tokenu pri zrušení účtu, manuálne prepojenie identít): `docs/ios-testflight-plan-2026-11-18.md`.

## 5. CLIA (do 24. 11. 2026)

Návrh správy na kontrolu vlastníkovi: `docs/clia-delta-2026-11-24-draft.md` — Resend (DNS dôkaz `mail.esblu.com`), Google login
v Android appke, nesúlad dátumov na `/subprocessors`, otázky k Apple prihláseniu, platbám, refundáciám a DPA.

## 6. Najbližšie kroky

| Otvorený bod | Najbližší vykonateľný krok | Kto |
|---|---|---|
| Play Console Data safety | bez zmeny; pripravené odpovede v `04-data-safety.md` | — |
| App access | vložiť text 6B do Play Console (heslo vlastník) | vlastník |
| Stripe reálny test | Stripe test účet + cena 15,90 € + restricted key a webhook do Vercel Preview (runbook § 4) | vlastník → agent |
| Účtovníčka | poslať otázky § 6 ekonomiky + vzor párovania | vlastník |
| Apple | D-U-N-S → Apple Developer (99 $/rok, schválenie) | vlastník |
| CLIA | skontrolovať a odoslať návrh do 24. 11. | vlastník |
