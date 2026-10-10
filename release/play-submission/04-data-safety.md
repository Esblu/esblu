# 04 — Data safety (konzervatívny draft)

Podklad: reálny kód (`mobile-platform`) + merged manifest AAB 1.0.0 (vc1). Internal testing Data safety **nevyžaduje**; povinné od Closed testing. Položky označené **NEEDS LEGAL/CLIA CONFIRMATION** musí potvrdiť CLIA/legal.

## Všeobecné odpovede
| Otázka | Odpoveď | Opora |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | tabuľka nižšie |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | HTTPS: `www.esblu.com` (Vercel), `*.supabase.co`, OpenAI API (server-side), FCM; `usesCleartextTraffic` nie je povolený (targetSdk 36 default = zakázaný cleartext) |
| Do you provide a way for users to request that their data is deleted? | **Yes** | in-app Nastavenia → Zrušiť účet; web `https://www.esblu.com/zrusenie-uctu` (**zatiaľ iba na vetve — 404 na produkcii**) |
| Account creation method | **Username/e-mail + password** a **OAuth (Google)** | Supabase Auth |
| Data deletion URL | `https://www.esblu.com/zrusenie-uctu` | po deployi |

## Externé služby (kontext pre „shared")
| Služba | Rola | Dáta |
|---|---|---|
| Supabase (EU, Frankfurt) | hosting DB/Auth/Storage — spracovateľ | všetky dáta appky |
| Vercel (fra1) | hosting webu a API — spracovateľ | prenos všetkých API požiadaviek |
| OpenAI | AI vyťaženie dokladov (`scan-document`, `scan-vehicle-*`, `store:false`), prepis hlasu (`gpt-4o-transcribe`, bez `store` parametra — SDK ho pri prepise nemá), AI fallback asistenta (`store:false`) | obrázky dokladov/fotiek, audio hlasu, text príkazov |
| Firebase Cloud Messaging (Google) | doručenie push | FCM token, Firebase Installation ID, text notifikácie (generický; náhľad správy predvolene vypnutý) |
| Verejné registre RPO / RÚZ (SR) | lookup firmy podľa IČO/názvu | IČO/názov **firmy** (nie osobný údaj používateľa) |

Podľa Google je zdieľanie so **service providerom** (spracúva v mene vývojára) výnimka z „shared". OpenAI/FCM/Supabase/Vercel sú spracovatelia → technicky „not shared". **Konzervatívne odporúčanie:** OpenAI uviesť ako **Shared** pri Photos, Files, Voice, Financial info, Other UGC (dáta opúšťajú infraštruktúru Esblu k AI poskytovateľovi). **NEEDS LEGAL/CLIA CONFIRMATION** (výklad + zmluvné postavenie OpenAI, lokalita spracovania).

## Typy dát
| Kategória → typ | Collected | Shared | Povinné? | Účel | Mazanie | Pozn. |
|---|---|---|---|---|---|---|
| Personal info → Email address | Yes | No | Required | Account management, App functionality | Yes | Auth, pozvánky |
| Personal info → User IDs | Yes | No | Required | Account management | Yes | `auth.users.id` |
| Personal info → Name | Yes (iba Google login: profil od Google v `auth.users` identity) | No | Optional | Account management | Yes | appka meno nezobrazuje ani nežiada |
| Personal info → Other info (firma, IČO/DIČ, adresa; kontakty partnerov — e-mail, telefón) | Yes | No | Required (firma) / Optional (partneri) | App functionality | Yes (owner zrušenie firmy; blokované pri finalizovaných faktúrach — viď 06) | **NEEDS LEGAL/CLIA** — údaje tretích osôb (kontakty partnerov) |
| Financial info → Other financial info (faktúry, úhrady, IBAN/BIC firmy a partnerov) | Yes | **Yes (konzervatívne)** — iba keď používateľ naskenuje doklad (OpenAI) | Optional | App functionality | Yes, s výnimkou zákonnej archivácie | **NEEDS LEGAL/CLIA** — retencia finalizovaných dokladov |
| Financial info → Payment info / Purchase history / Credit info | **No** | — | — | — | — | žiadny platobný SDK, žiadne karty |
| Photos and videos → Photos | Yes | **Yes (konzervatívne, OpenAI pri skenoch)** | Optional | App functionality | Yes | fotky vozidiel/strojov/skladu, doklady |
| Photos and videos → Videos | **No** | — | — | — | — | |
| Audio → Voice or sound recordings | Yes | **Yes (OpenAI prepis)** | Optional | App functionality | — (**ephemeral**: audio sa neukladá, iba in-memory počas requestu — `app/api/assistant/transcribe/route.ts`) | označiť „processed ephemerally"; **NEEDS LEGAL/CLIA** (retencia na strane OpenAI) |
| Files and docs → Files and docs | Yes | **Yes (konzervatívne, OpenAI pri skenoch)** | Optional | App functionality | Yes | Storage buckety (privátne) |
| Messages → Other in-app messages (firemný chat) | Yes | No (push nesie generický text) | Optional | App functionality | Yes (člen: identita; obsah ostáva firme — viď 06) | **NEEDS LEGAL/CLIA** — správy člena po jeho zrušení ostávajú firme |
| App activity → Other user-generated content (text príkazov asistenta) | Yes | **Yes (OpenAI fallback, `store:false`)** | Optional | App functionality | kontext asistenta expiruje | |
| App activity → App interactions / In-app search / Other actions | **No** (žiadna analytika) | — | — | — | — | |
| Device or other IDs | Yes (FCM token, Firebase Installation ID, interné installation UUID) | No (FCM = service provider) | Optional (iba po zapnutí notifikácií) | App functionality | Yes (odhlásenie/zrušenie účtu revokuje zariadenie) | |
| App info and performance → Crash logs / Diagnostics | **No** | — | — | — | — | žiadny Crashlytics/Sentry. Pozn.: knižnica FCM obsahuje `datatransport` (Google interná telemetria doručovania FCM) — **NEEDS CONFIRMATION** podľa Firebase dokumentácie „Data disclosure" pre FCM |
| Location (approx/precise) | **No** | — | — | — | — | žiadne povolenie |
| Contacts, Calendar, SMS, Health, Web history, Installed apps | **No** | — | — | — | — | |
| Advertising ID | **No** | — | — | — | — | merged manifest bez `AD_ID` |

## Otvorené legal/CLIA body
1. Výklad „shared" pre OpenAI (spracovateľ vs. tretia strana) a lokalita spracovania.
2. Retencia: finalizované účtovné doklady (blokované zrušenie) — formulácia v privacy policy.
3. Údaje tretích osôb (kontakty partnerov, IBAN partnerov) — informačná povinnosť.
4. Privacy policy 1.3 a `/subprocessors` dnes **nespomínajú** Firebase FCM, hlas → OpenAI, text asistenta → OpenAI, registre RPO/RÚZ.
5. FCM telemetria (`datatransport`) — potvrdiť podľa Firebase „Data disclosure".
