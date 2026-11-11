# J10 — CLIA GDPR reconciliation (2026-11-10, follow-up J10.1 2026-11-11)

> **Aktuálny stav po stanovisku CLIA z 11.11.2026: pozri §18.** Otázky v §16 sú uzavreté (§18.1). Sekcia §8 (Anthropic
> alternatíva A) je prekonaná — CLIA potvrdila Anthropic ako ďalšieho sprostredkovateľa.

Zdroj: balík CLIA **„GDPR Esblu“ z 09.11.2026** (Manuál implementácie Nariadenia GDPR v1.0, Zásady spracúvania
osobných údajov, Smernica o ochrane osobných údajov v1.0, Zmluva o spracúvaní osobných údajov + prílohy 1–3,
Záznam o spracovateľských činnostiach prevádzkovateľa / sprostredkovateľa (XLSX), 6 testov proporcionality).
Balík je uložený iba lokálne (`legal-inbox/`, mimo gitu). **Interné dokumenty (smernica, testy proporcionality,
záznamy) sa do repa ani na web nekopírujú** — tento dokument obsahuje iba audit a návrhy delta.

Audit: RC `e855664` (worktree `j10-clia`), staging `esblu-test` (`cjbdijbbcujvmrzezusd`, eu-west-1), Vercel projekt
`esblu` (read-only metadáta), produkcia **iba read-only metadáta** (región projektov). Claude nerobí právne
rozhodnutia — body s právnym dopadom sú označené **LEGAL CONFIRMATION REQUIRED (LCR)**.

Statusy: PASS · TECH GAP · DOC GAP · LCR · NOT YET LIVE · N/A. „FIXED J10“ = tech gap opravený v tomto bloku.

---

## 1. Role Esblu

| režim | činnosti (CLIA manuál 1.1) | realita v produkte | status |
|---|---|---|---|
| prevádzkovateľ | registrácia, účty, autentifikácia, zmluvné vzťahy (acceptance), prevádzková komunikácia, podpora, bezpečnosť | `auth.users`, `company_members`, `company_invites`, `user_legal_acceptances`, `company_dpa_acceptances`, push identifikátory + nastavenia, technické logy, e-mail info@/privacy@ | PASS |
| sprostredkovateľ | dokumenty, faktúry, evidencie, fotografie, interné správy, ďalší obsah Zákazníka | `documents`, `ai_evidence`, `invoices*`, `business_partners`, `vehicles*`, `machines*`, `inventory*`, `chat_*`, Storage buckety, AI spracovanie (OpenAI) | PASS |

Zámena režimov nenájdená. Hraničné prípady: (a) push identifikátory = prevádzkovateľ, obsah notifikácie = obsah
Zákazníka (LIA push to tak rozlišuje — PASS); (b) AI usage telemetria (`ai_usage_monthly`, iba čísla, bez
user_id) = technická prevádzka prevádzkovateľa — v dokumentoch CLIA nie je uvedená → DOC GAP (informatívne).

## 2. CLIA requirement matrix

| # | požiadavka CLIA | zdroj | realita Esblu (RC + J10) | status | gap / akcia |
|---|---|---|---|---|---|
| R1 | Privacy Policy na samostatnej podstránke „Ochrana osobných údajov“, verejná bez loginu | Manuál 2.1.2 | `/ochrana-osobnych-udajov` server page bez auth (proxy matchuje iba `/api/*`); nadpis „Ochrana osobných údajov“; J10: obsah = CLIA text v1.4 | PASS (FIXED J10 obsah) | — |
| R2 | odkaz v pätičke webu | 2.2.1 a | `PublicLandingPage` päta, `PublicLegalLayout` päta | PASS | — |
| R3 | odkaz na registračnej a prihlasovacej obrazovke | 2.2.1 b | `/login` (registrácia aj login) — checkbox + päta; **chýbal** na `/invite` (registrácia pozvaného) a `/reset-hesla` | FIXED J10 | `AuthLegalLinks` na `/invite` a `/reset-hesla` |
| R4 | odkaz v nastaveniach účtu / trvalo dostupnej sekcii | 2.2.1 c | `/nastavenia` → „Právne informácie“ (privacy, terms, cookies, DPA, subprocesori, kontakt) | PASS | — |
| R5 | odkaz v mobilnom rozhraní | 2.2.1 d | mobilný bundle re-exportuje `/nastavenia`, `/login`, legal routes; mobile Turbopack build 34/34 | PASS | — |
| R6 | samostatné potvrdenie oboznámenia v znení CLIA, s odkazom na aktuálnu PP | 2.2.2 | samostatný checkbox existoval; J10: SK text = presné odporúčané znenie („…so Zásadami spracúvania osobných údajov spoločnosti Esblu s. r. o.“), odkaz na `/ochrana-osobnych-udajov` | FIXED J10 (text) | DE gramatika opravená |
| R7 | potvrdenie je informačné, nie súhlas podľa čl. 6(1)(a) | 2.2.3 | separátny typ `privacy_policy` v `user_legal_acceptances`, wording „Potvrdzujem…“ | PASS | — |
| R8 | evidovať dátum, čas a verziu PP, ktorá bola sprístupnená | 2.2.4 | `accepted_at` (DB čas), `version`, `acceptance_method`; **gap:** pri e-mailovom potvrdení sa zapisovala verzia aktuálna pri onboardingu, nie zobrazená | FIXED J10 | verzie zobrazené pri odškrtnutí → `user_metadata.esblu_legal_ack` → onboarding ich zapíše |
| R9 | re-accept pri zmene verzie | (systém) | `LegalAcceptanceGate` pre každý nový `required` riadok; privacy 1.4 `required = true` | PASS | IP/UA/locale sa neevidujú — CLIA to nevyžaduje |
| R10 | invite registrácia — potvrdenie | 2.2.2 | pozvaný používateľ potvrdí PP cez `LegalAcceptanceGate` pred akýmkoľvek použitím (metóda `legal_gate`, čas, verzia) — nie na samotnej obrazovke | PASS s poznámkou | voliteľne checkbox priamo na `/invite` (OWNER) |
| R11 | PP placeholder cookies doplniť podľa reálnej techniky | PP „Používanie cookies…“, Manuál 6.2.1 | J10: zástupný riadok nahradený odkazom „[Informácie o cookies](/cookies)“ | FIXED J10 | LCR Q4 (potvrdiť formu doplnenia) |
| R12 | SK originál vs. EN/DE | zadanie | 1.4 iba SK; EN/DE zobrazí SK text + upozornenie „k dispozícii iba v slovenskom pôvodnom znení“ (žiadny neautorizovaný preklad) | PASS | LCR Q5 (finálne preklady + klauzula prednosti) |
| R13 | DPA uzatvorená s každým Zákazníkom pred začatím spracúvania | 3.1.2 | in-app owner-only acceptance `company_dpa_acceptances` (verzia, čas, user, firma); DB triggre blokujú nové záznamy s OÚ; **gap:** AI routy posielali obsah do OpenAI aj bez DPA | FIXED J10 (AI) + LCR Q1 | DPA brána pred OpenAI (scan, vozidlá, hlas, intent fallback); forma uzatvorenia = LCR |
| R14 | evidencia a aktualizácia DPA pri zmene rozsahu / subprocesorov | 3.2.1 | verzovanie DPA + re-accept pri novej verzii; CLIA DPA (nová šablóna) **zatiaľ nepublikovaná** v appke | LCR | Q1, Q2 (Anthropic v prílohe 3) |
| R15 | smernica schválená štatutárom, dátum účinnosti, verzia | 4.1.1, Smernica 13.1 | CLIA v1.0 bez dátumu schválenia / podpisu | PENDING OWNER | runbook `docs/gdpr-internal-compliance-runbook.md` §1 |
| R16 | oboznámenie ďalších osôb so smernicou | 4.1.3 | dnes jediný konateľ; žiadni ďalší zamestnanci s prístupom | N/A (dnes) | runbook §2 |
| R17 | smernica nie je verejná | 4.2.1 | nie je v repe ani na webe | PASS | — |
| R18 | testy proporcionality / záznamy interné, nezverejňovať, aktualizovať | 5.1–5.2 | iba lokálne `legal-inbox/` (gitignore cez `.git/info/exclude`) | PASS | runbook §3 (úložisko) |
| R19 | reálny audit cookies a obdobných technológií | 6.1 | J10 inventár (§4) — žiadne cookies, žiadna analytika | PASS | — |
| R20 | sekcia „Informácie o cookies“ s prehľadom | 6.2.1 | J10: `legal/cookies/1.1*.md`, titul „Informácie o cookies“ | FIXED J10 | — |
| R21 | lišta iba ak sú nepovinné technológie | 6.2.2–6.2.4 | žiadne nepovinné analytické/marketingové → **bez lišty**; CMP (CookieYes) nepridaný | PASS | LCR Q6 (preferenčné localStorage kľúče = výnimka?) |
| R22 | funkčnosť odkazov, preukázateľnosť DPA, retencia ↔ technika | 7.1 | testy `test:clia-gdpr`, `test:clia-gdpr-db`; retencia §5 | PASS / PARTIAL | — |
| R23 | technický výmaz vrátane príloh, logy, admin prístupy, zálohy | 7.2 | §6; **gap:** chat prílohy pri zrušení firmy ostávali v Storage | FIXED J10 | zálohy 7 dní — §6 |
| R24 | pri rozšírení AI / nových providerov preveriť dokumenty + DPIA | 7.3 | J10 §9 DPIA podklad | LCR Q7 | — |
| R25 | DPA 5.5 / príl. 1 §3: zákaz trénovania AI na dátach Zákazníka; prod dáta pre vývoj iba na pokyn | DPA | OpenAI API (`store:false`, bez Files/Threads/Vector Stores); dev/test na syntetických dátach (staging `@esblu-qa.invalid`) | PASS | Anthropic → §8 |
| R26 | DPA príl. 2: signed URL ≤ 1 h | DPA príl. 2, Smernica 9.2.3 | všetky `createSignedUrl` 60–3600 s (max 3600) | PASS | — |
| R27 | DPA príl. 2: notifikácie bez príloh a úplného obsahu | DPA príl. 2 | chat push = generický text; náhľad iba pri `show_message_preview` (default false, **v UI sa nedá zapnúť**); termíny = iba počet | PASS (bezpečnejšie) | DOC GAP: príl. 3 FCM uvádza „úvodná časť správy, ak si ju Používateľ aktivoval“ — dnes nedostupné |
| R28 | DPA príl. 2: AI extrakciu Používateľ kontroluje a potvrdzuje pred uložením | DPA príl. 2 | scan → editovateľné polia + „needs_review“; uloženie až po „Uložiť“; prijaté faktúry bez potvrdenia nič nevytvoria; **výnimka:** intake bez finance oprávnenia uloží šifrovaný AI návrh + originál so stavom `needs_review` pred potvrdením | PASS s poznámkou | DOC/LCR Q8 (intake návrh pred potvrdením) |
| R29 | DPA príl. 2: Frankfurt (Supabase + Vercel funkcie) | DPA príl. 2 | prod Supabase `eu-central-1`; Vercel `serverlessFunctionRegion = fra1` (overené Vercel API) | PASS | staging je eu-west-1 (iba syntetické dáta) |
| R30 | DPA príl. 2: HTTPS, šifrovanie v pokoji, RLS/oddelenie Zákazníkov | DPA príl. 2 | HTTPS, Supabase encryption at rest, RLS + `esblu_my_active_company_id()`; grants replay 43/43 | PASS | — |
| R31 | Smernica 6.3.2: evidencia admin zásahov do produkčných OÚ | Smernica 6.3 | **žiadny technický log** admin zásahov (Supabase dashboard / MCP SQL); CLIA register sám uvádza „nie je potvrdený“ | TECH/ORG GAP | runbook §4 (manuálny log, ≤ 12 mes.) |
| R32 | Smernica 9.2.2: evidencia exportov mimo funkcionalít | Smernica 9.2 | žiadne mimoaplikačné exporty dnes | PASS (proces) | runbook §4 |
| R33 | Smernica 10.3: evidencia bezpečnostných udalostí / porušení | Smernica 10.3 | `docs/data-breach-procedure.md` existuje; register uvádza „nepotvrdený“ | DOC GAP | runbook §5 |
| R34 | práva dotknutých osôb cez privacy@esblu.com, lehota 1 mesiac, evidencia 3 roky | Smernica 4, PP | privacy@ (Namecheap); self-service zrušenie účtu; evidencia žiadostí neexistuje | ORG GAP | runbook §6 |
| R35 | Terms/VOP | — | **nie sú súčasťou balíka CLIA 09.11.2026** (balík = GDPR) | N/A | J9 predpoklad opravený v checkliste |

