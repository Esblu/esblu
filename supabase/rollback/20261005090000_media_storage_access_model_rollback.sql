-- =============================================================================
-- ROLLBACK pre 20261005090000_media_storage_access_model.sql
-- (ak bola aplikovaná aj 20261005091000, tento súbor vráti aj public = true)
--
-- Vráti PRESNE produkčný stav zo 4. 10. 2026 (pg_policies + storage.buckets):
--   - buckety vehicle-photos, machine-photos, inventory-photos, company-logos
--     znova `public = true` (POZOR: znova otvorí anonymný prístup cez verejný
--     endpoint — použiť iba pri vážnej poruche),
--   - všetkých 15 pôvodných storage politík týchto bucketov doslovne z prod,
--   - odstráni nové politiky, triggre, funkcie a tabuľku media_deletion_queue.
-- Pôvodné funkcie esblu_can_delete_*_photo_object a
-- esblu_can_manage_company_logo_object migrácia nemenila — ostávajú.
-- Žiadne súbory ani dáta modulov sa nemenia. Záznamy vo fronte mazania sa
-- stratia (pred rollbackom ich možno exportovať, ak treba).
-- POUŽITIE: iba po výslovnom schválení cez Supabase MCP.
-- =============================================================================

update storage.buckets
   set public = true
 where id in ('vehicle-photos', 'machine-photos', 'inventory-photos', 'company-logos');

drop policy if exists media_select_scoped on storage.objects;
drop policy if exists media_insert_scoped on storage.objects;
drop policy if exists media_delete_scoped on storage.objects;

drop trigger if exists esblu_media_deletion_vehicle_photos on public.vehicle_photos;
drop trigger if exists esblu_media_deletion_machine_photos on public.machine_photos;
drop trigger if exists esblu_media_deletion_inventory_photos on public.inventory_photos;
drop trigger if exists esblu_media_deletion_company_logo on public.company_billing_profile;

drop function if exists public.esblu_media_deletion_sweep(integer);
drop function if exists public.esblu_enqueue_media_deletion();
drop function if exists public.esblu_can_delete_media_object(text, text);
drop function if exists public.esblu_can_upload_media_object(text, text);
drop function if exists public.esblu_can_read_media_object(text, text);
drop function if exists public.esblu_media_role_allows(text, text);
drop function if exists public.esblu_media_object_owner(text, text);
drop function if exists public.esblu_media_deletion_pending_company(text, text);
drop table if exists public.media_deletion_queue;

-- Pôvodné politiky (doslovne z pg_policies, prod 2026-10-04) -------------------
drop policy if exists vehicle_photos_select_company on storage.objects;
drop policy if exists vehicle_photos_insert_active_member on storage.objects;
drop policy if exists vehicle_photos_delete_owner_admin on storage.objects;
drop policy if exists machine_photos_select_company on storage.objects;
drop policy if exists machine_photos_insert_own on storage.objects;
drop policy if exists machine_photos_update_own on storage.objects;
drop policy if exists machine_photos_delete_company on storage.objects;
drop policy if exists inventory_photos_select_company on storage.objects;
drop policy if exists "Users can upload inventory photos" on storage.objects;
drop policy if exists "Users can update inventory photos" on storage.objects;
drop policy if exists inventory_photos_delete_company on storage.objects;
drop policy if exists company_logos_select_company on storage.objects;
drop policy if exists company_logos_insert_owner_admin on storage.objects;
drop policy if exists company_logos_update_owner_admin on storage.objects;
drop policy if exists company_logos_delete_owner_admin on storage.objects;

create policy vehicle_photos_select_company on storage.objects for select to authenticated
  using ((bucket_id = 'vehicle-photos'::text) AND (EXISTS ( SELECT 1
     FROM (public.company_members caller_cm
       JOIN public.company_members owner_cm ON (((owner_cm.company_id = caller_cm.company_id) AND (owner_cm.status = 'active'::text))))
    WHERE ((caller_cm.user_id = auth.uid()) AND (caller_cm.status = 'active'::text) AND ((owner_cm.user_id)::text = (storage.foldername(objects.name))[1])))));

create policy vehicle_photos_insert_active_member on storage.objects for insert to authenticated
  with check ((bucket_id = 'vehicle-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text) AND (EXISTS ( SELECT 1
     FROM (public.vehicles v
       JOIN public.company_members cm ON ((cm.company_id = v.company_id)))
    WHERE (((v.id)::text = (storage.foldername(objects.name))[2]) AND (cm.user_id = auth.uid()) AND (cm.status = 'active'::text)))));

