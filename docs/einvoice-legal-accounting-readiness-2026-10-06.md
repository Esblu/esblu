# E-Faktúra — technická, právna a účtovná pripravenosť (stav 6. 10. 2026)

Interný podklad pre rozhodnutie o prechode zo sandbox/staging do produkčnej prípravy.
**Nič v tomto dokumente nie je právne ani účtovné stanovisko.** Podklad pre CLIA a otázky pre
CLIA aj účtovníčku: `docs/clia-delta-einvoice-api-partner-2026-10-06.md`. To, že testy prešli, neznamená
právne schválenie. Body v sekciách 2–4 musia potvrdiť uvedené strany písomne.

## 1. Čo technicky overil Esblu (staging `esblu-test` × eFaktura.sk sandbox, syntetické dáta)

| Oblasť | Overenie | Zdroj dôkazu |
| --- | --- | --- |
| Onboarding firmy (POST /organizations, idempotentné podľa IČO) | reálne sandbox | staging E2E 5. 10. |
| Aktivácia príjmu FS kódom: enrolled / neplatný kód / send_only | reálne sandbox (driver), offline testy UI route | staging E2E, `einvoice-reception` |
| Odoslanie A → B: UBL EN 16931 / Peppol BIS 3.0, readiness (BR-49, BR-61), preflight, idempotentné podanie | reálne sandbox | FA20260002, FA20260003 |
| Doručenie: dôkaz poskytovateľa, stav `delivered` | reálne sandbox | outbound evidence |
| Príjem: nemenné XML (SHA-256 = odoslané), koncept na kontrolu, súčty a DPH z XML, ACK | reálne sandbox | inbound B |
| Webhook: HMAC, okno 300 s, dedupe, 409 pri inom tele, replay z portálu bez duplicít | reálne z eFaktura.sk + syntetické negatívne testy | 5. 10. |
| Participant webhooky | pozri report (reálne iba ak bol endpoint prihlásený na `participant.*`) | — |
| Feed udalostí s kurzorom v DB | reálne sandbox (cron route), offline testy | 6. 10. |
| Tenant izolácia (RLS) — owner/admin/admin-fin/accountant/employee/iný tenant | staging (SQL + user JWT), offline | 5.–6. 10. |
| Finalizácia a číslovanie faktúr nemenné | existujúce DB triggre + testy | `einvoice-db`, `einvoice-ui` |

Esblu **neoveroval**: produkčný Peppol (live kľúč), skutočné FS mandáty, doručenie mimo eFaktura.sk
sandboxu, výkonnosť pri objeme, správanie pri výpadku eFaktura.sk dlhšom než retry okno v produkcii.

## 2. Čo musí potvrdiť zmluva / DPA s eFaktura.sk

- Rola eFaktura.sk voči Esblu a voči klientom Esblu (sprostredkovateľ / ďalší sprostredkovateľ /
  samostatný prevádzkovateľ) a právny titul spracúvania údajov v faktúrach.
- Lokalita spracúvania, zoznam subdodávateľov (vrátane Peppol Access Point), prenosy mimo EHP.
- Retencia u eFaktura.sk: dokumentácia uvádza archív 10 rokov a feed udalostí 90 dní — **potvrdiť
  zmluvne**, vrátane toho, čo sa stane s dokladmi po ukončení zmluvy a ako ich klient získa.
- Export a prenositeľnosť (formát, lehoty, poplatky) pri ukončení zmluvy alebo zmene poskytovateľa.
- SLA, incidenty, notifikácia porušenia ochrany údajov, audit.
- Cena a záväzky (program, minimálna mesačná platba) — **nepodpisovať ani neaktivovať bez
  rozhodnutia vlastníka**.

## 3. Čo musí potvrdiť CLIA (právne)

- Rola Esblu: Esblu **nie je** registrovaný sprostredkovateľ na portáli Finančnej správy; klient si
  sám zvolí eFaktura.sk a overovací kód zadá v Esblu. Potvrdiť, že tento model je v súlade
  s pravidlami FS a že Esblu nepreberá povinnosti poskytovateľa e-fakturácie.
- Zmluvné podmienky Esblu a DPA s klientmi (Esblu ako sprostredkovateľ klienta; eFaktura.sk ako
  ďalší sprostredkovateľ alebo samostatný vzťah klienta) — doplnenie do VOP/DPA a informácie o
  spracúvaní.
