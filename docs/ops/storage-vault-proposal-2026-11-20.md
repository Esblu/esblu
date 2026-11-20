# Esblu — Trezor súborov v existujúcom Supabase (návrh v2, 2026-11-20)

Stav: **pripravené a otestované v PGlite, NENASADENÉ.** Žiadna produkčná migrácia, cron ani kopírovanie
zákazníckych dokumentov. Vetva `ops/storage-vault-proposal-2026-11-20`. Bez nového poskytovateľa a bez nových nákladov.

**Čo to je:** prevádzková redundancia v tom istom projekte — ochrana pred omylným, chybným alebo hromadným zmazaním
či prepísaním súborov. **Čo to nie je:** nezávislá záloha ani zákonný účtovný archív (pozri § 7).

## 1. Architektúra
| Časť | Súbor | Funkcia |
|---|---|---|
| SQL (návrh) | `supabase/proposals/storage_vault_proposal.sql` | bucket `esblu-file-vault`, tabuľky `storage_vault_entries` / `_queue` / `_guard`, trigger, 14 funkcií iba pre `service_role` |
| Worker | `lib/storage-vault/worker.ts` | `drainVaultQueue`, `reconcileVault`, `purgeVault`, `eraseVaultCopies`, `restoreFromVault`; Supabase adaptér |
| Cron route | `app/api/cron/storage-vault/route.ts` | `?mode=queue` (každú minútu), `?mode=reconcile` (každú hodinu); beží **iba** pri `ESBLU_STORAGE_VAULT_ENABLED=1`; **nie je vo `vercel.json`** |
| Výmaz | `lib/account-deletion-deps.ts`, `lib/account-deletion-storage.ts` | definitívny výmaz maže aj kópie tých istých cieľov; trezor v `DELETION_PROTECTED_BUCKETS` |

**Kópia hneď po nahratí:** trigger `AFTER INSERT/UPDATE` na `storage.objects` (rola `postgres` má v produkcii oprávnenie
TRIGGER — overené read-only) zapíše súbor do fronty; cron každú minútu urobí serverovú kópiu (Storage copy, bez prenosu
mimo Supabase) a v DB overí, že originál má **stále tú istú verziu** a kópia má **rovnakú veľkosť aj eTag**.
Trigger je `SECURITY DEFINER` a **nikdy neblokuje nahratie** (chyba = ticho; kópiu doplní hodinová kontrola).
Okamžitá kópia v reálnom čase by vyžadovala rozšírenie `pg_net` + tajomstvo v DB — neodporúčam (oneskorenie ≤ ~1 min je postačujúce).

## 2. Buckety: prevádzkové kópie vs. zákonný archív
| Bucket | Obsah | Aplikácia ho maže? | Trezor | Zákonný archív? |
|---|---|---|---|---|
| vehicle-photos, machine-photos, inventory-photos | fotky majetku | áno (používateľ, ukončenie) | kópia, 8 dní po zmazaní | nie |
| company-logos | logá | áno | kópia, 8 dní | nie |
| ai-inbox-documents, ai-evidence-documents | nahraté doklady na AI spracovanie | áno | kópia, 8 dní | **nie** — zákazník si originály uchováva sám (VOP 1.2 čl. 19.4) |
| chat-attachments | prílohy chatu | áno | kópia, 8 dní | nie |
| einvoice-documents | XML/PDF e-faktúr | **nie** (`DELETION_PROTECTED_BUCKETS`) | druhá kópia (ochrana pred chybou operátora/platformy) | **nie** — Esblu nie je garantovaný zákonný archív zákazníkov |
| billing-documents | PDF faktúr/dobropisov predplatného Esblu (Stripe) | **nie** | druhá kópia | účtovné záznamy Esblu — archív rieši účtovníčka/Stripe, trezor nie |
| esblu-file-vault | kópie | iba purge trezora | — | — |

Trezor **neuchováva nič dlhšie, než aplikácia uchováva originál** (+ 8 dní po bežnom zmazaní). Nikdy nie je archívom.

## 3. Bežné zmazanie vs. definitívny výmaz (návrh pravidiel pre CLIA)
| Udalosť | Originál | Kópia v trezore |
|---|---|---|
| Používateľ zmaže / prepíše súbor | hneď | **8 dní** (možnosť obnovy omylu; ≥ 7 dní záloh DB) |
| Chyba aplikácie / serverovej úlohy, kompromitovaný účet, hromadné zmazanie | hneď | 8 dní; pri ≥ 20 a > 20 % zmazaných naraz sa **mazanie kópií pozastaví na 48 h** (rozhodnutie operátora) |
| Zrušenie účtu (čl. 17), ukončenie firmy | cleanup job | **hneď v tom istom jobe** (lehota `esblu_storage_vault_erasure_delay()` = 0; alternatíva B: 8 dní) |
| Uplynutie lehoty | — | automatický výmaz (najviac 200/beh, nikdy aktuálna verzia existujúceho súboru) |

Definitívny výmaz sa vykoná aj počas pozastavenia (je explicitný a auditovaný: `erasure_requested_at`, `erasure_reason`).
Chyba pri výmaze kópií = cleanup job sa zopakuje (výmaz musí dobehnúť); nenainštalovaný trezor = nič na mazanie.

