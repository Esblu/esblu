# Vercel Preview env — audit a plán nápravy (6. 10. 2026)

> **Stav 7. 10. 2026: VYRIEŠENÉ vlastníkom.** Read-only kontrola (iba kľúče, ciele a vetvy; z hodnôt iba
> verejná Supabase URL): všeobecný Preview `NEXT_PUBLIC_SUPABASE_URL` → staging `cjbdijbbcujvmrzezusd`;
> Production má samostatné záznamy; `einvoice-port` má branch override. Zvyšok dokumentu je historický.

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

## 2. Doplnený audit (7. 10. 2026)

- **Build závislosti:** `lib/supabase.ts` číta `NEXT_PUBLIC_SUPABASE_URL` pri importe (klientsky bundle) a
  `lib/intents/ai-fallback.ts` vytvára OpenAI klienta s `OPENAI_API_KEY` už pri načítaní modulu. Ak by sa
  preview cieľ iba odobral bez náhrady, Preview build/runtime bežných vetiev môže zlyhať. Preto plán
  nahrádza hodnoty (nie iba odoberá).
- **Prednosť:** branch-specific záznamy (`gitBranch`) majú prednosť pred všeobecnými Preview záznamami —
  `einvoice-port` override ostáva funkčný bez zmeny.
- **Konflikt:** Vercel nedovolí dva všeobecné záznamy s rovnakým kľúčom a prekrývajúcim sa cieľom → pre
  každý kľúč treba najprv odobrať `preview` zo spoločného záznamu, potom vytvoriť nový Preview záznam.
- **Typ:** spoločné záznamy sú `sensitive` (hodnota sa nedá prečítať) — hodnota sa preto nemení ani
  nekopíruje; mení sa iba zoznam cieľov.
- **Expozícia:** od 31. 8. 2026 neexistuje žiadny Preview deployment inej vetvy než `einvoice-port`
  (ktorá mala staging override od prvého deployu). Pred 31. 8. nevieme overiť.

## 3. Cieľový stav

| Kľúč | Production | Preview (všetky vetvy) | Preview `einvoice-port` |
| --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | produkčný (bez zmeny) | **staging esblu-test** | staging (bez zmeny) |
| `NEXT_PUBLIC_SUPABASE_URL` | produkčný (bez zmeny) | **staging esblu-test** | staging (bez zmeny) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | produkčný (bez zmeny) | **staging esblu-test** | staging (bez zmeny) |
| `OPENAI_API_KEY` | produkčný (bez zmeny) | **`preview-disabled`** (nefunkčná hodnota → AI volania v Preview zlyhajú 401, build prejde) alebo samostatný staging kľúč s limitom (rozhodnutie vlastníka) | dedí všeobecný Preview |

## 4. Presný plán (VYŽADUJE SÚHLAS — mení produkčne používané záznamy)

Okno: bez pushov na iné vetvy než `main` počas zmeny (~5 min). Production deployment sa nemení — env sa
aplikuje až na nové deploye; produkčné hodnoty a cieľ `production` zostávajú.

