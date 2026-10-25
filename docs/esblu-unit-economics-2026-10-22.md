# Esblu — Cost & Unit Economics Audit (reálne náklady na 1 firmu)

> **Aktualizácia 2026-10-26 — CANONICAL LAUNCH PRICING (OWNER DECISION):** Esblu Komplet **15,90 €** / firma / mesiac
> (25 používateľov, všetky moduly, chat, 40 AI spracovaní, 60 min hlasu, 5 GB, 20 eFaktúra tx po spustení eFaktúry),
> ďalšia firma **12,90 €**, samostatný modul **3,90 €** so stropom na cenu Kompletu, add-ony AI +40 / 3,90 €, hlas +60 min / 3,90 €,
> používatelia +25 / 4,90 €, eFaktúra +40 / 4,90 € a +100 / 9,90 €. Bez textu „+ DPH“ (Esblu s.r.o. nie je platiteľ DPH).
> Prepočet pri nových limitoch: **§22**. Billing ani eFaktúra nie sú live.

> **Aktualizácia 2026-10-25 — COST CONTROL HARDENING** (RC po `4d9af40`): terminológia opravená podľa reálnych flowov
> (Esblu **nemá** samostatný AI chatbot/asistent — iba Intent Engine pre písané a hlasové príkazy s OpenAI
> *intent classification fallbackom*), interný chat prepočítaný po Realtime scope fixe, retry cost guard a usage
> telemetria zavedené v repe + na stagingu (§5.3–5.4, §6, §21). Produkcia nezmenená. Pricing: **CANONICAL LAUNCH PRICING 15,90 € (OWNER DECISION 2026-10-25) — billing / eFaktúra NOT LIVE**.

Dátum auditu: **2026-10-25** (súbor pomenovaný podľa zadania 2026-10-22) · RC `preprod-release-candidate` @ `28af0e3` · ceny overené 2026-10-25.
Typ: **iba audit**. Žiadny kód produktu, pricing UI, billing, subscriptions, produkčná DB, secrets, limity ani `main` sa nemenili.
**Toto nie je cenové rozhodnutie — Pricing: OWNER DECISION PENDING.**

Výpočtový model: `docs/unit-economics/esblu-unit-economics-assumptions-2026-10-22.json` (predpoklady) +
`scripts/unit-economics-model.py` (read-only prepočet, bez siete, bez secrets) → `python3 scripts/unit-economics-model.py`.
Všetky tabuľky nižšie sú výstupom tohto skriptu. Sumy v **EUR bez DPH**; USD náklady prepočítané konzervatívne **1 € = 1,10 $**
(ECB 6. 10. 2026 = 1,1269 $).

Štítky pôvodu čísla: **MEASURED** (repo / účet / ledger) · **OFFICIAL** (oficiálny cenník overený 2026-10-25) ·
**ESTIMATE** (transparentný odhad) · **TBD** (vstup vlastníka) · **MANUAL CONFIRMATION REQUIRED**.

---

## 1. Executive summary

- **Infraštruktúrny fix je malý:** Supabase Pro + 2 projekty ≈ 35 $ a Vercel Pro 1 seat ≈ 20 $ → **≈ 50 € / mes.**, plus
  eFaktúra minimum 10 € (po aktivácii produkcie). Supabase/Vercel usage na jednu firmu je rádovo centy.
- **Náklad nerastie s počtom používateľov, ale s AI/hlasom/eFaktúrou.** Firemný chat stojí aj pri 20 ľuďoch a 44 000 správach
  mesačne **≈ 1,6 € / firma / mes.** (po Realtime/push/retencia fixoch 2026-10-25) Neobmedzení používatelia sú ekonomicky v poriadku (s technickým fair-use).
- **Bez limitov 14,90 € nie je bezpečné.** Baseline mix (60/30/9/1) dá iba **~10 % hrubej marže**, konzervatívny mix je
  **záporný (−66 %)**. Profil HEAVY stojí ~53 €, EXTREME ~188 € mesačne (typicky). Hlavné ťahúne: **hlas** (prepis + AI
  klasifikácia každého príkazu), **eFaktúra pri najhoršej tx cene** a **intent classification fallback (písané/hlasové príkazy) bez prompt cachingu**.
- **S fair-use limitmi je 14,90 € ekonomicky životaschopné:** 50 AI skenov, 60 min hlasu, 25 eFaktúra tx, 10 GB → marža
  **~56 % (baseline) / ~44 % (konzervatívny mix)**, break-even infra pri **6–7 firmách**. Zraniteľná ostáva: ťažká 20-členná
  firma s neobmedzenými písanými príkazmi (typicky −6 €/mes.), kým sa nezapne prompt caching intent fallbacku (potom ~+4 €).
- **16,90 € s limitmi** dáva rezervu (~60 % / ~49 %) aj na Play/Apple poplatky a neistotu cien eFaktúry → odporúčaná pracovná
  launch cena (rozhodnutie vlastníka).
- **9,90 € za ďalšiu firmu nie je bezpečné ako plošné pravidlo** — druhá firma má vlastné AI/hlas/eFaktúru; pri NORMAL profile
  s HIGH cenami je strata. Bezpečné iba s nižšími zahrnutými limitmi (pozri §14).

**Verdikt: ESBLU UNIT ECONOMICS: NEEDS USAGE LIMITS.**

---

## 2. Provider inventory

| služba | čo platíme / používame | typ nákladu | cena (zdroj, dátum) | stav |
|---|---|---|---|---|
| **Supabase** (org „Esblu s.r.o.“) | Postgres, Auth, Storage, Realtime; prod `assetpilot` + staging `esblu-test` (`skitze-protokoly` INACTIVE) | FIXED MONTHLY + PER GB + PER MESSAGE + PER CONNECTION | Pro 25 $/mes. vrátane 10 $ compute kreditu; Micro 10 $/projekt; overage pozri §3 (OFFICIAL supabase.com/pricing + docs/compute-and-disk, 2026-10-25) | plán **pro** MEASURED (Supabase API); veľkosť compute **MANUAL CONFIRMATION** (predpoklad Micro) |
| **Vercel** (team `esblu`) | hosting Next.js, Functions (Fluid), 8 cronov, CDN | FIXED MONTHLY + PER REQUEST/CPU/GB-h | Pro 20 $/mes./seat vrátane 20 $ usage kreditu (OFFICIAL vercel.com/pricing 2026-10-25); ledger 22. 10.: licencia ≈ 0,645 $/deň, usage ≈ 0,001 $/deň (MEASURED) | plán Pro, 1 seat MEASURED |
| **OpenAI API** | AI skeny dokumentov, TP, intent classification fallback, prepis hlasu | PER TOKEN / PER MINUTE | §5 (OFFICIAL developers.openai.com/api/docs/pricing 2026-10-25) | usage telemetria `ai_usage_monthly` od 2026-10-25 (repo + staging; produkcia po rollout-e) |
| **eFaktura.sk** (Agent API partner, nie white-label) | odoslanie/príjem Peppol eFaktúr | FIXED MINIMUM + PER TRANSACTION | do 30. 11. 2026 promo 0 € do 1000 tx; od 1. 12. 2026 0,055–0,0194 €/tx, min. 10 €/mes., mesačný program ×1,20, prijatý doklad = 0,5 tx (provider dokumentácia 2. 10. 2026 v `docs/einvoice-production-provider-checklist.md`) | **MANUAL CONFIRMATION** — cenník po 30. 11. a rozsah minima (partner vs. organizácia) nie sú písomne potvrdené |
| **Stripe** | web predplatné (dnes iba test) | PERCENTAGE OF PAYMENT + PER TRANSACTION | EEA štandard 1,5 % + 0,25 €; EEA premium (firemné karty) 2,8 % + 0,25 €; Billing 0,7 %; spor 20 € (OFFICIAL stripe.com/en-sk/pricing 2026-10-25) | live neaktívne |
| **Google Play Billing** | mobilné predplatné Android | PERCENTAGE OF PAYMENT | EEA auto-renew predplatné: 10 % service fee + 5 % billing fee = **15 %** (OFFICIAL support.google.com answer/112622, 2026-10-25) | produkty nevytvorené |
| **Apple App Store / IAP** | mobilné predplatné iOS | PERCENTAGE OF PAYMENT | EU IAP: **15 %** (Small Business Program alebo predplatné po 1. roku), **26 %** štandard 1. rok; alternatívne platby v appke 10–20 % (OFFICIAL developer.apple.com/support/apps-in-the-eu 2026-10-25) | App Store Connect nenastavený |
| **Firebase / FCM** | natívne push (Android) | FREE / INCLUDED | Cloud Messaging „No-cost“ (OFFICIAL firebase.google.com/pricing 2026-10-25) | — |
| Web Push (VAPID) / APNs | web push / iOS push | FREE / INCLUDED | bez poplatku (APNs v rámci Apple Developer Program) | — |
| **GitHub** (`Esblu/esblu`) | repo | DEVELOPMENT OVERHEAD | **TBD** — plán nebolo možné overiť (GitHub konektor nepripojený) | Actions: v repe nie je `.github/workflows` → 0; LFS/Packages: nepoužité |
| GitHub Copilot | — | DEVELOPMENT OVERHEAD | **TBD** | použitie nepotvrdené |
| Claude / Cowork | vývoj | DEVELOPMENT OVERHEAD | **TBD** | — |
| Doména `esblu.com` | externý registrátor (DNS `registrar-servers.com`, Namecheap) | FIXED (ročne) | **TBD / MANUAL CONFIRMATION** | MEASURED cez Vercel API |
| E-mail | Supabase Auth vstavaný e-mail (registrácia, reset hesla); firemná schránka Namecheap Private Email | FREE / FIXED | Auth e-mail v Supabase pláne; schránka **TBD**. Resend nepoužívaný (`docs/gdpr-subprocessors.md`) | **MANUAL CONFIRMATION**, či má produkcia vlastný SMTP (vstavaný má prísne rate limity) |
| Monitoring / logging | žiadny platený (vedomé rozhodnutie, `docs/data-breach-procedure.md`) | — | 0 | — |
| Apple Developer Program | potrebné pre iOS | FIXED (ročne) | **TBD** (verejný cenník 99 $/rok — nebol v tejto session overený) | iba ak iOS pri launchi |
| Google Play registrácia | jednorazovo | — | už zaplatené (účet existuje) | 0 / mes. |
| ECB kurzy, RegisterUZ / RPO, Google OAuth | verejné API / OAuth | FREE | 0 | — |

