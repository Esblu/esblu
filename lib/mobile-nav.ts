// =============================================================================
// Model mobilnej navigácie (Mobile M1, 2026-09-28) — čistá funkcia.
//
// Spodná lišta (max 5 položiek) + „Viac" pre sekundárne moduly. Výpočet
// vychádza z TOHO ISTÉHO modelu oprávnení ako web (lib/company.ts):
//   - financie: hasFinanceView / hasFinanceManage (owner a accountant vždy,
//     admin iba s explicitným permissions.finance, zamestnanec nikdy),
//   - prevádzka (vozidlá, stroje, sklad): canOperate (owner, admin,
//     employee; accountant nie).
// Skrytie v navigácii je iba UX — autorizáciu robí server (RLS, RPC,
// finance checky v stránkach). Navigácia nikdy neponúkne cieľ, ktorý
// v aktuálnom builde neexistuje (overuje test voči mobile/app/**).
//
// Nároky (entitlements) moduly v navigácii NESKRÝVAJÚ: po strate nároku
// ostávajú existujúce dáta čitateľné (princíp 2b z company_entitlements),
// obmedzí sa iba vznik nových záznamov priamo v module. Hlas je platený
// doplnok a riadi ho server (VoiceSessionControl ho skryje bez nároku).
// =============================================================================

import {
  canOperate,
  hasFinanceManage,
  hasFinanceView,
  type CompanyMemberRole,
  type MemberPermissions,
} from "@/lib/company";

export type MobileNavKey =
  | "home"
  | "inbox"
  | "invoices"
  | "partners"
  | "folders"
  | "vehicles"
  | "machines"
  | "inventory"
  | "chat"
  | "settings";

export type MobileNavItem = {
  key: MobileNavKey;
  href: string;
  /** i18n kľúč popisu */
  labelKey: string;
};

// -----------------------------------------------------------------------------
// DVE ODDELENÉ SCHOPNOSTI (role clarification 2026-09-28) — nikdy ich nezlučovať:
//
//   HUMAN CHAT   — interná komunikácia medzi ľuďmi vo firme (zamestnanec ↔
//                  vedenie, ↔ kolegovia). Má ju KAŽDÝ aktívny člen firmy,
//                  vrátane zamestnanca. Neobsahuje AI, hlasové príkazy ani
//                  Intent Engine; autorizáciu robí RLS chat tabuliek.
//
//   AI ASSISTANT — Intent Engine (text/hlas, /api/assistant/*). Rozsah podľa
//                  roly; server (intent permission gate) je autorita:
//                    owner / admin → "full" (ďalej obmedzené ich oprávneniami
//                                    a nárokmi, napr. financie iba s
//                                    permissions.finance, hlas iba s nárokom),
//                    accountant    → "finance-scoped",
//                    employee      → "inbox-intake-only" (iba úzky príjem
//                                    finančných dokladov v Inboxe, bezpečné
//                                    potvrdenie; žiadny všeobecný asistent).
// -----------------------------------------------------------------------------
export type AiAssistantAccess = "full" | "finance-scoped" | "inbox-intake-only" | "none";

export function humanChatAllowed(role: CompanyMemberRole | null | undefined): boolean {
  return role === "owner" || role === "admin" || role === "accountant" || role === "employee";
}

export function aiAssistantAccess(role: CompanyMemberRole | null | undefined): AiAssistantAccess {
  switch (role) {
    case "owner":
    case "admin":
      return "full";
    case "accountant":
      return "finance-scoped";
    case "employee":
      return "inbox-intake-only";
    default:
      return "none";
  }
}

/**
 * Smie sa na danej obrazovke zobraziť vstup do AI asistenta? Zamestnanec iba
 * v Inboxe (príjem dokladov); human chat nie je obrazovka asistenta nikdy.
 */
export function assistantLauncherAllowed(
  role: CompanyMemberRole | null | undefined,
  screen: string | null | undefined
): boolean {
  const access = aiAssistantAccess(role);
  if (access === "none") return false;
  if (screen === "chat") return false;
  if (access === "inbox-intake-only") return screen === "inbox";
  return true;
}

export type MobileNavModel = {
  tabs: MobileNavItem[];
  more: MobileNavItem[];
  /** HUMAN CHAT — interná komunikácia (nie AI). */
  humanChat: boolean;
  /** Rozsah AI asistenta (Intent Engine) — oddelený od chatu. */
  aiAssistant: AiAssistantAccess;
  /** Smie sa na obrazovkách modulov (mimo Inboxu) zobraziť vstup do asistenta? */
  assistantInModules: boolean;
};

