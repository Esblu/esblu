# Esblu — release gate RC 2026-11-26 (nahrádza release-gate-rc-2026-11-25.md)

Stav: **PRIPRAVENÉ, NEVYKONANÉ v produkcii.** Vetva `release/rc-2026-11-26` iba v lokálnom repe (nie na GitHube).

## 1. Obsah kandidáta

`main 6506e11` (produkcia) + 79 commitov = `release/rc-2026-11-25` (P15, S17 opravy, O3 guard, Android vc5 tooling,
zálohovacie skripty) + 6 commitov z 26. 11.:

| Commit | Zmena |
| --- | --- |
| 7336a95, 5bf43c3 | Zásady 1.5 = znenie CLIA „GDPR_ESBLU 2.0“ (23.11.2026): Google prihlásenie aj v Android appke, Resend v časti Zasielanie oznámení; `/subprocessors` s Resend (oprava nepravdivého tvrdenia „Resend sa nepoužíva“); migrácia `20261129100000` |
| c8f3498 | VOP 1.3 — podmienky plateného predplatného; firemné prijatie s 30-dňovým oznámením; migrácia `20261129110000` |
| 1a6dc94 | `20261121100000` (10-ročný zákaznícky archív) presunutá do `supabase/superseded/` — produkcia ju nedostane |
| 82e4fd7 | rozhodovací podklad účtovníčka / Stripe / eFaktúra |

DPA ostáva 1.3: Resend spracúva iba údaje, pri ktorých je Esblu prevádzkovateľom (autentifikačné e-maily), nie údaje
zákazníkov → nie je ďalším sprostredkovateľom podľa DPA (zhodne s DPA 2.0 od CLIA, ktorá Resend v prílohe 3 nemá).
Jediný rozdiel DPA 2.0 voči 1.3 (Android v opise autentifikácie) sa zapracuje pri najbližšej verzii DPA spolu
s eFaktura.sk, aby firmy neprijímali DPA dvakrát.

## 2. Validácia (Linux sandbox, Node 22; HEAD 82e4fd7)

| Kontrola | Výsledok |
| --- | --- |
| `tsc --noEmit` | 0 chýb |
| `npm run lint` | 36 errors / 34 warnings = baseline (žiadna nová) |
| `next build` (webpack, mock Google Fonts) | PASS, 61 stránok; Turbopack build overí Vercel Preview |
| Testové sady `test:*` | **124/124 PASS** |
| P15 runner offline | groupD 25/25; storage-backup 11/12 (12. = práva k súboru v /tmp sandboxu, nie chyba kódu) |
| `npm audit --omit=dev` | 0 critical, 0 high, 2 moderate (exceljs → uuid, akceptované 20. 11.) |
| Capacitor | 8.6.2 (oprava critical z 8.5.0) |

## 3. Migrácie — presný plán

Prečo predtým „8 vs. 9“: produkcii chýbalo **9** súborov (`21`, `22`×3, `24`, `25`, `26`, `27`, `28`); číslo 8 v reporte
z 25. 11. bola moja chyba v počítaní. Teraz: `21` sa **nenasadzuje** (superseded), pribudli 2 právne migrácie → **10 migrácií**.

| # | Migrácia | Dopad v produkcii | Staging | Rollback |
| --- | --- | --- | --- | --- |
| 1 | 20261122100000_einvoice_mandates | žiadny (eFaktúra vypnutá) | ✅ | rollback súbor |
| 2 | 20261122110000_einvoice_deregistration_jobs | žiadny | ✅ | rollback súbor |
| 3 | 20261122120000_einvoice_ops_alerts | žiadny | ✅ | rollback súbor |
| 4 | 20261124100000_billing_document_company_link | žiadny (billing vypnutý); S17 PASS | ✅ | rollback súbor |
| 5 | 20261125100000_einvoice_inbound_quarantine | RLS skryje R3 doklady (0 v prod) | ✅ | rollback súbor |
| 6 | 20261126100000_einvoice_provider_rate_classes | žiadny | ✅ **26. 11. aplikovaná a overená** (MD5 3 funkcií = repo, 14 kvót, RLS, bez prístupu anon/authenticated) | rollback súbor |
| 7 | 20261127100000_company_termination_customer_delete | nová brána ukončenia firmy (výmaz bez zákazníckeho archívu) | ✅ | rollback súbor |
| 8 | 20261128100000_termination_purge_export_integrity | odtlačok exportu, overený výmaz súborov | ✅ | rollback súbor |
| 9 | 20261129100000_privacy_policy_1_5_resend | používatelia potvrdia Zásady 1.5 (LegalAcceptanceGate) | ⏳ s Preview | fail closed po prvom potvrdení |
| 10 | 20261129110000_terms_1_3_subscription | vlastníci firiem dostanú oznámenie VOP 1.3, 30 dní na prijatie | ⏳ s Preview | fail closed po prijatí/oznámení |