---

## 3. Fixed monthly costs

| položka | USD | EUR | poznámka |
|---|---|---|---|
| Supabase Pro | 25,00 | 22,73 | obsahuje 10 $ compute kreditu |
| Supabase compute prod (Micro) | 10,00 | 9,09 | pokrytý kreditom |
| Supabase compute staging (Micro) | 10,00 | 9,09 | nad kredit (staging je aktívny) |
| − compute kredit | −10,00 | −9,09 | |
| Vercel Pro (1 seat) | 20,00 | 18,18 | obsahuje 20 $ usage kreditu |
| **Infra fix spolu** | **55,00** | **≈ 50,00** | |
| eFaktúra minimum | — | 10,00 | po aktivácii produkčného účtu (od 1. 12. 2026), ak sa nedosiahne tx objem |
| Development overhead (GitHub, Copilot, Claude, doména, schránka, Apple) | — | **TBD** | modelované scenáre 0 / 50 / 150 € |

Škálovanie fixu (ESTIMATE, Supabase compute podľa počtu firiem): ≤ 100 Micro (10 $), ≤ 300 Small (15 $), ≤ 700 Medium (60 $),
nad Large (110 $) — oficiálne ceny compute 2026-10-25. Realtime fan-out (§6) môže vyžadovať vyšší tier skôr.

Supabase Pro zahrnuté (OFFICIAL): disk 8 GB/projekt (potom 0,125 $/GB), Storage 100 GB (0,0213 $/GB), egress 250 GB
(0,09 $/GB), cached egress 250 GB (0,03 $/GB), MAU 100 000 (0,00325 $/MAU), Realtime 500 peak connections (10 $/1000),
Realtime 5 M správ (2,50 $/M), Edge Functions 2 M (2 $/M; Esblu Edge Functions nepoužíva), denné zálohy 7 dní v cene.
**PITR sa nezapočítava** (vypnuté).

---

## 4. Variable cost table

| náklad | jednotka | sadzba | typ | kto ho generuje |
|---|---|---|---|---|
| AI sken dokumentu | 1 sken | 0,030 € typ. / 0,058 € high | PER TOKEN | firma (nie počet ľudí) |
| Písaný príkaz → Intent Engine (OpenAI iba intent classification fallback, keď deterministický parser nestačí) | 1 príkaz | 0,0026 € typ. / 0,010 € high | PER TOKEN | rastie s počtom ľudí |
| Hlas (prepis + klasifikácia príkazov) | 1 min audia | 0,037 € typ. / 0,077 € high | PER MINUTE + PER TOKEN | rastie s počtom ľudí |
| eFaktúra | 1 tx | 0,0233–0,066 € (mesačný program) | PER TRANSACTION | firma |
| Storage | GB/mes. | 0,019 € nad 100 GB pool | PER GB | firma |
| Egress | GB | 0,082 € nad 250 GB pool | PER GB | firma × ľudia |
| Realtime správy | 1 M | 2,27 € nad 5 M pool | PER MESSAGE | ľudia² (fan-out) |
| Realtime connections | 1000 peak | 9,09 € nad 500 | PER CONNECTION | ľudia |
| DB disk | GB | 0,114 € nad 8 GB | PER GB | firma (chat + push riadky bez retencie) |
| Vercel Functions | GB-h / CPU-h / invocations | 0,0152 $/GB-h (MEASURED), ~0,18 $/CPU-h, ~0,60 $/M (ESTIMATE) | PER REQUEST | ľudia |
| Platby | % z ceny | Stripe ~3,5 % z hrubej sumy + 0,25 €; Play 15 %; Apple 15/26 % | PERCENTAGE | firma |

---

## 5. OpenAI cost per action

### 5.1 Inventúra všetkých OpenAI volaní (MEASURED z kódu; retry/timeout stav po 2026-10-25 v §5.3)

**Neexistuje samostatný používateľský AI chatbot ani AI asistent.** Endpoint `app/api/assistant/*` je historický názov pre
Intent Engine (písané a hlasové príkazy → povolený intent → deterministický handler nad DB). OpenAI sa volá iba v 5 flowoch nižšie.

| flow | route | model | vstup | max tokens | retries | viac modelov? | caching | firemný kontext |
|---|---|---|---|---|---|---|---|---|
| AI evidencia / Inbox: bločky, faktúry, dodacie listy, vážne lístky, poistky, servis | `app/api/scan-document` | **gpt-5.6-terra** (`reasoning: none`, `store:false`, strict JSON schema) | text prompt (~14,2 k znakov) + schéma (~10 k znakov zdroja) + **1 obrázok `detail: high`** (JPEG/PNG/WebP ≤ 10 MB; **PDF sa neprijíma**) | nenastavené (štruktúrovaný výstup) | pred: SDK default 2 → teraz §5.3 | áno: **gpt-4.1** SPZ fallback iba pri vážnom lístku / dodacom liste bez SPZ (ten istý obrázok) | žiadny explicitný | **nie** — iba obrázok + statický prompt |
| Vehicle document (legacy) | `app/api/scan-vehicle-doc` | gpt-5.6-terra + gpt-4.1 SPZ fallback | prompt ~5,3 k znakov + schéma ~2,2 k + 1 obrázok high | nenastavené | pred: SDK default 2 → teraz §5.3 | áno (fallback) | nie | nie |
| Technický preukaz | `app/api/scan-vehicle-registration` | **gpt-4.1-mini** | krátky prompt + **2 obrázky** (predná/zadná strana) high | nenastavené | pred: SDK default 2 → teraz §5.3 | nie | nie | nie |
| Písané (a prepísané hlasové) príkazy — **intent classification fallback** | `app/api/assistant/intent` → `lib/intents/ai-fallback.ts` | gpt-5.6-terra | prompt ~10,2 k znakov + schéma ~4,3 k + text príkazu | nenastavené | pred 2026-10-25: SDK default 2 (aj po timeoute); teraz 0 | nie | nie | **nie** — iba klasifikácia textu na povolený intent; odpoveď skladá deterministický handler z DB (RLS). Volá sa **iba ak deterministický parser zlyhá** |
| Hlas | `app/api/assistant/transcribe` → potom ten istý Intent Engine | **gpt-4o-transcribe** (+ gpt-5.6-terra fallback podľa textu) | audio (VAD posiela iba reč) | — | pred: 1 retry vrátane timeoutu; teraz SDK 0 + guard max. 1 (429/5xx), timeout 18 s | áno: prepis + prípadne intent fallback | nie | nie; TTS = prehliadač (0 $) |

