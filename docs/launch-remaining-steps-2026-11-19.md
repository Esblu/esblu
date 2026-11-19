# Esblu — zostávajúce kroky pred ostrým spustením (stav 19. 11. 2026)

Východisko: produkcia web + DB beží od 11. 11. 2026 (release J10.2), verejná registrácia od 17. 11., Android 1.0.1 (vc4)
v internom testovaní, ostrý koncept pripravený (neodoslaný). Billing aj eFaktúra sú v produkcii **vypnuté**.
Vetva `android-release-payments-ios-2026-11-18` @ `729de27` (Preview READY, billing vypnutý). Produkcia sa v tejto vetve nemenila.

Značky: **V** = vlastník, **A** = agent (po súhlase), **CLIA**, **Ú** = účtovníčka, ⛔ = produkčný zásah, iba s výslovným súhlasom.

## 1. Právne podklady (CLIA, termín 24. 11. 2026)

| # | Krok | Kto | Podklad |
|---|---|---|---|
| L1 | Skontrolovať a odoslať návrh správy CLIA (Resend, Google login v appke, dátumy `/subprocessors`, Apple, platby, refundácie, DPA) | V | `docs/clia-delta-2026-11-24-draft.md` |
| L2 | Doplniť do správy: dátum prvého odoslania cez Resend (Resend → Emails / Domains `mail.esblu.com`), región odosielania a DPA Resend; priložiť snímku SMTP nastavení z 18. 11. | V | § 1.1 návrhu |
| L3 | Doplniť otázky k zisteniam z testov predplatného: plná refundácia aktuálneho obdobia = okamžitý koniec prístupu aj predplatného; refundácia staršej faktúry prístup nemení; zrušenie = prístup do konca obdobia (+ technická 2-dňová poistka); čiastočná refundácia bez zmeny | A → V | `stripe-test-and-reconciliation-2026-11-18.md` § 8.5, § 8.6 |
| L4 | Po stanovisku: Zásady 1.5 (Resend, Google v appke, Stripe ako príjemca, platby), DPA príloha sprostredkovateľov, `/subprocessors` (zjednotiť dátumy), `/zrusenie-uctu` (retencia `billing_events` a faktúr) | CLIA → A | nové verzie `legal_documents` + akceptácia |
| L5 | VOP: podmienky predplatného (automatická obnova, zrušenie, 7-dňová lehota po neúspešnej platbe, refundácie, zmena ceny), predajca pri obchodoch | CLIA → A | návrh § 3.2 |
| L6 | Oznámenie zákazníkom o nových sprostredkovateľoch (Resend, Stripe; neskôr eFaktura.sk) podľa DPA — lehota (D-15?) | CLIA → V | DPA 1.3 |
| L7 | Smernica v1.0 — schválenie a dátum účinnosti; DPA 1.3 prijať vo vlastnej firme | V | J10.1 owner actions |

## 2. Android — verejné vydanie

| # | Krok | Kto |
|---|---|---|
| AN1 | App access: vložiť text 6B a heslo kontrolórskeho účtu | V |
| AN2 | Data safety: bez zmeny (pripravené odpovede v `04-data-safety.md`); po L4 overiť, či netreba doplniť Resend/Stripe | V |
| AN3 | Voliteľne EN záznam v obchode (text v `01-store-listing.md` C) | V |
| AN4 | Rozhodnutie: odoslať pred alebo po úprave Zásad (Google login v appke, Resend) — odporúčanie: po L4 | V + CLIA |
| AN5 | ⛔ Odoslať ostré vydanie 1.0.1 (SK) na kontrolu | V |
| AN6 | Final full smoke (checklist K) na zariadení z Play | V + A |

## 3. Predplatné (Stripe na webe)

Hotové: testy v Stripe sandboxe (nákup, obnova, zlyhanie, refundácie, zrušenie, dve karty, reconciliation) — PASS.

