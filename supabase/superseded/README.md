# Superseded migrácie (nikdy neaplikovať do produkcie)

| Súbor | Dôvod | Stav |
| --- | --- | --- |
| `20261121100000_retention_archive_company_termination.sql` | Zavádzala 10-ročný retenčný archív **zákazníckych** dokladov pri ukončení firmy (`esblu_retention`). Rozhodnutím GDPR 2.0 / CLIA (23. 11. 2026) nahradená migráciou `20261127100000_company_termination_customer_delete` (výmaz bez zákazníckeho archívu). Ochrana účtovných kópií Esblu (`billing_invoice_documents`, bucket `billing-documents`) je v `20261123110000` (produkcia) a v `20261127100000`/`20261128100000` — nezávisí od tejto migrácie. | Produkcia: **neaplikovaná a nebude**. Staging (`esblu-test`): aplikovaná 2026-11-19 (historicky); schéma `esblu_retention` je tam nepoužívaná. Odstránenie zo stagingu iba rollbackom `supabase/rollback/20261121100000_…` po samostatnom rozhodnutí. |

Testy: `test:p15-termination-db` overuje oba stavy (prod-like bez 20261121, staging-like s ňou);
`test:retention-archive-db` je legacy test historického stavu stagingu.
