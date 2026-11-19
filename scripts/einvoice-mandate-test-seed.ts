// =============================================================================
// Testy (PGlite): účinný mandát 'send'+'receive' pre každú registrovanú organizáciu,
// ktorá ho ešte nemá. Používajú ho staršie E-Faktúra sady, ktoré testujú iné vrstvy
// (outbound / ops / inbound / partner / sandbox selftest) — od 20261122100000 sa bez
// mandátu nič neodošle. Append-only guard sa obíde IBA cez session_replication_role
// (superuser v teste); produkčný kód mandát zapisuje výhradne cez RPC.
// =============================================================================

export const EINVOICE_MANDATE_MIGRATION = "20261122100000_einvoice_mandates.sql";

export const SEED_EFFECTIVE_MANDATES_SQL = `
  set session_replication_role = replica;
  insert into public.einvoice_mandates (
    company_id, provider, environment, scope, granted_by_user_id, granted_by_role,
    statement_version, statement_sha256, statement_locale, authority_confirmed, grant_channel,
    provider_org_id, effective_at, effective_scope, provider_outcome
  )
  select o.company_id, o.provider, o.environment, '{send,receive}', '00000000-0000-4000-8000-000000000000', 'owner',
         'test-seed', repeat('0', 64), 'sk', true, 'operator_backfill',
         o.provider_org_id, now() - interval '1 minute', '{send,receive}', 'TEST_SEED'
  from public.einvoice_organizations o
  where o.provider_org_id is not null
    and not exists (select 1 from public.einvoice_mandates m
                    where m.company_id = o.company_id and m.environment = o.environment
                      and m.effective_at is not null and m.revoked_at is null);
  set session_replication_role = origin;
`;
