# Mobile security audit (Android + iOS), 2026-10-08

**Rozsah:** kód na branchi `mobile-platform` (z `main` @ `901c46c`).
**Pravidlo:** RLS a serverové RPC sú vždy posledná autorita. Mobilná appka je iba klient s verejným anon kľúčom a JWT používateľa.

## Opravené v tejto zmene

| # | Nález | Závažnosť | Oprava | Test |
|---|---|---|---|---|
| S1 | Zrušenie owner účtu firmy s **finalizovanými faktúrami** najprv zmazalo súbory zo Storage a až potom DB guard `esblu_block_finalized_invoice_delete` zastavil zmazanie firmy → stratené prílohy, firma ostala | HIGH | `findOwnerDeletionBlocker` (finalizované faktúry) v preflight **aj** delete route **pred** akýmkoľvek mazaním. 409 + jasné vysvetlenie v UI; chyba overenia = fail closed | `mobile-platform-tests`: zrušenie firmy s finalizovanými dokladmi |
| S2 | 7 ciest odhlásenia (DPA gate, právna brána, pozvánka, reset hesla, onboarding, login bootstrap, čiastočné zrušenie účtu) volalo priamo `supabase.auth.signOut()` **bez odregistrácie push** | HIGH (súkromie) | Všetko cez `signOutOnThisDevice()`: push odregistrácia + vyčistenie OAuth stavu a `sessionStorage` + signOut | statický test: žiadne `auth.signOut(` mimo `lib/sign-out.ts` |
| S3 | `android:allowBackup="true"` — localStorage WebView so Supabase refresh tokenom sa mohol zálohovať do cloudu alebo preniesť na iné zariadenie | MED | `allowBackup="false"` | manifest test |
| S4 | Fotky so signed URL (AI evidencia ×2, sklad, stroje) cez holé `<a target="_blank">` → navigácia WebView mimo appku, signed URL v histórii | MED | `externalFileLinkProps` → in-app prehliadač na mobile, web nezmenený | statický test |
| S5 | Žiadne obnovenie session po návrate z pozadia; odvolaná session nechala používateľa na chránenej obrazovke | MED | `AppLifecycleBridge` (stop/start auto-refresh, `getSession`, `SIGNED_OUT` → login) | lifecycle testy |
| S6 | Chat: rýchle dvojité Enter = duplicitná správa | MED | guard `sending` | statický test |
| S7 | OAuth v natívnej appke chýbal; bez opatrení hrozil embedded WebView OAuth | — | Systémový prehliadač + PKCE + custom scheme iba `com.esblu.app://auth/callback`; iOS bez Google, kým nie je Sign in with Apple | OAuth + deep link testy |

## Audit — stav

| Oblasť | Stav | Poznámka |
|---|---|---|
| Secrets v mobile bundli | OK | Iba `NEXT_PUBLIC_*` (Supabase URL + anon kľúč, voliteľné originy). `service_role` iba v `lib/supabase-admin.ts`, importovaný výlučne z `app/api/**`. Test: žiadny `"use client"` súbor nečíta server-only env |
| Natívne secrets | OK | `google-services.json`, `GoogleService-Info.plist`, `keystore.properties`, APNs `.p8` nie sú v repe; APNs/FCM kľúče iba v server env |
| `ESBLU_LEGAL_CONTENT_ROOT` v `mobile/next.config.ts` `env` | LOW (nález) | Absolútna cesta build stroja by sa vložila do bundlu, ak by ju čítal klientsky kód. Dnes iba serverové legal stránky. Neopravené (mimo scope), sledovať |
| OAuth tokeny | OK | PKCE (`flowType: "pkce"`). Tokeny nie sú v URL ani histórii; `code` bez verifiera je bezcenný |
| Lokálne úložisko | ACCEPTED RISK | Supabase session v localStorage WebView (app sandbox). Na rootnutom alebo jailbreaknutom zariadení čitateľná. Secure storage (Keychain/Keystore) by vyžadoval vlastný storage adapter + plugin → navrhované pre ďalšiu fázu |
| Deep link injection | OK | Prísny allowlist (host, `https`, presné cesty, 64-hex token, custom scheme iba `auth/callback`). Push tap iba `{screen, UUID}` |
| WebView navigácia | OK | Žiadny `server.url` ani `allowNavigation`. Externé URL cez `@capacitor/browser` alebo systém |
| Otváranie ľubovoľných URL | OK | `openExternalUrl` sa volá iba so signed URL zo servera alebo kanonickými stránkami Esblu |
| File URI exposure | OK | Exporty v `Directory.Cache`, zdieľané cez Share sheet / FileProvider (`file_paths.xml`); žiadny verejný permanentný priečinok |
| Screenshot / clipboard | LOW | Bez FLAG_SECURE (nie je bankovná appka). Clipboard iba pri kopírovaní pozývacieho odkazu na pokyn používateľa |
| Tenant isolation | OK | Firma vždy z `auth.uid()` v RPC a RLS; deep link na cudzí záznam = not found |
| Role (employee finance) | OK | Mobilná navigácia skrýva finance položky; RLS `esblu_my_finance_view/manage` platí rovnako |
| Push token ownership | OK | RPC ako prihlásený používateľ, väzba na `auth_session_id`; cudzí token sa neprevezme; doručenie iba živej session + aktívnemu členstvu |
| Ukradnuté zariadenie | OK | „Odhlásiť všade" / reset hesla odvolá sessions; refresh zlyhá → `SIGNED_OUT` → login; push zastavený (väzba na session) |
| Push obsah na lockscreene | OK | Preferencia „náhľad správ" (`showMessagePreview`); faktúry sa v push neposielajú |
| Duplicitné vytvorenie po stratenej odpovedi | OPEN (MED) | Idempotency kľúče iba pri AI scan. Návrh: idempotency kľúč pri insert RPC (DB migrácia so súhlasom) |
| Dynamické cesty (static export) | OK | `resolveAppHref` / `AppLink`; 2 `next/link` bez resolvera (legal markdown, dashboard search) — LOW |

## Odporúčané ďalšie kroky (bez zásahu do produkcie)

1. Idempotency pre create RPC (faktúra draft, partner, vozidlo, stroj, sklad, priečinok, chat) — **DB migrácia → potrebný súhlas**.
2. Secure storage adapter pre Supabase session (Keychain/Keystore) — nový natívny plugin, bez enrollmentu.
3. Odstrániť `ESBLU_LEGAL_CONTENT_ROOT` z `env` bloku (presunúť do serverového runtime).
