# Esblu — zálohovanie a monitoring produkcie (2026-11-20)

Vetva `ops/daily-backup-2026-11-20`. Nič nie je nasadené ani spustené proti produkcii; audit bol iba read-only
(metadáta: plán, veľkosti, počty — žiadny obsah tabuliek ani súborov).

## 1. Aktuálny stav

### Databáza (Supabase `assetpilot`, `fkpgvgvsmbpieduoatrt`, eu-central-1, Postgres 17)
| Položka | Stav |
|---|---|
| Plán organizácie Esblu s.r.o. | **Pro** |
| Automatické zálohy Supabase | denné **fyzické** zálohy, prístupné **7 dní**; obnova celého projektu z Dashboardu (výpadok počas obnovy) |
| PITR | nezapnuté (platený doplnok ~100 USD/mes. + Small compute) |
| Stiahnuteľnosť | fyzické zálohy sa **nedajú stiahnuť**; existujú iba v infraštruktúre Supabase |
| Zmazanie projektu | Supabase zmaže projekt **aj všetky jeho zálohy** — žiadna kópia mimo Supabase |
| Veľkosť | DB 25 MB (public 7,3 MB, 112 tabuliek, bez views) |
| Vlastná záloha | jednorazová šifrovaná záloha 19. 11. (`C:\Users\roiaj\esblu-backups\2026-11-19-prod-cleanup`), ručná, heslo |

### Storage (súbory) — **najväčšie riziko**
| Bucket | Súkromný | Súbory | Veľkosť |
|---|---|---|---|
| ai-evidence-documents | áno | 2 | 210 KB |
| ai-inbox-documents | áno | 4 | 750 KB |
| company-logos | áno | 2 | 37 KB |
| inventory-photos | áno | 1 | 16 KB |
| machine-photos | áno | 1 | 92 KB |
| vehicle-photos, chat-attachments, einvoice-documents, billing-documents | áno | 0 | 0 |

**Zálohy Supabase databázy súbory v Storage NEOBSAHUJÚ** (iba metadáta `storage.objects`). Obnova DB zo zálohy
nevráti zmazaný ani poškodený súbor. Dnes neexistuje žiadna automatická záloha fotografií vozidiel, strojov, skladu,
dokladov a AI dokumentov.

### Monitoring
| Oblasť | Stav |
|---|---|
| Crony (Vercel, 13 úloh) | bežia — dôkaz v DB: kurzy ECB dnes 16:00, cleanup jobov 03:30; žiadne upozornenie pri zlyhaní |
| Runtime chyby Vercel | 0 za 7 dní (overené cez API); runtime logy majú krátku retenciu |
| Billing ops alerty | implementované (DB + HTTP 503 z `billing-ops-monitor`), e-mail **nenastavený** (chýba `RESEND_API_KEY`, `ESBLU_OPS_ALERT_EMAIL_TO/FROM` v produkcii); pri vypnutom billingu sa heartbeat nepíše |
| eFaktúra ops alerty | v kóde (P3), migrácie zatiaľ nie v produkcii |
| Dostupnosť www.esblu.com | **žiadny externý monitoring** |
| Výpadok Supabase | nesledovaný (iba stavová stránka Supabase) |
| Bezpečnostné udalosti | nesledované priebežne; advisors iba ručne (0 ERROR) |
| Úspešnosť záloh | neexistuje (neexistuje automatická záloha) |

## 2. Návrh — denná šifrovaná záloha (pripravené vo vetve, nespustené)

`scripts/ops/esblu-daily-backup.mjs` + `scripts/ops/esblu-daily-backup.ps1` (Plánovač úloh Windows) + testy.

