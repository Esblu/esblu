# 04 — Data safety (konzervatívny draft)

Podklad: reálny kód (`mobile-platform`) + merged manifest AAB 1.0.0 (vc1). Internal testing Data safety **nevyžaduje**; povinné od Closed testing. Položky označené **NEEDS LEGAL/CLIA CONFIRMATION** musí potvrdiť CLIA/legal.

## Všeobecné odpovede
| Otázka | Odpoveď | Opora |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | tabuľka nižšie |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | HTTPS: `www.esblu.com` (Vercel), `*.supabase.co`, OpenAI API (server-side), FCM; `usesCleartextTraffic` nie je povolený (targetSdk 36 default = zakázaný cleartext) |
| Do you provide a way for users to request that their data is deleted? | **Yes** | in-app Nastavenia → Zrušiť účet; web `https://www.esblu.com/zrusenie-uctu` (**live 200, overené 2026-11-18**; spomína web aj Android appku a žiadosť bez appky na privacy@esblu.com) |
| Account creation method | **Username/e-mail + password** a **OAuth (Google)** — Google je od vc4 aj v Android appke | Supabase Auth |
| Data deletion URL | `https://www.esblu.com/zrusenie-uctu` | live |

**Kontrola voči vc4 (2026-11-18):** typy dát nižšie sedia so správaním 1.0.1 / vc4 (žiadny platobný SDK, `BILLING` povolenie
ani analytický SDK tretej strany; billing UI vypnuté `NEXT_PUBLIC_ESBLU_BILLING_UI`). Zmena od pôvodného draftu: potvrdzovacie e-maily
odosiela od 17. 11. 2026 **Resend** (vlastný SMTP Supabase Auth, doména `mail.esblu.com`) — service provider, teda „not shared“
pri Email address; verejné dokumenty ho zatiaľ neuvádzajú → CLIA (`docs/clia-delta-2026-11-24-draft.md` § 1.1).

## Prepracované body — Kontakty, Finančné údaje, Aktivita v aplikáciách (2026-11-18, PRIPRAVENÉ, v Play Console neuložené)

**Živý stav formulára** (Play Console → Obsah aplikácie → Zabezpečenie údajov, krok 4 a Ukážka, 2026-11-18, iba čítanie):
Kontakty — *Kontakty* (voliteľné; Funkcie aplikácie). Finančné údaje — *Platobné údaje používateľa*, *História nákupov*,
*Iné finančné údaje* (všetko voliteľné; Funkcie aplikácie). Aktivita v aplikáciách — *Interakcie s aplikáciou* (voliteľné;
Funkcie aplikácie, Analytika, Prevencia podvodov, zabezpečenie a dodržiavanie pravidiel), *História vyhľadávania v aplikácii*
(Funkcie aplikácie), *Ďalší obsah vytváraný používateľmi* (voliteľné; Funkcie aplikácie), *Iné akcie* (Funkcie aplikácie,
Prevencia podvodov, …). Zdieľanie: „S tretími stranami nie sú zdieľané žiadne údaje“.

**Oprava predchádzajúceho odporúčania:** v odovzdaní z 18. 11. som navrhol zrušiť Kontakty, ponechať jediný finančný typ
a odstrániť účel Analytika. Podrobná kontrola schémy produkčnej DB (iba názvy stĺpcov) a kódu ukázala, že **všetky tri
súčasné voľby zodpovedajú skutočnému správaniu verzie 4**. Odporúčanie: **nič nemeniť**, iba doplniť odpovede nižšie,
ak by ich Console pri úprave vyžadovala znova.

Spoločná cesta údajov (všetky tri body): aplikácia (WebView, HTTPS) → API `www.esblu.com` (Vercel, fra1) → databáza
Supabase `assetpilot` (eu-central-1, Frankfurt). Pri skenovaní dokladu ide obrázok aj na OpenAI (spracovateľ, `store:false`).
Nič sa nepredáva ani neposiela tretím stranám na ich vlastné účely → „nezdieľané“ (výnimka pre poskytovateľa služieb).

### 1. Kontakty

