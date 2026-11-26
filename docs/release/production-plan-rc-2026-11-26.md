# Esblu — produkčný postup release RC 2026-11-26 (migrácie, záloha, smoke test)

Stav: **PRIPRAVENÉ, NEVYKONANÉ.** Každý krok § 2–5 sa vykoná až po výslovnom schválení vlastníka.
Produkčný projekt Supabase `fkpgvgvsmbpieduoatrt` (assetpilot); kód `release/rc-2026-11-26`.

## 1. Východisko a stop kritériá

Release: vetva `release/rc-2026-11-26`; aplikačný kód = `18faaf4` (Preview `dpl_5E7CkBqLissNMUpKzwDEQ9tGYB4g` READY).
Nasledujúce lokálne commity menia iba `docs/` a `scripts/ops/` (nie aplikáciu).

Produkčné premenné (Vercel, production; iba názvy): Supabase URL/anon/service role, `OPENAI_API_KEY`, `CRON_SECRET`,
VAPID, FCM, `ESBLU_ACTION_CONFIRMATION_SECRET`, `ESBLU_INTAKE_ATTEST_SECRET`, `NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS` — release
nevyžaduje žiadnu novú povinnú premennú (nová voliteľná `ESBLU_EINVOICE_INBOUND_QUARANTINE_ACK`, default vypnuté);
žiadne `STRIPE_*`, `ESBLU_BILLING_*`, `ESBLU_EFAKTURA_*`, `ESBLU_FAKE_*` → billing aj eFaktúra vypnuté; `vercel.json`
(crony), `next.config.ts`, `proxy.ts` bez zmeny oproti produkcii.

- Produkcia: kód `6506e11` (`dpl_5GjvYbFswRpthUwLyHvnUJWFsaoa`), posledná migrácia `20261123120000_billing_ops_alerts`.
- STOP pred začiatkom, ak: `list_migrations` obsahuje čokoľvek po `20261123120000`; security advisors majú ERROR;
  existuje otvorený `billing_ops_alerts`; prebieha ukončenie firmy (`company_terminations.status = 'executing'`).
- STOP počas, ak: migrácia zlyhá, post-check nesedí, advisors ERROR, alebo runtime errors > 0 počas 15 min po deployi.

## 2. Záloha a overenie obnovy (pred prvou migráciou)

### 2.0 Inventúra produkcie (read-only, 2026-11-26) — `docs/release/prod-inventory-2026-11-26.json`

112 public tabuliek / 2 474 riadkov (z toho `fx_reference_rates` 2 175), 4 firmy, 5 členstiev, 0 faktúr, 0 predplatných,
1 interný grant; Auth 5 používateľov / 6 identít / 0 MFA; Storage 9 bucketov, 9 objektov / 1 114 838 B
(ai-evidence 2, ai-inbox 4, company-logos 2, machine-photos 1); 120 migrácií (posledná z repa `20261123120000`);
security advisors 0 ERROR. Odtlačky každej tabuľky, Auth a Storage sú v JSON (dva behy zhodné). Zistenie: 1 záznam
`inventory_photos` odkazuje na neexistujúci súbor (existujúci stav, nie chyba releasu).

### 2.1 Automatické zálohy Supabase (platforma)

- Organizácia „Esblu s.r.o.“ = plán **Pro** → denné zálohy, dostupných **posledných 7 dní**; Postgres 17.6 → fyzické zálohy
  (obnova celého projektu v Dashboarde, s výpadkom; nie sú na stiahnutie). PITR nie je potvrdené (doplnok).
- Zálohy platformy **neobsahujú súbory Storage** (iba metadáta) — preto vlastná záloha 2.2.
- Dostupnosť a čas poslednej zálohy agent overiť nevie (Management API vyžaduje osobný token) → **vlastník:** Dashboard →
  Database → Backups → snímka s časom poslednej zálohy (≤ 24 h).
Zdroj: supabase.com/docs/guides/platform/backups.

### 2.2 Čerstvá šifrovaná záloha (DB + Auth + Storage) — vlastník na svojom PC

Nástroj `scripts/ops/esblu-daily-backup.mjs` (iba čítanie: PostgREST, Auth Admin, Storage list/GET; AES-256-GCM + RSA-4096;
cieľ mimo repa a OneDrive; súkromný kľúč offline):
1. Raz: `node scripts/ops/esblu-daily-backup.mjs --init-keys <USB>` (súkromný kľúč s heslom na USB, verejný na PC).
2. `scripts/ops/esblu-daily-backup.ps1 -Setup` (serverový kľúč produkcie sa zadá skryto, uloží cez DPAPI; nikdy do súboru/logu).
3. Beh: `scripts/ops/esblu-daily-backup.ps1` → súbor `esblu-prod-<čas>.esblubk2` + `last-success.json` (počty bez osobných údajov).
4. `node scripts/ops/esblu-daily-backup.mjs --verify <súbor> <private.pem>` → integrita.
Doplnok pre heslá Auth (logická záloha ich neobsahuje — obnova by vyžadovala reset hesiel): denná fyzická záloha platformy
(2.1) obsahuje celú schému `auth`; voliteľne `supabase db dump --linked --schema auth --data-only -f auth-<čas>.sql`
(heslo DB iba u vlastníka; súbor zašifrovať a uložiť mimo PC).

