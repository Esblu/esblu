# eFaktúra — PRE-PRODUCTION CLOSURE (7. 10. 2026)

Nadväzuje na `docs/einvoice-preproduction-readiness-2026-10-07.md` (runbook, crony, rollout plán).
Vetva `einvoice-port`.

Počas fázy sa nič nenasadilo do produkcie:
- produkčná DB, `main`, produkčné secrets ani live eFaktúra sa nemenili;
- nič platené sa neaktivovalo;
- žiadny e-mail sa neodoslal.

Produkčná DB sa v tejto fáze ani nečítala. Supabase a Vercel sa čítali iba ako metadáta projektu.

## 1. Stav podľa dimenzií

| Dimenzia | Stav | Čo chýba |
| --- | --- | --- |
| **CODE READY** | **ÁNO pre rozsah spustenia** (odoslanie a príjem faktúr, 386, opravy, review, úhrady, export) | Model zdanenej zálohy opravený podľa FS FAQ príklad 38 (migrácie `20261008100009` + `20261008100010`, reálny sandbox E2E 7. 10. 2026 — pozri `docs/einvoice-taxed-advance-model-2026-10-07.md`). Fail-closed ostáva iba pre staršie finalizované konečné faktúry bez mínusových riadkov (`ADVANCE_DEDUCTION_EINVOICE_UNSUPPORTED`). |
| **PRODUCTION CONFIG READY** | **NIE** | Migrácie, merge do `main`, prvý import kurzov ECB, produkčné env eFaktúry, alert kanál (GitHub secret + workflow), backup pred oknom. Vercel plán **Pro** crony podporuje. |
| **LEGAL READY** | **NIE** | Delta pre CLIA pripravená, neodoslaná. Stanovisko CLIA k zrušeniu firmy s dokladmi, k retencii a k eFaktura.sk/DPA. 4 otázky pre účtovníčku (kategória C). |
| **PROVIDER READY** | **NIE** | E-mail pre eFaktura.sk pripravený, neodoslaný. Zmluva, DPA, live kľúč, webhook, odpovede P1–P4, P10–P12. |
| **ROLL-OUT APPROVED** | **NIE** | Výslovný súhlas vlastníka (sekcia 9). |

## 2. Nálezy a opravy v tejto fáze

| Nález | Zdroj | Opatrenie |
| --- | --- | --- |
| Konečná faktúra odpočítavala zdanenú zálohu cez `PrepaidAmount` (BT-113). FS: mínusový riadok (základ + DPH, BT-25); BT-113 iba pre nezdanené zálohy. | FAQ FS k eFaktúre 15. 9. 2026, tech. príklad 38 | **Opravené 7. 10.:** zdanená záloha = mínusový riadok (InvoicedQuantity −1, základ + DPH zálohy, sadzba zálohy, BT-25); BT-113 iba nezdanená záloha. Fail-closed ostáva len pre staršie doklady bez riadkov odpočtu. |
| Lehota faktúry k prijatej platbe od 1. 1. 2027 zobrazovala aj alternatívu „koniec mesiaca“. Pri tuzemskej e-faktúre platí iba 15 dní (§ 85o ods. 6). | § 85o ods. 6 ZDPH, FAQ FS príklady 13 a 74 | Opravené (`lib/invoicing/sk-deadlines.ts`) + testy. Posun na pracovný deň potvrdený ako neuplatniteľný (FS 903288). |

## 3. Vercel cron capability (overené cez API 7. 10.)

- Projekt `esblu` beží na pláne **Pro** (`plan: "pro"` v deployment objekte), región `fra1`, Fluid compute.
- Podľa dokumentácie Vercel (cron usage and pricing, 15. 7. 2026) má Pro:
  - 100 cronov na projekt;
  - minimálny interval **1 minúta**;
  - presnosť na minútu.
- Hobby by mal limit 1× denne a deploy by zlyhal.

