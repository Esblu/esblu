-- 20261008100001 — triggerové funkcie z 20261008100000 nesmú byť volateľné cez PostgREST RPC.
-- EXECUTE sa pri spustení triggera nekontroluje (iba pri CREATE TRIGGER), takže triggre fungujú ďalej.
-- Rieši Supabase advisor 0028/0029 (SECURITY DEFINER funkcia volateľná anon/authenticated).

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.esblu_invoice_finalize_compliance()',
    'public.esblu_invoice_correction_event()',
    'public.esblu_block_finalized_advance_deductions()',
    'public.esblu_default_breakdown_exemption()',
    'public.esblu_block_snapshot_insert_when_finalized()',
    'public.esblu_invoice_events_append_only()',
    'public.esblu_block_payment_on_credit_note()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end
$$;
