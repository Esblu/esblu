-- FÁZA 3B — EN16931 / eFaktúra canonical model audit — P0 schema hardening
-- Two minimal, additive, nullable, expand-only columns. No default, no
-- backfill, no rewrite of finalized invoices, no RPC/UI changes in this
-- migration. See docs/invoicing-en16931-gap-analysis-2026-09.md §13.
--
-- 1) invoice_items.unit_code — canonical UN/ECE Recommendation 20/21 unit
--    of measure code, required alongside the existing free-text `unit`
--    display label for EN16931/UBL line-level unit-of-measure semantics
--    (BT-130-equivalent). Existing free-text `unit` is left untouched.
ALTER TABLE public.invoice_items
  ADD COLUMN unit_code text;

COMMENT ON COLUMN public.invoice_items.unit_code IS
  'Canonical UN/ECE Recommendation 20/21 unit-of-measure code (e.g. HUR, MTQ, KGM) for EN16931/Peppol export. Nullable/expand-only; distinct from the free-text unit display label. Never auto-backfilled from unit.';

-- 2) invoice_tax_breakdowns.vat_exemption_reason_code /
--    vat_exemption_reason_text — required for VAT categories E and AE per
--    the official VATEX code list and EN16931 rules BR-E-10 / BR-AE-10.
--    Category-conditional: only meaningful when vat_category_code IN
--    ('E','AE'); enforced at a future validation layer, not by a DB CHECK
--    in this migration (no country-specific default/text is hardcoded).
ALTER TABLE public.invoice_tax_breakdowns
  ADD COLUMN vat_exemption_reason_code text;

ALTER TABLE public.invoice_tax_breakdowns
  ADD COLUMN vat_exemption_reason_text text;

COMMENT ON COLUMN public.invoice_tax_breakdowns.vat_exemption_reason_code IS
  'VATEX code list identifier (e.g. VATEX-EU-AE) for VAT category E/AE breakdowns, per EN16931 BR-E-10/BR-AE-10. Nullable/expand-only; not country-specific; no default.';

COMMENT ON COLUMN public.invoice_tax_breakdowns.vat_exemption_reason_text IS
  'Free-text VAT exemption/reverse-charge reason accompanying vat_exemption_reason_code. Nullable/expand-only; no hardcoded country-specific text.';
