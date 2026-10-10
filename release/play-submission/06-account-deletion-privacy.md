# 06 — Account deletion / privacy / verejné URL

Overené 2026-10-11 (HTTPS GET z produkcie, bez zmeny).

| Položka | Produkcia (www.esblu.com) | Iba `mobile-platform` | Potrebuje |
|---|---|---|---|
| In-app zrušenie účtu (Nastavenia → Zrušiť účet) | **áno** (web aj Android appka, rovnaký server flow `app/api/account/delete`) | — | nič |
| Ochrana finalizovaných dokladov | **áno** — firma s finalizovanými faktúrami: 409, nič sa nezmaže, vysvetlenie + kontakt info@esblu.com (`lib/account-deletion-retention.ts`) | — | nič |
| Verejná stránka zrušenia účtu `/zrusenie-uctu` | **404** | **áno** (SK/EN/DE, bez prihlásenia; in-app postup, rozsah mazania a archivácia = rovnaké texty ako v appke, žiadosť na privacy@esblu.com) | **explicitný súhlas s production deployom** (merge do main + Vercel prod) |
| Privacy policy `/ochrana-osobnych-udajov` (v1.3) | **200** | — | aktualizácia obsahu po CLIA (FCM, hlas/asistent → OpenAI, RPO/RÚZ) |
| Terms `/podmienky-pouzivania` | **200** | — | CLIA/VOP |
| Sprostredkovatelia `/subprocessors` | **200** (Supabase, OpenAI, Vercel, Namecheap) | — | doplniť Google Firebase (FCM) po CLIA |
| Kontakt `/kontakt` | **200** | — | — |
| `/.well-known/assetlinks.json` | **200**, iba **legacy** fingerprint `D0:D0:81…` (kľúč s neznámym heslom) | candidate s novým upload key + placeholder Play | Play App Signing SHA-256 + súhlas s deployom |

## Správanie zrušenia (bez zmien — konzistentné s ochranou dokladov)
- **Owner:** celá firma a jej dáta (súbory zo Storage → DB transakcia → auth identita ako posledná); ostatní členovia strácajú prístup, ich loginy ostávajú.
- **Člen (admin/accountant/employee):** iba vlastná identita a členstvo; firemné dáta ostávajú firme.
- **Blokované:** firma s finalizovanými faktúrami → nič sa nezmaže (žiadne čiastočné deštruktívne mazanie), vysvetlenie + kontakt.

## Čo blokuje Closed/Production
1. `/zrusenie-uctu` live na produkcii (Play „Delete account URL" musí fungovať bez appky).
2. Privacy policy + subprocessors zosúladené s Data safety (CLIA).
3. Formulácia retencie finalizovaných dokladov (CLIA) v privacy policy aj na `/zrusenie-uctu`.