Iné volania OpenAI v repe nie sú (žiadne embeddings, summarization, chat completions, image generation). **Firemný chat AI
nevolá.** AI kvóta firmy (`reserveAiProcessing`, abuse limit 60/h, 240/deň) chráni skeny; písané príkazy a hlas majú iba nárok
`voice` / role, **nie kvantitatívny limit**.

Ceny (OFFICIAL, 2026-10-25, Standard, $/1 M tokenov): gpt-5.6-terra 2,00 in / 0,20 cached / 12,00 out (cache write 30 min
2,50); gpt-4.1 2,00 / 0,50 / 8,00; gpt-4.1-mini 0,40 / 0,10 / 1,60; gpt-4o-transcribe ≈ 0,006 $/min.

### 5.2 Token odhady (ESTIMATE — nemerané živým volaním; `response.usage` sa v appke neloguje)

- scan-document vstup ≈ prompt 4 400 + schéma 2 000 + obrázok 1 500–3 000 → **7 500–10 000** tok.; výstup 600–3 500
  (štruktúrované polia + `rawText`; pri dlhom bločku najviac). SPZ fallback gpt-4.1 ≈ 3 800 in / 60 out.
- intent fallback ≈ 4 500 in / 60 out → **0,0097 $** (bez cache), **0,0025 $** pri cache hite.
- hlas: ~12 príkazov / min reči (≈ 5 s/príkaz), fallback 20–60 % príkazov.
- LOW = cache hit / krátky doklad; TYPICAL = bez cache; HIGH = dlhý výstup + fallback + podiel retry.

#### OpenAI cost per action (USD / EUR)

| action | low USD | typical USD | high USD | typical EUR |
|---|---|---|---|---|
| AI scan blended (85 % doc / 10 % vehicle doc / 5 % TP) | 0.0200 | 0.0327 | 0.0641 | 0.0298 |
| text command (intent fallback share × call) | 0.0003 | 0.0029 | 0.0110 | 0.0026 |
| voice: 1 audio min full chain (transcribe + intents) | 0.0176 | 0.0409 | 0.0852 | 0.0372 |
| scan_document (single call chain) | 0.0220 | 0.0360 | 0.0710 | 0.0327 |
| scan_vehicle_doc (single call chain) | 0.0120 | 0.0200 | 0.0350 | 0.0182 |
| scan_vehicle_registration (single call chain) | 0.0020 | 0.0030 | 0.0050 | 0.0027 |
| intent_fallback_call (single call chain) | 0.0025 | 0.0097 | 0.0110 | 0.0088 |
| voice 5 min full chain | 0.088 | 0.205 | 0.426 | 0.186 |

Odpovede na zadané akcie (typicky / high, EUR): bloček ≈ **0,033 / 0,065**; PDF faktúra — **PDF Esblu neprijíma**, foto faktúry
≈ 0,033 / 0,065; foto dokumentu ≈ 0,033; vehicle-document ≈ 0,018 / 0,032; TP ≈ 0,003; písaný príkaz ≈ **0,003** (keď padne do OpenAI fallbacku 0,009);
„dlhší príkaz s firemným kontextom“ = **rovnaká cena** (firemný kontext sa modelu neposiela); 1 min hlasu ≈ **0,037 / 0,077**; 5 min ≈
**0,19 / 0,39**; hlas → AI → odpoveď = prepis + fallback (zahrnuté v cene minúty).

### 5.3 Retry cost guard (implementované 2026-10-25, repo + staging)

| flow | pred | teraz (`lib/ai/openai-guard.ts`, `AI_CALL_POLICY`) |
|---|---|---|
| document scan / vehicle document scan (gpt-5.6-terra, obrázok) | SDK default: timeout 10 min, 2 retry vrátane timeoutu / prerušeného spojenia | SDK `maxRetries: 0`, timeout 90 s, max. **1** retry iba pri 429 (nie `insufficient_quota`) / 500 / 502 / 503 |
| plate (ŠPZ) fallback (gpt-4.1, obrázok) | SDK default | timeout 45 s, **0** retry |
| vehicle registration scan (gpt-4.1-mini, 2 obrázky) | SDK default | timeout 60 s, max. 1 retry (429/5xx) |
| voice transcription (gpt-4o-transcribe) | timeout 18 s, 1 retry vrátane timeoutu | timeout 18 s, max. 1 retry (429/5xx), timeout sa neopakuje |
| intent classification fallback (gpt-5.6-terra, text) | SDK default (10 min, 2 retry) | timeout 12 s, **0** retry (fail closed = „nerozumel som“) |

Timeout, abort, prerušené spojenie, 504/408/409 a ostatné 4xx sa **nikdy neopakujú** — request mohol byť spracovaný a
zaúčtovaný. Idempotencia: AI kvóta (`ai_processing_usage`, `Idempotency-Key` + SHA-256 obsahu) už zabraňuje dvojitému
**započítaniu** pri opakovaní od klienta; OpenAI API samo idempotency kľúč pre `responses.create` nemá, preto guard.
Počet pokusov sa zapisuje do telemetrie (`retry_count`).

### 5.4 Usage telemetria (implementované 2026-10-25, repo + staging; produkcia PENDING APPROVAL)

Tabuľka `ai_usage_monthly` (migrácia `20261025100000`): mesačné počítadlá na **firmu × mesiac × flow × model × výsledok** —
`requests`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `audio_input_tokens`, `audio_seconds`, `image_count`,
`retry_count`. **NIKDY:** prompt, odpoveď modelu, transcript, obsah/obrázok dokumentu, fakturačné údaje, text chatu, user_id
(GDPR: ACCESS / COST TELEMETRY ONLY — NO CONTENT LOGGING). Zápis iba server (service_role RPC `esblu_record_ai_usage` /
`esblu_record_ai_usage_for_reservation`); skeny sa pripíšu firme z AI rezervácie, hlas aktívnej firme session, intent fallback
firme z overeného členstva; DB vždy overí aktívne členstvo (fail closed). Klient nemá žiadny grant. Retencia: 25 mesiacov
(minimum 13) — OWNER/CLIA INFORMATIVE NOTE. Flowy: `document_scan`, `document_scan_plate_fallback`, `vehicle_document_scan`,
`vehicle_document_plate_fallback`, `vehicle_registration_scan`, `voice_transcription`, `intent_classification_fallback`.
Po produkčnom rollout-e sa odhady v §5.2 nahradia meraním (SQL: súčty tokenov × cenník z §5.1).

---

## 6. Internal Chat economics (INTERNÝ FIREMNÝ CHAT ≠ AI chat)

Implementácia (MEASURED, stav po cost control hardening 2026-10-25): `chat_messages` / `chat_attachments` /
`chat_message_references` / `chat_conversation_members` v Supabase Postgres; Realtime **postgres_changes** — všetkých 7
odberov má filter: unread zoznam, plávajúci widget a mobilný FAB `company_id=eq.<aktívna firma>`, otvorená konverzácia
`conversation_id=eq.<id>` (INSERT/UPDATE), prílohy a referencie `company_id=eq.<firma konverzácie>` (`lib/chat-realtime.ts`;
predtým 5 z 7 bez filtra → Realtime vyhodnocoval každý INSERT celej platformy pre každého pripojeného). RLS ostáva poslednou
vrstvou. Prílohy v buckete `chat-attachments` (≤ 15 MB, bez kompresie); unread = lokálny counter + RPC; push po každej správe
(`/api/push/chat-message`) **všetkým členom firemného kanála** (direct = 1 príjemca) — teraz v **paralelných dávkach po 5**
(`PUSH_USER_CONCURRENCY`), jeden zdieľaný FCM OAuth token; deduplikačný riadok `notification_deliveries` na príjemcu sa pre
`kind='chat'` **maže po 7 dňoch** (cron `telemetry-maintenance`). Retencia samotných správ: žiadna (produktové/CLIA rozhodnutie).
**Žiadne volanie OpenAI** (overené testom `test:cost-control`).