| | |
|---|---|
| **Konkrétne údaje** | adresár obchodných partnerov firmy: obchodné meno, IČO/DIČ/IČ DPH, adresa, **e-mail, telefón**, IBAN/BIC, Peppol/elektronická adresa (`business_partners`: `legal_name, ico, dic, ic_dph, address_line1…, email, phone, iban, bic, electronic_address`); e-maily pozvaných členov tímu (`company_invites.email`). Zadáva používateľ ručne alebo ich AI navrhne zo skenovaného dokladu a používateľ potvrdí. **Adresár zariadenia sa nečíta** (manifest nemá `READ_CONTACTS`, žiadny contact picker plugin). |
| **Kam sa odosielajú** | Esblu API (Vercel fra1) → Supabase Frankfurt; pri skenovaní dokladu s údajmi partnera obrázok na OpenAI (spracovateľ). Pozvánka: e-mail cez Supabase Auth → Resend. |
| **Účel** | Funkcie aplikácie — adresár zákazníkov/dodávateľov, predvyplnenie faktúr, pozvanie člena tímu. |
| **Dôkaz** | schéma `business_partners`, `company_invites` (produkcia, metadáta 2026-11-18); `mobile/android/app/src/main/AndroidManifest.xml` (povolenia iba INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS) |
| **Odpoveď do Play Console** | Kontakty → **Kontakty: vybrané**. Zhromažďované: **áno**. Zdieľané: **nie**. Dočasné spracovanie: **nie**. Povinné: **voliteľné** (používatelia môžu zvoliť, či údaje poskytnú). Účel zhromažďovania: **Funkcie aplikácie** (nič iné). = súčasný stav, ponechať. |

### 2. Finančné údaje (3 zo 4)

| Typ | Konkrétne údaje | Účel | Dôkaz | Odpoveď do Play Console |
|---|---|---|---|---|
| **Platobné údaje používateľa** | IBAN a BIC firmy používateľa (`company_billing_profile.iban, bic`), IBAN na faktúre (`invoices.iban`); IBAN/BIC partnerov. **Žiadne čísla kariet**, žiadne platby v appke. | Funkcie aplikácie — platobné údaje na vystavenej faktúre (QR / údaje na úhradu) | schéma `company_billing_profile`, `invoices`, `business_partners` | **vybrané**; zhromažďované áno; zdieľané nie; dočasné nie; voliteľné; **Funkcie aplikácie** |
| **História nákupov** | nákupy firmy z naskenovaných dokladov a prijatých faktúr: dodávateľ, číslo dokladu, dátum, množstvo, materiál, sumy (`ai_evidence: supplier, document_number, document_date, material, quantity, netto…`; `invoices` s `direction` prijaté, `supplier_business_partner_id`) | Funkcie aplikácie — evidencia nákladov, priradenie k vozidlu/stroju | schéma `ai_evidence`, `invoices` | **vybrané**; zhromažďované áno; zdieľané nie; dočasné nie; voliteľné; **Funkcie aplikácie** |
| **Iné finančné údaje** | vydané faktúry a opravné doklady (sumy, DPH, splatnosť, variabilný symbol), ručne zaznamenané úhrady (`invoice_payments: paid_amount, paid_at, payment_method`) | Funkcie aplikácie — fakturácia a evidencia úhrad | schéma `invoices`, `invoice_payments` | **vybrané**; zhromažďované áno; zdieľané nie; dočasné nie; voliteľné; **Funkcie aplikácie** |
| Úverové skóre / úverové údaje | nezbiera sa | — | — | **nevybrané** |

Kam: Esblu API → Supabase Frankfurt; obrázok skenovaného dokladu → OpenAI (spracovateľ). = súčasný stav, ponechať.
Pozn.: „Finančné funkcie“ (deklarácia) ostávajú „Aplikácia neposkytuje finančné funkcie“ — evidencia údajov nie je platobná služba.

### 3. Aktivita v aplikáciách (4 z 5)

