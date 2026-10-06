# Účtovný a eFaktúra tok — dokončenie a staging E2E (6. 10. 2026)

Interný technický podklad. Nie je to právne ani daňové stanovisko. Vetva `einvoice-port`; migrácie
`20261008100005` – `20261008100007` sú iba na stagingu `esblu-test`. Produkcia, `main`, produkčné
migrácie, produkčné secrets ani live eFaktúra sa nemenili.

## 1. Implementované

| Oblasť | Čo |
| --- | --- |
| Prijaté opravy (Peppol) | CreditNote 381 / 81 → dobropis, 83 → dobropis s `CORRECTION_TYPE_REVIEW`, Invoice 383 → ťarchopis; 396, 532 a 384 → manuálne (XML uložené, bez konceptu). Koncept opravy vždy v stave `review`, nič sa neaplikuje automaticky. Väzba BT-25 (+ BT-26) iba v rámci firmy a dodávateľa; inak dôvod `ORIGINAL_REFERENCE_MISSING` / `ORIGINAL_NOT_FOUND` / `ORIGINAL_AMBIGUOUS`. Ak oprava príde pred originálom, prepojí sa pri vzniku konceptu originálu (`20261008100007`). Prijatie = finalizácia (finance.manage), zamietnutie = RPC s dôvodom, ručné prepojenie = RPC. |
| Ochrana | DB guard každej väzby `corrects_invoice_id` (firma, smer, dodávateľ, cieľ nie proforma ani oprava); review polia klient nemení; replay/duplicita podľa SHA-256 XML, transport ID a (dodávateľ, druh, číslo). |
| Úhrady | stavy `unpaid` / `partially_paid` / `paid` / `overpaid`; vrátenie platby; saldo skupiny = originál − zálohy + ťarchopisy − dobropisy − (platby − vrátenia); prepočet pri úhrade, vrátení, finalizácii opravy aj konečnej faktúry; platba nemení obsah dokladu; na dobropis ani proformu sa platba neeviduje. |
| Zálohy | proforma (PF, nedaňový), faktúra k prijatej platbe (FA, 386), konečná faktúra s odpočtom jednej či viacerých záloh; ponuka dostupných záloh so zostatkom; zámok záloh pri finalizácii, limit základu, DPH aj celkovej sumy → tú istú zálohu nemožno odpočítať dvakrát; odoslanie faktúry k platbe ako e-faktúry (`20261008100006`). |
| UI | panel „Účtovný tok dokladu“: typ dokladu (nedaňový / daňový k platbe / konečný / opravný), review prijatej opravy s akciami, odpočet záloh, saldo, vrátenie; stav „Preplatená“; PDF konečnej faktúry s odpočtom záloh a sumou na úhradu. Chyby iba preložené podľa kódu, nikdy surový JSON. |
| Export | balík za obdobie (server-side, user JWT + RLS, finance.manage, explicitný filter firmy, nič sa neukladá): vydané, prijaté, opravy, faktúry k platbe, proformy v `proforma/`, XML (overený SHA-256), PDF, `metadata.json`, súhrnné CSV (doklady + saldo, úhrady, partneri, DPH, opravy, odpočty záloh, audit). |
| Regresie | `test:plan-entitlements` 46/47 → 47/47 (príčina: regex `\n` na súbore s CRLF v pracovnom strome; oprava `\r?\n`). Lint `InvoiceDetailView.tsx`, `faktury/page.tsx`, `faktury/new/page.tsx` (react-hooks/immutability: efekt pred deklaráciou `init`) → efekt presunutý za deklarácie; zostávajú iba 2 staré warningy (nepoužité importy). |

## 2. Staging E2E A–M

Reálny sandbox eFaktura.sk (partner API) × staging `esblu-test`, syntetické firmy E2E A → B, cez
staging driver na Preview (`einvoice-port`, guard: iba staging DB a sandbox kľúč). Úkony používateľa cez
skutočné user JWT (PostgREST + RLS), odoslanie cez skutočnú route `/api/einvoice/outbound` a cron
`/api/cron/einvoice-outbound`, príjem cez cron `/api/cron/einvoice-events` (feed poskytovateľa), export cez
skutočnú route `/api/accounting-handoff/package`.

