# Esblu — Cost & Unit Economics Audit (reálne náklady na 1 firmu)

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
  mesačne **≈ 2 € / firma / mes.** Neobmedzení používatelia sú ekonomicky v poriadku (s technickým fair-use).
- **Bez limitov 14,90 € nie je bezpečné.** Baseline mix (60/30/9/1) dá iba **~10 % hrubej marže**, konzervatívny mix je
  **záporný (−66 %)**. Profil HEAVY stojí ~53 €, EXTREME ~188 € mesačne (typicky). Hlavné ťahúne: **hlas** (prepis + AI
  klasifikácia každého príkazu), **eFaktúra pri najhoršej tx cene** a **AI asistent bez prompt cachingu**.
- **S fair-use limitmi je 14,90 € ekonomicky životaschopné:** 50 AI skenov, 60 min hlasu, 25 eFaktúra tx, 10 GB → marža
  **~55 % (baseline) / ~43 % (konzervatívny mix)**, break-even infra pri **6–7 firmách**. Zraniteľná ostáva: ťažká 20-členná
  firma s neobmedzeným asistentom (typicky −6 €/mes.), kým sa nezapne prompt caching (potom ~+4 €).
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
| **OpenAI API** | AI skeny dokumentov, TP, AI fallback asistenta, prepis hlasu | PER TOKEN / PER MINUTE | §5 (OFFICIAL developers.openai.com/api/docs/pricing 2026-10-25) | bez telemetrie spotreby |
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
| AI asistent (iba fallback, keď deterministický parser nestačí) | 1 otázka | 0,0026 € typ. / 0,010 € high | PER TOKEN | rastie s počtom ľudí |
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

### 5.1 Inventúra všetkých OpenAI volaní (MEASURED z kódu RC `28af0e3`)

| flow | route | model | vstup | max tokens | retries | viac modelov? | caching | firemný kontext |
|---|---|---|---|---|---|---|---|---|
| AI evidencia / Inbox: bločky, faktúry, dodacie listy, vážne lístky, poistky, servis | `app/api/scan-document` | **gpt-5.6-terra** (`reasoning: none`, `store:false`, strict JSON schema) | text prompt (~14,2 k znakov) + schéma (~10 k znakov zdroja) + **1 obrázok `detail: high`** (JPEG/PNG/WebP ≤ 10 MB; **PDF sa neprijíma**) | nenastavené (štruktúrovaný výstup) | SDK default 2 | áno: **gpt-4.1** SPZ fallback iba pri vážnom lístku / dodacom liste bez SPZ (ten istý obrázok) | žiadny explicitný | **nie** — iba obrázok + statický prompt |
| Vehicle document (legacy) | `app/api/scan-vehicle-doc` | gpt-5.6-terra + gpt-4.1 SPZ fallback | prompt ~5,3 k znakov + schéma ~2,2 k + 1 obrázok high | nenastavené | SDK default 2 | áno (fallback) | nie | nie |
| Technický preukaz | `app/api/scan-vehicle-registration` | **gpt-4.1-mini** | krátky prompt + **2 obrázky** (predná/zadná strana) high | nenastavené | SDK default 2 | nie | nie | nie |
| AI asistent (text) | `app/api/assistant/intent` → `lib/intents/ai-fallback.ts` | gpt-5.6-terra | prompt ~10,2 k znakov + schéma ~4,3 k + text používateľa | nenastavené | SDK default 2 | nie | nie | **nie** — iba klasifikácia textu na povolený intent; odpoveď skladá deterministický handler z DB (RLS). Volá sa **iba ak deterministický parser zlyhá** |
| Hlas | `app/api/assistant/transcribe` → potom ten istý Intent Engine | **gpt-4o-transcribe** (+ gpt-5.6-terra fallback podľa textu) | audio (VAD posiela iba reč) | — | `maxRetries: 1`, timeout 18 s | áno: prepis + prípadne AI fallback | nie | nie; TTS = prehliadač (0 $) |