## 4. Ochrana pred hromadným zmazaním a chybami serverových úloh
- kópie sa nemažú pri zmazaní originálu, iba po lehote → hromadné zmazanie je obnoviteľné;
- poistka hromadného zmazania pozastaví purge na 48 h (`esblu_storage_vault_resume_purge` iba operátor);
- cleanup joby trezor nikdy nezasiahnu (`DELETION_PROTECTED_BUCKETS`, `parseStorageTargets`), worker vie mazať **iba** v trezore;
- priame SQL mazanie `storage.objects` blokuje Supabase trigger `protect_objects_delete` (existuje v produkcii);
- poškodená/neúplná kópia sa odmietne (veľkosť + eTag), zmaže a zopakuje s exponenciálnym backoffom (max 6 h, 10 pokusov, potom „dead“ → alert).

## 5. Izolácia a tenant izolácia
Bucket bez RLS politiky; tabuľky RLS bez politík a bez grantov pre `anon`/`authenticated`; 14 funkcií spustiteľných
iba `service_role`. Produkcia (read-only): RLS na `storage.objects` zapnuté, **každá permisívna Storage politika
filtruje `bucket_id`**, 3 bez filtra sú RESTRICTIVE. Test: všetky existujúce politiky po inštalácii bajt po bajte rovnaké.

## 6. Obnova (postup)
1. Zistiť rozsah (bucket, prefix cesty = firma/používateľ, čas incidentu).
2. Ak chýbajú aj DB riadky → najprv obnova DB zo zálohy Supabase (≤ 7 dní), inak iba súbory.
3. `restoreFromVault(bucket, prefix, since)` (operátor, service_role) — posledná verzia každého zmazaného/prepísaného súboru
   sa skopíruje na pôvodnú cestu; **existujúci súbor sa nikdy neprepíše**; definitívne vymazané sa neobnovujú.
4. Overenie: metadáta (veľkosť/eTag) + kontrola v aplikácii; obnovené súbory sa automaticky znova zálohujú (trigger).

## 7. Cena, limity, zvyškové riziko
- **Cena 0 €:** dnes 1,1 MB; kópie (aj verzie ≤ 8 dní) v rámci 100 GB plánu Pro; nad 100 GB spolu 0,0213 USD/GB/mes.
  Kópia na serveri = bez egressu. Crony: existujúci plán Vercel (každú minútu už bežia iné crony).
- **Limity:** kópia do ~1 min (súbor nahraný a zmazaný skôr sa zachytí iba ak worker stihne); obnova je ručná akcia
  operátora; Copy API do 5 GB/súbor (limity bucketov ≤ 20 MB); obnova súboru bez DB riadku nemá zmysel bez obnovy DB.
- **Zvyškové riziko (nezmenené): strata Supabase projektu / účtu / service_role kľúča alebo chyba platformy = strata
  originálov aj kópií aj záloh DB.** Zmierniť bez nákladov: MFA pre všetkých členov Supabase, Vercel, GitHub; minimum
  vlastníkov; odstrániť produkčný service_role kľúč z `C:\Users\roiaj\assetpilot\.env.local`; voliteľne občasná ručná záloha.

## 8. Monitorovanie trezora
`?mode=reconcile` vracia HTTP 503 (pre existujúci/navrhnutý monitoring) pri: pozastavenom purge (hromadné zmazanie),
„dead“ položkách vo fronte (10 neúspešných pokusov), najstaršej čakajúcej kópii > 60 min. Odpovede obsahujú iba počty
a kódy, nikdy cesty ani mená súborov. Mesačne: počet kópií vs. originálov (`enqueued` = 0 po kontrole), veľkosť trezora.

## 9. Testy (`scripts/ops/storage-vault-pglite-tests.ts`, 17/17; PGlite s celou schémou Esblu + Storage simulátor s bajtmi)
kópia všetkých 9 bucketov bajt po bajte; opakovaný beh bez duplicít; trigger neblokuje nahratie a kontrola doplní chýbajúce;
zlyhanie kopírovania + backoff + opakovanie; prerušený beh; poškodená kópia odmietnutá; prepísanie pred kópiou (stale);
prepísanie (8 dní); izolácia A/B/anon (SELECT/INSERT/UPDATE/DELETE); tabuľky a 14 funkcií nedostupné klientom; politiky
nezmenené; ochrana v serverovom kóde; hromadné zmazanie + pozastavenie; definitívny výmaz firmy A (B nedotknutá);
obnova firmy B bajt po bajte bez prepisu; konzistencia metadát; purge (limit, nikdy aktuálna verzia).
Mutácie (vypnutý `exception` v triggeri, vypnuté overenie kópie, vypnuté pozastavenie, grant pre `authenticated`) testy zachytia.
Ďalej: `account-deletion-orchestration` 18/18 (+1 test trezora), `grants-guard`, `storage-media-db`, `company-termination`,
`account-deletion-subscription` bez zmeny; `tsc` 0, ESLint bez nálezov, `next build` 61 stránok + nová route.

## 10. Otázky pre CLIA
1. Je 8-dňové uchovanie kópií **bežne zmazaných/prepísaných** súborov primerané (súlad s 7-dňovými zálohami DB)?
2. Definitívny výmaz (zrušenie účtu, ukončenie firmy): mazať kópie **hneď** (návrh) alebo ponechať 8 dní ako ochranu pred omylom?
3. Treba to uviesť v Zásadách ochrany osobných údajov a v DPA (TOMs) — a v akom rozsahu, bez rozšírenia zmluvy?
4. Súlad s VOP 1.2 čl. 20.1 („vymazanie Firmy … odstraňuje … súbory“) pri variante B.
5. Potvrdiť, že dočasné prevádzkové kópie v tom istom sprostredkovateľovi (Supabase, EU) nie sú novým spracúvaním ani prenosom.
