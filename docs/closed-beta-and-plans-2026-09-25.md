# Closed Beta, 14-dňový trial a modulárne nároky (aktualizované 26. 9. 2026, finálne produktové korekcie)

Zdroj pravdy o dnešnom stave: produkcia `fkpgvgvsmbpieduoatrt` (iba read-only dotazy) + `main` @ `5c722c3`.

> **STAV:** migrácia `supabase/migrations/20260928100000_company_entitlements_trial.sql` je **NAVRHNUTÁ, NEAPLIKOVANÁ**.
> Kód v tejto zmene ju **vyžaduje** (fail closed). Poradie nasadenia: **najprv migrácia (MCP `apply_migration`), až potom kód.**
> Bez migrácie by nasadený kód vypol hlas, AI spracovanie a vytváranie modulových záznamov.
> Neaplikované ostávajú aj OAuth (`20260927120000`) a Push (`20260927110000`) — nie sú súčasťou tejto zmeny.

## 1. Vrstvy prístupu (oddelené)

```
prihlásenie → členstvo vo firme → rola/oprávnenie → NÁROK MODULU → pravidlá akcie
```

| Vrstva | Otázka | Úložisko | Kto mení |
| --- | --- | --- | --- |
| Closed beta | Smie vzniknúť nový vlastník/firma? | `beta_allowlist` + Auth hook | operátor (SQL) |
| Trial | Aké dočasné nároky má firma? | `companies.trial_started_at / trial_ends_at` (nemenné) + `entitlement_catalog` | nikto (vzniká s firmou) |
| Platené moduly | Čo firma platí / má pridelené? | `company_entitlements` | operátor (SQL), budúci billing |
| Rola | Čo smie používateľ? | `company_members.role/permissions` + RLS | owner/admin v appke |

Nárok **nikdy** nerozširuje rolu. Žiadna RLS politika nečíta plán ani nárok (overené testom).

## 2. 14-dňová skúšobná verzia (firma)

- Začína pri vzniku firmy (serverový čas `now()` v DB), končí presne o 14 dní. Aktívna iff `now() < trial_ends_at`.
- Nemenná: trigger `esblu_companies_trial_guard` odmietne akúkoľvek zmenu (`ESBLU_TRIAL_IMMUTABLE`), aj od operátora. Zmena ownera, pozvanie používateľa, odhlásenie, reinštalácia ani zmena billing stavu trial neresetujú. Pozvaný používateľ nový trial nedostáva (trial je stĺpec firmy, nie používateľa).
- Predĺženie = ručný grant v `company_entitlements`, nie posun trialu.
- Trial dostáva **iba novovytvorená firma** (INSERT trigger) — presne raz. Firmy existujúce pred migráciou trial nemajú (`NULL`), pozri §10.

| Nárok (`entitlement_catalog`) | Trial | Limit v triali |
| --- | --- | --- |
| `team_members` (používatelia) | áno | 1 |
| `vehicles` | áno | 2 |
| `machines` | áno | 2 |
| `inventory` | áno | 5 |
| `ai_documents` | áno | 5 AI spracovaní spolu za trial |
| `invoicing` (Fakturácia) | áno | bez limitu počtu faktúr (**rozhodnuté**) |
| `voice` | **nie** | — |

## 3. Po skončení trialu / nároku modulu (dáta ostávajú použiteľné na čítanie)

