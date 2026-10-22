# Esblu — granulárne oprávnenia členov tímu (V1, 2026-10-23)

Migrácia `20261023100000_team_granular_permissions.sql` (+ rollback). Repo + staging (`cjbdijbbcujvmrzezusd`);
**produkcia: PENDING EXPLICIT APPROVAL.** GDPR IMPACT: **NONE / ACCESS-CONTROL HARDENING**.

## 1. Audit pred zmenou

| vrstva | kde sa rozhoduje | stav pred |
|---|---|---|
| členstvo | `company_members` (id, company_id, user_id, role, status, permissions jsonb) | rola owner/admin/accountant/employee; `permissions.finance.view/manage` = jediné jemnejšie právo (finance) |
| helpery DB | `esblu_my_active_company_id()`, `esblu_my_active_role()`, `esblu_role_can_operate()`, `esblu_my_finance_view/manage()` | všetko viazané na aktívnu firmu session |
| RLS čítanie prevádzky | vozidlá/stroje/sklad/servisy/fotky/známky: `esblu_role_can_operate()` | owner/admin/employee |
| RLS zápis prevádzky | vehicles, vignettes, machines, machine_services, machine_photos, inventory_items, inventory_photos: insert/update `role in (owner, admin)` | zamestnanec nič; výnimka: `vehicle_services` insert/update a `vehicle_photos` insert = `role_can_operate` (zamestnanec áno) |
| RLS mazanie | všetky prevádzkové tabuľky | owner/admin |
| storage | `esblu_media_role_allows`: upload fotiek vozidiel owner/admin/employee, strojov a skladu owner/admin | |
| partneri/faktúry/doklady | `esblu_my_finance_view/manage`, `esblu_can_manage_document` | finance model (owner, accountant, admin s finance) |
| RPC tímu | `esblu_list_my_company_members/invites`, `esblu_create_company_invite`, `esblu_accept_company_invite` | owner/admin; účtovníka pozve iba owner |
| asistent | `lib/intents/permissions.ts` | zamestnanec iba príjem dokladu (allowlist) — bez zmeny |
| UI | stroje/sklad: `role in (owner, admin)`; vozidlá: CTA „Pridať“ podľa `canOperate` (zamestnanec ho videl, RLS ho odmietla) | |

## 2. Model

- **Register** (jediný zdroj): `public.esblu_permission_registry()`; TS zrkadlo `lib/team-permissions.ts` (parita testovaná).
  Neznáme oprávnenie = false (fail closed); tabuľka má CHECK, že sa dá uložiť iba delegovateľné oprávnenie.
- **Tabuľka** `company_member_permissions(member_id → company_members.id, company_id, permission, granted_by, granted_at)`,
  `unique(member_id, permission)`. Viazané na členstvo, nie na používateľa → firma A ≠ firma B.
  Trieda C (RPC-only, FORCE RLS, `authenticated` bez grantu, `anon` nič).
- **Audit** `company_member_permission_events` (append-only, trieda C): kto, komu, firma, oprávnenie, udelené/odobraté, čas.
- **Vyhodnotenie** `esblu_my_has_permission(p)`: owner/admin → všetky prevádzkové; employee → základ + udelené;
  accountant → žiadne prevádzkové. Vždy iba aktívna firma session a aktívne členstvo.
- **RPC**: `esblu_my_permissions()` (UI), `esblu_list_company_member_permissions()` (owner/admin),
  `esblu_set_member_permissions(member, text[])` (owner/admin; cieľ iba aktívny zamestnanec tej istej firmy, nikdy sám sebe;
  admin iba `admin_may_grant`; audit). Zmena roly / odchod člena oprávnenia zruší (trigger).

| oprávnenie | delegovateľné | admin smie | zamestnanec má vždy |
|---|---|---|---|
| vehicles.view / machines.view / inventory.view | nie | – | áno (dnešný základ) |
| vehicles.manage_service | nie | – | áno (dnešný základ: servis + fotky vozidiel) |
| vehicles.create, vehicles.edit (+ známky) | áno | áno | nie |
| machines.create, machines.edit (+ fotky), machines.manage_service | áno | áno | nie |
| inventory.create, inventory.edit (+ fotky), inventory.adjust_stock (iba množstvo; trigger) | áno | áno | nie |

**Nedelegovateľné (mimo registra = odmietnuté):** mazanie záznamov, billing/predplatné, vlastníctvo, zrušenie firmy,
správa rolí a oprávnení, eInvoice enrollment, prevádzkové/produkčné operácie.
**Mimo V1 (vedome):** doklady/Inbox, partneri, faktúry — finančný model (`permissions.finance`, účtovník) ostáva;
jemnejšie finance oprávnenia pre zamestnanca by menili `esblu_my_finance_*` a dokladové politiky → samostatný krok.

## 3. UI

Nastavenia → Používatelia → zamestnanec → **Oprávnenia** (iba owner/admin, nie pri sebe): skupiny Vozidlá / Stroje / Sklad,
vety typu „Môže pridávať stroje“, predvoľby Len čítanie / Prevádzkový pracovník / Skladník / Technik (iba zaškrtnú).
Stroje, sklad, vozidlá: CTA „Pridať“, „Upraviť“, servis a fotky podľa `esblu_my_permissions()`; mazanie owner/admin.
Pri „iba množstvo“ sú ostatné polia skladovej položky zamknuté a ukladá sa iba `quantity`.
Bez odpovede servera (DB bez migrácie) UI použije iba rolu = správanie pred zmenou, nikdy viac.

## 4. Overenie

- `test:team-permissions-db` (PGlite, čistý replay všetkých migrácií): matica A–N — 17/17.
- `test:team-permissions-ui`: preklady, UI kontrakty — 6/6.
- `test:grants-guard` 10/10, `test:grants-replay-db` 43/43 (nová fáza: migrácie po cleanup sú idempotentné a rollback → re-apply = rovnaké ACL aj politiky).
- Staging: migrácia aplikovaná; funkcie + politiky + ACL md5 == čistý replay repa; matica s QA fixtures (QA UX Firma A/B) v transakcii, ktorá sa vrátila — nič nezostalo.

## 5. Manuálny test (Preview × staging)

1. Owner (alebo admin) → Nastavenia → Používatelia → `qa-ux-employee@esblu-qa.invalid` → **Oprávnenia**.
2. Zapnúť „Môže pridávať stroje“ → Uložiť.
3. Zamestnanec: obnoviť / prihlásiť sa → Stroje → zobrazí sa „Pridať stroj“.
4. Pridať „QA UX stroj zamestnanca“ → uloží sa.
5. Owner vypne oprávnenie → Uložiť.
6. Zamestnanec obnoví → „Pridať stroj“ zmizne; priamy zápis (napr. z konzoly cez supabase-js) vráti RLS chybu.
7. Sklad: zapnúť iba „Môže meniť množstvo na sklade“ → zamestnanec pri „QA UX Skrutky A“ zmení iba množstvo
   (ostatné polia zamknuté); bez „Môže upravovať skladové položky“ zmena názvu na serveri neprejde.
