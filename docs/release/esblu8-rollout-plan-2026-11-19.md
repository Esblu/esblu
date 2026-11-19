# Esblu 8 — produkčný rollout plán (návrh, 2026-11-19)

Nahrádza poradie v `esblu8-integrated-release-2026-11-19.md` § 3. Každá vlna = osobitné schválenie prevádzkovateľa.
Pravidlá: `apply_migration` po jednej (name = názov súboru), nikdy `supabase db push`; deploy iba merge do `main` → Vercel READY pre presné SHA; po každom kroku kontrolný bod, pri odchýlke STOP + rollback.

## 0. Pred vlnou A (bez dopadu na produkciu)
1. Vetvu `release/esblu8` pushne prevádzkovateľ zo svojho PC (`git push origin release/esblu8`) — z Cowork je push blokovaný. Overiť, že GitHub SHA = lokálne SHA.
2. Staging sandbox E2E (§ 2) PASS.
3. Ručná záloha: denná PHYSICAL záloha Supabase < 24 h + šifrovaný logický export (postup ako 19. 11., do `C:\Users\roiaj\esblu-backups`).

## 1. Vlna A1 — bezpečne nasaditeľné (iba technické, nič sa nepredáva)
| # | Migrácia | Prečo bezpečné | Kontrola |
|---|---|---|---|
| 1–8 | `20261118120000` … `20261119140000` (Stripe S12–S15b) | `web_provider='none'`, `environment='test'` → žiadny predaj | `billing_runtime_config` nezmenený |
| 9 | `20261120100000_internal_operator_entitlement` | grant iba operátorom po registrácii + RPO overení | `internal_operator_grants` = 0 |
| 10 | `20261123100000_billing_event_retry` | iba retry plán | `billing_events` bez zmeny počtu |
| 11 | `20261123110000_billing_invoice_documents` | prázdne tabuľky, deny-all, zákaz DELETE | `billing_invoice_documents` = 0 |
| 12 | `20261123120000_billing_ops_alerts` | monitoring | — |
Potom merge `release/esblu8` → `main`, push, Vercel READY pre SHA, smoke test (§ 3).
**Rollback A1:** Vercel Instant Rollback na `12da726`; migrácie 12 → 1 rollback súbormi (audit sa archivuje, nemaže).

## 2. Staging sandbox E2E (podmienka pre A2 a pre LIVE)
Potrebné nastavenie (Vercel → Project → Settings; iba **Preview**, branch `release/esblu8`):
- Stripe sandbox „Esblu s.r.o.“: `ESBLU_BILLING_MODE=stripe_test`, `STRIPE_SECRET_KEY` (sk_test/rk_test), `STRIPE_WEBHOOK_SECRET` (endpoint na URL preview + bypass), `ESBLU_BILLING_RETURN_ORIGIN`.
- eFaktura sandbox: `ESBLU_EINVOICE_PROVIDER=efaktura_sk`, `ESBLU_EINVOICE_ENVIRONMENT=sandbox`, `ESBLU_EFAKTURA_API_KEY` (efk_pk_test), `ESBLU_EFAKTURA_WEBHOOK_SECRET`.
- Deployment Protection → „Protection Bypass for Automation“ (pre webhooky a cron testy).
Po nastavení Claude spustí kroky `docs/release/staging-smoke-test-esblu8.md` §2–4 cez preview a staging DB (pripnutá API verzia, replay zlyhanej udalosti, doklad + PDF archív, export; mandát → enroll → odoslanie → odvolanie → deregistrácia, webhook replay, 402 alert).

## 3. Smoke test po každom produkčnom deployi
`/` a `/login` 200; deployment READY pre SHA; 3 chránené účty (playreview, gdpresblu, zamestnanec) — dashboard, moduly; `billing_runtime_config` = test/none; `get_advisors` bez nového ERROR; `schema_migrations` obsahuje práve aplikované migrácie; Vercel runtime errors 30 min = 0 nových.

## 4. Vlna A2 — eFaktúra schéma (bez aktivácie)
`20261122100000`, `110000`, `120000`. Bezpečné (v produkcii 0 eFaktura organizácií; mandát DRAFT blokuje live grant). Podmienka: § 2 PASS.

## 5. Vyžaduje ďalšie rozhodnutia (nenasadzovať)
| Funkcia | Rozhodnutie |
|---|---|
| Vlna B: `20261121100000_retention_archive_company_termination` + texty `/zrusenie-uctu` | CLIA (čl. 28 ods. 3 písm. g), lehoty, režim `waived` |
| Stripe LIVE (live kľúče, ceny, allowlist, otvorenie predaja) | účtovníčka (doklady, § 7a, OSS/reverse charge), variant A/B, Stripe Portal, kto refunduje |
| eFaktúra produkcia | podpis zmluvy, schválenie textu poverenia (prepnúť `EINVOICE_MANDATE_STATEMENT_STATUS`), cena, pilot |
| Interný tarif | po registrácii `esblu.office@gmail.com` + RPO overení IČO 57815941 |
| E-mailové ops alerty (Resend REST) | voliteľné, adresa príjemcu |
| Lehoty retencie (zákaznícky archív, účtovné kópie Esblu 10 r. PROPOSED) | účtovníčka + CLIA |

## 6. Kontrolné body / okamžitý rollback
- Chyba buildu alebo smoke testu → Vercel Instant Rollback (sekundy), migrácie ostávajú (sú aditívne, starý kód ich ignoruje).
- Chyba migrácie → transakcia sa vráti; ďalšie migrácie nespúšťať.
- Neočakávané údaje (počty používateľov/firiem/súborov ≠ pred stavom) → STOP, obnova z PITR/dennej zálohy podľa `release-backups` postupu.