- Nič sa nemaže, nearchivuje, nepresúva (ani storage). Prihlásenie funguje, firma a členovia ostávajú.
- Existujúce dáta sú **čitateľné podľa existujúcich rolí a finančných oprávnení** (RLS sa nemení) — v UI aj cez asistenta/hlas rovnako.
- Existujúce záznamy ostávajú upraviteľné tam, kde to dnes dovoľuje RLS (napr. draft faktúry, skladová položka owner/admin).
- Blokované bez aktívneho nároku: nový záznam vo vozidlách/strojoch/sklade/AI evidencii, nová faktúra (vydaná aj prijatá) a finalizácia draftu, AI spracovanie, nová pozvánka aj prijatie čakajúcej pozvánky, hlas, zápisové intenty asistenta nad neaktívnym modulom.
- **Asistent:** READ intenty (v registri `readOnly: true`) nárok modulu nevyžadujú; rola a financie rozhodujú vždy a PRED nárokom (zamestnanec ani admin bez finance práva faktúry neuvidí). WRITE/create/AI/voice ostávajú nárokované.
- Kódy odmietnutia: `TRIAL_EXPIRED` (firma mala trial), `ENTITLEMENT_REQUIRED` (bez trialu/grantu), `VOICE_ENTITLEMENT_REQUIRED`.

## 4. Modulárne platené nároky

`company_entitlements(company_id, entitlement_key, source subscription|manual, status active|suspended|revoked, valid_from, valid_until, limit_value, limit_period month|total, external_ref, note)`.
Resolver `esblu_resolve_entitlement(company, key)`: platný platený/ručný riadok má prednosť (bez limitu > najvyšší limit), inak trial, inak odmietnutie. Neznámy kľúč / chýbajúca firma = odmietnutie. Nový modul = nový riadok v katalógu (bez zmeny schémy).

Príklad: firma platí iba `invoicing` + `voice` → hlasom vystavuje faktúry; „pridaj do skladu…“ vráti `TRIAL_EXPIRED:inventory`, „ukáž sklad“ (čítanie existujúcich položiek) funguje podľa roly.

`source`: `subscription` (budúci billing), `manual` (operátor), `beta_compat` (kompatibilita pred-entitlement beta firiem, §10).

## 5. AI spracovanie dokumentov (kvóta, nie počet dokumentov)

- 1 jednotka = 1 prijaté spracovanie dokumentu, ktoré naozaj spustí AI extrakciu (`scan-document`, `scan-vehicle-registration`, legacy `scan-vehicle-doc`). Doplnkové volanie (SPZ fallback) sa nepočíta zvlášť.
- Ledger `ai_processing_usage` je nezávislý od `documents` — **zmazanie dokumentu kredit nevracia**; uloženie bez AI nič nespotrebuje.
- Kedy: rezervácia `esblu_reserve_ai_processing` AŽ po autentifikácii, firme, abuse limite a validácii vstupu, tesne pred prvým volaním modelu. Zamietnuté/neplatné požiadavky nič nespotrebujú.
- Finalizácia `esblu_finalize_ai_processing`: model odpovedal → `succeeded` (účtuje sa, aj keď výstup neskôr neprejde validáciou); výnimka AI → `failed` (neúčtuje sa). Iba `reserved → výsledok`, iba vlastník rezervácie; `succeeded` sa nedá „vrátiť“.
- Timeout / pád servera pred finalizáciou: ostáva `reserved` = počíta sa (fail closed); retry s rovnakým kľúčom ho znovu použije bez ďalšieho kreditu.
- Idempotencia: hlavička `Idempotency-Key` (klient: stabilná na File + variant, `lib/idempotency-key.ts`) + serverový SHA-256 obsahu. Rovnaký kľúč a obsah do 24 h, najviac 3 pokusy = bez nového kreditu; iný obsah pod rovnakým kľúčom = `ESBLU_AI_IDEMPOTENCY_CONFLICT` (409).
- Súbežnosť: advisory lock na firmu → #5 a #6 nemôžu obe prejsť (overené skutočnou súbežnosťou).
- Platený modul `ai_documents` má vlastný „bucket“ (`limit_period=month` → počítanie od začiatku mesiaca).
- Technický abuse limit (60/h, 240/deň) ostáva a nově platí aj pre `scan-vehicle-*` (predtým bez kontroly firmy aj stropu).

## 6. Hlas je iba platený