Iné volania OpenAI v repe nie sú (žiadne embeddings, summarization, chat completions, image generation). **Firemný chat AI
nevolá.** AI kvóta firmy (`reserveAiProcessing`, abuse limit 60/h, 240/deň) chráni skeny; asistent a hlas majú iba nárok
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
| assistant request (fallback share × call) | 0.0003 | 0.0029 | 0.0110 | 0.0026 |
| voice: 1 audio min full chain (transcribe + intents) | 0.0176 | 0.0409 | 0.0852 | 0.0372 |
| scan_document (single call chain) | 0.0220 | 0.0360 | 0.0710 | 0.0327 |
| scan_vehicle_doc (single call chain) | 0.0120 | 0.0200 | 0.0350 | 0.0182 |
| scan_vehicle_registration (single call chain) | 0.0020 | 0.0030 | 0.0050 | 0.0027 |
| intent_fallback_call (single call chain) | 0.0025 | 0.0097 | 0.0110 | 0.0088 |
| voice 5 min full chain | 0.088 | 0.205 | 0.426 | 0.186 |

Odpovede na zadané akcie (typicky / high, EUR): bloček ≈ **0,033 / 0,065**; PDF faktúra — **PDF Esblu neprijíma**, foto faktúry
≈ 0,033 / 0,065; foto dokumentu ≈ 0,033; vehicle-document ≈ 0,018 / 0,032; TP ≈ 0,003; AI otázka ≈ **0,003** (fallback 0,009);
„dlhšia otázka s firemným kontextom“ = **rovnaká cena** (kontext sa neposiela); 1 min hlasu ≈ **0,037 / 0,077**; 5 min ≈
**0,19 / 0,39**; hlas → AI → odpoveď = prepis + fallback (zahrnuté v cene minúty).

---

## 6. Internal Chat economics (INTERNÝ FIREMNÝ CHAT ≠ AI chat)

Implementácia (MEASURED): `chat_messages` / `chat_attachments` / `chat_message_references` / `chat_conversation_members`
v Supabase Postgres; Realtime **postgres_changes** — (a) kanál `chat-unread-<user>` na **INSERT do celej tabuľky
`chat_messages` bez filtra** (RLS rozhodne o doručení), (b) otvorená konverzácia s filtrom `conversation_id`;
prílohy v buckete `chat-attachments` (≤ 15 MB, bez kompresie); unread = lokálny counter + RPC; push po každej správe
(`/api/push/chat-message`) **všetkým členom firemného kanála** (direct = 1 príjemca), sekvenčne, s deduplikačným riadkom
`notification_deliveries` na príjemcu. **Retencia správ ani `notification_deliveries` neexistuje.** Žiadne volanie OpenAI.

Model: 22 pracovných dní, 50 % správ vo firemnom kanáli, 50 % pripojených počas dňa, riadok správy 0,5 KB, riadok
doručenia 0,25 KB, push funkcia 0,15 s + 0,15 s/príjemca (ESTIMATE). Ceny Realtime/DB/egress = overage sadzby (konzervatívne
— v praxi pokryté poolom pri malom počte firiem).

#### Internal company chat — monthly cost per company (EUR)

