# eFaktura.sk — živý SANDBOX A/B test (2026-11-12)

- Vetva `einvoice-readiness-audit` (nie `main`). Kľúč: eFaktura.sk **sandbox test key** (`efk_pk_test_…`); live kľúč skript odmietne pred akýmkoľvek volaním.
- Beh: izolovaný Vercel Sandbox (fra1, sieť obmedzená na `api.efaktura.sk` + npm registry), kľúč iba ako env príkazu, výstup filtrovaný; sandbox po behu zastavený a zmazaný.
- DB: **PGlite v pamäti** (všetky migrácie) — žiadna Supabase, žiadny zápis do produkcie ani stagingu.
- Iba syntetické firmy (IČO s kontrolnou číslicou generované zo seedu, TEST SMP 9915). Test key nepoužíva produkčné kredity ani produkčný Peppol prenos.
- Seed `e2e-ab-20261112c`, `generated_at` 2026-11-12T21:33:28Z. Plný report: `docs/einvoice-sandbox-ab-live-2026-11-12.report.json` (0 výskytov `efk_pk_` / `whsec_`).

## Výsledok: 26 PASS, 1 PARTIAL, 0 FAIL

| Krok | Scenár | Výsledok |
|---|---|---|
| D1–D3 | POST /organizations A, B, C, D; idempotencia (rovnaké IČO → reused, 1 riadok) | PASS |
| E1–E4 | enroll A, B `a1b2c3` → enrolled, 9915:DIČ, príjem active; opakovaný enroll; participant.activated → DUPLICATE pri replay | PASS |
| F1–F3 | invalid `…dead` → 400 `VERIFICATION_TOKEN_INVALID`, C failed, A nezhoršená | PASS |
| G1–G3 | send_only `…beef` → D send_only (`PARTICIPANT_HELD_ELSEWHERE`), poll D aj C vynechá | PASS |
| I1–I3 | A → B: readiness, UBL EN16931/BIS 3.0, recipient + preflight + connector/send → `delivered`, evidence hash = UBL | PASS |
| I4 | status/feed: `peppol.document.delivered` (mode test) → ALREADY_FINAL | PASS |
| I5 | idempotentný retry: opakovaný request 200 `ALREADY_REQUESTED`, 0 nových podaní | PASS |
| J1 | inbound B: GET received → originál = **SBDH obálka**, receiver = B, uložené, acknowledged | PASS |
| J2 | `peppol.document.received` → webhook handler PROCESSED | PASS |
| J3 | koncept prijatej faktúry (draft, `efaktura_peppol`), ACK, dodávateľ A založený v B s DIČ z XML | PASS |
| J4 | duplicitný doklad (poll + registrácia znova) → 0 nových konceptov/partnerov | PASS |
| J5 | izolácia: A nevidí inbound B, B nevidí outbound A ani cudzie org, employee nič | PASS |
| J6 | **recipient mismatch**: reálne prijaté XML (pre B) v schránke A → `failed RECIPIENT_MISMATCH` (`RECIPIENT_ENVELOPE_MISMATCH`), bez konceptu, 0 ACK | PASS |
| H1 | webhook HMAC: neplatný podpis 401, stará pečiatka 401, duplicita (to isté ID) 200 DUPLICATE, iné telo pod tým istým ID 409, **to isté telo pod novým ID 200 DUPLICATE** | PARTIAL — sandbox feed neemitoval `peppol.document.sent`; reálne HTTP doručenie neprebehlo |
| H2 | wrong company: neznámy orgId → UNKNOWN_ORG; `company_id` A v tele + orgId B → spracované iba pre B, 0 riadkov v A | PASS |
| K1 | žiadny kľúč/overovací kód v DB ani v reporte | PASS |

Volania poskytovateľa: organizations 201×4/200×1, enroll 201×4 / 400×3, recipient, preflight, connector/send, status, evidence, received ×7, received/xml ×1, acknowledge ×1, events ×7.

## Syntetické organizácie (provider org ID — nie sú tajomstvá)

