# 05 — Financial features declaration

Zdroj: [Provide information for the Financial features declaration](https://support.google.com/googleplay/android-developer/answer/13849271) (overené 2026-10-11). Deklarácia je povinná pre každú appku na closed/open/production tracku, aj keď nemá finančné funkcie.

## Kategórie podľa Play a Esblu
| Play kategória | Položky | Esblu? | Dôvod |
|---|---|---|---|
| Banking and loans | Personal loan direct lender, Loan facilitator, Payday loans, Banking, Line of credit, Earned wage advances, Microfinance banking | **Nie** | žiadne úvery, žiadne bankové účty/služby |
| Payments and transfers | Mobile payments and digital wallets, Money transfer and wire services | **Nie** | appka neiniciuje ani nevykonáva platby/prevody; „evidencia úhrad" = ručný záznam používateľa; IBAN je iba údaj na faktúre (žiadne napojenie na banku, žiadny platobný príkaz) |
| Purchase agreements | Rewards/points, Buy now pay later | **Nie** | |
| Trading and funds | Crypto wallet/exchange, NFT, Stock trading, Crowdfunding | **Nie** | |
| Support services | Credit monitoring, Financial advice, Insurance, **Other** | **Nie** (Other — viď nižšie) | Esblu neposkytuje finančné poradenstvo ani poistenie; poistky vozidiel sú iba evidencia dokumentov |

## Odporúčaná odpoveď
**„My app doesn't provide any financial features."**

Reasoning: Play definícia „financial features" sa týka finančných **služieb** (poskytovanie úverov, platieb, prevodov, obchodovania, poradenstva, poistenia). Esblu je evidenčný a fakturačný nástroj firmy — vystavuje doklady a eviduje ich stav, ale nepohybuje peniazmi, nemá prístup k bankovým účtom a neposkytuje finančnú službu. Invoicing/bookkeeping nie je v zozname Play kategórií.

Riziko / alternatíva: ak by Google počas review považoval fakturáciu za finančnú funkciu, jediná vhodná voľba je **Support services → Other** s popisom „Business invoicing and record-keeping for the user's own company; no payments, transfers, lending or financial advice." — pripravené ako fallback, nepoužiť vopred.

## Kontrola v Console po odomknutí
1. Policy and programs → App content → Financial features → Start.
2. Overiť, že zoznam kategórií je stále rovnaký ako vyššie (Google ho mení).
3. Zvoliť „My app doesn't provide any financial features" → Save.
4. Ak Console zobrazí nové kategórie (napr. invoicing/accounting), **zastaviť** a prehodnotiť.
5. Rozhodnutie potvrdzuje vlastník (nie automaticky).