- Server: `/api/assistant/transcribe` volá `esblu_require_my_entitlement('voice')` po autentifikácii, **pred** čítaním audia aj pred OpenAI. Podvrhnutý „voice“ príznak z klienta sa nikde nečíta.
- UI: `VoiceSessionControl` sa bez nároku nevykreslí (mikrofón nemožno spustiť); prebiehajúcu reláciu možno vždy ukončiť. UI nie je bezpečnostná hranica.
- Prepis ide do `/api/assistant/intent`, kde platí tá istá brána rolí + brána modulu ako pri písaní (`entitlementGate` v orchestratore, AŽ po bráne rolí; zápisy modulu vyžadujú nárok, čítanie nie). Písaný asistent je dostupný aj v triali.

## 7. Limit používateľov

- Jediné cesty do firmy: `esblu_create_company_invite` a `esblu_accept_company_invite` (authenticated nemá INSERT na `company_members`; owner vzniká iba s novou firmou).
- Vytvorenie pozvánky: aktívni členovia + čakajúce neexpirované pozvánky < limit. Prijatie: aktívni členovia < limit. Oboje pod advisory lockom firmy (dve súbežné pozvánky na posledné miesto → presne jedna prejde).
- Rola sa overuje pred nárokom (zamestnanec dostane `ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN`, nič o nárokoch).
- Downgrade/expirácia: nikto sa neodoberá (ani owner), nové pozvánky/prijatia sú blokované.

## 8. Štruktúrované chyby

DB: `message = ENTITLEMENT_DENIED:<REASON>:<key>`, `detail = {"reason","key","limit","current"}`. HTTP: 403 `{success:false, code, reason, key, error}` (`entitlementDenialResponse`). UI/asistent mapujú `entitlements.reasons.*` (SK/EN/DE). Dôvody: `TRIAL_EXPIRED, ENTITLEMENT_REQUIRED, VOICE_ENTITLEMENT_REQUIRED, USER_LIMIT_REACHED, VEHICLE_LIMIT_REACHED, MACHINE_LIMIT_REACHED, INVENTORY_LIMIT_REACHED, AI_PROCESSING_LIMIT_REACHED, ENTITLEMENT_LIMIT_REACHED`.

## 9. `companies.plan` (kompatibilita)

- Ostáva (DEPRECATED komentár), nemaže sa. Nič v DB ani v novom kóde ho nečíta (`esblu_company_plan` ostáva, nevolá sa). `plan_limits` a `settings.plan` tiež ostávajú nečítané.
- Backfill pri aplikovaní: výslovné granty `beta_compat` (§10), žiadny trial.
- `admin` nikdy neznamenal oprávnenie roly (test: zamestnanec v `admin` firme ostáva read-only v sklade).
- Neskôr (samostatná, schválená úloha): zhodiť `companies.plan`, `settings.plan`, `plan_limits`, `esblu_company_plan`.

## 10. Existujúce (pred-entitlement) beta firmy — kompatibilita

Cieľ: v deň migrácie nikto neprišiel o prístup, nikomu sa nevyrobí falošný trial a čas migrácie sa nestane „dátumom registrácie“.

- `trial_started_at / trial_ends_at = NULL` pre všetky firmy existujúce pred migráciou (= „bez trialu“). Nedá sa dodatočne nastaviť (`ESBLU_TRIAL_IMMUTABLE`).
- Dnešný efektívny prístup sa zachová **výslovnými grantmi** `company_entitlements.source = 'beta_compat'` (bez konca platnosti, auditovateľné; pred platenou prevádzkou ich operátor revíduje a nahradí):

| `companies.plan` dnes | Mapovanie (granty `beta_compat`) |
| --- | --- |
| `pro` | všetkých 7 nárokov bez limitu vrátane `voice` (dnes majú všetko) |
| `admin` | rovnako ako `pro`; `admin` je iba komerčný príznak — **žiadna rola sa neodvodzuje** (členstvá/roly sa nemenia) |
| `free` | `invoicing`, `ai_documents` (bez kvóty; ostáva technický abuse limit 60/h, 240/deň), `team_members` (bez limitu, ako dnes), `vehicles` 2, `machines` 2, `inventory` 5 (dnešné Free limity z `plan_limits`); **bez `voice`** — hlas je iba platený |

