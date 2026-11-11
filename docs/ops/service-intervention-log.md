# Evidencia servisných zásahov (produkcia)

Účel: preukázateľnosť zásahov do produkčných systémov podľa odporúčania CLIA (11.11.2026), Smernice čl. 6.3.2 a
9.2.2 a `docs/ai-dev-tool-access-policy.md`. **Do záznamu sa nepíšu osobné údaje** (ani e-maily, mená, obsah) —
iba systém, rozsah, účel a výsledok. Záznam je append-only (git história). Uchovávanie: najviac 12 mesiacov od
zásahu (Smernica 11.3 — administrátorské prístupy a zásahy); staršie riadky presunie vlastník do internej
GDPR zložky alebo odstráni.

Polia: dátum a čas (UTC) · osoba / nástroj · systém · dôvod · rozsah (čítanie/zápis, objekty) · prístup k osobným
údajom (nie / agregáty / riadky) · výsledok · súhlas vlastníka.

| dátum a čas (UTC) | osoba / nástroj | systém | dôvod | rozsah | prístup k OÚ | výsledok | súhlas |
|---|---|---|---|---|---|---|---|
| 2026-10-25 | Claude (Cowork) pre vlastníka | Supabase `assetpilot` (prod) | J9 produkčný precheck migrácií | read-only transakcia, schéma + počty | nie (iba metadáta/počty) | precheck PASS | áno (J9) |
| 2026-11-10 17:4x | Claude (Cowork) pre vlastníka | Supabase org (zoznam projektov), Vercel `esblu` (projekt) | J10 audit regiónov | read-only metadáta (región, konfigurácia) | nie | eu-central-1 / fra1 potvrdené | áno (J10 zadanie) |
| 2026-11-11 | Claude (Cowork) pre vlastníka | Supabase `assetpilot` (prod) | J10.1 GDPR retention precheck (`scripts/sql/prod-gdpr-retention-precheck.sql`) | read-only transakcia, iba agregáty (počty, min/max čas) | agregáty, žiadne riadky | pozri J10.1 v checkliste | áno (J10.1 zadanie) |
