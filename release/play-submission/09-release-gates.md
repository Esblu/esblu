# 09 — Release gates (aktualizované 2026-10-11, po real-device QA nástenky)

**Legenda:**

| Štítok | Význam |
|---|---|
| **READY** | hotové a overené |
| **PENDING USER** | čaká na rozhodnutie alebo úkon vlastníka |
| **PENDING GOOGLE** | čaká na Google (overenie účtu, Play App Signing) |
| **PENDING LEGAL** | čaká na CLIA/GDPR/VOP |
| **NOT BLOCKING INTERNAL** | pre Internal testing netreba (rieši sa pred Closed alebo Production) |

## INTERNAL TESTING — readiness matrix

| Položka | Stav | Poznámka |
|---|---|---|
| AAB | **PENDING USER** | `esblu-1.0.0-vc1.aab` je podpísaný a overený, ale je postavený z `main` @ 901c46c, teda **pred** prijatou nástenkou, vrstvením Viac/Chat a hlasovým hardeningom. Na interné testovanie aktuálneho stavu treba **nový AAB vc2 z `mobile-platform`** (`release/build-release-aab.ps1`, `-PesbluVersionCode=2`). Produkčný AAB volá produkčné API (`main`). Rozdiel `main..mobile-platform` v `app/api` je malý a spätne kompatibilný (preflight/delete: nové voliteľné polia; transcribe: 503 bez kľúča), takže vc2 funguje aj proti dnešnému `main`. Rozhodnutie vlastníka: vc1 (starý UI) alebo vc2 |
| Signing (upload key) | **READY** | upload key SHA-256 `51:83:9A:…:6B:11:BA`, keystore mimo repa, `verify-release-aab.py` PASS |
| Play App Signing | **PENDING GOOGLE** | aktivuje sa pri 1. uploade (runbook 08) |
| Overenie Google účtu (organizácia + telefón) | **PENDING GOOGLE** | |
| Device QA (login, Google login, session, push, dáta) | **READY** | real-device PASS (predchádzajúci blok) |
| Dashboard QA (valec, Viac/Chat vrstvenie, FAB, návrat fokusu) | **READY** | real-device PASS na `cf20ffc` |
| Hlas — natívne QA | **PENDING USER** | checklist A1–A22 v `10-voice-qa.md` na staging builde z tohto commitu (nové: offline/503/Settings návrat) |
| Hlas — AI | **READY (harness)** / **PENDING USER (živý prepis)** | `test:voice-e2e` 47/47 (navigácia, čítanie, zápis + potvrdenie + duplicita, nejasnosti, kritické). Živý prepis: staging má AI vypnutú. Voliteľne read-only P1–P10 na produkcii, iba vlastník |
| Screenshoty | **NOT BLOCKING INTERNAL** | plán 8 kusov v `02-play-assets.md` §2. Capture až z Play-nainštalovanej appky na demo účte |
| Reviewer účet | **NOT BLOCKING INTERNAL** / **PENDING USER** | balík v `03-app-access-reviewer.md`. Zápis do produkcie (allowlist + demo firma + granty) iba so súhlasom |
| App access (Play Console text) | **NOT BLOCKING INTERNAL** | text pripravený (03 §6) |
| Data Safety draft | **NOT BLOCKING INTERNAL** / **PENDING LEGAL** | `04-data-safety.md`. Rozhodnutie „shared" pre OpenAI. `ACCESS_NETWORK_STATE` (teraz explicitne v manifeste, predtým iba cez Firebase merge) Data Safety nemení |
| Financial features draft | **NOT BLOCKING INTERNAL** / **PENDING USER** | `05` — odporúčané „no financial features" |
| Store listing SK/EN | **READY (draft)** / **PENDING USER** | schválenie textov |
| Ikona 512 | **READY** | |
| Feature graphic | **PENDING USER** | výber svetlý (pôvodný) alebo **tmavý** (nový draft, zladený s appkou) |
| Release notes 1.0.0 | **READY** | |

**Záver pre Internal testing:** technicky pripravené. Blokujú iba Google (overenie účtu + Play App Signing) a rozhodnutie vlastníka **vc1 vs. vc2** (odporúčanie: vc2 z `mobile-platform`, aby testeri videli prijatú nástenku a hlasový hardening).

## CLOSED TESTING (legal/policy gate)

| Blocker | Stav |
|---|---|
| Privacy policy + subprocessors (FCM, OpenAI hlas/text, RPO/RÚZ, retencia, údaje tretích osôb) | **PENDING LEGAL** |
| Data Safety odoslané (vrátane OpenAI „shared") | **PENDING LEGAL** + **PENDING USER** |
| `/zrusenie-uctu` live na produkcii | **PENDING USER** (deploy) |
| Reviewer účet + demo firma + granty (03) | **PENDING USER** (súhlas so zápisom do produkcie) |
| Content rating (IARC), Financial features, Advertising ID = No, Target audience 18+ | **PENDING USER** |
| Phone screenshots 6–8 (02 §2) | **PENDING USER** (capture z demo účtu) |
| Hlas v produkcii: živý prepis overený (P1–P10) alebo hlas pre reviewera vypnutý | **PENDING USER** |

## PRODUCTION

| Gate | Stav |
|---|---|
| CLIA / GDPR / VOP finálne | **PENDING LEGAL** |
| Privacy policy ↔ Data Safety konzistentné | **PENDING LEGAL** |
| Account deletion URL live | **PENDING USER** |
| `assetlinks.json` s Play App Signing SHA-256 (+ upload key), legacy `D0:D0:81…` preč | **PENDING GOOGLE** (po 1. uploade) + **PENDING USER** |
| Production prístup (podmienky pre organizačný účet overiť v Console) | **PENDING GOOGLE** |
| „Nahlásiť AI výstup" — produktové rozhodnutie | **PENDING USER** |
| Merge `mobile-platform` → `main` + produkčný deploy (server-side časti tohto bloku) | **PENDING USER** |
| Finálny smoke test Play-nainštalovanej appky | **PENDING USER** |
| Explicitný súhlas vlastníka s publikáciou | **PENDING USER** (povinné) |