| users | usage | msgs/mo | Realtime msgs | push deliveries | DB growth MB/mo | Realtime € | DB € | egress € | push fn € | **total €** |
|---|---|---|---|---|---|---|---|---|---|---|
| 5 | LIGHT 10 | 1 100 | 4 950 | 2 750 | 1.2 | 0.011 | 0.000 | 0.000 | 0.007 | **0.02** |
| 5 | NORMAL 30 | 3 300 | 14 850 | 8 250 | 3.6 | 0.034 | 0.000 | 0.001 | 0.021 | **0.06** |
| 5 | HEAVY 100 | 11 000 | 49 500 | 27 500 | 12.1 | 0.112 | 0.001 | 0.004 | 0.072 | **0.19** |
| 10 | LIGHT 10 | 2 200 | 15 400 | 11 000 | 3.8 | 0.035 | 0.000 | 0.001 | 0.022 | **0.06** |
| 10 | NORMAL 30 | 6 600 | 46 200 | 33 000 | 11.3 | 0.105 | 0.001 | 0.004 | 0.066 | **0.18** |
| 10 | HEAVY 100 | 22 000 | 154 000 | 110 000 | 37.6 | 0.350 | 0.004 | 0.012 | 0.219 | **0.59** |
| 20 | LIGHT 10 | 4 400 | 52 800 | 44 000 | 12.9 | 0.120 | 0.001 | 0.004 | 0.074 | **0.20** |
| 20 | NORMAL 30 | 13 200 | 158 400 | 132 000 | 38.7 | 0.360 | 0.004 | 0.012 | 0.222 | **0.60** |
| 20 | HEAVY 100 | 44 000 | 528 000 | 440 000 | 128.9 | 1.200 | 0.014 | 0.041 | 0.741 | **2.00** |

Prílohy: pri 2 % správ s prílohou 1 MB je HEAVY 20 ľudí ≈ 0,86 GB/mes. nového Storage — patrí do storage fair-use (§9).
**Záver: chat netreba limitovať počtom správ.** Riziká sú technické (nižšie), nie cenové.

---

## 7. 20-user company economics

Varianty: LIGHT = 25 skenov, 1 AI otázka/os./deň (440), 30 min hlasu, chat 10, 10 tx; NORMAL = 100 skenov, 3/deň (1 320),
120 min, chat 30, 50 tx; HEAVY = 300 skenov, 10/deň (4 400), 500 min, chat 100, 250 tx.

#### 20-person company (EUR / month)

| variant | cost typical € | cost high € | margin @14.90 web (typ) | @16.90 | @19.90 |
|---|---|---|---|---|---|
| 20 users LIGHT | 4.34 | 9.49 | 9.79 | 11.72 | 14.62 |
| 20 users NORMAL | 15.78 | 33.17 | -1.65 | 0.28 | 3.17 |
| 20 users HEAVY | 59.20 | 120.24 | -45.07 | -43.14 | -40.25 |

Same 20-user variants without voice and without eInvoice (core + AI scans + assistant + chat):

| variant | cost typical € | margin @14.90 web |
|---|---|---|
| 20 users LIGHT | 2.56 | 11.57 |
| 20 users NORMAL | 8.02 | 6.11 |
| 20 users HEAVY | 24.10 | -9.97 |

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

| profil | ľudia | AI skeny | AI otázky | hlas min | storage | chat / os. / deň | eFaktúra tx |
|---|---|---|---|---|---|---|---|
| A LIGHT | 5 | 25 | 100 | 30 | 1 GB | 10 | 10 |
| B NORMAL | 10 | 100 | 500 | 120 | 5 GB | 30 | 50 |
| C HEAVY | 20 | 300 | 2 000 | 500 | 10 GB | 100 | 250 |
| D EXTREME | 20 | 1 000 | 4 400 | 2 000 | 25 GB | 100 (44 000 správ) | 1 000 |

#### Profile cost per company / month (EUR, marginal above included pools, typical level, eInvoice worst price)

| profile | ai_scans | assistant | voice | chat | storage | egress | einvoice | vercel | total | total HIGH level |
|---|---|---|---|---|---|---|---|---|---|---|
| A_LIGHT | 0.74 | 0.26 | 1.12 | 0.02 | 0.02 | 0.02 | 0.66 | 0.09 | 2.94 | 5.59 |
| B_NORMAL | 2.98 | 1.32 | 4.46 | 0.18 | 0.10 | 0.12 | 3.30 | 0.27 | 12.73 | 24.09 |
| C_HEAVY | 8.93 | 5.29 | 18.60 | 2.00 | 0.19 | 0.25 | 16.50 | 1.09 | 52.85 | 96.24 |
| D_EXTREME | 29.77 | 11.64 | 74.40 | 2.00 | 0.48 | 1.02 | 66.00 | 2.27 | 187.59 | 328.96 |