Model: 22 pracovných dní, 50 % správ vo firemnom kanáli, 50 % pripojených počas dňa, riadok správy 0,5 KB, riadok
doručenia 0,25 KB, push funkcia 0,15 s + ⌈príjemcovia / 5⌉ × 0,15 s (ESTIMATE). Ceny Realtime/DB/egress = overage sadzby
(konzervatívne — v praxi pokryté poolom pri malom počte firiem). Účtované Realtime správy sa scope fixom **nemenia** (doručenie
už predtým filtrovala RLS) — fix odstraňuje celoplatformovú autorizačnú prácu (tabuľka nižšie), ktorá by pri stovkách firiem
tlačila na vyšší compute tier.

#### Internal company chat — monthly cost per company (EUR)

| users | usage | msgs/mo | Realtime msgs | push deliveries | message rows MB/mo | dedupe rows steady MB (7 d) | Realtime € | DB € | egress € | push fn € | **total €** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 5 | LIGHT 10 | 1 100 | 4 950 | 2 750 | 0.5 | 0.2 | 0.011 | 0.000 | 0.000 | 0.005 | **0.02** |
| 5 | NORMAL 30 | 3 300 | 14 850 | 8 250 | 1.6 | 0.5 | 0.034 | 0.000 | 0.001 | 0.016 | **0.05** |
| 5 | HEAVY 100 | 11 000 | 49 500 | 27 500 | 5.4 | 1.6 | 0.112 | 0.001 | 0.004 | 0.053 | **0.17** |
| 10 | LIGHT 10 | 2 200 | 15 400 | 11 000 | 1.1 | 0.6 | 0.035 | 0.000 | 0.001 | 0.012 | **0.05** |
| 10 | NORMAL 30 | 6 600 | 46 200 | 33 000 | 3.2 | 1.9 | 0.105 | 0.001 | 0.004 | 0.035 | **0.14** |
| 10 | HEAVY 100 | 22 000 | 154 000 | 110 000 | 10.7 | 6.3 | 0.350 | 0.002 | 0.012 | 0.118 | **0.48** |
| 20 | LIGHT 10 | 4 400 | 52 800 | 44 000 | 2.1 | 2.5 | 0.120 | 0.001 | 0.004 | 0.034 | **0.16** |
| 20 | NORMAL 30 | 13 200 | 158 400 | 132 000 | 6.4 | 7.5 | 0.360 | 0.002 | 0.012 | 0.101 | **0.47** |
| 20 | HEAVY 100 | 44 000 | 528 000 | 440 000 | 21.5 | 25.1 | 1.200 | 0.005 | 0.041 | 0.336 | **1.58** |

#### Realtime authorization fan-out — before vs after company filter (platform-wide, per month)

Before: every INSERT into chat_messages was evaluated for EVERY connected subscriber of the platform (RLS decided at the end). After: only subscribers of the same company (filter company_id=eq.<active company>).

| companies | platform msgs/mo | peak connected | checks before (msgs × all connected) | checks after (Σ company msgs × company connected) | reduction |
|---|---|---|---|---|---|
| 10 | 70 400 | 40 | 2 816 000 | 555 500 | 5× |
| 50 | 352 000 | 200 | 70 400 000 | 2 777 500 | 25× |
| 100 | 704 000 | 400 | 281 600 000 | 5 555 000 | 51× |
| 500 | 3 520 000 | 2 000 | 7 040 000 000 | 27 775 000 | 253× |
| 1000 | 7 040 000 | 4 000 | 28 160 000 000 | 55 550 000 | 507× |

Prílohy: pri 2 % správ s prílohou 1 MB je HEAVY 20 ľudí ≈ 0,86 GB/mes. nového Storage — patrí do storage fair-use (§9).
`notification_deliveries` (HEAVY 20 ľudí): predtým +440 000 riadkov/mes. bez konca (~107 MB/mes.), teraz ustálene ~103 000
chat riadkov (7 dní, ~25 MB). **Záver: chat netreba limitovať počtom správ.**

INTERNAL COMPANY CHAT INCLUDED IN MODEL: **YES** — po fixoch ≈ **0,05 / 0,14 / 0,47 €** (5 / 10 / 20 ľudí, NORMAL) a
**0,17 / 0,48 / 1,58 €** (HEAVY; 20 × 100 × 22 = 44 000 správ).

---

## 7. 20-user company economics

Varianty: LIGHT = 25 skenov, 1 písaný príkaz/os./deň (440), 30 min hlasu, chat 10, 10 tx; NORMAL = 100 skenov, 3/deň (1 320),
120 min, chat 30, 50 tx; HEAVY = 300 skenov, 10/deň (4 400), 500 min, chat 100, 250 tx.

#### 20-person company (EUR / month)

| variant | cost typical € | cost high € | margin @14.90 web (typ) | @16.90 | @19.90 |
|---|---|---|---|---|---|
| 20 users LIGHT | 4.29 | 9.45 | 9.83 | 11.76 | 14.66 |
| 20 users NORMAL | 15.65 | 33.04 | -1.53 | 0.40 | 3.30 |
| 20 users HEAVY | 58.78 | 119.82 | -44.66 | -42.73 | -39.83 |

Same 20-user variants without voice and without eInvoice (core + AI scans + text commands + chat):

| variant | cost typical € | margin @14.90 web |
|---|---|---|
| 20 users LIGHT | 2.52 | 11.61 |
| 20 users NORMAL | 7.89 | 6.24 |
| 20 users HEAVY | 23.68 | -9.56 |

Rovnaké varianty s odporúčanými limitmi (§15) sú v tabuľke §15.

---

## 8. eInvoice economics

#### eInvoice cost per company (EUR / month, variable part; partner minimum EUR 10 is fixed and shared)

| tx / month | best (0.0194 × 1.2) | worst (0.055 × 1.2) | annual prepay worst (0.055) |
|---|---|---|---|
| 10 | 0.23 | 0.66 | 0.55 |
| 25 | 0.58 | 1.65 | 1.38 |
| 50 | 1.16 | 3.30 | 2.75 |
| 100 | 2.33 | 6.60 | 5.50 |
| 250 | 5.82 | 16.50 | 13.75 |
| 500 | 11.64 | 33.00 | 27.50 |
| 1000 | 23.28 | 66.00 | 55.00 |

- Minimum 10 €/mes. je modelované ako **fixný náklad na úrovni partnera**. Ak by sa ukázalo, že minimum platí **na
  organizáciu klienta**, eFaktúra musí byť **platený add-on ≥ 12,90 €** — nedá sa zahrnúť do 14,90 €.
- Do 30. 11. 2026 promo (0 € do 1000 tx) — pre launch irelevantné, ak launch padne po 1. 12. 2026.
- Ročný program (×1,00, platba vopred) zníži tx cenu o 1/6 — rozhodnutie vlastníka (viaže hotovosť).
- **Odporúčanie: C — zahrnutý limit + overage/add-on** (pozri §15–16).

---

## 9. Storage economics

| profil | GB | marginálny Storage € / mes. | egress (30 % / 50 % stiahnutí) € / mes. | spolu € |
|---|---|---|---|---|
| LIGHT | 1 | 0,02 | 0,02 | 0,04 |
| NORMAL | 5 | 0,10 | 0,12 | 0,22 |
| HEAVY | 10 | 0,19 | 0,25 | 0,44 |
| VERY HEAVY | 25 | 0,48 | 1,02 | 1,50 |

Zahrnuté v Pro: 100 GB Storage + 250 GB egress na organizáciu (ďalej 0,0213 $/GB a 0,09 $/GB). Storage je prakticky
zanedbateľný náklad; **10 GB / firma je bezpečný fair-use** (≈ 0,44 €/mes. aj s egressom). Odporúčanie: komunikovať 10 GB,
technický strop napr. 25 GB, nad to add-on. Pozor: Storage objekty **nie sú v DB zálohe** (J5) — náklad zálohy súborov nie je
zahrnutý.

---

## 10. Payment / store fees

#### Payment / store fee per company per month (EUR)