| Cron | Cadence | Podpora Pro |
| --- | --- | --- |
| outbound send | každú minútu | áno |
| outbound reconcile | každých 5 min | áno |
| events (feed) | každých 5 min | áno |
| inbound poll | každých 10 min | áno |
| maintenance | 1× za hodinu | áno |
| FX import | 2× denne | áno |

- Preview build s týmito cronmi (`df6c683`) je READY.
- Produkčná cron konfigurácia ostáva iba `deadline-notifications` (overené). Crony sa zapnú až
  produkčným deployom z `main`.
- **Cena / dopad:** približne 65 600 volaní mesačne (send 43 200, reconcile 8 640, events 8 640, inbound
  4 320, maintenance 720, FX 60). Bez nakonfigurovaného poskytovateľa končia okamžite (`configured:false`).
  Crony sú v Pro pláne zahrnuté; účtuje sa iba bežné využitie funkcií (Active CPU, invocations). Pri tomto
  objeme ide o zanedbateľnú časť zahrnutej kvóty, nie o nový platený produkt.
- Vercel cron neopakuje zlyhaný beh. Opakovanie zabezpečuje ďalší plánovaný beh a backoff v DB.

## 4. Alerting

**Cieľ:** kritický stav nesmie ostať iba ako HTTP 503 v logu. Existujúce kanály Esblu:
- Vercel (Pro);
- Supabase (Pro);
- GitHub (`Esblu/esblu`);
- push notifikácie Esblu (web push / FCM). Tie sú viazané na firmu a druhy `chat`/`deadline`.

Transakčný e-mail poskytovateľ Esblu nemá.

| Možnosť | Cena / dopad | Hodnotenie |
| --- | --- | --- |
| **A. GitHub Actions — hodinový health check** (`docs/ops/einvoice-health-alert.github-workflow.yml`). Volá `/api/cron/einvoice-maintenance`, pri ne-200 (503 = kritický alert) beh zlyhá a GitHub pošle e-mail. Telo obsahuje iba kódy. | 0 € v rámci zahrnutých minút Actions (≈ 720 min/mesiac pri hodinovom behu; súkromné repo na GitHub Free má 2 000 min/mesiac — plán organizácie overiť v GitHub Billing, API z prostredia nie je dostupné). Nový poskytovateľ nepribudne; v GitHub je iba kód. | **Odporúčané.** Aktivácia: vlastník pridá secret `ESBLU_CRON_SECRET` a skopíruje súbor do `.github/workflows/` na `main`. |
| B. Push notifikácia operátorovi cez existujúci push stack | 0 €; vyžaduje novú DB migráciu (druh `ops`) + kód + konfiguráciu operátora | Neskôr. Mení produkčnú schému → nie v tejto fáze. |
| C. Vercel Alerts (anomaly) | Iba s plateným doplnkom **Observability Plus**. Alerty sú založené na anomáliách s minimálnou aktivitou, takže hodinový 503 ich spoľahlivo nespustí. | Neodporúčané. |

Doplnok: Vercel → projekt → Cron Jobs zobrazuje zlyhané behy (bez notifikácie). FX import pri chybe vracia
5xx; jeho stav maintenance nesleduje. Pri nedostupných kurzoch chybu ukáže finalizácia faktúry v cudzej mene.

## 5. Supabase backup / restore (read-only zistenie)

- Projekt `assetpilot` (`fkpgvgvsmbpieduoatrt`): eu-central-1, Postgres 17.6, ACTIVE_HEALTHY.
- Organizácia „Esblu s.r.o.“ má plán **Pro**.
- **Denné zálohy:** automatické, prístupných posledných **7 dní** (dokumentácia Supabase). Obnova je obnovou
  celého projektu k času zálohy:
  - počas obnovy je projekt nedostupný;
  - stratia sa zmeny po zálohe;
  - **súbory v Storage nie sú v zálohe DB**.