| | Scenár | Výsledok | Typ |
| --- | --- | --- | --- |
| A | vydaná faktúra FA20260004 → odoslaná → B koncept → B finalizuje | PASS | reálny provider |
| B | faktúra k prijatej platbe FA20260005 (386) | PASS po oprave `20261008100006` (pred ňou `ESBLU_EINVOICE_KIND_UNSUPPORTED`); u B vznikne bežná faktúra s `INVOICE_TYPE_CODE_UNUSUAL` | reálny provider; príjem 386 = GAP |
| C | konečná faktúra FA20260006 so zálohou (PrepaidAmount) | vydanie, saldo (369 − 123 = 246) a odoslanie PASS; duplicitný odpočet tej istej zálohy odmietnutý (`ESBLU_ADVANCE_DEDUCTION_EXCEEDS`); u B `UNSUPPORTED_PROFILE` (PrepaidAmount) → manuálne | reálny provider; príjem = GAP |
| D | vydaný dobropis DO20260001 | PASS (odoslaný, 381) | reálny provider |
| E | vydaný ťarchopis ID20260001 | PASS (odoslaný, 383) | reálny provider |
| F | prijatá bežná e-faktúra | PASS (koncept, ACK, finalizácia B) | reálny provider |
| G | prijatý dobropis | PASS: koncept v review; prvé spracovanie skôr než originál → `ORIGINAL_NOT_FOUND` → odhalené, opravené `20261008100007`; ručné prepojenie + prijatie PASS; druhý beh DO20260003 sa prepojil automaticky | reálny provider (+ syntetický test poradia) |
| H | prijatý ťarchopis | PASS (review → prepojenie → prijatie, saldo +12,30) | reálny provider |
| I | duplicitný webhook/feed | PASS: 16 udalostí znovu → 16× `DUPLICATE`, počet dokladov B 9 → 9 | reálny provider (replay feedu) |
| J | oprava bez nájdeného originálu (DO20260002, originál neodoslaný) | PASS: review `ORIGINAL_NOT_FOUND`, prijatie odmietnuté | reálny provider |
| K | cross-tenant | PASS: B → prepojenie na doklad A `ESBLU_CORRECTED_INVOICE_NOT_FOUND`; A → oprava B `ESBLU_INVOICE_NOT_FOUND`; A nevidí saldo ani doklady B (0 riadkov) | reálne user JWT |
| L | úhrady a saldo | PASS: A 233,70 na úhradu (246 − 24,60 + 12,30) → čiastočná → uhradená → preplatená → vrátenie → uhradená; B saldo 233,70 → uhradená; záloha uhradená | reálne user JWT |
| M | export celého prípadu | PASS: A 12 dokladov, 42 súborov (10 XML, 12 PDF, 7 CSV), SHA-256 balíka sedí; B 3 finalizované prijaté (originálne XML), koncepty vynechané | reálna route |

Úprava stagingu počas E2E: rollout E2E firiem dočasne `internal`, po teste znovu `paused`; driver
`ESBLU_STAGING_E2E_ENABLED=false`, `ESBLU_STAGING_E2E_SECRET` zmazaný, Protection Bypass zrušený.

## 3. Testy (offline)

`test:invoicing-flow` 21 (nový; syntetické UBL označené v súbore): prijatý dobropis/ťarchopis, oprava bez
originálu, oprava pred originálom, cross-tenant väzba, duplicita, nepodporované typy, nemenné XML, úhrady
(čiastočná, preplatok, vrátenie), dobropis/ťarchopis v salde, role, proforma, záloha, duplicitný odpočet,
limity, export tenant izolácia a statická kontrola route, odoslanie 386. Ostatné sady bez chýb (sekcia 4 reportu).

## 4. GAP / blokery

Technické: príjem faktúry k prijatej platbe (386) ako `payment_received_invoice`; príjem konečnej faktúry
s PrepaidAmount (dnes manuálne); prijaté zálohy a ich odpočet na strane príjemcu;
naplánovanie cronu kurzov ECB a e-faktúry v produkcii;
produkčné migrácie `20261002…` – `20261008100007`.

Právne (bez zmeny): kvalifikácia XML ako účtovného dokladu, vnútorný kontrolný systém, 386 v slovenskej
podzákonnej norme, kód 83 (finančná úprava), archív a zmluva s eFaktura.sk, CLIA.