## 3. Privacy Policy, potvrdenie, DPA — implementácia

**Privacy Policy 1.4** (`legal/privacy/1.4.md`): slovenský text CLIA prevzatý **doslovne** (overené tokenovým
diffom voči DOCX: 6 335 tokenov zhodných, jediný rozdiel = vložený odkaz „Informácie o cookies“ na mieste
zástupného riadku). Tabuľky CLIA sú zobrazené ako zoznamy „**Účel spracúvania:** …“ (renderer nepodporuje
tabuľky; obsah bez zmeny). Nové verzie: `legal_documents` seed (migrácia `20261110110000`), `legalConfig`.
Preklepy v CLIA texte ponechané (napr. „Hlavýnm“, „(USA môže“ bez zátvorky, „k dispozícií“) → hlásené CLIA (Q10).

**Potvrdenie pri registrácii:** existujúci model (samostatný checkbox `privacy_policy`, záznam
`user_legal_acceptances`) spĺňa 2.2.2–2.2.4 → paralelný systém sa nevytváral. Zmeny: text podľa CLIA, verzia
zobrazená pri odškrtnutí (2.2.4), DE gramatika.

**DPA — presný model nájdený v repe:**

- tabuľka `company_dpa_acceptances` (`company_id`, `document_type='dpa'`, `version`, `accepted_by`, `accepted_at`,
  `acceptance_method='company_dpa_gate'`; unique company+verzia); RLS: čítajú aktívni členovia firmy;
- uzatvára **iba owner** (`esblu_accept_company_dpa` odmieta admin/employee/accountant), iba aktuálna verzia;
- `CompanyDpaGate`: owner = blokujúci overlay s checkboxom „Potvrdzujem, že som oprávnený/á konať za túto firmu
  a v jej mene prijímam Zmluvu o spracúvaní osobných údajov (DPA), verzia X.“; ostatní = banner;
- vynútenie: DB trigger `ESBLU_COMPANY_DPA_NOT_ACCEPTED` na nové záznamy (documents, ai_evidence, vehicles*,
  machines*, inventory*, vehicle_photos/vignettes, chat_messages/attachments); faktúry a partneri iba UI;
  **J10:** AI routy (scan-document, scan-vehicle-registration, scan-vehicle-doc, transcribe, intent AI fallback)
  odmietnu odoslanie do OpenAI bez prijatej DPA (fail closed);
- zobrazenie: verejná `/dpa` (HTML), **bez PDF / stiahnutia**, stav DPA firmy sa v Nastaveniach nezobrazuje;
- aktuálna publikovaná DPA = Esblu verzia **1.2** (nie CLIA šablóna). CLIA šablóna má zmluvné strany s
  prázdnymi poľami, podpisové riadky, čl. 10.1 „účinnosť dňom podpisu oboma Zmluvnými stranami“ a čl. 11.7
  „dva rovnopisy“ → **LCR Q1**. CLIA DPA sa v J10 **nepublikovala**.

## 4. Cookies / storage inventár (web + PWA + mobil)

Overené v kóde (`document.cookie`, `cookies()`, `Set-Cookie`, localStorage/sessionStorage, IndexedDB, Cache
Storage, SW, Supabase Auth, OAuth, Firebase/Web Push, Vercel, 3rd-party skripty). Test `test:clia-gdpr` stráži,
že každý `esblu…` kľúč v kóde je v inventári a že kód nenastavuje cookies ani nevkladá analytiku.

| NAME | TYPE | PROVIDER | PURPOSE | RETENTION | NECESSARY? | CONSENT? | SOURCE |
|---|---|---|---|---|---|---|---|
| `sb-<ref>-auth-token` | localStorage (web) / Keystore·Keychain (mobil) | Supabase Auth | session | do odhlásenia | áno | nie | `lib/supabase.ts`, `lib/mobile/secure-storage.ts` |
| `sb-<ref>-auth-token-code-verifier` (+ `-flow-*`, `-flows-*`) | localStorage / secure storage | Supabase Auth | PKCE pri Google OAuth | do výmeny / odhlásenia | áno | nie | auth-js |
| `esblu.oauthPending.v1` | localStorage | Esblu | návrat z OAuth, legal tick, invite | ≤ 15 min, zmaže sa | áno | nie | `lib/auth/oauth-client.ts` |
| `esblu.partnerPrefill.v1` | sessionStorage | Esblu | prenos údajov z asistenta do formulára | ≤ 10 min / karta | áno | nie | `lib/partner-prefill.ts` |
| `esblu.dashboard.focus.v1` | sessionStorage | Esblu | posledný modul | karta / odhlásenie | áno (UI stav) | nie | `Dashboard.tsx` |
| `/sw.js` | Service Worker | Esblu | zobrazenie push + klik; **bez cache** | do vypnutia push | áno (po opt-in) | nie (permission) | `public/sw.js` |
| Web Push subscription | browser push store | Google/Mozilla/Microsoft/Apple | doručenie web push | do odhlásenia odberu | áno (opt-in) | nie | `lib/push/client.ts` |
| `esblu.push.native.enabled`, `esblu.push.installationId` | localStorage (natívny WebView) | Esblu | stav push + ID inštalácie | do vypnutia / odinštalovania | áno | nie | `lib/push/native.ts` |
| FCM installation ID / token | natívne úložisko (Android) | Google Firebase | natívny push | spravuje Firebase | áno (opt-in) | nie | `@capacitor/push-notifications` |
| `esblu_locale` | localStorage | Esblu | jazyk UI | trvalé | používateľská voľba | technicky nie (LCR Q6) | `lib/i18n/locales.ts` |
| `esblu.preferredCompany.<userId>` | localStorage | Esblu | naposledy zvolená firma | trvalé | voľba používateľa | technicky nie (LCR Q6) | `lib/company-preference.ts` |
| `esblu.dashboard.firstSteps.dismissed.v1:<companyId>` | localStorage | Esblu | skrytá karta | trvalé | UI voľba | technicky nie | `Dashboard.tsx` |
| `esblu.chat.bubble.position.v1`, `esblu.mobile.chatFab.position.v1` | localStorage | Esblu | poloha tlačidla | trvalé | UI voľba | technicky nie | chat widget |
| `esblu.voiceReplies.v1` | localStorage | Esblu | hlasové odpovede on/off | trvalé | voľba | technicky nie | `lib/voice/speech.ts` |
| cookies | — | — | **žiadne** first-party cookies; Vercel `_vercel_jwt` iba na chránených preview (nie produkcia); Google/Stripe cookies iba na ich doménach | — | — | — | `proxy.ts`, `vercel.json` |
| IndexedDB / CacheStorage | — | — | **nepoužité** | — | — | — | grep |
| analytika / marketing / 3rd-party skripty / embedy | — | — | **žiadne** (fonty Geist self-hosted cez `next/font`) | — | — | — | `app/layout.tsx` |

**Cookie lišta: NIE JE POTREBNÁ** (manuál 6.2.2). Žiadny CMP sa nepridal. J10 minimalizácia: odhlásenie v
natívnej appke už nevytvára nové `esblu.push.installationId` (predtým vznikalo aj bez push).

## 5. Retencia — CLIA vs. skutočnosť

| kategória | CLIA max | skutočnosť pred J10 | po J10 | status |
|---|---|---|---|---|
| údaje účtu po zrušení | ≤ 30 d | okamžitý výmaz (DB commit + auth retry cron ≤ 30 pokusov / 24 h backoff) | bez zmeny | PASS (kratšie) |
| neúspešné registrácie | ≤ 30 d | nepotvrdené `auth.users` navždy | cron maže nepotvrdené bez členstva/firmy > 30 d | FIXED J10 |
| neprijaté pozvánky | ≤ 30 d po expirácii/zrušení | navždy | purge > 30 d (pending/expired/revoked); prijaté ostávajú | FIXED J10 |
| login technické logy | ≤ 90 d | Supabase Auth logy (provider, plán Pro — kratšie ako 90 d) | — | PASS (provider) |
| zmluvné / acceptance záznamy | vzťah + ≤ 5 r | `user_legal_acceptances` sa mažú **so zrušením účtu**; `company_dpa_acceptances` so zrušením firmy | bez zmeny | PASS (kratšie) + **LCR Q3** (dôkaz po zrušení?) |
| e-mail auth/prevádzkové logy | ≤ 90 d | Supabase built-in mailer (provider logy); žiadny vlastný log | — | PASS |
| jednorazové overovacie / reset údaje | ≤ 24 h | Supabase OTP/recovery (provider, platnosť ≤ 24 h); invite token hash v `company_invites` (7 d) | invite purge 30 d po expirácii | PASS |
| push identifikátory | aktívne + ≤ 30 d po deaktivácii | soft-revoke, **revoked riadky navždy**; revoke sweep sa preskočil bez providera | purge revoked > 30 d; sweep beží vždy | FIXED J10 |
| nastavenia notifikácií | účet + ≤ 30 d | cascade s účtom / firmou | — | PASS |
| push delivery metadáta | ≤ 90 d | chat 7 d; **deadline navždy** | všetky > 90 d (vedľajší účinok: dlho neriešený termín po splatnosti sa pripomenie znova max. raz / ~90 d) | FIXED J10 (OWNER NOTE) |
| zákaznícka podpora | ≤ 12 mes. | e-mailová schránka Namecheap, bez retencie v appke | runbook §6 | ORG |
| technické/prevádzkové logy | ≤ 90 d | Vercel runtime logy (provider, kratšie); `account_deletion_cleanup_jobs` navždy; `assistant_action_confirmations` navždy; `media_deletion_queue` dokončené navždy; `einvoice` webhook 90 d | purge jobs > 90 d, media fronta > 90 d, expirované asistent záznamy > 1 d | FIXED J10 |
| admin prístupy/zásahy | ≤ 12 mes. | žiadny log | runbook §4 | ORG GAP |
| bezpečnostné udalosti bez porušenia | ≤ 12 mes. | žiadny log | runbook §5 | ORG |
| potvrdené porušenia | ≤ 5 r | `docs/data-breach-procedure.md` | runbook §5 | ORG |
| GDPR žiadosti | ≤ 3 r | žiadna evidencia | runbook §6 | ORG GAP |
| účtovné záznamy | 10 r | faktúry finalizované = nemenné; zrušenie firmy blokované (`ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION`) | **bez zmeny** | PASS (guardy nemenené) |
| právne nároky | ≤ 5 r | žiadne osobitné uchovávanie | — | PASS (kratšie) |
| nevyhnutné cookies/úložisko | podľa účelu | §4 | — | PASS |
| `ai_usage_monthly` | (CLIA neuvádza) | 25 mes., bez user_id a obsahu | — | DOC GAP (informatívne) |
| `ai_processing_usage` / `ai_scan_usage` (user_id, hash obsahu) | (CLIA neuvádza) | s firmou; počíta trial / obdobia kvót | **nemenené** (business rule) | LCR Q9 |
| `trial_claims` (sha256 IČO) | (CLIA neuvádza) | navždy (anti-abuse) | nemenené | LCR Q9 |
| `beta_allowlist` (e-mail) | (CLIA neuvádza) | navždy | nemenené | LCR Q9 |
| zálohy | (manuál 7.2) | Supabase Pro denné zálohy 7 d, PITR vypnuté; Storage nie je v DB zálohe | — | PASS + DOC (uviesť CLIA) |

Obsah Zákazníka (chat, dokumenty, faktúry, fotky): retenciu určuje Zákazník (Smernica 11.2) — Esblu nemaže
automaticky; výmaz cez funkcie appky / zrušenie firmy. Retenčné guardy účtovníctva/eFaktúry **nemenené**.

## 6. Technický výmaz

| tok | stav | J10 |
|---|---|---|
| zrušenie účtu (global / posledná firma) | DB commit (1 transakcia) → Storage → `auth.admin.deleteUser`; retry cron 03:30; blokované, ak je používateľ autorom účtovných záznamov alebo DPA acceptance (fail closed) | — |
| odchod člena | `esblu_member_leave_company` (členstvo, chat členstvo, aktívna firma); push zariadenia tej firmy zneplatní denný sweep (`membership_ended`) → zmažú sa po 30 d | sweep beží aj bez providera |
| zrušenie firmy | owner + blocker účtovníctva/eFaktúry; zber Storage ciest; **chat prílohy chýbali** | FIXED: `chat-attachments` v zbere |
| Storage delete queue | media triggre → `media_deletion_queue` → sweep (spúšťa klient owner/admin) | dokončené riadky > 90 d sa mažú; server-side cron sweep = P2 návrh |
| orphan súbory | 5 historických sirôt (`scripts/ops/media-orphan-cleanup.mjs`, nespustené) | OWNER (produkcia) |
| signed URL | 60–3600 s (≤ 1 h podľa DPA) | — |
| auth user deletion | admin API + overenie `getUserById` | + neúspešné registrácie |
| účtovné/eInvoice guardy | `einvoice-documents` sa nikdy nemaže; firma s účtovnými záznamami sa nedá zrušiť | **nemenené** |
| zálohy | výmaz sa prejaví v zálohách najneskôr po 7 d (rotácia) | dokumentované |

## 7. Subprocesori — realita

| provider | používa sa? | produkcia? | osobné údaje | kategórie | kontext | stav | CLIA dokumenty |
|---|---|---|---|---|---|---|---|
| Supabase (Pte. Ltd.) | áno | áno (eu-central-1) | áno | všetko (DB, Auth, Storage, Realtime) | prevádzkovateľ + sprostredkovateľ | LIVE | PP, DPA p3, registre — PASS |
| Vercel Inc. | áno | áno (fra1) | áno | požiadavky, IP, obsah v serverových funkciách | oboje | LIVE | PASS |
| OpenAI (Ireland Ltd.) | áno | áno (`OPENAI_API_KEY` prod) | áno | obrazy dokumentov, techn. preukazy (vrátane údajov držiteľa), audio, text príkazov | sprostredkovateľ | LIVE | DPA p3 — PASS; staré `/subprocessors` uvádzalo iba dokumenty → FIXED J10 |
| Google — OAuth | áno | áno (`NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS`) | áno | meno, e-mail, avatar URL, Google ID (Supabase auth tabuľky) | prevádzkovateľ (zdroj) | LIVE | PP — PASS |
| Google — FCM | áno | áno (`FCM_*` prod) | áno | token, installation ID, text notifikácie | prevádzkovateľ (identifikátory) + obsah Zákazníka | LIVE | PP, DPA p3 — PASS; `/subprocessors` chýbal → FIXED J10 |
| Web Push služby prehliadačov | áno | áno (`VAPID_*` prod) | áno | endpoint, šifrovaný payload | prevádzkovateľ | LIVE | PP — PASS |
| Apple APNs | kód áno | **nie** (`APNS_*` chýba) | — | — | — | NOT YET LIVE | — |
| Namecheap Private Email | áno (info@, privacy@ schránky) | áno | áno | e-maily od používateľov | prevádzkovateľ | LIVE | PASS — §10 |
| Supabase Auth mailer | áno | áno | e-mail | auth e-maily | prevádzkovateľ | LIVE | PP: Supabase/Vercel — PASS (LCR Q11: custom SMTP?) |
| Anthropic PBC | **nie v produkte** | **nie** ako runtime | — | — | — | DEV TOOL | DPA p3 + register → §8 |
| RPO / RÚZ (statistics.sk, registeruz.sk) | áno | áno (bez env brány) | text vyhľadávania / IČO (SZČO = meno) | verejné registre | prevádzkovateľ (zdroj) | LIVE | **DOC GAP:** PP „Zdroje“ neuvádza verejné registre (Q12) |
| ECB | áno | áno | žiadne | kurzy | — | LIVE | N/A |
| eFaktura.sk | kód áno | **nie** (`ESBLU_EINVOICE_LIVE_ENABLED` nie) | (by: faktúry, partneri) | — | LCR (rola) | NOT LIVE | CLIA neuvádza — správne |
| Stripe | kód áno | **nie** (prod vždy off) | — | — | — | NOT LIVE | správne neuvedené |
| Google Play Billing / Apple StoreKit | kód áno | **nie** | — | — | — | NOT LIVE | správne neuvedené |
| Sign in with Apple | kód áno | **nie** (flag bez `apple`) | — | — | — | NOT CONFIGURED | správne neuvedené |
| hlasová syntéza prehliadača | áno (klient) | áno | text odpovede asistenta | — | — | závisí od prehliadača | informatívne (Q13) |

Pred aktiváciou eFaktúry, Stripe, Play/Apple billingu, APNs alebo Sign in with Apple je **GDPR re-review povinný**
(DPA čl. IX 15-dňová notifikácia, PP, registre, LIA).

## 8. Anthropic — verdikt

- **Produkt:** žiadna závislosť (`package.json`, lockfile), žiadny `ANTHROPIC*` env, žiadne volanie API v `app/`,
  `lib/`, `mobile/`, žiadny CI workflow. Test `test:clia-gdpr` to stráži. **Anthropic nie je runtime subprocesor
  a J10 ho nezapojil.**
- **Vývojový nástroj:** Claude/Cowork pracuje v repe a cez MCP konektory má technický prístup k Supabase
  organizácii vrátane **produkčného projektu `assetpilot`** (a Vercel). Doterajšie bloky používali produkciu iba
  read-only (metadáta, počty, precheck), ale technicky je prístup k produkčným osobným údajom možný. Presne tento
  scenár opisuje CLIA DPA príloha 3 bod 5 („prípadné osobné údaje obsiahnuté v sprístupnených produkčných
  záznamoch … podľa konkrétneho rozsahu technického prístupu“).
- Záver: tvrdenie CLIA nie je „nepravdivé“ — je **podmienené** prístupovým modelom vývojového nástroja. Projektové
  očakávanie (Anthropic NESMIE byť subprocesorom zákazníckych dát) platí iba pri organizačnom opatrení.
- **Návrh delta pre CLIA (DOC GAP, LCR Q2)** — dve alternatívy, odporúčaná A:
  - **A (odporúčané):** odstrániť Anthropic z DPA prílohy 3 a zo záznamu sprostredkovateľa (riadok 13: „OpenAI API
    a Anthropic“ → „OpenAI API“; „DPA OpenAI a prípadne Anthropic“ → „DPA OpenAI“) **pod podmienkou** záväzného
    pravidla v Smernici 7.3.2 / 10.2: AI vývojové nástroje nesmú pristupovať k produkčným osobným údajom
    Zákazníkov; MCP/DB prístup AI nástroja iba k stagingu so syntetickými dátami; produkčné zásahy výlučne
    konateľom (bez AI nástroja) alebo iba nad schémou/metadátami bez obsahových riadkov. Technicky: odobrať
    Cowork Supabase konektoru prístup k projektu `fkpgvgvsmbpieduoatrt` (OWNER ACTION).
  - **B:** ponechať Anthropic ako ďalšieho sprostredkovateľa výlučne pre technickú diagnostiku, s doložením
    Anthropic DPA (obchodné podmienky), opisom rozsahu a 15-dňovou notifikáciou Zákazníkom; v PP nie je potrebný
    (sprostredkovateľský kontext).
- Do rozhodnutia: Anthropic sa **nepridal** na verejnú stránku `/subprocessors` (bezpečnejší reálny stav — žiadny
  produktový tok).

## 9. OpenAI — verdikt

| tok | endpoint / model | dáta | `store` | kontext firmy | perzistencia u OpenAI (API) | v appke |
|---|---|---|---|---|---|---|
| sken dokumentu / prijatej faktúry | responses `gpt-5.6-terra` (+ `gpt-4.1` ŠPZ fallback) | obraz | false | žiadny (fixný prompt) | žiadne Files/Threads/Vector Stores | výsledok až po „Uložiť“ (výnimka intake, R28) |
| technický preukaz | responses `gpt-4.1-mini` | 1–2 fotky (celý doklad vrátane držiteľa) | false | žiadny | — | vozidlo až po potvrdení |
| legacy `/api/scan-vehicle-doc` | responses | obraz | false | žiadny | — | UI ho nevolá (návrh: odstrániť, P3) |
| hlas | `audio.transcriptions` `gpt-4o-transcribe` | audio (≤ limit), fixný prompt | parameter neexistuje | žiadny | — | audio ani prepis sa neukladá |
| intent fallback | responses `gpt-5.6-terra` | text príkazu ≤ 600 znakov | false | žiadny (bez DB záznamov) | — | iba keď deterministický parser zlyhá; J10: iba s DPA |

- žiadne `metadata` / `user` / `safety_identifier`; logy iba chybové metadáta; `ai_usage_monthly` iba čísla.
- „No training“: OpenAI API dáta štandardne netrénuje (zmluvné podmienky OpenAI) — **nastavenie organizácie a
  podpis OpenAI DPA nie sú v repe overiteľné** → OWNER CONFIRM. Abuse-monitoring logy OpenAI (štandardne do 30 d,
  ak nie je Zero Data Retention) — CLIA DPA nič iné netvrdí → PASS; tvrdenie „žiadne logovanie obsahu“ nepoužívať.

## 10. Namecheap / e-mail

- `info@esblu.com` + `privacy@esblu.com` (alias tej istej schránky) — Namecheap Private Email (`/subprocessors`,
  PP 1.3); v kóde jediný zdroj `lib/legal-config.ts`. `support@` neexistuje.
- Auth e-maily: Supabase built-in mailer (v repe žiadny custom SMTP, žiadna e-mailová knižnica) → zhodné s PP CLIA
  (auth oznámenia: Supabase + Vercel). **Ak je v Supabase Auth nastavený custom SMTP (napr. Namecheap), treba ho
  doplniť** → OWNER/LCR Q11.
- `esblu.office@gmail.com`: **v repe nenájdená**, do customer/support toku z kódu nevstupuje. Ak je na ňu
  presmerovaná schránka info@/privacy@ alebo ju používa konateľ na komunikáciu so Zákazníkmi, Google (Gmail/
  Workspace) by bol príjemca a musel by sa doplniť do PP/registra → OWNER CONFIRM (Q11). Smernica 10.1.3 zakazuje
  súkromné účty na spracúvanie OÚ.
- Verdikt: Namecheap aktuálny = PASS (za predpokladu bez presmerovania na Gmail).

## 11. Google / Firebase

- OAuth: bez vlastných scope (Supabase default: e-mail, profil); údaje v `auth.users`/`auth.identities`
  (Supabase); appka ich nekopíruje. PP CLIA: „prihlasovanie cez Google je dostupné vo webovom rozhraní“ — kód podporuje
  Google OAuth aj v mobile (Capacitor Browser, PKCE); či je zapnutý v mobilnom builde, určuje build env
  `NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS` → ak áno, **DOC GAP malý** (Q14).
- FCM HTTP v1 (`notification` typ), payload = generický titulok/text + `screen`, `id` (UUID), `tag`; Android
  kanál `visibility: private` na zamknutej obrazovke; náhľad správy default vypnutý a v UI nedostupný.
- Retencia tokenov: revoked → 30 d purge (J10); `push_devices` mažú aj cascade so zrušením účtu/firmy.
- Používateľské nastavenia: zapnutie/vypnutie push v Nastaveniach (`PushNotificationSettings`) + OS (LIA push tvrdí „môže meniť nastavenia“ —
  PASS; nastavenie náhľadu neexistuje — bezpečnejšie).

## 12. AI / human review (DPA tvrdenia)

| tvrdenie | realita | status |
|---|---|---|
| automatizovaná extrakcia, kontrola a potvrdenie pred uložením | áno; neisté polia `needs_review`, null pri nečitateľnom; prijatá faktúra: bez potvrdenia nič, DPH kategória bez určenia blokuje uloženie | PASS (výnimka intake R28) |
| write confirmation | write intenty `requiresConfirmation` + HMAC proof; AI nemôže mazať ani zakladať bez výslovných slov; `CREATE_INVOICE_DRAFT` bez potvrdenia = iba koncept | PASS |
| no AI SQL | AI vracia iba hodnoty z fixného zoznamu intentov | PASS |
| hlasové audio sa neukladá | iba pamäť servera | PASS |
| no training / no persistent content | `store:false`, bez Files/Threads; tréning podľa OpenAI API podmienok | PASS / OWNER CONFIRM (DPA) |

## 13. Testy proporcionality — parita

| test | realita | nález |
|---|---|---|
| registrácia a správa účtov | IČO overenie (RPO/RÚZ), closed beta allowlist, pozvánky 7 d | LIA nepomenúva overenie IČO ani verejné registre ako zdroj; podmienka „technické overenie retencie“ → J10 implementované (neúspešné registrácie, pozvánky) |
| autentifikácia | e-mail+heslo, Google (web; mobil podľa build env), Supabase Auth | malý DOC GAP, ak je Google zapnutý aj v mobile |
| zmluvné vzťahy a právne nároky | acceptance záznamy, trial | dôkaz acceptance sa maže so zrušením účtu — LCR Q3 |
| komunikácia a podpora | e-mail Namecheap; auth e-maily Supabase | PASS |
| push notifikácie | web push + FCM; **APNs neaktívne**; náhľad nedostupný | PASS; retencia implementovaná |
| technická prevádzka / cookies | iba nevyhnutné + preferenčné localStorage | LIA uvádza „cookies“ — reálne localStorage (bez cookies); admin zásahy sa nelogujú technicky → runbook |

Nová významná činnosť prevádzkovateľa bez LIA/záznamu: **vyhľadávanie v RPO/RÚZ a overenie právnickej osoby pre
trial** (IČO, hash claimov) — čiastočne kryté registrom (trial), PP to neuvádza (Q12). Nový test sa svojvoľne
nepridával.

## 14. DPIA — technický podklad (Smernica 12.2–12.4)

Nevyhlasuje sa za zákonný P0 blocker (Smernica 12.3). Pre sprostredkovateľské spracúvanie je DPIA na Zákazníkovi;
Esblu poskytuje súčinnosť (12.4) — tento podklad slúži na oboje.

- **Toky:** klient (web/PWA/Android) → Vercel fra1 (Next.js API) → OpenAI API (obraz/audio/text, `store:false`)
  → štruktúrovaný výsledok späť klientovi → uloženie až po potvrdení do Supabase eu-central-1 (DB + privátny
  Storage). Push: Supabase → Vercel cron/route → FCM / Web Push služby.
- **Modely:** `gpt-5.6-terra`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4o-transcribe`.
- **Kategórie:** identifikačné/kontaktné údaje v dokumentoch, fakturačné a bankové údaje, údaje z technických a
  poistných dokumentov (vrátane držiteľa vozidla), podpisy na skenoch, hlas (krátke nahrávky), text príkazov;
  čl. 9/10 nie sú zamýšľané (môžu sa vyskytnúť v obsahu).
- **Opatrenia:** autentifikácia + aktívne členstvo + rola + nárok + kvóta + **DPA** pred AI; RLS/tenant izolácia
  (grants replay 43/43, m1-authz 47/47); HTTPS; šifrovanie v pokoji; privátne buckety + signed URL ≤ 1 h; žiadny
  obsah v logoch; cost/abuse guard, timeouty, bez retry pri 4xx.
- **Retencia:** u OpenAI bez ukladania stavu aplikácie (`store:false`; abuse logy podľa OpenAI); v appke iba po
  potvrdení; audio a prepis sa neukladajú; telemetria iba čísla 25 mes.
- **Role/oprávnenia:** employee nemá hlas; finance oprávnenia pre faktúry; owner-only DPA.
- **Human review:** povinné potvrdenie pred uložením; zápis cez asistenta iba s potvrdením (HMAC).
- **Bez tréningu:** API podmienky OpenAI; DPA 5.5.
- **Výmaz:** funkcie appky, zrušenie firmy (Storage + DB), zálohy 7 d.
- **Reziduálne riziká:** nesprávna extrakcia (mitigované review); prenos do OpenAI (EÚ zmluvný partner, ďalšie
  prenosy podľa OpenAI DPA); citlivé údaje v dokumentoch; hlas mimo zamýšľaného obsahu.
- **LCR Q7:** odporúča CLIA dokončiť DPIA pred kontrolovaným produkčným release?

## 15. Registre (XLSX) — delta návrh (originál CLIA sa nemenil)

**Sprostredkovateľ:** C5 „XY doplniť údaje klienta“ = šablóna (vyplní sa per Zákazník alebo generický opis
„všetci Zákazníci s DPA“ → LCR); C12 „treba posúdiť podľa reálneho dátového toku“ → doplniť: Supabase
eu-central-1, Vercel fra1 (overené), prístup zmluvných partnerov SG/USA podľa ich DPA; C13/E13 Anthropic → §8
alternatíva A; F13 doplniť „DPA brána pred AI“; doplniť web push služby prehliadačov.

**Prevádzkovateľ:**

- 1 (trial / closed beta): doplniť overenie právnickej osoby cez RPO/RÚZ, `trial_claims` (hash IČO) + retenciu
  (LCR Q9), `beta_allowlist`.
- 3 (autentifikácia): Google aj v mobile; e-maily Supabase mailer.
- 4 (pozvánky): platnosť 7 d, výmaz 30 d po expirácii (J10 technicky).
- 5 (acceptance + DPA): I17 „obmedzenie akceptácie DPA na správcu účtu“ → presne „iba vlastník (owner)“; dodať, že
  acceptance záznamy sa mažú so zrušením účtu/firmy (Q3).
- Technická prevádzka 1: I19 „úplný audit administrátorských zásahov ešte nie je potvrdený“ → stav: manuálny log
  podľa runbooku §4 (žiadny technický audit log).
- 2 (incidenty): I20 → odkaz na `docs/data-breach-procedure.md`.
- Účtovníctvo 7: H26/I26 doplniť skutočný účtovný systém Esblu (OWNER).
- Podpora 1: doplniť adresy info@/privacy@ (Namecheap), Gmail iba ak sa reálne používa (Q11).
- Push 2: krátky náhľad dnes nedostupný; APNs neaktívne; retencia technicky (J10).
- Cookies 2: odkaz na `/cookies` 1.1; I35 „marketingové a analytické trackery nie sú v produkcii“ — PASS (overené).
- Chýba: AI usage telemetria (technická prevádzka, bez obsahu, 25 mes.) — informatívne; vyhľadávanie RPO/RÚZ.

## 16. Otázky pre CLIA — LEGAL CONFIRMATION REQUIRED

1. **Q1 DPA forma:** Je in-app elektronická akceptácia DPA (owner, checkbox, záznam verzia/čas/používateľ/firma)
   dostatočným spôsobom jej uzatvorenia podľa verzie CLIA z 09.11.2026, keď šablóna predpokladá podpis oboch strán
   (čl. 10.1) a dva rovnopisy (čl. 11.7)? Ak áno, prosíme o click-through verziu textu (bez prázdnych polí, s
   identifikáciou Zákazníka z účtu) a formuláciu účinnosti.
2. **Q2 Anthropic:** Súhlasíte s alternatívou A (§8) — odstránenie z DPA prílohy 3 a záznamu sprostredkovateľa pri
   záväznom zákaze prístupu AI vývojových nástrojov k produkčným OÚ — alebo trváte na B?
3. **Q3 Dôkaz acceptance:** Majú sa záznamy o prijatí Podmienok/PP/DPA uchovať aj po zrušení účtu/firmy (až 5 r.),
   prípadne pseudonymizovane? Dnes sa mažú spolu s účtom (kratšie = v súlade s maximom, ale bez dôkazu).
4. **Q4 Cookie odkaz v PP:** Je doplnenie zástupného riadku odkazom „Informácie o cookies“ (/cookies) v poriadku?
5. **Q5 Preklady:** Dodá CLIA autorizované EN/DE preklady PP 1.4 a klauzulu „rozhodujúce je slovenské znenie“ aj pre
   existujúce EN/DE preklady Podmienok, DPA a Cookies?
6. **Q6 Preferenčné úložisko:** Spadá ukladanie jazyka, naposledy zvolenej firmy a polohy UI prvkov v localStorage
   pod výnimku § 109 ods. 8 ZEK (bez súhlasu)?
7. **Q7 DPIA:** Odporúča CLIA dokončiť DPIA pred kontrolovaným produkčným release?
8. **Q8 Intake:** Je prípustné, že pri používateľovi bez finančného oprávnenia sa šifrovaný AI návrh a originál
   uložia so stavom „na kontrolu“ ešte pred potvrdením (DPA príl. 2 „pred definitívnym uložením“)?
9. **Q9 Neuvedené záznamy:** retencia `trial_claims` (hash IČO, anti-abuse), `beta_allowlist`, `ai_processing_usage`
   (user_id + hash obsahu pre kvóty), `billing_events` po zrušení firmy.
10. **Q10 Preklepy v PP:** „Hlavýnm“, „(USA môže“, „k dispozícií“, „..“ na konci vety — opraví CLIA vo verzii 1.5?
11. **Q11 E-mail:** potvrdiť, či Supabase Auth používa custom SMTP a či sa `esblu.office@gmail.com` používa na
    komunikáciu so Zákazníkmi (vtedy doplniť Google ako príjemcu).
12. **Q12 Verejné registre:** doplniť do PP „Zdroje získavania osobných údajov“ verejné registre (RPO, RÚZ) pri
    vyhľadaní a overení Zákazníka?
13. **Q13 Hlasová syntéza:** odpovede asistenta číta syntéza prehliadača (môže byť cloudová podľa prehliadača) —
    treba uviesť?
14. **Q14 Google v mobile:** PP uvádza Google prihlásenie iba vo webovom rozhraní; reálne je dostupné aj v mobilnej
    aplikácii — upraviť text?

## 17. Implementované v J10 (repo + staging)

- Privacy Policy 1.4 (CLIA SK), `### ` podnadpisy v rendereri, upozornenie pre EN/DE bez prekladu.
- Cookies 1.1 inventár (sk/en/de), titul „Informácie o cookies“.
- Potvrdenie pri registrácii: CLIA text, verzia zobrazená pri odškrtnutí, DE gramatika; odkazy na `/invite`, `/reset-hesla`.
- `/subprocessors`: OpenAI rozsah podľa DPA p3 (dokumenty, hlas, príkazy; OpenAI Ireland), doplnený Google FCM.
- DPA brána pred OpenAI (5 tokov), fail closed.
- Retencia (migrácia `20261110100000`): push revoked 30 d, doručenia 90 d, pozvánky 30 d, deletion joby 90 d,
  asistent 1 d, media fronta 90 d, neúspešné registrácie 30 d; chat prílohy pri zrušení firmy.
- Push: revoke sweep aj bez providera; odhlásenie nevytvára nové ID inštalácie.
- Testy `test:clia-gdpr` (12), `test:clia-gdpr-db` (8, vrátane rollback + re-apply).
- Staging: obe migrácie aplikované na `esblu-test`; rollback overený v transakcii (ROLLBACK); granty service-only.

---

## 18. CLIA follow-up 2026-11-11 (J10.1)

Stanovisko CLIA z 11.11.2026 (záväzné):

| bod | stanovisko | stav v Esblu |
|---|---|---|
| DPA elektronicky | **CONFIRMED** — DPA možno uzatvoriť elektronicky; preukázať identitu, oprávnenie, verziu, dátum, čas, súhlas oboch strán; upraviť ustanovenia o podpise a listinných vyhotoveniach | DPA 1.3 + rozšírená evidencia (§18.2–18.3) |
| Anthropic | **SUBPROCESSOR CONFIRMED** — zaradenie v DPA a dokumentácii je opodstatnené (servisné/diagnostické zásahy) | ostáva v DPA p3 a registri; doplnený na `/subprocessors`; pravidlá prístupu (§18.5) |
| DPIA | **NOT A RELEASE BLOCKER** — povinnosť primárne na Zákazníkoch; Esblu poskytuje súčinnosť | technický podklad §14 ostáva ako support package |
| Cookies | **COOKIE BANNER NOT REQUIRED CURRENTLY** — stačí reálny a úplný prehľad | `/cookies` 1.1 bez zmeny; inventár znovu overený (test) |
| EN/DE Privacy Policy | **TRANSLATIONS REQUIRED** — slovenská verzia ako rozhodujúca nenahrádza zrozumiteľnú informáciu | `legal/privacy/1.4.en.md`, `1.4.de.md` (úplné preklady) |

### 18.1 Otázky Q1–Q14 — uzavretie

| Q | téma | rozhodnutie | stav |
|---|---|---|---|
| Q1 | DPA elektronicky | CLIA potvrdila → DPA 1.3 + evidencia | **CLOSED** |
| Q2 | Anthropic | CLIA: ponechať ako sprostredkovateľa → pravidlá minimalizácie a evidencia zásahov | **CLOSED** |
| Q3 | dôkaz prijatia po zrušení účtu | pred výmazom acceptance riadku sa uloží dôkaz (`legal_acceptance_evidence`: osoba, e-mail, verzia, čas, metóda, rola, firma) — retencia max. 5 r. (PP „Správa zmluvného vzťahu“), potom purge | **CLOSED (J10.1 tech)** |
| Q4 | odkaz na cookies v PP | CLIA potvrdila stránku cookies ako postačujúcu | **CLOSED** |
| Q5 | preklady | CLIA rozhodla → EN/DE implementované | **CLOSED** |
| Q6 | preferenčné localStorage | iba nastavenia zvolené používateľom, bez sledovania, bez prenosu tretím stranám; CLIA potvrdila súčasný model bez lišty | **CLOSED (covered)** |
| Q7 | DPIA | nie je blocker | **CLOSED** |
| Q8 | AI intake pred potvrdením | spracúvanie iniciuje Zákazník po prijatí DPA (DB guard na `documents`, DPA brána pred OpenAI); návrh sa ukladá šifrovaný so stavom `needs_review`, do evidencie (faktúra/ai_evidence) ide až po ľudskom potvrdení — v súlade s DPA p2 („pred definitívnym uložením“) a minimalizáciou | **CLOSED (documented)** |
| Q9 | trial / beta / AI telemetria | `trial_claims` ≤ 5 r. (evidencia skúšobného obdobia), `ai_scan_usage` ≤ 90 d (technický log), `ai_processing_usage` user_id pseudonymizovaný po 90 d (počty kvót ostávajú), `ai_usage_monthly` bez osobných údajov 25 mes.; `beta_allowlist` = vlastníkom spravovaný zoznam uzavretej bety → vyprázdni sa pri ukončení bety (OWNER ACTION, runbook §7) | **CLOSED** |
| Q10 | preklepy PP | opravené iba jednoznačné: „Hlavýnm“→„Hlavným“, „(USA môže“→„(USA) môže“, „k dispozícií“→„k dispozícii“, „incidentov..“→„incidentov.“ (hash 1.4 aktualizovaný pred produkciou; staging opravený) | **CLOSED** |
| Q11 | SMTP / Gmail | repo: žiadny custom SMTP, žiadna e-mailová knižnica, `esblu.office@gmail.com` nikde; auth e-maily = Supabase (v PP uvedené); podpora = Namecheap (uvedené). Gmail sa nepridáva. Ak vlastník zistí presmerovanie na Gmail → zaradiť ako sprostredkovateľa podľa existujúceho modelu (runbook §6) | **CLOSED (OWNER verify)** |
| Q12 | RPO / RÚZ | verejné registre = zdroj verejných údajov o firme (IČO, obchodné meno; pri SZČO meno) na overenie Zákazníka; nie profilovanie, nie nový typ údajov → doplnené do internej dokumentácie (§15 register delta), PP text sa nemení | **CLOSED (doc)** |
| Q13 | syntéza reči | Web Speech API (`speechSynthesis`) v prehliadači/zariadení; Esblu neposiela text na server ani tretej strane; niektoré prehliadače môžu použiť cloudové hlasy výrobcu prehliadača podľa nastavení používateľa → nie je to sprostredkovateľ Esblu, zdokumentované technicky | **CLOSED (doc)** |
| Q14 | Google login mobil | Google OAuth beží na webe aj v mobilnej aplikácii (Capacitor Browser, PKCE, `NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS=google` v mobilnom builde); PP tvrdenie „dostupné vo webovom rozhraní“ je pravdivé, nie úplné → interné dokumenty zosúladené, pri najbližšej revízii PP navrhnúť „vo webovom a mobilnom rozhraní“ (bez samostatnej CLIA otázky) | **CLOSED (doc)** |

### 18.2 DPA — elektronický model (finálny stav)

| požiadavka CLIA | implementácia |
|---|---|
| identita osoby | `company_dpa_acceptances.accepted_by` (auth user, FK RESTRICT); e-mail sa pri archivácii uloží do `legal_acceptance_evidence` |
| oprávnenie konať za Zákazníka | server: iba **owner** aktívnej firmy (`accepted_role`); osoba: výslovné vyhlásenie v checkboxe „Potvrdzujem, že som oprávnený/á konať za túto firmu…“ → `authority_confirmed = true` (bez neho `ESBLU_DPA_AUTHORITY_NOT_CONFIRMED`) |
| prijatá verzia | `version` + `document_content_hash` (sha256 SK textu) — iba aktuálna účinná verzia |
| dátum a čas | `accepted_at` (DB `now()`, nie klient) |
| metóda | `acceptance_method = company_dpa_gate`; jazyk zobrazenia `display_locale` |
| súhlas oboch strán | Esblu: DPA 1.3 bod 10.1 (sprístupnenie Zmluvy na elektronické potvrdenie = súhlas Sprostredkovateľa) + `processor_acceptance = esblu_electronic_offer_dpa_10_1` |
| identita Zákazníka | `company_name_snapshot`, `company_registration_id_snapshot` (IČO z overenej identity / fakturačného profilu) |
| dôkaz po zrušení firmy | `legal_acceptance_evidence` (5 r.) |
| zobrazenie | verejná `/dpa` (SK + EN/DE preklad 1.3); podpisový workflow, PDF podpis ani KEP sa nezavádzajú |

### 18.3 DPA 1.3 — presný diff voči textu CLIA (09.11.2026)

Všetky ostatné ustanovenia a prílohy 1–3 (vrátane Anthropic PBC v prílohe 3) sú doslovne CLIA (tokenový diff
mimo týchto 5 miest = 0).

1. **Čl. I — Prevádzkovateľ** (prázdne polia šablóny) → „**Prevádzkovateľ:** Zákazník, ktorého obchodné meno,
   sídlo, IČO, prípadne DIČ, IČ DPH a údaj o zápise sú evidované v jeho účte v Aplikácii Esblu v čase
   elektronického potvrdenia tejto Zmluvy / **V zastúpení:** osoba, ktorá Zmluvu v mene Prevádzkovateľa elektronicky
   potvrdila podľa bodu 10.1 / **Kontakt:** e-mailová adresa evidovaná v účte Prevádzkovateľa v Aplikácii Esblu“.
   (Pôvodné polia Sídlo/IČO/DIČ/IČ DPH/Zapísaný v so znakmi „……“ odstránené.)
2. **10.1** pôvodne: „…nadobúda platnosť a účinnosť dňom jej podpisu oboma Zmluvnými stranami.“ → „…nadobúda platnosť
   a účinnosť dňom jej uzatvorenia. Zmluva sa uzatvára elektronicky tak, že osoba oprávnená konať za
   Prevádzkovateľa potvrdí jej aktuálnu verziu v Aplikácii Esblu. Sprostredkovateľ sprístupnením Zmluvy na
   elektronické potvrdenie v Aplikácii Esblu vyjadruje súhlas s jej obsahom a s jej uzatvorením týmto spôsobom.
   Sprostredkovateľ eviduje identitu osoby, ktorá Zmluvu potvrdila, jej vyhlásenie o oprávnení konať za
   Prevádzkovateľa, potvrdenú verziu Zmluvy a dátum a čas potvrdenia. Zmluvu možno uzatvoriť aj podpisom oboch
   Zmluvných strán; v takom prípade nadobúda platnosť a účinnosť dňom jej podpisu oboma Zmluvnými stranami.“
3. **11.4** doplnené „…, prípadne elektronickým potvrdením novej verzie Zmluvy v Aplikácii Esblu postupom podľa
   bodu 10.1, ak táto Zmluva neustanovuje inak.“
4. **11.7** pôvodne: „Táto Zmluva je vyhotovená v dvoch rovnopisoch, z ktorých každá Zmluvná strana obdrží jeden
   rovnopis Zmluvy.“ → „Zmluva uzatvorená elektronicky podľa bodu 10.1 sa nevyhotovuje v listinných rovnopisoch;
   jej potvrdená verzia je Prevádzkovateľovi trvalo dostupná v Aplikácii Esblu. Ak sa Zmluva uzatvára podpisom v
   listinnej podobe, je vyhotovená v dvoch rovnopisoch, z ktorých každá Zmluvná strana obdrží jeden rovnopis Zmluvy.“
5. **Podpisová časť** („V …, dňa … / Za Prevádzkovateľa / Za Sprostredkovateľa / ……“) → „Za Prevádzkovateľa:
   elektronické potvrdenie v Aplikácii Esblu podľa bodu 10.1 (záznam o potvrdení eviduje Sprostredkovateľ). /
   Za Sprostredkovateľa: Esblu s. r. o., sprístupnením Zmluvy na elektronické potvrdenie podľa bodu 10.1.“

Klasický podpis ostáva ako **alternatíva** (10.1 posledná veta, 11.7 druhá veta), nie povinnosť.

### 18.4 DPA server-side enforcement matrix

| oblasť | vstup | vynútenie pred DPA | stav |
|---|---|---|---|
| dokumenty / Inbox / AI intake | `documents`, `document_attachments`, `ai_evidence` | DB BEFORE INSERT guard (všetky roly vrátane service_role) | PASS (J0) |
| vozidlá, stroje, sklad, fotky, servis, známky | 9 tabuliek | DB guard | PASS |
| chat správy a prílohy | `chat_messages`, `chat_attachments` | DB guard | PASS |
| **faktúry** | `invoices` (+ položky cez faktúru) | DB guard | **FIXED J10.1** (predtým iba UI) |
| **obchodní partneri** | `business_partners` | DB guard | **FIXED J10.1** (predtým iba UI) |
| **eFaktúra** | `einvoice_organizations` (registrácia firmy u providera → inbound/outbound) | DB guard | **FIXED J10.1** (NOT LIVE) |
| **súbory (Storage)** | buckety ai-inbox-documents, ai-evidence-documents, chat-attachments, vehicle/machine/inventory-photos | RESTRICTIVE insert politika `esblu_storage_company_dpa` | **FIXED J10.1** (predtým mohol vzniknúť osirelý súbor) |
| AI sken / technický preukaz / legacy sken | OpenAI | server DPA brána pred kvótou a prenosom | PASS (J10) |
| hlas | OpenAI transcribe | server DPA brána pred čítaním audia | PASS (J10) |
| intent AI fallback | OpenAI | bez DPA sa text neodošle (deterministický parser ostáva) | PASS (J10) |
| **povolené pred DPA** (založenie firmy/účtu) | `companies`, `company_members`, `company_invites`, `company_billing_profile`, `company_legal_identities`, logo firmy (`company-logos`), nastavenia, push identifikátory, legal acceptance | bez DPA guardu — údaje prevádzkovateľa Esblu / nastavenie firmy | zámerne |
| odvodené záznamy | folders, kategórie, export balíky, handoff, linky | z existujúceho obsahu (ten už vyžadoval DPA) | N/A |

Testy: `test:clia-j10-1-db` (business_partners, Storage, triggery, owner/admin/employee, cudzia firma),
`test:multi-company-db`, `test:einvoice-db`, `test:storage-media-db` PASS.

### 18.5 Anthropic — finálny stav a kontroly

- Ostáva v DPA 1.3 prílohe 3 (text CLIA) a v zázname sprostredkovateľa; doplnený na `/subprocessors`
  (vývoj, údržba, technický audit, diagnostika, schválené servisné zásahy — nie AI funkcia pre Zákazníkov).
- Pravidlá: `docs/ai-dev-tool-access-policy.md` (staging/syntetické najprv, produkcia iba nevyhnutne, minimálny
  rozsah, agregáty pred riadkami, žiadne dumpy, žiadne osobné údaje v promptoch/dokumentoch/commitoch, žiadne
  tajomstvá, žiadne dlhodobé lokálne kópie, zápis/mazanie iba so súhlasom) + odkaz v `AGENTS.md` (čítajú ho AI
  nástroje v repe).
- Evidencia zásahov: `docs/ops/service-intervention-log.md` (append-only cez git, bez osobných údajov, ≤ 12 mes.).
  Existujúce mechanizmy (git história migrácií, Supabase `schema_migrations`, Vercel deployment logy, checklist)
  zachytávajú zmeny, ale nie read-only prístupy → doplnený manuálny log.
- Runtime kód: žiadna Anthropic integrácia (test).

### 18.6 Produkčný purge — read-only precheck (2026-11-11)

`scripts/sql/prod-gdpr-retention-precheck.sql` (BEGIN READ ONLY … ROLLBACK, iba agregáty). Výsledok na produkcii:

| kategória | riadkov | najstarší | najnovší | typ údajov | legal hold |
|---|---|---|---|---|---|
| push_devices revoked > 30 d | 1 | 2026-10-12 | 2026-10-12 | technický identifikátor | nie |
| push_subscriptions revoked > 30 d | 2 | 2026-09-30 | 2026-10-01 | technický identifikátor | nie |
| notification_deliveries > 90 d | 0 | — | — | metadáta doručenia | nie |
| company_invites neprijaté > 30 d | 1 | exp. 2026-08-21 | 2026-08-21 | pozvánka (e-mail) | nie |
| account_deletion_cleanup_jobs | — | tabuľka v prod ešte neexistuje (RC) | | | |
| assistant_action_confirmations expirované > 1 d | 30 | 2026-09-15 | 2026-09-25 | technické (args príkazu) | nie |
| assistant_conversation_contexts expirované > 1 d | 2 | 2026-09-25 | 2026-09-25 | technické | nie |
| media_deletion_queue dokončené > 90 d | 0 | — | — | technické | nie |
| nepotvrdené registrácie > 30 d | 0 | — | — | registrácia | nie |
| trial_claims > 5 r. | — | tabuľka v prod ešte neexistuje (RC) | | | |
| ai_scan_usage > 90 d | 0 | — | — | technický log | nie |
| ai_processing_usage na pseudonymizáciu | 0 | — | — | kvótový záznam | nie (riadky ostávajú) |
| legal_acceptance_evidence > 5 r. | — | tabuľka v prod ešte neexistuje (J10.1) | | | |
| INFO user_legal_acceptances (ostávajú) | 19 | 2026-08-15 | 2026-09-30 | dôkaz prijatia | nemaže sa |
| INFO company_dpa_acceptances (ostávajú) | 5 | 2026-08-15 | 2026-09-30 | dôkaz prijatia | nemaže sa |
| INFO invoices (nikdy) | 2 | 2026-09-16 | 2026-09-20 | **účtovníctvo** | 10 r. — mimo purge |

Prvý produkčný beh by zmazal **36 technických riadkov**, žiadne zákaznícke, obchodné ani účtovné údaje.
**Purge sa nespúšťa** — po nasadení RC je potrebný výslovný súhlas vlastníka (OWNER ACTION).

### 18.7 Verzovanie po prekladoch

- Privacy Policy: právna verzia ostáva **1.4** (SK hash v `legal_documents`); EN/DE sú preklady tej istej verzie
  → žiadny nový riadok, žiadny re-accept kvôli prekladu. Potvrdenie eviduje `metadata.display_locale` +
  `source_version`.
- DPA: **1.3** je nová právna verzia (zmena textu podľa CLIA) → každá firma ju prijme cez CompanyDpaGate (owner).
- Cookies 1.1 bez zmeny. Re-accept PP 1.4 nastane raz (nová CLIA verzia oproti 1.3), nie kvôli prekladom.
