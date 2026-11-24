# P1-5 — skupina C: bezpečnostný audit runnera po opravách F-1 až F-6 (2026-11-24)

Iba lokálne. Žiadny kľúč, žiadne spustenie proti stagingu, žiadny push.

## Kontrolované súbory (F-4)

| Súbor | Úloha | SHA-256 (kontroluje .ps1) |
| --- | --- | --- |
| `release-backups/p15/run-p15-groupC.ps1` (mimo Git, `.git/info/exclude`) | spúšťač | — |
| `scripts/p15-staging/p15-staging-storage-export.ts` | vstup Node | fc413abd… |
| `scripts/p15-staging/runner-core.ts` | logika a poistky | 19403fce… |
| `scripts/p15-staging/manifest.json` | 322 syntetických súborov | fd81a8f5… (kontroluje aj runner) |
| `lib/company-export.ts` | zoznamy tabuliek/súborov exportu | 96adf813… (aj runner) |
| `lib/einvoice/visibility.ts` | R3 filter | 7013c5f6… (aj runner) |
| `node_modules/@supabase/*` (dist + package.json, 375 súborov, 2.110.0) | klient | súhrnný 246fd693… |

Testovacie súbory (`runner-tests.ts`, `gen.py`, `seed-group-c.sql`) runner nevykonáva.

## Opravy

| # | Oprava | Test |
| --- | --- | --- |
| F-1 | E5: poškodený XML → očakávané `FILES_CORRUPT`; obnova presných bajtov (`replaceControlled('E5_restore')`), SHA-256 = `xml_sha256`; E6: export T2 `completed`. Obnova aj vo `finally` pri prerušení; zlyhanie obnovy = exit 3 + „KRITICKÉ“ | „neúspešná obnova…“, „prerušenie medzi poškodením a obnovou“ |
| F-2 | stav objektu: `missing` / `valid` / `known_corrupt` / `unexpected`; nový objekt iba `upsert:false`; neočakávaný obsah = STOP bez prepisu; prepis existujúceho iba 3 pevné dôvody pre 2 presné cesty; E4 pri existujúcich súboroch = SKIP | „beh 2 a beh 3“, „prerušený upload“, „neočakávaný obsah“ |
| F-3 | presná URL `https://cjbdijbbcujvmrzezusd.supabase.co` (bez cesty/portu/používateľa/query); `guardedFetch` pre všetky požiadavky supabase-js: iný origin = výnimka, `redirect: 'error'` | 12 nesprávnych URL, supabase-js s cudzím projektom (nič neodoslané), skutočný proces exit 2 |
| F-4 | .ps1: SHA-256 5 lokálnych súborov + súhrnný odtlačok `@supabase`; runner znova overí manifest a knižnice | zmenená knižnica / manifest = STOP |
| F-5 | .ps1 odstráni `NODE_OPTIONS`, `NODE_PATH`, proxy, TLS a CA premenné, `NPM_CONFIG_*`; runner overí to isté + presné `execArgv`; .ps1 odmietne bežiaci `Start-Transcript` | 9 premenných, 4 varianty execArgv, skutočný proces s podstrčeným `--require` = exit 2 |
| F-6 | napevno 4 UUID firiem, názvy a vlastníci; každý súbor: `company_id` ∈ schválené, cesta = `<company_id>/…`, bez `..`, iba 2 buckety, obsah = SHA-256; S0: DB firmy, zoznamy súborov exportu, R3 riadky a osirelé súbory = manifest | 9 mutácií manifestu, cudzia DB (premenovaná firma) = STOP bez zápisu |

Ďalej: odvolanie kľúča sa vyžiada vo `finally` vždy, keď bol kľúč zadaný (aj pri chybe).

## Offline testy (`runner-tests.ts`, PGlite + Storage v pamäti, 17/17 PASS)

Nesprávna URL (aj skutočný proces), guardedFetch, supabase-js s cudzím projektom, zmenená knižnica/manifest,
NODE_OPTIONS (aj skutočný proces), cudzie company_id, beh 1 (všetky kroky vrátane PERF) / beh 2 / beh 3,
izolácia (žiadny zápis mimo 4 firiem, pôvodný objekt nezmenený), prerušený upload, čiastočne dokončený export,
prerušenie počas E5, neúspešná obnova (exit 3) + oprava ďalším behom, neočakávaný obsah, neznámy stav objektu,
nesúlad DB. `tsc --strict` bez chýb.

## Zostávajúce riziká

- `.ps1` sa nedá spustiť v Linuxovom sandboxe (bez PowerShellu) — overený staticky (ASCII, odtlačky = súbory,
  zoznam premenných, presná URL a parametre); prvý beh na Windows overí krok 1/6.
- Secret key má práva service_role na celý projekt (nedá sa obmedziť) — iba počas behu, odvolanie povinné.
- Tranzitívne závislosti mimo `@supabase` (napr. `ws`) nie sú odtlačkom pokryté; sieť aj tak obmedzuje guardedFetch.

## Verdikt

**PASS** — runner je možné spustiť podľa kontrolného zoznamu v reporte.