| Krok | Volanie (Vercel REST, token mimo repa) | Dopad |
| --- | --- | --- |
| 0 | `GET /v10/projects/esblu/env` → snapshot (ID, kľúč, ciele, vetva, typ) mimo repa | žiadny |
| 1 | `PATCH /v9/projects/esblu/env/94eoB742kId6zQAW` `{"target":["production"]}` (SUPABASE_SERVICE_ROLE_KEY) | Preview bez service_role do kroku 2 |
| 2 | `POST /v10/projects/esblu/env` `{"key":"SUPABASE_SERVICE_ROLE_KEY","value":<staging>,"type":"sensitive","target":["preview"]}` | Preview = staging |
| 3 | `PATCH …/lvLXSNBt82Av1YV4` `{"target":["production"]}` + `POST` staging `NEXT_PUBLIC_SUPABASE_URL` (preview, encrypted) | Preview klient → staging |
| 4 | `PATCH …/Fc1URq2hniY1JgEJ` `{"target":["production"]}` + `POST` staging `NEXT_PUBLIC_SUPABASE_ANON_KEY` (preview, encrypted) | Preview klient → staging |
| 5 | `PATCH …/dsDOdiAUOs3kVZLd` `{"target":["production"]}` + `POST` `OPENAI_API_KEY`=`preview-disabled` (preview, encrypted) | AI v Preview nefunguje (zámerne) |
| 6 | Overenie: `GET env` — žiadny záznam bez `gitBranch` s cieľom `preview` a produkčnou hodnotou; 4 nové Preview záznamy; `einvoice-port` override nezmenené | — |
| 7 | Redeploy Preview `einvoice-port` → READY (`guard ok` iba ak sa driver dočasne zapne — inak 404) | overenie buildu |
| 8 | Production: žiadna akcia; pri najbližšom produkčnom deployi bežný smoke test www.esblu.com | — |

Hodnoty stagingu: `Documents\esblu-l3-staging.env` (mimo repa), prenos bez výpisu (rovnako ako pri
`einvoice-port` override).

## 5. Rollback (každý krok samostatne)

- Kroky 1, 3, 4, 5: `DELETE /v9/projects/esblu/env/<nové Preview ID>` a potom
  `PATCH /v9/projects/esblu/env/<pôvodné ID>` `{"target":["production","preview"]}` (pôvodné ID a hodnoty
  sa nemenili).
- Production nie je dotknutá ani pri rollbacku (cieľ `production` sa nikdy neodoberá).

## 6. Rotácia (samostatné rozhodnutie)

Ak nemožno vylúčiť, že pred 31. 8. 2026 bežala Preview vetva s produkčným service_role, zvážiť rotáciu
Supabase JWT secret / service_role a OpenAI kľúča. Rotácia je zásah do produkcie s rizikom výpadku a
vyžaduje vlastný plán (poradie: nový kľúč do Vercel Production → redeploy → zneplatnenie starého).

## 7. Stav

- Audit: **hotový** (read-only).
- **Náprava vykonaná 6. 10. 2026 so súhlasom vlastníka** (variant OpenAI: `preview-disabled`):

| Kľúč | Pôvodne (ID, ciele) | Teraz Production | Teraz všeobecný Preview (nové ID) |
| --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | `94eoB742kId6zQAW` preview+production | `94eoB742kId6zQAW` (hodnota nezmenená) | `pbmpFkGLIaVLfDrJ` staging esblu-test (sensitive) |
| `NEXT_PUBLIC_SUPABASE_URL` | `lvLXSNBt82Av1YV4` production+preview | `lvLXSNBt82Av1YV4` | `Wmqd7d5xX6pCkhbg` staging |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `Fc1URq2hniY1JgEJ` production+preview | `Fc1URq2hniY1JgEJ` | `AEk28LXqYo2wIa4e` staging |
| `OPENAI_API_KEY` | `dsDOdiAUOs3kVZLd` production+preview | `dsDOdiAUOs3kVZLd` | `SnsgXI7Q5RAOoLI4` `preview-disabled` |

- Production záznamy: rovnaké ID a `createdAt`, zmenený iba zoznam cieľov (PATCH bez hodnoty);
  žiadny produkčný deploy; www.esblu.com 200.
- `einvoice-port` override (10 záznamov) nezmenené (ID aj `updatedAt`) — majú prednosť.
- Preview `einvoice-port` redeploy `dpl_84MP4yvvJj1M4mCp8pTYwc7gLjU9` READY.
- Snapshoty (iba názvy / ciele / vetvy, bez hodnôt) a záznam zmeny: mimo repa v `Documents`.
- Rollback pripravený podľa sekcie 5 (ID v tabuľke vyššie).
