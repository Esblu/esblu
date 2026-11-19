# Esblu 8 — GO/NO-GO pre produkčnú vlnu A1 (2026-11-19)

**Verdikt: NO-GO (podmienené).** Technicky je A1 pripravená a bez zistenej chyby, ale chýba dôkaz zo skutočného Stripe sandboxu s pripnutou API verziou a vetva nie je na GitHube. Po splnení podmienok v § 6 → GO.

## 1. Presný zoznam A1 (12 migrácií, produkcia má posledné `20261117213219`)
| # | Súbor | Staging (`esblu-test`) | Testy | Rollback |
|---|---|---|---|---|
| 1 | 20261118120000_billing_single_open_checkout | áno, 18. 11. (S12–S16) | subscriptions-db 60, lifecycle-db 82, S12/S13 sandbox | funkcie späť, bez dropu |
| 2 | 20261118130000_billing_terminal_precedence | áno, 18. 11. | lifecycle-db 82 | funkcie späť |
| 3 | 20261118140000_billing_refund_audit | áno, 18. 11. | lifecycle-db, refund audit | funkcie späť |
| 4 | 20261119100000_billing_post_period_protection | áno, 19. 11. | billing-post-period-db 16 | funkcie späť |
| 5 | 20261119110000_billing_scheduled_end | áno, 19. 11. | lifecycle-db, S13 sandbox | funkcie späť |
| 6 | 20261119120000_billing_event_catchup | áno, 19. 11. | billing-ops-db, S12 sandbox | drop `billing_event_cursors` (technický kurzor, bez auditu) |
| 7 | 20261119130000_billing_live_mode | áno, 19. 11. | billing-live-mode-db 14 | funkcie späť |
| 8 | 20261119140000_billing_live_purchase_allowlist | áno, 19. 11. | billing-live-mode-db 14 | neprázdna tabuľka → `esblu_audit_archive` |
| 9 | 20261120100000_internal_operator_entitlement | áno, dnes | internal-operator-db 16, staging RLS | neprázdna → archív |
| 10 | 20261123100000_billing_event_retry | áno, dnes | billing-ops-db 24, staging c2 | stĺpce ponechané |
| 11 | 20261123110000_billing_invoice_documents | áno, dnes | billing-ops-db 24, staging c3–c5 | neprázdne → archív, PDF bucket ponechaný |
| 12 | 20261123120000_billing_ops_alerts | áno, dnes | billing-ops-db 24, staging a2 | neprázdne → archív |
Spoločne: grants-guard 10, grants-replay-db 43 (čistý replay všetkých migrácií + rollback → re-apply každej migrácie po 2026-10-22 dáva identický stav ACL a politík), prelaunch-blockers 21, tsc 0 chýb, lint = baseline, Vercel preview build READY.

**Prečo 8 vs 12:** staging už mal migrácie 1–8 (Stripe sandbox testy 18.–19. 11.). Dnes sa naň aplikovalo 8 nových: z A1 iba č. 9–12, ďalej A2 (3× eFaktúra) a vlna B (retenčný archív). Produkcia nemá ani jednu → A1 = 12.
**Zistenie:** pri č. 1, 2, 3 a 5 je text uložený na stagingu skoršia verzia než súbor v repozitári (MD5 sa líši; súbory sa po commite nemenili, staging pravdepodobne dostal pracovnú verziu pred commitom). **Výsledný stav je však zhodný:** odtlačok 102 objektov (všetky funkcie, ktoré 16 migrácií mení, + 9 kľúčových tabuliek) na stagingu = odtlačok čistého replayu repozitára (0 rozdielov). Do produkcie pôjde presný obsah súborov (overený replayom).
**Produkcia bez driftu:** 11 objektov, ktoré A1 mení (8 funkcií, 3 tabuľky), má v produkcii presne stav, z ktorého vychádza replay (0 rozdielov).

## 2. Poradie nasadenia (podmienky v § 6)
1. Záloha: PHYSICAL < 24 h + šifrovaný logický export do `C:\Users\roiaj\esblu-backups`.
2. Migrácie 1 → 12 cez `apply_migration` (name = názov súboru), po každej: `schema_migrations`, `get_advisors` (0 nových ERROR), `billing_runtime_config` = test/none.
3. Až potom merge `release/esblu8` → `main`, push, Vercel READY pre presné SHA (kód č. 10–11 potrebuje schému vopred).
4. Smoke test (§ 4). A2 a vlna B nie.