### 2.3 Test obnovy v izolovanom prostredí (bez zásahu do produkcie)

1. `node scripts/ops/esblu-daily-backup.mjs --extract <súbor> <private.pem> <dočasný priečinok mimo repa>`
2. `node --experimental-strip-types --no-warnings scripts/ops/esblu-restore-verify.ts <priečinok> docs/release/prod-inventory-2026-11-26.json --max-version 20261123120000`
   — PGlite v pamäti, bez siete: schéma z migrácií v stave produkcie → Auth (id, e-mail) → `restore-public-data.sql`
   (jedna transakcia, kontrola počtov) → porovnanie s inventúrou: počty riadkov každej tabuľky (povinné), odtlačky
   (informatívne), Storage počty a bajty po bucketoch, počet Auth používateľov. Výstup `RESTORE_VERIFY_OK` / `_FAIL`.
3. Dočasný priečinok zmazať (obsahuje osobné údaje).
Overenie nástroja: `scripts/ops/esblu-backup-pglite-tests.ts` 15/15 (vrátane novej kontroly: zhoda → OK, zmenený počet
riadkov / Auth / bajtov → 3 chyby).
Ak sa medzi inventúrou a zálohou zmenia údaje (registrácie), inventúru zopakovať tesne pred zálohou (rovnaké SQL).

### 2.4 Obnova pri zlyhaní

(a) kód — Vercel instant rollback na `dpl_5GjvYbFs…`; (b) schéma — rollback súbory v opačnom poradí (§ 3);
(c) poškodenie dát — obnova projektu z dennej zálohy platformy (Dashboard, výpadok) a súborov Storage z 2.2;
(d) cielená oprava dát — z extrahovanej zálohy 2.2 (iba dotknuté riadky, po schválení).

## 3. Migrácie (10, bez `20261121100000`)

Nástroj: Supabase `apply_migration` na `fkpgvgvsmbpieduoatrt`, obsah = súbor z `supabase/migrations/` (bez úprav),
po jednej. Po každej: `list_migrations` (nový riadok), post-check, security advisors (0 ERROR).

| # | Migrácia | Pre-check | Post-check | Rollback |
| --- | --- | --- | --- | --- |
| 1 | `20261122100000_einvoice_mandates` | tabuľka `einvoice_mandates` neexistuje | tabuľka + RLS; `anon`/`authenticated` bez priamych práv mimo manifestu | `supabase/rollback/20261122100000_…` |
| 2 | `20261122110000_einvoice_deregistration_jobs` | #1 hotová | tabuľka `einvoice_deregistrations` | rollback súbor |
| 3 | `20261122120000_einvoice_ops_alerts` | #2 hotová | tabuľka `einvoice_ops_alerts` | rollback súbor |
| 4 | `20261124100000_billing_document_company_link` | `billing_invoice_documents` = 0 riadkov | trigger väzby existuje; 0 zmenených riadkov | rollback súbor |
| 5 | `20261125100000_einvoice_inbound_quarantine` | — | tabuľky `einvoice_inbound_scan_state`, `einvoice_provider_rate_window`; RLS politika R3 | rollback súbor |
| 6 | `20261126100000_einvoice_provider_rate_classes` | #5 hotová (health funkcia ju používa) | 14 kvót; 3 funkcie bez EXECUTE pre anon/authenticated | rollback súbor |
| 7 | `20261127100000_company_termination_customer_delete` | žiadne ukončenie v stave executing | `esblu_company_termination_execute` existuje; 4-arg `commit` fail closed | rollback súbor |
| 8 | `20261128100000_termination_purge_export_integrity` | #7 hotová | `company_export_run_files`, `einvoice_misdelivery_incidents`, funkcia odtlačku | rollback súbor |
| 9 | `20261129100000_privacy_policy_1_5_resend` | `legal_documents` bez `privacy_policy 1.5` | riadok 1.5, `content_hash` = `3de5c158…51ce` | fail closed po prvom potvrdení |
| 10 | `20261129110000_terms_1_3_subscription` | bez `terms 1.3` | riadok 1.3, hash `691d4455…5111`, `reaccept_notice_days` 30 | fail closed po prijatí/oznámení |

Kontrola nevykonania `20261121`: po #10 `select to_regnamespace('esblu_retention')` = null.
Závislosti overené: žiadna z 10 nepoužíva objekt definovaný iba v `20261121` (27 objektov); replay „prod-like“ bez nej PASS;
staging má #1–#10 (+ historickú `21`).

