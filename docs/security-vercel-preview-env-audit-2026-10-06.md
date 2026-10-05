# Vercel Preview env — audit a plán nápravy (6. 10. 2026)

Interný bezpečnostný podklad. Neobsahuje hodnoty secrets. **Nič z plánu nižšie nebolo vykonané** —
každý krok mení produkčne používaný Vercel env záznam a vyžaduje výslovný súhlas vlastníka.

## 1. Zistenie

Projekt `esblu` (prj_MKhX94GSEcP6278EJoKqaSGRxkv8). Záznamy, ktoré majú **spoločný** cieľ
`production` + `preview` (jeden záznam, jedna hodnota) a platia pre **každú** Preview vetvu bez
vlastného override:

| Kľúč | ID záznamu | Ciele | Typ | Dopad v bežnom Preview |
| --- | --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | `94eoB742kId6zQAW` | preview, production | sensitive | **kritický** — service_role produkčnej DB (obchádza RLS) v kóde ľubovoľnej vetvy |
| `OPENAI_API_KEY` | `dsDOdiAUOs3kVZLd` | production, preview | sensitive | vysoký — produkčný kľúč, náklady a dáta z Preview |
| `NEXT_PUBLIC_SUPABASE_URL` | `lvLXSNBt82Av1YV4` | production, preview | sensitive | stredný — Preview pracuje s produkčnou DB (cez RLS) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `Fc1URq2hniY1JgEJ` | production, preview | sensitive | nízky (verejný kľúč), ale smeruje Preview na produkčnú DB |

Vetva `einvoice-port` má vlastné branch-specific override (staging `esblu-test`, sandbox eFaktúra),
ktoré majú prednosť — tá je v poriadku.

Ostatné produkčné secrets (`CRON_SECRET`, `ESBLU_ACTION_CONFIRMATION_SECRET`,
`ESBLU_INTAKE_ATTEST_SECRET`, `FCM_*`, `VAPID_*`) sú iba `production` — v poriadku.

**Expozícia doteraz:** v histórii deploymentov od 31. 8. 2026 (posledných 100) existujú iba
produkčné deploye z `main` a Preview z `einvoice-port` (s staging override od prvého deployu).
Iná Preview vetva v tomto období nevznikla. Staršie obdobie API neukázalo — nevieme vylúčiť.
Preview sú chránené Vercel Authentication (`all_except_custom_domains`), Protection Bypass je
zrušený, fork protection zapnutá. Riziko je teda hlavne **latentné**: prvý push akejkoľvek novej
vetvy (alebo PR) dostane produkčný service_role a OpenAI kľúč do build aj runtime prostredia.

## 2. Cieľový stav

- Žiadna bežná Preview vetva nedostane produkčný `SUPABASE_SERVICE_ROLE_KEY` ani `OPENAI_API_KEY`.
- Production sa nezmení (rovnaké hodnoty, rovnaký cieľ `production`).
- `einvoice-port` override ostáva funkčný.
- Odporúčanie: všeobecné Preview = staging `esblu-test` (URL, anon, service_role stagingu),
  bez OpenAI (AI funkcie v Preview vypnuté), alebo samostatný OpenAI kľúč s limitom.

## 3. Plán (vyžaduje súhlas — mení produkčne používané záznamy)

Vykonanie cez Vercel REST API (`PATCH /v9/projects/esblu/env/{id}`), hodnoty sa NEMENIA, mení sa
iba zoznam cieľov. Production deployment sa tým nemení (env sa aplikuje na nové deploye).

1. **Snapshot** — `GET /v10/projects/esblu/env` (ID, kľúč, ciele, vetva, typ) uložiť mimo repa.
2. `SUPABASE_SERVICE_ROLE_KEY` `94eoB742kId6zQAW`: ciele `["production"]`.
3. `OPENAI_API_KEY` `dsDOdiAUOs3kVZLd`: ciele `["production"]`.
4. (Odporúčané) `NEXT_PUBLIC_SUPABASE_URL` `lvLXSNBt82Av1YV4` a `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   `Fc1URq2hniY1JgEJ`: ciele `["production"]`.
5. Nové všeobecné Preview záznamy (bez `gitBranch`): `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` = staging `esblu-test`.
   (Bez kroku 5 sa Preview bez override zostaví bez Supabase konfigurácie → serverové funkcie
   zlyhajú fail-closed; build môže zlyhať, ak niečo vyžaduje `NEXT_PUBLIC_SUPABASE_*` pri builde.)
6. **Overenie:**
   - `GET env` → žiadny produkčný záznam s cieľom `preview`;
   - `einvoice-port` override nezmenené (8 kľúčov + E2E prepínač);
   - redeploy Preview `einvoice-port` → READY, `staging-e2e` guard OK (staging DB);
   - skúšobná vetva `chore/preview-env-check` (bez zmien kódu) → Preview READY a jej runtime
     ukazuje staging ref (napr. read-only endpoint health / log bez hodnôt) → vetvu zmazať;
   - Production: **žiadny** redeploy nie je potrebný; pri najbližšom produkčnom deployi skontrolovať
     smoke test www.esblu.com.
7. **Rotácia** (rozhodnutie vlastníka): ak nemožno vylúčiť, že staršia Preview vetva (pred 31. 8.)
   bežala s produkčným service_role, zvážiť rotáciu Supabase service_role / JWT secretu a OpenAI
   kľúča. Rotácia = zásah do produkcie (výpadok pri nesynchronizovanej zmene) → samostatný plán.

## 4. Rollback

- Kroky 2–4: `PATCH` toho istého ID späť na `["production","preview"]` (ID sú stabilné, hodnoty
  sa nemenili).
- Krok 5: `DELETE /v9/projects/esblu/env/{id}` nových Preview záznamov.
- Production nie je ovplyvnená ani pri rollbacku (cieľ `production` sa nikdy neodoberá).

## 5. Stav

- Audit: **hotový** (read-only).
- Náprava: **pripravená, nevykonaná** — čaká na výslovný súhlas.
