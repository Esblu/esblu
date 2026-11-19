# Návrh správy pre CLIA — termín 24. 11. 2026 (NÁVRH na kontrolu vlastníkovi)

Stav: **draft, neodoslané**. Produkčné právne dokumenty sa nemenia, kým sa s CLIA nedohodne ďalší postup.
Podklady overené 2026-11-18 (živé stránky www.esblu.com, DNS, repo `main` @ `12da726`, produkčné metadáta bez osobných údajov).

---

**Predmet:** Esblu — potvrdené rozdiely v produkcii (e-mail, Google prihlásenie v Android appke) a otázky k budúcim funkciám

Dobrý deň,

pri príprave verejného vydania Android aplikácie a platieb predplatného sme porovnali reálny stav produkcie s platnými
dokumentmi (Zásady ochrany osobných údajov 1.4 z 9. 11. 2026, DPA 1.3, VOP 1.2, zoznam sprostredkovateľov na
`/subprocessors`). Prosíme o posúdenie nižšie uvedených rozdielov a návrh úprav. Dokumenty zatiaľ nemeníme.

## 1. Potvrdené rozdiely v už používanej produkcii

### 1.1 Resend — odosielanie potvrdzovacích e-mailov (od 17. 11. 2026)

- **Realita:** Supabase Auth v produkcii odosiela registračné a autentifikačné e-maily (potvrdenie registrácie, obnova hesla,
  pozvánky) cez vlastný SMTP poskytovateľa **Resend** z domény `mail.esblu.com`.
- **Dôkazy (stav 18. 11. 2026):**
  1. *DNS (overené agentom, dns.google):* `resend._domainkey.mail.esblu.com` TXT = DKIM kľúč Resend; `send.mail.esblu.com`
     TXT = `v=spf1 include:amazonses.com ~all` (odosielacia infraštruktúra Resend). Koreňová doména `esblu.com` má SPF iba
     pre Namecheap Private Email — `mail.esblu.com` je samostatná odosielacia subdoména pre Resend.
  2. *Nastavenie SMTP (snímka obrazovky z 18. 11. 2026, poskytol vlastník):* produkčný Supabase projekt `assetpilot` →
     Authentication → SMTP Settings: **vlastný SMTP zapnutý**, host **`smtp.resend.com`**, odosielateľ
     **`noreply@mail.esblu.com`** (heslo / API kľúč sa neuvádza). Snímku prikladá vlastník k správe pre CLIA; agent ju
     nevidel, údaje sú prevzaté z popisu vlastníka a zhodujú sa s DNS v bode 1 (odosielacia doména `mail.esblu.com`).
     Zapnutie potvrdil vlastník už 17. 11. 2026 (`docs/android-release-vc4-2026-11-17.md`, doplnok).
  3. *Prevádzkový záznam:* produkčný auth log 17. 11. 2026 22:55:16 UTC `user_confirmation_requested` (registrácia z Android
     appky, adresa mimo `esblu.com`) → `/verify` 200 o 22:55:29 UTC; vlastník potvrdil prijatie e-mailu a návrat do Esblu.
     Vstavaný mailer Supabase doručuje iba adresám členov tímu projektu, takže doručenie na externú adresu zodpovedá vlastnému SMTP.
- **Dátum začiatku:** nastavenie Resendu je doložené snímkou z 18. 11. 2026; doručenie e-mailu na externú adresu je
  doložené **17. 11. 2026 22:55 UTC** (bod 3). **Presný dátum prvého odoslania cez Resend zatiaľ nie je overený** — overí ho
  vlastník v Resend → Emails (najstarší záznam) alebo Domains → `mail.esblu.com` (Created / Verified) a doplní sa sem.
- **Dokumenty:**
  - `/subprocessors` výslovne uvádza, že „Resend nie je aplikáciou nikde použitý“ a že e-maily odosiela „výhradne vstavaný
    e-mailový systém Supabase Auth“ — **nepravdivé od 17. 11. 2026**.
  - Zásady 1.4, časť o prevádzkových a autentifikačných oznámeniach: príjemcovia iba Supabase a Vercel — Resend chýba.
  - DPA 1.3, príloha sprostredkovateľov — Resend chýba (zmena sprostredkovateľa → postup oznámenia podľa DPA).
- **Údaje:** e-mailová adresa príjemcu, obsah e-mailu (odkaz s tokenom), metadáta doručenia. Lokalita: Resend (USA);
  **región odosielania a DPA Resend potvrdí vlastník** (Resend ponúka aj EÚ región).