| Firma | provider org ID | príjem | participant |
|---|---|---|---|
| A | 5766da96-01c1-4996-8ff3-8b510b500008 | active | 9915:2030998233 |
| B | 9efd2efa-0853-4e4a-aa9e-dc761db96140 | active | 9915:2075211402 |
| C | 16a88793-859e-4a16-9d98-e730f8b787d1 | failed | — |
| D | a174d08c-ed57-4773-a595-13e253394a58 | send_only | 9915:2046366685 |

(Predchádzajúce dva behy toho istého dňa, seed `e2e-ab-20261112` a `…b`, vytvorili v sandboxe ďalšie syntetické organizácie; skript nemá oprávnenie ich deaktivovať — allowlist zakazuje deactivate.)

## Nálezy živého behu

1. **Kritické (opravené): SBDH obálka.** `GET /v1/agent/peppol/received/:id/xml` vracia `sh:StandardBusinessDocument` s vnoreným UBL. Parser ho odmietal (`UBL_UNSUPPORTED_ROOT`) → v produkcii by zlyhal **každý** prijatý doklad. Oprava: originál (obálka + UBL) sa ukladá nezmenený a hashuje; parsuje sa presne jeden vnorený Invoice/CreditNote (inak `UBL_SBDH_PAYLOAD_INVALID`); DOCTYPE/ENTITY sa odmietajú aj v obálke.
2. **Recipient fail-closed rozšírený o SBDH `Receiver`** (Peppol smerovanie) popri BT-49.
3. **Replay guard 409 → 200 DUPLICATE.** Telá z feedu sa zhodujú s telami webhooku; 409 by pri udalosti už spracovanej feedom spôsobil retry a po 15 zlyhaniach deaktiváciu endpointu. Efekt ochrany je rovnaký (nič sa nespracuje ani nevolá).
4. Vnorený UBL na strane príjemcu **nie je bajtovo zhodný** s odoslaným UBL (re-serializácia na strane poskytovateľa/AP; sumy, čísla a strany sedia). „Originál“ v Esblu = presne to, čo vydal poskytovateľ príjemcovi.

## Webhook rate limit — NÁVRH (nič nenakonfigurované)

Fakty poskytovateľa: 2xx do pár sekúnd; 10 opakovaní za ~2,7 dňa (5 s, 1 min, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h, 14 h, 24 h); **15 zlyhaní po sebe → endpoint deaktivovaný**; IP rozsahy poskytovateľa nezdokumentované. Esblu má feed fallback (`/v1/agent/events`, 90 dní) každých 5 min, takže odmietnuté doručenie sa nestratí.

Návrh Vercel WAF (custom rules, iba path `/api/einvoice/webhook`):

1. **Deny** (bez rate limitu): metóda ≠ POST, alebo chýba hlavička `x-webhook-signature`, alebo `content-length` > 262144. Legitímne doručenie toto nikdy nespĺňa.
2. **Rate limit** POST: kľúč = IP, fixné okno 60 s, **600 požiadaviek / 60 s**, akcia **429** (nie challenge — server-to-server klient challenge nezvládne), bez dlhodobého blokovania.
   - Zdôvodnenie: retry rozvrh je riedky (najhustejšie 5 s → 1 min), takže retry búrku nevytvorí; limit je ~10/s na IP. Pri hromadnom rozoslaní (napr. stovky participant/received udalostí naraz) je rezerva rádovo vyššia než pilotný objem.
   - 429 je pre poskytovateľa zlyhanie → **monitoring**: alert pri prvom 429 na tejto ceste a pri `einvoice_webhook_rejections` nárastoch; ak by sa limit dosiahol legitímne, zvýšiť pred 15. zlyhaním (najkratšia cesta k 15 zlyhaniam je ~2,7 dňa pre jedno doručenie, ale počíta sa naprieč doručeniami).
3. Nezávisle od WAF: aplikácia už vracia 200 pre duplicity/neznámu org/ignorované udalosti (žiadne zbytočné failures), 401 iba pri neplatnom podpise/pečiatke.

Rozhodnutie a nasadenie pravidiel = súčasť G5, až pri produkčnej aktivácii a po schválení.
