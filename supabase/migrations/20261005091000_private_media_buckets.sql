-- =============================================================================
-- Médiá firmy: prepnutie bucketov na súkromné.
--
-- STAV: NAVRHNUTÉ, NEAPLIKOVANÉ. Aplikovať iba po výslovnom schválení cez
-- Supabase MCP apply_migration. NIKDY db push.
-- PREDPOKLADY (v tomto poradí):
--   1) aplikovaná 20261005090000_media_storage_access_model.sql,
--   2) nasadená appka, ktorá zobrazuje médiá cez podpísané URL
--      (lib/storage/signed-media.ts) — inak by sa obrázky prestali zobrazovať.
-- Rollback: supabase/rollback/20261005091000_private_media_buckets_rollback.sql
-- Súbory sa nemenia ani nemažú. Verejný endpoint prestane súbory vydávať;
-- Supabase CDN môže už stiahnuté odpovede držať ešte do 1 h (cacheControl 3600).
-- IDEMPOTENTNÉ.
-- =============================================================================

update storage.buckets
   set public = false
 where id in ('vehicle-photos', 'machine-photos', 'inventory-photos', 'company-logos');