- **Otázky:** (a) zaradenie Resend ako sprostredkovateľa (Zákazník — DPA) aj ako príjemcu (Esblu — prevádzkovateľ pri
  vlastných účtoch)? (b) potrebné oznámenie Zákazníkom o novom sprostredkovateľovi podľa DPA a lehota? (c) mechanizmus
  prenosu (DPF / SCC)?

### 1.2 Google prihlásenie v Android aplikácii

- **Realita:** Android aplikácia 1.0.1 (versionCode 4, interné testovanie Google Play od 17. 11. 2026, pripravené na verejné
  vydanie) ponúka „Pokračovať cez Google“ (OAuth s PKCE, návrat `com.esblu.app://auth/callback`). Overené na telefóne
  17. 11. 2026 (úspešné prihlásenie v appke aj na webe).
- **Dokumenty:**
  - Zásady 1.4: „prihlasovanie cez Google je dostupné **vo webovom rozhraní** Aplikácie“.
  - DPA 1.3: „Vo webovom rozhraní je dostupné aj prihlásenie prostredníctvom účtu Google“.
  - VOP 1.2 čl. 5.1 je formulované neutrálne („ak je táto možnosť v Aplikácii dostupná“) — bez rozdielu.
- **Návrh:** „vo webovom rozhraní a v mobilnej aplikácii“ (rozsah údajov a príjemca Google LLC sa nemenia).
- Pozn.: interne bolo 10. 11. vyhodnotené ako „pravdivé, nie úplné“ (Q14); s verejným vydaním appky ide o reálny rozdiel.

### 1.3 Ďalšie zistenia pri kontrole

- **Zoznam `/subprocessors`** uvádza „Posledná aktualizácia: 16. augusta 2026“ a zároveň „Aktuálna verzia platí od 2026-09-09“ — zjednotiť pri úprave.
- **Verejné vydanie appky = verejná registrácia aj v appke** (od 17. 11. 2026 je registrácia otvorená). Texty o „pozvaných alebo
  schválených záujemcoch“ (VOP 5.1, druhá veta) sú formulované ako možnosť — bez rozdielu, iba na vedomie.

## 2. Google Play — Data safety a deklarácie (na vedomie, pred odoslaním na kontrolu)

Pripravené odpovede (`release/play-submission/04-data-safety.md`) zostávajú konzervatívne: OpenAI ako „Shared“ pri skenoch
a hlase, Resend/Supabase/Vercel/FCM ako poskytovatelia služieb („not shared“). Prosíme potvrdiť výklad „shared“ pre OpenAI
a doplnenie Resend do kontextu e-mailovej adresy (Account management).

## 3. Budúce funkcie — aké zmeny dokumentov budú potrebné?

### 3.1 Prihlásenie cez Apple (iOS)

1. Doplniť Apple Inc. / Apple Distribution International ako zdroj a príjemcu údajov pri prihlásení (meno, e-mail alebo
   relay adresa `@privaterelay.appleid.com`, technický identifikátor) — analogicky ku Google.
2. „Skryť môj e-mail“: e-maily z `mail.esblu.com` idú cez Apple relay — je Apple pri preposielaní e-mailov príjemcom/
   sprostredkovateľom?
3. Zrušenie účtu: Apple vyžaduje odvolanie Apple tokenov pri zrušení účtu — uviesť v zásadách a na `/zrusenie-uctu`?
4. Uchovávanie Apple refresh tokenu (šifrovane, iba na odvolanie) — právny základ a lehota.

### 3.2 Platby predplatného (Stripe na webe; neskôr prípadne Google Play / App Store)

1. **Predajca a doklady:** na webe je predajcom Esblu s.r.o. (Stripe = platobná služba). Ak by sa predávalo v obchodoch, je
   predajcom zákazníkovi Google / Apple? Ako to uviesť vo VOP (čl. 12.3 dnes rieši iba správu predplatného v obchode).
2. **Stripe ako sprostredkovateľ alebo samostatný prevádzkovateľ** (Stripe pri platbách vystupuje čiastočne ako samostatný
   prevádzkovateľ — prevencia podvodov, AML)? Úprava zásad (nový účel „platby a fakturácia predplatného“), DPA prílohy, `/subprocessors`.
3. **Kategórie údajov:** meno držiteľa karty, fakturačná adresa, posledné 4 číslice, krajina karty, IP pri platbe; Esblu
   neukladá číslo karty (Stripe Checkout). Zákaznícke ID a ID predplatného v DB Esblu.
