import { supabase } from "@/lib/supabase";

export type CompanyMemberRole = "owner" | "admin" | "accountant" | "employee";
export type CompanyInviteRole = "admin" | "accountant" | "employee";
export type CompanyInviteStatus = "pending" | "accepted" | "revoked" | "expired";

export type EnsureOwnerCompanyResult = {
  company_id: string;
  role: CompanyMemberRole;
  created: boolean;
};

export type CompanyMemberRow = {
  member_id: string;
  user_id: string;
  email: string;
  role: CompanyMemberRole;
  status: string;
  created_at: string;
};

// Finance Access Hardening — namespaced kľúče v company_members.permissions
// jsonb (stĺpec existuje od Fázy 1B, prvá reálna konvencia zavedená touto
// migráciou; pozri supabase/migrations/20260916140000_finance_access_
// hardening.sql). "manage" implikuje "view" (rovnako ako na DB strane v
// esblu_my_finance_view()/...manage()) — hasFinanceManage() teda netreba
// kontrolovať popri hasFinanceView().
export type FinancePermissions = {
  view?: boolean;
  manage?: boolean;
};

export type MemberPermissions = {
  finance?: FinancePermissions;
};

export type MyActiveMembership = {
  company_id: string;
  role: CompanyMemberRole;
  permissions: MemberPermissions;
};

/**
 * Smie ČÍTAŤ finančné/billing dáta (company_billing_profile,
 * business_partners, billing polia v Nastaveniach)? Owner vždy, inak iba
 * explicitné permissions.finance.view/manage. role==='admin' SAMA OSEBE
 * NESTAČÍ — toto je vedomé rozhodnutie (Finance Access Hardening), nie
 * dočasný stav. Toto je iba UI vrstva (čo zobraziť/skryť) — skutočná
 * autorizácia je vynútená RLS cez esblu_my_finance_view() na strane DB.
 */
type FinanceCheckInput = {
  role: CompanyMemberRole | null;
  permissions: MemberPermissions;
};

export function hasFinanceView(membership: FinanceCheckInput | null | undefined): boolean {
  if (!membership) return false;
  // Zamestnanec financie nemá NIKDY — ani keby mu v permissions niečo
  // zostalo. Rovnaké poradie vetiev ako v esblu_my_finance_view().
  if (membership.role === "employee") return false;
  if (membership.role === "owner" || membership.role === "accountant") return true;
  return Boolean(membership.permissions?.finance?.view || membership.permissions?.finance?.manage);
}

/**
 * Smie ZAPISOVAŤ (create/update/delete) finančné/billing dáta? Owner
 * vždy, inak iba explicitné permissions.finance.manage. Rovnako iba UI
 * vrstva — reálne vynútenie je esblu_my_finance_manage() v RLS.
 */
export function hasFinanceManage(membership: FinanceCheckInput | null | undefined): boolean {
  if (!membership) return false;
  if (membership.role === "employee") return false;
  if (membership.role === "owner" || membership.role === "accountant") return true;
  return Boolean(membership.permissions?.finance?.manage);
}

/**
 * Aktívny membership prihláseného používateľa (company_id + rola), priamo z
 * company_members (RLS company_members_select_own: user_id = auth.uid(),
 * z 20260814110000 — každý používateľ vidí vždy iba svoj vlastný riadok,
 * bez ohľadu na rolu). Toto je frontendový náprotivok DB funkcií
 * public.esblu_my_active_company_id() / public.esblu_my_active_role() z
 * 20260814160000 — slúži IBA na to, aby appka vedela, čo zobraziť/skryť v
 * UI (company-wide dáta, owner/admin-only akcie). Skutočná autorizácia sa
 * vždy vynucuje na strane DB (RLS + triggery), toto je iba UI vrstva.
 *
 * Vracia null, ak používateľ nemá žiadny aktívny membership (nemalo by
 * nastať pre bežne prihláseného používateľa po onboardingu, ale appka sa
 * musí správať bezpečne aj v tomto prípade — zobrazí prázdny stav namiesto
 * pádu).
 */
export async function getMyActiveMembership(): Promise<MyActiveMembership | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return null;
  }

  const { data, error } = await supabase
    .from("company_members")
    .select("company_id, role, permissions")
    .eq("user_id", session.user.id)
    .eq("status", "active")
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return {
    company_id: data.company_id,
    role: data.role as CompanyMemberRole,
    // "permissions" je vlastný riadok používateľa (RLS company_members_
    // select_own), takže toto nič neprezrádza o iných členoch. jsonb môže
    // teoreticky prísť ako čokoľvek (stĺpec nemá DB-level tvar/CHECK) —
    // typujeme ho ako MemberPermissions bez runtime validácie; hasFinance
    // View/Manage() vyššie sú voči neplatnému/chýbajúcemu tvaru fail-safe
    // (Boolean(...) na chýbajúcich kľúčoch vráti false, nikdy nespadne).
    permissions: (data.permissions ?? {}) as MemberPermissions,
  };
}

