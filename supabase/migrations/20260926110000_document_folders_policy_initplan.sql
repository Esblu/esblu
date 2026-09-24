-- =============================================================================
-- Priečinky dokladov: auth.uid() v politikách raz za dotaz, nie za riadok.
--
-- Performance advisor (auth_rls_initplan) upozornil, že INSERT politiky z
-- 20260926100000 volajú auth.uid() pre každý riadok. Pri hromadnom pridaní
-- (stovky dokladov do priečinka) je to zbytočná práca. `(select auth.uid())`
-- sa vyhodnotí raz. Význam politík sa NEMENÍ — iba spôsob vyhodnotenia.
-- =============================================================================

drop policy if exists document_folders_insert on public.document_folders;
create policy document_folders_insert on public.document_folders
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and created_by = (select auth.uid())
  );

drop policy if exists document_folder_items_insert on public.document_folder_items;
create policy document_folder_items_insert on public.document_folder_items
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.document_folders f
      where f.id = document_folder_items.folder_id
        and f.company_id = public.esblu_my_active_company_id()
    )
    and (
      (
        entity_type = 'invoice'
        and exists (
          select 1 from public.invoices i
          where i.id = document_folder_items.invoice_id
            and i.company_id = public.esblu_my_active_company_id()
        )
      )
      or (
        entity_type = 'document'
        and exists (
          select 1 from public.documents d
          where d.id = document_folder_items.document_id
            and d.company_id = public.esblu_my_active_company_id()
            and d.deleted_at is null
            and d.document_type in ('receipt', 'invoice', 'delivery_note', 'service_document', 'other')
            and public.esblu_can_read_document(d.id)
        )
      )
    )
  );

drop policy if exists document_export_packages_insert on public.document_export_packages;
create policy document_export_packages_insert on public.document_export_packages
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and created_by = (select auth.uid())
    and (
      folder_id is null
      or exists (
        select 1 from public.document_folders f
        where f.id = document_export_packages.folder_id
          and f.company_id = public.esblu_my_active_company_id()
      )
    )
  );

drop policy if exists document_export_package_items_insert on public.document_export_package_items;
create policy document_export_package_items_insert on public.document_export_package_items
  for insert to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and exists (
      select 1 from public.document_export_packages p
      where p.id = document_export_package_items.package_id
        and p.company_id = public.esblu_my_active_company_id()
        and p.created_by = (select auth.uid())
        and p.created_at > now() - interval '15 minutes'
    )
    and (
      (
        entity_type = 'invoice'
        and invoice_id = entity_ref
        and document_id is null
        and exists (
          select 1 from public.invoices i
          where i.id = document_export_package_items.invoice_id
            and i.company_id = public.esblu_my_active_company_id()
        )
      )
      or (
        entity_type = 'document'
        and document_id = entity_ref
        and invoice_id is null
        and exists (
          select 1 from public.documents d
          where d.id = document_export_package_items.document_id
            and d.company_id = public.esblu_my_active_company_id()
            and public.esblu_can_read_document(d.id)
        )
      )
    )
  );