#### Margin per single company by profile and price (web channel, typical) — EUR

| profile | cost € | 14.9 € margin | 16.9 € margin | 19.9 € margin | 9.90 € margin |
|---|---|---|---|---|---|
| A_LIGHT | 2.94 | 11.19 (75 %) | 13.12 (78 %) | 16.01 (80 %) | 6.36 (64 %) |
| B_NORMAL | 12.73 | 1.40 (9 %) | 3.33 (20 %) | 6.22 (31 %) | -3.43 (-35 %) |
| C_HEAVY | 52.85 | -38.72 (-260 %) | -36.79 (-218 %) | -33.90 (-170 %) | -43.55 (-440 %) |
| D_EXTREME | 187.59 | -173.46 (-1164 %) | -171.53 (-1015 %) | -168.64 (-847 %) | -178.29 (-1801 %) |

**Kde 14,90 € prestáva byť bezpečné (bez limitov):** už pri profile NORMAL je typická marža iba ~9 %; HEAVY a EXTREME sú
stratové. Pri HIGH cenách akcií je stratový aj NORMAL.

---

## 12. 10 / 50 / 100 / 500 / 1000-company model (bez limitov — „unlimited all-inclusive“)

Fix = Supabase + Vercel (tier podľa počtu firiem); eFaktúra = max(10 €, tx); kanál 80 % web / 15 % Play / 5 % Apple;
development overhead nezahrnutý (pozri §17).

#### Fleet model — price 14.90 €, mix baseline ({'A_LIGHT': 0.6, 'B_NORMAL': 0.3, 'C_HEAVY': 0.09, 'D_EXTREME': 0.01}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | assistant+voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 149.00 | 50.00 (micro) | 24.41 | 55.75 | 35.31 | 0.00 | 0.00 | 0.00 | 10.65 | -27.12 | -18.2 % |
| 50 | 745.00 | 50.00 (micro) | 122.07 | 278.75 | 176.55 | 1.60 | 0.00 | 0.00 | 53.24 | 62.79 | 8.4 % |
| 100 | 1 490.00 | 50.00 (micro) | 244.14 | 557.49 | 353.10 | 6.00 | 4.46 | 17.36 | 106.49 | 150.97 | 10.1 % |
| 500 | 7 450.00 | 95.45 (medium) | 1 220.68 | 2 787.46 | 1 765.50 | 65.33 | 81.40 | 159.52 | 532.43 | 742.22 | 10.0 % |
| 1000 | 14 900.00 | 140.91 (large) | 2 441.36 | 5 574.93 | 3 531.00 | 153.90 | 178.70 | 337.23 | 1 064.86 | 1 477.11 | 9.9 % |

#### Fleet model — price 16.90 €, mix baseline ({'A_LIGHT': 0.6, 'B_NORMAL': 0.3, 'C_HEAVY': 0.09, 'D_EXTREME': 0.01}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | assistant+voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 169.00 | 50.00 (micro) | 24.41 | 55.75 | 35.31 | 0.00 | 0.00 | 0.00 | 11.81 | -8.28 | -4.9 % |
| 50 | 845.00 | 50.00 (micro) | 122.07 | 278.75 | 176.55 | 1.60 | 0.00 | 0.00 | 59.05 | 156.98 | 18.6 % |
| 100 | 1 690.00 | 50.00 (micro) | 244.14 | 557.49 | 353.10 | 6.00 | 4.46 | 17.36 | 118.09 | 339.36 | 20.1 % |
| 500 | 8 450.00 | 95.45 (medium) | 1 220.68 | 2 787.46 | 1 765.50 | 65.33 | 81.40 | 159.52 | 590.47 | 1 684.18 | 19.9 % |
| 1000 | 16 900.00 | 140.91 (large) | 2 441.36 | 5 574.93 | 3 531.00 | 153.90 | 178.70 | 337.23 | 1 180.94 | 3 361.03 | 19.9 % |

