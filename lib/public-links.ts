// Verejné odkazy webu (landing, cenník, právne podstránky, prihlásenie).
// Registrácia = tá istá stránka /login, iba otvorená rovno v režime
// „Registrácia firmy“ (app/login/page.tsx číta ?rezim=registracia).

export const REGISTER_QUERY_PARAM = "rezim";
export const REGISTER_QUERY_VALUE = "registracia";
export const REGISTER_HREF = `/login?${REGISTER_QUERY_PARAM}=${REGISTER_QUERY_VALUE}`;
export const LOGIN_HREF = "/login";
export const CONTACT_EMAIL = "info@esblu.com";

/** true = URL žiada otvoriť prihlasovaciu stránku rovno v režime registrácie. */
export function wantsRegisterMode(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get(REGISTER_QUERY_PARAM) === REGISTER_QUERY_VALUE || params.get("mode") === "register";
}

/** Právne dokumenty v rovnakom poradí na všetkých verejných stránkach. */
export const LEGAL_LINKS = [
  { href: "/ochrana-osobnych-udajov", labelKey: "common.legalLinks.privacy" },
  { href: "/podmienky-pouzivania", labelKey: "common.legalLinks.terms" },
  { href: "/cookies", labelKey: "common.legalLinks.cookies" },
  { href: "/dpa", labelKey: "common.legalLinks.dpa" },
  { href: "/subprocessors", labelKey: "common.legalLinks.subprocessors" },
] as const;
