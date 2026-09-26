#!/usr/bin/env bash
# =============================================================================
# Skutočná súbežnosť (2 spojenia naraz) — IBA lokálny PostgreSQL s aplikovaným
# baseline + migráciou 20260928100000. Nikdy nie proti produkcii.
#
#   PSQL="psql -h /tmp/pgdata -U postgres -d ent" bash scripts/sql/entitlements-concurrency-local.sh
#
# Každý prípad: firma má voľné presne 1 miesto; dve spojenia súčasne skúsia
# obsadiť posledné miesto a v transakcii počkajú (pg_sleep), kým commitnú.
# Očakávanie: presne jedno uspeje, druhé dostane ENTITLEMENT_DENIED.
# =============================================================================
set -u
PSQL=${PSQL:-psql}
fails=0

setup() {
  $PSQL -q -v ON_ERROR_STOP=1 <<'SQL'
delete from public.ai_processing_usage where company_id in (select id from public.companies where name like 'CONC %');
delete from public.company_invites where company_id in (select id from public.companies where name like 'CONC %');
delete from public.inventory_items where company_id in (select id from public.companies where name like 'CONC %');
delete from public.company_dpa_acceptances where company_id in (select id from public.companies where name like 'CONC %');
delete from public.company_entitlements where company_id in (select id from public.companies where name like 'CONC %');
delete from public.company_members where company_id in (select id from public.companies where name like 'CONC %');
delete from public.companies where name like 'CONC %';
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000c0001', 'conc-owner@example.invalid') on conflict do nothing;
insert into public.companies (id, owner_id, name) values ('00000000-0000-0000-0000-0000000cc001', '00000000-0000-0000-0000-0000000c0001', 'CONC trial');
insert into public.company_members (company_id, user_id, role, status) values ('00000000-0000-0000-0000-0000000cc001', '00000000-0000-0000-0000-0000000c0001', 'owner', 'active');
insert into public.company_dpa_acceptances (company_id, version, accepted_by, acceptance_method)
select '00000000-0000-0000-0000-0000000cc001', version, '00000000-0000-0000-0000-0000000c0001', 'company_dpa_gate'
from public.legal_documents where type = 'dpa' order by effective_at desc limit 1;
-- team limit 2 → owner + presne 1 voľné miesto
insert into public.company_entitlements (company_id, entitlement_key, source, limit_value) values ('00000000-0000-0000-0000-0000000cc001', 'team_members', 'manual', 2);
-- inventory: 4 z 5
insert into public.inventory_items (company_id, user_id, name) select '00000000-0000-0000-0000-0000000cc001', '00000000-0000-0000-0000-0000000c0001', 'seed ' || g from generate_series(1, 4) g;
SQL
}

run_pair() {  # $1 = label, $2/$3 = SQL for session A/B
  local out_a out_b
  out_a=$(mktemp); out_b=$(mktemp)
  $PSQL -q -X -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-0000-0000-0000000c0001\",\"role\":\"authenticated\"}', true); set local role authenticated; $2; select pg_sleep(1.5); commit;" >"$out_a" 2>&1 &
  local pa=$!
  sleep 0.3
  $PSQL -q -X -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-0000-0000-0000000c0001\",\"role\":\"authenticated\"}', true); set local role authenticated; $3; commit;" >"$out_b" 2>&1 &
  local pb=$!
  wait $pa $pb
  local denied
  denied=$(cat "$out_a" "$out_b" | grep -c "ENTITLEMENT_DENIED")
  if [ "$denied" = "1" ]; then echo "ok   $1 (exactly one denied)"; else echo "FAIL $1 (denied=$denied)"; cat "$out_a" "$out_b"; fails=$((fails+1)); fi
  rm -f "$out_a" "$out_b"
}

setup
run_pair "9 two concurrent invites for the last seat" \
  "select * from public.esblu_create_company_invite('conc-a@example.invalid', 'employee')" \
  "select * from public.esblu_create_company_invite('conc-b@example.invalid', 'employee')"

run_pair "inventory #5/#6 concurrently" \
  "insert into public.inventory_items (company_id, user_id, name) values ('00000000-0000-0000-0000-0000000cc001', '00000000-0000-0000-0000-0000000c0001', 'race A')" \
  "insert into public.inventory_items (company_id, user_id, name) values ('00000000-0000-0000-0000-0000000cc001', '00000000-0000-0000-0000-0000000c0001', 'race B')"

# AI: 4 z 5 trial spracovaní použitých, potom #5 a #6 naraz.
$PSQL -q -X -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-0000-0000-0000000c0001\",\"role\":\"authenticated\"}', true); set local role authenticated; select public.esblu_reserve_ai_processing('scan-document', 'conc-seed-' || g || '-000000000', repeat('c', 64)) from generate_series(1, 4) g; commit;" >/dev/null
run_pair "AI processing #5/#6 concurrently" \
  "select public.esblu_reserve_ai_processing('scan-document', 'conc-race-A-0000000000', repeat('d', 64))" \
  "select public.esblu_reserve_ai_processing('scan-document', 'conc-race-B-0000000000', repeat('e', 64))"

total=$($PSQL -At -c "select count(*) from public.ai_processing_usage where company_id = '00000000-0000-0000-0000-0000000cc001' and status in ('reserved','succeeded')")
if [ "$total" = "5" ]; then echo "ok   AI ledger never exceeds 5 ($total)"; else echo "FAIL AI ledger = $total"; fails=$((fails+1)); fi

echo "concurrency failures: $fails"
exit $fails