#### Fleet model — price 19.90 €, mix baseline ({'A_LIGHT': 0.6, 'B_NORMAL': 0.3, 'C_HEAVY': 0.09, 'D_EXTREME': 0.01}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | assistant+voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 199.00 | 50.00 (micro) | 24.41 | 55.75 | 35.31 | 0.00 | 0.00 | 0.00 | 13.55 | 19.98 | 10.0 % |
| 50 | 995.00 | 50.00 (micro) | 122.07 | 278.75 | 176.55 | 1.60 | 0.00 | 0.00 | 67.75 | 298.28 | 30.0 % |
| 100 | 1 990.00 | 50.00 (micro) | 244.14 | 557.49 | 353.10 | 6.00 | 4.46 | 17.36 | 135.51 | 621.95 | 31.3 % |
| 500 | 9 950.00 | 95.45 (medium) | 1 220.68 | 2 787.46 | 1 765.50 | 65.33 | 81.40 | 159.52 | 677.54 | 3 097.11 | 31.1 % |
| 1000 | 19 900.00 | 140.91 (large) | 2 441.36 | 5 574.93 | 3 531.00 | 153.90 | 178.70 | 337.23 | 1 355.08 | 6 186.89 | 31.1 % |

#### Fleet model — price 14.90 €, mix conservative ({'A_LIGHT': 0.4, 'B_NORMAL': 0.4, 'C_HEAVY': 0.15, 'D_EXTREME': 0.05}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | assistant+voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 149.00 | 50.00 (micro) | 43.17 | 107.53 | 73.59 | 0.00 | 0.00 | 0.00 | 10.65 | -135.93 | -91.2 % |
| 50 | 745.00 | 50.00 (micro) | 215.85 | 537.63 | 367.95 | 4.36 | 2.96 | 11.83 | 53.24 | -498.82 | -67.0 % |
| 100 | 1 490.00 | 50.00 (micro) | 431.70 | 1 075.25 | 735.90 | 11.51 | 17.29 | 41.83 | 106.49 | -979.97 | -65.8 % |
| 500 | 7 450.00 | 95.45 (medium) | 2 158.52 | 5 376.27 | 3 679.50 | 126.60 | 150.07 | 281.89 | 532.43 | -4 950.73 | -66.5 % |
| 1000 | 14 900.00 | 140.91 (large) | 4 317.05 | 10 752.55 | 7 359.00 | 276.44 | 316.05 | 581.96 | 1 064.86 | -9 908.79 | -66.5 % |

#### Fleet model — price 16.90 €, mix conservative ({'A_LIGHT': 0.4, 'B_NORMAL': 0.4, 'C_HEAVY': 0.15, 'D_EXTREME': 0.05}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | assistant+voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 169.00 | 50.00 (micro) | 43.17 | 107.53 | 73.59 | 0.00 | 0.00 | 0.00 | 11.81 | -117.10 | -69.3 % |
| 50 | 845.00 | 50.00 (micro) | 215.85 | 537.63 | 367.95 | 4.36 | 2.96 | 11.83 | 59.05 | -404.62 | -47.9 % |
| 100 | 1 690.00 | 50.00 (micro) | 431.70 | 1 075.25 | 735.90 | 11.51 | 17.29 | 41.83 | 118.09 | -791.58 | -46.8 % |
| 500 | 8 450.00 | 95.45 (medium) | 2 158.52 | 5 376.27 | 3 679.50 | 126.60 | 150.07 | 281.89 | 590.47 | -4 008.77 | -47.4 % |
| 1000 | 16 900.00 | 140.91 (large) | 4 317.05 | 10 752.55 | 7 359.00 | 276.44 | 316.05 | 581.96 | 1 180.94 | -8 024.88 | -47.5 % |

#### Fleet model — price 19.90 €, mix conservative ({'A_LIGHT': 0.4, 'B_NORMAL': 0.4, 'C_HEAVY': 0.15, 'D_EXTREME': 0.05}) — EUR / month, overhead excluded

