-- =============================================================================
-- M1 authz (2026-09-28) — ai_evidence INSERT podľa roly a tvaru
-- NEAPLIKOVANÉ. Aplikovať iba cez MCP apply_migration po výslovnom schválení
-- (assetpilot / fkpgvgvsmbpieduoatrt). Nikdy nie `supabase db push`.
-- ZÁVISLOSŤ: stĺpce content_sha256 / intake_attestation pridáva 20260930125000.
-- PORADIE: až po 20260930125000 (RPC), Vault kľúči, env a nasadení kódu
-- app/api/inbox/intake/route.ts (INSERT dodacieho listu bez údajov +
-- podpísané RPC). Starý kód vkladá dodací list s údajmi → táto politika by
-- ho odmietla.
--
-- PRED (prod katalóg 2026-09-28):
--   ai_evidence_insert_operational  TO authenticated
--     WITH CHECK (company_id = esblu_my_active_company_id() AND esblu_role_can_operate())
--   BEFORE INSERT triggre: esblu_enforce_plan_limit (user_id MUSÍ byť
--   auth.uid(), company_id prepíše na aktívnu firmu, vyžaduje modul),
--   esblu_require_company_dpa_current.
--   UPDATE/DELETE: owner/admin; dodací list iba s finance.manage.
--   → Zamestnanec (aj admin bez financií) teda priamo cez PostgREST vložil
--     dodací list s ĽUBOVOĽNÝMI údajmi (dodávateľ, odberateľ, množstvá,
--     brutto/tara/netto, dátum, raw_text, confidence_score), ľubovoľným
--     review_status (aj „confirmed"), ľubovoľným vehicle_id / machine_id
--     (aj UUID vozidla cudzej firmy — FK to pustí; chyba FK navyše prezradí,
--     či UUID existuje), ľubovoľným photo_url (aj cesta k cudziemu súboru —
--     esblu_can_read_ai_evidence_object potom sprístupní súbor, ktorý
--     nereferencuje žiadny iný riadok), deleted_at a spätným created_at.
--   Impersonácia (user_id) a iná firma boli už zablokované triggrom.
--
-- PO (M1 produktová korekcia — uploader vždy dokončí review svojho dokladu):
-- spoločný základ pre KAŽDÚ rolu
--   company_id = aktívna firma, user_id = auth.uid(), prevádzková rola,
--   deleted_at NULL, created_at = teraz (−5 min … +1 min), photo_url NULL
--   alebo vlastný priečinok, vehicle_id / machine_id NULL alebo entita
--   VLASTNEJ firmy, evidence_kind povinné,
-- a práve jedna vetva:
--   W) VÁŽNY LÍSTOK S ÚDAJMI — owner/admin: ich kontrola vo formulári je
--      potvrdením (review_status aj 'confirmed').
--   D) DODACÍ LIST S ÚDAJMI — finance.manage (owner, admin s finance.manage).
--   I) PRÍJEM (dodací list ALEBO vážny lístok) — každá prevádzková rola:
--      review_status = 'needs_review', photo_url povinné, VŠETKY údaje NULL.
--      Ďalej iba: esblu_attach_evidence_intake_extraction (podpis servera,
--      needs_review → extracted) a esblu_confirm_evidence_intake (uploader
--      opraví/doplní/potvrdí, extracted → confirmed, audit po poliach).
-- Zamestnanec teda priamym INSERT-om nevytvorí nič okrem prázdneho príjmu a
-- priamym UPDATE-om nič nezmení (UPDATE politika sa nemení: owner/admin,
-- dodací list iba finance.manage). Potvrdený dodací list po potvrdení NEVIDÍ
-- (SELECT: dodací list iba finance_view) — potvrdenie nerozširuje čítanie.
-- Účtovník do ai_evidence nevkladá (ako doteraz — nie je prevádzková rola).
--
-- ROLLBACK:
--   drop policy if exists ai_evidence_insert_scoped on public.ai_evidence;
--   create policy ai_evidence_insert_operational on public.ai_evidence
--     for insert to authenticated
--     with check (company_id = public.esblu_my_active_company_id() and public.esblu_role_can_operate());
-- =============================================================================

begin;

drop policy if exists ai_evidence_insert_operational on public.ai_evidence;
drop policy if exists ai_evidence_insert_scoped on public.ai_evidence;

create policy ai_evidence_insert_scoped
  on public.ai_evidence
  for insert
  to authenticated
  with check (
    company_id = public.esblu_my_active_company_id()
    and user_id = (select auth.uid())
    and public.esblu_role_can_operate()
    and deleted_at is null
    and created_at >= now() - interval '5 minutes'
    and created_at <= now() + interval '1 minute'
    and (photo_url is null or split_part(photo_url, '/', 1) = (select auth.uid())::text)
    and (
      vehicle_id is null
      or exists (select 1 from public.vehicles v where v.id = ai_evidence.vehicle_id and v.company_id = public.esblu_my_active_company_id())
    )
    and (
      machine_id is null
      or exists (select 1 from public.machines m where m.id = ai_evidence.machine_id and m.company_id = public.esblu_my_active_company_id())
    )
    and evidence_kind is not null
    -- atestáciu originálu zapisuje iba podpísané RPC, nikdy INSERT
    and intake_attestation is null
    and (
      -- W) vážny lístok s údajmi — owner/admin (ich vlastná kontrola pri uložení)
      (
        evidence_kind = 'weigh_ticket'
        and (select public.esblu_my_active_role()) = any (array['owner'::text, 'admin'::text])
        and review_status = any (array['pending'::text, 'needs_review'::text, 'confirmed_candidate'::text, 'confirmed'::text])
      )
      -- D) dodací list s údajmi — iba finance.manage (owner, admin s finance.manage)
      or (
        evidence_kind = 'delivery_note'
        and public.esblu_my_finance_manage()
        and review_status = any (array['pending'::text, 'needs_review'::text, 'confirmed_candidate'::text, 'confirmed'::text])
      )
      -- I) príjem (dodací list alebo vážny lístok) — počiatočný tvar bez údajov.
      --    Každá prevádzková rola; zamestnanec INAK nevloží nič.
      or (
        evidence_kind = any (array['delivery_note'::text, 'weigh_ticket'::text])
        and review_status = 'needs_review'
        and photo_url is not null
        -- hash originálu je povinný: atestácia a potvrdenie sa naň viažu
        and content_sha256 is not null
        and (
          (evidence_kind = 'delivery_note' and (document_type is null or public.esblu_evidence_is_delivery_note(null, document_type)))
          or (evidence_kind = 'weigh_ticket' and (document_type is null or not public.esblu_evidence_is_delivery_note(null, document_type)))
        )
        and vehicle_id is null and machine_id is null and machine_label is null and movement_type is null
        and spz is null and supplier is null and customer is null and construction_site is null
        and document_number is null and material is null and material_original is null and material_category is null
        and quantity is null and unit is null and brutto is null and tara is null and netto is null
        and document_date is null and document_time is null
        and source_location is null and destination_location is null
        and document_language is null and confidence_score is null and raw_text is null
      )
    )
  );

commit;