create policy vehicle_photos_delete_owner_admin on storage.objects for delete to authenticated
  using ((bucket_id = 'vehicle-photos'::text) AND public.esblu_can_delete_vehicle_photo_object(name));

create policy machine_photos_select_company on storage.objects for select to authenticated
  using ((bucket_id = 'machine-photos'::text) AND (EXISTS ( SELECT 1
     FROM (public.company_members caller_cm
       JOIN public.company_members owner_cm ON (((owner_cm.company_id = caller_cm.company_id) AND (owner_cm.status = 'active'::text))))
    WHERE ((caller_cm.user_id = auth.uid()) AND (caller_cm.status = 'active'::text) AND ((owner_cm.user_id)::text = (storage.foldername(objects.name))[1])))));

create policy machine_photos_insert_own on storage.objects for insert to authenticated
  with check ((bucket_id = 'machine-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text));

create policy machine_photos_update_own on storage.objects for update to authenticated
  using ((bucket_id = 'machine-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text))
  with check ((bucket_id = 'machine-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text));

create policy machine_photos_delete_company on storage.objects for delete to authenticated
  using ((bucket_id = 'machine-photos'::text) AND public.esblu_can_delete_machine_photo_object(name));

create policy inventory_photos_select_company on storage.objects for select to authenticated
  using ((bucket_id = 'inventory-photos'::text) AND (EXISTS ( SELECT 1
     FROM (public.company_members caller_cm
       JOIN public.company_members owner_cm ON (((owner_cm.company_id = caller_cm.company_id) AND (owner_cm.status = 'active'::text))))
    WHERE ((caller_cm.user_id = auth.uid()) AND (caller_cm.status = 'active'::text) AND ((owner_cm.user_id)::text = (storage.foldername(objects.name))[1])))));

create policy "Users can upload inventory photos" on storage.objects for insert to authenticated
  with check ((bucket_id = 'inventory-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text));

create policy "Users can update inventory photos" on storage.objects for update to authenticated
  using ((bucket_id = 'inventory-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text))
  with check ((bucket_id = 'inventory-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text));

create policy inventory_photos_delete_company on storage.objects for delete to authenticated
  using ((bucket_id = 'inventory-photos'::text) AND public.esblu_can_delete_inventory_photo_object(name));

create policy company_logos_select_company on storage.objects for select to authenticated
  using ((bucket_id = 'company-logos'::text) AND (EXISTS ( SELECT 1
     FROM (public.company_members caller_cm
       JOIN public.company_members owner_cm ON (((owner_cm.company_id = caller_cm.company_id) AND (owner_cm.status = 'active'::text))))
    WHERE ((caller_cm.user_id = auth.uid()) AND (caller_cm.status = 'active'::text) AND ((owner_cm.user_id)::text = (storage.foldername(objects.name))[1])))));

create policy company_logos_insert_owner_admin on storage.objects for insert to authenticated
  with check ((bucket_id = 'company-logos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text) AND (EXISTS ( SELECT 1
     FROM public.company_members cm
    WHERE ((cm.user_id = auth.uid()) AND (cm.status = 'active'::text) AND (cm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

create policy company_logos_update_owner_admin on storage.objects for update to authenticated
  using ((bucket_id = 'company-logos'::text) AND (EXISTS ( SELECT 1
     FROM (public.company_members caller_cm
       JOIN public.company_members owner_cm ON (((owner_cm.company_id = caller_cm.company_id) AND (owner_cm.status = 'active'::text))))
    WHERE ((caller_cm.user_id = auth.uid()) AND (caller_cm.status = 'active'::text) AND (caller_cm.role = ANY (ARRAY['owner'::text, 'admin'::text])) AND ((owner_cm.user_id)::text = (storage.foldername(objects.name))[1])))))
  with check ((bucket_id = 'company-logos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text) AND (EXISTS ( SELECT 1
     FROM public.company_members cm
    WHERE ((cm.user_id = auth.uid()) AND (cm.status = 'active'::text) AND (cm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

create policy company_logos_delete_owner_admin on storage.objects for delete to authenticated
  using ((bucket_id = 'company-logos'::text) AND public.esblu_can_manage_company_logo_object(name));