- Zodpovednosť pri chybnom doručení, oneskorení, odmietnutí dokladu sieťou.
- Text súhlasu v UI („potvrdzujem, že som v portáli FS zvolil eFaktura.sk…“) — postačuje?
- Prenos FS overovacieho kódu: Esblu ho neukladá; potvrdiť, že jednorazové odovzdanie
  poskytovateľovi je v súlade s podmienkami FS.

## 4. Čo musí potvrdiť slovenská účtovníčka

- Prijatý doklad v Esblu vzniká ako **koncept** z nemenného XML; potvrdiť, že účtovný doklad je XML
  (nie vizualizácia v Esblu) a postup kontroly / finalizácie konceptu.
- Automaticky založený dodávateľ (IČO, DIČ, IČ DPH z XML) — potvrdiť, že ho možno použiť bez ručnej
  kontroly, alebo vyžadovať kontrolu pri prvom doklade.
- Dátumy (dodanie, DUZP, splatnosť), zaokrúhlenie, rozpis DPH podľa XML — potvrdiť, že mapovanie na
  účtovné polia Esblu je správne pre bežné prípady (S, Z, E, AE, K, G, O).
- Prijaté opravné doklady (dobropis, ťarchopis) — koncept v review, prijatie až po kontrole (`20261008100005`);
  potvrdiť postup kontroly.
- Prijaté faktúry k prijatej platbe (UBL 386) a konečné faktúry s odpočítanými zálohami (BT-113) — evidencia
  a párovanie záloh s kontrolou (`20261008100008`). Esblu **nerozhoduje** o nároku na odpočet DPH zo zálohy;
  potvrdiť postup a slovenský profil 386 (stále REVIEW).
- Číslovanie a nemennosť vydaných faktúr (Esblu číslovanie pri finalizácii, nemenný snapshot).

## 5. Uchovávanie, export, archivácia

| Údaj | Kde | Stav |
| --- | --- | --- |
| Odoslané / prijaté UBL XML | Esblu privátny bucket `einvoice-documents` (nemenné, SHA-256) | uložené; retenčná politika Esblu pre E-Faktúru **nie je finálna** |
| Doklad v sieti / archív | eFaktura.sk | podľa dokumentácie 10 rokov — potvrdiť zmluvne |
| Udalosti (webhook/feed) | Esblu: iba hash tela + stav; eFaktura.sk feed 90 dní | v poriadku pre prevádzku, nie archív |
| Export pre klienta | Esblu: stiahnutie XML jednotlivo | hromadný export **nie je** implementovaný |

**Esblu zatiaľ nesľubuje zákonný dlhodobý archív dokladov.** Kým nebude potvrdená retencia
(eFaktura.sk zmluva + vlastná politika Esblu + export), UI ani marketing nesmú tvrdiť, že Esblu
nahrádza zákonnú archiváciu.

## 6. Rola Esblu vs. eFaktura.sk (technický stav, nie právny záver)

- **Esblu:** vystaviteľský softvér klienta — vytvorí faktúru, vygeneruje UBL z nemenného snapshotu,
  odovzdá ju poskytovateľovi; prijaté XML uloží a pripraví koncept. Neuchováva FS overovací kód ani
  API kľúče v DB. Nie je Peppol Access Point.
- **eFaktura.sk:** poskytovateľ e-fakturácie / prístup do Peppolu (partner API), registrácia
  účastníka v SMP, doručenie, dôkaz doručenia, archív podľa jeho podmienok.

## 7. Čo blokuje prechod do produkčnej prípravy

1. Zmluva + DPA s eFaktura.sk (sekcia 2) a rozhodnutie o programe — rozhodnutie vlastníka.
2. CLIA stanovisko (sekcia 3) a úprava VOP/DPA Esblu.
3. Potvrdenie účtovníčky (sekcia 4).
4. Retenčná politika a export (sekcia 5).
5. Bezpečnosť Vercel Preview env — produkčný service_role / OpenAI v Preview
   (`docs/security-vercel-preview-env-audit-2026-10-06.md`) — vyžaduje súhlas.
6. Produkčné migrácie E-Faktúry a SK súladu fakturácie (20261002… až 20261008100008) — nespustené,
   vyžadujú súhlas. Právno-účtovný audit: `docs/einvoice-sk-accounting-legal-audit-2026-10.md`.
7. Produkčný kľúč eFaktura.sk, produkčné webhook URL a secret — po bodoch 1–3.
