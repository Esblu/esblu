-- =============================================================================
-- ROLLBACK pre 20261005091000_private_media_buckets.sql
-- Vráti buckety médií na verejné (produkčný stav pred 2026-10-05). POZOR:
-- znova otvorí anonymný prístup cez verejný endpoint. Prístupový model
-- (20261005090000) ostáva. Použiť iba pri vážnej poruche zobrazovania.
-- =============================================================================

update storage.buckets
   set public = true
 where id in ('vehicle-photos', 'machine-photos', 'inventory-photos', 'company-logos');
