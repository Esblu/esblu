# Export, obnova a dôkazy o incidentoch (2026-11-12)

Zdroj: ChatGPT re-audit VOP 1.2 (body 3 a 5). Bez nového logovania obsahu zákazníckych dát.

## 1. Export údajov zákazníkom

| Export | Kto | Obsah | Formát | Originály |
|---|---|---|---|---|
| **Export údajov firmy** — Nastavenia → Export údajov firmy (`POST /api/company/export`, nové) | iba owner | všetky zákaznícke tabuľky firmy (firma, fakturačný profil, tím, oprávnenia, partneri, vozidlá + servis + známky + fotky, stroje + servis + fotky, sklad + fotky, dokumenty + prílohy + väzby + priečinky, AI evidencia, chat konverzácie + správy + prílohy, faktúry + riadky + strany + DPH + platby + udalosti + zálohy, e-faktúry prijaté/odoslané, prijatia VOP/DPA) + manifest s počtami a SHA-256 | ZIP: JSON + CSV (UTF-8) | áno — ZIP po dávkach (100 súborov), manifest + chýbajúce súbory |
| Balík pre účtovníka (`/api/accounting-handoff/package`) | finance.manage | finalizované faktúry: metadata.json, PDF, CSV súhrny, originálne XML e-faktúr | ZIP (PDF, XML, JSON, CSV) | áno |
| Balík dokumentov (`/api/document-packages`) | finance.manage | priečinok / výber dokladov s originálmi | ZIP | áno |
| Jednotlivé PDF / UBL / XML faktúr | finance.view | jedna faktúra | PDF / XML | áno |
| AI evidencia (XLSX, ZIP s fotkami) | RLS | záznamy AI evidencie | XLSX / ZIP | áno (fotky) |

**Pred zmenou** (audit 2026-11-12) neboli exportovateľné: vozidlá, stroje, sklad, chat, fakturačný profil, tím, partneri
ako celá tabuľka, štruktúra priečinkov → **BLOCKER odstránený** novým exportom údajov firmy.

**Čo sa neexportuje a prečo:** technické a vlastné záznamy Esblu (predplatné, kvóty, tokeny pozvánok, doručovanie push /
notifikácií, technický stav prenosu e-faktúr, evidencia sťahovaní) — nie sú zákazníckym obsahom spracúvaným v mene Zákazníka.
Krátkodobý kontext asistenta a hlasové nahrávky sa neuchovávajú, preto sa nedajú vrátiť. Generované PDF faktúr sú v Balíku pre
účtovníka; export údajov firmy obsahuje štruktúrované dáta faktúr (JSON/CSV), z ktorých PDF vzniká.

**Nie je to zákonný archív** — manifest exportu to uvádza; za uchovávanie dokladov zodpovedá Zákazník (VOP 19.4, 21.3).

## 2. Obnova pri technickom incidente

- **Databáza:** Supabase Pro denné zálohy (overené vlastníkom 2026-10-22); PITR **nie je zapnutý** → obnova zo zálohy môže
  stratiť zmeny od poslednej zálohy (VOP 19.4 to uvádza). Pred migračnými oknami sa robí logický dump (runbook §B).
- **Súbory (Storage):** nie sú súčasťou denných DB záloh Supabase; ochrana = súbory sa mažú iba explicitne (výmaz firmy /
  záznamu, cleanup job), nie automaticky. Obnovu jednotlivých súborov Esblu nesľubuje.
- **Aplikácia:** Vercel — návrat na predchádzajúci deployment (instant rollback); DB migrácie majú rollback súbory.
- **Postup:** `docs/data-breach-procedure.md`, `docs/einvoice-operations-runbook.md` §4 (výpadok Supabase / Vercel / providera),
  zápis zásahu do `docs/ops/service-intervention-log.md`.
- **Čo sa nedá vrátiť v pôvodnom formáte:** hlasové nahrávky (neuchovávajú sa), kontext asistenta (expiruje), vymazané súbory
  po dokončení cleanup jobu, zmeny po poslednej DB zálohe (bez PITR).

## 3. Dôkazy pri spore o dostupnosť (bez logovania obsahu)

**Dostupné:** Vercel deploymenty a runtime logy (obmedzená retencia plánu; logy obsahujú kódy chýb, nie obsah — AI chyby cez
`safeAiErrorMeta`, provider tajomstvá redigované), Vercel/Supabase status stránky a incident históriu poskytovateľov, Supabase
logy (API/DB, retencia podľa plánu), cron joby (`vercel.json`), e-faktúra health (`/api/cron/einvoice-maintenance`, 503 pri
kritickom stave), `docs/ops/service-intervention-log.md` (čas, rozsah, výsledok zásahu, bez osobných údajov),
`account_deletion_cleanup_jobs` / `company_terminations` (kódy, časy).

**Chýba (riziko, neblokuje VOP — VOP neobsahuje SLA):** verejný health endpoint, aktívny uptime monitoring / alerting
(GitHub workflow je iba návrh), centrálny log drain s retenciou, error monitoring. Odporúčanie pred spustením platenej
prevádzky: externý uptime monitor nad verejnou stránkou (iba HTTP stav, bez obsahu) + export runtime logov pri incidente
do internej zložky (kódy, časy) — bez nového logovania obsahu dokumentov, správ, AI promptov ani hlasu.