- **PITR:** platený doplnok (7 dní ≈ 100 USD/mesiac, 0,137 USD/hod; vyžaduje aspoň Small compute). Či je
  zapnutý, môj prístup neukáže (MCP nevidí add-ony ani zoznam záloh) → vlastník overí v Dashboard →
  Database → Backups.
- **Pred migráciami odporúčam:**
  1. V Dashboarde overiť čas poslednej dennej zálohy (bezplatné, read-only).
  2. Tesne pred oknom urobiť bezplatný logický dump schémy a dát (`supabase db dump`, resp. `pg_dump`
     s produkčnými prístupovými údajmi vlastníka). Je to read-only voči DB a uloží sa mimo repa. Fyzické
     zálohy Supabase sa sťahovať nedajú.
  3. PITR **netreba** zapínať: reťazec je aditívny (žiadne `update`/`delete` produkčných dát). Primárny
     rollback sú súbory v `supabase/rollback/` a forward-fix; obnova zo zálohy je až posledná možnosť.
     Ak vlastník chce RPO v minútach počas okna, PITR sa dá zapnúť dočasne (≈ 3,3 USD/deň) — je to
     platená akcia, rozhodne vlastník.

## 6. Produkčný precheck (pripravený, nespustený)

`scripts/sql/einvoice-prod-precheck.sql`:
- transakcia `READ ONLY` + `ROLLBACK`;
- výstup iba počty a stav (STOP / WARN / INFO / OK);
- žiadne osobné údaje.

Kontroluje:
- stav migrácií a neprítomnosť objektov a stĺpcov reťazca (drift);
- **signatúry 9 existujúcich funkcií**, ktoré reťazec mení (iný návratový typ alebo DEFAULT by migráciu
  zastavil);
- kotvu `invoice_events`;
- všetky nové CHECK nad existujúcimi riadkami;
- väzby opráv;
- duplicitné čísla a počítadlá sérií za použitým číslom;
- rozpor DPH hlavička vs. rozpis vs. riadky;
- cudzie meny (koncepty / finalizované);
- koncepty dotknuté novými pravidlami finalizácie;
- úhrady na dobropisoch;
- bucket.

Overenie na stagingu (read-only, po reťazci): syntax OK, signatúry 9/9 zhodné. Stavové kontroly správne
hlásia STOP, keďže staging je už zmigrovaný. Kontrola väzieb opráv hlási 1 koncept prijatej opravy bez
originálu — nový model to povoľuje; v produkcii pred reťazcom platí pôvodné obmedzenie, takže očakávame 0.

Poznámka k nástrojom: časové pečiatky `20261002…`–`20261003…` sú staršie ako produkčná `20261005091000`.
Runbook aplikuje súbory jednotlivo (`apply_migration`). Pri `supabase db push` by bol potrebný
`--include-all`.

## 7. Main merge readiness (throwaway, nič nepushnuté)

`main` = `901c46c` (+2 commity: Google OAuth, storage media), `einvoice-port` = `df6c683`.

**Jediný konflikt** je `package.json` → `scripts`. Obe strany pridali testovacie skripty; vyriešenie je
zjednotenie (najprv `main`, potom `einvoice-port`):

```jsonc
    "test:company-lookup-db": "…",              // spoločný predok
    "test:google-oauth": "…",                    // main
    "test:google-oauth-db": "…",                 // main
    "test:storage-media": "…",                   // main
    "test:storage-media-db": "…",                // main
    "test:einvoice-db": "…",                     // einvoice-port … až po
    "test:einvoice-partner-e2e-selftest": "…",   // einvoice-port
    "verify:mobile-bundle": "…"                  // spoločný predok
```

Ostatné súbory sa zlúčili automaticky: `app/nastavenia/page.tsx` a `lib/i18n/dictionaries/{sk,en,de}.ts`.

Závislosti z `einvoice-port`:
- `next` 16.2.9 → 16.3.8;
- `eslint-config-next` 16.2.9 → 16.3.8;
- `@xmldom/xmldom` 0.9.12.

