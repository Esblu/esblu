# PR: Bezpečnostné aktualizácie závislostí (Next.js 16.4.6, Capacitor 8.6.2) — 2026-11-20

Vetva `fix/dependency-security-2026-11-20` (z `origin/main` `1e2ab73`). Bez zmeny aplikačného kódu, DB, RLS ani migrácií.
Merge do `main` a produkčný deploy iba po výslovnom schválení prevádzkovateľa.

## Commity
| SHA | Zmena |
|---|---|
| `f3435d1` | `package.json`, `mobile/package.json`, `package-lock.json`: next 16.3.8 → 16.4.6, eslint-config-next 16.4.6, @capacitor/core/android/ios/cli 8.5.x → 8.6.2, `npm audit fix` bez `--force` |
| `4b67bf7` | `release/build-release-aab.ps1`: predvolene vc5 / 1.0.2, vc1–vc4 odmietnuté; test `android-release-tooling` |
| (tento) | dokumentácia PR |

## Zmeny lockfile (51 zmenených, 1 pridaný, 1 odstránený; všetko z registry.npmjs.org s integrity)
Produkčné: next + @next/env + @next/swc-* 16.4.6; @capacitor/android, core, ios 8.6.2; zod 4.4.3 → 4.6.7;
source-map-js 1.2.4; brace-expansion 1.1.22 (aj readdir-glob/2.1.8); baseline-browser-mapping 2.11.39; caniuse-lite.
Vývojové: typescript-eslint 8.73.0, eslint-config-next 16.4.6, @capacitor/cli 8.6.2 (glob 14, minimatch 11, xcode 4.0.0),
browserslist 4.29.6, js-yaml 4.3.2 a ďalšie tranzitívne. Pridaný `@isaacs/nonrecursive-glob-match` (glob 14), odstránený `xcode/uuid` 7.0.3.

## Opravené zraniteľnosti (npm audit: 21 → 2)
| Balík | Advisory | Závažnosť |
|---|---|---|
| next | GHSA-2464-fhr4-w9xw (RCE Image Optimization + SVG), GHSA-673q-mjm6-r5xr (RCE `use cache`), GHSA-p3m5-59mp-jv5r (DoS Server Actions) + 6 moderate | 2 critical, 1 high |
| @capacitor/android | GHSA-rvm3-566m-v7fv — v 8.5.0 bol interný proxy `/_capacitor_http_interceptor_` dostupný aj pre navigáciu dokumentu (vzdialený obsah na origine appky) aj pri vypnutom CapacitorHttp; 8.6.2 ho blokuje (overené diffom `WebViewLocalServer.java`, `Bridge.java`) | critical (týka sa Android vc1–vc4) |
| zod, source-map-js, brace-expansion | DoS | high |
| browserslist, js-yaml, typescript-eslint, glob, minimatch, xcode/uuid | DoS / dev nástroje | high / moderate |

## Zostávajúce (2× moderate, akceptované)
`exceljs 4.4.0 → uuid 8.3.2` (GHSA-w5hq-g745-h8pq: v3/v5/v6 s parametrom `buf`). exceljs volá iba `uuidv4()` bez `buf`
(`cf-rule-ext-xform.js`) → nezneužiteľné. Oprava podľa npm = downgrade exceljs na 3.4.0 (nevhodné).

## Validácia
| Kontrola | Výsledok |
|---|---|
| `npm ci` (čistá inštalácia) | PASS, 605 balíkov |
| `tsc --noEmit` | 0 chýb |
| ESLint (celé repo, 680 súborov) | 36 chýb / 31 varovaní = baseline `origin/main` (rovnaké pravidlá) |
| `next build` (web) | PASS, 61 stránok, 101 ciest = zhodné s `origin/main` |
| `npm run build -w mobile` + `npx cap sync android` | PASS, 34 stránok, 5 pluginov, **žiadna zmena sledovaných natívnych súborov** |
| `android-prebuild-check --target production` | všetko OK (API probe overená curl: `/api/push/preferences` → JSON 401) |
| Regresné testy | **122/123 PASS** (~2 470 tvrdení, PGlite RLS/authz, billing/Stripe adaptér, webhooky, auth recovery, secure storage, eFaktúra, mobil). `test:pricing-engine` 18/19 — **zlyháva rovnako na `origin/main`** (audit uploadov počíta pozície v `app/ai-evidencia/page.tsx`), nesúvisí |
| `npm audit` | 0 critical, 0 high, 2 moderate (vyššie) |
| Vercel Preview `dpl_23NBHy6eodSWdSkb25t2z5cdWg3N` | READY pre SHA `4b67bf7`, build na Verceli: Next.js 16.4.6, 61/61; DB Preview = staging `cjbdijbbcujvmrzezusd` |
| Smoke Preview (iba GET) | `/login` 200 (SSR), `/api/billing/purchase-options` 404 `ESBLU_BILLING_DISABLED`, `/api/billing/webhooks/stripe` GET 405, `/api/push/preferences` a `/api/cron/billing-stripe-events` 401 bez prihlásenia; runtime chyby za 1 h: 0 |

## Kompatibilita
- **Supabase / Auth / RLS:** `@supabase/supabase-js` bez zmeny; DB, migrácie, RLS bez zmeny; DB testy (authz, RLS, termination, billing, eFaktúra) PASS.
- **Stripe:** bez zmeny kódu ani verzie API (`2025-03-31.basil`); stripe-adapter, webhook-idempotency, billing-* DB testy PASS; billing v Preview aj produkcii vypnutý.
- **Android:** Capacitor 8.6.2 vyžaduje AGP 8.13.0, compileSdk/targetSdk 36, minSdk 24, Java 21 = zhodné s projektom (`variables.gradle`, `build.gradle`). Zmeny v natívnej vrstve: blokovanie proxy, CSP na proxy odpovediach, null-check anotácií pluginov, SystemBars (insets/klávesnica). Vlastné pluginy (SecureStorage, AppConfig, Billing) používajú nezmenené API.
- **Neoverené tu:** Gradle kompilácia a podpísaný AAB (v prostredí agenta nie je Android SDK ani Maven; podpisový kľúč je iba u prevádzkovateľa); vzhľad safe-area/klávesnice na zariadení.

## Android vc5 (interný, nie verejný)
`release/build-release-aab.ps1` (predvolene vc5 / 1.0.2) s `-PrepareWeb` na PC prevádzkovateľa → Internal testing → kontrola: prihlásenie (e-mail + Google), push, otvorenie dokumentov, zdieľanie, OAuth návrat, safe-area a klávesnica. Verejné vydanie nie.

## Rollback
1. Web: Vercel Instant Rollback na `dpl_F2Xidca3H6HcgPDCnVPSLgXgXG4U` (produkcia `1e2ab73`) — bez DB zmien, okamžité.
2. Kód: `git revert` merge commitu v `main` (lockfile sa vráti celý).
3. Android: vc5 iba v internom kanáli; pri probléme sa nepovýši, vc4 ostáva (Play neumožňuje znížiť versionCode — oprava = vc6).

## Postup po schválení
merge PR → Vercel READY pre presné SHA → smoke www.esblu.com (`/`, `/login`, 401 API, billing 404) → `get_runtime_errors` 1 h → vc5 interný test.
