# Produkčné nasadenie vlny A1 — 2026-11-19 (SUCCESS)

Schválil: prevádzkovateľ (ESBLU 9). Supabase `assetpilot` (`fkpgvgvsmbpieduoatrt`), Vercel `esblu`.

| Krok | Výsledok |
|---|---|
| Preflight | release `1c3e6a7`, main `12da726` (predok), 12 súborov MD5 = overený manifest, billing none/test, eFaktúra 0 org., dáta = záloha (`all_md5 454da245…`) |
| Záloha | `esblu-backups\2026-11-19-pre-a1` (33 min stará, rozšifrovanie OK, dáta nezmenené); denná PHYSICAL záloha 19. 11. 00:33 UTC |
| Migrácie | 12/12 cez `apply_migration`, 22:54–23:09 SEČ, verzie 20261119215434 … 20261119220951; MD5 uloženého SQL = súbor pri všetkých; advisors ERROR 0 → 0; billing none/test/false po každej |
| Merge | PR #1 `release/esblu8` → `main`, merge commit `1e2ab730ab5caab86ab5a72d1042fbca28748f7b` (rodičia `12da726`, `1c3e6a7`); tree = tree `1c3e6a7` (`40ee195b…`) |
| Deploy | `dpl_F2Xidca3H6HcgPDCnVPSLgXgXG4U` READY, target production, aliasy www.esblu.com / esblu.com |
| Smoke | `/`, `/login`, `/cennik`, právne stránky, manifest 200; `data-dpl-id` = nový deployment; 7 cronov bez tajného kľúča 401; Stripe webhook 404 (billing off), eFaktura webhook 503 NOT_CONFIGURED, billing manage 404 BILLING_DISABLED, mandát 401 |
| Dáta | odtlačky users/identities/companies/members/entitlements/settings/objects nezmenené; interné granty 0; billing_events/checkouty/predplatné 0; ops alerty/heartbeaty 0; A2/B migrácie 0 |
| Monitoring | Vercel runtime errors (1 h) 0; runtime logy bez chýb |

Rollback: Vercel Instant Rollback na `dpl_7rkNSeF2…` (`12da726`) je kompatibilný s novou schémou; DB rollback iba pri chybe migrácie (12 → 1, samostatný súhlas).
Mimo A1: pridelenie interného tarifu (po registrácii Esblu s. r. o. + schválení), Stripe LIVE, eFaktúra LIVE, A2, B.