| price | web Stripe | Google Play 15 % | Apple 15 % (SBP / yr 2+) | Apple 26 % (std yr 1) | blended 80/15/5 |
|---|---|---|---|---|---|
| 14.90 | 0.77 | 2.23 | 2.23 | 3.87 | 1.06 |
| 16.90 | 0.84 | 2.53 | 2.53 | 4.39 | 1.18 |
| 19.90 | 0.95 | 2.98 | 2.98 | 5.17 | 1.36 |
| 9.90 | 0.60 | 1.49 | 1.49 | 2.57 | 0.77 |

Web: Stripe poplatok počítaný z hrubej sumy s 23 % DPH (SK B2B zákazník), 50 % firemných (premium) kariet + Billing 0,7 % +
0,25 € fix → ~5 % ceny. Google Play 15 % a Apple 15 % sú ~3× drahšie; Apple 1. rok bez Small Business Program 26 %.
Store pravidlá umožňujú v EEA aj iné architektúry (externé odkazy / alternatívne platby so zníženou províziou) —
**iba dokumentované, bez právneho/store záveru** (CLIA + store review).

---

## 11. Scenario profiles

| profil | ľudia | AI skeny | písané príkazy | hlas min | storage | chat / os. / deň | eFaktúra tx |
|---|---|---|---|---|---|---|---|
| A LIGHT | 5 | 25 | 100 | 30 | 1 GB | 10 | 10 |
| B NORMAL | 10 | 100 | 500 | 120 | 5 GB | 30 | 50 |
| C HEAVY | 20 | 300 | 2 000 | 500 | 10 GB | 100 | 250 |
| D EXTREME | 20 | 1 000 | 4 400 | 2 000 | 25 GB | 100 (44 000 správ) | 1 000 |

#### Profile cost per company / month (EUR, marginal above included pools, typical level, eInvoice worst price)

| profile | ai_scans | text_commands | voice | chat | storage | egress | einvoice | vercel | total | total HIGH level |
|---|---|---|---|---|---|---|---|---|---|---|
| A_LIGHT | 0.74 | 0.26 | 1.12 | 0.02 | 0.02 | 0.02 | 0.66 | 0.09 | 2.94 | 5.59 |
| B_NORMAL | 2.98 | 1.32 | 4.46 | 0.14 | 0.10 | 0.12 | 3.30 | 0.27 | 12.70 | 24.06 |
| C_HEAVY | 8.93 | 5.29 | 18.60 | 1.58 | 0.19 | 0.25 | 16.50 | 1.09 | 52.44 | 95.82 |
| D_EXTREME | 29.77 | 11.64 | 74.40 | 1.58 | 0.48 | 1.02 | 66.00 | 2.27 | 187.17 | 328.54 |

#### Margin per single company by profile and price (web channel, typical) — EUR

| profile | cost € | 14.9 € margin | 16.9 € margin | 19.9 € margin | 9.90 € margin |
|---|---|---|---|---|---|
| A_LIGHT | 2.94 | 11.19 (75 %) | 13.12 (78 %) | 16.02 (80 %) | 6.37 (64 %) |
| B_NORMAL | 12.70 | 1.43 (10 %) | 3.36 (20 %) | 6.25 (31 %) | -3.40 (-34 %) |
| C_HEAVY | 52.44 | -38.31 (-257 %) | -36.38 (-215 %) | -33.48 (-168 %) | -43.13 (-436 %) |
| D_EXTREME | 187.17 | -173.05 (-1161 %) | -171.12 (-1013 %) | -168.22 (-845 %) | -177.87 (-1797 %) |

**Kde 14,90 € prestáva byť bezpečné (bez limitov):** už pri profile NORMAL je typická marža iba ~9 %; HEAVY a EXTREME sú
stratové. Pri HIGH cenách akcií je stratový aj NORMAL.

---

## 12. 10 / 50 / 100 / 500 / 1000-company model (bez limitov — „unlimited all-inclusive“)

Fix = Supabase + Vercel (tier podľa počtu firiem); eFaktúra = max(10 €, tx); kanál 80 % web / 15 % Play / 5 % Apple;
development overhead nezahrnutý (pozri §17).

#### Fleet model — price 14.90 €, mix baseline ({'A_LIGHT': 0.6, 'B_NORMAL': 0.3, 'C_HEAVY': 0.09, 'D_EXTREME': 0.01}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | text cmds + voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 149.00 | 50.00 (micro) | 24.41 | 55.75 | 35.31 | 0.00 | 0.00 | 0.00 | 10.65 | -27.12 | -18.2 % |
| 50 | 745.00 | 50.00 (micro) | 122.07 | 278.75 | 176.55 | 1.21 | 0.00 | 0.00 | 53.24 | 63.18 | 8.5 % |
| 100 | 1 490.00 | 50.00 (micro) | 244.14 | 557.49 | 353.10 | 4.36 | 4.46 | 12.28 | 106.49 | 157.69 | 10.6 % |
| 500 | 7 450.00 | 95.45 (medium) | 1 220.68 | 2 787.46 | 1 765.50 | 56.47 | 81.40 | 134.13 | 532.43 | 776.48 | 10.4 % |
| 1000 | 14 900.00 | 140.91 (large) | 2 441.36 | 5 574.93 | 3 531.00 | 136.19 | 178.70 | 286.44 | 1 064.86 | 1 545.62 | 10.4 % |

#### Fleet model — price 16.90 €, mix baseline ({'A_LIGHT': 0.6, 'B_NORMAL': 0.3, 'C_HEAVY': 0.09, 'D_EXTREME': 0.01}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | text cmds + voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 169.00 | 50.00 (micro) | 24.41 | 55.75 | 35.31 | 0.00 | 0.00 | 0.00 | 11.81 | -8.28 | -4.9 % |
| 50 | 845.00 | 50.00 (micro) | 122.07 | 278.75 | 176.55 | 1.21 | 0.00 | 0.00 | 59.05 | 157.38 | 18.6 % |
| 100 | 1 690.00 | 50.00 (micro) | 244.14 | 557.49 | 353.10 | 4.36 | 4.46 | 12.28 | 118.09 | 346.08 | 20.5 % |
| 500 | 8 450.00 | 95.45 (medium) | 1 220.68 | 2 787.46 | 1 765.50 | 56.47 | 81.40 | 134.13 | 590.47 | 1 718.43 | 20.3 % |
| 1000 | 16 900.00 | 140.91 (large) | 2 441.36 | 5 574.93 | 3 531.00 | 136.19 | 178.70 | 286.44 | 1 180.94 | 3 429.53 | 20.3 % |

#### Fleet model — price 19.90 €, mix baseline ({'A_LIGHT': 0.6, 'B_NORMAL': 0.3, 'C_HEAVY': 0.09, 'D_EXTREME': 0.01}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | text cmds + voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 199.00 | 50.00 (micro) | 24.41 | 55.75 | 35.31 | 0.00 | 0.00 | 0.00 | 13.55 | 19.98 | 10.0 % |
| 50 | 995.00 | 50.00 (micro) | 122.07 | 278.75 | 176.55 | 1.21 | 0.00 | 0.00 | 67.75 | 298.67 | 30.0 % |
| 100 | 1 990.00 | 50.00 (micro) | 244.14 | 557.49 | 353.10 | 4.36 | 4.46 | 12.28 | 135.51 | 628.67 | 31.6 % |
| 500 | 9 950.00 | 95.45 (medium) | 1 220.68 | 2 787.46 | 1 765.50 | 56.47 | 81.40 | 134.13 | 677.54 | 3 131.37 | 31.5 % |
| 1000 | 19 900.00 | 140.91 (large) | 2 441.36 | 5 574.93 | 3 531.00 | 136.19 | 178.70 | 286.44 | 1 355.08 | 6 255.40 | 31.4 % |

