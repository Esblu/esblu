# Esblu — release gate RC 2026-11-25 (jeden súhrnný bod schválenia)

Stav: **PRIPRAVENÉ, NEVYKONANÉ.** Žiadny produkčný zápis, merge do `main`, push ani deploy. LIVE Stripe a LIVE eFaktúra
sú mimo tohto gate (samostatné schválenie).

## 1. Východisko (overené 2026-11-25 ~20:30 UTC, read-only)

| Položka | Hodnota |
| --- | --- |
| GitHub `main` | `6506e11` (PR #2, bezpečnostné aktualizácie next 16.4.6 / Capacitor 8.6.2) |
| Vercel production | `dpl_5GjvYbFswRpthUwLyHvnUJWFsaoa` READY, SHA `6506e11…` |
| Prod DB (`fkpgvgvsmbpieduoatrt`) | posledná migrácia `20261123120000_billing_ops_alerts`; 4 firmy, 5 účtov, 0 faktúr; billing `web_provider=none`; 0 otvorených billing alertov |
| Prod env | žiadne Stripe ani eFaktúra premenné → billing a eFaktúra vypnuté (fail closed) |
| Supabase security advisors (prod) | 0 ERROR; WARN SECURITY DEFINER RPC (známe, interné kontroly), INFO 53 service-only tabuliek |
| Staging (`cjbdijbbcujvmrzezusd`) | všetky RC migrácie okrem `20261126100000` |

## 2. Release kandidát

- Vetva **`release/rc-2026-11-25`** (lokálne repo, nepushnutá), HEAD `7b2b96a` + tento dokument; = `main 6506e11` + 72 commitov.
- Obsah: P1-4 eFaktúra príjem (stránkovanie, karanténa, R3 izolácia, limit partnerského kľúča), P1-5 ukončenie firmy bez
  zákazníckeho archívu + integrita exportu a overený výmaz súborov, O3 guard (`waived` → 409 pred akýmkoľvek zásahom),
  S17-4 väzba účtovnej kópie na firmu, S17-5 archív PDF Stripe cez S3 + SSRF kontrola, Android vc5 release tooling,
  verify-mobile-bundle, zálohovacie skripty (ops), dokumentácia.
- Konflikty pri integrácii: iba texty i18n/UI z `fix/termination-waiver-guard` (ponechaná novšia verzia P15); serverový
  guard O3 prevzatý.
- Opravené testy (zastarané očakávania, nie chyby kódu): `pricing-engine` (2 serverové uploady P4), `prelaunch-blockers`
  (nové tabuľky P1-4/P1-5 v manifeste), `company-termination` (signatúra s `terminationAck`).

### Validácia (Linux sandbox, Node 22)

| Kontrola | Výsledok |
| --- | --- |
| `tsc --noEmit` | 0 chýb |
| `npm run lint` | 36 errors / 34 warnings = baseline chýb 36 (žiadna nová chyba) |
| `next build` | PASS cez webpack (61 stránok) s mockom Google Fonts a dummy env; **Turbopack build overí Vercel Preview** (sandbox nemá prístup k fonts.googleapis.com) |
| Testové sady `test:*` | **125/125 PASS** |
| Sken tajomstiev v diffe voči `main` | 0 kľúčov (iba skrátené prefixy odvolaných stagingových kľúčov v dokumentácii) |
| Billing kód vs. S17 | `lib/billing`, `app/api/billing`, migrácia 20261124 = presne kód testovaný S17 (`d785483`): **S17 PASS 2026-11-22 19:53 UTC**, 1 LIMITATION (payout v sandboxe) |

## 3. Pred schválením musí prebehnúť (neprodukčné, vyžaduje PC vlastníka)

| # | Krok | Prečo | Postup |
| --- | --- | --- | --- |
| P1 | D-T1, D-T2, D-PERF na stagingu | skutočný E2E výmaz firmy novým kódom ešte neprebehol (skupina C PASS, záloha 67 objektov PASS) | `docs/p15-groupD-plan-2026-11-25.md` § 5 — spúšťač `release-backups/p15/run-p15-groupD.ps1 -Target t1|t2|perf`, dočasný kľúč na beh, odvolanie + 401 |
| P2 | `20261126100000` na staging | parita staging = produkcia | Claude cez Supabase MCP (aditívna) |
| P3 | Push `release/rc-2026-11-25` na GitHub → Vercel Preview READY + smoke | Turbopack build, runtime | vlastník (`git push origin release/rc-2026-11-25`) |

D-PERF pravdepodobne narazí na `statement_timeout` 8 s (25 000 faktúr) → bezpečné zlyhanie bez výmazu. Pre prvé spustenie
to nie je blokátor (žiadna produkčná firma nemá takýto objem); veľké firmy ukončí operátor cez D-PERF-B postup.

## 4. Rozsah produkčnej operácie (po schválení)

**Rozhodnutie A (odporúčané):** aplikovať aj `20261121100000` (história = staging, schéma `esblu_retention` ostane prázdna).

Poradie (migrácie pred kódom; každá samostatne, po každej kontrola):

| # | Migrácia | Dopad v produkcii | Rollback |
| --- | --- | --- | --- |
| 1 | 20261121100000_retention_archive_company_termination | nová schéma, hneď nahradená #6 | `supabase/rollback/20261121100000_…` |
| 2–4 | 20261122100000/110000/120000 eFaktúra mandát, deregistrácia, alerty | žiadny (eFaktúra vypnutá) | príslušné rollback súbory |
| 5 | 20261124100000_billing_document_company_link | žiadny (billing vypnutý) | rollback súbor |
| 6 | 20261125100000_einvoice_inbound_quarantine | RLS skryje R3 doklady (0 riadkov v prod) | rollback súbor |
| 7 | 20261126100000_einvoice_provider_rate_classes | žiadny (eFaktúra vypnutá) | rollback súbor |
| 8 | 20261127100000_company_termination_customer_delete | ukončenie firmy novou bránou; starý 4-arg commit fail closed | rollback súbor |
| 9 | 20261128100000_termination_purge_export_integrity | odtlačok exportu, overený výmaz súborov | rollback súbor |
| 10 | merge `release/rc-2026-11-25` → `main` (PR), push | Vercel production build | Vercel instant rollback na `dpl_5GjvYbFs…` (`6506e11`) |

Kompatibilita: starý kód `6506e11` nad novými migráciami → ukončenie firmy fail closed (nič sa nezmaže), ostatné funkcie
bez zmeny. Nový kód bez migrácií → ukončenie fail closed, export v pôvodnom režime. Rollback kódu a DB sú teda nezávislé.

### Záloha pred migráciou (povinné)

1. Supabase Dashboard → Database → Backups: overiť poslednú dennú zálohu + (ak je PITR) čas; inak `pg_dump` schémy a dát
   (`scripts/ops/esblu-daily-backup.ps1`, read-only rola `esblu_backup`, vetva `ops/daily-backup-2026-11-20`).
2. Storage: prod má 0 faktúr; inventár objektov (SQL `storage.objects` počty po bucketoch) pred a po.
3. Test obnovy: obnova dumpu do lokálneho PGlite/Postgres (postup v `docs/ops/backup-preflight-verification-2026-11-20.md`).

### Smoke test po nasadení (SHA spárovaný s Vercel deploymentom)

`/`, `/login`, `/cennik`, `/podmienky-pouzivania`, `/ochrana-osobnych-udajov`, `/dpa`, `/subprocessors`, `/kontakt`,
`/.well-known/assetlinks.json` = 200; prihlásenie vlastníka; dashboard; vytvorenie a zmazanie konceptu faktúry v internej
firme; export firmy (`/api/company/export`) dokončený bez chýbajúcich súborov; Supabase advisors 0 ERROR; Vercel runtime
errors 30 min = 0 nových.

## 5. Mimo gate (samostatné výslovné schválenie / úkon vlastníka)

- **Stripe LIVE:** aktivácia účtu Esblu s. r. o., produkt/cena, restricted kľúč, webhook, env, `ESBLU_BILLING_LIVE_APPROVED`,
  interný nákup + refund (`docs/billing-live-rollout-2026-11-19.md`). Predpoklad: VOP s podmienkami predplatného (CLIA) a
  odpovede účtovníčky (`docs/accountant-questions-billing-2026-11-19.md`).
- **eFaktúra LIVE:** zmluva s eFaktura.sk je od 22. 11. pripravená na podpis (partnerský portál); po podpise faktúra na
  platbu vopred, produkcia až po úhrade → live kľúč, WAF, brána G1–G12.
- **GDPR:** Resend (SMTP Supabase Auth od 17. 11.) chýba v Zásadách 1.4, DPA 1.3 a `/subprocessors` (stránka dokonca
  tvrdí, že Resend sa nepoužíva) — oprava po potvrdení regiónu a DPA Resend (CLIA delta § 1.1).
- **Android:** vc5 / 1.0.2 (Capacitor 8.6.2) build + interný test; vc4 obsahuje Capacitor 8.5.0 s critical zraniteľnosťou.