## 3. Rollback — dve nezávislé vrstvy
**Kompatibilita overená:** po A1 žiadna funkcia nezaniká, žiadna nemení návratový typ a žiadna existujúca tabuľka nedostáva nový NOT NULL stĺpec bez defaultu (overené na replayi) → starý produkčný kód `12da726` beží nad novou schémou.
| Situácia | Postup |
|---|---|
| Chyba aplikácie po deployi | **Vercel Instant Rollback** na `dpl_7rkNSeF2…` (`12da726`). Nemení databázu; migrácie ostávajú (sú kompatibilné so starým kódom). |
| Chyba počas migrácie | `apply_migration` beží v transakcii → zlyhaná migrácia sa celá vráti; ďalšie nespúšťať; kód nenasadzovať. |
| Chybná migrácia po aplikovaní (pred deployom kódu) | rollback SQL súbory v opačnom poradí 12 → 1 (`supabase/rollback/*`); auditné tabuľky s riadkami sa presúvajú do `esblu_audit_archive`, nemažú sa; `billing_event_cursors` sa zmaže (technický kurzor). Riadky v `schema_migrations` evidovať ručne. |
| Chybná migrácia po deployi nového kódu | **najprv** Vercel Instant Rollback (nový kód potrebuje novú schému), **potom** DB rollback 12 → 1. Nikdy opačne. |
| Strata/poškodenie dát | PITR / denná PHYSICAL záloha do nového projektu + selektívny prenos; Storage zo šifrovanej zálohy. |
Instant Rollback Vercelu **nie je** databázový rollback.

## 4. Kontrolné body po nasadení
`/`, `/login` 200; deployment READY pre SHA; 3 chránené účty (dashboard, moduly); `billing_runtime_config` = test/none; počty users/companies/objects nezmenené; `get_advisors` bez nového ERROR; Vercel runtime errors 30 min = 0 nových; cron `billing-ops-monitor` bez kritického alertu; `billing-stripe-events` / `billing-reconcile` vracajú 200 (pri `web_provider='none'` bez spracovania platieb).

## 5. Zostávajúce riziká
| Riziko | Úroveň | Mitigácia |
|---|---|---|
| Pripnutá `Stripe-Version 2025-03-31.basil` neoverená na skutočnom sandboxe | stredné (LIVE vypnutý → v A1 bez dopadu na zákazníkov) | sandbox E2E pred GO |
| Vetva nie je na GitHube; preview zatiaľ z Vercel API | nízke | push z PC prevádzkovateľa, preview z Git integrácie |
| Nové crony (`billing-ops-monitor`, `billing-documents`) začnú bežať v produkcii | nízke | pri `web_provider='none'` bez spracovania; 503 iba pri kritickom alerte |
| Staging uložený text 4 migrácií ≠ repo | nízke | výsledný stav overený odtlačkom |
| Lehoty retencie účtovných kópií PROPOSED | nízke (nič sa nemaže) | účtovníčka |
| DB rollback č. 6 maže kurzor doťahovania | nízke | po re-apply sa doťahovanie začne od nastaveného okna |

## 6. Podmienky pre GO
1. `release/esblu8` pushnutý z PC prevádzkovateľa; GitHub SHA = `2ec15c5` alebo novší s rovnakými migráciami.
2. Stripe sandbox E2E na Preview (pripnutá verzia, webhook, replay, doklad) PASS — vyžaduje prístupy podľa `staging-sandbox-access-setup.md`.
3. Čerstvá záloha (§ 2.1).
4. Výslovné schválenie A1 prevádzkovateľom.

## 7. Aktualizácia 2026-11-19 (konečný stav pred sandbox testom)
- Bypass secret pre testovacie webhooky vytvorený a overený (ochrana Preview zachovaná, podpisy sa overujú nezávisle) — `staging-sandbox-access-setup.md` § 5.
- Bez zmeny: produkcia `12da726`, posledná migrácia `20261117213219`, LIVE vypnutý.
- **Verdikt: NO-GO** — chýba jediný technický dôkaz: skutočný Stripe sandbox beh s pripnutou `Stripe-Version` (A1 obsahuje kód, ktorý ju posiela pri každom volaní; pri vypnutom billingu sa však v produkcii nevolá). Ostatné podmienky: push vetvy, čerstvá záloha, schválenie.
- **Alternatíva (rozhodnutie prevádzkovateľa):** keďže v A1 ostáva `web_provider='none'` a Stripe sa v produkcii nevolá, A1 možno nasadiť ako „GO s podmienkou“ a sandbox overenie verzie presunúť pred zapnutie Stripe LIVE (nie pred A1). Riziko pre produkciu: nízke; nedá sa ho však vylúčiť pre crony `billing-stripe-events`/`billing-reconcile`, ktoré pri `none` bez kľúča končia `NOT_CONFIGURED`.