| companies | MRR | fixed infra | AI scans | assistant+voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 199.00 | 50.00 (micro) | 43.17 | 107.53 | 73.59 | 0.00 | 0.00 | 0.00 | 13.55 | -88.84 | -44.6 % |
| 50 | 995.00 | 50.00 (micro) | 215.85 | 537.63 | 367.95 | 4.36 | 2.96 | 11.83 | 67.75 | -263.33 | -26.5 % |
| 100 | 1 990.00 | 50.00 (micro) | 431.70 | 1 075.25 | 735.90 | 11.51 | 17.29 | 41.83 | 135.51 | -508.99 | -25.6 % |
| 500 | 9 950.00 | 95.45 (medium) | 2 158.52 | 5 376.27 | 3 679.50 | 126.60 | 150.07 | 281.89 | 677.54 | -2 595.84 | -26.1 % |
| 1000 | 19 900.00 | 140.91 (large) | 4 317.05 | 10 752.55 | 7 359.00 | 276.44 | 316.05 | 581.96 | 1 355.08 | -5 199.01 | -26.1 % |

---

## 13. Price comparison 14.90 / 16.90 / 19.90

Bez limitov:

#### Price comparison summary (baseline mix, typical; overhead 0)

| price | break-even (infra) | BE +50 € overhead | BE +150 € overhead | margin @50 | @100 | @500 | @1000 | @100 conservative mix |
|---|---|---|---|---|---|---|---|---|
| 14.90 | 22 | 45 | 100 | 8.4 % | 10.1 % | 10.0 % | 9.9 % | -65.8 % |
| 16.90 | 12 | 24 | 49 | 18.6 % | 20.1 % | 19.9 % | 19.9 % | -46.8 % |
| 19.90 | 8 | 15 | 29 | 30.0 % | 31.3 % | 31.1 % | 31.1 % | -25.6 % |

#### Sensitivity at 100 companies (baseline mix) — gross margin

| scenario | 14.90 | 16.90 | 19.90 |
|---|---|---|---|
| base (typical) | 10.1 % | 20.1 % | 31.3 % |
| AI at HIGH cost per action | -59.1 % | -41.0 % | -20.6 % |
| AI usage ×2 (scans, assistant, voice) | -43.7 % | -27.4 % | -9.0 % |
| AI usage ×2 at HIGH cost | -182.2 % | -149.5 % | -112.7 % |
| every company has 20 users | 8.2 % | 18.3 % | 29.8 % |
| eInvoice usage ×3 | -37.3 % | -21.7 % | -4.2 % |
| eInvoice best price | 25.5 % | 33.6 % | 42.7 % |
| conservative mix | -65.8 % | -46.8 % | -25.6 % |

S odporúčanými limitmi (§15) — rozhodujúca tabuľka:

#### Recommended fair-use caps applied (no add-on revenue counted) — caps {'ai_scans': 50, 'voice_min': 60, 'einvoice_tx': 25, 'storage_gb': 10, 'assistant': None, 'chat_rate': None, 'users': None}

| price | mix | margin @50 | @100 | @500 | @1000 | break-even (infra) | BE +150 € overhead | @100 AI HIGH cost | @100 eInvoice worst ×3 |
|---|---|---|---|---|---|---|---|---|---|
| 14.90 | baseline | 53.7 % | 55.4 % | 55.2 % | 55.2 % | 6 | 23 | 15.9 % | 51.4 % |
| 14.90 | conservative | 41.8 % | 43.0 % | 42.5 % | 42.4 % | 7 | 27 | -15.2 % | 40.3 % |
| 16.90 | baseline | 58.5 % | 60.0 % | 59.9 % | 59.8 % | 6 | 19 | 25.2 % | 56.5 % |
| 16.90 | conservative | 48.0 % | 49.0 % | 48.6 % | 48.6 % | 6 | 22 | -2.2 % | 46.7 % |
| 19.90 | baseline | 63.9 % | 65.1 % | 65.0 % | 65.0 % | 5 | 15 | 35.6 % | 62.1 % |
| 19.90 | conservative | 55.0 % | 55.8 % | 55.5 % | 55.4 % | 5 | 17 | 12.3 % | 53.8 % |