| Typ | Konkrétne údaje | Účel | Dôkaz | Odpoveď do Play Console |
|---|---|---|---|---|
| **Interakcie s aplikáciou** | počty použitia funkcií na firmu: AI spracovania dokladov (`ai_processing_usage`, `ai_scan_usage` — firma, používateľ, endpoint, čas), mesačné počítadlá (`company_usage_counters`), **agregovaná telemetria nákladov** `ai_usage_monthly` (firma × mesiac × flow × model × výsledok × súčty tokenov/sekúnd; bez textu a bez `user_id`), triedy príkazov asistenta (`intent_command`) | Funkcie aplikácie (kvóty balíka), **Analytika** (meranie spotreby a nákladov funkcií — `docs/esblu-unit-economics-2026-10-22.md`), Prevencia podvodov a zabezpečenie (limit zneužitia 60/h, 240/deň, idempotencia) | migrácia `20261025100000_ai_usage_metering.sql`, `lib/intents/command-telemetry.ts`; schéma tabuliek | **vybrané**; zhromažďované áno; zdieľané nie; dočasné nie; voliteľné; účely **Funkcie aplikácie, Analytika, Prevencia podvodov, zabezpečenie a dodržiavanie pravidiel** — ponechať (Analytika je pravdivá, ide o vlastnú agregovanú telemetriu, nie SDK tretej strany) |
| **História vyhľadávania v aplikácii** | text z vyhľadávacieho poľa / príkazu asistenta: spracuje Intent Engine, pri nejasnom príkaze AI fallback (OpenAI, `store:false`); rozpracovaná úloha sa dočasne ukladá (`assistant_conversation_contexts: pending_intent, slots`, s `expires_at`) | Funkcie aplikácie | `lib/intents/*`, schéma `assistant_conversation_contexts` | **vybrané**; zhromažďované áno; zdieľané nie; dočasné **nie** (kontext sa ukladá do expirácie); voliteľné; **Funkcie aplikácie** |
| **Ďalší obsah vytváraný používateľmi** | poznámky, popisy vozidiel/strojov/skladu, umiestnenia, poznámky k úhradám | Funkcie aplikácie | schémy modulov | **vybrané**; áno; nie; nie; voliteľné; **Funkcie aplikácie** |
| **Iné akcie** | potvrdenia akcií asistenta (`assistant_action_confirmations`), prijatie VOP/DPA, registrácia zariadenia pre push (`push_devices.last_seen_at`) | Funkcie aplikácie, Prevencia podvodov a zabezpečenie, Správa účtu | schémy uvedených tabuliek | **vybrané**; áno; nie; nie; **povinné** (v Ukážke bez „Voliteľné“); **Funkcie aplikácie, Prevencia podvodov, zabezpečenie a dodržiavanie pravidiel** + **Správa účtu** (prijatie VOP/DPA) — tretí účel bol v Ukážke orezaný, pri úprave overiť |
| Nainštalované aplikácie | nezbiera sa | — | — | **nevybrané** |

Kam: Esblu API → Supabase Frankfurt; text príkazu pri AI fallbacku → OpenAI (spracovateľ). = súčasný stav, ponechať.

## Externé služby (kontext pre „shared")
| Služba | Rola | Dáta |
|---|---|---|
| Supabase (EU, Frankfurt) | hosting DB/Auth/Storage — spracovateľ | všetky dáta appky |
| Resend (od 2026-11-17) | SMTP pre e-maily Supabase Auth (potvrdenie registrácie, obnova hesla, pozvánky) | e-mailová adresa, obsah auth e-mailu |
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
4. ~~Privacy policy 1.3 a `/subprocessors` dnes **nespomínajú** Firebase FCM, hlas → OpenAI, text asistenta → OpenAI, registre RPO/RÚZ.~~
   Vyriešené v Zásadách 1.4 (9. 11. 2026) a `/subprocessors` (FCM, OpenAI hlas/príkazy). **Nové (2026-11-18):** Resend chýba
   a `/subprocessors` tvrdí, že sa nepoužíva; Zásady 1.4 a DPA 1.3 uvádzajú Google prihlásenie iba vo webovom rozhraní.
5. FCM telemetria (`datatransport`) — potvrdiť podľa Firebase „Data disclosure".
