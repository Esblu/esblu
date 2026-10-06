-- 20261008100006 — odoslanie faktúry k prijatej platbe (záloha, UBL InvoiceTypeCode 386) ako e-faktúry.
-- Staging E2E (6. 10. 2026) odhalil: UBL generátor 386 podporuje, ale esblu_einvoice_request_outbound
-- (20261002140000) povoľoval iba regular_invoice / credit_note / debit_note → ESBLU_EINVOICE_KIND_UNSUPPORTED.
-- § 85o ods. 2 zákona o DPH: povinná e-faktúra aj pri prijatej platbe. Proforma ostáva vylúčená (nie je faktúra).
-- Zmena: iba zoznam povolených druhov (server-side úprava aktuálnej definície každého preťaženia,
-- zvyšok tela bez zmeny). Idempotentné.
do $patch$
declare
  r record;
  a text := $$v_inv.kind not in ('regular_invoice', 'credit_note', 'debit_note')$$;
  b text := $$v_inv.kind not in ('regular_invoice', 'payment_received_invoice', 'credit_note', 'debit_note')$$;
  v_seen integer := 0;
  d text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'esblu_einvoice_request_outbound'
  loop
    d := pg_get_functiondef(r.oid);
    if position(a in d) > 0 then
      execute replace(d, a, b);
      v_seen := v_seen + 1;
    elsif position(b in d) > 0 then
      v_seen := v_seen + 1;
    end if;
  end loop;
  if v_seen = 0 then
    raise exception 'OUTBOUND_KIND_ANCHOR_MISSING';
  end if;
end
$patch$;