#### Fleet model — price 14.90 €, mix conservative ({'A_LIGHT': 0.4, 'B_NORMAL': 0.4, 'C_HEAVY': 0.15, 'D_EXTREME': 0.05}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | text cmds + voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 149.00 | 50.00 (micro) | 43.17 | 107.53 | 73.59 | 0.00 | 0.00 | 0.00 | 10.65 | -135.93 | -91.2 % |
| 50 | 745.00 | 50.00 (micro) | 215.85 | 537.63 | 367.95 | 3.05 | 2.96 | 7.13 | 53.24 | -492.81 | -66.1 % |
| 100 | 1 490.00 | 50.00 (micro) | 431.70 | 1 075.25 | 735.90 | 8.25 | 17.29 | 32.43 | 106.49 | -967.31 | -64.9 % |
| 500 | 7 450.00 | 95.45 (medium) | 2 158.52 | 5 376.27 | 3 679.50 | 110.29 | 150.07 | 234.89 | 532.43 | -4 887.43 | -65.6 % |
| 1000 | 14 900.00 | 140.91 (large) | 4 317.05 | 10 752.55 | 7 359.00 | 243.82 | 316.05 | 487.97 | 1 064.86 | -9 782.19 | -65.7 % |

#### Fleet model — price 16.90 €, mix conservative ({'A_LIGHT': 0.4, 'B_NORMAL': 0.4, 'C_HEAVY': 0.15, 'D_EXTREME': 0.05}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | text cmds + voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 169.00 | 50.00 (micro) | 43.17 | 107.53 | 73.59 | 0.00 | 0.00 | 0.00 | 11.81 | -117.10 | -69.3 % |
| 50 | 845.00 | 50.00 (micro) | 215.85 | 537.63 | 367.95 | 3.05 | 2.96 | 7.13 | 59.05 | -398.61 | -47.2 % |
| 100 | 1 690.00 | 50.00 (micro) | 431.70 | 1 075.25 | 735.90 | 8.25 | 17.29 | 32.43 | 118.09 | -778.92 | -46.1 % |
| 500 | 8 450.00 | 95.45 (medium) | 2 158.52 | 5 376.27 | 3 679.50 | 110.29 | 150.07 | 234.89 | 590.47 | -3 945.47 | -46.7 % |
| 1000 | 16 900.00 | 140.91 (large) | 4 317.05 | 10 752.55 | 7 359.00 | 243.82 | 316.05 | 487.97 | 1 180.94 | -7 898.28 | -46.7 % |

#### Fleet model — price 19.90 €, mix conservative ({'A_LIGHT': 0.4, 'B_NORMAL': 0.4, 'C_HEAVY': 0.15, 'D_EXTREME': 0.05}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | text cmds + voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 199.00 | 50.00 (micro) | 43.17 | 107.53 | 73.59 | 0.00 | 0.00 | 0.00 | 13.55 | -88.84 | -44.6 % |
| 50 | 995.00 | 50.00 (micro) | 215.85 | 537.63 | 367.95 | 3.05 | 2.96 | 7.13 | 67.75 | -257.32 | -25.9 % |
| 100 | 1 990.00 | 50.00 (micro) | 431.70 | 1 075.25 | 735.90 | 8.25 | 17.29 | 32.43 | 135.51 | -496.33 | -24.9 % |
| 500 | 9 950.00 | 95.45 (medium) | 2 158.52 | 5 376.27 | 3 679.50 | 110.29 | 150.07 | 234.89 | 677.54 | -2 532.54 | -25.5 % |
| 1000 | 19 900.00 | 140.91 (large) | 4 317.05 | 10 752.55 | 7 359.00 | 243.82 | 316.05 | 487.97 | 1 355.08 | -5 072.41 | -25.5 % |

---

## 13. Price comparison 14.90 / 16.90 / 19.90

Bez limitov:

#### Price comparison summary (baseline mix, typical; overhead 0)

| price | break-even (infra) | BE +50 € overhead | BE +150 € overhead | margin @50 | @100 | @500 | @1000 | @100 conservative mix |
|---|---|---|---|---|---|---|---|---|
| 14.90 | 22 | 45 | 96 | 8.5 % | 10.6 % | 10.4 % | 10.4 % | -64.9 % |
| 16.90 | 12 | 24 | 49 | 18.6 % | 20.5 % | 20.3 % | 20.3 % | -46.1 % |
| 19.90 | 8 | 15 | 29 | 30.0 % | 31.6 % | 31.5 % | 31.4 % | -24.9 % |

#### Sensitivity at 100 companies (baseline mix) — gross margin

| scenario | 14.90 | 16.90 | 19.90 |
|---|---|---|---|
| base (typical) | 10.6 % | 20.5 % | 31.6 % |
| AI at HIGH cost per action | -58.7 % | -40.6 % | -20.3 % |
| AI usage ×2 (scans, text commands, voice) | -43.2 % | -27.0 % | -8.7 % |
| AI usage ×2 at HIGH cost | -181.7 % | -149.1 % | -112.4 % |
| every company has 20 users | 9.1 % | 19.1 % | 30.5 % |
| eInvoice usage ×3 | -36.8 % | -21.3 % | -3.9 % |
| eInvoice best price | 25.9 % | 34.0 % | 43.1 % |
| conservative mix | -64.9 % | -46.1 % | -24.9 % |

S odporúčanými limitmi (§15) — rozhodujúca tabuľka:

#### Recommended fair-use caps applied (no add-on revenue counted) — caps {'ai_scans': 50, 'voice_min': 60, 'einvoice_tx': 25, 'storage_gb': 10, 'chat_rate': None, 'users': None, 'text_commands': None}

| price | mix | margin @50 | @100 | @500 | @1000 | break-even (infra) | BE +150 € overhead | @100 AI HIGH cost | @100 eInvoice worst ×3 |
|---|---|---|---|---|---|---|---|---|---|
| 14.90 | baseline | 53.7 % | 55.8 % | 55.7 % | 55.7 % | 6 | 23 | 16.4 % | 51.8 % |
| 14.90 | conservative | 42.6 % | 43.8 % | 43.3 % | 43.3 % | 7 | 27 | -14.3 % | 41.2 % |
| 16.90 | baseline | 58.5 % | 60.4 % | 60.3 % | 60.2 % | 6 | 19 | 25.6 % | 56.9 % |
| 16.90 | conservative | 48.7 % | 49.8 % | 49.4 % | 49.3 % | 6 | 22 | -1.5 % | 47.4 % |
| 19.90 | baseline | 63.9 % | 65.5 % | 65.4 % | 65.3 % | 5 | 15 | 35.9 % | 62.5 % |
| 19.90 | conservative | 55.6 % | 56.5 % | 56.1 % | 56.1 % | 5 | 17 | 12.9 % | 54.5 % |

Per-profile cost with caps (typical / high), and margin at 14.90 / 9.90 web:

| profile | capped cost typ € | capped cost high € | margin 14.90 typ | margin 14.90 high | margin 9.90 typ | margin 9.90 high |
|---|---|---|---|---|---|---|
| A_LIGHT | 2.94 | 5.59 | 11.19 | 8.54 | 6.37 | 3.71 |
| B_NORMAL | 7.33 | 14.85 | 6.80 | -0.72 | 1.97 | -5.54 |
| C_HEAVY | 13.77 | 32.32 | 0.35 | -18.20 | -4.47 | -23.02 |
| D_EXTREME | 21.47 | 57.67 | -7.34 | -43.54 | -12.17 | -48.37 |

20-user variants with caps:

| variant | capped cost typ € | capped cost high € | margin 14.90 typ | margin 14.90 high |
|---|---|---|---|---|
| 20 users LIGHT | 4.29 | 9.45 | 9.83 | 4.68 |
| 20 users NORMAL | 10.28 | 23.83 | 3.84 | -9.70 |
| 20 users HEAVY | 20.12 | 56.32 | -6.00 | -42.20 |

---

## 14. Multi-company 9.90 analysis

Druhá firma = samostatné IČO, dáta, tím, AI, hlas, chat aj eFaktúra. Zdieľaný login **neznižuje náklad** — fix infra na
ďalšiu firmu je ~0 € už dnes (rovnako ako pri novom zákazníkovi). Zľava je čisto obchodné rozhodnutie.

#### Multi-company: second company at 9.90 € (web, typical)

| profile of 2nd company | cost € | fee € | margin € | margin % |
|---|---|---|---|---|
| A_LIGHT | 2.94 | 0.60 | 6.37 | 64 % |
| B_NORMAL | 12.70 | 0.60 | -3.40 | -34 % |
| C_HEAVY | 52.44 | 0.60 | -43.13 | -436 % |
| D_EXTREME | 187.17 | 0.60 | -177.87 | -1797 % |

