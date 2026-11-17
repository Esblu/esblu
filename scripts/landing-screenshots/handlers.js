// Mock-backend rig pre snímky verejného webu — pozri run.sh. Syntetické údaje, žiadna DB.
const CO = 'c0ffee00-0000-4000-8000-000000000001';
const d = (days) => { const x = new Date(); x.setDate(x.getDate() + days); return x.toISOString().slice(0, 10); };
const ts = (days) => new Date(Date.now() + days * 864e5).toISOString();
const ENT = ['invoicing','einvoice','ai_documents','vehicles','machines','inventory','voice','team_members','voice_minutes','storage_mb','einvoice_transactions'];
const fixtures = {
  esblu_my_active_membership: [{ company_id: CO, role: 'owner', permissions: {}, company_name: 'Novák Stavby s. r. o.' }],
  esblu_list_my_companies: [{ company_id: CO, company_name: 'Novák Stavby s. r. o.', role: 'owner', is_active: true }],
  esblu_get_my_pending_required_acceptances: [],
  esblu_get_my_company_terms_status: [{ company_id: CO, current_terms_version: '1.2', has_current_acceptance: true, accepted_at: ts(-5), my_role: 'owner', grace_until: null, required_now: false }],
  esblu_get_my_company_dpa_status: [{ company_id: CO, current_dpa_version: '1.3', has_current_acceptance: true, accepted_at: ts(-5), my_role: 'owner' }],
  esblu_get_my_company_entitlements: { company_id: CO, trial: { started_at: ts(-4), ends_at: ts(10), active: true, ai_processing_used: 3 }, entitlements: ENT.map((key) => ({ key, active: !key.startsWith('einvoice'), source: 'trial', limit: null })) },
};
module.exports = {
  fixtures,
  handle({ method, path }) {
    const m = /^\/rest\/v1\/rpc\/(.+)$/.exec(path);
    if (m && m[1] in fixtures) return fixtures[m[1]];
    const t = /^\/rest\/v1\/([a-z_]+)$/.exec(path);
    if (t && method === 'GET' && module.exports.tables[t[1]]) return module.exports.tables[t[1]];
    return undefined;
  },
  tables: {},
};
// ---- demo tables (synthetic) ----
(() => {
  const U = '0d3f6c1e-5a1b-4c2d-9e8f-000000000001';
  const id = (p, n) => `${p}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const veh = (n, spz, znacka, model, stk, ek, year, palivo) => ({ id: id('aa', n), spz, znacka, model, stk, ek, vin: null, farba: null, objem: null, vykon: null, palivo, rok_vyroby: year, hmotnost: null, pocet_miest: null, user_id: U, company_id: CO, client_mutation_id: null, datum_prvej_evidencie: null });
  const vehicles = [
    veh(1, 'BL-482KS', 'Volkswagen', 'Crafter', d(9), d(9), 2021, 'Nafta'),
    veh(2, 'BA-913MT', 'Ford', 'Transit Custom', d(64), d(64), 2022, 'Nafta'),
    veh(3, 'TT-205DN', 'Škoda', 'Octavia Combi', d(143), d(143), 2020, 'Benzín'),
    veh(4, 'NR-771AX', 'Iveco', 'Daily 35S', d(4), d(32), 2019, 'Nafta'),
  ];
  const mach = (n, name, manufacturer, model, category, year) => ({ id: id('bb', n), name, manufacturer, model, category, year, notes: null, status: null, user_id: U, company_id: CO, created_at: ts(-30), purchase_date: null, serial_number: null, client_mutation_id: null });
  const machines = [mach(1, 'Minibager', 'Kubota', 'KX019-4', 'Stavebný stroj', 2021), mach(2, 'Vibračná doska', 'Wacker Neuson', 'DPU 2550', 'Hutnenie', 2020), mach(3, 'Miešačka', 'Atika', 'Profi 185', 'Stavebný stroj', 2022)];
  const item = (n, name, unit, quantity, min_quantity, category, location) => ({ id: id('cc', n), name, unit, quantity, min_quantity, category, location, notes: null, user_id: U, company_id: CO, created_at: ts(-20), client_mutation_id: null });
  const inventory_items = [item(1, 'Kábel CYKY 3×2,5', 'm', 140, 50, 'Elektro', 'Sklad Trnava'), item(2, 'Sadrokartón 12,5 mm', 'ks', 18, 30, 'Materiál', 'Sklad Trnava'), item(3, 'Cementová malta', 'vrece', 42, 20, 'Materiál', 'Sklad Trnava'), item(4, 'Hmoždinky 8 mm', 'bal', 9, 10, 'Spojovací materiál', 'Dodávka BL-482KS'), item(5, 'Ochranné rukavice', 'pár', 36, 12, 'OOPP', 'Sklad Trnava')];
  const vehicle_vignettes = [{ id: id('dd', 1), company_id: CO, vehicle_id: id('aa', 2), country_code: 'SK', valid_until: d(6), created_at: ts(-300), updated_at: ts(-300) }];
  const vehicle_services = [{ vehicle_id: id('aa', 1), service_date: d(-170), next_service_date: d(12) }];
  const machine_services = [{ machine_id: id('bb', 1), service_date: d(-90), next_service_date: d(3) }];
  const inv = (n, num, total, due, pay, dir = 'issued') => ({ id: id('ee', n), kind: 'invoice', direction: dir, document_status: 'finalized', payment_status: pay, total_amount: total, currency: 'EUR', due_date: due, corrects_invoice_id: null, invoice_number: num, supplier_invoice_number: dir === 'received' ? num : null, source: 'manual', correction_review_status: null, advance_review_status: null });
  const invoices = [inv(1, '2026110004', 2480.0, d(-3), 'unpaid'), inv(2, '2026110005', 1260.5, d(11), 'unpaid'), inv(3, '2026110003', 890.0, d(-12), 'paid'), inv(4, 'FA-88213', 412.8, d(2), 'unpaid', 'received')];
  const company_billing_profile = [{ company_id: CO, legal_name: 'Novák Stavby s. r. o.', ico: '55512345', dic: '2121234567', ic_dph: null, city: 'Trnava', postal_code: '91701', country_code: 'SK', address_line1: 'Hlavná 12', address_line2: null, iban: null, bic: null, logo_path: null, contact_email: null, vat_identifier: null, default_currency: 'EUR', default_due_days: 14, default_vat_rate: null, vat_payer_status: 'non_vat_payer', electronic_address: null, generic_identifier: null, legal_registration_id: null, invoice_numbering_prefix: null, electronic_address_scheme_id: null, generic_identifier_scheme_id: null, legal_registration_scheme_id: null, created_at: ts(-5), updated_at: null, updated_by: null }];
  module.exports.tables = { vehicles, machines, inventory_items, vehicle_vignettes, vehicle_services, machine_services, invoices, company_billing_profile, documents: [], business_partners: [] };
  Object.assign(fixtures, {
    esblu_get_my_unread_counts: [],
    esblu_get_company_profile: [{ company_id: CO, company_name: 'Novák Stavby s. r. o.' }],
    esblu_list_my_company_members: [],
    esblu_list_my_company_invites: [],
    esblu_media_deletion_sweep: 0,
  });
})();