`main` závislosti nemenil, takže `package-lock.json` z `einvoice-port` je konzistentný.

| Overenie na zlúčenom strome | Výsledok |
| --- | --- |
| `tsc --noEmit` | PASS |
| eFaktúra a fakturácia (einvoice-db 44, ubl 65, efaktura 17, outbound 47, inbound 47, ops 23, ui 53, invoicing-sk 33, invoicing-flow 39, l3-inbound-one 16, e2e self-test 27+1 PARTIAL, partner 23, partner e2e 25, hardening 19, reception 23, staging-guard 8) | PASS |
| main + ostatné (google-oauth 17, google-oauth-db 18, storage-media 10, storage-media-db 33, m1-authz-db 47, push-db 31, company-lookup-db 13, closed-beta-p0 36, p0-bank-sql 17, handoff 122, i18n 114, plan-entitlements 47, partners 84, master-control 34, mobile-m1 64, voice 38, gross 230) | PASS |
| Storage + eFaktúra kombinácia (storage migrácie → `20261008100002`) | storage-media-db 33/33 PASS |
| Poradie migrácií | `20261005090000/091000` (main, v produkcii) → `20261005100000` … `20261008100010` (eFaktúra) |
| `next build` | **lokálne nespustené** — prostredie nemá prístup k npm registru pre natívny SWC. Oba rodičia sú READY na Verceli (main produkcia `901c46c`, einvoice-port preview `df6c683`). Build zlúčeného stromu overí Vercel po zlúčení (pozri sekciu 9). |

## 8. Pripravené dokumenty na odoslanie (NEODOSLANÉ)

- `docs/efaktura-sk-provider-email-2026-10-07.md` — iba nezodpovedané otázky (P1–P4, P5b, P5c, P10–P13,
  P15, P17, P18, onboarding, cena).
- `docs/clia-delta-email-2026-10-07.md` — iba materiálne zmeny od 4. 10. a 3 právne otázky; príloha nie je
  potrebná.
- `docs/einvoice-tax-accounting-open-items-2026-10-07.md` — A/B/C; účtovníčke iba 4 otázky (C).

## 9. Kroky, ktoré objektívne vyžadujú vlastníka

1. Odoslať e-mail eFaktura.sk; vyhodnotiť odpovede (P1/P2/P4 sú podmienkou bezpečného retry).
2. Odoslať delta e-mail CLIA; po odpovedi poskytovateľa poslať CLIA aj jeho odpovede (rola, DPA,
   lokalita, retencia).
3. Poslať 4 otázky (C) účtovníčke / daňovému poradcovi.
4. Rozhodnúť o prepracovaní modelu konečnej faktúry so zálohou (pred 1. 1. 2027) — samostatná úloha.
5. Podpísať zmluvu a DPA s eFaktura.sk; rozhodnúť o programe a okamihu vzniku poplatku (platené).
6. Zlúčenie `main` → `einvoice-port`, aby Vercel postavil zlúčený strom, a neskôr PR do `main` — súhlas.
7. Pred oknom:
   - overiť poslednú dennú zálohu (Dashboard);
   - urobiť logický dump;
   - rozhodnúť o dočasnom PITR (platené, voliteľné).
8. Spustiť `scripts/sql/einvoice-prod-precheck.sql` na produkcii (read-only) — súhlas; pri STOP stop.
9. Produkčné migrácie (runbook M-1/M-2), merge a produkčný deploy, smoke test, import ECB.
10. Production env eFaktúry vrátane live kľúča, webhook v portáli a webhook secret.
11. Alerting:
    - secret `ESBLU_CRON_SECRET` v GitHub;
    - workflow skopírovať na `main`;
    - overiť plán Actions minút.
12. Zapojenie internej firmy (`einvoice_rollout = internal`), potom pilot — rozhodnutie o rollout-e.