const ITEMS: Record<MobileNavKey, MobileNavItem> = {
  home: { key: "home", href: "/", labelKey: "nav.overview" },
  inbox: { key: "inbox", href: "/ai-evidencia", labelKey: "nav.inbox" },
  invoices: { key: "invoices", href: "/faktury", labelKey: "nav.invoices" },
  partners: { key: "partners", href: "/obchodni-partneri", labelKey: "nav.businessPartners" },
  folders: { key: "folders", href: "/priecinky", labelKey: "nav.folders" },
  vehicles: { key: "vehicles", href: "/vozidla", labelKey: "nav.vehicles" },
  machines: { key: "machines", href: "/stroje", labelKey: "nav.machines" },
  inventory: { key: "inventory", href: "/sklad", labelKey: "nav.inventory" },
  chat: { key: "chat", href: "/chat", labelKey: "nav.chat" },
  settings: { key: "settings", href: "/nastavenia", labelKey: "nav.settings" },
};

export type MobileNavInput = {
  role: CompanyMemberRole | null;
  permissions?: MemberPermissions | null;
};

export function mobileNavModel(input: MobileNavInput | null): MobileNavModel {
  if (!input?.role) return { tabs: [], more: [], humanChat: false, aiAssistant: "none", assistantInModules: false };
  const membership = { role: input.role, permissions: input.permissions ?? {} };
  const financeView = hasFinanceView(membership);
  const financeManage = hasFinanceManage(membership);
  const operate = canOperate(input.role);
  const employee = input.role === "employee";

  const visible: MobileNavKey[] = ["home", "inbox"];
  if (financeView) visible.push("invoices", "partners");
  if (financeManage) visible.push("folders");
  if (operate) visible.push("vehicles", "machines", "inventory");
  // HUMAN CHAT je pre každého člena (aj zamestnanca) — nezávisle od AI asistenta.
  if (humanChatAllowed(input.role)) visible.push("chat");
  visible.push("settings");

  // Poradie spodnej lišty podľa roly (najčastejšia práca vpredu).
  let tabKeys: MobileNavKey[];
  if (financeView && operate) tabKeys = ["home", "inbox", "invoices", "vehicles"];
  else if (financeView) tabKeys = ["home", "inbox", "invoices", "partners"];
  else if (employee) tabKeys = ["home", "inbox", "vehicles", "inventory"];
  else tabKeys = ["home", "inbox", "vehicles", "machines"];

  const tabs = tabKeys.filter((key) => visible.includes(key)).map((key) => ITEMS[key]);
  const more = visible.filter((key) => !tabKeys.includes(key)).map((key) => ITEMS[key]);

  const aiAssistant = aiAssistantAccess(input.role);
  return {
    tabs,
    more,
    humanChat: humanChatAllowed(input.role),
    aiAssistant,
    // Zamestnanec nemá všeobecného asistenta (iba úzky príjem dokladov
    // v Inboxe — ten ostáva priamo v Inboxe).
    assistantInModules: aiAssistant === "full" || aiAssistant === "finance-scoped",
  };
}

/** Ktorá položka je aktívna pre danú cestu (dlhší prefix vyhráva). */
export function activeMobileNavKey(pathname: string, items: MobileNavItem[]): MobileNavKey | null {
  const path = pathname.replace(/\.html$/, "").replace(/\/+$/, "") || "/";
  let best: MobileNavItem | null = null;
  for (const item of items) {
    const matches = item.href === "/" ? path === "/" : path === item.href || path.startsWith(`${item.href}/`);
    if (matches && (!best || item.href.length > best.href.length)) best = item;
  }
  return best?.key ?? null;
}

/** Cesty, na ktorých sa spodná lišta nezobrazuje (prihlásenie, právne texty…). */
const CHROMELESS_PREFIXES = [
  "/login",
  "/reset-hesla",
  "/invite",
  "/onboarding",
  "/auth",
  "/ochrana-osobnych-udajov",
  "/podmienky-pouzivania",
  "/cookies",
  "/dpa",
  "/subprocessors",
  "/kontakt",
];

export function isChromelessPath(pathname: string): boolean {
  const path = pathname.replace(/\.html$/, "");
  return CHROMELESS_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