S limitmi (§15) je 9,90 € OK iba pre LIGHT (+6,37 €) a hraničné pre NORMAL (+1,97 € typ., −5,54 € high); HEAVY je strata.
**9,90 € nie je bezpečné ako plošná cena druhej firmy.** Bezpečné varianty (OWNER DECISION):
(a) 9,90 € s nižšími zahrnutými limitmi (napr. 25 skenov, hlas 0–30 min, eFaktúra iba add-on), alebo
(b) zľava ~20 % (≈ 12,90–13,50 €) s plnými limitmi, alebo
(c) 9,90 € iba pri ročnej platbe.

---

## 15. Recommended limits / fair-use

| oblasť | odporúčanie | náklad pri plnom čerpaní (typ. / high) | odôvodnenie |
|---|---|---|---|
| Používatelia | **Neobmedzení** (fair-use technicky ~50 aktívnych) | chat 20 ľudí HEAVY ≈ 1,6 € | náklad na osobu je centový; fan-out chatu rastie ~kvadraticky, preto technický fair-use, nie marketingový limit |
| AI skeny dokumentov | **50 / mes. zahrnuté** (dnešná provizórna hodnota `AI_DOCUMENTS_MONTHLY_ALLOWANCE`) | 1,49 € / 2,92 € | 100 je možné pri 19,90 € alebo po zmeraní tokenov |
| Písané príkazy (intent classification fallback) | **bez tvrdého limitu, fair-use napr. 2 000 / firma / mes.** + odporúčaný prompt caching | 2 000 ≈ 5,3 € typ. bez cache → ~1,4 € s cache | lacné na príkaz, ale bez cache je pri 20 ľuďoch hlavná položka |
| Hlas | **60 min / firma / mes. zahrnuté, potom hard cap** (alebo hlas iba ako add-on) | 2,23 € / 4,65 € | najdrahšia neobmedzená položka (0,037–0,077 €/min) |
| Firemný chat | **bez limitu správ**; prílohy rátať do storage | ≤ 1,6 € | §6 |
| eFaktúra | **25 tx / mes. zahrnuté**, nad to add-on | 1,65 € worst | pri neistej tx cene a minime |
| Storage | **10 GB fair-use**, technický strop 25 GB | 0,44 € | §9 |

#### Lever: prompt caching on the intent-fallback prompt (NOT implemented — recommendation only)

| price | mix | margin @100 with caps, no caching | with caching | 20 users HEAVY capped cost typ € no cache → cache |
|---|---|---|---|---|
| 14.90 | baseline | 55.8 % | 68.2 % | 20.12 → 10.07 |
| 14.90 | conservative | 43.8 % | 61.4 % | 20.12 → 10.07 |
| 16.90 | baseline | 60.4 % | 71.3 % | 20.12 → 10.07 |
| 16.90 | conservative | 49.8 % | 65.3 % | 20.12 → 10.07 |
| 19.90 | baseline | 65.5 % | 74.7 % | 20.12 → 10.07 |
| 19.90 | conservative | 56.5 % | 69.7 % | 20.12 → 10.07 |

---

## 16. Recommended add-ons

#### Add-on economics (EUR, typical / high cost)

| add-on | unit | cost typical | cost high | proposed price | margin typical | margin high |
|---|---|---|---|---|---|---|
| +100 AI scans | 1 | 2.98 | 5.83 | 6.90 | 53 % | 12 % |
| Voice +120 min | 1 | 4.46 | 9.29 | 7.90 | 40 % | -21 % |
| Storage +25 GB | 1 | 1.10 | 2.53 | 2.90 | 59 % | 9 % |
| eInvoice Basic (50 tx) | 1 | 1.16 | 3.30 | 4.90 | 73 % | 29 % |
| eInvoice Plus (250 tx) | 1 | 5.82 | 16.50 | 14.90 | 57 % | -14 % |

Návrh (OWNER DECISION, ceny pracovné): **+100 AI skenov 6,90 €** (53 % typ.; pri high cene 12 % → zvážiť 7,90 €);
**hlas +120 min 9,90 €** (pri 7,90 € je high scenár stratový; s prompt cachingom je 7,90 € typicky bezpečné); **storage +25 GB 2,90 €**;
**eFaktúra Basic 50 tx 4,90 €**; **eFaktúra Plus 250 tx 19,90 €** (14,90 € je pri najhoršej tx cene stratové). Add-on sa
účtuje na tej istej Stripe faktúre (bez ďalšieho fixného 0,25 €).

---

## 17. Break-even

- **Infra break-even** (Supabase + Vercel + eFaktúra minimum, bez overheadu), s limitmi: **6 firiem pri 14,90 €**
  (konzervatívny mix 7), 6 pri 16,90 €, 5 pri 19,90 €. Bez limitov: 22 / 12 / 8 firiem (baseline), konzervatívny mix sa
  **nikdy nevyrovná** pri žiadnej z cien.
- **S development overheadom 150 €/mes.** (placeholder, GitHub/Copilot/Claude/doména/schránka — TBD): s limitmi
  23 / 19 / 15 firiem (baseline), 27 / 22 / 17 (konzervatívny).

**Cost buckets:**

| bucket | čo obsahuje | mesačne |
|---|---|---|
| COGS | OpenAI, eFaktúra tx, Storage/egress/Realtime/disk overage, Vercel usage nad kredit, platobné poplatky | podľa používania (§12–13) |
| FIXED OPERATING | Supabase Pro + compute (prod + staging), Vercel Pro seat, eFaktúra minimum | ≈ 50 € + 10 € |
| DEVELOPMENT OVERHEAD | GitHub, Copilot, Claude/Cowork, doména, firemná schránka, Apple Developer Program | **TBD** (scenáre 0 / 50 / 150 €) |
| OWNER LABOUR | práca vlastníka (nie je v gross margin) | príklad: pokrytie 3 000 €/mes. práce — pri 14,90 € s limitmi (~8,2 € príspevku/firmu) ≈ **365 platiacich firiem**; 16,90 € (~10,1 €) ≈ 297; 19,90 € (~12,9 €) ≈ 232 |

---

## 18. Recommended launch price (návrh — OWNER DECISION)

> **Prekonané 2026-10-25 rozhodnutím vlastníka:** kanonická launch cena je **Esblu Komplet 15,90 €** s limitmi a add-onmi
> (prepočet §22). Nižšie je pôvodná analýza pre úplnosť.

- **16,90 € bez DPH / firma / mes. s fair-use limitmi z §15** — rezerva na Play/Apple poplatky, neistú eFaktúra cenu a
  heavy 20-členné firmy; marža s limitmi ~60 % (baseline) / ~49 % (konzervatívny mix).
- **14,90 € je obhájiteľné iba ak** sú limity zavedené **a** zapne sa prompt caching intent fallbacku (alebo fair-use písaných príkazov) —
  potom ~68 % / ~61 % marža na 100 firmách.
- 19,90 € dovoľuje 100 skenov v cene; konkurenčné porovnanie (`docs/closed-beta-and-plans-2026-09-25.md` §8) je mimo tohto auditu.
- Ďalšia firma: **nie plošne 9,90 €** — pozri §14.
- Nič z toho sa neimplementuje v tomto tasku; `lib/pricing.ts` ostáva `provisional`.

---

## 19. Risks / unknowns

1. **AI telemetria** — implementovaná (§5.4), ale v produkcii až po schválenom rollout-e; do vtedy sú AI čísla odhady.
2. **Hlas** — podiel intent fallbacku a počet príkazov/min nie sú zmerané; telemetria (`voice_transcription`,
   `intent_classification_fallback`) ich po rollout-e zmeria.
3. **eFaktúra** — produkčný cenník po 30. 11. 2026, pásma objemu a rozsah minima (partner vs. organizácia) nepotvrdené.
4. ~~Realtime fan-out~~ — **OPRAVENÉ 2026-10-25** (filtre na firmu/konverzáciu, §6).
5. `notification_deliveries` — **chat riadky čistené po 7 dňoch** (2026-10-25). `deadline` riadky ostávajú (kľúč „overdue“
   bráni opakovanému upozorneniu); ich retencia = OWNER/CLIA INFORMATIVE NOTE (návrh: mazať iba riadky, ktorých termín bol
   vyriešený / entita zmazaná — neimplementované).