| Vlastnosť | Riešenie |
|---|---|
| Rozsah | všetky tabuľky `public` (dynamicky z PostgREST), Auth používatelia (bez hesiel — Admin API ich nevracia), **všetky buckety Storage vrátane súkromných** (rekurzívne) |
| Produkcia | iba čítanie (GET + výpis bucketu); test overuje 0 zápisov |
| Integrita | počty riadkov voči serveru, SHA-256 tabuliek, veľkosť + MD5/eTag každého súboru; po zápise sa súbor znovu načíta, rozšifruje a celý overí; inak sa zmaže a beh zlyhá |
| Šifrovanie | AES-256-GCM s náhodným kľúčom na každú zálohu, kľúč zabalený **verejným** RSA-4096 kľúčom; hlavička chránená tagom. Denný beh nepozná heslo ani súkromný kľúč. Súkromný kľúč (šifrovaný heslom) je offline. |
| Kľúč k Supabase | samostatný, samostatne zrušiteľný secret kľúč „backup“, uložený iba cez Windows DPAPI (tento používateľ + PC), nikdy v súbore v čistej podobe |
| Cieľ | `C:\Users\roiaj\esblu-backups\daily` — mimo repa a mimo OneDrive (skript odmietne OneDrive/Dropbox/Google Drive), práva iba pre používateľa |
| Retencia | 14 denných + 1 týždenná zo 4 predchádzajúcich týždňov (najstaršia ≤ ~6 týždňov) |
| Minimalizácia | vynechané: FCM tokeny (`push_devices`), web push odbery, relácie, dočasné potvrdenia/kontexty asistenta, pokusy o aktiváciu eFaktúry; kurzy ECB iba počet |
| Súhrn | `last-success.json` / `backup-runs.jsonl` — iba počty, veľkosti, odtlačky (test overuje, že neobsahuje e-maily ani mená) |
| Automatizácia | Plánovač úloh denne 02:30, spustí sa aj dodatočne po zapnutí PC; log bez tajomstiev; pri chybe `last-failure.json` |
| Testy | `node scripts/ops/esblu-daily-backup-tests.mjs` — 12/12 (mock Supabase na 127.0.0.1: stránkovanie, podpriečinky, minimalizácia, nesprávne heslo/kľúč, poškodenie 1 bajtu, path traversal, retencia, ochrany produkcie/OneDrive); mutácie (vypnutá kontrola MD5, odtlačku) testy zachytia |

### Obnova (runbook)
1. **Chyba v dátach / zmazaný záznam (DB):** Supabase Dashboard → Database → Backups → obnova na posledný deň (do 7 dní). Výpadok aplikácie počas obnovy. Súbory Storage sa tým nevrátia.
2. **Zmazané / poškodené súbory Storage:** `--verify` a `--extract` vlastnej zálohy (súkromný kľúč + heslo) → nahratie súborov na pôvodné cesty cez Storage API (skript na nahratie: ďalší krok, iba po schválení obnovy).
3. **Strata projektu (zmazanie, kompromitácia účtu):** nový projekt → migrácie z repa → import tabuliek v poradí FK → Auth používatelia cez Admin API s pôvodným `id` (heslá sa nezálohujú → reset hesla, Google sa prepojí prihlásením) → nahratie súborov.
4. **Skúška obnovy:** mesačne `--verify` poslednej zálohy (súkromný kľúč z offline úložiska); obnova do izolovanej lokálnej DB raz za štvrťrok. **Nie do stagingu** (produkčné osobné údaje nesmú do testovacieho prostredia).

### Náklady
| Variant | Cena | Odporúčanie |
|---|---|---|
| A. Vlastná denná záloha na PC prevádzkovateľa (vyššie) | 0 € | **áno, hneď** |
| A+. Týždenná offline kópia na šifrovaný USB disk (ochrana pred ransomvérom/krádežou PC) | jednorazovo ~30–60 € (alebo existujúci disk) | áno |
| B. Záloha mimo PC (GitHub Actions / iný cloud) | 0 € pri GitHub minútach, ale prenos osobných údajov k ďalšiemu sprostredkovateľovi | až po stanovisku CLIA |
| C. Supabase PITR (RPO ~2 min) | ~100 USD/mes. + Small compute | nie teraz (25 MB, RPO 24 h je pred spustením primerané) |