Per-profile cost with caps (typical / high), and margin at 14.90 / 9.90 web:

| profile | capped cost typ € | capped cost high € | margin 14.90 typ | margin 14.90 high | margin 9.90 typ | margin 9.90 high |
|---|---|---|---|---|---|---|
| A_LIGHT | 2.94 | 5.59 | 11.19 | 8.53 | 6.36 | 3.71 |
| B_NORMAL | 7.36 | 14.88 | 6.77 | -0.75 | 1.94 | -5.58 |
| C_HEAVY | 14.19 | 32.74 | -0.06 | -18.61 | -4.89 | -23.43 |
| D_EXTREME | 21.88 | 58.08 | -7.76 | -43.96 | -12.58 | -48.78 |

20-user variants with caps:

| variant | capped cost typ € | capped cost high € | margin 14.90 typ | margin 14.90 high |
|---|---|---|---|---|
| 20 users LIGHT | 4.34 | 9.49 | 9.79 | 4.64 |
| 20 users NORMAL | 10.41 | 23.96 | 3.72 | -9.83 |
| 20 users HEAVY | 20.54 | 56.74 | -6.41 | -42.61 |

---

## 14. Multi-company 9.90 analysis

Druhá firma = samostatné IČO, dáta, tím, AI, hlas, chat aj eFaktúra. Zdieľaný login **neznižuje náklad** — fix infra na
ďalšiu firmu je ~0 € už dnes (rovnako ako pri novom zákazníkovi). Zľava je čisto obchodné rozhodnutie.

#### Multi-company: second company at 9.90 € (web, typical)

| profile of 2nd company | cost € | fee € | margin € | margin % |
|---|---|---|---|---|
| A_LIGHT | 2.94 | 0.60 | 6.36 | 64 % |
| B_NORMAL | 12.73 | 0.60 | -3.43 | -35 % |
| C_HEAVY | 52.85 | 0.60 | -43.55 | -440 % |
| D_EXTREME | 187.59 | 0.60 | -178.29 | -1801 % |

S limitmi (§15) je 9,90 € OK iba pre LIGHT (+6,36 €) a hraničné pre NORMAL (+1,94 € typ., −5,58 € high); HEAVY je strata.
**9,90 € nie je bezpečné ako plošná cena druhej firmy.** Bezpečné varianty (OWNER DECISION):
(a) 9,90 € s nižšími zahrnutými limitmi (napr. 25 skenov, hlas 0–30 min, eFaktúra iba add-on), alebo
(b) zľava ~20 % (≈ 12,90–13,50 €) s plnými limitmi, alebo
(c) 9,90 € iba pri ročnej platbe.

---

## 15. Recommended limits / fair-use

| oblasť | odporúčanie | náklad pri plnom čerpaní (typ. / high) | odôvodnenie |
|---|---|---|---|
| Používatelia | **Neobmedzení** (fair-use technicky ~50 aktívnych) | chat 20 ľudí HEAVY ≈ 2 € | náklad na osobu je centový; fan-out chatu rastie ~kvadraticky, preto technický fair-use, nie marketingový limit |
| AI skeny dokumentov | **50 / mes. zahrnuté** (dnešná provizórna hodnota `AI_DOCUMENTS_MONTHLY_ALLOWANCE`) | 1,49 € / 2,92 € | 100 je možné pri 19,90 € alebo po zmeraní tokenov |
| AI asistent (text) | **bez tvrdého limitu, fair-use napr. 2 000 / firma / mes.** + odporúčaný prompt caching | 2 000 ≈ 5,3 € typ. bez cache → ~1,4 € s cache | lacný per otázka, ale bez cache je pri 20 ľuďoch hlavná položka |
| Hlas | **60 min / firma / mes. zahrnuté, potom hard cap** (alebo hlas iba ako add-on) | 2,23 € / 4,65 € | najdrahšia neobmedzená položka (0,037–0,077 €/min) |
| Firemný chat | **bez limitu správ**; prílohy rátať do storage | ≤ 2 € | §6 |
| eFaktúra | **25 tx / mes. zahrnuté**, nad to add-on | 1,65 € worst | pri neistej tx cene a minime |
| Storage | **10 GB fair-use**, technický strop 25 GB | 0,44 € | §9 |

