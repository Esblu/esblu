# 09 — Release gates (stav 2026-10-11)

## INTERNAL TESTING
| Položka | Stav |
|---|---|
| Signed AAB `esblu-1.0.0-vc1.aab` (com.esblu.app, vc1, 1.0.0, min 24/target 36, nový upload key, nie debug, 64-bit, Firebase, iba produkčný backend, bez secrets) | **READY** |
| Reálne device testy (login, Google login, session, push, chat FAB, dáta) | **READY (PASS)** |
| JDK 21 release tooling | **READY** |
| Store listing texty, ikona 512, feature graphic | **READY (draft na schválenie)** |
| Release notes | **READY** |
| Overenie organizácie + telefónu v Play Console | **ČAKÁ na Google** |
| Create app + Play App Signing + upload | **ČAKÁ na odomknutie účtu** (runbook 08) |
| Data safety, content rating, app access, screenshoty, `/zrusenie-uctu`, assetlinks | **nie sú blocker** pre internal |

## CLOSED TESTING (legal/policy gate)
| Blocker | Vlastník |
|---|---|
| CLIA/GDPR/VOP: privacy policy + subprocessors zosúladené (FCM, OpenAI hlas/text, RPO/RÚZ, retencia dokladov, údaje tretích osôb) | CLIA / vlastník |
| Data safety odoslané (04) — vrátane rozhodnutia „shared" pre OpenAI | vlastník + CLIA |
| `/zrusenie-uctu` live na produkcii (súhlas s deployom) | vlastník |
| App access: reviewer účet + demo firma (03) — zápis do produkcie so súhlasom | vlastník |
| Content rating (IARC), Financial features (05), Advertising ID = No, Target audience (18+ firmy) | vlastník |
| Phone screenshots (min. 2, odporúčané 4–8) z demo účtu | vlastník / ja po capture |

## PRODUCTION
| Gate | Stav |
|---|---|
| CLIA / GDPR / VOP finálne | čaká |
| Privacy policy + Data safety konzistentné | čaká |
| Account deletion URL live | čaká na deploy |
| Production `assetlinks.json` s Play App Signing SHA-256 (+ upload key), legacy `D0:D0:81…` odstránený | čaká na 1. upload + súhlas |
| Play App Signing aktívne | čaká na 1. upload |
| Production prístup (organizačný účet — podmienka 12 testerov/14 dní platí pre osobné účty; overiť v Console) | overiť po odomknutí |
| Rozhodnutie o „nahlásiť AI výstup" | produktové rozhodnutie |
| Finálny smoke test Play-nainštalovanej appky (runbook 10–15) | čaká |
| **Explicitný súhlas vlastníka** s publikáciou | povinné |