- Dnešná produkcia: 3 firmy (`admin`, `pro`, `free`); `free` firma s 2 aktívnymi členmi pozvánky posielať môže ďalej (bez limitu).
- Hlas pre `free` beta firmy po migrácii zmizne (dnes je hlas dostupný všetkým) — zámerne podľa politiky „hlas iba platený“; operátor ho môže udeliť grantom.
- Overené: `scripts/sql/entitlements-backfill-check-local.sql` (dáta/členstvá nezmenené, trial NULL, mapovanie, nová firma dostane trial, pred-entitlement firma si trial nevyrobí).

## 11. Ako dať klientovi beta prístup (bez zmeny)

```sql
insert into public.beta_allowlist (email, note)
values (lower(btrim('owner@klient.sk')), 'Klient XY — beta') on conflict (email) do nothing;
select email, consumed_at, revoked_at from public.beta_allowlist where email = 'owner@klient.sk';
update public.beta_allowlist set revoked_at = now() where email = 'owner@klient.sk' and consumed_at is null;
```
Klient sa zaregistruje → založí firmu (spustí sa 14-dňový trial vrátane Fakturácie) → počas trialu 1 používateľ.

Aktivácia modulu (po aplikovaní migrácie, operátor):
```sql
insert into public.company_entitlements (company_id, entitlement_key, source, limit_value, limit_period, note)
values ('<company_id>', 'invoicing', 'manual', null, null, 'beta — Fakturácia'),
       ('<company_id>', 'team_members', 'manual', 5, null, 'beta — 5 používateľov'),
       ('<company_id>', 'ai_documents', 'manual', 50, 'month', 'beta — 50 AI/mes (provizórne)');
-- ukončenie (nič sa nemaže):
update public.company_entitlements set status = 'revoked' where company_id = '<company_id>' and entitlement_key = 'invoicing';
```

## 12. Billing

Žiadny billing provider (Stripe a pod.) neexistuje a nepridáva sa. `company_entitlements.source='subscription'` + `external_ref` + `valid_until` sú pripravené pre budúci webhook, ktorý smie meniť **iba** tieto riadky. Web nemá tlačidlo „Kúpiť“.

## 13. Cenník (PROVIZÓRNY — čaká na schválenie)

Konfigurácia: `lib/pricing.ts` (jediný zdroj; `PRICING_APPROVAL_STATUS = "provisional"`; limity trialu overené testom proti DB katalógu). Stránka `/cennik`, odkaz v navigácii, pätičke a v sekcii „14 dní zadarmo“ na úvode. Komunikácia: „14 dní zadarmo“ → „Vyberiete si iba moduly, ktoré používate.“ Kalkulačka je iba informatívna, žiadny checkout; CTA = žiadosť o beta prístup.

Zákaznícky názov modulu je **„Fakturácia“** (EN „Invoicing“, DE „Rechnungsstellung“), interný kľúč `invoicing`. Kým nie je hotová podpora Peppol/PDS, modul sa **neprezentuje ako oficiálne slovenské eFaktúra riešenie** (popis výslovne uvádza, že odosielanie cez Peppol zatiaľ nie je súčasťou).

| Modul | € / mes. bez DPH / firma (provizórne) | Poznámka |
| --- | --- | --- |
| Fakturácia | 5,90 | Peppol odosielanie zatiaľ nie je súčasťou |
| AI evidencia | 9,90 | **50 AI spracovaní / mes. v cene** (`AI_DOCUMENTS_MONTHLY_ALLOWANCE`, provizórne; zmena na 75/100 = jedna konštanta) |
| Vozidlá | 5,90 | |
| Stroje | 5,90 | |
| Sklad | 5,90 | |
| Hlasové ovládanie | 6,90 | nie je v triali |