4. **Podmienky predplatného (VOP):** automatické obnovovanie mesačne, kde a ako sa vypína (Nastavenia → Predplatné),
   prístup do konca zaplateného obdobia, 7-dňová lehota po neúspešnej platbe, zmena ceny a oznámenie vopred.
   **Nové (schválené vlastníkom 19. 11. 2026, zatiaľ iba v testovacom prostredí):** po riadnom skončení zaplateného obdobia
   (aj po zrušení automatického obnovovania) ponechávame prístup ešte **48 hodín** ako ochrannú lehotu; nevzťahuje sa na
   neúspešnú platbu (tam platí 7-dňová lehota, nesčítavajú sa), na plnú refundáciu, prehraný spor ani na skúšobné obdobie.
   Otázka: je ochranná lehota dobrovoľným plnením bez nároku na úhradu (bez vplyvu na DPH a fakturáciu) a stačí ju uviesť vo
   VOP takto? Návrh znenia — pozri prílohu A nižšie.
5. **Refundácie:** kedy má zákazník nárok (zákonne iba výnimky v B2B?), že **plná refundácia ukončí prístup okamžite**
   (dáta ostávajú, žiadna 48-hodinová lehota), že **čiastočná refundácia prístup nemení**, a že spor (chargeback) môže viesť
   k ukončeniu prístupu.
6. **Spotrebitelia a SZČO:** ak sa predplatné ponúkne spotrebiteľom, odstúpenie od zmluvy (14 dní) a súhlas so začatím
   plnenia pri digitálnej službe; dnes cielime na firmy a SZČO.
7. **Retencia:** účtovné a platobné záznamy (faktúry, `billing_events`) sa nemažú ani pri zrušení účtu — formulácia v zásadách
   a na `/zrusenie-uctu` (dnes uvádza iba finalizované faktúry).
8. **DPA:** treba novú verziu DPA alebo stačí oznámenie zmeny sprostredkovateľov (Resend, Stripe, Apple)?

## Príloha A — návrh znenia do VOP (na posúdenie CLIA, neodoslané, nezverejnené)

> **12.x Skončenie predplatného a ochranná lehota.** Predplatné sa automaticky obnovuje na ďalšie obdobie, kým ho
> Zákazník nezruší v Aplikácii (Nastavenia → Predplatné) alebo v obchode, cez ktorý ho zakúpil. Po zrušení zostáva prístup
> k plateným funkciám zachovaný do konca zaplateného obdobia. Po skončení zaplateného obdobia Poskytovateľ bezodplatne
> ponecháva prístup ešte 48 hodín (ochranná lehota), aby mohol Zákazník predplatné obnoviť bez prerušenia práce. Ochranná
> lehota sa neuplatní pri skúšobnom období, pri vrátení celej platby za aktuálne obdobie, pri úspešne uplatnenej námietke
> platby (chargeback) ani pri ukončení zmluvy z dôvodu porušenia VOP.
>
> **12.y Neúspešná platba.** Ak sa platbu za ďalšie obdobie nepodarí uhradiť, prístup zostáva zachovaný najviac 7 dní od
> prvého neúspešného pokusu, počas ktorých môže Zákazník platobnú metódu aktualizovať. Táto lehota a ochranná lehota podľa
> 12.x sa nesčítavajú. Ak platba nie je uhradená ani v tejto lehote, predplatné sa ukončí a prístup k plateným funkciám
> zanikne.
>
> **12.z Dáta po skončení predplatného.** Skončením predplatného alebo ochrannej lehoty sa dáta Zákazníka nevymazávajú;
> zostávajú uložené a dostupné po obnovení predplatného, kým Zákazník nepožiada o zrušenie účtu alebo firmy podľa čl. … a
> Zásad ochrany osobných údajov. Vrátenie celej platby ukončí prístup okamžite; vrátenie časti platby prístup nemení.

Dopad na ďalšie dokumenty: Zásady (účel „platby a fakturácia predplatného“, doba uchovávania údajov firmy po skončení
predplatného), `/zrusenie-uctu` (zrušenie účtu počas ochrannej lehoty ju prepadá — existujúci text o prepadnutí zvyšku
obdobia doplniť o lehotu). DPA sa nemení (nové spracovanie nevzniká).

## 4. Navrhovaný ďalší postup

1. CLIA posúdi body 1.1 a 1.2 a navrhne znenie (Zásady 1.5, DPA príloha, `/subprocessors`).
2. Vlastník doplní: región a DPA Resend; potvrdenie, či sa Stripe/Apple spúšťajú a kedy.
3. Úpravy produkčných textov nasadíme až po odsúhlasení znenia (nové verzie dokumentov + akceptácia podľa existujúceho procesu).

S pozdravom
Esblu s.r.o.