6. ~~Sekvenčný push fan-out~~ — **OPRAVENÉ 2026-10-25** (paralelné dávky po 5; FCM HTTP v1 nemá multicast, limit projektu
   ~600 000 správ/min).
7. ~~SDK retry po timeoute~~ — **OPRAVENÉ 2026-10-25** (§5.3).
8. Supabase compute veľkosť a Supabase Auth SMTP v produkcii — **MANUAL CONFIRMATION**.
9. Prílohy chatu bez kompresie (≤ 15 MB) — rast Storage.
10. Kurz USD/EUR, zmeny cien OpenAI (gpt-5.6-terra nie je v „latest“ sekcii — riziko deprecácie/zmeny ceny).
11. Play/Apple ceny sú VAT-inclusive pre spotrebiteľa; B2B zákazníci cez store platia DPH v cene — dopad na čistý príjem
    potvrdí účtovník/CLIA.

---

## 20. What needs manual billing confirmation

- [ ] Supabase: veľkosť compute prod + staging (Dashboard → Settings → Compute), či staging musí bežať nonstop.
- [ ] Supabase: vlastný SMTP pre Auth v produkcii (áno/nie).
- [ ] Vercel: Active CPU / invocations sadzby pre `fra1` (Usage stránka), počet seatov.
- [ ] eFaktura.sk: písomný cenník od 1. 12. 2026, pásma, minimum na partnera vs. organizáciu, ročný vs. mesačný program.
- [ ] OpenAI: skutočná spotreba tokenov (Usage dashboard po prvých 50–100 skenoch), dostupnosť prompt cachingu pre gpt-5.6-terra.
- [ ] GitHub plán, Copilot, Claude/Cowork, doména, firemná schránka, Apple Developer Program (development overhead).
- [ ] Stripe: podiel firemných kariet (premium 2,8 %), či sa použije Stripe Tax.
- [ ] Apple: zápis do App Store Small Business Program (15 % vs 26 %).

---

## 21. Cost limit readiness (meranie teraz, limity až po OWNER DECISION)

| limit | dnes v systéme | čo chýba na vynútenie |
|---|---|---|
| AI skeny / mesiac / firma | **vynucované** — `ai_processing_usage` + `esblu_reserve_ai_processing` (nárok `ai_documents`, `limit_value` + `limit_period='month'`) | iba rozhodnutie o čísle (dnes provizórne 50) |
| hlasové minúty / mesiac / firma | meria sa `ai_usage_monthly.audio_input_tokens` / `audio_seconds` (`voice_transcription`) | strop = kontrola súčtu pred volaním v `/api/assistant/transcribe` (nová RPC) — **neimplementované** |
| intent fallback (písané + hlasové príkazy) | meria sa `requests` + tokeny (`intent_classification_fallback`) | voliteľný fair-use strop rovnakým vzorom — neimplementované |
| eFaktúra tx / mesiac / firma | počítateľné z `einvoice_outbound` / `einvoice_inbound` (firma, dátum) | nárok + kontrola pred odoslaním — neimplementované |
| storage fair-use | počítateľné z `storage.objects` (`metadata.size`) podľa cesty firmy | periodický súčet + blok uploadu nad strop — neimplementované |

Customer-facing limity, UI ani nové balíky sa v tomto kroku **nezavádzali**.

---

## 22. Launch pricing 15,90 € (canonical, 2026-10-26)

Kanonický engine: `lib/pricing.ts`; nároky: migrácia `20261026100000_pricing_entitlements` (repo + staging). Model:
`docs/unit-economics/esblu-unit-economics-assumptions-2026-10-22.json` → `launch_pricing`. eFaktúra nie je live, preto sa
jej tx do kompletu zatiaľ nepočítajú (0 v cene; plánovaných 20 tx po spustení). Režim A = nad zahrnuté množstvo hard stop
(žiadny príjem z add-onov), režim B = firma si nad limit dokúpi add-on balíky.

#### Launch pricing — Esblu Komplet 15.90 € (included: {'ai_scans': 40, 'voice_min': 60, 'storage_gb': 5, 'users': 25, 'einvoice_tx': 0}) — margin by mix

A) excess usage blocked (hard stop, no add-on revenue); B) excess bought as add-on packs (AI 40 / 3,90 €, voice 60 min / 3,90 €, users 25 / 4,90 €). eFaktúra not live → 0 tx.

| mix | mode | margin @50 | @100 | @500 | @1000 | break-even (infra) | BE +150 € overhead | @100 AI HIGH cost |
|---|---|---|---|---|---|---|---|---|
| baseline | A hard stop | 62.5 % | 65.1 % | 65.5 % | 65.6 % | 6 | 19 | 28.8 % |
| baseline | B add-ons bought | 59.0 % | 60.6 % | 60.8 % | 60.8 % | 4 | 13 | 22.2 % |
| conservative | A hard stop | 53.7 % | 55.5 % | 55.7 % | 55.7 % | 7 | 22 | 2.1 % |
| conservative | B add-ons bought | 52.7 % | 53.4 % | 53.4 % | 53.4 % | 3 | 10 | 6.0 % |

Per profile at 15,90 € (web, typical): cost with hard stop vs. with add-ons bought (revenue includes add-ons)

| profile | cost hard-stop € | margin hard-stop € | add-on packs (AI/voice/users) | add-on revenue € | cost full usage € | margin with add-ons € |
|---|---|---|---|---|---|---|
| A_LIGHT | 2.28 | 12.82 | 0/0/0 | 0.00 | 2.28 | 12.82 |
| B_NORMAL | 5.38 | 9.71 | 2/1/0 | 11.70 | 9.40 | 16.98 |
| C_HEAVY | 11.61 | 3.49 | 7/8/0 | 58.50 | 35.94 | 35.61 |
| D_EXTREME | 19.22 | -4.13 | 24/33/0 | 222.30 | 121.17 | 108.43 |
| 20 users LIGHT | 3.63 | 11.46 | 0/0/0 | 0.00 | 3.63 | 11.46 |
| 20 users NORMAL | 8.34 | 6.76 | 2/1/0 | 11.70 | 12.35 | 14.03 |
| 20 users HEAVY | 17.96 | -2.86 | 7/8/0 | 58.50 | 42.28 | 29.26 |

Secondary company at 12.90 € (web, typical, hard stop):

| profile | cost € | margin € | margin % |
|---|---|---|---|
| A_LIGHT | 2.28 | 9.92 | 77 % |
| B_NORMAL | 5.38 | 6.82 | 53 % |
| C_HEAVY | 11.61 | 0.59 | 5 % |
| D_EXTREME | 19.22 | -7.02 | -54 % |

Závery pri 15,90 €:
- Baseline mix: **~65 %** hrubá marža (hard stop) / **~61 %** (add-ony kupované — vyšší absolútny príspevok), break-even infra
  **4–6 firiem**, s 150 € overheadom **13–19 firiem**. Konzervatívny mix: **~56 % / ~53 %**.
- LIGHT a NORMAL firmy (aj 20-členné NORMAL) sú pri 15,90 € ziskové; HEAVY / EXTREME firmy sú pri hard stope okolo nuly
  alebo mierne stratové (hlavne písané príkazy s OpenAI fallbackom bez prompt cachingu) a výrazne ziskové, ak si dokupujú add-ony.
- Ďalšia firma za 12,90 € s vlastnými limitmi: LIGHT 77 %, NORMAL 53 %, HEAVY ~5 %, EXTREME strata pri hard stope.
- Najväčšia páka ostáva prompt caching intent fallbacku (§15) a fair-use písaných príkazov.

---

COST / UNIT ECONOMICS AUDIT: **PARTIAL** (model hotový; AI tokeny, eFaktúra cenník a development overhead čakajú na manuálne potvrdenie)
Pricing: **CANONICAL LAUNCH PRICING 15,90 € (OWNER DECISION 2026-10-25) — billing / eFaktúra NOT LIVE**
INTERNAL COMPANY CHAT INCLUDED IN MODEL: **YES** (5 / 10 / 20 ľudí: §6)
COST CONTROL HARDENING: repo + staging **PASS**, production rollout **NOT YET RUN / PENDING APPROVAL**
