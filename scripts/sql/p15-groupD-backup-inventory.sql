-- =============================================================================
-- P1-5 skupina D, krok D-B — inventár 67 objektov Storage mimo syntetických firiem P15 (READ-ONLY).
-- Výstup (jeden JSON) uloží Claude AŽ po schválení D-B do release-backups/p15/storage-inventory-<čas>.json (mimo Git);
-- jeho SHA-256 sa uvedie v reporte a runner zálohy ho overí (presne 67, 3 buckety, bez P15, eTag = MD5).
-- Hneď po zálohe sa dotaz spustí znova: id + updated_at + eTag sa nesmú zmeniť (inak sa záloha opakuje).
-- =============================================================================
select jsonb_agg(jsonb_build_object(
         'bucket', o.bucket_id, 'name', o.name, 'id', o.id::text,
         'size', (o.metadata->>'size')::bigint, 'etag', replace(o.metadata->>'eTag', '"', ''),
         'updated_at', o.updated_at)
       order by o.bucket_id, o.name) as inventory,
       count(*) as objects,
       md5(string_agg(o.bucket_id || '|' || o.name || '|' || o.id::text || '|' || o.updated_at::text || '|' || coalesce(o.metadata->>'eTag', ''), ',' order by o.bucket_id, o.name)) as inventory_md5
from storage.objects o
where o.name not like 'f151%' and o.name not like '%f1510000-0000-4000-8000-00000000000%';
