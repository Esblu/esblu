# E-mail pre eFaktura.sk — otvorené otázky pred produkčným spustením (7. 10. 2026)

**Stav:** pripravené na odoslanie, NEODOSLANÉ. Odosiela vlastník.
**Komu:** sales@efaktura.sk · **Kópia:** podpora@efaktura.sk
**Neobsahuje** kľúče, tokeny, interné ID ani údaje klientov.

Rekonštrukcia: P1, P2, P3, P4, P5b, P5c, P10, P11, P12, P13, P15, P17, P18 z
`docs/einvoice-production-provider-checklist.md` — žiadna nemá odpoveď. Vynechané ako zodpovedané/overené:
replay toho istého `Idempotency-Key` hneď po stratenej odpovedi (sandbox: rovnaká odpoveď, žiadne nové
podanie), `/peppol/status` končí `SENT` a doručenie nesie `evidence.delivery_status`, P8/P9 (používame feed
`/v1/agent/events`), formát a replay webhookov (overené v sandboxe).

---

**Predmet:** Esblu — API partner (Agent API): otázky pred produkčným spustením

Dobrý deň,

v Esblu sme dokončili integráciu Agent API v sandboxe (organizácie, enroll, odoslanie, príjem, webhooky aj
feed `/v1/agent/events`). Pred podpisom zmluvy a produkčným spustením potrebujeme potvrdiť nasledujúce body.
Odpovede z dokumentácie, ktoré už máme, neopakujeme.

**1. Opakované odoslanie a idempotencia (`POST connector/send`)**
1. Ako dlho platí `Idempotency-Key` (TTL) a v akom rozsahu (organizácia alebo API kľúč)? Náš worker
   opakuje ten istý kľúč najviac 8× počas približne 2 hodín.
2. Čo vráti replay s rovnakým kľúčom, kým prvý request ešte beží (409, čakanie, alebo dve spracovania)?
3. Dá sa podanie dohľadať podľa `Idempotency-Key` alebo našej referencie bez opätovného odoslania?
4. V sandboxe replay po stratenej odpovedi vrátil rovnakú odpoveď a nové podanie nevzniklo.
   Platí to rovnako v produkcii?

**2. Retry po chybe alebo neistom výsledku**
1. Je `ERROR` v `/peppol/status` vždy terminálny? Môže nastať aj po tom, čo sieť dokument prevzala?
2. Je po `ERROR` číslo dokladu (`cbc:ID`) u vás „obsadené“? Je správnou cestou nové `connector/send`
   s novým kľúčom, alebo `POST /v1/agent/peppol/send/{invoiceId}`?
3. Je `evidence.delivery_status.state = rejected` (odmietnutie po AS4) konečný stav? Smie integrátor poslať
   opravený doklad znova?

**3. Identifikátor dokumentu**
1. Ktorý identifikátor je stabilný a jednoznačný pre odoslaný dokument (`invoiceId` / `document_id`)?
   Je vždy prítomný v udalostiach feedu a webhookov (`sent.*`, `delivered`)?
2. Kolidujú čísla dokladov vystavených v Esblu s číslami, ktoré tá istá firma vystavila priamo
   v aplikácii eFaktúra?

**4. Zmluvná rola a ochrana údajov**
1. Akú rolu má eFaktura.sk voči Esblu a voči klientom Esblu (sprostredkovateľ, ďalší sprostredkovateľ,
   samostatný prevádzkovateľ / poskytovateľ doručovacej služby)? Aké DPA navrhujete?
   Prosíme o presný názov, IČO a sídlo zmluvnej strany.
2. Kde sa údaje spracúvajú (krajina, cloud, zálohy)? Aký je zoznam subdodávateľov vrátane Peppol Access
   Pointu? Dochádza k prenosu mimo EHP?
3. Platí 10-ročný archív aj pre odoslané doklady? Čo sa stane s dokladmi po ukončení zmluvy s Esblu
   alebo po deaktivácii klientskej firmy?
4. Ako získame export dokladov a dôkazov o doručení pri ukončení služby (formát, lehota, poplatok)?
   Ostávajú po `peppol/deactivate` prijaté doklady dostupné cez API a ako dlho?

**5. Produkčný onboarding — prosíme o potvrdenie postupu**
1. Postup: žiadosť o produkčný prístup v portáli → zmluva → live kľúč (zobrazí sa raz) → registrácia
   partner webhooku v portáli. Je to všetko, alebo je potrebný ďalší krok (NDA, schválenie, KYC)?
2. Máme správne, že pre live je povinný enroll cestou B s overovacím kódom z portálu Finančnej správy?
   Overovací kód zadá klient v Esblu. Esblu nie je na PFS vedené ako sprostredkovateľ.
3. Aké scope má partnerský live kľúč? Je možné vydať kľúč s minimálnymi scope?
4. Akú hodnotu má `data.mode` vo webhookoch v produkcii?
5. Aké máte SLA, technický kontakt pre incidenty a status page?

**6. Cena a okamih vzniku poplatku**
1. Aký je aktuálny produkčný cenník po 30. 11. 2026 (cena za transakciu, minimum, mesačný alebo ročný
   program)?
2. Kedy začína plynúť poplatok: podpisom zmluvy, vygenerovaním live kľúča, prvou organizáciou, alebo
   prvou transakciou? Účtuje sa minimum aj v mesiaci bez transakcií?

Ďakujeme. Ak je jednoduchšie prejsť body na krátkom hovore, radi sa prispôsobíme.

S pozdravom

Jaroslav Juriš
konateľ
Esblu s. r. o.
info@esblu.com