export function isOwnerOrAdmin(role: CompanyMemberRole | null | undefined) {
  return role === "owner" || role === "admin";
}

/**
 * Patrí rola do PREVÁDZKY — stroje, sklad, servis a fotky vozidiel,
 * vážne lístky? Zrkadlí DB funkciu esblu_role_can_operate().
 *
 * Zámerne POZITÍVNY výpočet rolí, nie `role !== "accountant"`. Negatívna
 * podmienka je presne tá chyba, ktorou by ďalšia nová rola ticho získala
 * prevádzkový zápis — a v appke takých negatívnych kontrol bolo desať.
 *
 * Toto je iba UI vrstva. Skutočnú autorizáciu drží RLS.
 */
export function canOperate(role: CompanyMemberRole | null | undefined) {
  return role === "owner" || role === "admin" || role === "employee";
}

/**
 * Účtovník — má doklady, nemá majetok. Používa sa tam, kde treba
 * rozhodnúť o zobrazení prevádzkových modulov.
 */
export function isAccountant(role: CompanyMemberRole | null | undefined) {
  return role === "accountant";
}

export type CompanyProfile = {
  company_name: string | null;
  logo_path: string | null;
};

/**
 * Firemný názov + logo pre AKTÍVNEHO PRIHLÁSENÉHO POUŽÍVATEĽA, bez ohľadu na
 * jeho rolu — owner, admin aj employee dostanú rovnaké dva údaje (branding
 * ownera firmy), nikdy vlastný, väčšinou prázdny settings riadok. Volá
 * public.esblu_get_company_profile() (20260814180000), ktorá company_id
 * odvodzuje výhradne z auth.uid(). Vracia null, ak volajúci nemá aktívny
 * membership alebo ak firma ešte nemá vyplnené meno/logo (bežný, nechybový
 * stav — volajúci má zachovať dnešný fallback).
 */
export async function getCompanyProfile(): Promise<CompanyProfile | null> {
  const { data, error } = await supabase.rpc("esblu_get_company_profile");

  if (error) {
    console.error("getCompanyProfile zlyhalo:", error.message);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return row ?? null;
}

export type CompanyInviteRow = {
  invite_id: string;
  email: string;
  role: CompanyInviteRole;
  status: CompanyInviteStatus;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
};

export type CreateInviteResult = {
  invite_id: string;
  token: string;
  expires_at: string;
  email: string;
  role: CompanyInviteRole;
};

export type InvitePreview = {
  company_name: string;
  role: CompanyInviteRole;
  masked_email: string;
  expires_at: string;
  valid: boolean;
};

/**
 * Idempotentný bootstrap: ak prihlásený používateľ ešte nemá žiadne aktívne
 * company_members membership, vytvorí mu vlastnú firmu s rolou 'owner'.
 * Identita sa na DB strane odvodzuje výhradne z auth.uid(), klient
 * neposiela žiadny user_id/company_id/role.
 *
 * DÔLEŽITÉ — volať IBA z týchto dvoch presne vymedzených miest, kde je
 * owner-registration intent jednoznačný z KONTEXTU VOLANIA (nie z toho, či
 * má používateľ membership):
 *   1. app/login/page.tsx → register(), vetva s okamžitou session (email
 *      confirmation vypnuté) — sme priamo vnútri "Registrovať firmu"
 *      klik-handlera,
 *   2. app/onboarding/company/page.tsx — dedikovaná route, na ktorú smeruje
 *      výhradne emailRedirectTo z toho istého signUp() volania, keď session
 *      príde až po potvrdení e-mailu.
 * NIKDY z login() (bežné prihlásenie existujúceho ownera/admina/employee by
 * si inak mohlo omylom založiť vlastnú firmu), NIKDY globálne/fire-and-
 * forget pri každej session (app/page.tsx) a NIKDY z invite-accept flow
 * (app/invite/[token]/page.tsx). Táto funkcia už neblokuje na základe
 * pending pozvánky (bývalý DoS vektor bol odstránený na DB strane) —
 * ochranu pred konfliktom s prijatím pozvánky teraz zaisťuje výhradne
 * poradie volaní na frontende plus
 * ESBLU_ALREADY_HAS_ACTIVE_MEMBERSHIP kontrola v esblu_accept_company_invite.
 */
export async function ensureMyOwnerCompany(): Promise<EnsureOwnerCompanyResult | null> {
  const { data, error } = await supabase.rpc("esblu_ensure_my_owner_company");

  // DÔLEŽITÉ (Closed Beta): predtým sa chyba iba logovala a vracal sa null,
  // čím volajúci nevedel rozlíšiť "žiadna firma sa nezaložila, lebo už
  // nejakú má" od "žiadna firma sa nezaložila, lebo RPC zlyhalo" (napr.
  // ESBLU_BETA_ACCESS_REQUIRED — pozri
  // supabase/migrations/20260816130000_add_closed_beta_allowlist.sql).
  // Chyba sa preto teraz vyhadzuje, rovnako ako pri ostatných RPC funkciách
  // v tomto module (acceptCompanyInvite, createCompanyInvite) — volajúci
  // (app/login/page.tsx, app/onboarding/company/page.tsx) ju musí odchytiť
  // a zobraziť používateľovi zrozumiteľnú správu cez
  // getEnsureOwnerCompanyErrorMessage nižšie.
  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return row ?? null;
}

/**
 * Zrozumiteľná, preložená správa pre chybu z ensureMyOwnerCompany(). Text
 * poskytuje volajúca stránka cez i18n `t()` (kľúče
 * auth.closedBeta.registerNotice / auth.notAuthenticated /
 * auth.company.createFailedGeneric) — tento modul si nesmie natvrdo
 * renderovať slovenský text. Pozn.: bežný scenár neschváleného beta
 * signup-u sa dnes odchytí už skôr — priamo v supabase.auth.signUp() vďaka
 * Auth hooku esblu_before_user_created_beta_gate (auth.users sa vtedy vôbec
 * nevytvorí). Táto funkcia pokrýva iba defense-in-depth prípad (napr. Auth
 * hook zatiaľ nie je zapnutý v Supabase Dashboarde, alebo existuje staršie
 * auth.users bez firmy).
 */
export function getEnsureOwnerCompanyErrorMessage(
  error: unknown,
  t: (key: string) => string
): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  if (text.includes("ESBLU_BETA_ACCESS_REQUIRED")) {
    return t("auth.closedBeta.registerNotice");
  }

  if (text.includes("NOT_AUTHENTICATED")) {
    return t("auth.notAuthenticated");
  }

  return t("auth.company.createFailedGeneric");
}