## 3. Návrh — monitoring (bez nových platených služieb)
| Vrstva | Riešenie | Cena |
|---|---|---|
| Externá dostupnosť | `scripts/ops/github-workflows/uptime.yml` (šablóna vo vetve; aktivácia = presun do `.github/workflows/`, PAT nemá scope `workflow`): každých 15 min GET `/`, `/login`, 401 chránených API, 404 `ESBLU_BILLING_DISABLED` (zachytí aj omylom zapnuté platby). Zlyhanie = e-mail GitHubu adminom. Overené ručne proti produkcii: 5/5 OK | 0 € (≈720 min/mes. z bezplatných minút GitHubu) |
| Interné kontroly | nový cron `ops-health` (Vercel, existujúci plán): DB dostupná, kurzy ECB z dnes, cleanup joby bez `pending` > 24 h, otvorené ops alerty billing/eFaktúra, čerstvosť zálohy (heartbeat), zlyhané webhooky (`billing_events`/`einvoice_webhook_rejections`), denný počet neúspešných prihlásení | 0 € |
| Upozornenia | e-mail cez Resend (už sprostredkovateľ pre auth e-maily): doplniť `RESEND_API_KEY`, `ESBLU_OPS_ALERT_EMAIL_TO/FROM` do Vercel Production. Obsah iba kódy a počty, žiadne e-maily ani mená | 0 € (bezplatný limit Resend) |
| Heartbeat záloh | malá tabuľka / RPC `esblu_ops_backup_heartbeat` (iba service_role; čas, veľkosť, počty, odtlačok) — **produkčná migrácia, iba po schválení** | 0 € |
| Deploy | Vercel posiela e-mail pri zlyhanom produkčnom deployi (overiť v Team → Notifications) | 0 € |
| Bezpečnosť | týždenne `get_advisors` (security), zmena `internal_operator_grants` / `billing_ops_admins` = alert | 0 € |

## 4. Bezpečnostné a GDPR riziká
| # | Riziko | Závažnosť | Opatrenie |
|---|---|---|---|
| 1 | Súbory Storage nie sú zálohované vôbec | **vysoká** | variant A |
| 2 | Jediné zálohy DB sú v tom istom Supabase účte (strata účtu/projektu = strata záloh) | vysoká | variant A + offline kópia |
| 3 | `C:\Users\roiaj\assetpilot\.env.local` obsahuje **produkčný service_role kľúč a OpenAI kľúč v čistom texte**, `.env` GitHub PAT a Vercel token | vysoká | po zavedení zálohy: rotovať service_role → používať samostatné zrušiteľné kľúče, odstrániť z `.env.local`, tokeny do Správcu poverení |
| 4 | Záloha obsahuje osobné údaje zákazníkov (Esblu = sprostredkovateľ podľa DPA) | stredná | šifrovanie, offline súkromný kľúč, minimalizácia, retencia ≤ ~6 týždňov, umiestnenie v SR (bez nového sprostredkovateľa) |
| 5 | Výmaz účtu sa do záloh premietne až rotáciou | stredná | zdokumentovať lehotu (≤ 6 týždňov) — **otázka pre CLIA** (Zásady a DPA zálohy dnes neuvádzajú; VOP 1.2 čl. 19.4 hovorí iba o zálohe databázy) |
| 6 | Závislosť od zapnutého PC | stredná | `StartWhenAvailable` + heartbeat alert pri zálohe staršej ako 30 h |
| 7 | Žiadny alert na výpadky a zlyhané crony | stredná | monitoring vyššie |

Do záznamov o spracúvaní (RoPA) a TOMs v DPA doplniť: zálohy, šifrovanie, umiestnenie, retencia, prístup — po stanovisku CLIA.