Príklad: Fakturácia + Hlas = 12,80 € / mes. bez DPH (informatívne). Trial: 5 AI spracovaní spolu.

## 14. Unit economics (odhad z kódu, 26. 9. 2026)

Ceny OpenAI (štandard, krátky kontext, developers.openai.com/api/docs/pricing, 26. 9. 2026): `gpt-5.6-terra` $2,00 in / $12,00 out za 1M tok.; `gpt-4.1` $2/$8; `gpt-4.1-mini` $0,40/$1,60; `gpt-4o-transcribe` ≈ $0,006/min. Kurz predpoklad 1 € ≈ 1,10 $.

AI dokument (`scan-document`, `gpt-5.6-terra`, obrázok `detail: high` → ≤ 2 500 patchov × 1,2 = ≤ 3 000 tokenov): vstup ≈ prompt ~4 000 (14,2 k znakov) + schéma ~2 000–2 500 + obrázok ~3 000 ≈ 9 000–9 500 tok. ≈ $0,019; výstup (štruktúrované polia + `rawText`) 1 200–3 000 tok. ≈ $0,014–0,036. **Spolu ≈ $0,035–0,055, typicky ~$0,045 (~0,04 €)**; SPZ fallback `gpt-4.1` +≈$0,003 pri časti dodacích listov; technický preukaz `gpt-4.1-mini` (2 strany) ≈ $0,004.

| Dokumenty / mes. | Náklad (typ.) | Náklad (horný) | Marža pri 9,90 € (≈ $10,9) |
| --- | --- | --- | --- |
| 50 | $2,25 | $3,00 | ~72–79 % |
| 100 | $4,50 | $6,00 | ~45–59 % |
| 250 | $11,25 | $15,00 | strata |
| 500 | $22,50 | $30,00 | strata |

Pracovná hodnota na webe: **50 spracovaní / mes.** (konzervatívna, marža ~72–79 % pri plnom čerpaní). 75/100 sú možné po zmeraní reálnej spotreby tokenov; doplnkový balík a lacnejší model (`gpt-5.6-luna` ~10× lacnejší) ostávajú na rozhodnutie. Chýbajúca telemetria: `response.usage` (input/output/cached tokeny) sa nikde neloguje — odporúčame logovať bez obsahu.

Hlas: prepis `gpt-4o-transcribe` $0,006/min; VAD pošle iba reč (+0,9 s ticho), ~5 s/príkaz → ~12 príkazov/min. AI fallback klasifikátor (`gpt-5.6-terra`, prompt ~10 k znakov + schéma ~4,3 k → ~4 000 tok.) ≈ $0,009/volanie; volá sa iba keď deterministický parser nestačí (podiel neznámy — log `esblu_assistant_turn.source` to umožňuje zmerať; odhad 20–40 %). TTS = prehliadač (0 $).

| Hlas / mes. | Prepis | AI fallback (30 %) | Spolu | vs 6,90 € (≈ $7,6) |
| --- | --- | --- | --- | --- |
| 30 min | $0,18 | $0,97 | ~$1,15 | bezpečné |
| 100 min | $0,60 | $3,24 | ~$3,84 | OK (~50 %) |
| 300 min | $1,80 | $9,72 | ~$11,5 | strata |

Odporúčanie: 6,90 € je bezpečné pri bežnom používaní; pred spustením zmerať fallback rate, zapnúť prompt caching statického promptu (~$0,20/1M cached) a zvážiť fair-use (napr. 300 min/mes.). Limit minút sa teraz nezavádza.

## 15. Benchmark (verejné cenníky, stiahnuté 26. 9. 2026, ceny bez DPH)