#### Lever: prompt caching on the intent-fallback prompt (NOT implemented — recommendation only)

| price | mix | margin @100 with caps, no caching | with caching | 20 users HEAVY capped cost typ € no cache → cache |
|---|---|---|---|---|
| 14.90 | baseline | 55.4 % | 67.7 % | 20.54 → 10.48 |
| 14.90 | conservative | 43.0 % | 60.6 % | 20.54 → 10.48 |
| 16.90 | baseline | 60.0 % | 70.9 % | 20.54 → 10.48 |
| 16.90 | conservative | 49.0 % | 64.6 % | 20.54 → 10.48 |
| 19.90 | baseline | 65.1 % | 74.4 % | 20.54 → 10.48 |
| 19.90 | conservative | 55.8 % | 69.0 % | 20.54 → 10.48 |

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

- **16,90 € bez DPH / firma / mes. s fair-use limitmi z §15** — rezerva na Play/Apple poplatky, neistú eFaktúra cenu a
  heavy 20-členné firmy; marža s limitmi ~60 % (baseline) / ~49 % (konzervatívny mix).
- **14,90 € je obhájiteľné iba ak** sú limity zavedené **a** zapne sa prompt caching asistenta (alebo limit asistenta) —
  potom ~68 % / ~61 % marža na 100 firmách.
- 19,90 € dovoľuje 100 skenov v cene; konkurenčné porovnanie (`docs/closed-beta-and-plans-2026-09-25.md` §8) je mimo tohto auditu.
- Ďalšia firma: **nie plošne 9,90 €** — pozri §14.
- Nič z toho sa neimplementuje v tomto tasku; `lib/pricing.ts` ostáva `provisional`.

---

## 19. Risks / unknowns

1. **Žiadna telemetria AI spotreby** — `response.usage` sa nikde neloguje; všetky AI čísla sú odhady. Odporúčanie (neimplementované):
   logovať input/output/cached tokeny bez obsahu.
2. **Hlas** — podiel AI fallbacku a počet príkazov/min nie sú zmerané (`esblu_assistant_turn.source` to umožňuje zmerať).
3. **eFaktúra** — produkčný cenník po 30. 11. 2026, pásma objemu a rozsah minima (partner vs. organizácia) nepotvrdené.
4. **Realtime fan-out (technický nález, neopravené):** kanál `chat-unread-<user>` počúva INSERT na celú `chat_messages` bez
   filtra → Realtime autorizuje každú novú správu pre každého pripojeného odberateľa celej platformy. Pri stovkách firiem to
   záťaží DB (compute tier) skôr než účet za správy. Odporúčaný smer: filter `company_id` / Broadcast.
5. **`notification_deliveries` bez retencie (nález, neopravené)** — ~440 000 riadkov/mes. pri HEAVY 20-člennej firme.
6. **Push fan-out je sekvenčný** (~3–4 s funkcie pri 19 príjemcoch) — Vercel GB-h; pri 50+ ľuďoch dlhé behy.
7. OpenAI SDK default `maxRetries: 2` pri skenoch — retry po timeoute môže byť účtovaný dvakrát.
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

COST / UNIT ECONOMICS AUDIT: **PARTIAL** (model hotový; AI tokeny, eFaktúra cenník a development overhead čakajú na manuálne potvrdenie)
Pricing: **OWNER DECISION PENDING**
INTERNAL COMPANY CHAT INCLUDED IN MODEL: **YES** (5 / 10 / 20 ľudí: §6)