| # | Krok | Kto |
|---|---|---|
| S1 | ~~Rozhodnúť o rezerve~~ — **schválené 19. 11.: 48 h ochranná lehota** po riadnom skončení; migrácia `20261119100000` na stagingu, testy PASS (`stripe-test-and-reconciliation` § 8.8); produkcia spolu s S4 | — |
| S2 | Účtovníčka: 12 otázok (DPH § 7a, Stripe poplatky, doklady) + vzor mesačného párovania | V → Ú | `payment-channels-economics-2026-11-18.md` § 6 |
| S3 | ⛔ Merge vetvy do `main` (kód billing ostáva vypnutý flagmi) | V |
| S4 | ⛔ Produkčné migrácie `20261118120000`, `20261118130000`, `20261118140000`, `20261119100000`, `20261119110000`, `20261119120000` (záloha + dump, po jednej, rollback súbory v repe) | V súhlas → A |
| S5 | ⛔ Stripe live účet (Esblu s.r.o., overenie firmy, SEPA), produkt + cena 15,90 €/mes., Billing Portal, daňové nastavenia (§ 7a, OSS ak B2C) | V |
| S6 | ⛔ Vercel production: `STRIPE_SECRET_KEY` (restricted live), `STRIPE_WEBHOOK_SECRET`, `ESBLU_BILLING_MODE`, `ESBLU_BILLING_RETURN_ORIGIN`, `CRON_SECRET` pre reconciliation; webhook endpoint v Stripe (10 udalostí) | V |
| S7 | ⛔ Prod DB: `billing_provider_prices` (live cena), `billing_runtime_config.web_provider='stripe'`, `environment='live'` | V súhlas → A |
| S8 | ⛔ Cron reconciliation v `vercel.json` (dnes zámerne vypnutý) | V súhlas → A |
| S9 | ⛔ `NEXT_PUBLIC_ESBLU_BILLING_UI=1` až po L5 (VOP) a interný nákup vlastnou kartou + refund | V |
| S12 | ~~Chýbajúce webhooky~~ — **implementované 19. 11.** (doťahovanie `/v1/events` + reconciliation platby aktuálnej faktúry + crony); staging DB testy PASS; zostáva overenie so živým sandboxom a produkčné migrácie (S4) | A / V |
| S13 | ~~Ukončenie k zvolenému dátumu~~ — **implementované 19. 11.** (`scheduled_end_at`, bez 48 h); overiť `cancel_at` v sandboxe | A / V |
| S14 | ~~Manifest grantov~~ — **hotové 19. 11.** (`registration_policy`, nové tabuľky/funkcie; ACL v DB bez zmeny) | — |
| S15 | **Live režim Stripe (pred ostrým billingom):** provider s očakávaným `livemode` podľa prostredia, `ESBLU_BILLING_MODE=stripe_live` iba v produkcii, DB `environment=live` (config, ceny, kurzor), testy oddelenia sandbox ↔ live (`stripe-test-and-reconciliation` § 8.11) | A (po súhlase) |
| S16 | Overenie S12/S13 so skutočným sandboxom (minimum, bez nových predplatných): okno 1 `-NoListen`, `s12-events`, `s12-catchup`, `verify-terminal`, `s13-existing` (§ 8.12); potom staging `web_provider=none` | V → A |
| S10 | Monitoring: alert na `billing_events` s chybou, `dead_letter` v reconciliation | A |
| S11 | Upratanie Stripe sandboxov: zrušiť predplatné C v pôvodnom sandboxe (príkaz v § 8.7), potom `stripe sandboxes delete` | V |

## 4. eFaktúra (Peppol, eFaktura.sk) — brána G1–G12 (`einvoice-production-gate-2026-11-12.md`)

| # | Krok | Kto | Stav |
|---|---|---|---|
| E1 | G1 partnerská zmluva s eFaktura.sk vrátane Prílohy 2 (DPA), program, úhrada | V | OPEN |
| E2 | G2 live API kľúč `efk_pk_live_…` iba ako Vercel sensitive env production | V | OPEN |
| E3 | G3 DPA/GDPR: eFaktura.sk ako sprostredkovateľ v Zásadách, DPA, `/subprocessors`, smernici; transfery | CLIA | OPEN — pridať do správy CLIA (L1/L4) |
| E4 | G4 oznámenie sprostredkovateľa D-15 pred aktiváciou | V | OPEN |
| E5 | G5 Vercel WAF rate-limit pre `/api/einvoice/webhook` (návrh 600/60 s) | V súhlas → A | KÓD HOTOVÝ, WAF OPEN |
| E6 | G6 reálne HTTP doručenie webhooku na Preview | A | API PASS 26 + PARTIAL 1; Preview HTTP testy PASS 13. 11. — uzavrieť dokumentačne |
| E7 | G10 písomné stanovisko účtovníčky (koncept ≠ zaúčtovanie, doručenie vs. úhrada, archivácia, dobropisy/zálohy) | Ú | OPEN |
| E8 | G11 cenník eFaktúry a nákladový model partnera (od 1. 12. 2026 sadzba/tx + min. 10 €/mes.) | V | OPEN |
| E9 | Otvorené nálezy review: M1 operátorský postup `RECIPIENT_MISMATCH`, G1 export histórie `einvoice_events`, S3 index `body_sha256` | A | OPEN |
| E10 | ⛔ G12 písomný pokyn „aktivuj produkčný eInvoice“ → env, redeploy, rollout iba internej firme, pilot | V | OPEN |

## 5. iOS (samostatná fáza)

| # | Krok | Kto |
|---|---|---|
| I1 | D-U-N-S → Apple Developer (organizácia, 99 $/rok) | V |
| I2 | Implementácia: odvolanie Apple tokenu pri zrušení účtu, manuálne prepojenie identít | A |
| I3 | Podpisovanie + build (Codemagic/Mac), TestFlight, App Privacy, Sign in with Apple | V + A |

## 6. Prevádzka a upratanie

| # | Krok | Kto |
|---|---|---|
| P1 | Po pushi: lokálny worktree opravený (cesty `.git`, zámky, vetva = `729de27`); ďalšie worktree so sandboxovými cestami (`checklist-reconcile`, `einvoice-port-recovery`, `j10-clia`, `mobile-platform`, `preprod-release-candidate`, `rc-product`) a staré zámky `j10-clia` — opraviť rovnako alebo `git worktree prune` po kontrole | V / A |
| P2 | Vercel Preview premenné vetvy (billing off) zmazať po merge | V |
| P3 | Retenčná purge (`ESBLU_GDPR_RETENTION_PURGE_ENABLED`) — schváliť prvý beh | V |
| P4 | Po bete vyprázdniť `beta_allowlist`; overiť, že info@/privacy@ nie sú presmerované na Gmail | V |
| P5 | Unit economics z produkčnej telemetrie po 30 dňoch | V + A |

## Odporúčané poradie

L1–L3 (do 24. 11.) → S1, S2, E7 paralelne → AN1–AN4 → po stanovisku CLIA L4–L6 → AN5 (verejné Android vydanie) →
S3–S4 → S5–S8 → interný nákup → S9 (billing pre zákazníkov) → E1–E10 (eFaktúra) → iOS.