Ochrana povinného archívu účtovných kópií Esblu je už v produkcii (`20261123110000`: zákaz DELETE/TRUNCATE
`billing_invoice_documents`, bucket `billing-documents`) a znova v #7/#8 (cleanup job nikdy nezahrnie `billing-documents`).
Nezávisí od `21`. Test `test:p15-termination-db` overuje prod-like replay bez `21` aj staging-like s ňou.

Poradie: #1–#8 jednotlivo (po každej kontrola `list_migrations` + advisors), potom #9–#10, potom kód (merge PR → Vercel).
Starý kód nad novou DB: ukončenie firmy fail closed, ostatné bez zmeny; Zásady 1.5/VOP 1.3 si starý kód nevyžiada.

## 4. Pred schválením produkcie (neprodukčné)

| # | Krok | Kto |
| --- | --- | --- |
| P1 | D-T1, D-T2, D-PERF na stagingu (rozsah nižšie) | vlastník spustí runner, agent kontroluje snímky |
| P2 | `git push origin release/rc-2026-11-26` → Vercel Preview READY | vlastník (súhlas s pushom) |
| P3 | Migrácie #9, #10 na staging + Preview smoke (nižšie) | agent po P2 |
| P4 | Záloha produkcie + test obnovy | vlastník (dashboard / `scripts/ops/esblu-daily-backup.ps1`) |

### Rozsah deštruktívneho stagingového behu (na schválenie)

- Projekt iba `cjbdijbbcujvmrzezusd` (esblu-test). Firmy iba **QA-P15-T1** (`f1510000-…-0001`), **QA-P15-T2** (`…-0002`),
  **QA-P15-PERF** (`…-0004`); ich vlastníci `qa-p15-t1|t2|perf@esblu-qa.invalid` (účty sa zrušia).
- Chránené (runner a DB to vynucujú, kontrola snímkou pred/po): QA-P15-ISO, 16 pôvodných firiem, `billing-documents`,
  67 objektov zálohovaných 25. 11. (záloha PASS).
- Postup: `docs/p15-groupD-plan-2026-11-25.md` § 5 — `release-backups\p15\run-p15-groupD.ps1 -Target t1` (potom `t2`
  so simulovaným 503 výpadkom Storage, potom `perf`); dočasný kľúč na každý beh, po behu odvolanie a overenie 401.
- Kód runnera = kód RC (`lib/account-deletion*`, `lib/company-export.ts`, migrácie 27/28 bez rozdielu).
- Očakávanie PERF: pravdepodobne prekročí 8 s `statement_timeout` → bezpečné zlyhanie bez výmazu (to je výsledok testu);
  D-PERF-B (rovnaká DB funkcia mimo API) iba po osobitnom súhlase.

### Preview smoke test (po P2/P3)

`/`, `/login`, `/cennik`, `/podmienky-pouzivania` (VOP 1.3 + archív 1.2), `/ochrana-osobnych-udajov` (1.5),
`/subprocessors` (Resend), `/dpa`, `/kontakt` = 200; prihlásenie testovacieho používateľa → výzva na potvrdenie Zásad 1.5;
vlastník firmy → oznámenie VOP 1.3 s lehotou 30 dní; export firmy dokončený; ukončenie firmy bez exportu → 409;
Vercel runtime errors 0.

## 5. Produkčná operácia (po schválení gate)

1. Záloha (P4) + inventár `storage.objects` po bucketoch.
2. Migrácie #1–#10 podľa § 3 (Supabase MCP na `fkpgvgvsmbpieduoatrt`), advisors 0 ERROR.
3. PR `release/rc-2026-11-26` → `main`, merge, Vercel deployment spárovaný podľa SHA → READY.
4. Produkčný smoke (ako Preview, na www.esblu.com).
5. Rollback: kód — Vercel instant rollback na `dpl_5GjvYbFswRpthUwLyHvnUJWFsaoa` (`6506e11`); DB — rollback súbory
   v opačnom poradí (#10 → #1), legal migrácie iba pred prvým potvrdením; obnova zo zálohy iba pri poškodení dát.

LIVE Stripe a LIVE eFaktúra sú mimo tohto gate (`docs/release/rozhodnutia-ucto-stripe-efaktura-2026-11-26.md`).