export function isBetaAccessRequiredError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return text.includes("ESBLU_BETA_ACCESS_REQUIRED");
}

export async function listMyCompanyMembers(): Promise<CompanyMemberRow[]> {
  const { data, error } = await supabase.rpc("esblu_list_my_company_members");

  if (error) {
    throw error;
  }

  return (data as CompanyMemberRow[]) || [];
}

export async function listMyCompanyInvites(): Promise<CompanyInviteRow[]> {
  const { data, error } = await supabase.rpc("esblu_list_my_company_invites");

  if (error) {
    throw error;
  }

  return (data as CompanyInviteRow[]) || [];
}

export async function createCompanyInvite(
  email: string,
  role: CompanyInviteRole
): Promise<CreateInviteResult> {
  const { data, error } = await supabase.rpc("esblu_create_company_invite", {
    p_email: email,
    p_role: role,
  });

  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (!row) {
    throw new Error("Pozvánku sa nepodarilo vytvoriť.");
  }

  return row as CreateInviteResult;
}

export async function getInvitePreview(token: string): Promise<InvitePreview | null> {
  const { data, error } = await supabase.rpc("esblu_get_invite_preview", {
    p_token: token,
  });

  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return (row as InvitePreview) ?? null;
}

export async function acceptCompanyInvite(
  token: string
): Promise<{ company_id: string; role: CompanyMemberRole }> {
  const { data, error } = await supabase.rpc("esblu_accept_company_invite", {
    p_token: token,
  });

  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (!row) {
    throw new Error("Pozvánku sa nepodarilo prijať.");
  }

  return row as { company_id: string; role: CompanyMemberRole };
}

const INVITE_ERROR_CODES = [
  "ESBLU_INVALID_TOKEN",
  "ESBLU_INVITE_ALREADY_ACCEPTED",
  "ESBLU_INVITE_REVOKED",
  "ESBLU_INVITE_EXPIRED",
  "ESBLU_INVITE_EMAIL_MISMATCH",
  "ESBLU_ALREADY_HAS_ACTIVE_MEMBERSHIP",
] as const;

// Text pre volajúceho poskytuje i18n `t()` — kľúče auth.invite.errors.<kód>,
// auth.notAuthenticated (spoločné s ensureOwnerCompany vyššie) a
// auth.invite.errors.acceptFailedGeneric.
export function getInviteErrorMessage(
  error: unknown,
  t: (key: string) => string
): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  for (const code of INVITE_ERROR_CODES) {
    if (text.includes(code)) {
      return t(`auth.invite.errors.${code}`);
    }
  }

  if (text.includes("NOT_AUTHENTICATED")) {
    return t("auth.notAuthenticated");
  }

  return t("auth.invite.errors.acceptFailedGeneric");
}

const CREATE_INVITE_ERROR_CODES = [
  "ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN",
  "ESBLU_INVALID_INVITE_EMAIL",
  "ESBLU_INVITE_ALREADY_MEMBER",
  "ESBLU_INVITE_ALREADY_PENDING",
] as const;

// Text pre volajúceho poskytuje i18n `t()` — kľúče
// auth.invite.createErrors.<kód> a auth.invite.createErrors.createFailedGeneric.
export function getCreateInviteErrorMessage(
  error: unknown,
  t: (key: string) => string
): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  for (const code of CREATE_INVITE_ERROR_CODES) {
    if (text.includes(code)) {
      return t(`auth.invite.createErrors.${code}`);
    }
  }

  return t("auth.invite.createErrors.createFailedGeneric");
}