| Služba | Vstup | Používatelia | Poznámka |
| --- | --- | --- | --- |
| KROS Fakturácia (kros.sk/fakturacia/cennik) | Zadarmo 0 € (5 partnerov); Základ 5,90 €; Štandard 11,00 €; KROS Firma 14,90 € (sklad) — pri platbe na 12 mes. | 1 + 1 (účtovník) | 50 odoslaných eFaktúr/mes. v cene, príjem eFaktúr zadarmo; eFaktúra povinná od 1. 1. 2027 |
| iDoklad (idoklad.sk/cennik) | Bezplatné 0 €; Základné 5 €; Obľúbené 8,3 € (sklad); Prémiové 11,6 € — pri ročnom predplatnom (predvolený výber) | 2 / 3 / 9 | 30 dní zadarmo bez karty; pri downgrade nič nemažú |
| SuperFaktúra (superfaktura.sk/cennik) | Základný 4,99 €; Štandardný 9,99 €; Prémiový 16,99 € — pri ročnej platbe (mesačne o ~1 € viac) | 1 + účtovník / neobm. v Prémiovom | 30 dní zadarmo; sklad v cene; 20 vyťažení dokladov zadarmo, 50 eFaktúr/mes. |

Záver: 5,90 € za Fakturáciu je v pásme konkurencie, ale konkurencia už dnes ponúka odosielanie Peppol eFaktúr v cene — Esblu ho zatiaľ nemá (web to uvádza ako „pripravujeme“). AI vyťažovanie konkurencia obmedzuje (SuperFaktúra 20 dokladov zadarmo) — potvrdzuje kvótový model.

## 16. Testy

- `npm run test:plan-entitlements` — resolver, fail closed, asistent × modul × rola, hlas (server), AI brány, cenník vs DB, i18n, bezpečnosť migrácie.
- `scripts/sql/plan-entitlements-matrix.sql` — 57 DB prípadov (trial deň 1/13/hranica/15, reset, limity, AI ledger, idempotencia, pozvánky, voice × modul × rola, self-grant, anon, cross-company). Spúšťať lokálne (`entitlements-local-baseline.sql` + migrácia) alebo na Supabase branchi. **Nie na produkcii.**
- `scripts/sql/entitlements-concurrency-local.sh` — skutočná súbežnosť (2 spojenia): posledné miesto v tíme, sklad #5/#6, AI #5/#6.
- `scripts/sql/entitlements-backfill-check-local.sql` — backfill nemení dáta, pro/admin dostanú moduly, free trial.

## 17. Rollback (pred aplikovaním migrácie)

1. Uložiť aktuálne definície: `select pg_get_functiondef(p.oid) from pg_proc p where p.proname in ('esblu_enforce_plan_limit','esblu_create_company_invite','esblu_accept_company_invite','esblu_company_plan');`
2. Rollback = spätne `create or replace` týchto definícií + `drop trigger esblu_invoicing_entitlement_guard on public.invoices; drop trigger esblu_companies_trial_guard on public.companies;`. Nové tabuľky/stĺpce môžu ostať (žiadne dáta sa nestratia).

## 18. Rozhodnuté (26. 9. 2026)

- Trial obsahuje Fakturáciu, bez limitu počtu faktúr.
- Po skončení nároku sú existujúce dáta čitateľné podľa rolí (UI aj asistent), zápisy/AI/hlas blokované.
- Pred-entitlement beta firmy: bez trialu, výslovné granty `beta_compat` (§10).
- Zákaznícky názov „Fakturácia“; eFaktúra/Peppol iba ako „pripravujeme“.
- AI evidencia: 50 spracovaní / mes. (provizórne), trial 5 spolu.

## 19. Otvorené rozhodnutia produktu

1. Počet používateľov v platenej prevádzke (`team_members` grant) — web uvádza „upresníme pred spustením“.
2. Je jadro (dokumenty/Inbox bez AI, priečinky, chat, partneri) po triali zadarmo? Dnes nie je nárokom obmedzené.
3. Všetky ceny, konečná AI allowance (50/75/100), cena doplnkového balíka.
4. Kedy a čím nahradiť granty `beta_compat` (a či `free` beta firmy dostanú hlas).
5. Názov a cena Fakturácie po doplnení Peppol/PDS.
