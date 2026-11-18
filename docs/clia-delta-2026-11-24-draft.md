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
  pozvánky) cez vlastný SMTP poskytovateľa **Resend** z domény `mail.esblu.com`. Dôkaz: DNS záznamy
  `resend._domainkey.mail.esblu.com` (DKIM Resend) a `send.mail.esblu.com` (SPF `amazonses.com`); zapnutie potvrdil vlastník
  v Supabase Dashboarde 17. 11. 2026; potvrdzovací e-mail bol doručený pri teste registrácie v Android appke.
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
5. **Refundácie:** kedy má zákazník nárok (zákonne iba výnimky v B2B?), že **plná refundácia ukončí prístup okamžite**
   (dáta ostávajú), že **čiastočná refundácia prístup nemení**, a že spor (chargeback) môže viesť k ukončeniu prístupu.
6. **Spotrebitelia a SZČO:** ak sa predplatné ponúkne spotrebiteľom, odstúpenie od zmluvy (14 dní) a súhlas so začatím
   plnenia pri digitálnej službe; dnes cielime na firmy a SZČO.
7. **Retencia:** účtovné a platobné záznamy (faktúry, `billing_events`) sa nemažú ani pri zrušení účtu — formulácia v zásadách
   a na `/zrusenie-uctu` (dnes uvádza iba finalizované faktúry).
8. **DPA:** treba novú verziu DPA alebo stačí oznámenie zmeny sprostredkovateľov (Resend, Stripe, Apple)?

## 4. Navrhovaný ďalší postup

1. CLIA posúdi body 1.1 a 1.2 a navrhne znenie (Zásady 1.5, DPA príloha, `/subprocessors`).
2. Vlastník doplní: región a DPA Resend; potvrdenie, či sa Stripe/Apple spúšťajú a kedy.
3. Úpravy produkčných textov nasadíme až po odsúhlasení znenia (nové verzie dokumentov + akceptácia podľa existujúceho procesu).

S pozdravom
Esblu s.r.o.