Poradie s kódom: migrácie #1–#10 → merge PR `release/rc-2026-11-26` → `main` → Vercel production deployment pre presný
SHA → smoke § 4. Starý kód nad novou DB: ukončenie firmy fail closed, ostatné bez zmeny (bezpečné okno medzi krokmi).

## 4. Produkčný smoke test (www.esblu.com, po deployi)

Anonymne (agent):
- [ ] `/`, `/login`, `/cennik`, `/kontakt`, `/podmienky-pouzivania` (VOP 1.3 + archív 1.2/1.1/1.0), `/ochrana-osobnych-udajov` (1.5, 23.11.2026), `/subprocessors` (Resend), `/dpa` (1.3), `/cookies`, `/zrusenie-uctu`, `/.well-known/assetlinks.json`, `/manifest.json` = 200
- [ ] `/nastavenia/predplatne/fake-checkout` = **404**
- [ ] `/api/billing/checkout`, `/api/billing/purchase-intent` (POST) = `ESBLU_BILLING_DISABLED`; `/api/einvoice/webhook` = `NOT_CONFIGURED`
- [ ] `/api/cron/*` bez tajomstva = 401; `/api/company/export`, `/api/account/delete` bez prihlásenia = 401
- [ ] Cenník: eFaktúra „Pripravujeme“, žiadne tlačidlo platby
- [ ] Mobil 375 px: `/`, `/login` bez horizontálneho posunu

Prihlásený vlastník (vlastník, vlastný účet; agent heslá nezadáva):
- [ ] prihlásenie → výzva potvrdiť Zásady 1.5 → potvrdenie
- [ ] firma: oznámenie VOP 1.3 s lehotou 30 dní (bez blokovania)
- [ ] dashboard, vozidlá, stroje, sklad, faktúry (otvorenie zoznamu), partneri, chat — bez chyby
- [ ] koncept faktúry vytvoriť a zmazať (nefinalizovať)
- [ ] export firmy (Nastavenia) dokončený
- [ ] Predplatné: žiadna možnosť platby kartou

Agent (read-only): advisors 0 ERROR; `list_migrations` = 10 nových; Vercel runtime errors 0 / 30 min; `internal_operator_grants` bez zmeny.

## 5. Rollback

1. Kód: Vercel → Instant Rollback na `dpl_5GjvYbFswRpthUwLyHvnUJWFsaoa` (`6506e11`).
2. DB (iba ak je chyba v schéme): rollback #10 → #1 v opačnom poradí; #9/#10 iba pred prvým potvrdením/prijatím.
3. Dáta: obnova zo zálohy iba pri preukázanom poškodení (§ 2).

## 6. Blokátory podľa rozsahu (stav 2026-11-26)

**Bránia webovému release (trial / bez platieb):**
1. ~~Používateľský smoke test Preview po prihlásení~~ — **vykonal vlastník 2026-11-26 (vrátane mobilu): OK**.
2. Staging test reálneho výmazu D-T1 / D-T2 / D-PERF (nový kód ukončenia firmy) — runner vlastníka.
3. Záloha a test obnovy produkcie (§ 2.1–2.3).
4. Schválenie tohto postupu (migrácie #1–#10, merge, deploy).

**Bránia iba Stripe LIVE:** aktivácia Stripe účtu Esblu s. r. o.; odpovede účtovníčky (Ú1–Ú9); restricted kľúč + webhook
(Sensitive env); kontrola prijatia aktuálnych VOP pred checkoutom (odporúčanie); interný nákup + refund; samostatné schválenie.

**Bránia iba eFaktúre LIVE:** úplná kontrola zmluvy PC-2026-0050 (str. 5–13 + prílohy nedostupné agentovi); podpis a
úhrada; DPA 1.4 (eFaktura.sk) + oznámenie existujúcim firmám (DPA 1.3 čl. 9.3); text mandátu (DRAFT); LIVE kľúč, WAF,
brána G1–G12; samostatné schválenie.

## 7. Účty na stagingu (read-only, 2026-11-26)

29 účtov Supabase Auth na `esblu-test`:
- 1 skutočný účet vlastníka `roi***@gmail.com` (heslo + identita email, posledné prihlásenie 27. 10.; vlastník firiem
  „Anchar Bau (STAGING)“, „QA UX Firma A“, „QA UX Firma B“) — **jediný účet použiteľný na smoke test bez zásahu**; heslo
  pozná/obnoví iba vlastník (e-mail na obnovu príde do jeho schránky).
- 16 syntetických účtov (`*@esblu-qa.invalid`, `*@example.com`) s heslom a identitou, neblokovaných — heslá náhodné a
  neznáme; použiť ich by vyžadovalo zmenu hesla cez Admin API (zásah do účtu) → nepoužité.
- 12 syntetických účtov vytvorených SQL (bez identity a/alebo bez hesla, prípadne zablokovaných) vrátane P15 T1/T2/PERF/ISO
  — nepoužiteľné na prihlásenie a ISO sa nikdy nesmie prihlásiť (brána výmazu).
Žiadny účet sa nevytváral ani nemenil.
